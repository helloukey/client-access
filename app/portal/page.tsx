"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/browser";

// Everything on this page is read straight from Supabase with the client's own JWT, so RLS decides
// what is visible. Server routes are only used for actions that need Stripe/Zoho credentials.

type Document = { id: string; title: string; amount: number; currency: string; storage_path: string };
type Entitlement = { document_id: string; purchase_id: string; granted_at: string };
type CrmSync = { status: string; attempts: number; last_error: string | null; synced_at: string | null };
type Purchase = {
  id: string;
  document_id: string;
  status: string;
  amount: number;
  currency: string;
  needs_refund: boolean;
  paid_at: string | null;
  created_at: string;
  crm_sync: CrmSync | null;
};

const POLL_MS = 3000;
const POLL_FOR_MS = 2 * 60 * 1000;

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

const PAYMENT_BADGE: Record<string, string> = { paid: "ok", pending: "warn", failed: "bad", expired: "neutral" };
const CRM_BADGE: Record<string, string> = {
  synced: "ok", pending: "warn", in_progress: "warn", failed: "bad", failed_permanent: "bad",
};

export default function PortalPage() {
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const [docs, ents, purch] = await Promise.all([
      supabase.from("documents").select("id, title, amount, currency, storage_path").order("title"),
      supabase.from("entitlements").select("document_id, purchase_id, granted_at"),
      supabase
        .from("purchases")
        .select("id, document_id, status, amount, currency, needs_refund, paid_at, created_at, crm_sync (status, attempts, last_error, synced_at)")
        .order("created_at", { ascending: false }),
    ]);
    const error = docs.error ?? ents.error ?? purch.error;
    if (error) return setNotice({ kind: "bad", text: `Could not load portal data: ${error.message}` });
    setDocuments(docs.data ?? []);
    setEntitlements(ents.data ?? []);
    setPurchases((purch.data ?? []) as unknown as Purchase[]);
  }, []);

  useEffect(() => {
    supabaseBrowser().auth.getSession().then(({ data }) => {
      if (!data.session) return router.replace("/login");
      setSession(data.session);
      setEmail(data.session.user.email ?? "");

      // Returning from Stripe Checkout. The redirect itself proves nothing; we wait for the webhook.
      const result = new URLSearchParams(window.location.search).get("checkout");
      if (result === "success") {
        setNotice({ kind: "ok", text: "Payment submitted. Access appears once Stripe confirms it (usually a few seconds)." });
        setPollUntil(Date.now() + POLL_FOR_MS);
      } else if (result === "cancelled") {
        setNotice({ kind: "bad", text: "Checkout cancelled. You have not been charged." });
      }
      if (result) window.history.replaceState(null, "", "/portal");
      load();
    });
  }, [router, load]);

  // Keep refreshing while a payment or CRM update is in flight (webhook / Zoho are asynchronous).
  const inFlight = purchases.some(
    (p) => p.crm_sync?.status === "pending" || p.crm_sync?.status === "in_progress",
  );
  useEffect(() => {
    if (!session || (!inFlight && Date.now() > pollUntil)) return;
    const timer = setInterval(() => {
      if (Date.now() > pollUntil && !inFlight) clearInterval(timer);
      load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [session, inFlight, pollUntil, load]);

  async function callApi(path: string, body: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json;
  }

  async function buy(documentId: string) {
    setBusy(documentId);
    try {
      const { url } = await callApi("/api/checkout", { documentId });
      window.location.assign(url);
    } catch (err) {
      setNotice({ kind: "bad", text: (err as Error).message });
      setBusy(null);
    }
  }

  async function download(doc: Document) {
    // Storage RLS only signs the URL if this client holds an entitlement for the file.
    const { data, error } = await supabaseBrowser().storage.from("documents").createSignedUrl(doc.storage_path, 60);
    if (error || !data) return setNotice({ kind: "bad", text: `Download not allowed: ${error?.message ?? "no access"}` });
    window.open(data.signedUrl, "_blank", "noopener");
  }

  async function retry(purchaseId: string) {
    setBusy(purchaseId);
    try {
      const { results } = await callApi("/api/crm/retry", { purchaseId });
      const r = results[0];
      setNotice(
        r.status === "synced"
          ? { kind: "ok", text: "CRM updated." }
          : { kind: "bad", text: `CRM update ${r.status}${r.error ? `: ${r.error}` : ""}` },
      );
    } catch (err) {
      setNotice({ kind: "bad", text: (err as Error).message });
    } finally {
      setBusy(null);
      load();
    }
  }

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
  }

  if (!session) return <main className="muted">Loading…</main>;

  const titleOf = (id: string) => documents.find((d) => d.id === id)?.title ?? "Unknown document";

  return (
    <main>
      <div className="header">
        <div>
          <h1>Client portal</h1>
          <div className="muted">Signed in as {email}</div>
        </div>
        <div className="row">
          <button className="secondary" onClick={load}>Refresh</button>
          <button className="secondary" onClick={signOut}>Sign out</button>
        </div>
      </div>

      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

      <h2>Documents</h2>
      <div className="stack">
        {documents.length === 0 && <div className="card muted">No documents found.</div>}
        {documents.map((doc) => {
          const entitlement = entitlements.find((e) => e.document_id === doc.id);
          return (
            <div key={doc.id} className="card row">
              <div>
                <strong>{doc.title}</strong>
                <div className="muted">
                  {money(doc.amount, doc.currency)} ·{" "}
                  {entitlement ? (
                    <span className="badge ok">Access granted {when(entitlement.granted_at)}</span>
                  ) : (
                    <span className="badge neutral">No access</span>
                  )}
                </div>
              </div>
              {entitlement ? (
                <button onClick={() => download(doc)}>Download</button>
              ) : (
                <button onClick={() => buy(doc.id)} disabled={busy === doc.id}>
                  {busy === doc.id ? "Redirecting…" : "Buy with Stripe (test)"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <h2>Purchases &amp; CRM sync</h2>
      <div className="card table-wrap">
        {purchases.length === 0 ? (
          <div className="muted">No purchases yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Document</th>
                <th>Payment</th>
                <th>Zoho CRM</th>
                <th>Last CRM error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => {
                const crm = p.crm_sync;
                const canRetry = crm && (crm.status === "failed" || crm.status === "pending");
                return (
                  <tr key={p.id}>
                    <td>{when(p.created_at)}</td>
                    <td>
                      {titleOf(p.document_id)}
                      <div className="muted"><code>{p.id.slice(0, 8)}</code> · {money(p.amount, p.currency)}</div>
                    </td>
                    <td>
                      <span className={`badge ${PAYMENT_BADGE[p.status] ?? "neutral"}`}>{p.status}</span>
                      {p.needs_refund && <div className="muted">Duplicate payment, refund pending</div>}
                    </td>
                    <td>
                      {crm ? (
                        <>
                          <span className={`badge ${CRM_BADGE[crm.status] ?? "neutral"}`}>{crm.status.replace("_", " ")}</span>
                          <div className="muted">
                            {crm.synced_at ? `synced ${when(crm.synced_at)}` : `${crm.attempts} attempt(s)`}
                          </div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="error">{crm?.last_error ?? ""}</td>
                    <td>
                      {canRetry && (
                        <button className="secondary" onClick={() => retry(p.id)} disabled={busy === p.id}>
                          {busy === p.id ? "Retrying…" : "Retry CRM"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
