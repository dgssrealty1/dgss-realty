-- =====================================================================
-- MIGRATION 02 — Property data integrity: slugs, redirects, controlled
-- values, indexes
-- ---------------------------------------------------------------------
-- 1. Slugs: every property gets a clean, unique, URL-safe slug,
--    generated automatically when left blank. Existing slugs are NOT
--    rewritten (only new rows and deliberately edited slugs are
--    normalized), so every URL already shared keeps working.
-- 2. property_slug_redirects: when a slug IS deliberately changed, the
--    old one is remembered so /properties/<old-slug>/ 301-redirects to
--    the new URL instead of 404ing.
-- 3. CHECK constraints for category / listing_type / status — added as
--    NOT VALID so existing rows are never rejected; only new writes are
--    checked. Run the "validate" statements at the bottom after checking
--    the report query returns nothing.
-- 4. Indexes matched to the actual queries the site runs.
-- Safe to re-run.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Slug normalization + uniqueness
-- ---------------------------------------------------------------------
create table if not exists public.property_slug_redirects (
  old_slug    text primary key,
  property_id uuid not null references public.properties(id) on delete cascade,
  created_at  timestamptz not null default now()
);
comment on table public.property_slug_redirects is
  'Old property slugs -> property. The public site 301-redirects /properties/<old_slug>/ to the current URL.';

alter table public.property_slug_redirects enable row level security;

drop policy if exists "public read slug redirects" on public.property_slug_redirects;
create policy "public read slug redirects"
  on public.property_slug_redirects for select
  using (exists (
    select 1 from public.properties p
    where p.id = property_slug_redirects.property_id
      and p.is_published = true and p.is_archived = false
  ));
drop policy if exists "staff read slug redirects" on public.property_slug_redirects;
create policy "staff read slug redirects"
  on public.property_slug_redirects for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));
-- No write policies: rows are written only by the trigger below
-- (SECURITY DEFINER), never directly by clients.

create or replace function public.slugify(input text)
returns text
language sql immutable
as $$
  select nullif(
    left(
      trim(both '-' from regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g')),
      80
    ),
  '')
$$;

create or replace function public.ensure_property_slug()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  base      text;
  candidate text;
  n         int := 2;
begin
  -- Leave untouched slugs alone on UPDATE — stable URLs.
  if tg_op = 'UPDATE' and new.slug is not distinct from old.slug then
    return new;
  end if;

  base := public.slugify(new.slug);
  if base is null then
    base := public.slugify(concat_ws(' ', new.title,
              case when new.title ilike '%' || coalesce(new.location, '') || '%' then null else new.location end));
  end if;
  base := trim(both '-' from coalesce(base, 'property'));

  candidate := base;
  while exists (select 1 from public.properties where slug = candidate and id <> new.id)
     or exists (select 1 from public.property_slug_redirects where old_slug = candidate and property_id <> new.id)
  loop
    candidate := left(base, 75) || '-' || n;
    n := n + 1;
  end loop;
  new.slug := candidate;

  -- A published property's slug is changing: remember the old one.
  if tg_op = 'UPDATE' and old.slug is not null and old.slug <> new.slug then
    insert into public.property_slug_redirects (old_slug, property_id)
    values (old.slug, new.id)
    on conflict (old_slug) do update set property_id = excluded.property_id;
    -- If the property is moving back to a slug it used before, that
    -- slug is live again and no longer a redirect.
    delete from public.property_slug_redirects where old_slug = new.slug;
  end if;

  return new;
end $$;

drop trigger if exists trg_ensure_property_slug on public.properties;
create trigger trg_ensure_property_slug
  before insert or update of slug on public.properties
  for each row execute function public.ensure_property_slug();

-- properties.slug is already "unique not null" in schema.sql; the
-- unique constraint already creates an index, so the extra plain index
-- from schema.sql is redundant.
drop index if exists public.idx_properties_slug;

-- ---------------------------------------------------------------------
-- 2. Controlled values
-- ---------------------------------------------------------------------
-- 'Leased' added (for lease listings). 'Inactive' kept because existing
-- rows may use it. Archiving stays the separate is_archived flag.
alter table public.properties drop constraint if exists properties_category_check;
alter table public.properties add constraint properties_category_check
  check (category in ('Apartment','Flat','Independent House','Villa','Residential Plot','Land',
                      'Commercial','Office','Retail','Warehouse','Industrial','Other')) not valid;

alter table public.properties drop constraint if exists properties_listing_type_check;
alter table public.properties add constraint properties_listing_type_check
  check (listing_type in ('For Sale','For Rent','For Lease')) not valid;

alter table public.properties drop constraint if exists properties_status_check;
alter table public.properties add constraint properties_status_check
  check (status in ('Available','Under Offer','Sold','Rented','Leased','Inactive')) not valid;

alter table public.properties drop constraint if exists properties_numbers_check;
alter table public.properties add constraint properties_numbers_check
  check (
    (price is null or price >= 0)
    and (price_per_sqft is null or price_per_sqft >= 0)
    and (bedrooms  is null or bedrooms  between 0 and 50)
    and (bathrooms is null or bathrooms between 0 and 50)
    and (balconies is null or balconies between 0 and 50)
    and (latitude  is null or latitude  between -90  and 90)
    and (longitude is null or longitude between -180 and 180)
  ) not valid;

-- Slug must be URL-safe for anything written from now on.
alter table public.properties drop constraint if exists properties_slug_format_check;
alter table public.properties add constraint properties_slug_format_check
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$') not valid;

-- ---------------------------------------------------------------------
-- 3. Indexes for real query patterns
-- ---------------------------------------------------------------------
-- Public site: published & not archived, newest first
--   (script.js fetchAllPublishedProperties, sitemap, area pages)
create index if not exists idx_properties_public_listing
  on public.properties (created_at desc)
  where is_published = true and is_archived = false;
-- Admin dashboard "recent properties"
create index if not exists idx_properties_updated
  on public.properties (updated_at desc);
-- Gallery: images of one property in order (already exists in schema.sql
-- as idx_property_images_property (property_id, sort_order) — kept).

commit;

-- ---------------------------------------------------------------------
-- OPTIONAL, after verifying: validate the constraints on existing rows.
-- This report must return zero rows first:
--
--   select id, slug, category, listing_type, status from public.properties
--   where category not in ('Apartment','Flat','Independent House','Villa','Residential Plot','Land','Commercial','Office','Retail','Warehouse','Industrial','Other')
--      or listing_type not in ('For Sale','For Rent','For Lease')
--      or status not in ('Available','Under Offer','Sold','Rented','Leased','Inactive')
--      or slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$';
--
-- then:
--   alter table public.properties validate constraint properties_category_check;
--   alter table public.properties validate constraint properties_listing_type_check;
--   alter table public.properties validate constraint properties_status_check;
--   alter table public.properties validate constraint properties_numbers_check;
--   alter table public.properties validate constraint properties_slug_format_check;
-- ---------------------------------------------------------------------
