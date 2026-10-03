-- =====================================================================
-- VERIFY after running migrations 01–03 (and again after 04 and 05).
-- Read-only. Paste into the Supabase SQL Editor and Run.
--
-- Postgres combines permissive policies with OR: one leftover policy
-- that the migrations didn't know about (e.g. added by hand in the
-- dashboard) can silently re-open access. Every row in result 1 must
-- say "expected". Anything marked "UNEXPECTED" must be reviewed and
-- normally dropped before going live.
-- =====================================================================

-- 1. Every policy on the tables this project uses
with expected(tbl, name) as (values
  ('properties','public can read published properties'),
  ('properties','staff read all properties'),
  ('properties','editors insert properties'),
  ('properties','editors update properties'),
  ('properties','admins delete properties'),
  ('property_images','public can read images of published properties'),
  ('property_images','staff read all property_images'),
  ('property_images','editors insert property_images'),
  ('property_images','editors update property_images'),
  ('property_images','editors delete property_images'),
  ('leads','lead staff read leads'),
  ('leads','lead staff update leads'),
  ('leads','super_admin delete leads'),
  ('testimonials','public can read published testimonials'),
  ('testimonials','staff read all testimonials'),
  ('testimonials','editors insert testimonials'),
  ('testimonials','editors update testimonials'),
  ('testimonials','admins delete testimonials'),
  ('settings','public can read settings'),
  ('settings','admins update settings'),
  ('admin_users','admin_users read own row or super_admin all'),
  ('admin_users','admin_users super_admin insert'),
  ('admin_users','admin_users super_admin update'),
  ('admin_users','admin_users super_admin delete'),
  ('property_slug_redirects','public read slug redirects'),
  ('property_slug_redirects','staff read slug redirects'),
  ('objects','staff list property images'),              -- until migration 04
  ('objects','public read published property images'),  -- after migration 04
  ('objects','staff read property images'),              -- after migration 04
  ('objects','editors upload property images'),
  ('objects','editors update property images'),
  ('objects','editors delete property images'),
  -- migration 05
  ('objects','staff list site media'),
  ('objects','admins upload site media'),
  ('objects','admins update site media'),
  ('objects','admins delete site media'),
  ('property_internal','internal read'),
  ('property_internal','internal insert'),
  ('property_internal','internal update'),
  ('property_internal','internal delete'),
  ('lead_activity','lead staff read activity'),
  ('lead_activity','lead staff add own notes'),
  ('audit_log','admins read audit log'),
  ('storage_cleanup_queue','editors read cleanup queue'),
  ('media_assets','staff read media assets'),
  ('media_assets','admins write media assets'),
  ('site_cache_state','public read cache version')
)
select p.schemaname, p.tablename, p.policyname, p.cmd, p.roles::text,
       case when e.name is null then 'UNEXPECTED — review' else 'expected' end as status,
       p.qual, p.with_check
from pg_policies p
left join expected e on e.tbl = p.tablename and e.name = p.policyname
where (p.schemaname = 'public' and p.tablename in ('properties','property_images','leads','testimonials','settings','admin_users','property_slug_redirects',
                                                      'property_internal','lead_activity','audit_log','storage_cleanup_queue','media_assets','site_cache_state'))
   or (p.schemaname = 'storage' and p.tablename = 'objects'
       and (coalesce(p.qual,'') || coalesce(p.with_check,'')) similar to '%(property-images|site-media)%')
order by (e.name is null) desc, p.tablename, p.policyname;

-- 2. RLS must be ON for every table
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('properties','property_images','leads','testimonials','settings','admin_users','property_slug_redirects',
                  'property_internal','lead_activity','audit_log','storage_cleanup_queue','media_assets','site_cache_state')
order by 1;

-- 2b. (after 05) At most one featured image per property — must return no rows
select property_id, count(*) from public.property_images where is_featured_image group by 1 having count(*) > 1;

-- 3. Who is staff (expect exactly Gopi as super_admin unless you added others)
select u.email, a.role, a.created_at
from public.admin_users a join auth.users u on u.id = a.user_id
order by a.role, u.email;

-- 4. Nothing lost: row counts to compare with the numbers you noted BEFORE migrating
select (select count(*) from public.properties)      as properties,
       (select count(*) from public.property_images) as property_images,
       (select count(*) from public.leads)           as leads,
       (select count(*) from public.testimonials)    as testimonials,
       (select count(*) from auth.users)             as users,
       (select count(*) from storage.objects where bucket_id = 'property-images') as storage_files;

-- 5. Bucket state (public = true before migration 04, false after)
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('property-images','site-media');
