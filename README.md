# cert-saas

Multi-tenant e-certificate platform. Societies, universities and companies issue
certificates online instead of printing them.

Each **organization** signs up and gets its own admin dashboard. Admins create **events**,
upload their own certificate **template** (PDF/PNG), place the name box visually, and add
**attendees** (CSV or manually). Attendees download their certificate from a public event
page, and admins see who has / hasn't downloaded.

> Status: early SaaS conversion of a working single-event seminar app. See the phases below.

## Stack

- **Next.js 16** (App Router, `src/proxy.ts` instead of middleware) + React 19 + TypeScript
- **Tailwind CSS 4**
- **Supabase** Postgres (+ Auth and Storage in later phases)
- **pdf-lib** + `@pdf-lib/fontkit` for certificate rendering, **papaparse** for CSV
- Deployed on **Vercel**

Read [`AGENTS.md`](./AGENTS.md) before changing code: this Next.js version has breaking changes.

## Rules

- Every table row belongs to an organization; every query is scoped by `org_id`.
- `SUPABASE_SERVICE_ROLE_KEY` is used **only** in server code (`import "server-only"`),
  never in Client Components and never with a `NEXT_PUBLIC_` prefix.
- Secrets live in env vars only. Real attendee data, signed templates and screenshots
  with personal data are git-ignored and never committed.

## Local setup

```bash
# 1. Install
npm install

# 2. Env vars
cp .env.example .env.local      # Windows PowerShell: Copy-Item .env.example .env.local
# fill in values from YOUR new Supabase project (see "Infrastructure setup")

# 3. Database: open Supabase → SQL Editor → paste and run in order:
#    supabase/migrations/001_core.sql
#    supabase/migrations/002_rls.sql
#    supabase/migrations/003_auth_signup.sql
#    supabase/migrations/004_storage_templates.sql
#    supabase/migrations/005_name_placement_pts.sql
#    supabase/migrations/006_event_qr_settings.sql
#    supabase/migrations/007_event_identifier_settings.sql
#    supabase/migrations/008_bulk_import_attendees.sql
#    supabase/migrations/009_atomic_certificate_download.sql
#    supabase/migrations/010_attendee_issue_note.sql
#    supabase/migrations/011_billing_and_plan_enforcement.sql
#    supabase/migrations/012_super_admins.sql
#    (NOT the legacy schema.sql — the old single-event code is ported in the next phases)

# 4. Run
npm run dev                     # http://localhost:3000, dashboard at /dashboard (login at /login, signup at /signup)
npm test                        # run unit tests (certificate generator, auto-shrink, diacritics, QR, caching)
npm run build                   # production build check
npm run lint
```

The bundled template is a **blank sample** (`public/samples/blank-template.pdf`).
Real templates are uploaded per organization (phase 4).

## Project layout

```
src/app/            pages + route handlers (admin UI under /admin, APIs under /api)
src/lib/            certificate.ts (PDF render), csv-parser.ts, rate-limit.ts,
                    session.ts, supabase.ts (server-only admin client), config.ts
src/proxy.ts        protects /admin and /api/admin
public/samples/     blank sample template
public/fonts/       fonts embedded in certificates
schema.sql          LEGACY single-event schema (reference only, do not run in the new project)
supabase/migrations numbered SQL migrations — run in order in the Supabase SQL Editor
```

## Phases

- [x] **0. Repo prep** — secrets/real data untracked, `.env.example`, blank sample template, README
- [ ] **1. Multi-tenant schema** — `organizations`, `org_members`, `events`, attendees scoped by `org_id` + `event_id`
  - [x] SQL: `supabase/migrations/001_core.sql` + `002_rls.sql` (tested in `supabase/tests/isolation.sql`)
  - [ ] Port data-access code to the new tables
