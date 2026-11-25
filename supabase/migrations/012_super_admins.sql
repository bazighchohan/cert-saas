-- =============================================================================
-- 012_super_admins.sql — Platform super_admins table, strict RLS suspension
-- enforcement, atomic download suspension guard, and superadmin SQL helpers
--
-- Run AFTER 001..011 in Supabase SQL Editor. Safe to re-run.
--
-- Security guarantees:
--   1. Platform super-admin access is controlled EXCLUSIVELY by membership in
--      public.super_admins (never via an environment password or client flag).
--   2. Nobody can insert/update/delete super_admins via PostgREST/browser roles;
--      rows are managed only in the Supabase SQL Editor (postgres / service_role).
--   3. Suspending an organization (status = 'suspended') takes effect AT ONCE:
--      - public.is_org_member() & public.is_org_owner() return FALSE for
--        suspended orgs, immediately blocking all authenticated RLS reads/writes
--        and Storage access.
--      - public.claim_certificate_download() requires organizations.status = 'active',
--        immediately blocking public certificate downloads as well.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. public.super_admins (GLOBAL platform operators — never tenant-writable)
--    To grant yourself access in Supabase SQL Editor:
--      insert into public.super_admins (user_id, note)
--      select id, 'Founder' from auth.users where email = 'you@yourdomain.com';
-- -----------------------------------------------------------------------------
create table if not exists public.super_admins (
  user_id     uuid        primary key references auth.users (id) on delete cascade,
  note        text        check (note is null or length(note) <= 200),
  created_at  timestamptz not null default now()
);

alter table public.super_admins enable row level security;

revoke all on public.super_admins from public, anon, authenticated;
grant select on public.super_admins to authenticated;
grant all    on public.super_admins to service_role;

drop policy if exists rls_super_admins_select_self on public.super_admins;
create policy rls_super_admins_select_self on public.super_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.super_admins sa
     where sa.user_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_super_admin() from public, anon;
grant  execute on function public.is_super_admin() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Harden public.is_org_member & public.is_org_owner so suspending an org
--    blocks authenticated RLS SELECT / INSERT / UPDATE / DELETE and Storage
--    policies AT ONCE, even for existing JWTs before token expiry.
-- -----------------------------------------------------------------------------
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_members m
      join public.organizations o on o.id = m.org_id
     where m.org_id = p_org_id
       and m.user_id = (select auth.uid())
       and o.status = 'active'
  );
$$;

create or replace function public.is_org_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_members m
      join public.organizations o on o.id = m.org_id
     where m.org_id = p_org_id
       and m.user_id = (select auth.uid())
       and m.role = 'owner'
       and o.status = 'active'
  );
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.is_org_owner(uuid)  from public, anon;
grant  execute on function public.is_org_member(uuid) to authenticated, service_role;
grant  execute on function public.is_org_owner(uuid)  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Harden public.claim_certificate_download so public PDF downloads are
--    also blocked at the SQL layer the instant an organization is suspended.
-- -----------------------------------------------------------------------------
create or replace function public.claim_certificate_download(
  p_org_id                  uuid,
  p_event_id                uuid,
  p_attendee_certificate_id uuid,
  p_ip_hash                 text default null
)
returns table (
  claimed            boolean,
  reason             text, -- 'ok' | 'limit_reached' | 'not_released' | 'org_suspended' | 'not_found'
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
     and (e.download_limit is null or ac.download_count < e.download_limit)
  returning ac.id, ac.download_count, e.download_limit, ac.verify_code
    into v_claimed_id, v_new_count, v_limit, v_verify_code;

  if v_claimed_id is not null then
    insert into public.download_log (org_id, attendee_certificate_id, ip_hash)
    values (p_org_id, v_claimed_id, left(p_ip_hash, 128));

    return query select true, 'ok'::text, v_new_count, v_limit, v_verify_code;
    return;
  end if;

  select o.status, e.released, e.download_limit, ac.download_count
    into v_org_status, v_released, v_limit, v_existing_count
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

  return query select false, 'limit_reached'::text, v_existing_count, v_limit, null::text;
end;
$$;

revoke execute on function public.claim_certificate_download(uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.claim_certificate_download(uuid, uuid, uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 4. Server-only helper to inspect organization members' emails & last_sign_in_at
--    from auth.users (gracefully handles minimal test auth.users stubs).
-- -----------------------------------------------------------------------------
create or replace function public.superadmin_get_org_members_auth(
  p_org_id uuid default null
)
returns table (
  org_id          uuid,
  user_id         uuid,
  role            text,
  joined_at       timestamptz,
  email           text,
  last_sign_in_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    return query execute
      'select m.org_id,
              m.user_id,
              m.role,
              m.created_at as joined_at,
              u.email::text,
              u.last_sign_in_at
         from public.organization_members m
         left join auth.users u on u.id = m.user_id
        where ($1::uuid is null or m.org_id = $1)
        order by m.created_at asc'
      using p_org_id;
  exception when undefined_column then
    return query
      select m.org_id,
             m.user_id,
             m.role,
             m.created_at as joined_at,
             null::text as email,
             null::timestamptz as last_sign_in_at
        from public.organization_members m
       where (p_org_id is null or m.org_id = p_org_id)
       order by m.created_at asc;
  end;
end;
$$;

revoke execute on function public.superadmin_get_org_members_auth(uuid) from public, anon, authenticated;
grant  execute on function public.superadmin_get_org_members_auth(uuid) to service_role;

commit;
