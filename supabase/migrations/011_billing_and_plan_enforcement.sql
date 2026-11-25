-- =============================================================================
-- 011_billing_and_plan_enforcement.sql — Manual billing model (payment_requests),
-- organization plan expiration & read-only enforcement, Pro plan tier, private
-- "payment-proofs" bucket, atomic approval trigger/RPC, and daily expiry cron RPC
--
-- Run AFTER 001..010 in Supabase SQL Editor. Safe to re-run.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Seed 'pro' plan tier alongside 'free' and 'starter' (NULL = unlimited)
-- -----------------------------------------------------------------------------
insert into public.plans (
  id,
  name,
  max_events,
  max_certificates_per_event,
  max_certificates_total,
  max_certificate_types_per_event,
  allow_custom_branding,
  price_pkr,
  active
)
values (
  'pro',
  'Pro',
  null,
  5000,
  null,
  null,
  true,
  7999,
  true
)
on conflict (id) do update
  set max_certificate_types_per_event = coalesce(public.plans.max_certificate_types_per_event, excluded.max_certificate_types_per_event);

-- -----------------------------------------------------------------------------
-- 2. organizations: add plan_expires_at + cron warning flags
--    When plan_expires_at <= now(), the organization enters read-only mode in
--    the dashboard (view & export allowed, create/edit blocked), while public
--    downloads for released events keep working because status stays 'active'.
-- -----------------------------------------------------------------------------
alter table public.organizations
  add column if not exists plan_expires_at    timestamptz,
  add column if not exists plan_expiring_soon boolean not null default false,
  add column if not exists expiry_flagged_at  timestamptz;

create index if not exists organizations_plan_expires_at_idx
  on public.organizations (plan_expires_at)
  where plan_expires_at is not null;

-- -----------------------------------------------------------------------------
-- 3. RLS helper: public.is_org_writable(p_org_id)
--    True only when the signed-in user is a member of p_org_id, status = 'active',
--    AND the organization's plan has not expired.
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
       and (o.plan_expires_at is null or o.plan_expires_at > now())
  );
$$;

revoke execute on function public.is_org_writable(uuid) from public, anon;
grant  execute on function public.is_org_writable(uuid) to authenticated, service_role;

-- Tighten RLS write policies on events, certificate_types, attendees, and
-- attendee_certificates so expired organizations are read-only at the DB layer
-- too (SELECT remains open via is_org_member for viewing and exports).
drop policy if exists rls_events_insert on public.events;
drop policy if exists rls_events_update on public.events;
drop policy if exists rls_events_delete on public.events;

create policy rls_events_insert on public.events
  for insert to authenticated with check (public.is_org_writable(org_id));
create policy rls_events_update on public.events
  for update to authenticated
  using (public.is_org_writable(org_id)) with check (public.is_org_writable(org_id));
create policy rls_events_delete on public.events
  for delete to authenticated using (public.is_org_writable(org_id));

