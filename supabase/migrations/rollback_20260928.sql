-- =====================================================================
-- EMERGENCY ROLLBACK for the 2026-09-28 migrations.
-- Restores the ORIGINAL policies — which let any signed-up Supabase user
-- act as an admin. Use only if the new policies block something critical,
-- and re-apply the migrations as soon as possible.
-- Columns/tables added by the migrations are left in place (harmless).
-- =====================================================================
begin;

-- leads: restore direct public insert, drop the new function
create policy "public can submit leads" on public.leads for insert with check (true);
drop function if exists public.submit_lead(text,text,text,text,text,text,uuid,jsonb,text,text,text);

-- triggers
drop trigger if exists trg_guard_property_publish_rights on public.properties;
drop trigger if exists trg_ensure_property_slug on public.properties;

-- role-based policies -> old "authenticated" policies
drop policy if exists "staff read all properties" on public.properties;
drop policy if exists "editors insert properties" on public.properties;
drop policy if exists "editors update properties" on public.properties;
drop policy if exists "admins delete properties" on public.properties;
drop policy if exists "staff read all property_images" on public.property_images;
drop policy if exists "editors insert property_images" on public.property_images;
drop policy if exists "editors update property_images" on public.property_images;
drop policy if exists "editors delete property_images" on public.property_images;
drop policy if exists "lead staff read leads" on public.leads;
drop policy if exists "lead staff update leads" on public.leads;
drop policy if exists "super_admin delete leads" on public.leads;
drop policy if exists "staff read all testimonials" on public.testimonials;
drop policy if exists "editors insert testimonials" on public.testimonials;
drop policy if exists "editors update testimonials" on public.testimonials;
drop policy if exists "admins delete testimonials" on public.testimonials;
drop policy if exists "admins update settings" on public.settings;

create policy "admins full access properties" on public.properties for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "admins full access property_images" on public.property_images for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "admins full access leads" on public.leads for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "admins full access testimonials" on public.testimonials for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "admins full access settings" on public.settings for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- storage (also undoes migration 04: bucket public again)
update storage.buckets set public = true where id = 'property-images';
drop policy if exists "public read published property images" on storage.objects;
drop policy if exists "staff read property images" on storage.objects;
drop policy if exists "staff list property images" on storage.objects;
drop policy if exists "editors upload property images" on storage.objects;
drop policy if exists "editors update property images" on storage.objects;
drop policy if exists "editors delete property images" on storage.objects;
create policy "public can view property images in storage" on storage.objects for select using (bucket_id = 'property-images');
create policy "admins can upload property images" on storage.objects for insert with check (bucket_id = 'property-images' and auth.role() = 'authenticated');
create policy "admins can update property images" on storage.objects for update using (bucket_id = 'property-images' and auth.role() = 'authenticated');
create policy "admins can delete property images" on storage.objects for delete using (bucket_id = 'property-images' and auth.role() = 'authenticated');

commit;
-- NOTE: the new site code calls submit_lead() and current_admin_role();
-- after this rollback, redeploy the previous site version as well.
