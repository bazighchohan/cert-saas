-- =============================================================================
-- 004_storage_templates.sql — Private "templates" bucket, storage RLS policies,
-- template dimensions in points, and per-event certificate type plan limits
--
-- Run AFTER 001_core.sql, 002_rls.sql, and 003_auth_signup.sql. Safe to re-run.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. plans: add max_certificate_types_per_event (NULL = unlimited)
-- -----------------------------------------------------------------------------
alter table public.plans
  add column if not exists max_certificate_types_per_event int
  check (max_certificate_types_per_event is null or max_certificate_types_per_event >= 1);

-- Free plan allows up to 3 certificate types per event (e.g. Participation,
-- Appreciation, Winner); Starter allows up to 10.
update public.plans
   set max_certificate_types_per_event = 3
 where id = 'free'
   and max_certificate_types_per_event is null;

update public.plans
   set max_certificate_types_per_event = 10
 where id = 'starter'
   and max_certificate_types_per_event is null;

-- -----------------------------------------------------------------------------
-- 2. certificate_types: store MIME type, page count, and page width/height in points
--    and tighten template_path check to require {org_id}/{event_id}/...
-- -----------------------------------------------------------------------------
alter table public.certificate_types
  add column if not exists template_mime  text
    check (template_mime is null or template_mime in ('application/pdf', 'image/png', 'image/jpeg')),
  add column if not exists page_width_pt  numeric(8,2)
    check (page_width_pt is null or page_width_pt > 0),
  add column if not exists page_height_pt numeric(8,2)
    check (page_height_pt is null or page_height_pt > 0),
  add column if not exists page_count     int not null default 1
    check (page_count >= 1);

alter table public.certificate_types
  drop constraint if exists certificate_types_template_in_org_folder;

alter table public.certificate_types
  drop constraint if exists certificate_types_template_in_event_folder;

alter table public.certificate_types
  add constraint certificate_types_template_in_event_folder
  check (
    template_path is null
    or template_path like (org_id::text || '/' || event_id::text || '/%')
  );

-- -----------------------------------------------------------------------------
-- 3. Storage helper: verifies an object path in the "templates" bucket is
--    "{org_id}/{event_id}/{filename}" and that the current user is a member of
--    that org and the event belongs to that org.
-- -----------------------------------------------------------------------------
create or replace function public.can_access_template_object(
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
  v_parts    text[];
  v_org_id   uuid;
  v_event_id uuid;
begin
  if p_bucket_id is distinct from 'templates' or p_name is null then
    return false;
  end if;

  -- Reject path traversal tricks.
  if position('..' in p_name) > 0 or left(p_name, 1) = '/' then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) < 3 then
    return false;
  end if;

  if length(btrim(v_parts[3])) = 0 then
    return false;
  end if;

  begin
    v_org_id   := v_parts[1]::uuid;
    v_event_id := v_parts[2]::uuid;
  exception when others then
    return false;
  end;

  -- User must be a member of v_org_id AND v_event_id must belong to v_org_id.
  return public.is_org_member(v_org_id)
     and public.event_org_id(v_event_id) = v_org_id;
end;
$$;

revoke execute on function public.can_access_template_object(text, text) from public, anon;
grant  execute on function public.can_access_template_object(text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Private Supabase Storage bucket "templates" & storage.objects RLS policies
--    (Guarded so the migration also succeeds in local test DBs without storage schema)
-- -----------------------------------------------------------------------------
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
      'templates',
      'templates',
      false,
      5242880, -- 5 MB
      array['application/pdf', 'image/png', 'image/jpeg']
    )
    on conflict (id) do update
      set public             = false,
          file_size_limit    = 5242880,
          allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg'];
  end if;

  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'storage'
       and table_name   = 'objects'
  ) then
    drop policy if exists templates_org_member_select on storage.objects;
    drop policy if exists templates_org_member_insert on storage.objects;
    drop policy if exists templates_org_member_update on storage.objects;
    drop policy if exists templates_org_member_delete on storage.objects;

    execute $p$
      create policy templates_org_member_select on storage.objects
        for select to authenticated
        using (public.can_access_template_object(bucket_id, name))
    $p$;

    execute $p$
      create policy templates_org_member_insert on storage.objects
        for insert to authenticated
        with check (public.can_access_template_object(bucket_id, name))
    $p$;

    execute $p$
      create policy templates_org_member_update on storage.objects
        for update to authenticated
        using (public.can_access_template_object(bucket_id, name))
        with check (public.can_access_template_object(bucket_id, name))
    $p$;

    execute $p$
      create policy templates_org_member_delete on storage.objects
        for delete to authenticated
        using (public.can_access_template_object(bucket_id, name))
    $p$;
  end if;
end $$;

commit;
