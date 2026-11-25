-- =============================================================================
-- 009_atomic_certificate_download.sql — Atomic download_limit enforcement &
-- download_log recording, plus admin reset helper
--
-- Run AFTER 001..008. Safe to re-run.
--
-- Creates public.claim_certificate_download(p_org_id, p_event_id,
-- p_attendee_certificate_id, p_ip_hash), callable ONLY by service_role.
--
-- Uses a single atomic SQL UPDATE ... WHERE (download_limit IS NULL OR
-- download_count < download_limit) RETURNING so two parallel download requests
-- can NEVER both succeed when download_limit = 1.
-- =============================================================================

begin;

create or replace function public.claim_certificate_download(
  p_org_id                  uuid,
  p_event_id                uuid,
  p_attendee_certificate_id uuid,
  p_ip_hash                 text default null
)
returns table (
  claimed            boolean,
  reason             text, -- 'ok' | 'limit_reached' | 'not_released' | 'not_found'
  new_download_count int,
  download_limit     int,
  verify_code        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released       boolean;
  v_limit          int;
  v_claimed_id     uuid;
  v_new_count      int;
  v_verify_code    text;
  v_existing_count int;
begin
  -- 1. Single atomic UPDATE guarded by event.released and download_count < download_limit.
  --    Postgres row-level locking on attendee_certificates guarantees concurrent callers
  --    serialize and re-evaluate the WHERE condition against the latest committed count.
  update public.attendee_certificates ac
     set download_count      = ac.download_count + 1,
         first_downloaded_at = coalesce(ac.first_downloaded_at, now()),
         last_downloaded_at  = now()
    from public.events e
   where ac.id       = p_attendee_certificate_id
     and ac.org_id   = p_org_id
     and ac.event_id = p_event_id
     and e.id        = ac.event_id
     and e.org_id    = p_org_id
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

  -- 2. Determine why the atomic UPDATE matched 0 rows (without modifying any state).
  select e.released, e.download_limit, ac.download_count
    into v_released, v_limit, v_existing_count
    from public.attendee_certificates ac
    join public.events e on e.id = ac.event_id and e.org_id = ac.org_id
   where ac.id       = p_attendee_certificate_id
     and ac.org_id   = p_org_id
     and ac.event_id = p_event_id;

  if v_existing_count is null then
    return query select false, 'not_found'::text, 0, null::int, null::text;
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

commit;
