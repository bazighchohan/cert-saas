-- =============================================================================
-- 003_auth_signup.sql — Transactional organization provisioning on signup
--
-- Run AFTER 001_core.sql and 002_rls.sql. Safe to re-run.
--
-- Creates public.create_organization_for_user(p_user_id, p_org_name), callable
-- ONLY by service_role (server code). In a single Postgres transaction it:
--   1. Returns the user's existing organization if one was already provisioned
--      (idempotent across immediate signup + email-confirmation callback).
--   2. Generates a unique, URL-safe slug from p_org_name.
--   3. Inserts the organization on the 'free' plan.
--   4. Inserts the organization_members row with role = 'owner'.
--   5. Records 'org.created' in audit_log.
-- =============================================================================

begin;

create or replace function public.create_organization_for_user(
  p_user_id  uuid,
  p_org_name text
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
  v_clean_name    text;
  v_existing_name text;
  v_base_slug     text;
  v_slug          text;
  v_org_id        uuid;
  v_plan_id       text := 'free';
  v_role          text := 'owner';
  v_attempt       int  := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  v_clean_name := btrim(coalesce(p_org_name, ''));
  if length(v_clean_name) < 2 or length(v_clean_name) > 200 then
    raise exception 'Organization name must be between 2 and 200 characters';
  end if;

  -- Serialize concurrent provisioning calls for the same user.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- 1. Idempotency: if this user already belongs to an org, return it.
  select o.id, o.name, o.slug, o.plan_id, m.role
    into v_org_id, v_existing_name, v_slug, v_plan_id, v_role
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
   where m.user_id = p_user_id
   order by m.created_at asc
   limit 1;

  if v_org_id is not null then
    return query select v_org_id, v_existing_name, v_slug, v_plan_id, v_role;
    return;
  end if;

  -- 2. Slugify: lowercase alphanumeric + single hyphens, 2..55 chars base.
  v_base_slug := lower(regexp_replace(v_clean_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := regexp_replace(v_base_slug, '(^-+|-+$)', '', 'g');
  v_base_slug := substr(v_base_slug, 1, 50);
  v_base_slug := regexp_replace(v_base_slug, '-+$', '', 'g');
  if length(v_base_slug) < 2 then
    v_base_slug := 'org-' || substr(replace(p_user_id::text, '-', ''), 1, 8);
  end if;

  v_slug := v_base_slug;

  -- 3. Insert organization (retry with short suffix on slug collision).
  loop
    v_attempt := v_attempt + 1;
    begin
      insert into public.organizations (name, slug, plan_id, status)
      values (v_clean_name, v_slug, 'free', 'active')
      returning id into v_org_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 8 then
        raise exception 'Could not allocate a unique organization slug';
      end if;
      v_slug := v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end;
  end loop;

  -- 4. Insert owner membership.
  insert into public.organization_members (org_id, user_id, role)
  values (v_org_id, p_user_id, 'owner');

  -- 5. Audit log entry.
  insert into public.audit_log (org_id, user_id, action, details)
  values (
    v_org_id,
    p_user_id,
    'org.created',
    jsonb_build_object('name', v_clean_name, 'slug', v_slug, 'plan_id', 'free')
  );

  return query select v_org_id, v_clean_name, v_slug, 'free'::text, 'owner'::text;
end;
$$;

revoke execute on function public.create_organization_for_user(uuid, text) from public, anon, authenticated;
grant  execute on function public.create_organization_for_user(uuid, text) to service_role;

commit;
