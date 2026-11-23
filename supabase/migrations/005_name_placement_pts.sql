-- =============================================================================
-- 005_name_placement_pts.sql — Store name box coordinates and max width in
-- PDF points (origin bottom-left, matching pdf-lib) and add name_bold flag.
--
-- Run AFTER 001..004. Safe to re-run.
-- =============================================================================

begin;

-- 1. Drop the 0..1 ratio check constraints from 001_core.sql so name_x, name_y,
--    and max_name_width can store PDF points (e.g. name_x = 421.88, name_y = 265,
--    max_name_width = 464).
alter table public.certificate_types
  drop constraint if exists certificate_types_name_x_check,
  drop constraint if exists certificate_types_name_y_check,
  drop constraint if exists certificate_types_max_name_width_check;

-- 2. Widen numeric precision from numeric(6,5) to numeric(8,2) for PDF points.
alter table public.certificate_types
  alter column name_x         type numeric(8,2) using round(name_x::numeric, 2),
  alter column name_y         type numeric(8,2) using round(name_y::numeric, 2),
  alter column max_name_width type numeric(8,2) using round(max_name_width::numeric, 2);

-- 3. Convert any legacy 0..1 ratio rows to PDF points using page_width_pt / page_height_pt
--    (or standard 843.75 x 597.75 pt landscape defaults).
update public.certificate_types
   set name_x = round((coalesce(page_width_pt, 843.75) * name_x)::numeric, 2)
 where name_x <= 1;

update public.certificate_types
   set name_y = round((coalesce(page_height_pt, 597.75) * (1 - name_y))::numeric, 2)
 where name_y <= 1;

update public.certificate_types
   set max_name_width = round((coalesce(page_width_pt, 843.75) * max_name_width)::numeric, 2)
 where max_name_width <= 1;

-- 4. Set defaults in PDF points (centered on an 843.75 x 597.75 pt landscape page)
--    and add non-negative point constraints.
alter table public.certificate_types
  alter column name_x         set default 421.88,
  alter column name_y         set default 265.00,
  alter column max_name_width set default 464.00;

alter table public.certificate_types
  add constraint certificate_types_name_x_pts_check
    check (name_x >= 0 and name_x <= 10000),
  add constraint certificate_types_name_y_pts_check
    check (name_y >= 0 and name_y <= 10000),
  add constraint certificate_types_max_name_width_pts_check
    check (max_name_width >= 10 and max_name_width <= 10000);

-- 5. Add name_bold boolean column.
alter table public.certificate_types
  add column if not exists name_bold boolean not null default true;

commit;
