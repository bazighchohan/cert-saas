-- =============================================================================
-- 013_pricing_and_purchases.sql — Dynamic pricing engine (pricing_config),
-- preset plans (no Free plan, no hardcoded prices), package purchases,
-- certificate top-ups, transactional slot consumption, per-event max_certificates,
-- 12-month public retention_until, daily expiry cron, and pilot migration
--
-- Run AFTER 001..012 in Supabase SQL Editor. Safe to re-run.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. public.pricing_config (single row, editable by super_admins / service_role)
-- -----------------------------------------------------------------------------
create table if not exists public.pricing_config (
  id                    boolean     primary key default true check (id = true),
  event_fee_pkr         int         not null default 500 check (event_fee_pkr >= 0),
  cert_rate_pkr         int         not null default 5 check (cert_rate_pkr >= 0),
  volume_discounts      jsonb       not null default '[{"min_events":1,"discount":0},{"min_events":2,"discount":0.2},{"min_events":4,"discount":0.35},{"min_events":7,"discount":0.5}]'::jsonb,
  duration_multipliers  jsonb       not null default '[{"months":3,"mult":1.0},{"months":6,"mult":1.05},{"months":12,"mult":1.1}]'::jsonb,
  rounding_pkr          int         not null default 50 check (rounding_pkr >= 1),
  min_events            int         not null default 1 check (min_events >= 1),
  max_events            int         not null default 20 check (max_events >= min_events),
  min_certs_per_event   int         not null default 25 check (min_certs_per_event >= 1),
  max_certs_per_event   int         not null default 500 check (max_certs_per_event >= min_certs_per_event),
  certs_step            int         not null default 25 check (certs_step >= 1),
  allowed_months        int[]       not null default array[3, 6, 12],
  updated_at            timestamptz not null default now(),
  updated_by            uuid        references auth.users (id) on delete set null
);

drop trigger if exists set_updated_at on public.pricing_config;
create trigger set_updated_at before update on public.pricing_config
  for each row execute function public.set_updated_at();

insert into public.pricing_config (id)
values (true)
on conflict (id) do nothing;

create index if not exists pricing_config_updated_by_idx
  on public.pricing_config (updated_by);

create index if not exists payment_requests_requested_by_idx
  on public.payment_requests (requested_by);

alter table public.pricing_config enable row level security;

revoke all on public.pricing_config from public, anon, authenticated;
grant select on public.pricing_config to anon, authenticated;
grant update on public.pricing_config to authenticated;
grant all    on public.pricing_config to service_role;

drop policy if exists rls_pricing_config_select on public.pricing_config;
create policy rls_pricing_config_select on public.pricing_config
  for select to anon, authenticated
  using (true);

drop policy if exists rls_pricing_config_superadmin_update on public.pricing_config;
create policy rls_pricing_config_superadmin_update on public.pricing_config
  for update to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- -----------------------------------------------------------------------------
-- 2. Refactor public.plans into presets ONLY (configuration, NO prices; remove Free)
-- -----------------------------------------------------------------------------
alter table public.organizations
  alter column plan_id drop not null;

alter table public.payment_requests
  alter column plan_id drop not null;

alter table public.payment_requests
  drop constraint if exists payment_requests_plan_id_fkey;

alter table public.plans
  add column if not exists kind            text not null default 'single'
    check (kind in ('single', 'multi', 'pro', 'custom')),
  add column if not exists events_count    int  not null default 1
    check (events_count between 1 and 20),
  add column if not exists certs_per_event int  not null default 50
    check (certs_per_event between 25 and 500 and certs_per_event % 25 = 0),
  add column if not exists months          int  not null default 3
    check (months in (3, 6, 12)),
  add column if not exists sort_order      int  not null default 0;

-- Remove stored prices & legacy plan quota columns from plans so computePrice is the single source of truth
alter table public.plans
  drop column if exists price_pkr,
  drop column if exists max_events,
  drop column if exists max_certificates_per_event,
  drop column if exists max_certificates_total;

-- Clear legacy 'free' / 'starter' references on organizations before removing those rows
update public.organizations
   set plan_id = null
 where plan_id is not null
   and plan_id not in ('single-50', 'single-100', 'multi-50', 'multi-100', 'pro');

delete from public.plans
 where id not in ('single-50', 'single-100', 'multi-50', 'multi-100', 'pro');

insert into public.plans (
  id, name, kind, events_count, certs_per_event, months, allow_custom_branding, sort_order, active
)
values
  ('single-50',  'Single (50 certs)',     'single', 1,  50,  3,  true, 1, true),
  ('single-100', 'Single (100 certs)',    'single', 1,  100, 3,  true, 2, true),
  ('multi-50',   'Multi (3 × 50 certs)',  'multi',  3,  50,  3,  true, 3, true),
  ('multi-100',  'Multi (3 × 100 certs)', 'multi',  3,  100, 3,  true, 4, true),
  ('pro',        'Pro (10 × 100 certs)',  'pro',    10, 100, 12, true, 5, true)
on conflict (id) do update
  set name                  = excluded.name,
      kind                  = excluded.kind,
      events_count          = excluded.events_count,
      certs_per_event       = excluded.certs_per_event,
      months                = excluded.months,
      allow_custom_branding = excluded.allow_custom_branding,
      sort_order            = excluded.sort_order,
      active                = excluded.active;

