-- =============================================================================
-- supabase/tests/cross_org_every_resource.sql
--
-- Automated cross-organization isolation & attack test suite across EVERY
-- tenant & platform resource type (migrations 001..013):
--   1. organizations
--   2. organization_members
--   3. events
--   4. certificate_types
--   5. attendees
--   6. attendee_certificates
--   7. download_log
--   8. audit_log
--   9. payment_requests
--  10. purchases (including composite FK cross-org purchase consumption attempt)
--  11. certificate_topups
--  12. pricing_config (non-superadmin update attempt)
--  13. super_admins (privilege escalation attempt)
--  14. Storage "templates" & "payment-proofs" object helpers
--
-- Runs inside a transaction and ROLLS BACK at the end so it is safe to run
-- against a live dev database or PGlite. Any leak raises an exception.
-- =============================================================================

begin;

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
  v_pur_a  uuid;
  v_pur_b  uuid;
  v_ev_a   uuid;
  v_ev_b   uuid;
  v_ct_a   uuid;
  v_att_a  uuid;
  v_ac_a   uuid;
  v_top_a  uuid;
  v_pay_a  uuid;
begin
  select org_id into v_org_a from public.create_organization_for_user(v_user_a, 'Victim Org A');
  select org_id into v_org_b from public.create_organization_for_user(v_user_b, 'Attacker Org B');

  insert into public.purchases (
    org_id, requested_by, plan_id, kind, events_total, events_used, certs_per_event,
    months, list_price_pkr, discount_pkr, final_price_pkr, status, starts_at, expires_at
  ) values (
    v_org_a, v_user_a, 'single-100', 'single', 2, 1, 100, 3, 1000, 0, 1000,
    'active', now(), now() + interval '3 months'
  ) returning id into v_pur_a;

  insert into public.purchases (
    org_id, requested_by, plan_id, kind, events_total, events_used, certs_per_event,
    months, list_price_pkr, discount_pkr, final_price_pkr, status, starts_at, expires_at
  ) values (
    v_org_b, v_user_b, 'single-50', 'single', 1, 1, 50, 3, 750, 0, 750,
    'active', now(), now() + interval '3 months'
  ) returning id into v_pur_b;

  insert into public.events (org_id, purchase_id, max_certificates, slug, title, released, retention_until)
  values (v_org_a, v_pur_a, 100, 'sec-test-org-a-ev', 'Org A Secret Event', true, now() + interval '12 months')
  returning id into v_ev_a;

  insert into public.events (org_id, purchase_id, max_certificates, slug, title, released, retention_until)
  values (v_org_b, v_pur_b, 50, 'sec-test-org-b-ev', 'Org B Event', true, now() + interval '12 months')
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

  insert into public.certificate_topups (
    org_id, event_id, requested_by, certs_added, cert_rate_pkr, amount_pkr, payment_method, transaction_reference
  ) values (
    v_org_a, v_ev_a, v_user_a, 50, 5, 250, 'bank', 'TOPUP-ORGA-1'
  ) returning id into v_top_a;

  insert into public.payment_requests (
    org_id, requested_by, plan_id, amount_pkr, payment_method, transaction_reference, screenshot_path
  ) values (
    v_org_a, v_user_a, 'single-100', 1000, 'bank', 'REF-ORGA-1', v_org_a::text || '/proof.png'
  ) returning id into v_pay_a;

  perform set_config('test.org_a', v_org_a::text, true);
  perform set_config('test.org_b', v_org_b::text, true);
  perform set_config('test.pur_a', v_pur_a::text, true);
  perform set_config('test.ev_a',  v_ev_a::text, true);
  perform set_config('test.ev_b',  v_ev_b::text, true);
  perform set_config('test.ct_a',  v_ct_a::text, true);
  perform set_config('test.att_a', v_att_a::text, true);
  perform set_config('test.ac_a',  v_ac_a::text, true);
  perform set_config('test.top_a', v_top_a::text, true);
  perform set_config('test.pay_a', v_pay_a::text, true);
