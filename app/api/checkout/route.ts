import { getUserFromRequest } from "@/lib/auth";
import { env } from "@/lib/env";
import { stripeClient } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Creates (or reuses) a Stripe Checkout Session for the signed-in client.
// The client id comes from the verified Supabase token; the Zoho Deal id comes from `offers`.
// Nothing here grants access; only the verified webhook does.

const SESSION_TTL_SECONDS = 60 * 60; // Stripe minimum is 30 minutes

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });

  const { documentId } = (await req.json().catch(() => ({}))) as { documentId?: string };
  if (!documentId) return Response.json({ error: "documentId is required" }, { status: 400 });

  const db = supabaseAdmin();

  const { data: entitlement } = await db
    .from("entitlements")
    .select("id")
    .eq("client_id", user.id)
    .eq("document_id", documentId)
    .maybeSingle();
  if (entitlement) return Response.json({ error: "you already have access to this document" }, { status: 409 });

  const { data: offer } = await db
    .from("offers")
    .select("zoho_deal_id, documents (id, title, stripe_price_id, amount, currency)")
    .eq("client_id", user.id)
    .eq("document_id", documentId)
    .maybeSingle();
  const document = offer?.documents as unknown as
    | { id: string; title: string; stripe_price_id: string; amount: number; currency: string }
    | undefined;
  if (!offer || !document) return Response.json({ error: "this document is not offered to you" }, { status: 404 });

  const stripe = stripeClient();

  // Reuse a still-open session instead of creating another one, so double-clicks / two tabs don't
  // lead to two payments.
  const { data: pending } = await db
    .from("purchases")
    .select("stripe_checkout_session_id")
    .eq("client_id", user.id)
    .eq("document_id", documentId)
    .eq("status", "pending")
    .not("stripe_checkout_session_id", "is", null)
    .gte("created_at", new Date(Date.now() - SESSION_TTL_SECONDS * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pending?.stripe_checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(pending.stripe_checkout_session_id);
    if (existing.status === "open" && existing.url) return Response.json({ url: existing.url });
  }

  const { data: purchase, error: insertError } = await db
    .from("purchases")
    .insert({
      client_id: user.id,
      document_id: document.id,
      zoho_deal_id: offer.zoho_deal_id,
      amount: document.amount,
      currency: document.currency,
    })
    .select("id")
    .single();
  if (insertError || !purchase) {
    console.error(`[checkout] purchase insert failed: ${insertError?.message}`);
    return Response.json({ error: "could not start checkout" }, { status: 500 });
  }

  const appUrl = env.appUrl();
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ price: document.stripe_price_id, quantity: 1 }],
      client_reference_id: user.id,
      customer_email: user.email,
      metadata: { purchase_id: purchase.id, client_id: user.id, document_id: document.id },
      payment_intent_data: { metadata: { purchase_id: purchase.id, zoho_deal_id: offer.zoho_deal_id } },
      success_url: `${appUrl}/portal?checkout=success`,
      cancel_url: `${appUrl}/portal?checkout=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    { idempotencyKey: `checkout-${purchase.id}` },
  );

  const { error: updateError } = await db
    .from("purchases")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", purchase.id);
  // Not fatal: the webhook can still match via metadata.purchase_id.
  if (updateError) console.error(`[checkout] could not store session id for ${purchase.id}: ${updateError.message}`);

  return Response.json({ url: session.url });
}
