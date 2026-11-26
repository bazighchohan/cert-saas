-- =============================================================================
-- supabase/tests/cross_org_every_resource.sql
--
-- Automated cross-organization isolation & attack test suite across EVERY
-- tenant resource type (migrations 001..012):
--   1. organizations
--   2. organization_members
--   3. events
--   4. certificate_types
--   5. attendees
--   6. attendee_certificates
--   7. download_log
--   8. audit_log
--   9. payment_requests
--  10. super_admins (privilege escalation attempt)
--  11. Storage "templates" object helper (can_access_template_object)
--  12. Storage "payment-proofs" object helper (can_access_payment_proof_object)
--
-- Runs inside a transaction and ROLLS BACK at the end so it is safe to run
-- against a live dev database or PGlite. Any leak raises an exception.
-- =============================================================================

begin;

-- Seed two isolated users & organizations (Org A = Victim, Org B = Attacker)
insert into auth.users (id) values
  ('aaaa1111-1111-4111-8111-111111111111'),
  ('bbbb2222-2222-4222-8222-222222222222')
on conflict (id) do nothing;

do $$
declare
  v_user_a uuid := 'aaaa1111-1111-4111-8111-111111111111';
  v_user_b uuid := 'bbbb2222-2222-4222-8222-222222222222';
  v_org_a  uuid;
  v_org_b  uuid;
  v_ev_a   uuid;
  v_ev_b   uuid;
  v_ct_a   uuid;
  v_att_a  uuid;
  v_ac_a   uuid;
  v_pay_a  uuid;
begin
  select org_id into v_org_a from public.create_organization_for_user(v_user_a, 'Victim Org A');
  select org_id into v_org_b from public.create_organization_for_user(v_user_b, 'Attacker Org B');

  insert into public.events (org_id, slug, title, released)
  values (v_org_a, 'sec-test-org-a-ev', 'Org A Secret Event', true)
  returning id into v_ev_a;

  insert into public.events (org_id, slug, title, released)
  values (v_org_b, 'sec-test-org-b-ev', 'Org B Event', true)
  returning id into v_ev_b;

  insert into public.certificate_types (org_id, event_id, key, label, template_path)
  values (v_org_a, v_ev_a, 'winner', 'Winner', v_org_a::text || '/' || v_ev_a::text || '/tpl.pdf')
  returning id into v_ct_a;

  insert into public.attendees (org_id, event_id, identifier, full_name, email, source, issue_note)
  values (v_org_a, v_ev_a, 'SEC-001', 'Alice Victim', 'alice@org-a.org', 'manual', 'Internal note')
  returning id into v_att_a;

  insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id, verify_code)
  values (v_org_a, v_ev_a, v_att_a, v_ct_a, 'SECVICT0001')
  returning id into v_ac_a;

  perform * from public.claim_certificate_download(v_org_a, v_ev_a, v_ac_a, 'iphash_a');

  insert into public.payment_requests (
    org_id, requested_by, plan_id, amount_pkr, payment_method, transaction_reference, screenshot_path
  ) values (
    v_org_a, v_user_a, 'starter', 2999, 'bank', 'REF-ORGA-1', v_org_a::text || '/proof.png'
  ) returning id into v_pay_a;

  -- Save IDs in session config for the authenticated attacker block below
  perform set_config('test.org_a', v_org_a::text, true);
  perform set_config('test.org_b', v_org_b::text, true);
  perform set_config('test.ev_a',  v_ev_a::text, true);
  perform set_config('test.ev_b',  v_ev_b::text, true);
  perform set_config('test.ct_a',  v_ct_a::text, true);
  perform set_config('test.att_a', v_att_a::text, true);
  perform set_config('test.ac_a',  v_ac_a::text, true);
  perform set_config('test.pay_a', v_pay_a::text, true);
end $$;

-- Switch to authenticated role as Attacker (User B of Org B)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbb2222-2222-4222-8222-222222222222', true);

