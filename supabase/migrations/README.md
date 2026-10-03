# Database migrations — how to apply

| # | File | What it does | Destructive? |
|---|------|--------------|--------------|
| 1 | `20260928_01_admin_roles_rls.sql` | `admin_users` + roles (super_admin, admin, editor, sales, viewer). Role-based RLS; editors can't publish/archive (trigger). Storage write rules, 8 MB / image-only limit. Seeds **gopi@dgssrealty.com** as super_admin. | No data changed. |
| 2 | `20260928_02_property_integrity.sql` | `property_slug_redirects`, slug generation, CHECK constraints (NOT VALID), indexes. | No data changed. |
| 3 | `20260928_03_lead_protection.sql` | `submit_lead()` (validation, honeypot, de-dup, rate limits), `lead_type`, `client_ip_hash`. Removes direct public INSERT on leads. | `lead_type` back-fill only. |
| 4 | `20260928_04_private_property_images.sql` | `property-images` bucket private; public reads only for published listings. | No files touched. |
| 5 | `20261003_05_cms_integrity_crm_audit.sql` | Staff management (`is_active`, `list_staff()`, `add_staff_by_email()`), **one featured image per property** (duplicates un-flagged first, then a unique index), auto-promotion when the featured photo is deleted, image path rules, listing/status business rules, review workflow (`review_status`), `property_internal` (staff-only owner/mandate data), leads CRM (priority, assignment, follow-up, budget, requirement, next action) + `lead_activity` timeline, **audit log**, tighter Storage policies + clean-up queue, `site-media` bucket + `media_assets`, cache version, settings validation + new settings fields, `dashboard_stats()`. | Only clears **duplicate** featured flags (the images stay). Everything else adds columns/tables/functions or replaces policies. |

`verify_after_migration.sql` — read-only checks to run after migrating.
`rollback_20260928.sql` — emergency undo of 01–04 policies.
`rollback_20261003.sql` — emergency undo of 05's triggers and policy changes (keeps all data and new columns).

## Deployment order (this release)

1. **Back up.** Supabase → Database → Backups. Run section 4 of `verify_after_migration.sql` and note the counts.
2. If 01–04 are not applied yet, apply them first (see their notes below).
3. **Before migration 05**, check for duplicate featured images (informational — 05 fixes them):
   `select property_id, count(*) from property_images where is_featured_image group by 1 having count(*) > 1;`
4. Run **migration 05** in the SQL Editor.
5. Run `verify_after_migration.sql`: every policy "expected", RLS on everywhere, counts unchanged.
6. Supabase → **Authentication → URL Configuration**: add
   `https://dgssrealty.com/admin/reset-password.html` to **Redirect URLs** (password reset and staff invitations land there).
7. Optional — email invitations from Admin → Staff Management:
   `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API keys → secret / service_role key).
   Without it, staff can still be added: create the user in Supabase → Authentication → Users, then use **Add existing account**.
   The key is only ever used inside the Worker for the invite call, after the database confirms the caller is a super admin.
8. Deploy the site: `npm install` then `npx wrangler deploy`.
9. Smoke test (below).

Deploying the code before migration 05 is safe too: the Worker falls back to
the old settings columns and time-based caching until the migration runs. But
Admin features that use the new tables (staff, CRM, audit, media library)
need migration 05.

### Smoke test (production)
- Homepage: hero text, phone, WhatsApp, email, address, social icons and logo match Admin → Contact Details / Branding / Homepage. View source: `<title>`, `og:title` and the JSON-LD block show the same values.
- Change the hero heading in Admin → Homepage, save, reload the homepage: the new text appears within a few seconds. Change it back.
- `https://dgssrealty.com/properties/<a real slug>/` loads; `/properties/does-not-exist/` is a 404; `/sitemap.xml` lists only published properties; `/robots.txt` disallows /admin/ and /api/.
- Admin → Leads: page navigation and "Per page" work; open a lead, set priority / follow-up / assignment, add a note — the timeline shows each step. Export CSV downloads the filtered list.
- Admin → Staff Management (super admin): staff list shows emails; roles can be changed.
- Admin → Audit Log shows the changes you just made.
- Admin login → "Forgot password?" sends an email whose link opens `/admin/reset-password.html`.
- Upload a photo to a draft property; open it in a private window via `/media/property-images/<path>` → 404 until published.

## Adding staff
Use **Admin → Staff Management** (super admin). SQL is only needed for the very first super admin:
```sql
insert into public.admin_users (user_id, role)
select id, 'super_admin' from auth.users where email = 'person@example.com';
```

## Notes for 01–04 (unchanged)
- After 01–03: Supabase → Authentication → Providers → Email → turn off **Allow new users to sign up**.
- Run 04 only after the site code serving `/media/property-images/…` is deployed. Undo: `update storage.buckets set public = true where id = 'property-images';`
- Optional hardening: Cloudflare Turnstile (`TURNSTILE_SITE_KEY` var + `TURNSTILE_SECRET_KEY` secret) and the lead gate secret (`LEAD_GATE_SECRET` secret + `private.app_secrets` row).

## Tests
- `bash supabase/tests/run_all.sh` — rebuilds a throwaway local Postgres with every migration and runs the RLS / authorization matrix (`rls_test.py`).
- `supabase/tests/e2e/` — real Worker (`wrangler dev`) + PostgREST + headless Chromium QA (`admin-qa.mjs`). Test-only; never run against Supabase.
