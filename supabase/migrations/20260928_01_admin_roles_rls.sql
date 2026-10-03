-- =====================================================================
-- MIGRATION 01 — Role-based admin authorization + full RLS rewrite
-- ---------------------------------------------------------------------
-- PROBLEM THIS FIXES
--   Every write policy previously checked only
--       auth.role() = 'authenticated'
--   Supabase allows public e-mail sign-ups by default, so ANY stranger
--   who signed up with the public (anon) key became "authenticated" and
--   could edit/delete properties, read every lead, change settings and
--   upload/delete Storage files.
--
-- WHAT THIS DOES
--   1. Adds public.admin_users (user_id -> role) and two SECURITY DEFINER
--      helpers: current_admin_role() and has_admin_role(text[]).
--   2. Drops the old "authenticated = admin" policies and replaces them
--      with role-scoped ones (matrix below).
--   3. Blocks editors from publishing/archiving via a trigger (RLS cannot
--      restrict individual columns on UPDATE).
--   4. Tightens Storage: only staff can list the bucket; only
--      super_admin/admin/editor can write, and only inside a folder named
--      after an existing property id. Adds size + MIME limits.
--   5. Seeds gopi@dgssrealty.com as super_admin (if that user exists).
--
-- ROLE MATRIX
--   role         properties/images  publish/archive  testimonials  settings  leads      admin_users
--   super_admin  read/write/delete  yes              full          write     full       manage
--   admin        read/write/delete  yes              full          write     read/edit  own row
--   editor       read/write         NO               read/write    no        NO ACCESS  own row
--   sales        read               no               read          no        read/edit  own row
--   viewer       read               no               read          no        NO ACCESS  own row
--   (public)     published only     -                published     read      submit via submit_lead() only (migration 03)
--
-- Safe to re-run. Run in Supabase SQL Editor AFTER schema.sql and
-- add-founder-settings.sql. See supabase/migrations/README.md.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. admin_users + helpers
-- ---------------------------------------------------------------------
create table if not exists public.admin_users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('super_admin','admin','editor','sales','viewer')),
  display_name text,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
comment on table public.admin_users is
  'Who may use the DGSS admin panel and with which role. Being signed in to Supabase Auth is NOT enough — a user must have a row here.';

alter table public.admin_users enable row level security;

-- SECURITY DEFINER so policies can consult admin_users without the
-- caller needing (or getting) read access to the whole table, and
-- without recursive RLS evaluation. search_path pinned for safety.
create or replace function public.current_admin_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.admin_users where user_id = auth.uid()
$$;

create or replace function public.has_admin_role(allowed text[])
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where user_id = auth.uid() and role = any(allowed)
  )
$$;

revoke all on function public.current_admin_role() from public;
revoke all on function public.has_admin_role(text[]) from public;
grant execute on function public.current_admin_role() to authenticated;
grant execute on function public.has_admin_role(text[]) to authenticated;

-- Never allow the last super_admin to be removed or demoted — that would
-- lock everyone out of user management.
create or replace function public.guard_last_super_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'DELETE' and old.role = 'super_admin')
     or (tg_op = 'UPDATE' and old.role = 'super_admin' and new.role <> 'super_admin') then
    if (select count(*) from public.admin_users where role = 'super_admin' and user_id <> old.user_id) = 0 then
      raise exception 'Cannot remove or demote the last super_admin.';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_guard_last_super_admin on public.admin_users;
create trigger trg_guard_last_super_admin
  before update or delete on public.admin_users
  for each row execute function public.guard_last_super_admin();

drop policy if exists "admin_users read own row or super_admin all" on public.admin_users;
drop policy if exists "admin_users super_admin insert" on public.admin_users;
drop policy if exists "admin_users super_admin update" on public.admin_users;
drop policy if exists "admin_users super_admin delete" on public.admin_users;

create policy "admin_users read own row or super_admin all"
  on public.admin_users for select to authenticated
  using (user_id = auth.uid() or public.has_admin_role(array['super_admin']));
create policy "admin_users super_admin insert"
  on public.admin_users for insert to authenticated
  with check (public.has_admin_role(array['super_admin']));
