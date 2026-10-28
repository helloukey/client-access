-- Paid client access: schema, RLS, storage policy, fulfilment + CRM-sync functions.
--
-- Security model
--   * The browser uses the anon key + the client's JWT. It may only SELECT its own rows (RLS).
--   * No INSERT/UPDATE/DELETE policies exist for clients: every write goes through server code
--     using the service-role key (Stripe webhook, checkout route, CRM retry).
--   * Idempotency lives in the database (unique constraints + conditional updates), not in app memory.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.clients (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null unique,
  full_name       text,
  zoho_contact_id text,
  created_at      timestamptz not null default now()
);

create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  title           text not null,
  storage_path    text not null unique,      -- object name in the private `documents` bucket
  stripe_price_id text not null,
  amount          integer not null check (amount > 0),   -- minor units, must match the Stripe price
  currency        text not null default 'usd',
  created_at      timestamptz not null default now()
);

-- The stable link between a client, the thing they may buy, and the Zoho Deal tracking it.
-- Populated by the seed script; never derived from anything the browser sends.
create table public.offers (
  client_id    uuid not null references public.clients (id) on delete cascade,
  document_id  uuid not null references public.documents (id) on delete cascade,
  zoho_deal_id text not null unique,
  primary key (client_id, document_id)
);

create type public.purchase_status as enum ('pending', 'paid', 'failed', 'expired');

-- One row per checkout attempt.
create table public.purchases (
  id                         uuid primary key default gen_random_uuid(),
  client_id                  uuid not null references public.clients (id) on delete cascade,
  document_id                uuid not null references public.documents (id),
  zoho_deal_id               text not null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text,
  amount                     integer not null,
  currency                   text not null,
  status                     public.purchase_status not null default 'pending',
  -- Set when a second payment succeeds for something the client already owns (e.g. two tabs).
  -- No second entitlement / CRM update is created; an operator refunds it.
  needs_refund               boolean not null default false,
  paid_at                    timestamptz,
  created_at                 timestamptz not null default now()
);
create index purchases_client_id_idx on public.purchases (client_id);
create index purchases_client_document_idx on public.purchases (client_id, document_id, created_at desc);

-- Access grants. unique(client_id, document_id) makes a duplicate grant impossible.
create table public.entitlements (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  purchase_id uuid not null unique references public.purchases (id),
  granted_at  timestamptz not null default now(),
  unique (client_id, document_id)
);

-- Every Stripe event we have accepted. The PK is the dedupe for webhook re-deliveries.
create table public.stripe_events (
  event_id         text primary key,
  type             text not null,
  stripe_object_id text,
  outcome          text,
  received_at      timestamptz not null default now()
);

create type public.crm_sync_status as enum ('pending', 'in_progress', 'synced', 'failed', 'failed_permanent');

