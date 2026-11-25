-- =============================================================================
-- 008_bulk_import_attendees.sql — Transactional batched CSV/XLSX attendee import
--
-- Run AFTER 001..007. Safe to re-run.
--
-- Creates public.bulk_import_event_attendees(p_org_id, p_user_id, p_event_id,
-- p_mode, p_rows) callable ONLY by service_role.
-- Inserts/updates up to 5,000 rows in batches of 500 inside ONE transaction,
-- enforces max_certificates_per_event and max_certificates_total atomically,
-- and logs 'attendee.csv_imported' to audit_log.
-- =============================================================================

begin;

create or replace function public.bulk_import_event_attendees(
  p_org_id   uuid,
  p_user_id  uuid,
  p_event_id uuid,
  p_mode     text, -- 'skip' | 'update'
  p_rows     jsonb
)
returns table (
  inserted_count             int,
  updated_count              int,
  skipped_count              int,
  certificates_created_count int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_id         text;
  v_plan_name       text;
  v_max_per_event   int;
  v_max_total       int;
  v_total_rows      int;
  v_batch_size      constant int := 500;
  v_offset          int;
  v_batch           jsonb;
  v_inserted        int := 0;
  v_updated         int := 0;
  v_skipped         int := 0;
  v_certs_created   int := 0;
  v_batch_ins       int;
  v_batch_upd       int;
  v_batch_skp       int;
  v_batch_certs     int;
  v_event_certs_now int;
  v_org_certs_now   int;
  v_event_att_now   int;
begin
  if p_mode not in ('skip', 'update') then
    raise exception 'Invalid import mode "%" (expected skip or update)', p_mode;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  v_total_rows := jsonb_array_length(p_rows);
  if v_total_rows = 0 then
    return query select 0, 0, 0, 0;
    return;
  end if;

  if v_total_rows > 5000 then
    raise exception 'Import exceeds maximum of 5,000 rows per upload (% rows supplied)', v_total_rows;
  end if;

  -- Serialize concurrent imports on this org/event
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_event_id::text, 0));

  -- Verify event belongs to p_org_id and load plan limits
  select o.plan_id, p.name, p.max_certificates_per_event, p.max_certificates_total
    into v_plan_id, v_plan_name, v_max_per_event, v_max_total
    from public.events e
    join public.organizations o on o.id = e.org_id
    left join public.plans p on p.id = o.plan_id
   where e.id = p_event_id
     and e.org_id = p_org_id;

  if v_plan_id is null then
    raise exception 'Event not found for organization';
  end if;

  -- Process incoming rows in batches of 500 inside this transaction
  for v_offset in 0 .. (v_total_rows - 1) by v_batch_size loop
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_batch
      from (
        select elem
          from jsonb_array_elements(p_rows) with ordinality as t(elem, ord)
         where t.ord > v_offset
           and t.ord <= v_offset + v_batch_size
      ) sub;

    if p_mode = 'skip' then
      -- Count rows in this batch that already exist (case-insensitive)
      select count(*)::int
        into v_batch_skp
        from jsonb_array_elements(v_batch) as b
       where exists (
         select 1
           from public.attendees a
          where a.org_id = p_org_id
            and a.event_id = p_event_id
            and lower(a.identifier) = lower(b->>'identifier')
       );

      with new_rows as (
        select
          (b->>'identifier')::text as identifier,
          (b->>'full_name')::text  as full_name,
          nullif(b->>'email', '')::text as email,
          nullif(b->>'note', '')::text  as note,
          coalesce(b->'type_ids', '[]'::jsonb) as type_ids
        from jsonb_array_elements(v_batch) as b
        where not exists (
          select 1
            from public.attendees a
           where a.org_id = p_org_id
             and a.event_id = p_event_id
             and lower(a.identifier) = lower(b->>'identifier')
        )
      ),
      ins_att as (
        insert into public.attendees (org_id, event_id, identifier, full_name, email, note, source)
        select p_org_id, p_event_id, nr.identifier, nr.full_name, nr.email, nr.note, 'csv'
          from new_rows nr
        on conflict do nothing
        returning id, identifier
      ),
      ins_certs as (
        insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id)
        select
          p_org_id,
          p_event_id,
          ia.id,
          ct.id
        from ins_att ia
        join new_rows nr on lower(nr.identifier) = lower(ia.identifier)
        cross join lateral jsonb_array_elements_text(nr.type_ids) as tid(val)
        join public.certificate_types ct
          on ct.id = tid.val::uuid
         and ct.org_id = p_org_id
         and ct.event_id = p_event_id
        on conflict (attendee_id, certificate_type_id) do nothing
        returning 1
      )
      select (select count(*)::int from ins_att),
             (select count(*)::int from ins_certs)
        into v_batch_ins, v_batch_certs;

      v_inserted      := v_inserted + v_batch_ins;
      v_skipped       := v_skipped + v_batch_skp;
      v_certs_created := v_certs_created + v_batch_certs;

    else
      -- p_mode = 'update': update existing names (+ non-empty email/note) and insert new rows
      with incoming as (
        select
          (b->>'identifier')::text as identifier,
          (b->>'full_name')::text  as full_name,
          nullif(b->>'email', '')::text as email,
          nullif(b->>'note', '')::text  as note,
          coalesce(b->'type_ids', '[]'::jsonb) as type_ids
        from jsonb_array_elements(v_batch) as b
      ),
      upd_att as (
        update public.attendees a
           set full_name = inc.full_name,
               email     = coalesce(inc.email, a.email),
               note      = coalesce(inc.note, a.note)
          from incoming inc
         where a.org_id = p_org_id
           and a.event_id = p_event_id
           and lower(a.identifier) = lower(inc.identifier)
        returning a.id, a.identifier
      ),
      ins_att as (
        insert into public.attendees (org_id, event_id, identifier, full_name, email, note, source)
        select p_org_id, p_event_id, inc.identifier, inc.full_name, inc.email, inc.note, 'csv'
          from incoming inc
         where not exists (
           select 1
             from public.attendees a
            where a.org_id = p_org_id
              and a.event_id = p_event_id
              and lower(a.identifier) = lower(inc.identifier)
         )
        on conflict do nothing
        returning id, identifier
      ),
      all_touched as (
        select id, identifier from upd_att
        union all
        select id, identifier from ins_att
      ),
      ins_certs as (
        insert into public.attendee_certificates (org_id, event_id, attendee_id, certificate_type_id)
        select
          p_org_id,
          p_event_id,
          at_row.id,
          ct.id
        from all_touched at_row
        join incoming inc on lower(inc.identifier) = lower(at_row.identifier)
        cross join lateral jsonb_array_elements_text(inc.type_ids) as tid(val)
        join public.certificate_types ct
          on ct.id = tid.val::uuid
         and ct.org_id = p_org_id
         and ct.event_id = p_event_id
        on conflict (attendee_id, certificate_type_id) do nothing
        returning 1
      )
      select (select count(*)::int from ins_att),
             (select count(*)::int from upd_att),
             (select count(*)::int from ins_certs)
        into v_batch_ins, v_batch_upd, v_batch_certs;

      v_inserted      := v_inserted + v_batch_ins;
      v_updated       := v_updated + v_batch_upd;
      v_certs_created := v_certs_created + v_batch_certs;
    end if;
  end loop;

  -- Atomic post-batch plan quota verification (rolls back entire transaction if exceeded)
  select count(*)::int into v_event_certs_now
    from public.attendee_certificates
   where org_id = p_org_id and event_id = p_event_id;

  select count(*)::int into v_org_certs_now
    from public.attendee_certificates
   where org_id = p_org_id;

  select count(*)::int into v_event_att_now
    from public.attendees
   where org_id = p_org_id and event_id = p_event_id;

  if v_max_per_event is not null and v_event_certs_now > v_max_per_event then
    raise exception 'Plan limit exceeded: importing would bring this event to % certificates (limit is % on % plan).',
      v_event_certs_now, v_max_per_event, coalesce(v_plan_name, v_plan_id);
  end if;

  if v_max_per_event is not null and v_event_att_now > v_max_per_event then
    raise exception 'Plan limit exceeded: importing would bring this event to % attendees (limit is % on % plan).',
      v_event_att_now, v_max_per_event, coalesce(v_plan_name, v_plan_id);
  end if;

  if v_max_total is not null and v_org_certs_now > v_max_total then
    raise exception 'Plan limit exceeded: importing would bring your organization to % total certificates (limit is % on % plan).',
      v_org_certs_now, v_max_total, coalesce(v_plan_name, v_plan_id);
  end if;

  -- Audit log entry
  insert into public.audit_log (org_id, user_id, action, details)
  values (
    p_org_id,
    p_user_id,
    'attendee.csv_imported',
    jsonb_build_object(
      'event_id', p_event_id,
      'mode', p_mode,
      'inserted_count', v_inserted,
      'updated_count', v_updated,
      'skipped_count', v_skipped,
      'certificates_created_count', v_certs_created
    )
  );

  return query select v_inserted, v_updated, v_skipped, v_certs_created;
end;
$$;

revoke execute on function public.bulk_import_event_attendees(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function public.bulk_import_event_attendees(uuid, uuid, uuid, text, jsonb) to service_role;

commit;
