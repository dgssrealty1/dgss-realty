-- =====================================================================
-- MIGRATION 06 — Table / function grants for projects with Supabase's
-- locked-down default privileges
-- ---------------------------------------------------------------------
-- WHY: the live project (verified 2026-10-03) does NOT give anon /
--   authenticated any SELECT/INSERT/UPDATE/DELETE on tables created from
--   the SQL Editor, and new functions are executable by postgres only.
--   RLS policies only filter rows a role is ALREADY allowed to touch, so
--   without these grants the tables/functions added by migrations 01–05
--   are unusable (staff management, image uploads, CRM timeline, audit
--   log, media library, slug redirects, cache version).
--
-- WHAT: grants exactly the privileges the app uses. Every row is still
--   filtered by the RLS policies from 01–05; nothing here widens access
--   beyond those policies. Tables staff must never write directly
--   (audit_log, storage_cleanup_queue, site_cache_state,
--   property_slug_redirects) get SELECT only.
--
-- Run AFTER migration 05. Safe to re-run. No data is changed.
-- On projects with the classic (permissive) defaults it is a no-op in
-- effect, because those privileges already exist.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- Staff list (RLS: own row; super_admin manages everyone).
grant select, insert, update, delete on public.admin_users to authenticated;

-- Old-slug redirects are read by the public Worker (RLS: published only).
grant select on public.property_slug_redirects to anon, authenticated;

-- Staff-only data (RLS restricts by role; anon was revoked in 05).
grant select, insert, update, delete on public.property_internal to authenticated;
grant select, insert on public.lead_activity to authenticated;      -- append-only: no update/delete
grant select on public.audit_log to authenticated;                   -- written by triggers only
grant select on public.storage_cleanup_queue to authenticated;       -- written by triggers / RPCs only
grant select, insert, update, delete on public.media_assets to authenticated;

-- Public content version for the Worker's cache keys (read-only).
grant select on public.site_cache_state to anon, authenticated;

-- ---------------------------------------------------------------------
-- Functions evaluated as the CALLER (inside RLS / Storage policies or
-- non-SECURITY-DEFINER triggers) need EXECUTE for that role.
-- ---------------------------------------------------------------------
grant execute on function public.is_valid_property_image_path(text) to authenticated;
grant execute on function public.is_valid_site_media_path(text) to authenticated;
grant execute on function public.slugify(text) to authenticated;

-- Already granted by 01 / 03 / 05; repeated so this file alone restores them.
grant execute on function public.current_admin_role() to authenticated;
grant execute on function public.has_admin_role(text[]) to authenticated;
grant execute on function public.submit_lead(text,text,text,text,text,text,uuid,jsonb,text,text,text) to anon, authenticated;
grant execute on function public.list_staff() to authenticated;
grant execute on function public.add_staff_by_email(text, text, text) to authenticated;
grant execute on function public.set_featured_image(uuid) to authenticated;
grant execute on function public.complete_lead_follow_up(uuid, date, text) to authenticated;
grant execute on function public.lead_assignees() to authenticated;
grant execute on function public.staff_labels() to authenticated;
grant execute on function public.log_lead_export(int, jsonb) to authenticated;
grant execute on function public.resolve_storage_cleanup(text[]) to authenticated;
grant execute on function public.report_storage_cleanup_failure(text, text) to authenticated;
grant execute on function public.storage_orphan_report() to authenticated;
grant execute on function public.dashboard_stats() to authenticated;

commit;
