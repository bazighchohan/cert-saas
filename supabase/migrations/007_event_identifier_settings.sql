-- =============================================================================
-- 007_event_identifier_settings.sql — Per-event identifier normalization &
-- search/sort indexes for 500+ attendee management
--
-- Run AFTER 001..006. Safe to re-run.
-- =============================================================================

begin;

-- 1. Optional uppercase normalization per event (true by default for Roll numbers /
--    Registration IDs; can be toggled off when using case-sensitive IDs or emails).
alter table public.events
  add column if not exists uppercase_identifiers boolean not null default true;

-- 2. Indexes to keep server-side sorting & pagination fast at 500 - 50,000+ rows.
create index if not exists attendees_event_id_created_at_idx
  on public.attendees (event_id, created_at desc);

create index if not exists attendees_event_id_full_name_idx
  on public.attendees (event_id, full_name);

create index if not exists attendees_event_id_source_idx
  on public.attendees (event_id, source);

-- Enforce case-insensitive uniqueness of identifier within an event as defence in depth
create unique index if not exists attendees_event_id_lower_identifier_uidx
  on public.attendees (event_id, lower(identifier));

commit;
