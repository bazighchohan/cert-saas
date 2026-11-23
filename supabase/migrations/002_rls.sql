-- =============================================================================
-- 002_rls.sql — Row Level Security for every table
--
-- Run AFTER 001_core.sql (SQL Editor → paste → Run). Safe to re-run.
--
-- Access model
--   service_role  : server code only. Bypasses RLS. Public pages (event page,
--                   certificate download, verification) go through server routes.
--   authenticated : a logged-in user may SELECT / INSERT / UPDATE / DELETE only
--                   rows whose org_id is an organization they are a member of.
--                   Exceptions (stricter on purpose):
--                     * organizations: cannot be created directly (sign-up flow on
--                       the server creates org + owner membership atomically);
--                       only `name` is editable (plan_id/status are billing);
--                       only owners may delete.
--                     * organization_members: only owners add/remove/re-role members;
--                       only `role` is editable.
--                     * download_log / audit_log: read-only (written by the server),
--                       so admins cannot erase or forge history.
--   anon          : no table access at all, except reading plans (pricing).
--   plans         : readable by everyone, writable by nobody (only via SQL
--                   editor / service role).
--
-- Why policies check org_id directly on child tables:
--   Every tenant table stores org_id, and 001's composite foreign keys force it
--   to equal the org of its event (and attendee / certificate type). So
--   "row.org_id is mine" is exactly "row's event is mine". As defence in depth,
--   writes to child tables ALSO re-derive the org from event_id via
--   event_org_id() and require it to match.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Helper functions
-- SECURITY DEFINER: they read organization_members/events without being
-- filtered by the RLS policies that call them (avoids infinite recursion).
-- STABLE: result is constant within a statement, so Postgres can cache it.
-- search_path = '' + schema-qualified names: cannot be hijacked by a user
-- creating look-alike objects.
-- They only ever answer about the CURRENT user (auth.uid()), so calling them
-- directly via the API reveals nothing about other organizations.
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
     where m.org_id = p_org_id
       and m.user_id = (select auth.uid())
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
     where m.org_id = p_org_id
       and m.user_id = (select auth.uid())
       and m.role = 'owner'
  );
$$;

-- Org that owns an event — but ONLY if the current user is a member of it.
-- Returns NULL otherwise, so it cannot be used to discover other orgs' ids.
create or replace function public.event_org_id(p_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.org_id
    from public.events e
   where e.id = p_event_id
     and public.is_org_member(e.org_id);
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.is_org_owner(uuid)  from public, anon;
revoke execute on function public.event_org_id(uuid)  from public, anon;
grant  execute on function public.is_org_member(uuid) to authenticated, service_role;
grant  execute on function public.is_org_owner(uuid)  to authenticated, service_role;
grant  execute on function public.event_org_id(uuid)  to authenticated, service_role;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- RLS on every table (idempotent; 001 already enabled it)
-- -----------------------------------------------------------------------------
alter table public.plans                  enable row level security;
alter table public.organizations          enable row level security;
alter table public.organization_members   enable row level security;
alter table public.events                 enable row level security;
alter table public.certificate_types      enable row level security;
alter table public.attendees              enable row level security;
alter table public.attendee_certificates  enable row level security;
alter table public.download_log           enable row level security;
alter table public.audit_log              enable row level security;

-- -----------------------------------------------------------------------------
-- Table privileges (first gate — RLS is the second)
-- Start from zero, then grant only what each role needs. Column-level UPDATE
-- grants stop users from changing billing fields or re-pointing foreign keys.
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- New tables created later get NO access for anon/authenticated by default;
-- each migration must grant explicitly.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant select on public.plans to anon, authenticated;

grant select, delete         on public.organizations to authenticated;
grant update (name)          on public.organizations to authenticated;

grant select, insert, delete on public.organization_members to authenticated;
grant update (role)          on public.organization_members to authenticated;

grant select, insert, update, delete on
  public.events, public.certificate_types, public.attendees, public.attendee_certificates
to authenticated;

grant select on public.download_log, public.audit_log to authenticated;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- -----------------------------------------------------------------------------
-- Policies — drop 001's read-only policies and any previous run of this file
-- -----------------------------------------------------------------------------
drop policy if exists plans_read_active                 on public.plans;
drop policy if exists organizations_member_read         on public.organizations;
drop policy if exists organization_members_member_read  on public.organization_members;
drop policy if exists events_member_read                on public.events;
drop policy if exists certificate_types_member_read     on public.certificate_types;
drop policy if exists attendees_member_read             on public.attendees;
drop policy if exists attendee_certificates_member_read on public.attendee_certificates;
drop policy if exists download_log_member_read          on public.download_log;
drop policy if exists audit_log_member_read             on public.audit_log;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
     where schemaname = 'public' and policyname like 'rls\_%'
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- plans: everyone reads, nobody writes (no write policies, no write grants).
create policy rls_plans_select on public.plans
  for select to anon, authenticated using (true);

-- organizations
create policy rls_organizations_select on public.organizations
  for select to authenticated using (public.is_org_member(id));
create policy rls_organizations_update on public.organizations
  for update to authenticated
  using (public.is_org_member(id)) with check (public.is_org_member(id));
create policy rls_organizations_delete on public.organizations
  for delete to authenticated using (public.is_org_owner(id));
-- (no INSERT policy: orgs are created by the server during sign-up)

-- organization_members
create policy rls_members_select on public.organization_members
  for select to authenticated using (public.is_org_member(org_id));
create policy rls_members_insert on public.organization_members
  for insert to authenticated with check (public.is_org_owner(org_id));
create policy rls_members_update on public.organization_members
  for update to authenticated
  using (public.is_org_owner(org_id)) with check (public.is_org_owner(org_id));
create policy rls_members_delete on public.organization_members
  for delete to authenticated using (public.is_org_owner(org_id));

-- events
create policy rls_events_select on public.events
  for select to authenticated using (public.is_org_member(org_id));
create policy rls_events_insert on public.events
  for insert to authenticated with check (public.is_org_member(org_id));
create policy rls_events_update on public.events
  for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy rls_events_delete on public.events
  for delete to authenticated using (public.is_org_member(org_id));

-- Child tables reached via event_id (certificate_types, attendees) and via
-- attendee_id / certificate_type_id (attendee_certificates).
do $$
declare t text;
begin
  foreach t in array array['certificate_types', 'attendees', 'attendee_certificates'] loop
    execute format(
      'create policy rls_%1$s_select on public.%1$I for select to authenticated
         using (public.is_org_member(org_id))', t);
    execute format(
      'create policy rls_%1$s_insert on public.%1$I for insert to authenticated
         with check (public.is_org_member(org_id) and public.event_org_id(event_id) = org_id)', t);
    execute format(
      'create policy rls_%1$s_update on public.%1$I for update to authenticated
         using (public.is_org_member(org_id))
         with check (public.is_org_member(org_id) and public.event_org_id(event_id) = org_id)', t);
    execute format(
      'create policy rls_%1$s_delete on public.%1$I for delete to authenticated
         using (public.is_org_member(org_id))', t);
  end loop;
end $$;

-- Logs: members read their org's history; only the server writes.
create policy rls_download_log_select on public.download_log
  for select to authenticated using (public.is_org_member(org_id));
create policy rls_audit_log_select on public.audit_log
  for select to authenticated using (public.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- Safety net: fail the migration if any table in public lacks RLS.
-- -----------------------------------------------------------------------------
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p')
     and not c.relrowsecurity;
  if missing is not null then
    raise exception 'RLS is not enabled on: %', missing;
  end if;
end $$;

commit;