-- Outbox for the Zoho update. At most one row per purchase (PK), so at most one CRM update is owed.
create table public.crm_sync (
  purchase_id     uuid primary key references public.purchases (id) on delete cascade,
  zoho_deal_id    text not null,
  status          public.crm_sync_status not null default 'pending',
  attempts        integer not null default 0,
  last_error      text,
  last_attempt_at timestamptz,
  synced_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index crm_sync_due_idx on public.crm_sync (status) where status <> 'synced';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.clients       enable row level security;
alter table public.documents     enable row level security;
alter table public.offers        enable row level security;
alter table public.purchases     enable row level security;
alter table public.entitlements  enable row level security;
alter table public.stripe_events enable row level security;
alter table public.crm_sync      enable row level security;

create policy "clients: read own row" on public.clients
  for select to authenticated using (id = (select auth.uid()));

-- The catalogue is visible to any signed-in client. Knowing a storage_path grants nothing:
-- the storage policy below checks entitlements.
create policy "documents: signed-in clients read catalogue" on public.documents
  for select to authenticated using (true);

create policy "purchases: read own" on public.purchases
  for select to authenticated using (client_id = (select auth.uid()));

create policy "entitlements: read own" on public.entitlements
  for select to authenticated using (client_id = (select auth.uid()));

create policy "crm_sync: read own" on public.crm_sync
  for select to authenticated using (
    exists (
      select 1 from public.purchases p
      where p.id = crm_sync.purchase_id and p.client_id = (select auth.uid())
    )
  );

-- offers and stripe_events: no client policies at all (server-only).

-- ---------------------------------------------------------------------------
-- Storage: private bucket, readable only with an entitlement
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "documents bucket: entitled clients can read" on storage.objects
  for select to authenticated using (
    bucket_id = 'documents'
    and exists (
      select 1
      from public.entitlements e
      join public.documents d on d.id = e.document_id
      where e.client_id = (select auth.uid())
        and d.storage_path = storage.objects.name
    )
  );

-- ---------------------------------------------------------------------------
-- Fulfilment: one transaction, safe to call any number of times
-- ---------------------------------------------------------------------------
--
-- Outcomes:
--   duplicate_event   this Stripe event id was already processed -> nothing happens
--   unknown_session   not one of our checkouts (e.g. other activity on the Stripe account)
--   mismatch          client/amount/currency differ from what we created -> no access granted
--   fulfilled         access granted (or already granted for this purchase)
--   duplicate_payment client already owned the document via another purchase -> flagged for refund
--
-- crm_sync_created is true only the first time, so the caller triggers at most one Zoho update.

create or replace function public.fulfill_checkout(
  p_event_id            text,
  p_event_type          text,
  p_session_id          text,
  p_purchase_id         uuid,   -- from session.metadata; fallback lookup only
  p_client_reference_id text,
  p_payment_intent_id   text,
  p_amount_total        integer,
  p_currency            text
)
returns table (outcome text, purchase_id uuid, crm_sync_created boolean)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_purchase    public.purchases%rowtype;
  v_owner        uuid;
  v_crm_created  boolean := false;
  v_outcome      text;
begin
  insert into public.stripe_events (event_id, type, stripe_object_id)
  values (p_event_id, p_event_type, p_session_id)
  on conflict (event_id) do nothing;
  if not found then
    return query select 'duplicate_event'::text, null::uuid, false;
    return;
  end if;

  -- Match by the session id we stored at checkout; fall back to metadata.purchase_id only for a
  -- purchase that has no session recorded yet (checkout route crashed after creating the session).
  select * into v_purchase from public.purchases p
  where p.stripe_checkout_session_id = p_session_id
  for update;

  if not found and p_purchase_id is not null then
    select * into v_purchase from public.purchases p
    where p.id = p_purchase_id and p.stripe_checkout_session_id is null
    for update;
  end if;

  if v_purchase.id is null then
    v_outcome := 'unknown_session';
  elsif v_purchase.client_id::text is distinct from p_client_reference_id
     or v_purchase.amount is distinct from p_amount_total
     or lower(v_purchase.currency) is distinct from lower(p_currency) then
    v_outcome := 'mismatch';
  end if;

  if v_outcome is not null then
    update public.stripe_events set outcome = v_outcome where event_id = p_event_id;
    return query select v_outcome, v_purchase.id, false;
    return;
  end if;

  update public.purchases p
  set status                     = 'paid',
      paid_at                    = coalesce(p.paid_at, now()),
      stripe_payment_intent_id   = coalesce(p_payment_intent_id, p.stripe_payment_intent_id),
      stripe_checkout_session_id = coalesce(p.stripe_checkout_session_id, p_session_id)
  where p.id = v_purchase.id;

  insert into public.entitlements (client_id, document_id, purchase_id)
  values (v_purchase.client_id, v_purchase.document_id, v_purchase.id)
  on conflict (client_id, document_id) do nothing;

  select e.purchase_id into v_owner from public.entitlements e
  where e.client_id = v_purchase.client_id and e.document_id = v_purchase.document_id;

  if v_owner <> v_purchase.id then
    update public.purchases p set needs_refund = true where p.id = v_purchase.id;
    v_outcome := 'duplicate_payment';
  else
    insert into public.crm_sync (purchase_id, zoho_deal_id)
    values (v_purchase.id, v_purchase.zoho_deal_id)
    on conflict on constraint crm_sync_pkey do nothing;
    v_crm_created := found;
    v_outcome := 'fulfilled';
  end if;

  update public.stripe_events set outcome = v_outcome where event_id = p_event_id;
  return query select v_outcome, v_purchase.id, v_crm_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- CRM sync claim: only one worker may send a given Zoho update at a time
-- ---------------------------------------------------------------------------
--
-- Returns the row only if this caller won the claim. 'synced' and 'failed_permanent' rows are never
-- claimed, so a synced purchase is never re-sent. A row stuck 'in_progress' (worker crashed mid-call)
-- becomes claimable again after p_stale_after.

create or replace function public.claim_crm_sync(
  p_purchase_id uuid,
  p_stale_after interval default interval '5 minutes'
)
returns setof public.crm_sync
language sql
set search_path = public
as $$
  update public.crm_sync c
  set status          = 'in_progress',
      attempts        = c.attempts + 1,
      last_attempt_at = now(),
      updated_at      = now()
  where c.purchase_id = p_purchase_id
    and (
      c.status in ('pending', 'failed')
      or (c.status = 'in_progress' and c.last_attempt_at < now() - p_stale_after)
    )
  returning c.*;
$$;

-- Server-only functions: not callable through PostgREST by anon/authenticated users.
revoke execute on function public.fulfill_checkout(text, text, text, uuid, text, text, integer, text)
  from public, anon, authenticated;
revoke execute on function public.claim_crm_sync(uuid, interval) from public, anon, authenticated;
grant execute on function public.fulfill_checkout(text, text, text, uuid, text, text, integer, text) to service_role;
grant execute on function public.claim_crm_sync(uuid, interval) to service_role;