do $$
declare
  v_org_a uuid := current_setting('test.org_a')::uuid;
  v_org_b uuid := current_setting('test.org_b')::uuid;
  v_ev_a  uuid := current_setting('test.ev_a')::uuid;
  v_ev_b  uuid := current_setting('test.ev_b')::uuid;
  v_ct_a  uuid := current_setting('test.ct_a')::uuid;
  v_att_a uuid := current_setting('test.att_a')::uuid;
  v_ac_a  uuid := current_setting('test.ac_a')::uuid;
  v_pay_a uuid := current_setting('test.pay_a')::uuid;
  v_cnt   int;
  v_blocked boolean;
begin
  -- 1. Cross-org SELECT must return 0 rows on EVERY tenant table
  select count(*) into v_cnt from public.organizations where id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: organizations SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.organization_members where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: organization_members SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.events where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: events SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.certificate_types where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: certificate_types SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.attendees where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: attendees SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.attendee_certificates where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: attendee_certificates SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.download_log where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: download_log SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.audit_log where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: audit_log SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.payment_requests where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: payment_requests SELECT (%)', v_cnt; end if;

  -- 2. Cross-org UPDATE / DELETE must affect 0 rows on Org A resources
  update public.organizations set name = 'Hacked' where id = v_org_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: organizations UPDATE'; end if;

  update public.events set title = 'Hacked' where id = v_ev_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: events UPDATE'; end if;

  delete from public.events where id = v_ev_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: events DELETE'; end if;

  update public.certificate_types set label = 'Hacked' where id = v_ct_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: certificate_types UPDATE'; end if;

  update public.attendees set full_name = 'Hacked', issue_note = 'Hacked' where id = v_att_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: attendees UPDATE'; end if;

  delete from public.attendees where id = v_att_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: attendees DELETE'; end if;

  delete from public.attendee_certificates where id = v_ac_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: attendee_certificates DELETE'; end if;

  -- 3. Cross-org INSERT & hybrid composite-FK attacks must raise an exception
  v_blocked := false;
  begin
    insert into public.events (org_id, slug, title) values (v_org_a, 'injected-ev', 'Injected');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: cross-org event INSERT succeeded'; end if;

  -- Hybrid attack: Attacker sets org_id = Org B (their own org!) but points event_id at Org A's event
  v_blocked := false;
  begin
    insert into public.attendees (org_id, event_id, identifier, full_name, source)
    values (v_org_b, v_ev_a, 'HYBRID-1', 'Hybrid Attack', 'manual');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: hybrid cross-org attendee INSERT succeeded'; end if;

  -- Hybrid attack on attendee_certificates: org_id = Org B, event_id = Org B, but certificate_type_id = Org A!
  v_blocked := false;
  begin
    insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id)
    values (v_org_b, v_ev_b, v_att_a, v_ct_a);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: hybrid attendee_certificates INSERT succeeded'; end if;

  -- 4. Privilege escalation attempts on super_admins & billing RPCs must fail
  if public.is_super_admin() then
    raise exception 'LEAK: attacker reported as super_admin';
  end if;

  v_blocked := false;
  begin
    insert into public.super_admins (user_id) values ('bbbb2222-2222-4222-8222-222222222222');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: super_admins self-insert succeeded'; end if;

  v_blocked := false;
  begin
    perform * from public.review_payment_request(v_pay_a, 'approved', 'attacker', null, 30);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: authenticated called review_payment_request RPC'; end if;

  -- 5. Storage path helpers block cross-org & path-traversal access on both private buckets
  if public.can_access_template_object('templates', v_org_a::text || '/' || v_ev_a::text || '/tpl.pdf') then
    raise exception 'LEAK: Attacker accessed Org A template in Storage';
  end if;

  if public.can_access_template_object('templates', v_org_b::text || '/../' || v_org_a::text || '/tpl.pdf') then
    raise exception 'LEAK: Path traversal bypassed can_access_template_object';
  end if;

  if public.can_access_payment_proof_object('payment-proofs', v_org_a::text || '/proof.png') then
    raise exception 'LEAK: Attacker accessed Org A payment proof in Storage';
  end if;

  if public.can_access_payment_proof_object('payment-proofs', v_org_b::text || '/../' || v_org_a::text || '/proof.png') then
    raise exception 'LEAK: Path traversal bypassed can_access_payment_proof_object';
  end if;
end $$;

rollback;