create policy "admin_users super_admin update"
  on public.admin_users for update to authenticated
  using (public.has_admin_role(array['super_admin']))
  with check (public.has_admin_role(array['super_admin']));
create policy "admin_users super_admin delete"
  on public.admin_users for delete to authenticated
  using (public.has_admin_role(array['super_admin']));

-- ---------------------------------------------------------------------
-- 2. Remove the old "any authenticated user = admin" policies
-- ---------------------------------------------------------------------
drop policy if exists "admins full access properties"       on public.properties;
drop policy if exists "admins full access property_images"  on public.property_images;
drop policy if exists "admins full access leads"            on public.leads;
drop policy if exists "admins full access testimonials"     on public.testimonials;
drop policy if exists "admins full access settings"         on public.settings;

-- (Re-created below with explicit roles; dropped first so re-runs work.)
drop policy if exists "staff read all properties"      on public.properties;
drop policy if exists "editors insert properties"      on public.properties;
drop policy if exists "editors update properties"      on public.properties;
drop policy if exists "admins delete properties"       on public.properties;
drop policy if exists "staff read all property_images" on public.property_images;
drop policy if exists "editors insert property_images" on public.property_images;
drop policy if exists "editors update property_images" on public.property_images;
drop policy if exists "editors delete property_images" on public.property_images;
drop policy if exists "lead staff read leads"          on public.leads;
drop policy if exists "lead staff update leads"        on public.leads;
drop policy if exists "super_admin delete leads"       on public.leads;
drop policy if exists "staff read all testimonials"    on public.testimonials;
drop policy if exists "editors insert testimonials"    on public.testimonials;
drop policy if exists "editors update testimonials"    on public.testimonials;
drop policy if exists "admins delete testimonials"     on public.testimonials;
drop policy if exists "admins update settings"         on public.settings;

-- Public read policies from schema.sql are KEPT unchanged:
--   "public can read published properties"
--   "public can read images of published properties"
--   "public can read published testimonials"
--   "public can read settings"
-- "public can submit leads" is replaced in migration 03.

-- ---------------------------------------------------------------------
-- 3. properties
-- ---------------------------------------------------------------------
create policy "staff read all properties"
  on public.properties for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));

create policy "editors insert properties"
  on public.properties for insert to authenticated
  with check (public.has_admin_role(array['super_admin','admin','editor']));

create policy "editors update properties"
  on public.properties for update to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor']))
  with check (public.has_admin_role(array['super_admin','admin','editor']));

create policy "admins delete properties"
  on public.properties for delete to authenticated
  using (public.has_admin_role(array['super_admin','admin']));

-- Editors may create and edit, but only super_admin/admin may change
-- publish/archive state. RLS can't restrict single columns, so a
-- trigger enforces it. Calls with no signed-in user (SQL Editor,
-- service_role maintenance) are allowed through.
create or replace function public.guard_property_publish_rights()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if public.has_admin_role(array['super_admin','admin']) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.is_published, false) or coalesce(new.is_archived, false) then
      raise exception 'Only an admin can publish or archive a property. Save it as a draft instead.'
        using errcode = '42501';
    end if;
  elsif new.is_published is distinct from old.is_published
     or new.is_archived  is distinct from old.is_archived then
    raise exception 'Only an admin can publish, unpublish, archive or unarchive a property.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_property_publish_rights on public.properties;
create trigger trg_guard_property_publish_rights
  before insert or update on public.properties
  for each row execute function public.guard_property_publish_rights();

-- ---------------------------------------------------------------------
-- 4. property_images
-- ---------------------------------------------------------------------
create policy "staff read all property_images"
  on public.property_images for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));
create policy "editors insert property_images"
  on public.property_images for insert to authenticated
  with check (public.has_admin_role(array['super_admin','admin','editor']));
create policy "editors update property_images"
  on public.property_images for update to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor']))
  with check (public.has_admin_role(array['super_admin','admin','editor']));
create policy "editors delete property_images"
  on public.property_images for delete to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor']));

-- ---------------------------------------------------------------------
-- 5. leads (personal data: phone, email, messages)
-- ---------------------------------------------------------------------
create policy "lead staff read leads"
  on public.leads for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','sales']));
