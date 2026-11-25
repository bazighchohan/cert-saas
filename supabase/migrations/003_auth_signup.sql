-- =============================================================================
-- 003_auth_signup.sql — Transactional, idempotent organization provisioning
--
-- Run AFTER 001_core.sql and 002_rls.sql in Supabase SQL Editor. Safe to re-run.
--
-- Creates public.create_organization_for_user(p_user_id, p_org_name), callable
-- ONLY by service_role (server code). In a single Postgres transaction it:
--   1. Serializes concurrent calls for the same user via pg_advisory_xact_lock
--      (so double-clicking Signup or concurrent requests never create two orgs).
--   2. Returns the user's existing organization if they already have a membership
--      (idempotent across signup, email-confirmation callback, and login).
--   3. Resolves the organization name in priority order, NEVER null or empty:
--        a) explicit p_org_name argument
--        b) auth.users.raw_user_meta_data->>'organization_name' (or 'org_name')
--        c) email prefix before '@' from auth.users.email, cleaned & title-cased
--        d) 'My Organization'
--   4. Generates a unique URL-safe slug from the resolved name (appending a
--      short 6-char random suffix on collision).
--   5. Inserts the organization (on the 'free' plan), owner membership, and
--      audit_log entry atomically in one transaction.
-- =============================================================================

begin;

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

  -- 1. Serialize concurrent provisioning calls for the same user in this transaction.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- 2. Idempotency: if this user already has a membership, do nothing and return it.
  --    Uses separate v_existing_* variables so v_clean_name is NEVER nulled out
  --    when no row is found.
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

  -- 3. Read user_metadata and email from auth.users as fallbacks if p_org_name is blank.
  begin
    execute
      'select coalesce(raw_user_meta_data->>''organization_name'', raw_user_meta_data->>''org_name''), email
         from auth.users
        where id = $1'
      into v_meta_org_name, v_user_email
      using p_user_id;
  exception when undefined_column then
    -- Minimal test stub auth.users without raw_user_meta_data/email columns
    v_meta_org_name := null;
    v_user_email    := null;
  end;

  -- Priority 1: explicit p_org_name
  v_clean_name := nullif(btrim(coalesce(p_org_name, '')), '');

  -- Priority 2: user_metadata.organization_name (or org_name)
  if v_clean_name is null then
    v_clean_name := nullif(btrim(coalesce(v_meta_org_name, '')), '');
  end if;

  -- Priority 3: derived from email local-part before '@', cleaned and title-cased
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

  -- Priority 4: 'My Organization' (guaranteed non-null, >= 2 chars)
  if v_clean_name is null or length(v_clean_name) < 2 then
    v_clean_name := 'My Organization';
  end if;

  v_clean_name := left(v_clean_name, 200);

  -- 4. Slugify: lowercase alphanumeric + single hyphens, 2..50 chars base.
  v_base_slug := lower(regexp_replace(v_clean_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := regexp_replace(v_base_slug, '(^-+|-+$)', '', 'g');
  v_base_slug := substr(v_base_slug, 1, 50);
  v_base_slug := regexp_replace(v_base_slug, '-+$', '', 'g');
  if length(v_base_slug) < 2 then
    v_base_slug := 'org-' || substr(replace(p_user_id::text, '-', ''), 1, 8);
  end if;

  v_slug := v_base_slug;

  -- 5. Ensure 'free' plan row exists before inserting organization.
  insert into public.plans (id, name, max_events, max_certificates_per_event, max_certificates_total, allow_custom_branding, price_pkr, active)
  values ('free', 'Free', 1, 50, 50, false, 0, true)
  on conflict (id) do nothing;

  -- 6. Insert organization (retry with short 6-char random suffix on slug collision).
  loop
    v_attempt := v_attempt + 1;
    begin
      insert into public.organizations (name, slug, plan_id, status)
      values (v_clean_name, v_slug, 'free', 'active')
      returning id into v_new_org_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise exception 'Could not allocate a unique organization slug for "%"', v_clean_name;
      end if;
      v_slug := v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end;
  end loop;

  -- 7. Insert owner membership.
  insert into public.organization_members (org_id, user_id, role)
  values (v_new_org_id, p_user_id, 'owner');

  -- 8. Audit log entry.
  insert into public.audit_log (org_id, user_id, action, details)
  values (
    v_new_org_id,
    p_user_id,
    'org.created',
    jsonb_build_object('name', v_clean_name, 'slug', v_slug, 'plan_id', 'free')
  );

  return query select v_new_org_id, v_clean_name, v_slug, 'free'::text, 'owner'::text;
end;
$$;

revoke execute on function public.create_organization_for_user(uuid, text) from public, anon, authenticated;
grant  execute on function public.create_organization_for_user(uuid, text) to service_role;

commit;
