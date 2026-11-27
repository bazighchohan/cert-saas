-- =============================================================================
-- 014_pilot_approval_and_gateway.sql — Approval-gated pilot signup flow,
-- organization pending/rejected/active/suspended lifecycle, shared purchase
-- activation RPC, payment_settings (bank/JazzCash/Easypaisa), and disabled-by-
-- default payment gateway schema + idempotent webhook processor
--
-- Run AFTER 001..013 in Supabase SQL Editor. Safe to re-run.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. public.organizations: expand status ('pending', 'active', 'rejected',
--    'suspended'), default new orgs to 'pending', and store pilot contact info
--    + approval / rejection metadata.
--    Existing organizations keep their current status ('active' / 'suspended').
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum   = any (c.conkey)
     where c.conrelid = 'public.organizations'::regclass
       and c.contype  = 'c'
       and a.attname  = 'status'
  loop
    execute format('alter table public.organizations drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.organizations
  alter column status set default 'pending';

alter table public.organizations
  add constraint organizations_status_check
    check (status in ('pending', 'active', 'rejected', 'suspended'));

alter table public.organizations
  add column if not exists contact_name     text
    check (contact_name is null or length(btrim(contact_name)) between 1 and 200),
  add column if not exists contact_email    text
    check (contact_email is null or length(btrim(contact_email)) <= 254),
  add column if not exists whatsapp_number  text
    check (whatsapp_number is null or length(btrim(whatsapp_number)) between 5 and 40),
  add column if not exists rejection_reason text
    check (rejection_reason is null or length(btrim(rejection_reason)) <= 1000),
  add column if not exists approved_at      timestamptz,
  add column if not exists approved_by      text
    check (approved_by is null or length(btrim(approved_by)) <= 200),
  add column if not exists rejected_at      timestamptz,
  add column if not exists rejected_by      text
    check (rejected_by is null or length(btrim(rejected_by)) <= 200);

create index if not exists organizations_status_created_at_idx
  on public.organizations (status, created_at desc);

-- -----------------------------------------------------------------------------
-- 2. public.purchases & public.certificate_topups: add price_snapshot JSONB,
--    signup_idempotency_key unique, and allow gateway payment_method ('safepay')
-- -----------------------------------------------------------------------------
alter table public.purchases
  add column if not exists price_snapshot         jsonb not null default '{}'::jsonb,
  add column if not exists signup_idempotency_key text  unique;

update public.purchases
   set price_snapshot = jsonb_build_object(
         'events',           events_total,
         'certs_per_event',  certs_per_event,
         'months',           months,
         'list_price_pkr',   list_price_pkr,
         'discount_pkr',     discount_pkr,
         'final_price_pkr',  final_price_pkr,
         'currency',         'PKR'
       )
 where price_snapshot = '{}'::jsonb;

do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum   = any (c.conkey)
     where c.conrelid = 'public.purchases'::regclass
       and c.contype  = 'c'
       and a.attname  = 'payment_method'
  loop
    execute format('alter table public.purchases drop constraint %I', r.conname);
  end loop;

  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum   = any (c.conkey)
     where c.conrelid = 'public.certificate_topups'::regclass
       and c.contype  = 'c'
       and a.attname  = 'payment_method'
  loop
    execute format('alter table public.certificate_topups drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.purchases
  add constraint purchases_payment_method_check
    check (payment_method is null or payment_method in ('bank', 'jazzcash', 'easypaisa', 'pilot', 'manual', 'safepay'));

alter table public.certificate_topups
  add constraint certificate_topups_payment_method_check
    check (payment_method is null or payment_method in ('bank', 'jazzcash', 'easypaisa', 'manual', 'safepay'));

-- -----------------------------------------------------------------------------
-- 3. public.payment_settings (single row: Bank / JazzCash / Easypaisa details
--    used when REQUIRE_PAYMENT_PROOF=true, editable only by super_admins)
-- -----------------------------------------------------------------------------
create table if not exists public.payment_settings (
  id                       boolean     primary key default true check (id = true),
  bank_enabled             boolean     not null default true,
  bank_name                text        not null default 'Meezan Bank' check (length(bank_name) <= 120),
  bank_account_title       text        not null default 'Cert SaaS Technologies' check (length(bank_account_title) <= 160),
  bank_account_number      text        not null default '0101-0101234567' check (length(bank_account_number) <= 80),
  bank_iban                text        not null default 'PK00MEZN0001010101234567' check (length(bank_iban) <= 80),
  jazzcash_enabled         boolean     not null default true,
  jazzcash_account_title   text        not null default 'Cert SaaS' check (length(jazzcash_account_title) <= 160),
  jazzcash_number          text        not null default '0300-0000000' check (length(jazzcash_number) <= 40),
  easypaisa_enabled        boolean     not null default true,
  easypaisa_account_title  text        not null default 'Cert SaaS' check (length(easypaisa_account_title) <= 160),
  easypaisa_number         text        not null default '0345-0000000' check (length(easypaisa_number) <= 40),
  instructions             text        not null default 'Transfer the exact PKR amount, save your confirmation receipt, and enter the transaction reference.'
    check (length(instructions) <= 1000),
  updated_at               timestamptz not null default now(),
  updated_by               uuid        references auth.users (id) on delete set null
);

create index if not exists payment_settings_updated_by_idx
  on public.payment_settings (updated_by);

drop trigger if exists set_updated_at on public.payment_settings;
create trigger set_updated_at before update on public.payment_settings
  for each row execute function public.set_updated_at();

insert into public.payment_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.payment_settings enable row level security;

revoke all on public.payment_settings from public, anon, authenticated;
grant select on public.payment_settings to authenticated;
grant update on public.payment_settings to authenticated;
grant all    on public.payment_settings to service_role;

drop policy if exists rls_payment_settings_select on public.payment_settings;
create policy rls_payment_settings_select on public.payment_settings
  for select to authenticated
  using (true);

drop policy if exists rls_payment_settings_superadmin_update on public.payment_settings;
create policy rls_payment_settings_superadmin_update on public.payment_settings
  for update to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- -----------------------------------------------------------------------------
-- 4. public.payments table (PART B: payment gateway records, off by default)
--    Composite FK (org_id, purchase_id) -> purchases(org_id, id) guarantees a
--    payment record can never point to a purchase in another organization.
-- -----------------------------------------------------------------------------
create table if not exists public.payments (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.organizations (id) on delete cascade,
  purchase_id   uuid        not null,
  provider      text        not null check (provider in ('manual', 'safepay')),
  provider_ref  text        not null unique check (length(btrim(provider_ref)) between 1 and 200),
  amount        int         not null check (amount >= 0),
  currency      text        not null default 'PKR' check (currency ~ '^[A-Z]{3}$'),
  status        text        not null default 'created'
                            check (status in ('created', 'paid', 'failed', 'refunded')),
  raw_event     jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  paid_at       timestamptz,
  constraint payments_purchase_fk
    foreign key (org_id, purchase_id) references public.purchases (org_id, id) on delete cascade
);

create index if not exists payments_org_purchase_idx
  on public.payments (org_id, purchase_id);

create index if not exists payments_purchase_id_idx
  on public.payments (purchase_id);

drop trigger if exists set_updated_at on public.payments;
create trigger set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

alter table public.payments enable row level security;

revoke all on public.payments from public, anon, authenticated;
grant select on public.payments to authenticated;
grant all    on public.payments to service_role;

drop policy if exists rls_payments_select on public.payments;
create policy rls_payments_select on public.payments
  for select to authenticated
  using (public.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- 5. Access-gate helper for Next.js Proxy: public.get_my_access_gate_status()
--    Returns ONLY the caller's own (auth.uid()) super-admin exemption + org status.
-- -----------------------------------------------------------------------------
create or replace function public.get_my_access_gate_status()
returns table (
  is_super_admin boolean,
  has_org        boolean,
  org_id         uuid,
  org_status     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_is_super   boolean := false;
  v_org_id     uuid := null;
  v_org_status text := null;
begin
  if v_uid is null then
    return query select false, false, null::uuid, null::text;
    return;
  end if;

  select exists (
    select 1 from public.super_admins sa where sa.user_id = v_uid
  ) into v_is_super;

  select o.id, o.status
    into v_org_id, v_org_status
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
   where m.user_id = v_uid
   order by m.created_at asc
   limit 1;

  return query select
    v_is_super,
    (v_org_id is not null),
    v_org_id,
    v_org_status;
end;
$$;

revoke execute on function public.get_my_access_gate_status() from public, anon;
grant  execute on function public.get_my_access_gate_status() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Update create_organization_for_user to default new organizations to
--    status = 'pending' (never auto-activating unapproved signups).
-- -----------------------------------------------------------------------------
drop function if exists public.create_organization_for_user(uuid, text);

create or replace function public.create_organization_for_user(
  p_user_id        uuid,
  p_org_name       text default null,
  p_initial_status text default 'pending'
)
returns table (
  org_id     uuid,
  org_name   text,
  org_slug   text,
  plan_id    text,
  role       text,
  org_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_org_id   uuid;
  v_existing_org_name text;
  v_existing_org_slug text;
  v_existing_plan_id  text;
  v_existing_role     text;
  v_existing_status   text;
  v_meta_org_name     text;
  v_user_email        text;
  v_email_local       text;
  v_clean_name        text;
  v_base_slug         text;
  v_slug              text;
  v_new_org_id        uuid;
  v_status            text;
  v_attempt           int := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  v_status := coalesce(nullif(btrim(p_initial_status), ''), 'pending');
  if v_status not in ('pending', 'active', 'rejected', 'suspended') then
    raise exception 'Invalid initial status "%"', v_status;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select o.id, o.name, o.slug, o.plan_id, m.role, o.status
    into v_existing_org_id, v_existing_org_name, v_existing_org_slug, v_existing_plan_id, v_existing_role, v_existing_status
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
   where m.user_id = p_user_id
   order by m.created_at asc
   limit 1;

  if v_existing_org_id is not null then
    return query select
      v_existing_org_id,
      v_existing_org_name,
      v_existing_org_slug,
      v_existing_plan_id,
      v_existing_role,
      v_existing_status;
    return;
  end if;

  begin
    execute
      'select coalesce(raw_user_meta_data->>''organization_name'', raw_user_meta_data->>''org_name''), email
         from auth.users
        where id = $1'
      into v_meta_org_name, v_user_email
      using p_user_id;
  exception when undefined_column then
    v_meta_org_name := null;
    v_user_email    := null;
  end;

  v_clean_name := nullif(btrim(coalesce(p_org_name, '')), '');
  if v_clean_name is null then
    v_clean_name := nullif(btrim(coalesce(v_meta_org_name, '')), '');
  end if;

  if v_clean_name is null and v_user_email is not null then
    v_email_local := split_part(v_user_email, '@', 1);
    v_email_local := btrim(regexp_replace(v_email_local, '[^a-zA-Z0-9]+', ' ', 'g'));
    v_email_local := initcap(v_email_local);
    if length(v_email_local) >= 2 then
      v_clean_name := v_email_local;
    elsif length(v_email_local) = 1 then
      v_clean_name := upper(v_email_local) || ' Organization';
    end if;
  end if;

  if v_clean_name is null or length(v_clean_name) < 2 then
    v_clean_name := 'My Organization';
  end if;

  v_clean_name := left(v_clean_name, 200);

  v_base_slug := lower(regexp_replace(v_clean_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := regexp_replace(v_base_slug, '(^-+|-+$)', '', 'g');
  v_base_slug := substr(v_base_slug, 1, 50);
  v_base_slug := regexp_replace(v_base_slug, '-+$', '', 'g');
  if length(v_base_slug) < 2 then
    v_base_slug := 'org-' || substr(replace(p_user_id::text, '-', ''), 1, 8);
  end if;

  v_slug := v_base_slug;

  loop
    v_attempt := v_attempt + 1;
    begin
      insert into public.organizations (name, slug, plan_id, status, contact_email)
      values (v_clean_name, v_slug, null, v_status, lower(nullif(btrim(coalesce(v_user_email, '')), '')))
      returning id into v_new_org_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise exception 'Could not allocate a unique organization slug for "%"', v_clean_name;
      end if;
      v_slug := v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end;
  end loop;

  insert into public.organization_members (org_id, user_id, role)
  values (v_new_org_id, p_user_id, 'owner');

  insert into public.audit_log (org_id, user_id, action, details)
  values (
    v_new_org_id,
    p_user_id,
    'org.created',
    jsonb_build_object('name', v_clean_name, 'slug', v_slug, 'status', v_status, 'plan_id', null)
  );

  return query select v_new_org_id, v_clean_name, v_slug, null::text, 'owner'::text, v_status;
end;
$$;

revoke execute on function public.create_organization_for_user(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.create_organization_for_user(uuid, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 7. Idempotent Pilot Signup Transaction: public.signup_pending_organization
--    Atomically creates organization (status='pending'), owner membership,
--    pending purchase (with server-computed price_snapshot), and audit_log.
--    Double-clicks or retries for the same user return the existing records
--    without creating duplicate organizations or purchases.
-- -----------------------------------------------------------------------------
create or replace function public.signup_pending_organization(
  p_user_id          uuid,
  p_email            text,
  p_org_name         text,
  p_contact_name     text,
  p_whatsapp_number  text,
  p_plan_id          text,
  p_kind             text,
  p_events_total     int,
  p_certs_per_event  int,
  p_months           int,
  p_list_price_pkr   int,
  p_discount_pkr     int,
  p_final_price_pkr  int,
  p_price_snapshot   jsonb default '{}'::jsonb,
  p_idempotency_key  text default null
)
returns table (
  org_id           uuid,
  org_name         text,
  org_slug         text,
  org_status       text,
  purchase_id      uuid,
  purchase_status  text,
  already_existed  boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_org    public.organizations%rowtype;
  v_existing_pur    public.purchases%rowtype;
  v_clean_org_name  text;
  v_clean_contact   text;
  v_clean_email     text;
  v_clean_whatsapp  text;
  v_base_slug       text;
  v_slug            text;
  v_new_org_id      uuid;
  v_new_purchase_id uuid;
  v_idem_key        text;
  v_snapshot        jsonb;
  v_attempt         int := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  -- Serialize concurrent double-clicks / retries for the same user inside Postgres
  perform pg_advisory_xact_lock(hashtextextended('signup_user:' || p_user_id::text, 0));

  v_idem_key := coalesce(nullif(btrim(coalesce(p_idempotency_key, '')), ''), 'signup:' || p_user_id::text);

  -- Check if this user already belongs to an organization
  select o.*
    into v_existing_org
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
   where m.user_id = p_user_id
   order by m.created_at asc
   limit 1;

  if v_existing_org.id is not null then
    select p.*
      into v_existing_pur
      from public.purchases p
     where p.org_id = v_existing_org.id
     order by p.created_at asc
     limit 1;

    if v_existing_pur.id is not null then
      return query select
        v_existing_org.id,
        v_existing_org.name,
        v_existing_org.slug,
        v_existing_org.status,
        v_existing_pur.id,
        v_existing_pur.status,
        true;
      return;
    end if;

    -- Edge recovery: org existed without initial purchase -> attach the pending purchase once
    v_snapshot := case
      when p_price_snapshot is null or p_price_snapshot = '{}'::jsonb then
        jsonb_build_object(
          'events', p_events_total,
          'certs_per_event', p_certs_per_event,
          'months', p_months,
          'list_price_pkr', p_list_price_pkr,
          'discount_pkr', p_discount_pkr,
          'final_price_pkr', p_final_price_pkr,
          'currency', 'PKR'
        )
      else p_price_snapshot
    end;

    insert into public.purchases (
      org_id, requested_by, plan_id, kind, events_total, events_used, certs_per_event,
      months, list_price_pkr, discount_pkr, final_price_pkr, price_snapshot,
      is_pilot, payment_method, status, signup_idempotency_key
    )
    values (
      v_existing_org.id, p_user_id, nullif(btrim(coalesce(p_plan_id, '')), ''), p_kind,
      p_events_total, 0, p_certs_per_event, p_months,
      p_list_price_pkr, p_discount_pkr, p_final_price_pkr, v_snapshot,
      false, 'manual', 'pending', v_idem_key
    )
    on conflict (signup_idempotency_key) do update
      set updated_at = public.purchases.updated_at
    returning id into v_new_purchase_id;

    return query select
      v_existing_org.id,
      v_existing_org.name,
      v_existing_org.slug,
      v_existing_org.status,
      v_new_purchase_id,
      'pending'::text,
      true;
    return;
  end if;

  v_clean_org_name := left(btrim(coalesce(p_org_name, '')), 200);
  if length(v_clean_org_name) < 2 then
    raise exception 'Organization name must be at least 2 characters.';
  end if;

  v_clean_contact  := left(btrim(coalesce(p_contact_name, '')), 200);
  v_clean_email    := lower(left(btrim(coalesce(p_email, '')), 254));
  v_clean_whatsapp := left(btrim(coalesce(p_whatsapp_number, '')), 40);

  if length(v_clean_contact) < 2 then
    raise exception 'Contact person name is required.';
  end if;
  if length(v_clean_whatsapp) < 5 then
    raise exception 'WhatsApp number is required.';
  end if;

  v_base_slug := lower(regexp_replace(v_clean_org_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := regexp_replace(v_base_slug, '(^-+|-+$)', '', 'g');
  v_base_slug := substr(v_base_slug, 1, 50);
  v_base_slug := regexp_replace(v_base_slug, '-+$', '', 'g');
  if length(v_base_slug) < 2 then
    v_base_slug := 'org-' || substr(replace(p_user_id::text, '-', ''), 1, 8);
  end if;

  v_slug := v_base_slug;

  loop
    v_attempt := v_attempt + 1;
    begin
      insert into public.organizations (
        name,
        slug,
        plan_id,
        status,
        contact_name,
        contact_email,
        whatsapp_number
      )
      values (
        v_clean_org_name,
        v_slug,
        nullif(btrim(coalesce(p_plan_id, '')), ''),
        'pending',
        v_clean_contact,
        v_clean_email,
        v_clean_whatsapp
      )
      returning id into v_new_org_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise exception 'Could not allocate a unique organization slug for "%"', v_clean_org_name;
      end if;
      v_slug := v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end;
  end loop;

  insert into public.organization_members (org_id, user_id, role)
  values (v_new_org_id, p_user_id, 'owner');

  v_snapshot := case
    when p_price_snapshot is null or p_price_snapshot = '{}'::jsonb then
      jsonb_build_object(
        'events', p_events_total,
        'certs_per_event', p_certs_per_event,
        'months', p_months,
        'list_price_pkr', p_list_price_pkr,
        'discount_pkr', p_discount_pkr,
        'final_price_pkr', p_final_price_pkr,
        'currency', 'PKR'
      )
    else p_price_snapshot
  end;

  insert into public.purchases (
    org_id,
    requested_by,
    plan_id,
    kind,
    events_total,
    events_used,
    certs_per_event,
    months,
    list_price_pkr,
    discount_pkr,
    final_price_pkr,
    price_snapshot,
    is_pilot,
    payment_method,
    status,
    signup_idempotency_key
  )
  values (
    v_new_org_id,
    p_user_id,
    nullif(btrim(coalesce(p_plan_id, '')), ''),
    p_kind,
    p_events_total,
    0,
    p_certs_per_event,
    p_months,
    p_list_price_pkr,
    p_discount_pkr,
    p_final_price_pkr,
    v_snapshot,
    false,
    'manual',
    'pending',
    v_idem_key
  )
  returning id into v_new_purchase_id;

  insert into public.audit_log (org_id, user_id, action, details)
  values (
    v_new_org_id,
    p_user_id,
    'signup.pending_created',
    jsonb_build_object(
      'org_name', v_clean_org_name,
      'contact_name', v_clean_contact,
      'contact_email', v_clean_email,
      'whatsapp_number', v_clean_whatsapp,
      'purchase_id', v_new_purchase_id,
      'plan_id', nullif(btrim(coalesce(p_plan_id, '')), ''),
      'kind', p_kind,
      'events_total', p_events_total,
      'certs_per_event', p_certs_per_event,
      'months', p_months,
      'list_price_pkr', p_list_price_pkr,
      'final_price_pkr', p_final_price_pkr
    )
  );

  return query select
    v_new_org_id,
    v_clean_org_name,
    v_slug,
    'pending'::text,
    v_new_purchase_id,
    'pending'::text,
    false;
end;
$$;

revoke execute on function public.signup_pending_organization(
  uuid, text, text, text, text, text, text, int, int, int, int, int, int, jsonb, text
) from public, anon, authenticated;
grant execute on function public.signup_pending_organization(
  uuid, text, text, text, text, text, text, int, int, int, int, int, int, jsonb, text
) to service_role;

-- -----------------------------------------------------------------------------
-- 8. Shared Idempotent Activation Function: public.activate_purchase_and_organization
--    Used by BOTH:
--      a) Manual approval in /superadmin/requests ("Approve as pilot" / "Approve as paid")
--         and /superadmin/payments
--      b) Webhook activation in /api/webhooks/safepay
-- -----------------------------------------------------------------------------
create or replace function public.activate_purchase_and_organization(
  p_purchase_id    uuid,
  p_is_pilot       boolean default false,
  p_payment_note   text default null,
  p_actor_user_id  uuid default null,
  p_actor_label    text default 'super_admin',
  p_payment_method text default null
)
returns table (
  org_id            uuid,
  purchase_id       uuid,
  org_status        text,
  purchase_status   text,
  is_pilot          boolean,
  discount_pkr      int,
  final_price_pkr   int,
  starts_at         timestamptz,
  expires_at        timestamptz,
  already_processed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pur          public.purchases%rowtype;
  v_org          public.organizations%rowtype;
  v_discount     int;
  v_final        int;
  v_method       text;
  v_max_exp      timestamptz;
  v_audit_action text;
begin
  if p_purchase_id is null then
    raise exception 'p_purchase_id is required';
  end if;

  select *
    into v_pur
    from public.purchases p
   where p.id = p_purchase_id
   for update;

  if v_pur.id is null then
    raise exception 'PURCHASE_NOT_FOUND: Purchase not found.';
  end if;

  select *
    into v_org
    from public.organizations o
   where o.id = v_pur.org_id
   for update;

  if v_org.id is null then
    raise exception 'ORG_NOT_FOUND: Organization not found.';
  end if;

  if v_org.status = 'suspended' then
    raise exception 'ORG_SUSPENDED: Cannot activate a suspended organization.';
  end if;

  -- Idempotency: if already active, return existing state without extending expiry or duplicating logs
  if v_pur.status = 'active' and v_org.status = 'active' then
    return query select
      v_org.id,
      v_pur.id,
      v_org.status,
      v_pur.status,
      v_pur.is_pilot,
      v_pur.discount_pkr,
      v_pur.final_price_pkr,
      v_pur.starts_at,
      v_pur.expires_at,
      true;
    return;
  end if;

  if v_pur.status = 'rejected' then
    raise exception 'PURCHASE_REJECTED: Purchase has already been rejected.';
  end if;

  if v_pur.status = 'expired' then
    raise exception 'PURCHASE_EXPIRED: Purchase has already expired.';
  end if;

  if coalesce(p_is_pilot, false) then
    -- Approve as pilot: discount = full price, final_price_pkr = 0
    v_discount     := greatest(v_pur.list_price_pkr, v_pur.final_price_pkr);
    v_final        := 0;
    v_method       := coalesce(nullif(btrim(coalesce(p_payment_method, '')), ''), 'pilot');
    v_audit_action := 'superadmin.request_approved_pilot';
  else
    v_discount     := v_pur.discount_pkr;
    v_final        := v_pur.final_price_pkr;
    v_method       := coalesce(nullif(btrim(coalesce(p_payment_method, '')), ''), v_pur.payment_method, 'manual');
    v_audit_action := case
      when v_method = 'safepay' then 'payment.webhook_activated'
      else 'superadmin.request_approved_paid'
    end;
  end if;

  update public.purchases p
     set status          = 'active',
         is_pilot        = coalesce(p_is_pilot, false),
         discount_pkr    = v_discount,
         final_price_pkr = v_final,
         payment_method  = v_method,
         payment_note    = coalesce(nullif(btrim(coalesce(p_payment_note, '')), ''), p.payment_note),
         starts_at       = now(),
         expires_at      = now() + make_interval(months => p.months),
         reviewed_by     = coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), 'super_admin'),
         reviewed_at     = now()
   where p.id = p_purchase_id
  returning * into v_pur;

  select max(p2.expires_at)
    into v_max_exp
    from public.purchases p2
   where p2.org_id = v_org.id
     and p2.status = 'active';

  update public.organizations o
     set status             = 'active',
         rejection_reason   = null,
         approved_at        = coalesce(o.approved_at, now()),
         approved_by        = coalesce(o.approved_by, nullif(btrim(coalesce(p_actor_label, '')), '')),
         plan_id            = coalesce(v_pur.plan_id, o.plan_id),
         plan_expires_at    = v_max_exp,
         plan_expiring_soon = false,
         expiry_flagged_at  = null
   where o.id = v_org.id
  returning * into v_org;

  insert into public.audit_log (org_id, user_id, action, details)
  values (
    v_org.id,
    coalesce(p_actor_user_id, v_pur.requested_by),
    v_audit_action,
    jsonb_build_object(
      'purchase_id', v_pur.id,
      'kind', v_pur.kind,
      'plan_id', v_pur.plan_id,
      'events_total', v_pur.events_total,
      'certs_per_event', v_pur.certs_per_event,
      'months', v_pur.months,
      'is_pilot', v_pur.is_pilot,
      'list_price_pkr', v_pur.list_price_pkr,
      'discount_pkr', v_pur.discount_pkr,
      'final_price_pkr', v_pur.final_price_pkr,
      'payment_method', v_pur.payment_method,
      'payment_note', v_pur.payment_note,
      'starts_at', v_pur.starts_at,
      'expires_at', v_pur.expires_at,
      'reviewed_by', v_pur.reviewed_by
    )
  );

  return query select
    v_org.id,
    v_pur.id,
    v_org.status,
    v_pur.status,
    v_pur.is_pilot,
    v_pur.discount_pkr,
    v_pur.final_price_pkr,
    v_pur.starts_at,
    v_pur.expires_at,
    false;
end;
$$;

revoke execute on function public.activate_purchase_and_organization(uuid, boolean, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function public.activate_purchase_and_organization(uuid, boolean, text, uuid, text, text) to service_role;

-- Keep review_purchase_request aligned with activate_purchase_and_organization
create or replace function public.review_purchase_request(
  p_purchase_id uuid,
  p_decision    text, -- 'active' | 'approved' | 'rejected'
  p_reviewer    text default 'super_admin',
  p_note        text default null
)
returns table (
  purchase_id uuid,
  org_id      uuid,
  new_status  text,
  starts_at   timestamptz,
  expires_at  timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pur public.purchases%rowtype;
  v_act record;
begin
  if p_decision in ('approved', 'active') then
    select *
      into v_act
      from public.activate_purchase_and_organization(
        p_purchase_id,
        false,
        p_note,
        null,
        p_reviewer,
        null
      );

    return query select
      v_act.purchase_id,
      v_act.org_id,
      v_act.purchase_status,
      v_act.starts_at,
      v_act.expires_at;
    return;
  elsif p_decision = 'rejected' then
    select *
      into v_pur
      from public.purchases p
     where p.id = p_purchase_id
     for update;

    if v_pur.id is null then
      raise exception 'Purchase request not found.';
    end if;

    if v_pur.status = 'rejected' then
      return query select v_pur.id, v_pur.org_id, v_pur.status, v_pur.starts_at, v_pur.expires_at;
      return;
    end if;

    if v_pur.status <> 'pending' then
      raise exception 'Purchase % is already % and cannot be rejected.', v_pur.id, v_pur.status;
    end if;

    update public.purchases p
       set status       = 'rejected',
           reviewed_by  = coalesce(nullif(btrim(p_reviewer), ''), 'super_admin'),
           reviewed_at  = now(),
           payment_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), p.payment_note)
     where p.id = p_purchase_id
    returning * into v_pur;

    insert into public.audit_log (org_id, user_id, action, details)
    values (
      v_pur.org_id,
      v_pur.requested_by,
      'billing.purchase_rejected',
      jsonb_build_object(
        'purchase_id', v_pur.id,
        'kind', v_pur.kind,
        'final_price_pkr', v_pur.final_price_pkr,
        'payment_note', v_pur.payment_note,
        'reviewed_by', v_pur.reviewed_by
      )
    );

    return query select v_pur.id, v_pur.org_id, v_pur.status, v_pur.starts_at, v_pur.expires_at;
    return;
  else
    raise exception 'Invalid decision "%" (expected approved or rejected)', p_decision;
  end if;
end;
$$;

revoke execute on function public.review_purchase_request(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.review_purchase_request(uuid, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 9. Idempotent Organization Signup Rejection RPC:
--    public.reject_organization_signup_request
-- -----------------------------------------------------------------------------
create or replace function public.reject_organization_signup_request(
  p_org_id         uuid,
  p_purchase_id    uuid default null,
  p_reason         text default null,
  p_actor_user_id  uuid default null,
  p_actor_label    text default 'super_admin'
)
returns table (
  org_id            uuid,
  org_status        text,
  rejection_reason  text,
  already_processed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org          public.organizations%rowtype;
  v_clean_reason text;
begin
  if p_org_id is null then
    raise exception 'p_org_id is required';
  end if;

  v_clean_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_clean_reason is null then
    raise exception 'REJECTION_REASON_REQUIRED: Please provide a reason for rejecting this organization.';
  end if;

  select *
    into v_org
    from public.organizations o
   where o.id = p_org_id
   for update;

  if v_org.id is null then
    raise exception 'ORG_NOT_FOUND: Organization not found.';
  end if;

  -- Idempotent: already rejected
  if v_org.status = 'rejected' then
    return query select
      v_org.id,
      v_org.status,
      v_org.rejection_reason,
      true;
    return;
  end if;

  if v_org.status = 'active' then
    raise exception 'ORG_ALREADY_ACTIVE: Organization is already active; use suspend instead.';
  end if;

  update public.organizations o
     set status           = 'rejected',
         rejection_reason = left(v_clean_reason, 1000),
         rejected_at      = now(),
         rejected_by      = coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), 'super_admin')
   where o.id = p_org_id
  returning * into v_org;

  update public.purchases p
     set status       = 'rejected',
         payment_note = left(v_clean_reason, 1000),
         reviewed_by  = coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), 'super_admin'),
         reviewed_at  = now()
   where p.org_id = p_org_id
     and p.status = 'pending'
     and (p_purchase_id is null or p.id = p_purchase_id);

  insert into public.audit_log (org_id, user_id, action, details)
  values (
    v_org.id,
    p_actor_user_id,
    'superadmin.request_rejected',
    jsonb_build_object(
      'purchase_id', p_purchase_id,
      'reason', v_org.rejection_reason,
      'rejected_by', v_org.rejected_by
    )
  );

  return query select
    v_org.id,
    v_org.status,
    v_org.rejection_reason,
    false;
end;
$$;

revoke execute on function public.reject_organization_signup_request(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant  execute on function public.reject_organization_signup_request(uuid, uuid, text, uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 10. Idempotent Payment Webhook Processor RPC: public.process_payment_webhook
--     - Looks up payment by unique (provider, provider_ref) inside transaction
--     - Verifies webhook amount & currency against stored purchases.price_snapshot
--       (never trusts client or webhook amount)
--     - Handles replayed webhooks idempotently
--     - Activates purchase + organization via public.activate_purchase_and_organization
-- -----------------------------------------------------------------------------
create or replace function public.process_payment_webhook(
  p_provider         text,
  p_provider_ref     text,
  p_event_status     text, -- 'paid' | 'failed' | 'refunded'
  p_webhook_amount   int,
  p_webhook_currency text,
  p_raw_event        jsonb default '{}'::jsonb
)
returns table (
  ok                boolean,
  code              text,
  http_status       int,
  already_processed boolean,
  org_id            uuid,
  purchase_id       uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay               public.payments%rowtype;
  v_pur               public.purchases%rowtype;
  v_expected_amount   int;
  v_expected_currency text;
  v_act               record;
begin
  if p_provider is null or p_provider_ref is null then
    return query select false, 'INVALID_PARAMETERS'::text, 400, false, null::uuid, null::uuid;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('payment_webhook:' || p_provider || ':' || p_provider_ref, 0)
  );

  select *
    into v_pay
    from public.payments pm
   where pm.provider     = p_provider
     and pm.provider_ref = p_provider_ref
   for update;

  if v_pay.id is null then
    return query select false, 'PAYMENT_NOT_FOUND'::text, 404, false, null::uuid, null::uuid;
    return;
  end if;

  select *
    into v_pur
    from public.purchases p
   where p.id     = v_pay.purchase_id
     and p.org_id = v_pay.org_id
   for update;

  if v_pur.id is null then
    return query select false, 'PURCHASE_NOT_FOUND'::text, 404, false, v_pay.org_id, v_pay.purchase_id;
    return;
  end if;

  -- Replayed 'paid' webhook -> return 200 idempotently without re-activating
  if v_pay.status = 'paid' and p_event_status = 'paid' then
    return query select true, 'ALREADY_PROCESSED'::text, 200, true, v_pay.org_id, v_pay.purchase_id;
    return;
  end if;

  -- Authoritative price_snapshot check: NEVER trust webhook or client amount
  v_expected_amount := coalesce(
    nullif(v_pur.price_snapshot->>'final_price_pkr', '')::int,
    v_pur.final_price_pkr
  );
  v_expected_currency := upper(coalesce(
    nullif(v_pur.price_snapshot->>'currency', ''),
    v_pay.currency,
    'PKR'
  ));

  if p_webhook_amount is distinct from v_expected_amount
     or v_pay.amount is distinct from v_expected_amount
     or upper(coalesce(p_webhook_currency, '')) is distinct from v_expected_currency
  then
    insert into public.audit_log (org_id, user_id, action, details)
    values (
      v_pay.org_id,
      null,
      'payment.webhook_amount_mismatch',
      jsonb_build_object(
        'payment_id', v_pay.id,
        'purchase_id', v_pur.id,
        'provider', p_provider,
        'provider_ref', p_provider_ref,
        'expected_amount', v_expected_amount,
        'webhook_amount', p_webhook_amount,
        'expected_currency', v_expected_currency,
        'webhook_currency', p_webhook_currency
      )
    );

    return query select false, 'AMOUNT_MISMATCH'::text, 400, false, v_pay.org_id, v_pay.purchase_id;
    return;
  end if;

  if p_event_status = 'paid' then
    update public.payments pm
       set status    = 'paid',
           paid_at   = coalesce(pm.paid_at, now()),
           raw_event = coalesce(p_raw_event, '{}'::jsonb)
     where pm.id = v_pay.id;

    select *
      into v_act
      from public.activate_purchase_and_organization(
        v_pur.id,
        false,
        'Paid via ' || p_provider || ' (' || p_provider_ref || ')',
        null,
        'webhook:' || p_provider,
        p_provider
      );

    return query select
      true,
      'ACTIVATED'::text,
      200,
      coalesce(v_act.already_processed, false),
      v_pay.org_id,
      v_pay.purchase_id;
    return;
  elsif p_event_status in ('failed', 'refunded') then
    if v_pay.status = p_event_status then
      return query select true, 'ALREADY_PROCESSED'::text, 200, true, v_pay.org_id, v_pay.purchase_id;
      return;
    end if;

    update public.payments pm
       set status    = p_event_status,
           raw_event = coalesce(p_raw_event, '{}'::jsonb)
     where pm.id = v_pay.id;

    insert into public.audit_log (org_id, user_id, action, details)
    values (
      v_pay.org_id,
      null,
      'payment.webhook_' || p_event_status,
      jsonb_build_object(
        'payment_id', v_pay.id,
        'purchase_id', v_pur.id,
        'provider', p_provider,
        'provider_ref', p_provider_ref
      )
    );

    return query select true, upper(p_event_status)::text, 200, false, v_pay.org_id, v_pay.purchase_id;
    return;
  else
    return query select false, 'UNSUPPORTED_EVENT_STATUS'::text, 400, false, v_pay.org_id, v_pay.purchase_id;
    return;
  end if;
end;
$$;

revoke execute on function public.process_payment_webhook(text, text, text, int, text, jsonb) from public, anon, authenticated;
grant  execute on function public.process_payment_webhook(text, text, text, int, text, jsonb) to service_role;

commit;
