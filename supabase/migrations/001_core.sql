-- =============================================================================
-- 001_core.sql — multi-tenant core schema for cert-saas
--
-- Run once in a NEW Supabase project (SQL Editor → paste → Run).
-- The whole file runs in a single transaction: it either fully applies or not at all.
--
-- Isolation model (summary — see comments next to each piece):
--   * Every tenant table carries org_id NOT NULL, even child tables, so every
--     query and every RLS policy can filter on org_id directly (no joins).
--   * Composite foreign keys (org_id, parent_id) → parent(org_id, id) make it
--     IMPOSSIBLE for a row to point at a parent in another organization.
--   * RLS is enabled on every table. Writes go through the server only
--     (service role). Signed-in members may only SELECT their own org's rows.
--   * anon (public, not signed in) can read nothing except active plans.
--   * plans is the only global (non-tenant) table.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Generic updated_at trigger.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- plans (GLOBAL — not owned by an organization)
-- Limits: NULL = unlimited.
-- Text ids ('free', 'starter') are stable and readable in app code.
-- -----------------------------------------------------------------------------
create table public.plans (
  id                          text        primary key
                                          check (id ~ '^[a-z0-9_-]{2,32}$'),
  name                        text        not null check (length(btrim(name)) > 0),
  max_events                  int         check (max_events >= 0),
  max_certificates_per_event  int         check (max_certificates_per_event >= 0),
  max_certificates_total      int         check (max_certificates_total >= 0),
  allow_custom_branding       boolean     not null default false,
  price_pkr                   int         not null default 0 check (price_pkr >= 0),
  active                      boolean     not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- organizations (the tenant)
-- -----------------------------------------------------------------------------
create table public.organizations (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null check (length(btrim(name)) between 1 and 200),
  -- Globally unique, URL-safe: lowercase letters, digits, single hyphens.
  slug        text        not null unique
                          check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 63),
  -- RESTRICT: a plan in use cannot be deleted (deactivate it instead).
  plan_id     text        not null references public.plans (id) on delete restrict,
  status      text        not null default 'active' check (status in ('active', 'suspended')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index organizations_plan_id_idx on public.organizations (plan_id);

-- -----------------------------------------------------------------------------
-- organization_members (which auth user may administer which org)
-- The PK (org_id, user_id) is the "unique pair"; a user may belong to many orgs.
-- -----------------------------------------------------------------------------
create table public.organization_members (
  org_id      uuid        not null references public.organizations (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  role        text        not null default 'admin' check (role in ('owner', 'admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- org_id FK is covered by the PK (leading column); user_id needs its own index
-- (used by every RLS check: "which orgs is this user in?").
create index organization_members_user_id_idx on public.organization_members (user_id);

-- -----------------------------------------------------------------------------
-- events
-- -----------------------------------------------------------------------------
create table public.events (
  id                  uuid        primary key default gen_random_uuid(),
  org_id              uuid        not null references public.organizations (id) on delete cascade,
  title               text        not null check (length(btrim(title)) between 1 and 200),
  subtitle            text        check (length(subtitle) <= 300),
  -- Globally unique so the public URL /e/<slug> needs no org prefix.
  slug                text        not null unique
                                  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 80),
  event_date          date,
  contact_email       text        check (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone       text        check (length(contact_phone) <= 40),
  released            boolean     not null default false,
  identifier_label    text        not null default 'Registration number'
                                  check (length(btrim(identifier_label)) between 1 and 60),
  require_name_match  boolean     not null default false,
  -- Max downloads per attendee certificate. NULL = unlimited.
  download_limit      int         default 1 check (download_limit is null or download_limit > 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Target for child composite FKs: lets children prove "same org as my event".
  constraint events_org_id_id_key unique (org_id, id)
);

-- Covers the org_id FK (leading column) and the "list my org's events" query.
create index events_org_id_created_at_idx on public.events (org_id, created_at desc);

-- -----------------------------------------------------------------------------
-- certificate_types (e.g. participation / appreciation) — one template each
-- name_x / name_y / max_name_width are RATIOS of the page (0..1), so the same
-- placement works for PDF and PNG templates of any size. name_y is measured
-- from the TOP of the page (matches the visual editor).
-- -----------------------------------------------------------------------------
create table public.certificate_types (
  id              uuid          primary key default gen_random_uuid(),
  org_id          uuid          not null,
  event_id        uuid          not null,
  key             text          not null check (key ~ '^[a-z0-9_-]{1,40}$'),
  label           text          not null check (length(btrim(label)) between 1 and 80),
  -- Path inside the private Storage bucket. MUST live under the org's folder
  -- ("<org_id>/..."), so a template can never be attached across tenants.
  template_path   text          constraint certificate_types_template_in_org_folder
                                check (template_path is null or template_path like org_id::text || '/%'),
  name_x          numeric(6,5)  not null default 0.5    check (name_x between 0 and 1),
  name_y          numeric(6,5)  not null default 0.5    check (name_y between 0 and 1),
  name_font       text          not null default 'TimesNewRoman-Bold' check (length(name_font) <= 80),
  name_size       numeric(5,2)  not null default 34     check (name_size between 4 and 300),
  name_color      text          not null default '#0B2A4F' check (name_color ~ '^#[0-9A-Fa-f]{6}$'),
  name_align      text          not null default 'center' check (name_align in ('left', 'center', 'right')),
  max_name_width  numeric(6,5)  not null default 0.55   check (max_name_width > 0 and max_name_width <= 1),
  page_index      int           not null default 0      check (page_index >= 0),
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  -- Composite FK: the event must belong to the same org.
  constraint certificate_types_event_fk
    foreign key (org_id, event_id) references public.events (org_id, id) on delete cascade,
  constraint certificate_types_event_id_key_key unique (event_id, key),
  -- Target for attendee_certificates: "this type belongs to this event".
  constraint certificate_types_event_id_id_key unique (event_id, id)
);

create index certificate_types_org_id_event_id_idx on public.certificate_types (org_id, event_id);

-- -----------------------------------------------------------------------------
-- attendees
-- identifier = roll no / employee id / email, labelled per event by
-- events.identifier_label. The app stores it trimmed (and normalised).
-- -----------------------------------------------------------------------------
create table public.attendees (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null,
  event_id    uuid        not null,
  identifier  text        not null check (identifier = btrim(identifier) and length(identifier) between 1 and 100),
  full_name   text        not null check (length(btrim(full_name)) between 1 and 200),
  email       text        check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  source      text        not null default 'csv' check (source in ('csv', 'manual')),
  note        text        check (length(note) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint attendees_event_fk
    foreign key (org_id, event_id) references public.events (org_id, id) on delete cascade,
  -- Also serves as the (event_id, identifier) lookup index for public downloads.
  constraint attendees_event_id_identifier_key unique (event_id, identifier),
  -- Target for attendee_certificates: "this attendee belongs to this event".
  constraint attendees_event_id_id_key unique (event_id, id)
);

create index attendees_org_id_event_id_idx on public.attendees (org_id, event_id);

-- -----------------------------------------------------------------------------
-- attendee_certificates — one row per (attendee, certificate type) they earned
-- event_id is stored so BOTH composite FKs below can require that the attendee
-- and the certificate type belong to the SAME event (and therefore same org).
-- -----------------------------------------------------------------------------
create table public.attendee_certificates (
  id                    uuid        primary key default gen_random_uuid(),
  org_id                uuid        not null,
  event_id              uuid        not null,
  attendee_id           uuid        not null,
  certificate_type_id   uuid        not null,
  download_count        int         not null default 0 check (download_count >= 0),
  first_downloaded_at   timestamptz,
  last_downloaded_at    timestamptz,
  -- Public verification code printed on the certificate. Random (UUIDv4-based,
  -- 48 bits), not derived from any id, so it cannot be guessed or enumerated.
  verify_code           text        not null unique
                                    default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
                                    check (verify_code ~ '^[A-Z0-9]{8,32}$'),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint attendee_certificates_event_fk
    foreign key (org_id, event_id) references public.events (org_id, id) on delete cascade,
  constraint attendee_certificates_attendee_fk
    foreign key (event_id, attendee_id) references public.attendees (event_id, id) on delete cascade,
  constraint attendee_certificates_type_fk
    foreign key (event_id, certificate_type_id) references public.certificate_types (event_id, id) on delete cascade,
  constraint attendee_certificates_attendee_type_key unique (attendee_id, certificate_type_id),
  -- Target for download_log.
  constraint attendee_certificates_org_id_id_key unique (org_id, id),
  constraint attendee_certificates_download_dates_chk
    check (first_downloaded_at is null or last_downloaded_at >= first_downloaded_at)
);

create index attendee_certificates_org_id_event_id_idx on public.attendee_certificates (org_id, event_id);
create index attendee_certificates_event_id_attendee_id_idx on public.attendee_certificates (event_id, attendee_id);
create index attendee_certificates_event_id_type_id_idx on public.attendee_certificates (event_id, certificate_type_id);

-- -----------------------------------------------------------------------------
-- download_log (append-only)
-- ip_hash = HMAC/SHA-256 of the IP with a server secret — raw IPs are never stored.
-- -----------------------------------------------------------------------------
create table public.download_log (
  id                       bigint      generated always as identity primary key,
  org_id                   uuid        not null,
  attendee_certificate_id  uuid        not null,
  downloaded_at            timestamptz not null default now(),
  ip_hash                  text        check (length(ip_hash) <= 128),
  constraint download_log_attendee_certificate_fk
    foreign key (org_id, attendee_certificate_id)
    references public.attendee_certificates (org_id, id) on delete cascade
);

create index download_log_org_id_cert_id_idx
  on public.download_log (org_id, attendee_certificate_id, downloaded_at desc);

-- -----------------------------------------------------------------------------
-- audit_log (append-only) — admin actions per organization
-- user_id SET NULL: deleting a user keeps the org's history.
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id          bigint      generated always as identity primary key,
  org_id      uuid        not null references public.organizations (id) on delete cascade,
  user_id     uuid        references auth.users (id) on delete set null,
  action      text        not null check (action ~ '^[a-z0-9_.:-]{1,80}$'),
  details     jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_org_id_created_at_idx on public.audit_log (org_id, created_at desc);
create index audit_log_user_id_idx on public.audit_log (user_id);

-- -----------------------------------------------------------------------------
-- updated_at triggers (logs are append-only, so they have none)
-- -----------------------------------------------------------------------------
create trigger set_updated_at before update on public.plans
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.organization_members
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.events
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.certificate_types
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.attendees
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.attendee_certificates
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Membership check used by RLS.
-- SECURITY DEFINER so the policy on organization_members does not recurse
-- into itself; empty search_path + fully-qualified names prevent hijacking.
-- Only answers for the CURRENT user (auth.uid()), so it leaks nothing.
-- -----------------------------------------------------------------------------
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_members m
     where m.org_id = p_org_id
       and m.user_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
grant  execute on function public.is_org_member(uuid) to authenticated, service_role;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
--  * service_role (server code only) bypasses RLS and does all writes.
--  * authenticated: SELECT only, and only rows of orgs they are a member of.
--  * anon: nothing, except reading active plans (pricing page).
--  Table privileges are revoked too, so even a future mistaken policy cannot
--  grant browser clients INSERT/UPDATE/DELETE.
-- -----------------------------------------------------------------------------
alter table public.plans                  enable row level security;
alter table public.organizations          enable row level security;
alter table public.organization_members   enable row level security;
alter table public.events                 enable row level security;
alter table public.certificate_types      enable row level security;
alter table public.attendees              enable row level security;
alter table public.attendee_certificates  enable row level security;
alter table public.download_log           enable row level security;
alter table public.audit_log              enable row level security;

revoke all on
  public.plans, public.organizations, public.organization_members, public.events,
  public.certificate_types, public.attendees, public.attendee_certificates,
  public.download_log, public.audit_log
from anon, authenticated;

grant select on
  public.plans, public.organizations, public.organization_members, public.events,
  public.certificate_types, public.attendees, public.attendee_certificates,
  public.download_log, public.audit_log
to authenticated;

grant select on public.plans to anon;

grant all on
  public.plans, public.organizations, public.organization_members, public.events,
  public.certificate_types, public.attendees, public.attendee_certificates,
  public.download_log, public.audit_log
to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy plans_read_active on public.plans
  for select to anon, authenticated
  using (active);

create policy organizations_member_read on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

create policy organization_members_member_read on public.organization_members
  for select to authenticated
  using (public.is_org_member(org_id));

create policy events_member_read on public.events
  for select to authenticated
  using (public.is_org_member(org_id));

create policy certificate_types_member_read on public.certificate_types
  for select to authenticated
  using (public.is_org_member(org_id));

create policy attendees_member_read on public.attendees
  for select to authenticated
  using (public.is_org_member(org_id));

create policy attendee_certificates_member_read on public.attendee_certificates
  for select to authenticated
  using (public.is_org_member(org_id));

create policy download_log_member_read on public.download_log
  for select to authenticated
  using (public.is_org_member(org_id));

create policy audit_log_member_read on public.audit_log
  for select to authenticated
  using (public.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- Seed: plans only. NULL limit = unlimited. Starter numbers/price are
-- placeholders — change them here or later with an UPDATE.
-- -----------------------------------------------------------------------------
insert into public.plans
  (id, name, max_events, max_certificates_per_event, max_certificates_total, allow_custom_branding, price_pkr, active)
values
  ('free',    'Free',    1,  50,  50,   false, 0,    true),
  ('starter', 'Starter', 10, 500, 5000, true,  2999, true)
on conflict (id) do nothing;

commit;
