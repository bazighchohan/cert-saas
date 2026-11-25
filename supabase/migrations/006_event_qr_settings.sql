-- =============================================================================
-- 006_event_qr_settings.sql — Per-event QR verification stamp settings
--
-- Run AFTER 001..005. Safe to re-run.
--
-- Adds to public.events:
--   show_qr      boolean not null default false
--   qr_position  text    not null default 'bottom-right'
--                        ('bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'custom')
--   qr_x         numeric(8,2) nullable (PDF points from left when qr_position = 'custom')
--   qr_y         numeric(8,2) nullable (PDF points from bottom when qr_position = 'custom')
--   qr_size      numeric(5,2) not null default 54 (QR box width/height in PDF points)
-- =============================================================================

begin;

alter table public.events
  add column if not exists show_qr boolean not null default false,
  add column if not exists qr_position text not null default 'bottom-right'
    check (qr_position in ('bottom-right', 'bottom-left', 'top-right', 'top-left', 'custom')),
  add column if not exists qr_x numeric(8,2)
    check (qr_x is null or (qr_x >= 0 and qr_x <= 10000)),
  add column if not exists qr_y numeric(8,2)
    check (qr_y is null or (qr_y >= 0 and qr_y <= 10000)),
  add column if not exists qr_size numeric(5,2) not null default 54
    check (qr_size >= 28 and qr_size <= 200);

commit;
