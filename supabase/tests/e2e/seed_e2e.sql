-- TEST-ONLY data for the local end-to-end run (never run on Supabase).
insert into auth.users(email) values
  ('gopi@dgssrealty.com'), ('editor@test.local'), ('sales@test.local'), ('stranger@test.local'), ('admin@test.local')
on conflict (email) do nothing;
insert into admin_users(user_id, role)
  select id, 'editor' from auth.users where email='editor@test.local' on conflict do nothing;
insert into admin_users(user_id, role)
  select id, 'sales' from auth.users where email='sales@test.local' on conflict do nothing;

-- Numeric prices so the budget filter has data (the seed only has display prices).
update properties set price = 19000000 where slug = '2bhk-flat-nandanam';
update properties set price = 150000000 where slug = 'premium-beach-side-land-uthandi';
update properties set price = 150000, locality = 'Ashok Nagar' where slug = '5bhk-independent-house-ashok-nagar';

-- A published listing whose fields contain script injection attempts.
insert into properties (slug, title, category, listing_type, status, location, city, display_price,
  bedrooms, builtup_area, short_description, full_description, highlights, amenities, is_published)
values ('', 'Villa <script>alert("t")</script> ECR', 'Villa', 'For Sale', 'Available',
  'Uthandi, ECR <img src=x onerror=alert(1)>', 'Chennai', '₹4.5 Crore',
  4, '3,200 Sq.Ft.', 'Sea-facing "villa" & garden',
  '## Overview' || chr(10) || 'Great <b onclick="x()">villa</b> with <script>alert(2)</script> garden.' || chr(10) || chr(10) || '- Private pool' || chr(10) || '- Near beach',
  array['Corner plot', '<svg onload=alert(3)>'], array['Swimming Pool', 'Security'], true);

-- A sold listing (must show as sold, not "available").
insert into properties (slug, title, category, listing_type, status, location, city, display_price, bedrooms, is_published)
values ('3bhk-apartment-velachery', '3 BHK Apartment – Velachery', 'Apartment', 'For Sale', 'Sold', 'Velachery', 'Chennai', '₹1.1 Crore', 3, true);

-- A draft (must never be public).
insert into properties (slug, title, category, listing_type, location, is_published)
values ('secret-draft-kk-nagar', 'Secret Draft – KK Nagar', 'Flat', 'For Sale', 'KK Nagar', false);

-- A lead whose fields try to inject script into the admin panel.
insert into leads(name, phone, email, message, source, lead_type, source_details)
values ('<img src=x onerror=alert(document.cookie)>', '9841055506', 'a@b.co',
        '<script>alert(1)</script>', 'contact_form', 'general_contact', '{"Note":"<svg onload=alert(2)>"}');

-- Uploaded (Storage) images: one for a published listing, one for the draft.
-- The files themselves are copied into the mock storage folder by start.sh.
insert into storage.objects(bucket_id, name)
  select 'property-images', id || '/pub-photo.jpg' from properties where slug = '5bhk-independent-house-ashok-nagar';
insert into storage.objects(bucket_id, name)
  select 'property-images', id || '/draft-photo.jpg' from properties where slug = 'secret-draft-kk-nagar';
-- Stored exactly as the OLD admin uploader saved it (a public Storage URL).
-- (The old featured photo is un-featured first: only one featured image
-- per property is allowed since migration 05.)
update property_images set is_featured_image = false
  where public_url like '%prop-4-ashok-nagar%';
insert into property_images(property_id, storage_path, public_url, alt_text, is_featured_image, sort_order)
  select id, id || '/pub-photo.jpg', 'https://uiirwgzyuhxyerakvzzf.supabase.co/storage/v1/object/public/property-images/' || id || '/pub-photo.jpg', 'Uploaded living room', true, 0
  from properties where slug = '5bhk-independent-house-ashok-nagar';
insert into property_images(property_id, storage_path, public_url, alt_text, is_featured_image, sort_order)
  select id, id || '/draft-photo.jpg', 'https://uiirwgzyuhxyerakvzzf.supabase.co/storage/v1/object/public/property-images/' || id || '/draft-photo.jpg', 'Draft photo', true, 0
  from properties where slug = 'secret-draft-kk-nagar';
