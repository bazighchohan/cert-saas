-- =============================================================================
-- supabase/tests/isolation.sql — proves tenant isolation (run after 001 + 002)
--
-- How to run: Supabase SQL Editor → paste → Run (as the default `postgres` role).
-- Output: one row per test (n, test, expected, actual, result). Row 0 is the
-- summary and must read "ALL n TESTS PASSED".
--
-- It creates two orgs (A, B) and three users with fixed, obviously-fake ids,
-- impersonates them via `set role authenticated` + JWT claims (the same
-- mechanism PostgREST uses), and deletes all test data at the end.
--
-- Every "attack" from user A on org B must be either rejected with an error
-- (permission denied / RLS violation / FK violation) or affect 0 rows.
-- Positive controls prove the policies are not simply denying everything.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------
reset role;

-- Clean leftovers from an interrupted previous run.
delete from public.organizations where id in ('a1111111-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000');
delete from auth.users where id in (
  'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001');

drop table if exists pg_temp.results;
create temp table results (n int, test text, expected text, actual text, pass boolean);
grant all on pg_temp.results to public;

-- users: A = owner of org A, A2 = plain admin of org A, A3 = not a member (used
-- for "owner adds member" control), B = owner of org B.
insert into auth.users (id) values
  ('a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000003'),
  ('b0000000-0000-4000-8000-000000000001');

insert into public.organizations (id, name, slug, plan_id) values
  ('a1111111-0000-4000-8000-000000000000', 'Test Org A', 'zz-test-org-a', 'free'),
  ('b1111111-0000-4000-8000-000000000000', 'Test Org B', 'zz-test-org-b', 'free');