-- -----------------------------------------------------------------------------
-- 3. public.purchases table (org members SELECT own rows; only server writes)
-- -----------------------------------------------------------------------------
create table if not exists public.purchases (
  id                     uuid        primary key default gen_random_uuid(),
  org_id                 uuid        not null references public.organizations (id) on delete cascade,
  requested_by           uuid        references auth.users (id) on delete set null,
  plan_id                text        references public.plans (id) on delete set null,
  kind                   text        not null check (kind in ('single', 'multi', 'pro', 'custom')),
  events_total           int         not null check (events_total >= 1),
  events_used            int         not null default 0 check (events_used >= 0 and events_used <= events_total),
  certs_per_event        int         not null check (certs_per_event >= 25),
  months                 int         not null check (months in (3, 6, 12)),
  list_price_pkr         int         not null check (list_price_pkr >= 0),
  discount_pkr           int         not null default 0 check (discount_pkr >= 0),
  final_price_pkr        int         not null check (final_price_pkr >= 0),
  is_pilot               boolean     not null default false,
  payment_method         text        check (payment_method is null or payment_method in ('bank', 'jazzcash', 'easypaisa', 'pilot', 'manual')),
  transaction_reference  text        check (transaction_reference is null or length(transaction_reference) <= 120),
  screenshot_path        text        check (screenshot_path is null or screenshot_path like (org_id::text || '/%')),
  payment_note           text        check (payment_note is null or length(payment_note) <= 1000),
  status                 text        not null default 'pending' check (status in ('pending', 'active', 'rejected', 'expired')),
  starts_at              timestamptz,
  expires_at             timestamptz,
  reviewed_by            text        check (reviewed_by is null or length(reviewed_by) <= 200),
  reviewed_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- Target for composite FK on events (org_id, purchase_id) so an org can NEVER consume another org's purchase
  constraint purchases_org_id_id_key unique (org_id, id)
);

create index if not exists purchases_org_status_expires_idx
  on public.purchases (org_id, status, expires_at asc, created_at asc);

create index if not exists purchases_status_created_idx
  on public.purchases (status, created_at desc);

create index if not exists purchases_requested_by_idx
  on public.purchases (requested_by);

create index if not exists purchases_plan_id_idx
  on public.purchases (plan_id);

drop trigger if exists set_updated_at on public.purchases;
create trigger set_updated_at before update on public.purchases
  for each row execute function public.set_updated_at();

alter table public.purchases enable row level security;

revoke all on public.purchases from public, anon, authenticated;
grant select on public.purchases to authenticated;
grant all    on public.purchases to service_role;

drop policy if exists rls_purchases_select on public.purchases;
create policy rls_purchases_select on public.purchases
  for select to authenticated
  using (public.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- 4. public.events: add purchase_id, max_certificates, retention_until
-- -----------------------------------------------------------------------------
alter table public.events
  add column if not exists purchase_id      uuid,
  add column if not exists max_certificates int  not null default 50 check (max_certificates >= 1),
  add column if not exists retention_until  timestamptz;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'events_purchase_fk'
  ) then
    alter table public.events
      add constraint events_purchase_fk
        foreign key (org_id, purchase_id)
        references public.purchases (org_id, id)
        on delete restrict;
  end if;
end $$;

create index if not exists events_org_purchase_id_idx
  on public.events (org_id, purchase_id);

-- -----------------------------------------------------------------------------
-- 5. public.certificate_topups table (server-recomputed top-ups for an event)
-- -----------------------------------------------------------------------------
create table if not exists public.certificate_topups (
  id                     uuid        primary key default gen_random_uuid(),
  org_id                 uuid        not null references public.organizations (id) on delete cascade,
  event_id               uuid        not null,
  requested_by           uuid        references auth.users (id) on delete set null,
  certs_added            int         not null check (certs_added between 1 and 10000),
  cert_rate_pkr          int         not null check (cert_rate_pkr >= 0),
  amount_pkr             int         not null check (amount_pkr >= 0),
  payment_method         text        check (payment_method is null or payment_method in ('bank', 'jazzcash', 'easypaisa', 'manual')),
  transaction_reference  text        check (transaction_reference is null or length(transaction_reference) <= 120),
  screenshot_path        text        check (screenshot_path is null or screenshot_path like (org_id::text || '/%')),
  payment_note           text        check (payment_note is null or length(payment_note) <= 1000),
  status                 text        not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by            text        check (reviewed_by is null or length(reviewed_by) <= 200),
  reviewed_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint certificate_topups_event_fk
    foreign key (org_id, event_id) references public.events (org_id, id) on delete cascade
);

create index if not exists certificate_topups_org_created_idx
  on public.certificate_topups (org_id, created_at desc);

create index if not exists certificate_topups_org_event_idx
  on public.certificate_topups (org_id, event_id);

create index if not exists certificate_topups_requested_by_idx
  on public.certificate_topups (requested_by);

create index if not exists certificate_topups_status_created_idx
  on public.certificate_topups (status, created_at desc);

drop trigger if exists set_updated_at on public.certificate_topups;
create trigger set_updated_at before update on public.certificate_topups
  for each row execute function public.set_updated_at();

alter table public.certificate_topups enable row level security;

revoke all on public.certificate_topups from public, anon, authenticated;
grant select on public.certificate_topups to authenticated;
grant all    on public.certificate_topups to service_role;

