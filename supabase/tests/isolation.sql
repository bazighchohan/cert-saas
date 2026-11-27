-- =============================================================================
-- supabase/tests/isolation.sql — proves tenant isolation across migrations 001..013
--
-- How to run: Supabase SQL Editor → paste → Run (as the default `postgres` role).
-- Output: one row per test (n, test, expected, actual, result). Row 0 is the
-- summary and must read "ALL n TESTS PASSED".
-- =============================================================================

reset role;

delete from public.organizations where id in ('a1111111-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000');
delete from auth.users where id in (
  'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001');

drop table if exists pg_temp.results;
create temp table results (n int, test text, expected text, actual text, pass boolean);
grant all on pg_temp.results to public;

insert into auth.users (id) values
  ('a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000003'),
  ('b0000000-0000-4000-8000-000000000001');

insert into public.organizations (id, name, slug, plan_id) values
  ('a1111111-0000-4000-8000-000000000000', 'Test Org A', 'zz-test-org-a', null),
  ('b1111111-0000-4000-8000-000000000000', 'Test Org B', 'zz-test-org-b', null);

insert into public.organization_members (org_id, user_id, role) values
  ('a1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'owner'),
  ('a1111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000002', 'admin'),
  ('b1111111-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000001', 'owner');

insert into public.purchases (
  id, org_id, plan_id, kind, events_total, events_used, certs_per_event, months,
  list_price_pkr, discount_pkr, final_price_pkr, status, starts_at, expires_at
) values
  ('a6666666-0000-4000-8000-000000000000', 'a1111111-0000-4000-8000-000000000000', 'multi-100', 'multi', 3, 2, 100, 3, 2400, 600, 2400, 'active', now(), now() + interval '3 months'),
  ('b6666666-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000', 'single-100', 'single', 1, 1, 100, 3, 1000, 0, 1000, 'active', now(), now() + interval '3 months');

insert into public.events (id, org_id, purchase_id, max_certificates, title, slug) values
  ('a2222222-0000-4000-8000-000000000000', 'a1111111-0000-4000-8000-000000000000', 'a6666666-0000-4000-8000-000000000000', 100, 'A Event', 'zz-test-a-event'),
  ('a2222222-0000-4000-8000-000000000009', 'a1111111-0000-4000-8000-000000000000', 'a6666666-0000-4000-8000-000000000000', 100, 'A Event 2', 'zz-test-a-event-2'),
  ('b2222222-0000-4000-8000-000000000000', 'b1111111-0000-4000-8000-000000000000', 'b6666666-0000-4000-8000-000000000000', 100, 'B Event', 'zz-test-b-event');

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

insert into public.certificate_topups (
  org_id, event_id, certs_added, cert_rate_pkr, amount_pkr, payment_method, transaction_reference
) values
  ('a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000000', 25, 5, 125, 'bank', 'TOP-A1'),
  ('b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 25, 5, 125, 'bank', 'TOP-B1');

-- Fingerprint of all org B data, to prove nothing changed at the end.
drop table if exists pg_temp.b_before;
create temp table b_before as
select md5(string_agg(x, '|' order by x)) as fp from (
  select 'org:'  || row(o.*)::text as x from public.organizations o where o.id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'mem:' || row(m.*)::text from public.organization_members m where m.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'pur:' || row(p.*)::text from public.purchases p where p.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'evt:' || row(e.*)::text from public.events e where e.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'ct:'  || row(c.*)::text from public.certificate_types c where c.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'att:' || row(a.*)::text from public.attendees a where a.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'ac:'  || row(ac.*)::text from public.attendee_certificates ac where ac.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'top:' || row(t.*)::text from public.certificate_topups t where t.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'dl:'  || row(d.*)::text from public.download_log d where d.org_id = 'b1111111-0000-4000-8000-000000000000'
  union all select 'au:'  || row(l.*)::text from public.audit_log l where l.org_id = 'b1111111-0000-4000-8000-000000000000'
) s;

create or replace function pg_temp.rec(p_test text, p_expected text, p_actual text, p_pass boolean)
returns void language sql as $$
  insert into pg_temp.results
  values ((select coalesce(max(n), 0) + 1 from pg_temp.results), p_test, p_expected, p_actual, p_pass);
$$;

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  perform set_config('request.jwt.claims',
    case when p_user is null then '{"role":"anon"}'
         else json_build_object('sub', p_user, 'role', 'authenticated')::text end, false);
end $$;

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

create or replace function pg_temp.allow(p_test text, p_sql text, p_rows int) returns void language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform pg_temp.rec(p_test, p_rows || ' rows affected', n || ' rows affected', n = p_rows);
exception when others then
  perform pg_temp.rec(p_test, p_rows || ' rows affected', 'ERROR ' || sqlstate || ': ' || sqlerrm, false);
end $$;

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
select pg_temp.eq('A sees own purchases',            $$select count(*) from public.purchases$$, '1');
select pg_temp.eq('A sees own topups',               $$select count(*) from public.certificate_topups$$, '1');
select pg_temp.eq('A sees own events',               $$select count(*) from public.events$$, '2');
select pg_temp.eq('A sees own certificate types',    $$select count(*) from public.certificate_types$$, '1');
select pg_temp.eq('A sees own attendees',            $$select count(*) from public.attendees$$, '1');
select pg_temp.eq('A sees own attendee certificates',$$select count(*) from public.attendee_certificates$$, '1');
select pg_temp.eq('A sees own download log',         $$select count(*) from public.download_log$$, '1');
select pg_temp.eq('A sees own audit log',            $$select count(*) from public.audit_log$$, '1');
select pg_temp.eq('A sees all 5 preset plans',       $$select count(*) from public.plans$$, '5');
select pg_temp.eq('A sees pricing_config',           $$select count(*) from public.pricing_config$$, '1');

-- Direct client event insert is denied (events must consume a slot via server RPC)
select pg_temp.deny('A cannot bypass slot RPC via direct events INSERT',
  $$insert into public.events (org_id, title, slug) values
    ('a1111111-0000-4000-8000-000000000000', 'Bypass', 'zz-bypass-slot')$$);

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

select pg_temp.allow('A renames own org',            $$update public.organizations set name = 'Test Org A2' where id = 'a1111111-0000-4000-8000-000000000000'$$, 1);
select pg_temp.allow('A (owner) changes member role', $$update public.organization_members set role = 'owner' where user_id = 'a0000000-0000-4000-8000-000000000003'$$, 1);
select pg_temp.allow('A updates own event',          $$update public.events set title = 'A Event 2b' where id = 'a2222222-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A updates own certificate type', $$update public.certificate_types set label = 'P2' where id = 'a3333333-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A updates own attendee',       $$update public.attendees set full_name = 'Ann B' where id = 'a4444444-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A updates own attendee certificate', $$update public.attendee_certificates set download_count = 0 where attendee_id = 'a4444444-0000-4000-8000-000000000009'$$, 1);

select pg_temp.allow('A deletes own attendee certificate', $$delete from public.attendee_certificates where attendee_id = 'a4444444-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A deletes own attendee',       $$delete from public.attendees where id = 'a4444444-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A deletes own certificate type', $$delete from public.certificate_types where id = 'a3333333-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A deletes own event',          $$delete from public.events where id = 'a2222222-0000-4000-8000-000000000009'$$, 1);
select pg_temp.allow('A (owner) removes a member',   $$delete from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000003'$$, 1);

-- =============================================================================
-- 2. User A attacks org B & platform tables
-- =============================================================================
select pg_temp.eq  ('organizations: A cannot SELECT org B', $$select count(*) from public.organizations where id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('organizations: A cannot INSERT an org', $$insert into public.organizations (name, slug) values ('Evil', 'zz-evil')$$);
select pg_temp.deny('organizations: A cannot UPDATE org B', $$update public.organizations set name = 'hacked' where id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('organizations: A cannot DELETE org B', $$delete from public.organizations where id = 'b1111111-0000-4000-8000-000000000000'$$);

select pg_temp.eq  ('purchases: A cannot SELECT org B purchases', $$select count(*) from public.purchases where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('purchases: A cannot INSERT purchases directly', $$insert into public.purchases (org_id, kind, events_total, certs_per_event, months, list_price_pkr, final_price_pkr, status) values ('a1111111-0000-4000-8000-000000000000', 'pro', 10, 500, 12, 0, 0, 'active')$$);
select pg_temp.deny('purchases: A cannot UPDATE own purchase slots', $$update public.purchases set events_total = 999 where org_id = 'a1111111-0000-4000-8000-000000000000'$$);

select pg_temp.eq  ('topups: A cannot SELECT org B topups', $$select count(*) from public.certificate_topups where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('topups: A cannot INSERT topups directly', $$insert into public.certificate_topups (org_id, event_id, certs_added, cert_rate_pkr, amount_pkr) values ('a1111111-0000-4000-8000-000000000000', 'a2222222-0000-4000-8000-000000000000', 500, 0, 0)$$);

select pg_temp.deny('pricing_config: non-superadmin cannot UPDATE pricing_config', $$update public.pricing_config set event_fee_pkr = 0 where id = true$$);
select pg_temp.deny('plans: A cannot INSERT a plan', $$insert into public.plans (id, name) values ('evil', 'Evil')$$);
select pg_temp.deny('plans: A cannot UPDATE plans', $$update public.plans set events_count = 99$$);
select pg_temp.deny('plans: A cannot DELETE plans', $$delete from public.plans$$);

select pg_temp.eq  ('events: A cannot SELECT org B events', $$select count(*) from public.events where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('events: A cannot UPDATE org B events', $$update public.events set title = 'hacked' where org_id = 'b1111111-0000-4000-8000-000000000000'$$);
select pg_temp.deny('events: A cannot DELETE org B events', $$delete from public.events where org_id = 'b1111111-0000-4000-8000-000000000000'$$);

select pg_temp.eq  ('attendees: A cannot SELECT org B attendees', $$select count(*) from public.attendees where org_id = 'b1111111-0000-4000-8000-000000000000'$$, '0');
select pg_temp.deny('attendees: A cannot INSERT into org B event', $$insert into public.attendees (org_id, event_id, identifier, full_name) values ('b1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'EVIL', 'Evil')$$);

-- =============================================================================
-- 3. Sneaky cross-tenant tricks by user A
-- =============================================================================
select pg_temp.deny('trick: move own event into org B', $$update public.events set org_id = 'b1111111-0000-4000-8000-000000000000' where id = 'a2222222-0000-4000-8000-000000000000'$$);
select pg_temp.deny('trick: point own event at org B purchase', $$update public.events set purchase_id = 'b6666666-0000-4000-8000-000000000000' where id = 'a2222222-0000-4000-8000-000000000000'$$);
select pg_temp.deny('trick: own-org attendee pointing at org B event', $$insert into public.attendees (org_id, event_id, identifier, full_name) values ('a1111111-0000-4000-8000-000000000000', 'b2222222-0000-4000-8000-000000000000', 'X', 'X')$$);
select pg_temp.deny('trick: A upgrades own plan_id column', $$update public.organizations set plan_id = 'pro' where id = 'a1111111-0000-4000-8000-000000000000'$$);
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
-- 5. anon (public, not logged in): no direct tenant access, can read presets & pricing_config
-- =============================================================================
reset role;
set role anon;
select pg_temp.login(null);
select pg_temp.deny('anon: cannot SELECT organizations',  $$select * from public.organizations$$);
select pg_temp.deny('anon: cannot SELECT purchases',      $$select * from public.purchases$$);
select pg_temp.deny('anon: cannot SELECT topups',         $$select * from public.certificate_topups$$);
select pg_temp.deny('anon: cannot SELECT events',         $$select * from public.events$$);
select pg_temp.deny('anon: cannot SELECT attendees',      $$select * from public.attendees$$);
select pg_temp.deny('anon: cannot UPDATE pricing_config', $$update public.pricing_config set event_fee_pkr = 0$$);
select pg_temp.eq  ('anon: CAN read 5 preset plans',      $$select count(*) from public.plans$$, '5');
select pg_temp.eq  ('anon: CAN read pricing_config',      $$select count(*) from public.pricing_config$$, '1');

-- =============================================================================
-- 6. Org B data is byte-for-byte unchanged & every public table has RLS enabled
-- =============================================================================
reset role;
select pg_temp.eq('org B data unchanged (fingerprint)',
  $$select (select md5(string_agg(x, '|' order by x)) from (
      select 'org:'  || row(o.*)::text as x from public.organizations o where o.id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'mem:' || row(m.*)::text from public.organization_members m where m.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'pur:' || row(p.*)::text from public.purchases p where p.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'evt:' || row(e.*)::text from public.events e where e.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'ct:'  || row(c.*)::text from public.certificate_types c where c.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'att:' || row(a.*)::text from public.attendees a where a.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'ac:'  || row(ac.*)::text from public.attendee_certificates ac where ac.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'top:' || row(t.*)::text from public.certificate_topups t where t.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'dl:'  || row(d.*)::text from public.download_log d where d.org_id = 'b1111111-0000-4000-8000-000000000000'
      union all select 'au:'  || row(l.*)::text from public.audit_log l where l.org_id = 'b1111111-0000-4000-8000-000000000000'
    ) s) = (select fp from pg_temp.b_before)$$::text, 'true');

select pg_temp.eq('every public table has RLS enabled',
  $$select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity$$, '0');

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
