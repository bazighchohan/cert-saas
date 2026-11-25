-- =============================================================================
-- 010_attendee_issue_note.sql — Dedicated "Issues" / name-correction note field
-- on attendees + index on download_log(org_id, downloaded_at) for daily charts
--
-- Run AFTER 001..009. Safe to re-run.
-- =============================================================================

begin;

alter table public.attendees
  add column if not exists issue_note text
  check (issue_note is null or length(issue_note) <= 1000);

create index if not exists download_log_org_id_downloaded_at_idx
  on public.download_log (org_id, downloaded_at desc);

commit;
