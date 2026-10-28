// Seeds test data across all three systems. Safe to re-run: every step looks up before creating.
//
//   Stripe   : one test Product/Price (found again via lookup_key)
//   Supabase : the sample PDF in the private bucket, the document row, two auth users + clients rows
//   Zoho     : a Contact and an open Deal per client; the Deal id is stored in `offers`
//
// Usage: npm run db:seed

import { config } from "dotenv";
config({ path: ".env.local" });

import { stripeClient } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { zohoRequest, type ZohoBody } from "@/lib/zoho";

const DOCUMENT = {
  slug: "sample-report",
  title: "Sample Industry Report (PDF)",
  storagePath: "sample-report.pdf",
  amount: 1900,
  currency: "usd",
  stripeLookupKey: "client_access_sample_report_v1",
};

const CLIENTS = [
  { email: "alice@example.com", firstName: "Alice", lastName: "Example" },
  { email: "bob@example.com", firstName: "Bob", lastName: "Example" },
  // Never buys: lets `check:isolation` prove storage refuses an unentitled client.
  { email: "carol@example.com", firstName: "Carol", lastName: "Example" },
];

const ZOHO_OPEN_STAGE = process.env.ZOHO_SEED_STAGE || "Qualification";

async function main() {
  const password = process.env.SEED_CLIENT_PASSWORD;
  if (!password) throw new Error("Set SEED_CLIENT_PASSWORD in .env.local (password for the seeded test clients)");

  const db = supabaseAdmin();

  // --- Stripe -------------------------------------------------------------
  const stripe = stripeClient();
  const prices = await stripe.prices.list({ lookup_keys: [DOCUMENT.stripeLookupKey], active: true, limit: 1 });
  let price = prices.data[0];
  if (!price) {
    price = await stripe.prices.create({
      currency: DOCUMENT.currency,
      unit_amount: DOCUMENT.amount,
      lookup_key: DOCUMENT.stripeLookupKey,
      product_data: { name: DOCUMENT.title },
    });
    console.log(`stripe: created price ${price.id}`);
  } else {
    console.log(`stripe: using price ${price.id}`);
  }
  if (price.unit_amount !== DOCUMENT.amount || price.currency !== DOCUMENT.currency) {
    throw new Error(`Stripe price ${price.id} does not match ${DOCUMENT.amount} ${DOCUMENT.currency}`);
  }

  // --- Supabase: document -------------------------------------------------
  const { error: uploadError } = await db.storage
    .from("documents")
    .upload(DOCUMENT.storagePath, samplePdf(), { contentType: "application/pdf", upsert: true });
  if (uploadError) throw new Error(`storage upload: ${uploadError.message} (did you run the migration?)`);

  const { data: document, error: docError } = await db
    .from("documents")
    .upsert(
      {
        slug: DOCUMENT.slug,
        title: DOCUMENT.title,
        storage_path: DOCUMENT.storagePath,
        stripe_price_id: price.id,
        amount: DOCUMENT.amount,
        currency: DOCUMENT.currency,
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (docError) throw new Error(`documents upsert: ${docError.message}`);
  console.log(`supabase: document ${document.id}`);

  // --- Clients + Zoho -----------------------------------------------------
  for (const c of CLIENTS) {
    const userId = await ensureAuthUser(c.email, password);

    const { error: clientError } = await db
      .from("clients")
      .upsert({ id: userId, email: c.email, full_name: `${c.firstName} ${c.lastName}` }, { onConflict: "id" });
    if (clientError) throw new Error(`clients upsert: ${clientError.message}`);

    const contactId = await ensureZohoContact(c);
    const { data: existingOffer } = await db
      .from("offers")
      .select("zoho_deal_id")
      .eq("client_id", userId)
      .eq("document_id", document.id)
      .maybeSingle();
    const dealId = await ensureZohoDeal(c, contactId, existingOffer?.zoho_deal_id);

    await db.from("clients").update({ zoho_contact_id: contactId }).eq("id", userId);
    const { error: offerError } = await db
      .from("offers")
      .upsert({ client_id: userId, document_id: document.id, zoho_deal_id: dealId }, { onConflict: "client_id,document_id" });
    if (offerError) throw new Error(`offers upsert: ${offerError.message}`);

    console.log(`client ${c.email}: user ${userId}, zoho contact ${contactId}, zoho deal ${dealId}`);
  }

  console.log("\nSeed complete. Sign in at /login with any seeded email and SEED_CLIENT_PASSWORD.");
}

async function ensureAuthUser(email: string, password: string): Promise<string> {
  const admin = supabaseAdmin().auth.admin;
  const { data, error } = await admin.createUser({ email, password, email_confirm: true });
  if (data.user) return data.user.id;
  if (error && error.code !== "email_exists") throw new Error(`createUser ${email}: ${error.message}`);

  for (let page = 1; ; page++) {
    const { data: list, error: listError } = await admin.listUsers({ page, perPage: 200 });
    if (listError) throw new Error(`listUsers: ${listError.message}`);
    const found = list.users.find((u) => u.email === email);
    if (found) {
      await admin.updateUserById(found.id, { password }); // keep the documented password valid
      return found.id;
    }
    if (list.users.length < 200) throw new Error(`user ${email} exists but could not be found`);
  }
}

async function ensureZohoContact(c: (typeof CLIENTS)[number]): Promise<string> {
  const search = await zohoRequest(`/crm/v8/Contacts/search?email=${encodeURIComponent(c.email)}`);
  const existing = search.body?.data?.[0]?.id; // 204 No Content when nothing matches
  if (existing) return existing;

  const created = await zohoRequest("/crm/v8/Contacts", {
    method: "POST",
    body: { data: [{ First_Name: c.firstName, Last_Name: c.lastName, Email: c.email }] },
  });
  return createdId(created, `contact ${c.email}`);
}

async function ensureZohoDeal(c: (typeof CLIENTS)[number], contactId: string, knownDealId?: string): Promise<string> {
  // Prefer the id we already stored: Zoho search is index-backed and can lag right after creation.
  if (knownDealId) {
    const found = await zohoRequest(`/crm/v8/Deals/${knownDealId}`);
    if (found.status === 200 && found.body?.data?.[0]?.id) return knownDealId;
    console.warn(`zoho: stored deal ${knownDealId} no longer exists, creating a new one`);
  }

  const dealName = `Sample Report - ${c.email}`;
  const criteria = encodeURIComponent(`(Deal_Name:equals:${dealName})`);
  const search = await zohoRequest(`/crm/v8/Deals/search?criteria=${criteria}`);
  const existing = search.body?.data?.[0]?.id;
  if (existing) return existing;

  const closing = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const created = await zohoRequest("/crm/v8/Deals", {
    method: "POST",
    body: {
      data: [
        {
          Deal_Name: dealName,
          Stage: ZOHO_OPEN_STAGE,
          Amount: DOCUMENT.amount / 100,
          Closing_Date: closing,
          Contact_Name: { id: contactId },
        },
      ],
    },
  });
  return createdId(created, `deal ${dealName}`);
}

function createdId(res: { status: number; body: ZohoBody }, what: string): string {
  const record = res.body?.data?.[0];
  if (record?.code === "SUCCESS" && record.details?.id) return record.details.id;
  throw new Error(
    `zoho: could not create ${what}: ${JSON.stringify(res.body)}\n` +
      "Hint: check ZOHO_API_DOMAIN matches your data centre, the token scopes, and ZOHO_SEED_STAGE / required fields (e.g. Pipeline).",
  );
}

// A tiny valid one-page PDF so the repo needs no binary fixture.
function samplePdf(): Buffer {
  const lines = [
    "Sample Industry Report",
    "",
    "This is a test document for the paid client access exercise.",
    "If you can read this, your Supabase entitlement is working.",
    `Generated ${new Date().toISOString()}`,
  ];
  const escape = (s: string) => s.replace(/[\\()]/g, (m) => `\\${m}`);
  const stream = ["BT", "/F1 14 Tf", "72 740 Td", "20 TL", ...lines.map((l) => `(${escape(l)}) '`), "ET"].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  process.exit(1);
});