end $$;

-- Switch to authenticated role as Attacker (User B of Org B)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbb2222-2222-4222-8222-222222222222', true);

do $$
declare
  v_org_a uuid := current_setting('test.org_a')::uuid;
  v_org_b uuid := current_setting('test.org_b')::uuid;
  v_pur_a uuid := current_setting('test.pur_a')::uuid;
  v_ev_a  uuid := current_setting('test.ev_a')::uuid;
  v_ev_b  uuid := current_setting('test.ev_b')::uuid;
  v_ct_a  uuid := current_setting('test.ct_a')::uuid;
  v_att_a uuid := current_setting('test.att_a')::uuid;
  v_ac_a  uuid := current_setting('test.ac_a')::uuid;
  v_top_a uuid := current_setting('test.top_a')::uuid;
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

  select count(*) into v_cnt from public.purchases where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: purchases SELECT (%)', v_cnt; end if;

  select count(*) into v_cnt from public.certificate_topups where org_id = v_org_a;
  if v_cnt <> 0 then raise exception 'LEAK: certificate_topups SELECT (%)', v_cnt; end if;

  -- 2. Non-superadmin cannot modify pricing_config
  update public.pricing_config set event_fee_pkr = 1 where id = true;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: non-superadmin updated pricing_config'; end if;

  -- 3. Cross-org UPDATE / DELETE must affect 0 rows on Org A resources
  update public.organizations set name = 'Hacked' where id = v_org_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: organizations UPDATE'; end if;

  update public.events set title = 'Hacked' where id = v_ev_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: events UPDATE'; end if;

  delete from public.events where id = v_ev_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: events DELETE'; end if;

  update public.attendees set full_name = 'Hacked', issue_note = 'Hacked' where id = v_att_a;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'LEAK: attendees UPDATE'; end if;

  -- 4. Cross-org INSERT & hybrid composite-FK attacks must raise an exception
  v_blocked := false;
  begin
    insert into public.events (org_id, purchase_id, slug, title)
    values (v_org_b, v_pur_a, 'stolen-purchase-ev', 'Stolen Purchase');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: Org B attached Org A purchase_id'; end if;

  v_blocked := false;
  begin
    insert into public.attendees (org_id, event_id, identifier, full_name, source)
    values (v_org_b, v_ev_a, 'HYBRID-1', 'Hybrid Attack', 'manual');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: hybrid cross-org attendee INSERT succeeded'; end if;

  -- 5. Privilege escalation attempts on super_admins & billing RPCs must fail
  if public.is_super_admin() then
    raise exception 'LEAK: attacker reported as super_admin';
  end if;

  v_blocked := false;
  begin
    perform * from public.review_purchase_request(v_pur_a, 'approved', 'attacker', null);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: authenticated called review_purchase_request RPC'; end if;

  v_blocked := false;
  begin
    perform * from public.review_certificate_topup(v_top_a, 'approved', 'attacker', null);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: authenticated called review_certificate_topup RPC'; end if;

  v_blocked := false;
  begin
    perform * from public.create_event_consuming_slot(v_org_a, 'bbbb2222-2222-4222-8222-222222222222', 'Hack', null, 'hack-slug');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'LEAK: authenticated called create_event_consuming_slot RPC'; end if;

  -- 6. Storage path helpers block cross-org & path-traversal access on both private buckets
  if public.can_access_template_object('templates', v_org_a::text || '/' || v_ev_a::text || '/tpl.pdf') then
    raise exception 'LEAK: Attacker accessed Org A template in Storage';
  end if;

  if public.can_access_payment_proof_object('payment-proofs', v_org_a::text || '/proof.png') then
    raise exception 'LEAK: Attacker accessed Org A payment proof in Storage';
  end if;
end $$;

rollback;
