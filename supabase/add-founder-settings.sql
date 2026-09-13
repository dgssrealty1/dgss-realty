-- =====================================================================
-- MIGRATION: admin-managed Founder content
-- ---------------------------------------------------------------------
-- Adds founder fields to the EXISTING `settings` singleton table rather
-- than creating a new table — founder info is site-wide configuration,
-- exactly what `settings` already holds, and it means the existing
-- Admin settings form, auth and RLS policies all apply unchanged.
--
-- Run once in the Supabase SQL Editor. Safe to re-run: every column
-- uses "if not exists", and the seed only fills columns that are still
-- NULL, so it will never overwrite anything you've edited in Admin.
-- =====================================================================

-- 1. Add the columns -------------------------------------------------
alter table settings add column if not exists founder_name            text;
alter table settings add column if not exists founder_designation     text;
alter table settings add column if not exists founder_location        text;
alter table settings add column if not exists founder_experience      text;
alter table settings add column if not exists founder_credential_line text;
alter table settings add column if not exists founder_photo_url       text;
alter table settings add column if not exists founder_bio_intro       text;
alter table settings add column if not exists founder_bio_top         text;
alter table settings add column if not exists founder_bio_bottom      text;
alter table settings add column if not exists founder_quote           text;

-- 2. Seed with the website's CURRENT live founder content -------------
-- coalesce() means each field is only filled if it's still empty —
-- nothing already set in Admin gets overwritten.
update settings set
  founder_name = coalesce(founder_name, 'D. Gopi'),

  founder_designation = coalesce(founder_designation, 'Real Estate Advisor'),

  founder_location = coalesce(founder_location, 'K.K. Nagar, Chennai'),

  founder_experience = coalesce(founder_experience, '20+ Years Experience'),

  founder_credential_line = coalesce(founder_credential_line,
    '20+ Years in Sales, Rentals, Leasing, Commercial Real Estate and Property Advisory.'),

  founder_bio_intro = coalesce(founder_bio_intro,
    'D. Gopi is an experienced real estate professional, deal-maker, mentor, and trusted advisor.'),

  founder_bio_top = coalesce(founder_bio_top,
    'With more than 20 years of experience in the real estate industry, D. Gopi has built his reputation through extensive knowledge, strong relationships, and a proven track record of successful property transactions.'
    || chr(10) || chr(10) ||
    'Over the years, he has been involved in a wide range of residential and commercial real estate transactions, including property sales, purchases, rentals, leases, and commercial deals. His experience across different segments of the market has given him a deep understanding of property, negotiation, documentation, and deal execution.'),

  founder_bio_bottom = coalesce(founder_bio_bottom,
    'Beyond transactions, D. Gopi is known for being a supportive and approachable professional. He has encouraged and motivated many young realtors and aspiring professionals, sharing his experience and helping others grow in the industry.'
    || chr(10) || chr(10) ||
    'His philosophy is simple: build trust, create value, and grow together.'
    || chr(10) || chr(10) ||
    'As DGSS Realty''s Real Estate Advisor, D. Gopi continues to bring his two decades of experience, market knowledge, and people-first approach to every client and every property transaction.'),

  founder_quote = coalesce(founder_quote,
    '"Real estate is not just about property. It is about people, trust, relationships, and creating the right opportunities."')
where id = 1;

-- 3. RLS ---------------------------------------------------------------
-- No policy changes needed. `settings` already has:
--   "public can read settings"   -> public site can read founder info
--   "admins full access settings" -> only authenticated admins can write
-- Adding columns to an existing table inherits its existing policies.
