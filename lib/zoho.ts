import { env } from "@/lib/env";

// Minimal Zoho CRM v8 client (Self Client OAuth: refresh token -> short-lived access token).

export class ZohoError extends Error {
  constructor(
    message: string,
    // false = retrying cannot help (deleted deal, invalid field value); needs a human.
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ZohoError";
  }
}

type ZohoRecordResult = { id?: string; code?: string; message?: string; status?: string; details?: { id?: string } & Record<string, unknown> };
export type ZohoBody = { data?: ZohoRecordResult[]; code?: string; message?: string; raw?: string } | null;

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const params = new URLSearchParams({
    refresh_token: env.zohoRefreshToken(),
    client_id: env.zohoClientId(),
    client_secret: env.zohoClientSecret(),
    grant_type: "refresh_token",
  });

  let res: Response;
  try {
    res = await fetch(`${env.zohoAccountsUrl()}/oauth/v2/token?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ZohoError(`Zoho accounts unreachable: ${(err as Error).message}`, true);
  }

  // Zoho reports OAuth errors (e.g. {"error":"invalid_code"}) with HTTP 200.
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new ZohoError(`Zoho token refresh failed: ${body.error ?? `HTTP ${res.status}`}`, true);
  }

  // Tokens live 1h; refresh a few minutes early.
  cachedToken = { value: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 300) * 1000 };
  return cachedToken.value;
}

export async function zohoRequest(
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
  retriedAuth = false,
): Promise<{ status: number; body: ZohoBody }> {
  if (env.zohoSimulateDown()) {
    throw new ZohoError("Simulated Zoho outage (ZOHO_SIMULATE_DOWN=true)", true);
  }

  const token = await accessToken();
  let res: Response;
  try {
    res = await fetch(`${env.zohoApiDomain()}${path}`, {
      method: init.method,
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ZohoError(`Zoho API unreachable: ${(err as Error).message}`, true);
  }

  const text = await res.text();
  let body: ZohoBody = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }

  if (res.status === 401 && !retriedAuth) {
    cachedToken = null; // token revoked/expired early: refresh once and retry
    return zohoRequest(path, init, true);
  }
  if (res.status === 401 || res.status === 403) {
    // Credentials / scope problem: fixable by config, so retry later rather than give up.
    throw new ZohoError(`Zoho auth error ${res.status}: ${body?.code ?? ""} ${body?.message ?? ""}`.trim(), true);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new ZohoError(`Zoho unavailable (HTTP ${res.status})`, true);
  }
  return { status: res.status, body };
}

export type DealPayment = {
  paymentIntentId: string | null;
  amount: number; // minor units
  paidAt: string; // ISO timestamp
};

// Mark the Deal as paid. Sends absolute values (not increments), so re-sending is harmless.
export async function markDealPaid(dealId: string, payment: DealPayment): Promise<void> {
  const record: Record<string, unknown> = {
    Stage: env.zohoPaidStage(),
    Amount: payment.amount / 100,
    Closing_Date: payment.paidAt.slice(0, 10),
  };
  const paymentField = env.zohoPaymentIdField();
  if (paymentField && payment.paymentIntentId) record[paymentField] = payment.paymentIntentId;

  const { status, body } = await zohoRequest(`/crm/v8/Deals/${encodeURIComponent(dealId)}`, {
    method: "PUT",
    body: { data: [record] },
  });

  // Zoho can answer 200/202 with a per-record error, so the record code is what counts.
  const result = body?.data?.[0];
  if (result?.code === "SUCCESS") return;

  const code = result?.code ?? body?.code ?? `HTTP_${status}`;
  const message = result?.message ?? body?.message ?? "unexpected response";
  const details = result?.details ? ` ${JSON.stringify(result.details)}` : "";
  // Remaining 4xx / record errors (bad deal id, invalid picklist value) won't succeed on retry.
  throw new ZohoError(`Zoho rejected deal ${dealId} update: ${code} ${message}${details}`, false);
}
