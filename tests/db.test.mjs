import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

// Runs the real migration in PGlite (Postgres compiled to WASM) with stubs for Supabase auth/storage/roles.
const migration = readFileSync(new URL("../supabase/migrations/20261028000000_init.sql", import.meta.url), "utf8");
const db = new PGlite();

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`);
};
const q = async (sql, params) => (await db.query(sql, params)).rows;

// --- Supabase stubs -------------------------------------------------------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant select on storage.objects to authenticated;
  -- Supabase's default privileges: API roles get everything, RLS does the gating
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
await db.exec(migration);
console.log("migration applied\n");

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
await db.exec(`
  insert into auth.users values ('${A}'), ('${B}');
  insert into clients (id, email) values ('${A}', 'alice@example.com'), ('${B}', 'bob@example.com');
  insert into documents (id, slug, title, storage_path, stripe_price_id, amount)
    values ('dddddddd-0000-0000-0000-000000000001', 'doc', 'Doc', 'doc.pdf', 'price_1', 1900);
  insert into offers values ('${A}', 'dddddddd-0000-0000-0000-000000000001', 'deal_A'),
                            ('${B}', 'dddddddd-0000-0000-0000-000000000001', 'deal_B');
  insert into storage.objects (bucket_id, name) values ('documents', 'doc.pdf');
`);
const DOC = "dddddddd-0000-0000-0000-000000000001";
const newPurchase = async (client, deal, session, amount = 1900) =>
  (await q(
    `insert into purchases (client_id, document_id, zoho_deal_id, stripe_checkout_session_id, amount, currency)
     values ($1, $2, $3, $4, $5, 'usd') returning id`, [client, DOC, deal, session, amount],
  ))[0].id;
const fulfil = async (evt, session, clientRef, amount = 1900, currency = "usd", purchaseId = null) =>
  (await q(`select * from fulfill_checkout($1, 'checkout.session.completed', $2, $3, $4, 'pi_x', $5, $6)`,
    [evt, session, purchaseId, clientRef, amount, currency]))[0];
const count = async (sql) => Number((await q(sql))[0].n);

// --- Fulfilment -----------------------------------------------------------
const pA = await newPurchase(A, "deal_A", "cs_A1");
let r = await fulfil("evt_1", "cs_A1", A);
ok("first event fulfils + creates CRM row", r.outcome === "fulfilled" && r.crm_sync_created === true, JSON.stringify(r));
r = await fulfil("evt_1", "cs_A1", A);
ok("same event id -> duplicate_event", r.outcome === "duplicate_event" && !r.crm_sync_created);
r = await fulfil("evt_2", "cs_A1", A);
ok("different event, same session -> no new CRM row", r.outcome === "fulfilled" && r.crm_sync_created === false);
ok("exactly one entitlement", (await count(`select count(*) n from entitlements`)) === 1);
ok("exactly one crm_sync row", (await count(`select count(*) n from crm_sync`)) === 1);
ok("purchase marked paid", (await q(`select status from purchases where id = $1`, [pA]))[0].status === "paid");

const pB = await newPurchase(B, "deal_B", "cs_B1");
r = await fulfil("evt_3", "cs_B1", A);
ok("client_reference_id mismatch -> no grant", r.outcome === "mismatch" &&
  (await count(`select count(*) n from entitlements where client_id = '${B}'`)) === 0);
r = await fulfil("evt_4", "cs_B1", B, 100);
ok("amount mismatch -> no grant", r.outcome === "mismatch");
r = await fulfil("evt_5", "cs_B1", B, 1900, "eur");
ok("currency mismatch -> no grant", r.outcome === "mismatch");
r = await fulfil("evt_6", "cs_unknown", A);
ok("unknown session -> ignored", r.outcome === "unknown_session");

const pA2 = await newPurchase(A, "deal_A", "cs_A2");
r = await fulfil("evt_7", "cs_A2", A);
ok("second paid purchase -> duplicate_payment, flagged, no CRM row",
  r.outcome === "duplicate_payment" && !r.crm_sync_created &&
  (await q(`select needs_refund from purchases where id = $1`, [pA2]))[0].needs_refund === true &&
  (await count(`select count(*) n from crm_sync`)) === 1);

const pB2 = await newPurchase(B, "deal_B", null);
r = await fulfil("evt_8", "cs_B2", B, 1900, "usd", pB2);
ok("metadata fallback when session id not stored", r.outcome === "fulfilled" &&
  (await q(`select stripe_checkout_session_id s from purchases where id = $1`, [pB2]))[0].s === "cs_B2");
r = await fulfil("evt_9", "cs_other", B, 1900, "usd", pA);
ok("metadata fallback cannot hijack a purchase that has a session", r.outcome === "unknown_session");

// --- Claim ---------------------------------------------------------------
let c = await q(`select * from claim_crm_sync($1)`, [pA]);
ok("first claim wins", c.length === 1 && c[0].status === "in_progress" && c[0].attempts === 1);
c = await q(`select * from claim_crm_sync($1)`, [pA]);
ok("concurrent second claim loses", c.length === 0);
await db.exec(`update crm_sync set last_attempt_at = now() - interval '10 minutes' where purchase_id = '${pA}'`);
c = await q(`select * from claim_crm_sync($1)`, [pA]);
ok("stale in_progress claim is reclaimable", c.length === 1 && c[0].attempts === 2);
await db.exec(`update crm_sync set status = 'synced' where purchase_id = '${pA}'`);
c = await q(`select * from claim_crm_sync($1)`, [pA]);
ok("synced row is never claimed again", c.length === 0);
await db.exec(`update crm_sync set status = 'failed_permanent' where purchase_id = '${pB2}'`);
c = await q(`select * from claim_crm_sync($1)`, [pB2]);
ok("failed_permanent row is not auto-claimed", c.length === 0);

// --- RLS as Bob ----------------------------------------------------------
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${B}', false);`);
ok("bob sees only own purchases", (await q(`select client_id from purchases`)).every((p) => p.client_id === B) &&
  (await q(`select id from purchases where id = $1`, [pA])).length === 0);