do $$
declare t text;
begin
  foreach t in array array['certificate_types', 'attendees', 'attendee_certificates'] loop
    execute format('drop policy if exists rls_%1$s_insert on public.%1$I', t);
    execute format('drop policy if exists rls_%1$s_update on public.%1$I', t);
    execute format('drop policy if exists rls_%1$s_delete on public.%1$I', t);

    execute format(
      'create policy rls_%1$s_insert on public.%1$I for insert to authenticated
         with check (public.is_org_writable(org_id) and public.event_org_id(event_id) = org_id)', t);
    execute format(
      'create policy rls_%1$s_update on public.%1$I for update to authenticated
         using (public.is_org_writable(org_id))
         with check (public.is_org_writable(org_id) and public.event_org_id(event_id) = org_id)', t);
    execute format(
      'create policy rls_%1$s_delete on public.%1$I for delete to authenticated
         using (public.is_org_writable(org_id))', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 4. payment_requests table (manual bank / JazzCash / Easypaisa upgrade flow)
-- -----------------------------------------------------------------------------
create table if not exists public.payment_requests (
  id                     uuid        primary key default gen_random_uuid(),
  org_id                 uuid        not null references public.organizations (id) on delete cascade,
  requested_by           uuid        references auth.users (id) on delete set null,
  plan_id                text        not null references public.plans (id) on delete restrict,
  amount_pkr             int         not null check (amount_pkr > 0),
  payment_method         text        not null check (payment_method in ('bank', 'jazzcash', 'easypaisa')),
  transaction_reference  text        not null check (length(btrim(transaction_reference)) between 2 and 120),
  screenshot_path        text        check (screenshot_path is null or screenshot_path like (org_id::text || '/%')),
  status                 text        not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  billing_days           int         not null default 30 check (billing_days between 1 and 3660),
  reviewer_note          text        check (reviewer_note is null or length(reviewer_note) <= 500),
  reviewed_by            text        check (reviewed_by is null or length(reviewed_by) <= 200),
  reviewed_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists payment_requests_org_id_created_at_idx
  on public.payment_requests (org_id, created_at desc);

create index if not exists payment_requests_status_created_at_idx
  on public.payment_requests (status, created_at desc);

drop trigger if exists set_updated_at on public.payment_requests;
create trigger set_updated_at before update on public.payment_requests
  for each row execute function public.set_updated_at();

alter table public.payment_requests enable row level security;

revoke all on public.payment_requests from anon, authenticated;
grant select on public.payment_requests to authenticated;
grant all    on public.payment_requests to service_role;

drop policy if exists rls_payment_requests_select on public.payment_requests;
create policy rls_payment_requests_select on public.payment_requests
  for select to authenticated
  using (public.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- 5. Triggers + RPC for atomic plan upgrade on payment_requests approval
--    Approving a pending payment_requests row (via review_payment_request RPC,
--    admin UI, or Supabase Table Editor) atomically upgrades organizations.plan_id,
--    extends plan_expires_at by billing_days, clears expiry warnings, and writes
--    to audit_log. Once approved/rejected, status is immutable.
-- -----------------------------------------------------------------------------
create or replace function public.payment_requests_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status in ('approved', 'rejected') and new.status is distinct from old.status then
      raise exception 'Payment request % is already % and cannot change status.', old.id, old.status;
    end if;

    if old.status = 'pending' and new.status in ('approved', 'rejected') then
      new.reviewed_at := coalesce(new.reviewed_at, now());
    end if;
  elsif tg_op = 'INSERT' then
    if new.status in ('approved', 'rejected') then
      new.reviewed_at := coalesce(new.reviewed_at, now());
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.payment_requests_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_expires_at timestamptz;
begin
  if (tg_op = 'INSERT' and new.status = 'approved')
     or (tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'approved')
  then
    update public.organizations o
       set plan_id            = new.plan_id,
           status             = 'active',
           plan_expires_at    = case
                                  when new.plan_id = 'free' then null
                                  else greatest(coalesce(o.plan_expires_at, now()), now())
                                       + make_interval(days => coalesce(new.billing_days, 30))
                                end,
           plan_expiring_soon = false,
           expiry_flagged_at  = null
     where o.id = new.org_id
    returning o.plan_expires_at into v_new_expires_at;

    insert into public.audit_log (org_id, user_id, action, details)
    values (
      new.org_id,
      new.requested_by,
      'billing.plan_upgraded',
      jsonb_build_object(
        'payment_request_id', new.id,
        'plan_id', new.plan_id,
        'amount_pkr', new.amount_pkr,
        'payment_method', new.payment_method,
        'transaction_reference', new.transaction_reference,
        'billing_days', new.billing_days,
        'plan_expires_at', v_new_expires_at,
        'reviewed_by', new.reviewed_by
      )
    );
  elsif (tg_op = 'INSERT' and new.status = 'rejected')
     or (tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'rejected')
  then
    insert into public.audit_log (org_id, user_id, action, details)
    values (
      new.org_id,
      new.requested_by,
      'billing.payment_rejected',
      jsonb_build_object(
        'payment_request_id', new.id,
        'plan_id', new.plan_id,
        'amount_pkr', new.amount_pkr,
        'reviewer_note', new.reviewer_note,
        'reviewed_by', new.reviewed_by
      )
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.payment_requests_before_write() from public, anon, authenticated;
revoke execute on function public.payment_requests_after_write()  from public, anon, authenticated;

drop trigger if exists trg_payment_requests_before_write on public.payment_requests;
create trigger trg_payment_requests_before_write
  before insert or update on public.payment_requests
  for each row execute function public.payment_requests_before_write();

drop trigger if exists trg_payment_requests_after_write on public.payment_requests;
create trigger trg_payment_requests_after_write
  after insert or update on public.payment_requests
  for each row execute function public.payment_requests_after_write();

create or replace function public.review_payment_request(
  p_request_id   uuid,
  p_decision     text,
  p_reviewer     text default 'super_admin',
  p_note         text default null,
  p_billing_days int  default 30
)
returns table (
  request_id      uuid,
  org_id          uuid,
  new_status      text,
  plan_id         text,
  plan_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.payment_requests%rowtype;
  v_exp timestamptz;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  update public.payment_requests pr
     set status        = p_decision,
         reviewed_by   = coalesce(nullif(btrim(p_reviewer), ''), 'super_admin'),
         reviewer_note = nullif(btrim(coalesce(p_note, '')), ''),
         billing_days  = coalesce(p_billing_days, pr.billing_days, 30),
         reviewed_at   = now()
   where pr.id = p_request_id
     and pr.status = 'pending'
  returning * into v_req;

  if v_req.id is null then
    raise exception 'Pending payment request not found (may already be reviewed).';
  end if;

  select o.plan_expires_at into v_exp
    from public.organizations o
   where o.id = v_req.org_id;

  return query select v_req.id, v_req.org_id, v_req.status, v_req.plan_id, v_exp;
end;
$$;

revoke execute on function public.review_payment_request(uuid, text, text, text, int) from public, anon, authenticated;
grant  execute on function public.review_payment_request(uuid, text, text, text, int) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Daily Cron RPC: public.flag_expiring_organizations(p_within_days default 7)
--    Flags active organizations expiring within p_within_days, clears stale
--    warnings for renewed accounts, and writes audit_log entries for newly
--    expiring or newly expired (read-only) organizations.
-- -----------------------------------------------------------------------------
create or replace function public.flag_expiring_organizations(
  p_within_days int default 7
)
returns table (
  flagged_expiring_soon_count int,
  newly_expired_count         int,
  cleared_count               int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flagged int := 0;
  v_expired int := 0;
  v_cleared int := 0;
begin
  -- 1. Clear warning flag on organizations that renewed past the warning window or moved to non-expiring
  with cleared as (
    update public.organizations o
       set plan_expiring_soon = false,
           expiry_flagged_at  = null
     where o.plan_expiring_soon = true
       and (
         o.plan_expires_at is null
         or o.plan_expires_at > now() + make_interval(days => greatest(p_within_days, 1))
       )
    returning o.id
  )
  select count(*)::int into v_cleared from cleared;

  -- 2. Flag organizations expiring within p_within_days (still in the future)
  with expiring as (
    update public.organizations o
       set plan_expiring_soon = true,
           expiry_flagged_at  = now()
     where o.status = 'active'
       and o.plan_expires_at is not null
       and o.plan_expires_at > now()
       and o.plan_expires_at <= now() + make_interval(days => greatest(p_within_days, 1))
       and o.plan_expiring_soon = false
    returning o.id, o.plan_id, o.plan_expires_at
  ),
  logged_expiring as (
    insert into public.audit_log (org_id, user_id, action, details)
    select
      e.id,
      null,
      'billing.plan_expiring_soon',
      jsonb_build_object(
        'plan_id', e.plan_id,
        'plan_expires_at', e.plan_expires_at,
        'within_days', p_within_days
      )
    from expiring e
    returning 1
  )
  select count(*)::int into v_flagged from expiring;

  -- 3. Record newly expired accounts (now in read-only mode) once per expiration cycle
  with newly_exp as (
    update public.organizations o
       set plan_expiring_soon = false,
           expiry_flagged_at  = now()
     where o.status = 'active'
       and o.plan_expires_at is not null
       and o.plan_expires_at <= now()
       and not exists (
         select 1
           from public.audit_log al
          where al.org_id = o.id
            and al.action = 'billing.plan_expired_readonly'
            and al.created_at >= o.plan_expires_at
       )
    returning o.id, o.plan_id, o.plan_expires_at
  ),
  logged_expired as (
    insert into public.audit_log (org_id, user_id, action, details)
    select
      ne.id,
      null,
      'billing.plan_expired_readonly',
      jsonb_build_object(
        'plan_id', ne.plan_id,
        'plan_expires_at', ne.plan_expires_at
      )
    from newly_exp ne
    returning 1
  )
  select count(*)::int into v_expired from newly_exp;

  return query select v_flagged, v_expired, v_cleared;
end;
$$;

revoke execute on function public.flag_expiring_organizations(int) from public, anon, authenticated;
grant  execute on function public.flag_expiring_organizations(int) to service_role;

-- -----------------------------------------------------------------------------
-- 7. Update bulk_import_event_attendees RPC to also block expired / suspended orgs
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
  v_plan_id         text;
  v_plan_name       text;
  v_org_status      text;
  v_plan_expires_at timestamptz;
  v_max_per_event   int;
  v_max_total       int;
  v_total_rows      int;
  v_batch_size      constant int := 500;
  v_offset          int;
  v_batch           jsonb;
  v_inserted        int := 0;
  v_updated         int := 0;
  v_skipped         int := 0;
  v_certs_created   int := 0;
  v_batch_ins       int;
  v_batch_upd       int;
  v_batch_skp       int;
  v_batch_certs     int;
  v_event_certs_now int;
  v_org_certs_now   int;
  v_event_att_now   int;
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

  select o.plan_id, o.status, o.plan_expires_at, p.name, p.max_certificates_per_event, p.max_certificates_total
    into v_plan_id, v_org_status, v_plan_expires_at, v_plan_name, v_max_per_event, v_max_total
    from public.events e
    join public.organizations o on o.id = e.org_id
    left join public.plans p on p.id = o.plan_id
   where e.id = p_event_id
     and e.org_id = p_org_id;

  if v_plan_id is null then
    raise exception 'Event not found for organization';
  end if;

  if v_org_status <> 'active' then
    raise exception 'Organization is suspended and cannot import attendees.';
  end if;

  if v_plan_expires_at is not null and v_plan_expires_at <= now() then
    raise exception 'Your % plan has expired — organization is in read-only mode. Renew or upgrade in Billing to import attendees.',
      coalesce(v_plan_name, v_plan_id);
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
          where a.org_id = p_org_id
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
           where a.org_id = p_org_id
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
          on ct.id = tid.val::uuid
         and ct.org_id = p_org_id
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
         where a.org_id = p_org_id
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
            where a.org_id = p_org_id
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
          on ct.id = tid.val::uuid
         and ct.org_id = p_org_id
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

  select count(*)::int into v_org_certs_now
    from public.attendee_certificates
   where org_id = p_org_id;

  select count(*)::int into v_event_att_now
    from public.attendees
   where org_id = p_org_id and event_id = p_event_id;

  if v_max_per_event is not null and v_event_certs_now > v_max_per_event then
    raise exception 'Plan limit exceeded: importing would bring this event to % certificates (limit is % on % plan).',
      v_event_certs_now, v_max_per_event, coalesce(v_plan_name, v_plan_id);
  end if;

  if v_max_per_event is not null and v_event_att_now > v_max_per_event then
    raise exception 'Plan limit exceeded: importing would bring this event to % attendees (limit is % on % plan).',
      v_event_att_now, v_max_per_event, coalesce(v_plan_name, v_plan_id);
  end if;

  if v_max_total is not null and v_org_certs_now > v_max_total then
    raise exception 'Plan limit exceeded: importing would bring your organization to % total certificates (limit is % on % plan).',
      v_org_certs_now, v_max_total, coalesce(v_plan_name, v_plan_id);
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
-- 8. Private Supabase Storage bucket "payment-proofs" & storage RLS policies
--    (Guarded so local Postgres / PGlite tests without storage schema succeed)
-- -----------------------------------------------------------------------------
create or replace function public.can_access_payment_proof_object(
  p_bucket_id text,
  p_name      text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts  text[];
  v_org_id uuid;
begin
  if p_bucket_id is distinct from 'payment-proofs' or p_name is null then
    return false;
  end if;

  if position('..' in p_name) > 0 or left(p_name, 1) = '/' then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) < 2 or length(btrim(v_parts[2])) = 0 then
    return false;
  end if;

  begin
    v_org_id := v_parts[1]::uuid;
  exception when others then
    return false;
  end;

  return public.is_org_member(v_org_id);
end;
$$;

revoke execute on function public.can_access_payment_proof_object(text, text) from public, anon;
grant  execute on function public.can_access_payment_proof_object(text, text) to authenticated, service_role;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'storage'
       and table_name   = 'buckets'
  ) then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'payment-proofs',
      'payment-proofs',
      false,
      5242880, -- 5 MB
      array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
    )
    on conflict (id) do update
      set public             = false,
          file_size_limit    = 5242880,
          allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
  end if;

  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'storage'
       and table_name   = 'objects'
  ) then
    drop policy if exists payment_proofs_org_member_select on storage.objects;
    drop policy if exists payment_proofs_org_member_insert on storage.objects;

    execute $p$
      create policy payment_proofs_org_member_select on storage.objects
        for select to authenticated
        using (public.can_access_payment_proof_object(bucket_id, name))
    $p$;

    execute $p$
      create policy payment_proofs_org_member_insert on storage.objects
        for insert to authenticated
        with check (public.can_access_payment_proof_object(bucket_id, name))
    $p$;
  end if;
end $$;

commit;
