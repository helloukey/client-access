// Signs in as one client (default bob) with the public anon key, exactly like the browser does, and
// tries to reach another client's (default alice) purchase records and document.
// Run after the "victim" has bought the document:  npm run check:isolation [-- attacker@x victim@y]

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";

const [attackerEmail = "bob@example.com", victimEmail = "alice@example.com"] = process.argv.slice(2);

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  const admin = supabaseAdmin();
  const { data: victim } = await admin.from("clients").select("id").eq("email", victimEmail).single();
  if (!victim) throw new Error(`no client ${victimEmail}; run npm run db:seed`);
  const { data: victimPurchase } = await admin
    .from("purchases").select("id").eq("client_id", victim.id).eq("status", "paid").limit(1).maybeSingle();
  const { data: doc } = await admin.from("documents").select("id, storage_path").limit(1).single();
  if (!victimPurchase) console.log(`note: ${victimEmail} has no paid purchase yet, so some checks are weaker\n`);

  const anon = createClient(env.supabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
  const { data: auth, error: signInError } = await anon.auth.signInWithPassword({
    email: attackerEmail,
    password: process.env.SEED_CLIENT_PASSWORD!,
  });
  if (signInError || !auth.user) throw new Error(`sign in as ${attackerEmail}: ${signInError?.message}`);
  const attackerId = auth.user.id;
  console.log(`signed in as ${attackerEmail}, probing ${victimEmail}'s data\n`);

  const purchases = await anon.from("purchases").select("id, client_id");
  check("purchases: only own rows visible", (purchases.data ?? []).every((p) => p.client_id === attackerId));

  const byClient = await anon.from("purchases").select("id").eq("client_id", victim.id);
  check("purchases: filtering by victim client_id returns nothing", (byClient.data ?? []).length === 0);

  if (victimPurchase) {
    const byId = await anon.from("purchases").select("id").eq("id", victimPurchase.id);
    check("purchases: victim purchase id returns nothing", (byId.data ?? []).length === 0);

    const crm = await anon.from("crm_sync").select("purchase_id").eq("purchase_id", victimPurchase.id);
    check("crm_sync: victim sync row hidden", (crm.data ?? []).length === 0);
  }

  const ents = await anon.from("entitlements").select("client_id");
  check("entitlements: only own rows visible", (ents.data ?? []).every((e) => e.client_id === attackerId));

  const offers = await anon.from("offers").select("zoho_deal_id");
  check("offers: Zoho deal mapping not readable", (offers.data ?? []).length === 0);

  const { data: attackerEnt } = await admin
    .from("entitlements").select("id").eq("client_id", attackerId).eq("document_id", doc!.id).maybeSingle();
  if (!attackerEnt) {
    const signed = await anon.storage.from("documents").createSignedUrl(doc!.storage_path, 60);
    check("storage: cannot sign a URL for an unpurchased document", !signed.data, signed.error?.message);
  } else {
    console.log(`skip  storage check: ${attackerEmail} owns the document`);
  }

  const insert = await anon.from("entitlements").insert({
    client_id: attackerId, document_id: doc!.id, purchase_id: victimPurchase?.id ?? crypto.randomUUID(),
  });
  check("entitlements: client cannot grant itself access", !!insert.error, insert.error?.message);

  const rpc = await anon.rpc("fulfill_checkout", {
    p_event_id: "evt_fake", p_event_type: "checkout.session.completed", p_session_id: "cs_fake",
    p_purchase_id: null, p_client_reference_id: attackerId, p_payment_intent_id: null,
    p_amount_total: 0, p_currency: "usd",
  });
  check("rpc: fulfill_checkout not callable by clients", !!rpc.error, rpc.error?.message);

  if (victimPurchase) {
    try {
      const res = await fetch(`${env.appUrl()}/api/crm/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.session!.access_token}` },
        body: JSON.stringify({ purchaseId: victimPurchase.id }),
      });
      check("api: cannot trigger CRM retry for victim purchase", res.status === 404, `HTTP ${res.status}`);
    } catch {
      console.log("skip  api check: dev server not running");
    }
  }

  console.log(failures === 0 ? "\nAll isolation checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