ok("bob sees only own entitlements", (await q(`select client_id from entitlements`)).every((e) => e.client_id === B));
ok("bob cannot see alice crm_sync", (await q(`select purchase_id from crm_sync where purchase_id = $1`, [pA])).length === 0);
ok("bob cannot read offers", (await q(`select * from offers`)).length === 0);
ok("bob cannot read stripe_events", (await q(`select * from stripe_events`)).length === 0);
ok("bob CAN read the file bob is entitled to", (await q(`select name from storage.objects`)).length === 1);
let err = null;
try { await q(`insert into entitlements (client_id, document_id, purchase_id) values ($1, $2, $3)`, [B, DOC, pA]); } catch (e) { err = e.message; }
ok("bob cannot insert entitlements", !!err, err);
err = null;
try { await q(`update purchases set status = 'paid' where id = $1`, [pB]); } catch (e) { err = e.message; }
ok("bob's update of own purchase affects nothing",
  (await db.query(`update purchases set status = 'paid' where id = $1`, [pB])).affectedRows === 0);
err = null;
try { await fulfil("evt_x", "cs_B1", B); } catch (e) { err = e.message; }
ok("bob cannot call fulfill_checkout", !!err && /permission denied/.test(err), err);
err = null;
try { await q(`select * from claim_crm_sync($1)`, [pB2]); } catch (e) { err = e.message; }
ok("bob cannot call claim_crm_sync", !!err && /permission denied/.test(err), err);

// Storage as a client with no entitlement
await db.exec(`reset role; delete from entitlements where client_id = '${B}'; set role authenticated;`);
ok("unentitled bob cannot read the file", (await q(`select name from storage.objects`)).length === 0);
await db.exec(`select set_config('request.jwt.claim.sub', '${A}', false);`);
ok("entitled alice can read the file", (await q(`select name from storage.objects`)).length === 1);
await db.exec(`reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);`);
ok("anon sees no purchases", (await q(`select * from purchases`)).length === 0);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
