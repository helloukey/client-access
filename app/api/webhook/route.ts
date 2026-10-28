import { after } from "next/server";
import type Stripe from "stripe";
import { syncPurchase } from "@/lib/crm-sync";
import { env } from "@/lib/env";
import { stripeClient } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Stripe -> fulfilment. Order of operations:
//   1. verify signature on the raw body
//   2. fulfil in one DB transaction (dedupe event, mark paid, grant access, queue CRM update)
//   3. return 200, then push to Zoho in the background (a Zoho outage never fails the webhook)

export async function POST(req: Request) {
  const payload = await req.text(); // raw body: parsing JSON first would break the signature
  const signature = req.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "missing stripe-signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(payload, signature, env.stripeWebhookSecret());
  } catch (err) {
    console.warn(`[webhook] signature verification failed: ${(err as Error).message}`);
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  if (event.livemode) {
    console.warn(`[webhook] ignoring live-mode event ${event.id}`);
    return Response.json({ received: true, outcome: "ignored_livemode" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        // completed + unpaid = delayed payment method; access waits for async_payment_succeeded.
        if (session.payment_status !== "paid") {
          console.info(`[webhook] ${event.id} ${event.type} session ${session.id} not paid yet (${session.payment_status})`);
          return Response.json({ received: true, outcome: "awaiting_payment" });
        }
        return Response.json({ received: true, outcome: await fulfil(event, session) });
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const session = event.data.object;
        const status = event.type === "checkout.session.expired" ? "expired" : "failed";
        const outcome = await closePending(event, session, status);
        return Response.json({ received: true, outcome });
      }
      default:
        return Response.json({ received: true, outcome: "ignored_type" });
    }
  } catch (err) {
    // A DB failure rolls the whole transaction back (including the event record), so a 500 makes
    // Stripe redeliver and the retry starts clean.
    console.error(`[webhook] ${event.id} ${event.type} failed: ${(err as Error).message}`);
    return Response.json({ error: "processing failed" }, { status: 500 });
  }
}

async function fulfil(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<string> {
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

  const { data, error } = await supabaseAdmin().rpc("fulfill_checkout", {
    p_event_id: event.id,
    p_event_type: event.type,
    p_session_id: session.id,
    p_purchase_id: session.metadata?.purchase_id ?? null,
    p_client_reference_id: session.client_reference_id,
    p_payment_intent_id: paymentIntentId,
    p_amount_total: session.amount_total,
    p_currency: session.currency,
  });
  if (error) throw new Error(`fulfill_checkout: ${error.message}`);

  const result = (data as { outcome: string; purchase_id: string | null; crm_sync_created: boolean }[])[0];
  console.info(
    `[webhook] ${event.id} ${event.type} session ${session.id} -> ${result.outcome}` +
      (result.purchase_id ? ` (purchase ${result.purchase_id})` : ""),
  );
  if (result.outcome === "mismatch" || result.outcome === "duplicate_payment") {
    console.error(`[webhook] ATTENTION ${result.outcome} for session ${session.id}: needs manual review/refund`);
  }

  // Only the transaction that created the CRM row triggers Zoho, so redelivered events never do.
  if (result.crm_sync_created && result.purchase_id) {
    const purchaseId = result.purchase_id;
    after(async () => {
      try {
        await syncPurchase(purchaseId);
      } catch (err) {
        // Row stays pending/in_progress; `npm run crm:retry` picks it up.
        console.error(`[crm] background sync for ${purchaseId} crashed: ${(err as Error).message}`);
      }
    });
  }
  return result.outcome;
}

async function closePending(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  status: "failed" | "expired",
): Promise<string> {
  const db = supabaseAdmin();

  // Only a still-pending purchase moves; a paid one is never downgraded by a late event.
  // Naturally idempotent, so it runs before the event is recorded (a crash in between is harmless).
  const { error } = await db
    .from("purchases")
    .update({ status })
    .eq("stripe_checkout_session_id", session.id)
    .eq("status", "pending");
  if (error) throw new Error(`purchase update: ${error.message}`);

  const { error: insertError } = await db
    .from("stripe_events")
    .insert({ event_id: event.id, type: event.type, stripe_object_id: session.id, outcome: status });
  if (insertError?.code === "23505") return "duplicate_event";
  if (insertError) throw new Error(`stripe_events insert: ${insertError.message}`);
  return status;
}