- [x] **2. Auth** — Supabase Auth (`@supabase/ssr`) sign-up/login/logout/forgot-password/reset-password, org + owner membership + Free plan created in one transaction (`003_auth_signup.sql`), `getCurrentUser()` & `getCurrentOrg()` server helpers (replaces `ADMIN_PASSWORD`)
- [x] **3. Events & Attendees** — create/edit/release/delete events; paginated/searchable/sortable Attendees tab (50/page) + arbitrary CSV/XLSX import wizard up to 5,000 rows (`007_event_identifier_settings.sql`, `008_bulk_import_attendees.sql`)
- [x] **4. Templates** — upload PDF/PNG/JPG to private Storage (`004_storage_templates.sql`), visual click-to-place name-box editor (`005_name_placement_pts.sql`, `pdfjs-dist` canvas, curated TTF fonts including script & Urdu/Arabic, test PDF generator)
- [x] **5. Public event page** — `/e/[slug]` student lookup & download flow, preview cards, IP + identifier rate limiting, atomic `download_limit` enforcement (`009_atomic_certificate_download.sql`), and admin Reset Download action
- [x] **6. Admin tracking** — Downloads tab with KPI summary cards, Recharts daily downloads chart, filterable downloaded / not-downloaded / per-type table, CSV & Excel (`.xlsx`) exports, pending-email copy, per-attendee `download_log` history, and Issues / name-correction notes (`010_attendee_issue_note.sql`)
- [x] **6b. Billing & plan enforcement** — central `assertWithinPlan(orgId, resource)` guard, read-only mode on plan expiration while public downloads remain live, `/dashboard/billing` with usage meters, plan comparison & manual Bank/JazzCash/Easypaisa `payment_requests` + screenshot upload, atomic approval upgrade trigger/RPC, and daily Vercel Cron (`/api/cron/check-expiring-plans`, `011_billing_and_plan_enforcement.sql`)
- [x] **6c. Platform `/superadmin` console** — gated exclusively by `public.super_admins` table (`012_super_admins.sql`, never via env password; no impersonation), platform overview with monthly revenue chart, searchable organizations list & detail, manual plan & expiry controls, payment screenshot review queue, and instant org suspension blocking both admin sessions and public `/e/[slug]` pages with full `audit_log` coverage
- [ ] **7. Deploy** — new Vercel project, production env vars

### Legacy TODO (single-event leftovers, kept working until replaced)

Search the code for `TODO(saas)`.

- [x] `ADMIN_PASSWORD` (`src/app/api/admin/login/route.ts`) → replaced by Supabase Auth per user (phase 2)
- [ ] `SEMINAR_TITLE`, `SEMINAR_SUBTITLE` (`src/lib/config.ts`, `src/app/page.tsx`) → `events.title` / `events.subtitle` (phase 3)
- [ ] `TEMPLATE_FILE` + hard-coded `NAME_STYLES` (`src/lib/config.ts`) → per-event template + name box (phase 4)
- [ ] Fixed `cert_type` (participation/appreciation) and `roll_no` key → per-event configuration (phase 1/3)
- [ ] "Society" member routes/UI → generic attendee tags or remove (ask first)
- [ ] `public/fonts/*.ttf` (Times New Roman, Georgia) are Microsoft fonts — replace with
      open-licensed fonts (e.g. Tinos / Gelasio, OFL) before a public release

## Infrastructure setup (manual, one time)

Use a **brand-new** Supabase project and a **brand-new** Vercel project. Never reuse old keys.

**Supabase**
1. supabase.com → New project → name `cert-saas`, strong DB password (save it in a password manager), nearest region.
2. Project Settings → API: copy **Project URL**, **anon/publishable key**, **service_role/secret key**.
3. SQL Editor → run `supabase/migrations/001_core.sql` then `supabase/migrations/002_rls.sql` (creates all tables, RLS policies, and the Free/Starter plans). Optionally run `supabase/tests/isolation.sql` to verify all 94 isolation checks pass.

**GitHub**
4. Create a new **private** repo `cert-saas`, then:
   `git remote add origin https://github.com/<you>/cert-saas.git && git push -u origin main`

**Vercel**
5. vercel.com → Add New → Project → import the new GitHub repo (framework: Next.js, defaults OK).
6. Before the first deploy, Settings → Environment Variables (Production + Preview + Development):

| Variable | Value | Exposed to browser? |
|---|---|---|
| `SUPABASE_URL` | Project URL | no |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key | **no — server only** |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key | yes |
| `NEXT_PUBLIC_APP_URL` | `https://<project>.vercel.app` | yes |
| `SESSION_SECRET` | new random 64-hex string | no |
| `ADMIN_PASSWORD` | new strong password (legacy) | no |
| `SEMINAR_TITLE`, `SEMINAR_SUBTITLE` | optional (legacy) | no |

7. Deploy. Locally, put the same values in `.env.local` with `NEXT_PUBLIC_APP_URL=http://localhost:3000`.