create policy "lead staff update leads"
  on public.leads for update to authenticated
  using (public.has_admin_role(array['super_admin','admin','sales']))
  with check (public.has_admin_role(array['super_admin','admin','sales']));
-- Leads are archived, not deleted, in normal use. Hard delete is
-- reserved for super_admin (e.g. a data-removal request).
create policy "super_admin delete leads"
  on public.leads for delete to authenticated
  using (public.has_admin_role(array['super_admin']));

-- ---------------------------------------------------------------------
-- 6. testimonials
-- ---------------------------------------------------------------------
create policy "staff read all testimonials"
  on public.testimonials for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));
create policy "editors insert testimonials"
  on public.testimonials for insert to authenticated
  with check (public.has_admin_role(array['super_admin','admin','editor']));
create policy "editors update testimonials"
  on public.testimonials for update to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor']))
  with check (public.has_admin_role(array['super_admin','admin','editor']));
create policy "admins delete testimonials"
  on public.testimonials for delete to authenticated
  using (public.has_admin_role(array['super_admin','admin']));

-- ---------------------------------------------------------------------
-- 7. settings (singleton row; public read policy kept)
-- ---------------------------------------------------------------------
create policy "admins update settings"
  on public.settings for update to authenticated
  using (public.has_admin_role(array['super_admin','admin']))
  with check (public.has_admin_role(array['super_admin','admin']));

-- ---------------------------------------------------------------------
-- 8. Storage: property-images bucket
-- ---------------------------------------------------------------------
-- The bucket stays PUBLIC so every existing image URL keeps working.
-- What changes:
--   * Anonymous visitors can no longer LIST the bucket (previously the
--     public SELECT policy let anyone enumerate every file, including
--     draft property photos). Direct public URLs still load.
--   * Writes need editor+ AND must go into "<existing property id>/…",
--     which is exactly the path the admin uploader already uses.
--   * Server-side size and type limits.
update storage.buckets
   set file_size_limit = 8388608,  -- 8 MB, matches the admin uploader
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/avif']
 where id = 'property-images';

drop policy if exists "public can view property images in storage" on storage.objects;
drop policy if exists "admins can upload property images"          on storage.objects;
drop policy if exists "admins can update property images"          on storage.objects;
drop policy if exists "admins can delete property images"          on storage.objects;
drop policy if exists "staff list property images"                 on storage.objects;
drop policy if exists "editors upload property images"             on storage.objects;
drop policy if exists "editors update property images"             on storage.objects;
drop policy if exists "editors delete property images"             on storage.objects;

create policy "staff list property images"
  on storage.objects for select to authenticated
  using (bucket_id = 'property-images'
         and public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));

create policy "editors upload property images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'property-images'
    and public.has_admin_role(array['super_admin','admin','editor'])
    and exists (
      select 1 from public.properties p
      where p.id::text = (storage.foldername(name))[1]
    )
  );

create policy "editors update property images"
  on storage.objects for update to authenticated
  using (bucket_id = 'property-images' and public.has_admin_role(array['super_admin','admin','editor']))
  with check (bucket_id = 'property-images' and public.has_admin_role(array['super_admin','admin','editor']));

create policy "editors delete property images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'property-images' and public.has_admin_role(array['super_admin','admin','editor']));

-- ---------------------------------------------------------------------
-- 9. Seed the first super_admin
-- ---------------------------------------------------------------------
-- Only the account below keeps admin access after this migration. Add
-- other staff afterwards, e.g.:
--   insert into public.admin_users (user_id, role)
--   select id, 'editor' from auth.users where email = 'someone@example.com';
insert into public.admin_users (user_id, role, display_name)
select id, 'super_admin', 'D. Gopi'
from auth.users
where lower(email) = 'gopi@dgssrealty.com'
on conflict (user_id) do nothing;

do $$
begin
  if not exists (select 1 from public.admin_users where role = 'super_admin') then
    raise warning 'No super_admin was created (gopi@dgssrealty.com not found in auth.users). Nobody can use the admin panel until you insert a row into public.admin_users.';
  end if;
end $$;

commit;