insert into public.organization_members (org_id, user_id, role) values
  ('a1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'owner'),
  ('a1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000002', 'admin'),
  ('b1111111-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000001', 'owner');

insert into public.events (id, org_id, title, slug) values
  ('a2222222-0000-4000-8000-000000000000', 'a1111111-0000-4000-8000-000000000000', 'A Event', 'zz-test-a-event'),
  ('b2222222-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000', 'B Event', 'zz-test-b-event');

insert into public.certificate_types (id, org_id, event_id, key, label) values
  ('a3333333-0000-4000-8000-000000000000', 'a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000000', 'participation', 'Participation'),
  ('b3333333-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'participation', 'Participation'),
  ('b3333333-0000-4000-8000-000000000002', 'b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'appreciation', 'Appreciation');

insert into public.attendees (id, org_id, event_id, identifier, full_name) values
  ('a4444444-0000-4000-8000-000000000000', 'a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000000', 'A-001', 'Alice'),
  ('b4444444-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'B-001', 'Bob');

insert into public.attendee_certificates (id, org_id, event_id, attendee_id, certificate_type_id) values
  ('a5555555-0000-4000-8000-000000000000', 'a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000000',
   'a4444444-0000-4000-8000-000000000000', 'a3333333-0000-4000-8000-000000000000'),
  ('b5555555-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000',
   'b4444444-0000-4000-8000-000000000000', 'b3333333-0000-4000-8000-000000000000');

insert into public.download_log (org_id, attendee_certificate_id, ip_hash) values
  ('a1111111-0000-4000-8000-000000000000', 'a5555555-0000-4000-8000-000000000000', 'hash-a'),
  ('b1111111-0000-4000-8000-000000000000', 'b5555555-0000-4000-8000-000000000000', 'hash-b');

insert into public.audit_log (org_id, user_id, action) values
  ('a1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'test.seed'),
  ('b1111111-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000001', 'test.seed');

-- Fingerprint of all org B data, to prove nothing changed at the end.
drop table if exists pg_temp.b_before;
create temp table b_before as
select md5(string_agg(x, '|' order by x)) as fp from (
  select 'org:'  || row(o.*)::text as x from public.organizations o where o.id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'mem:' || row(m.*)::text from public.organization_members m where m.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'evt:' || row(e.*)::text from public.events e where e.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'ct:'  || row(c.*)::text from public.certificate_types c where c.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'att:' || row(a.*)::text from public.attendees a where a.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'ac:'  || row(ac.*)::text from public.attendee_certificates ac where ac.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'dl:'  || row(d.*)::text from public.download_log d where d.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'au:'  || row(l.*)::text from public.audit_log l where l.org_id = 'b1111111-0000-4000-8000-000000000000'
) s;

-- -----------------------------------------------------------------------------
-- Test helpers
-- -----------------------------------------------------------------------------
create or replace function pg_temp.rec(p_test text, p_expected text, p_actual text, p_pass boolean)
returns void language sql as $$
  insert into pg_temp.results
  values ((select coalesce(max(n), 0) + 1 from pg_temp.results), p_test, p_expected, p_actual, p_pass);
$$;

-- Become a user (or anon when p_user is null), like PostgREST does.
create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  perform set_config('request.jwt.claims',
    case when p_user is null then '{"role":"anon"}'
         else json_build_object('sub', p_user, 'role', 'authenticated')::text end, false);
end $$;

-- Attack must be REJECTED (permission/RLS/FK/check error) or affect 0 rows.
-- Any other error (e.g. a typo -> undefined_column) counts as a FAILURE, so a
-- broken test can never pass by accident.
create or replace function pg_temp.deny(p_test text, p_sql text) returns void language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform pg_temp.rec(p_test, 'rejected or 0 rows', n || ' rows affected', n = 0);
exception
  when insufficient_privilege or foreign_key_violation or check_violation then
    perform pg_temp.rec(p_test, 'rejected or 0 rows', 'rejected: ' || sqlerrm, true);
  when others then
    perform pg_temp.rec(p_test, 'rejected or 0 rows', 'UNEXPECTED ' || sqlstate || ': ' || sqlerrm, false);
end $$;

-- Statement must succeed and affect exactly p_rows rows.
create or replace function pg_temp.allow(p_test text, p_sql text, p_rows int) returns void language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform pg_temp.rec(p_test, p_rows || ' rows affected', n || ' rows affected', n = p_rows);
exception when others then
  perform pg_temp.rec(p_test, p_rows || ' rows affected', 'ERROR ' || sqlstate || ': ' || sqlerrm, false);
end $$;

-- Scalar query must return p_expected (compared as text).
create or replace function pg_temp.eq(p_test text, p_sql text, p_expected text) returns void language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  perform pg_temp.rec(p_test, coalesce(p_expected, 'NULL'), coalesce(v, 'NULL'), v is not distinct from p_expected);
exception when others then
  perform pg_temp.rec(p_test, coalesce(p_expected, 'NULL'), 'ERROR ' || sqlstate || ': ' || sqlerrm, false);
end $$;

grant all on all tables in schema pg_temp to public;

-- =============================================================================
-- 1. User A (owner of org A) — positive controls on OWN org
-- =============================================================================
set role authenticated;
select pg_temp.login('a0000000-0000-4000-8000-000000000001');

select pg_temp.eq('A sees own org',                  $$select count(*) from public.organizations$$, '1');
select pg_temp.eq('A sees own members',              $$select count(*) from public.organization_members$$, '2');
select pg_temp.eq('A sees own events',               $$select count(*) from public.events$$, '1');
select pg_temp.eq('A sees own certificate types',    $$select count(*) from public.certificate_types$$, '1');
select pg_temp.eq('A sees own attendees',            $$select count(*) from public.attendees$$, '1');
select pg_temp.eq('A sees own attendee certificates',$$select count(*) from public.attendee_certificates$$, '1');
select pg_temp.eq('A sees own download log',         $$select count(*) from public.download_log$$, '1');
select pg_temp.eq('A sees own audit log',            $$select count(*) from public.audit_log$$, '1');
select pg_temp.eq('A sees all plans',                $$select count(*) from public.plans$$, '2');

select pg_temp.allow('A inserts event in own org',
  $$insert into public.events (id, org_id, title, slug) values
    ('a2222222-0000-4000-8000-000000000009', 'a1111111-0000-4000-8000-000000000000', 'A Event 2', 'zz-test-a-event-2')$$, 1);
select pg_temp.allow('A inserts certificate type in own event',
  $$insert into public.certificate_types (id, org_id, event_id, key, label) values
    ('a3333333-0000-4000-8000-000000000009', 'a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000009', 'p', 'P')$$, 1);
select pg_temp.allow('A inserts attendee in own event',
  $$insert into public.attendees (id, org_id, event_id, identifier, full_name) values
    ('a4444444-0000-4000-8000-000000000009', 'a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000009', 'A-009', 'Ann')$$, 1);
select pg_temp.allow('A inserts attendee certificate in own event',
  $$insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id) values
    ('a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000009',
     'a4444444-0000-4000-8000-000000000009', 'a3333333-0000-4000-8000-000000000009')$$, 1);
select pg_temp.allow('A (owner) adds a member to own org',
  $$insert into public.organization_members (org_id, user_id, role) values
    ('a1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000003', 'admin')$$, 1);

select pg_temp.allow('A renames own org',          $$update public.organizations set name = 'Test Org A2' where id = 'a1111111-0000-4000-8000-000000000000'$$, 1);
select pg_temp.allow('A (owner) changes member role', $$update public.organization_members set role = 'owner' where user_id = 'a0000000-0000-4000-8000-000000000003'$$, 1);
select pg_temp.allow('A updates own event',        $$update public.events set title = 'A Event 2b' where id = 'a2222222-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A updates own certificate type', $$update public.certificate_types set label = 'P2' where id = 'a3333333-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A updates own attendee',     $$update public.attendees set full_name = 'Ann B' where id = 'a4444444-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A updates own attendee certificate', $$update public.attendee_certificates set download_count = 0 where attendee_id = 'a4444444-0000-4000-8000-000000000009'$$, 1);

select pg_temp.allow('A deletes own attendee certificate', $$delete from public.attendee_certificates where attendee_id = 'a4444444-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A deletes own attendee',     $$delete from public.attendees where id = 'a4444444-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A deletes own certificate type', $$delete from public.certificate_types where id = 'a3333333-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A deletes own event',        $$delete from public.events where id = 'a2222222-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A (owner) removes a member', $$delete from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000003'$$, 1);

-- =============================================================================
-- 2. User A attacks org B — SELECT / INSERT / UPDATE / DELETE on EVERY table
-- =============================================================================

-- organizations
select pg_temp.eq  ('organizations: A cannot SELECT org B', $$select count(*) from public.organizations where id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('organizations: A cannot INSERT an org', $$insert into public.organizations (name, slug, plan_id) values ('Evil', 'zz-evil', 'free')$$);
select pg_temp.deny('organizations: A cannot UPDATE org B', $$update public.organizations set name = 'hacked' where id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('organizations: A cannot DELETE org B', $$delete from public.organizations where id = 'b1111111-0000-4000-8000-000000000000'$$);

-- organization_members
select pg_temp.eq  ('members: A cannot SELECT org B members', $$select count(*) from public.organization_members where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('members: A cannot INSERT self into org B', $$insert into public.organization_members (org_id, user_id, role) values ('b1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'owner')$$);
select pg_temp.deny('members: A cannot UPDATE org B members', $$update public.organization_members set role = 'admin' where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('members: A cannot DELETE org B members', $$delete from public.organization_members where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

-- events
select pg_temp.eq  ('events: A cannot SELECT org B events', $$select count(*) from public.events where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('events: A cannot INSERT event into org B', $$insert into public.events (org_id, title, slug) values ('b1111111-0000-4000-8000-000000000000', 'Evil', 'zz-evil-event')$$);
select pg_temp.deny('events: A cannot UPDATE org B events', $$update public.events set title = 'hacked' where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('events: A cannot DELETE org B events', $$delete from public.events where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

-- certificate_types
select pg_temp.eq  ('certificate_types: A cannot SELECT org B types', $$select count(*) from public.certificate_types where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('certificate_types: A cannot INSERT into org B event', $$insert into public.certificate_types (org_id, event_id, key, label) values ('b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'evil', 'Evil')$$);
select pg_temp.deny('certificate_types: A cannot UPDATE org B types', $$update public.certificate_types set label = 'hacked' where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('certificate_types: A cannot DELETE org B types', $$delete from public.certificate_types where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

-- attendees
select pg_temp.eq  ('attendees: A cannot SELECT org B attendees', $$select count(*) from public.attendees where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('attendees: A cannot INSERT into org B event', $$insert into public.attendees (org_id, event_id, identifier, full_name) values ('b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'EVIL', 'Evil')$$);
select pg_temp.deny('attendees: A cannot UPDATE org B attendees', $$update public.attendees set full_name = 'hacked' where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('attendees: A cannot DELETE org B attendees', $$delete from public.attendees where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

-- attendee_certificates
select pg_temp.eq  ('attendee_certificates: A cannot SELECT org B rows', $$select count(*) from public.attendee_certificates where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('attendee_certificates: A cannot INSERT into org B', $$insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id) values ('b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'b4444444-0000-4000-8000-000000000000', 'b3333333-0000-4000-8000-000000000002')$$);
select pg_temp.deny('attendee_certificates: A cannot UPDATE org B rows', $$update public.attendee_certificates set download_count = 99 where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('attendee_certificates: A cannot DELETE org B rows', $$delete from public.attendee_certificates where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

-- download_log
select pg_temp.eq  ('download_log: A cannot SELECT org B log', $$select count(*) from public.download_log where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('download_log: A cannot INSERT into org B log', $$insert into public.download_log (org_id, attendee_certificate_id) values ('b1111111-0000-4000-8000-000000000000', 'b5555555-0000-4000-8000-000000000000')$$);
select pg_temp.deny('download_log: A cannot UPDATE org B log', $$update public.download_log set ip_hash = 'x' where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('download_log: A cannot DELETE org B log', $$delete from public.download_log where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

-- audit_log
select pg_temp.eq  ('audit_log: A cannot SELECT org B log', $$select count(*) from public.audit_log where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('audit_log: A cannot INSERT into org B log', $$insert into public.audit_log (org_id, action) values ('b1111111-0000-4000-8000-000000000000', 'evil')$$);
select pg_temp.deny('audit_log: A cannot UPDATE org B log', $$update public.audit_log set action = 'hacked' where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('audit_log: A cannot DELETE org B log', $$delete from public.audit_log where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

-- plans (global): readable, writable by nobody
select pg_temp.deny('plans: A cannot INSERT a plan', $$insert into public.plans (id, name) values ('evil', 'Evil')$$);
select pg_temp.deny('plans: A cannot UPDATE plans', $$update public.plans set price_pkr = 0$$);
select pg_temp.deny('plans: A cannot DELETE plans', $$delete from public.plans$$);

-- =============================================================================
-- 3. Sneaky cross-tenant tricks by user A
-- =============================================================================
select pg_temp.deny('trick: move own event into org B', $$update public.events set org_id = 'b1111111-0000-4000-8000-000000000000' where id = 'a2222222-0000-4000-8000-000000000000'$$);
select pg_temp.deny('trick: own-org attendee pointing at org B event', $$insert into public.attendees (org_id, event_id, identifier, full_name) values ('a1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'X', 'X')$$);
select pg_temp.deny('trick: own-org certificate type pointing at org B event', $$insert into public.certificate_types (org_id, event_id, key, label) values ('a1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'x', 'X')$$);
select pg_temp.deny('trick: own attendee given org B certificate type', $$insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id) values ('a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000000', 'a4444444-0000-4000-8000-000000000000', 'b3333333-0000-4000-8000-000000000002')$$);
select pg_temp.deny('trick: re-point own attendee to org B event', $$update public.attendees set event_id = 'b2222222-0000-4000-8000-000000000000' where id = 'a4444444-0000-4000-8000-000000000000'$$);
select pg_temp.deny('trick: A upgrades own plan (billing field)', $$update public.organizations set plan_id = 'starter' where id = 'a1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('trick: A un-suspends / changes own org status', $$update public.organizations set status = 'active' where id = 'a1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('trick: A moves own membership to org B', $$update public.organization_members set org_id = 'b1111111-0000-4000-8000-000000000000' where user_id = 'a0000000-0000-4000-8000-000000000001'$$);
select pg_temp.eq  ('trick: event_org_id(org B event) returns NULL', $$select public.event_org_id('b2222222-0000-4000-8000-000000000000')::text$$, null);
select pg_temp.eq  ('trick: is_org_member(org B) is false', $$select public.is_org_member('b1111111-0000-4000-8000-000000000000')::text$$, 'false');

-- =============================================================================
-- 4. User A2 (admin, not owner, of org A): owner-only actions denied
-- =============================================================================
select pg_temp.login('a0000000-0000-4000-8000-000000000002');
select pg_temp.allow('A2 (admin) can update own org event', $$update public.events set title = 'A Event' where id = 'a2222222-0000-4000-8000-000000000000'$$, 1);
select pg_temp.deny('A2 (admin) cannot add members',        $$insert into public.organization_members (org_id, user_id, role) values ('a1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000003', 'owner')$$);
select pg_temp.deny('A2 (admin) cannot promote self to owner', $$update public.organization_members set role = 'owner' where user_id = 'a0000000-0000-4000-8000-000000000002'$$);
select pg_temp.deny('A2 (admin) cannot remove the owner',   $$delete from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000001'$$);
select pg_temp.deny('A2 (admin) cannot delete the org',     $$delete from public.organizations where id = 'a1111111-0000-4000-8000-000000000000'$$);

-- =============================================================================
-- 5. User B — symmetric check: B sees only org B
-- =============================================================================
select pg_temp.login('b0000000-0000-4000-8000-000000000001');
select pg_temp.eq('B sees only org B events',    $$select count(*) from public.events where org_id <> 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.eq('B sees only org B attendees', $$select count(*) from public.attendees where org_id <> 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.eq('B sees own attendees',        $$select count(*) from public.attendees$$, '1');

-- =============================================================================
-- 6. anon (public, not logged in): no direct table access
-- =============================================================================
reset role;
set role anon;
select pg_temp.login(null);
select pg_temp.deny('anon: cannot SELECT organizations',         $$select * from public.organizations$$);
select pg_temp.deny('anon: cannot SELECT organization_members',  $$select * from public.organization_members$$);
select pg_temp.deny('anon: cannot SELECT events',                $$select * from public.events$$);
select pg_temp.deny('anon: cannot SELECT certificate_types',     $$select * from public.certificate_types$$);
select pg_temp.deny('anon: cannot SELECT attendees',             $$select * from public.attendees$$);
select pg_temp.deny('anon: cannot SELECT attendee_certificates', $$select * from public.attendee_certificates$$);
select pg_temp.deny('anon: cannot SELECT download_log',          $$select * from public.download_log$$);
select pg_temp.deny('anon: cannot SELECT audit_log',             $$select * from public.audit_log$$);
select pg_temp.deny('anon: cannot INSERT attendees',             $$insert into public.attendees (org_id, event_id, identifier, full_name) values ('b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'ANON', 'Anon')$$);
select pg_temp.deny('anon: cannot UPDATE attendee_certificates', $$update public.attendee_certificates set download_count = 0$$);
select pg_temp.deny('anon: cannot DELETE events',                $$delete from public.events$$);
select pg_temp.deny('anon: cannot call event_org_id()',          $$select public.event_org_id('b2222222-0000-4000-8000-000000000000')$$);
select pg_temp.deny('anon: cannot INSERT plans',                 $$insert into public.plans (id, name) values ('evil', 'Evil')$$);
select pg_temp.eq  ('anon: CAN read plans',                      $$select count(*) from public.plans$$, '2');

-- =============================================================================
-- 7. Org B data is byte-for-byte unchanged after all attacks
-- =============================================================================
reset role;
select pg_temp.eq('org B data unchanged (fingerprint)',
  $$select (select md5(string_agg(x, '|' order by x)) from (
      select 'org:'  || row(o.*)::text as x from public.organizations o where o.id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'mem:' || row(m.*)::text from public.organization_members m where m.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'evt:' || row(e.*)::text from public.events e where e.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'ct:'  || row(c.*)::text from public.certificate_types c where c.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'att:' || row(a.*)::text from public.attendees a where a.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'ac:'  || row(ac.*)::text from public.attendee_certificates ac where ac.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'dl:'  || row(d.*)::text from public.download_log d where d.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'au:'  || row(l.*)::text from public.audit_log l where l.org_id = 'b1111111-0000-4000-8000-000000000000'
    ) s) = (select fp from pg_temp.b_before)$$::text, 'true');

select pg_temp.eq('every public table has RLS enabled',
  $$select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity$$, '0');

-- -----------------------------------------------------------------------------
-- Cleanup (cascades remove all test rows) and report
-- -----------------------------------------------------------------------------
delete from public.organizations where id in ('a1111111-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000');
delete from auth.users where id in (
  'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001');

select 0 as n,
       case when bool_and(pass) then 'ALL ' || count(*) || ' TESTS PASSED'
            else count(*) filter (where not pass) || ' OF ' || count(*) || ' TESTS FAILED' end as test,
       null as expected, null as actual,
       case when bool_and(pass) then 'PASS' else 'FAIL' end as result
  from pg_temp.results
union all
select n, test, expected, actual, case when pass then 'PASS' else 'FAIL' end
  from pg_temp.results
order by n;
