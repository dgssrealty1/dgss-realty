-- =====================================================================
-- MIGRATION 04 — Private property-image storage
-- ---------------------------------------------------------------------
-- PROBLEM: the property-images bucket is PUBLIC. Anyone holding a file's
--   URL (…/storage/v1/object/public/property-images/<propertyId>/<file>)
--   can open it without signing in — including photos of DRAFT,
--   unpublished or archived properties, and photos that were public
--   once and are still cached/shared elsewhere.
--
-- FIX:
--   1. The bucket becomes PRIVATE, so /object/public/ URLs stop working.
--   2. Anonymous visitors may read ONLY files inside the folder of a
--      published, non-archived property. The website shows these through
--      its own address /media/property-images/<path> (the Worker fetches
--      them from Supabase with the public key, so this policy decides).
--   3. Staff (any admin role) can read every file; the admin panel uses
--      short-lived signed URLs for drafts.
--   4. Upload/update/delete rules from migration 01 are unchanged.
--
-- NON-DESTRUCTIVE: no file, row or URL value is deleted or rewritten.
-- Existing public_url values are converted to /media/… when displayed.
--
-- ORDER: run this only AFTER the new site code is deployed and
--   https://dgssrealty.com/media/property-images/<a published image path>
-- has been confirmed to load (see supabase/migrations/README.md).
--
-- UNDO (instant): update storage.buckets set public = true where id = 'property-images';
-- Safe to re-run.
-- =====================================================================

begin;

update storage.buckets set public = false where id = 'property-images';

drop policy if exists "staff list property images"            on storage.objects;
drop policy if exists "staff read property images"            on storage.objects;
drop policy if exists "public read published property images" on storage.objects;

-- Everyone (including signed-out visitors): only files of live listings.
create policy "public read published property images"
  on storage.objects for select
  using (
    bucket_id = 'property-images'
    and exists (
      select 1 from public.properties p
      where p.id::text = (storage.foldername(name))[1]
        and p.is_published = true
        and p.is_archived = false
    )
  );

-- Staff: every file (drafts, archived) — needed for admin previews.
create policy "staff read property images"
  on storage.objects for select to authenticated
  using (bucket_id = 'property-images'
         and public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));

commit;
