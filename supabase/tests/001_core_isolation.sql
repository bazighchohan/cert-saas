-- Isolation tests for 001_core.sql. Safe to run in Supabase SQL Editor: everything is rolled back.
-- Expected last result: ALL TESTS PASSED. Any failure raises an error naming the check.
begin;
-- Isolation tests. Each check prints PASS/FAIL via NOTICE; any FAIL raises.
set client_min_messages = notice;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b');

insert into public.organizations (id, name, slug, plan_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Org A', 'org-a', 'free'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Org B', 'org-b', 'starter');

insert into public.organization_members (org_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'owner');

insert into public.events (id, org_id, title, slug) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A Event', 'a-event'),
  ('bbbbbbbb-0000-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B Event', 'b-event');

insert into public.certificate_types (id, org_id, event_id, key, label, template_path) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1',
   'participation', 'Participation', 'aaaaaaaa-0000-0000-0000-000000000001/a-event/participation.pdf');

insert into public.attendees (id, org_id, event_id, identifier, full_name) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'FA24-BSE-001', 'Alice'),
  ('bbbbbbbb-0000-0000-0000-0000000000a1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000e1', 'EMP-1', 'Bob');

insert into public.attendee_certificates (id, org_id, event_id, attendee_id, certificate_type_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ac', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000c1');

insert into public.download_log (org_id, attendee_certificate_id, ip_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000ac', 'x');

-- Helper: expect a statement to fail.
create or replace function pg_temp.expect_fail(label text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'PASS  % (rejected: %)', label, sqlerrm;
    return;
  end;
  raise exception 'FAIL  % — statement was accepted', label;
end $$;

-- 1. Cross-tenant references are impossible.
select pg_temp.expect_fail('attendee in org A pointing at org B event',
  $q$insert into public.attendees (org_id, event_id, identifier, full_name)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000e1', 'X', 'X')$q$);
select pg_temp.expect_fail('cert type in org B pointing at org A event',
  $q$insert into public.certificate_types (org_id, event_id, key, label)
     values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'k', 'K')$q$);
select pg_temp.expect_fail('attendee_certificate mixing org B attendee with org A cert type',
  $q$insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1',
             'bbbbbbbb-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000c1')$q$);
select pg_temp.expect_fail('download_log with wrong org',
  $q$insert into public.download_log (org_id, attendee_certificate_id)
     values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000ac')$q$);
select pg_temp.expect_fail('template_path outside own org folder',
  $q$insert into public.certificate_types (org_id, event_id, key, label, template_path)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'x', 'X',
             'bbbbbbbb-0000-0000-0000-000000000001/stolen.pdf')$q$);
select pg_temp.expect_fail('duplicate identifier in same event',
  $q$insert into public.attendees (org_id, event_id, identifier, full_name)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'FA24-BSE-001', 'Dup')$q$);
-- Same identifier in another org's event is allowed.
insert into public.attendees (org_id, event_id, identifier, full_name)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000e1', 'FA24-BSE-001', 'Other org, same roll');
do $$ begin raise notice 'PASS  same identifier allowed in a different org/event'; end $$;

-- 2. updated_at trigger.
do $$
declare after timestamptz;
begin
  -- Trying to set updated_at by hand must be overridden by the trigger.
  update public.events set title = 'A Event 2', updated_at = '2000-01-01' where slug = 'a-event';
  select updated_at into after from public.events where slug = 'a-event';
  if after > '2001-01-01' then raise notice 'PASS  updated_at trigger'; else raise exception 'FAIL  updated_at trigger'; end if;
end $$;

-- 3. RLS: signed-in user A sees only org A.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$
declare n_orgs int; n_att int; n_b int;
begin
  select count(*) into n_orgs from public.organizations;
  select count(*) into n_att  from public.attendees;
  select count(*) into n_b    from public.attendees where org_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  if n_orgs = 1 and n_att = 1 and n_b = 0 then raise notice 'PASS  RLS: user A sees only org A (orgs=%, attendees=%)', n_orgs, n_att;
  else raise exception 'FAIL  RLS user A: orgs=%, attendees=%, orgB rows=%', n_orgs, n_att, n_b; end if;
end $$;
select pg_temp.expect_fail('authenticated user cannot INSERT directly',
  $q$insert into public.events (org_id, title, slug) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Hack', 'hack')$q$);
select pg_temp.expect_fail('authenticated user cannot UPDATE directly',
  $q$update public.attendees set full_name = 'Hacked'$q$);
reset role;

-- 4. anon sees nothing tenant-related, can read plans.
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.expect_fail('anon cannot read attendees', $q$select * from public.attendees$q$);
do $$
declare n int;
begin
  select count(*) into n from public.plans;
  if n = 2 then raise notice 'PASS  anon can read 2 active plans'; else raise exception 'FAIL  anon plans=%', n; end if;
end $$;
reset role;

-- 5. Deleting an org cascades everything.
delete from public.organizations where slug = 'org-a';
do $$
declare n int;
begin
  select (select count(*) from public.events where org_id = 'aaaaaaaa-0000-0000-0000-000000000001')
       + (select count(*) from public.attendees where org_id = 'aaaaaaaa-0000-0000-0000-000000000001')
       + (select count(*) from public.download_log where org_id = 'aaaaaaaa-0000-0000-0000-000000000001')
    into n;
  if n = 0 then raise notice 'PASS  org delete cascades'; else raise exception 'FAIL  % rows left', n; end if;
end $$;

-- 6. Every FK has a supporting index whose leading columns match.
do $$
declare r record; missing int := 0;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
     where c.contype = 'f' and c.connamespace = 'public'::regnamespace
       and not exists (
         select 1 from pg_index i
          where i.indrelid = c.conrelid
            and (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey
            and (i.indkey::int2[])[0:array_length(c.conkey,1)-1] <@ c.conkey)
  loop
    raise notice 'MISSING index for FK % on %', r.conname, r.tbl; missing := missing + 1;
  end loop;
  if missing = 0 then raise notice 'PASS  every FK is indexed'; else raise exception 'FAIL  % FKs unindexed', missing; end if;
end $$;

select 'ALL TESTS PASSED' as result;

rollback; -- leaves the database untouched
