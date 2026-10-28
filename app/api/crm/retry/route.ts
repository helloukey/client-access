import { timingSafeEqual } from "node:crypto";
import { getUserFromRequest } from "@/lib/auth";
import { retryDueSyncs, syncPurchase } from "@/lib/crm-sync";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Retry the Zoho update.
//   Operator: header `x-admin-token: $ADMIN_TOKEN`, body {} -> retry everything due,
//             or {"purchaseId": "..."} -> retry one, {"includePermanent": true} -> also re-queue permanent failures.
//   Client:   Bearer token, body {"purchaseId": "..."} -> retry only their own purchase.

function isAdmin(req: Request): boolean {
  const given = Buffer.from(req.headers.get("x-admin-token") ?? "");
  const expected = Buffer.from(env.adminToken());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { purchaseId?: string; includePermanent?: boolean };

  if (isAdmin(req)) {
    const results = body.purchaseId
      ? [await syncPurchase(body.purchaseId)]
      : await retryDueSyncs({ includePermanent: body.includePermanent });
    return Response.json({ results });
  }

  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  if (!body.purchaseId) return Response.json({ error: "purchaseId is required" }, { status: 400 });

  const { data: purchase } = await supabaseAdmin()
    .from("purchases")
    .select("id")
    .eq("id", body.purchaseId)
    .eq("client_id", user.id)
    .maybeSingle();
  // Same response whether it doesn't exist or belongs to someone else.
  if (!purchase) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ results: [await syncPurchase(purchase.id)] });
}
