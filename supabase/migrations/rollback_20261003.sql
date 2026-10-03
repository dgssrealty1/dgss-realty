-- =====================================================================
-- EMERGENCY ROLLBACK for migration 05 (20261003). Use only if something
-- critical breaks; re-apply 05 as soon as possible.
-- Keeps ALL data, tables and columns (audit_log, lead_activity,
-- property_internal, media_assets, new lead/settings columns): only the
-- new triggers / functions / policies are removed and the previous
-- Storage policies + role helpers are restored.
-- The new admin pages (staff, CRM, audit, media library) stop working
-- after this; redeploy the previous site version as well.
-- =====================================================================
begin;

-- role helpers: back to "any admin_users row counts" (is_active ignored)
create or replace function public.current_admin_role()
returns text language sql stable security definer set search_path = public
as $$ select role from public.admin_users where user_id = auth.uid() $$;
create or replace function public.has_admin_role(allowed text[])
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.admin_users where user_id = auth.uid() and role = any(allowed)) $$;

-- triggers added by 05
drop trigger if exists trg_promote_featured_image on public.property_images;
drop trigger if exists trg_check_property_image_row on public.property_images;
drop trigger if exists trg_queue_image_file_cleanup on public.property_images;
drop trigger if exists trg_audit_property_images on public.property_images;
drop trigger if exists trg_property_business_rules on public.properties;
drop trigger if exists trg_property_review_workflow on public.properties;
drop trigger if exists trg_audit_properties on public.properties;
drop trigger if exists trg_guard_lead_update on public.leads;
drop trigger if exists trg_log_lead_activity on public.leads;
drop trigger if exists trg_audit_leads on public.leads;
drop trigger if exists trg_validate_settings on public.settings;
drop trigger if exists trg_audit_settings on public.settings;
drop trigger if exists trg_validate_testimonial on public.testimonials;
drop trigger if exists trg_audit_testimonials on public.testimonials;
drop trigger if exists trg_audit_admin_users on public.admin_users;
drop trigger if exists trg_audit_property_internal on public.property_internal;
drop trigger if exists trg_touch_property_internal on public.property_internal;
drop trigger if exists trg_prepare_media_asset on public.media_assets;
do $$ declare t text; begin
  foreach t in array array['properties','property_images','settings','testimonials','property_slug_redirects'] loop
    execute format('drop trigger if exists trg_bump_cache_version on public.%I', t);
  end loop;
end $$;

-- Storage policies: back to migration 01's versions
drop policy if exists "editors upload property images" on storage.objects;
drop policy if exists "editors update property images" on storage.objects;
drop policy if exists "editors delete property images" on storage.objects;
create policy "editors upload property images" on storage.objects for insert to authenticated
  with check (bucket_id = 'property-images' and public.has_admin_role(array['super_admin','admin','editor'])
              and exists (select 1 from public.properties p where p.id::text = (storage.foldername(name))[1]));
create policy "editors update property images" on storage.objects for update to authenticated
  using (bucket_id = 'property-images' and public.has_admin_role(array['super_admin','admin','editor']))
  with check (bucket_id = 'property-images' and public.has_admin_role(array['super_admin','admin','editor']));
create policy "editors delete property images" on storage.objects for delete to authenticated
  using (bucket_id = 'property-images' and public.has_admin_role(array['super_admin','admin','editor']));

-- The one-featured-image index is kept on purpose: the data already
-- satisfies it and old admin code clears the old flag before setting
-- a new one. To drop it anyway:
--   drop index if exists public.uniq_property_images_one_featured;
commit;
