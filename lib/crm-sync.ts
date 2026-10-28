import { supabaseAdmin } from "@/lib/supabase/admin";
import { markDealPaid, ZohoError } from "@/lib/zoho";

export type SyncResult = {
  purchaseId: string;
  status: "synced" | "failed" | "failed_permanent" | "skipped";
  error?: string;
};

const STALE_CLAIM_MINUTES = 5;

// Push one purchase to Zoho. Safe to call concurrently and repeatedly: claim_crm_sync lets exactly one
// caller proceed, and never for a row that is already synced.
export async function syncPurchase(purchaseId: string): Promise<SyncResult> {
  const db = supabaseAdmin();

  const { data: claimed, error: claimError } = await db.rpc("claim_crm_sync", { p_purchase_id: purchaseId });
  if (claimError) throw new Error(`claim_crm_sync failed: ${claimError.message}`);
  const row = (claimed as { zoho_deal_id: string }[] | null)?.[0];
  if (!row) return { purchaseId, status: "skipped" };

  try {
    const { data: purchase, error } = await db
      .from("purchases")
      .select("stripe_payment_intent_id, amount, paid_at")
      .eq("id", purchaseId)
      .single();
    if (error || !purchase?.paid_at) throw new Error(`purchase ${purchaseId} not found or not paid`);

    await markDealPaid(row.zoho_deal_id, {
      paymentIntentId: purchase.stripe_payment_intent_id,
      amount: purchase.amount,
      paidAt: purchase.paid_at,
    });

    await db
      .from("crm_sync")
      .update({ status: "synced", synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
      .eq("purchase_id", purchaseId);
    console.info(`[crm] purchase ${purchaseId} -> Zoho deal ${row.zoho_deal_id} synced`);
    return { purchaseId, status: "synced" };
  } catch (err) {
    const retryable = !(err instanceof ZohoError) || err.retryable;
    const status = retryable ? "failed" : "failed_permanent";
    const message = (err as Error).message;
    await db
      .from("crm_sync")
      .update({ status, last_error: message.slice(0, 1000), updated_at: new Date().toISOString() })
      .eq("purchase_id", purchaseId);
    console.error(`[crm] purchase ${purchaseId} sync ${status}: ${message}`);
    return { purchaseId, status, error: message };
  }
}

// Retry everything that is owed to Zoho. `includePermanent` re-queues rows that failed with a
// non-retryable error, for use after someone has fixed the Deal or the config.
export async function retryDueSyncs(opts: { includePermanent?: boolean } = {}): Promise<SyncResult[]> {
  const db = supabaseAdmin();

  if (opts.includePermanent) {
    await db.from("crm_sync").update({ status: "failed" }).eq("status", "failed_permanent");
  }

  const staleBefore = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { data, error } = await db
    .from("crm_sync")
    .select("purchase_id")
    .or(`status.in.(pending,failed),and(status.eq.in_progress,last_attempt_at.lt.${staleBefore})`)
    .order("created_at");
  if (error) throw new Error(`could not list due CRM syncs: ${error.message}`);

  const results: SyncResult[] = [];
  for (const { purchase_id } of data ?? []) {
    results.push(await syncPurchase(purchase_id)); // sequential: stays well under Zoho rate limits
  }
  return results;
}