drop policy if exists rls_certificate_topups_select on public.certificate_topups;
create policy rls_certificate_topups_select on public.certificate_topups
  for select to authenticated
  using (public.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- 6. Migrate existing organizations and events to an active pilot purchase
--    so nothing breaks on existing deployments.
-- -----------------------------------------------------------------------------
do $$
declare
  r_org        record;
  v_ev_count   int;
  v_max_certs  int;
  v_pilot_id   uuid;
  v_expires_at timestamptz;
begin
  for r_org in
    select o.id, o.plan_expires_at
      from public.organizations o
     where not exists (
       select 1 from public.purchases p where p.org_id = o.id
     )
  loop
    select count(*)::int
      into v_ev_count
      from public.events e
     where e.org_id = r_org.id;

    select greatest(
      coalesce((
        select max(cnt)
          from (
            select count(*)::int as cnt
              from public.attendee_certificates ac
             where ac.org_id = r_org.id
             group by ac.event_id
            union all
            select count(*)::int as cnt
              from public.attendees a
             where a.org_id = r_org.id
             group by a.event_id
          ) counts_q
      ), 0),
      100
    )
    into v_max_certs;

    -- Round up to nearest 25
    v_max_certs := ((v_max_certs + 24) / 25) * 25;
    v_expires_at := coalesce(r_org.plan_expires_at, now() + interval '3 months');

    insert into public.purchases (
      org_id,
      plan_id,
      kind,
      events_total,
      events_used,
      certs_per_event,
      months,
      list_price_pkr,
      discount_pkr,
      final_price_pkr,
      is_pilot,
      payment_method,
      payment_note,
      status,
      starts_at,
      expires_at,
      reviewed_by,
      reviewed_at
    )
    values (
      r_org.id,
      null,
      'custom',
      greatest(v_ev_count, 1),
      v_ev_count,
      v_max_certs,
      3,
      0,
      0,
      0,
      true,
      'pilot',
      'Migrated pilot package for existing organization',
      case when v_expires_at <= now() then 'expired' else 'active' end,
      now(),
      v_expires_at,
      'migration_013',
      now()
    )
    returning id into v_pilot_id;

    update public.events e
       set purchase_id      = v_pilot_id,
           max_certificates = greatest(e.max_certificates, v_max_certs),
           retention_until  = case
                                when e.released then coalesce(e.retention_until, now() + interval '12 months')
                                else e.retention_until
                              end
     where e.org_id = r_org.id
       and e.purchase_id is null;

    update public.organizations o
       set plan_expires_at = v_expires_at
     where o.id = r_org.id
       and o.plan_expires_at is null;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Update RLS write helpers (is_org_writable + is_event_purchase_active)
--    so organizations without an active unexpired purchase are read-only at the
--    DB layer too, and events whose backing purchase has expired cannot accept
--    new attendees or edits while SELECT/exports remain open via is_org_member.
-- -----------------------------------------------------------------------------
create or replace function public.is_org_writable(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organizations o
      join public.organization_members m on m.org_id = o.id
     where o.id = p_org_id
       and m.user_id = (select auth.uid())
       and o.status = 'active'
       and exists (
         select 1
           from public.purchases p
          where p.org_id = o.id
            and p.status = 'active'
            and (p.expires_at is null or p.expires_at > now())
       )
  );
$$;

create or replace function public.is_event_purchase_active(
  p_org_id   uuid,
  p_event_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.events e
      join public.purchases p
        on p.org_id = e.org_id
       and p.id     = e.purchase_id
     where e.id     = p_event_id
       and e.org_id = p_org_id
       and p.status = 'active'
       and (p.expires_at is null or p.expires_at > now())
  );
$$;

revoke execute on function public.is_org_writable(uuid) from public, anon;
revoke execute on function public.is_event_purchase_active(uuid, uuid) from public, anon;
grant  execute on function public.is_org_writable(uuid) to authenticated, service_role;
grant  execute on function public.is_event_purchase_active(uuid, uuid) to authenticated, service_role;

-- Events must be created ONLY via the server transactional slot-consumption RPC
-- (not via raw PostgREST client insert bypassing slot accounting).
drop policy if exists rls_events_insert on public.events;
drop policy if exists rls_events_update on public.events;
drop policy if exists rls_events_delete on public.events;

create policy rls_events_update on public.events
  for update to authenticated
  using (public.is_org_writable(org_id) and public.is_event_purchase_active(org_id, id))
  with check (public.is_org_writable(org_id) and public.is_event_purchase_active(org_id, id));

create policy rls_events_delete on public.events
  for delete to authenticated
  using (public.is_org_writable(org_id));

do $$
declare t text;
begin
  foreach t in array array['certificate_types', 'attendees', 'attendee_certificates'] loop
    execute format('drop policy if exists rls_%1$s_insert on public.%1$I', t);
    execute format('drop policy if exists rls_%1$s_update on public.%1$I', t);
    execute format('drop policy if exists rls_%1$s_delete on public.%1$I', t);

    execute format(
      'create policy rls_%1$s_insert on public.%1$I for insert to authenticated
         with check (
           public.is_org_writable(org_id)
           and public.event_org_id(event_id) = org_id
           and public.is_event_purchase_active(org_id, event_id)
         )', t);
    execute format(
      'create policy rls_%1$s_update on public.%1$I for update to authenticated
         using (
           public.is_org_writable(org_id)
           and public.is_event_purchase_active(org_id, event_id)
         )
         with check (
           public.is_org_writable(org_id)
           and public.event_org_id(event_id) = org_id
           and public.is_event_purchase_active(org_id, event_id)
         )', t);
    execute format(
      'create policy rls_%1$s_delete on public.%1$I for delete to authenticated
         using (
           public.is_org_writable(org_id)
           and public.is_event_purchase_active(org_id, event_id)
         )', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 8. Update create_organization_for_user: NO Free plan, NO free purchase!
--    New organizations start with plan_id = NULL and 0 purchases.
-- -----------------------------------------------------------------------------
create or replace function public.create_organization_for_user(
  p_user_id  uuid,
  p_org_name text default null
)
returns table (
  org_id   uuid,
  org_name text,
  org_slug text,
  plan_id  text,
  role     text
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
  v_meta_org_name     text;
  v_user_email        text;
  v_email_local       text;
  v_clean_name        text;
  v_base_slug         text;
  v_slug              text;
  v_new_org_id        uuid;
  v_attempt           int := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select o.id, o.name, o.slug, o.plan_id, m.role
    into v_existing_org_id, v_existing_org_name, v_existing_org_slug, v_existing_plan_id, v_existing_role
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
      v_existing_role;
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
      insert into public.organizations (name, slug, plan_id, status)
      values (v_clean_name, v_slug, null, 'active')
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
    jsonb_build_object('name', v_clean_name, 'slug', v_slug, 'plan_id', null)
  );

  return query select v_new_org_id, v_clean_name, v_slug, null::text, 'owner'::text;
end;
$$;

revoke execute on function public.create_organization_for_user(uuid, text) from public, anon, authenticated;
grant  execute on function public.create_organization_for_user(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 9. Transactional Event Creation Consuming 1 Purchase Slot
--    - Serializes concurrent calls per org via pg_advisory_xact_lock + FOR UPDATE
--    - Prefers the active, unexpired purchase that expires soonest
--    - Copies max_certificates = purchase.certs_per_event
--    - Sets retention_until = now() + 12 months if created released
--    - Blocks with exact error prefixes: PURCHASE_PENDING, NO_EVENT_SLOTS,
--      NO_ACTIVE_PURCHASE, ORG_SUSPENDED, SLUG_TAKEN
-- -----------------------------------------------------------------------------
create or replace function public.create_event_consuming_slot(
  p_org_id        uuid,
  p_user_id       uuid,
  p_title         text,
  p_subtitle      text default null,
  p_slug          text default null,
  p_event_date    date default null,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_released      boolean default false
)
returns table (
  event_id            uuid,
  slug                text,
  purchase_id         uuid,
  max_certificates    int,
  events_used         int,
  events_total        int,
  purchase_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_status    text;
  v_purchase      public.purchases%rowtype;
  v_has_pending   boolean;
  v_has_exhausted boolean;
  v_has_expired   boolean;
  v_event_id      uuid;
  v_retention     timestamptz;
begin
  if p_org_id is null then
    raise exception 'p_org_id is required';
  end if;

  -- Serialize concurrent event creations for the same organization
  perform pg_advisory_xact_lock(hashtextextended('create_event_slot:' || p_org_id::text, 0));

  select o.status
    into v_org_status
    from public.organizations o
   where o.id = p_org_id;

  if v_org_status is null then
    raise exception 'ORG_SUSPENDED: Organization not found.';
  end if;

  if v_org_status <> 'active' then
    raise exception 'ORG_SUSPENDED: Your organization account is suspended.';
  end if;

  if exists (select 1 from public.events e where e.slug = p_slug) then
    raise exception 'SLUG_TAKEN: The URL slug "%" is already taken.', p_slug;
  end if;

  -- Pick the active, unexpired purchase with available slots that expires SOONEST
  select p.*
    into v_purchase
    from public.purchases p
   where p.org_id = p_org_id
     and p.status = 'active'
     and (p.expires_at is null or p.expires_at > now())
     and p.events_used < p.events_total
   order by p.expires_at asc nulls last, p.created_at asc
   limit 1
   for update;

  if v_purchase.id is null then
    select exists (
      select 1
        from public.purchases p
       where p.org_id = p_org_id
         and p.status = 'pending'
    ) into v_has_pending;

    if v_has_pending then
      raise exception 'PURCHASE_PENDING: Your package purchase is waiting for approval. You will be able to create events once approved.';
    end if;

    select exists (
      select 1
        from public.purchases p
       where p.org_id = p_org_id
         and p.status = 'active'
         and (p.expires_at is null or p.expires_at > now())
         and p.events_used >= p.events_total
    ) into v_has_exhausted;

    if v_has_exhausted then
      raise exception 'NO_EVENT_SLOTS: You have no event slots left in your active package(s). Buy another package in Billing to create more events.';
    end if;

    select exists (
      select 1
        from public.purchases p
       where p.org_id = p_org_id
         and (p.status = 'expired' or (p.expires_at is not null and p.expires_at <= now()))
    ) into v_has_expired;

    if v_has_expired then
      raise exception 'PURCHASE_EXPIRED: Your package has expired — buy a package in Billing to create new events.';
    end if;

    raise exception 'NO_ACTIVE_PURCHASE: Please buy a package in Billing before creating an event.';
  end if;

  -- Consume 1 slot atomically
  update public.purchases p
     set events_used = p.events_used + 1
   where p.id     = v_purchase.id
     and p.org_id = p_org_id
     and p.events_used < p.events_total
  returning * into v_purchase;

  if v_purchase.id is null then
    raise exception 'NO_EVENT_SLOTS: No event slots left in your active package.';
  end if;

  v_retention := case when coalesce(p_released, false) then now() + interval '12 months' else null end;

  insert into public.events (
    org_id,
    purchase_id,
    max_certificates,
    retention_until,
    title,
    subtitle,
    slug,
    event_date,
    contact_email,
    contact_phone,
    released
  )
  values (
    p_org_id,
    v_purchase.id,
    v_purchase.certs_per_event,
    v_retention,
    p_title,
    p_subtitle,
    p_slug,
    p_event_date,
    p_contact_email,
    p_contact_phone,
    coalesce(p_released, false)
  )
  returning id into v_event_id;

  insert into public.certificate_types (org_id, event_id, key, label)
  values (p_org_id, v_event_id, 'participation', 'Certificate of Participation');

  insert into public.audit_log (org_id, user_id, action, details)
  values (
    p_org_id,
    p_user_id,
    'event.created',
    jsonb_build_object(
      'event_id', v_event_id,
      'title', p_title,
      'slug', p_slug,
      'purchase_id', v_purchase.id,
      'max_certificates', v_purchase.certs_per_event,
      'events_used', v_purchase.events_used,
      'events_total', v_purchase.events_total
    )
  );

  return query select
    v_event_id,
    p_slug,
    v_purchase.id,
    v_purchase.certs_per_event,
    v_purchase.events_used,
    v_purchase.events_total,
    v_purchase.expires_at;
end;
$$;

revoke execute on function public.create_event_consuming_slot(uuid, uuid, text, text, text, date, text, text, boolean) from public, anon, authenticated;
grant  execute on function public.create_event_consuming_slot(uuid, uuid, text, text, text, date, text, text, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 10. Transactional Purchase Approval / Rejection RPC
-- -----------------------------------------------------------------------------
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
  v_target_status text;
  v_pur           public.purchases%rowtype;
  v_max_exp       timestamptz;
begin
  if p_decision in ('approved', 'active') then
    v_target_status := 'active';
  elsif p_decision = 'rejected' then
    v_target_status := 'rejected';
  else
    raise exception 'Invalid decision "%" (expected approved or rejected)', p_decision;
  end if;

  select *
    into v_pur
    from public.purchases p
   where p.id = p_purchase_id
   for update;

  if v_pur.id is null then
    raise exception 'Purchase request not found.';
  end if;

  if v_pur.status <> 'pending' then
    raise exception 'Purchase % is already % and cannot be reviewed again.', v_pur.id, v_pur.status;
  end if;

  if v_target_status = 'active' then
    update public.purchases p
       set status       = 'active',
           starts_at    = now(),
           expires_at   = now() + make_interval(months => p.months),
           reviewed_by  = coalesce(nullif(btrim(p_reviewer), ''), 'super_admin'),
           reviewed_at  = now(),
           payment_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), p.payment_note)
     where p.id = p_purchase_id
    returning * into v_pur;

    select max(p2.expires_at)
      into v_max_exp
      from public.purchases p2
     where p2.org_id = v_pur.org_id
       and p2.status = 'active';

    update public.organizations o
       set plan_id            = coalesce(v_pur.plan_id, o.plan_id),
           plan_expires_at    = v_max_exp,
           plan_expiring_soon = false,
           expiry_flagged_at  = null
     where o.id = v_pur.org_id;

    insert into public.audit_log (org_id, user_id, action, details)
    values (
      v_pur.org_id,
      v_pur.requested_by,
      'billing.purchase_approved',
      jsonb_build_object(
        'purchase_id', v_pur.id,
        'kind', v_pur.kind,
        'plan_id', v_pur.plan_id,
        'events_total', v_pur.events_total,
        'certs_per_event', v_pur.certs_per_event,
        'months', v_pur.months,
        'final_price_pkr', v_pur.final_price_pkr,
        'is_pilot', v_pur.is_pilot,
        'expires_at', v_pur.expires_at,
        'reviewed_by', v_pur.reviewed_by
      )
    );
  else
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
  end if;

  return query select v_pur.id, v_pur.org_id, v_pur.status, v_pur.starts_at, v_pur.expires_at;
end;
$$;

revoke execute on function public.review_purchase_request(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.review_purchase_request(uuid, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 11. Transactional Certificate Top-Up Approval / Rejection RPC
--     Approving atomically increments events.max_certificates + writes audit_log.
-- -----------------------------------------------------------------------------
create or replace function public.review_certificate_topup(
  p_topup_id uuid,
  p_decision text, -- 'approved' | 'rejected'
  p_reviewer text default 'super_admin',
  p_note     text default null
)
returns table (
  topup_id             uuid,
  org_id               uuid,
  event_id             uuid,
  new_status           text,
  new_max_certificates int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topup    public.certificate_topups%rowtype;
  v_new_max  int;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select *
    into v_topup
    from public.certificate_topups ct
   where ct.id = p_topup_id
   for update;

  if v_topup.id is null then
    raise exception 'Top-up request not found.';
  end if;

  if v_topup.status <> 'pending' then
    raise exception 'Top-up request % is already %.', v_topup.id, v_topup.status;
  end if;

  update public.certificate_topups ct
     set status       = p_decision,
         reviewed_by  = coalesce(nullif(btrim(p_reviewer), ''), 'super_admin'),
         reviewed_at  = now(),
         payment_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), ct.payment_note)
   where ct.id = p_topup_id
  returning * into v_topup;

  if p_decision = 'approved' then
    update public.events e
       set max_certificates = e.max_certificates + v_topup.certs_added
     where e.id     = v_topup.event_id
       and e.org_id = v_topup.org_id
    returning e.max_certificates into v_new_max;

    insert into public.audit_log (org_id, user_id, action, details)
    values (
      v_topup.org_id,
      v_topup.requested_by,
      'billing.topup_approved',
      jsonb_build_object(
        'topup_id', v_topup.id,
        'event_id', v_topup.event_id,
        'certs_added', v_topup.certs_added,
        'amount_pkr', v_topup.amount_pkr,
        'new_max_certificates', v_new_max,
        'reviewed_by', v_topup.reviewed_by
      )
    );
  else
    select e.max_certificates
      into v_new_max
      from public.events e
     where e.id     = v_topup.event_id
       and e.org_id = v_topup.org_id;

    insert into public.audit_log (org_id, user_id, action, details)
    values (
      v_topup.org_id,
      v_topup.requested_by,
      'billing.topup_rejected',
      jsonb_build_object(
        'topup_id', v_topup.id,
        'event_id', v_topup.event_id,
        'certs_added', v_topup.certs_added,
        'amount_pkr', v_topup.amount_pkr,
        'payment_note', v_topup.payment_note,
        'reviewed_by', v_topup.reviewed_by
      )
    );
  end if;

  return query select v_topup.id, v_topup.org_id, v_topup.event_id, v_topup.status, v_new_max;
end;
$$;

revoke execute on function public.review_certificate_topup(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.review_certificate_topup(uuid, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 12. Update bulk_import_event_attendees to enforce events.max_certificates
--     and active purchase status (no legacy plans table quota columns)
-- -----------------------------------------------------------------------------
create or replace function public.bulk_import_event_attendees(
  p_org_id   uuid,
  p_user_id  uuid,
  p_event_id uuid,
  p_mode     text,
  p_rows     jsonb
)
returns table (
  inserted_count             int,
  updated_count              int,
  skipped_count              int,
  certificates_created_count int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_status       text;
  v_max_per_event    int;
  v_purchase_id      uuid;
  v_purchase_status  text;
  v_purchase_expires timestamptz;
  v_total_rows       int;
  v_batch_size       constant int := 500;
  v_offset           int;
  v_batch            jsonb;
  v_inserted         int := 0;
  v_updated          int := 0;
  v_skipped          int := 0;
  v_certs_created    int := 0;
  v_batch_ins        int;
  v_batch_upd        int;
  v_batch_skp        int;
  v_batch_certs      int;
  v_event_certs_now  int;
  v_event_att_now    int;
begin
  if p_mode not in ('skip', 'update') then
    raise exception 'Invalid import mode "%" (expected skip or update)', p_mode;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  v_total_rows := jsonb_array_length(p_rows);
  if v_total_rows = 0 then
    return query select 0, 0, 0, 0;
    return;
  end if;

  if v_total_rows > 5000 then
    raise exception 'Import exceeds maximum of 5,000 rows per upload (% rows supplied)', v_total_rows;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_event_id::text, 0));

  select o.status, e.max_certificates, e.purchase_id, p.status, p.expires_at
    into v_org_status, v_max_per_event, v_purchase_id, v_purchase_status, v_purchase_expires
    from public.events e
    join public.organizations o on o.id = e.org_id
    left join public.purchases p on p.id = e.purchase_id and p.org_id = e.org_id
   where e.id     = p_event_id
     and e.org_id = p_org_id;

  if v_org_status is null then
    raise exception 'Event not found for organization';
  end if;

  if v_org_status <> 'active' then
    raise exception 'Organization is suspended and cannot import attendees.';
  end if;

  if v_purchase_id is null or v_purchase_status is distinct from 'active' then
    raise exception 'This event does not have an active package. Buy or renew a package in Billing to import attendees.';
  end if;

  if v_purchase_expires is not null and v_purchase_expires <= now() then
    raise exception 'The package for this event has expired — organization keeps read and export access. Buy a package in Billing to add attendees to new events.';
  end if;

  for v_offset in 0 .. (v_total_rows - 1) by v_batch_size loop
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_batch
      from (
        select elem
          from jsonb_array_elements(p_rows) with ordinality as t(elem, ord)
         where t.ord > v_offset
           and t.ord <= v_offset + v_batch_size
      ) sub;

    if p_mode = 'skip' then
      select count(*)::int
        into v_batch_skp
        from jsonb_array_elements(v_batch) as b
       where exists (
         select 1
           from public.attendees a
          where a.org_id   = p_org_id
            and a.event_id = p_event_id
            and lower(a.identifier) = lower(b->>'identifier')
       );

      with new_rows as (
        select
          (b->>'identifier')::text as identifier,
          (b->>'full_name')::text  as full_name,
          nullif(b->>'email', '')::text as email,
          nullif(b->>'note', '')::text  as note,
          coalesce(b->'type_ids', '[]'::jsonb) as type_ids
        from jsonb_array_elements(v_batch) as b
        where not exists (
          select 1
            from public.attendees a
           where a.org_id   = p_org_id
             and a.event_id = p_event_id
             and lower(a.identifier) = lower(b->>'identifier')
        )
      ),
      ins_att as (
        insert into public.attendees (org_id, event_id, identifier, full_name, email, note, source)
        select p_org_id, p_event_id, nr.identifier, nr.full_name, nr.email, nr.note, 'csv'
          from new_rows nr
        on conflict do nothing
        returning id, identifier
      ),
      ins_certs as (
        insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id)
        select
          p_org_id,
          p_event_id,
          ia.id,
          ct.id
        from ins_att ia
        join new_rows nr on lower(nr.identifier) = lower(ia.identifier)
        cross join lateral jsonb_array_elements_text(nr.type_ids) as tid(val)
        join public.certificate_types ct
          on ct.id       = tid.val::uuid
         and ct.org_id   = p_org_id
         and ct.event_id = p_event_id
        on conflict (attendee_id, certificate_type_id) do nothing
        returning 1
      )
      select (select count(*)::int from ins_att),
             (select count(*)::int from ins_certs)
        into v_batch_ins, v_batch_certs;

      v_inserted      := v_inserted + v_batch_ins;
      v_skipped       := v_skipped + v_batch_skp;
      v_certs_created := v_certs_created + v_batch_certs;
    else
      with incoming as (
        select
          (b->>'identifier')::text as identifier,
          (b->>'full_name')::text  as full_name,
          nullif(b->>'email', '')::text as email,
          nullif(b->>'note', '')::text  as note,
          coalesce(b->'type_ids', '[]'::jsonb) as type_ids
        from jsonb_array_elements(v_batch) as b
      ),
      upd_att as (
        update public.attendees a
           set full_name = inc.full_name,
               email     = coalesce(inc.email, a.email),
               note      = coalesce(inc.note, a.note)
          from incoming inc
         where a.org_id   = p_org_id
           and a.event_id = p_event_id
           and lower(a.identifier) = lower(inc.identifier)
        returning a.id, a.identifier
      ),
      ins_att as (
        insert into public.attendees (org_id, event_id, identifier, full_name, email, note, source)
        select p_org_id, p_event_id, inc.identifier, inc.full_name, inc.email, inc.note, 'csv'
          from incoming inc
         where not exists (
           select 1
             from public.attendees a
            where a.org_id   = p_org_id
              and a.event_id = p_event_id
              and lower(a.identifier) = lower(inc.identifier)
         )
        on conflict do nothing
        returning id, identifier
      ),
      all_touched as (
        select id, identifier from upd_att
        union all
        select id, identifier from ins_att
      ),
      ins_certs as (
        insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id)
        select
          p_org_id,
          p_event_id,
          at_row.id,
          ct.id
        from all_touched at_row
        join incoming inc on lower(inc.identifier) = lower(at_row.identifier)
        cross join lateral jsonb_array_elements_text(inc.type_ids) as tid(val)
        join public.certificate_types ct
          on ct.id       = tid.val::uuid
         and ct.org_id   = p_org_id
         and ct.event_id = p_event_id
        on conflict (attendee_id, certificate_type_id) do nothing
        returning 1
      )
      select (select count(*)::int from ins_att),
             (select count(*)::int from upd_att),
             (select count(*)::int from ins_certs)
        into v_batch_ins, v_batch_upd, v_batch_certs;

      v_inserted      := v_inserted + v_batch_ins;
      v_updated       := v_updated + v_batch_upd;
      v_certs_created := v_certs_created + v_batch_certs;
    end if;
  end loop;

  select count(*)::int into v_event_certs_now
    from public.attendee_certificates
   where org_id = p_org_id and event_id = p_event_id;

  select count(*)::int into v_event_att_now
    from public.attendees
   where org_id = p_org_id and event_id = p_event_id;

  if v_max_per_event is not null and v_event_certs_now > v_max_per_event then
    raise exception 'Certificate limit reached: importing would bring this event to % / % certificates. Request a certificate top-up in Billing.',
      v_event_certs_now, v_max_per_event;
  end if;

  if v_max_per_event is not null and v_event_att_now > v_max_per_event then
    raise exception 'Certificate limit reached: importing would bring this event to % / % attendees. Request a certificate top-up in Billing.',
      v_event_att_now, v_max_per_event;
  end if;

  insert into public.audit_log (org_id, user_id, action, details)
  values (
    p_org_id,
    p_user_id,
    'attendee.csv_imported',
    jsonb_build_object(
      'event_id', p_event_id,
      'mode', p_mode,
      'inserted_count', v_inserted,
      'updated_count', v_updated,
      'skipped_count', v_skipped,
      'certificates_created_count', v_certs_created
    )
  );

  return query select v_inserted, v_updated, v_skipped, v_certs_created;
end;
$$;

revoke execute on function public.bulk_import_event_attendees(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function public.bulk_import_event_attendees(uuid, uuid, uuid, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 13. Update claim_certificate_download to enforce retention_until
--     Public downloads for released events keep working AFTER purchase.expires_at,
--     and stop ONLY when retention_until <= now() ('event_expired').
-- -----------------------------------------------------------------------------
create or replace function public.claim_certificate_download(
  p_org_id                  uuid,
  p_event_id                uuid,
  p_attendee_certificate_id uuid,
  p_ip_hash                 text default null
)
returns table (
  claimed            boolean,
  reason             text, -- 'ok' | 'limit_reached' | 'not_released' | 'event_expired' | 'org_suspended' | 'not_found'
  new_download_count int,
  download_limit     int,
  verify_code        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_status     text;
  v_released       boolean;
  v_retention      timestamptz;
  v_limit          int;
  v_claimed_id     uuid;
  v_new_count      int;
  v_verify_code    text;
  v_existing_count int;
begin
  update public.attendee_certificates ac
     set download_count      = ac.download_count + 1,
         first_downloaded_at = coalesce(ac.first_downloaded_at, now()),
         last_downloaded_at  = now()
    from public.events e
    join public.organizations o on o.id = e.org_id
   where ac.id       = p_attendee_certificate_id
     and ac.org_id   = p_org_id
     and ac.event_id = p_event_id
     and e.id        = ac.event_id
     and e.org_id    = p_org_id
     and o.status    = 'active'
     and e.released  = true
     and (e.retention_until is null or e.retention_until > now())
     and (e.download_limit is null or ac.download_count < e.download_limit)
  returning ac.id, ac.download_count, e.download_limit, ac.verify_code
    into v_claimed_id, v_new_count, v_limit, v_verify_code;

  if v_claimed_id is not null then
    insert into public.download_log (org_id, attendee_certificate_id, ip_hash)
    values (p_org_id, v_claimed_id, left(p_ip_hash, 128));

    return query select true, 'ok'::text, v_new_count, v_limit, v_verify_code;
    return;
  end if;

  select o.status, e.released, e.retention_until, e.download_limit, ac.download_count
    into v_org_status, v_released, v_retention, v_limit, v_existing_count
    from public.attendee_certificates ac
    join public.events e on e.id = ac.event_id and e.org_id = ac.org_id
    join public.organizations o on o.id = e.org_id
   where ac.id       = p_attendee_certificate_id
     and ac.org_id   = p_org_id
     and ac.event_id = p_event_id;

  if v_existing_count is null then
    return query select false, 'not_found'::text, 0, null::int, null::text;
    return;
  end if;

  if v_org_status is distinct from 'active' then
    return query select false, 'org_suspended'::text, v_existing_count, v_limit, null::text;
    return;
  end if;

  if not v_released then
    return query select false, 'not_released'::text, v_existing_count, v_limit, null::text;
    return;
  end if;

  if v_retention is not null and v_retention <= now() then
    return query select false, 'event_expired'::text, v_existing_count, v_limit, null::text;
    return;
  end if;

  return query select false, 'limit_reached'::text, v_existing_count, v_limit, null::text;
end;
$$;

revoke execute on function public.claim_certificate_download(uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.claim_certificate_download(uuid, uuid, uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 14. Daily Vercel Cron RPC: public.run_daily_purchases_cron(p_within_days default 14)
--     - Marks active purchases with expires_at <= now() as 'expired'
--     - Updates organizations.plan_expiring_soon for orgs with active purchases
--       expiring within 14 days (no emails)
-- -----------------------------------------------------------------------------
create or replace function public.run_daily_purchases_cron(
  p_within_days int default 14
)
returns table (
  newly_expired_count int,
  expiring_soon_count int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired_count  int := 0;
  v_expiring_count int := 0;
  v_days           int := greatest(coalesce(p_within_days, 14), 1);
begin
  -- 1. Mark overdue active purchases as expired and write audit_log entries
  with newly_exp as (
    update public.purchases p
       set status = 'expired'
     where p.status = 'active'
       and p.expires_at is not null
       and p.expires_at <= now()
    returning p.id, p.org_id, p.kind, p.events_used, p.events_total, p.expires_at
  ),
  logged as (
    insert into public.audit_log (org_id, user_id, action, details)
    select
      ne.org_id,
      null,
      'billing.purchase_expired',
      jsonb_build_object(
        'purchase_id', ne.id,
        'kind', ne.kind,
        'events_used', ne.events_used,
        'events_total', ne.events_total,
        'expires_at', ne.expires_at
      )
    from newly_exp ne
    returning 1
  )
  select count(*)::int into v_expired_count from newly_exp;

  -- 2. Count active purchases expiring within p_within_days (14 days)
  select count(*)::int
    into v_expiring_count
    from public.purchases p
    join public.organizations o on o.id = p.org_id
   where o.status = 'active'
     and p.status = 'active'
     and p.expires_at is not null
     and p.expires_at > now()
     and p.expires_at <= now() + make_interval(days => v_days);

  -- 3. Keep organizations.plan_expiring_soon in sync for dashboard banners
  update public.organizations o
     set plan_expiring_soon = exists (
           select 1
             from public.purchases p
            where p.org_id = o.id
              and p.status = 'active'
              and p.expires_at is not null
              and p.expires_at > now()
              and p.expires_at <= now() + make_interval(days => v_days)
         ),
         plan_expires_at = (
           select max(p2.expires_at)
             from public.purchases p2
            where p2.org_id = o.id
              and p2.status in ('active', 'expired')
         );

  return query select v_expired_count, v_expiring_count;
end;
$$;

revoke execute on function public.run_daily_purchases_cron(int) from public, anon, authenticated;
grant  execute on function public.run_daily_purchases_cron(int) to service_role;

commit;
