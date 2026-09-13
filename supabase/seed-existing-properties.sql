-- =====================================================================
-- SEED: migrates DGSS Realty's 5 current properties (previously
-- hardcoded in js/script.js) into the database, so the admin panel
-- starts pre-populated instead of empty.
--
-- Run this ONCE, after schema.sql, in the Supabase SQL Editor.
-- =====================================================================

-- NOTE ON IMAGES: this seed points image URLs at your live site
-- (pointed at dgssrealty.com — update if your live domain differs)
-- rather than Supabase Storage, since these image files already exist
-- there and there's no need to re-upload them just to get the CMS
-- working. Going forward, new properties you add through the admin
-- panel will upload straight to Supabase Storage. If you'd like these
-- 5 fully migrated to Supabase Storage too, you can re-upload each one
-- through Admin → Properties → Edit → Images whenever it's convenient
-- — nothing breaks in the meantime.

do $$
declare
  base_url text := 'https://dgssrealty.com';
  v_id uuid;
begin

  -- Property 1
  insert into properties (slug, title, category, listing_type, status, location, city,
    display_price, bedrooms, land_area, builtup_area, property_age,
    short_description, is_published, is_featured)
  values ('prime-residential-property-perambur', 'Prime Residential Property – Perambur', 'Independent House', 'For Sale', 'Available',
    'Office Paper Mills Road, Behind Jawahar Nagar, Perambur', 'Chennai', '₹3 Crore per Ground (Negotiable)', 4,
    '3,195 Sq.Ft. (35 × 91 Ft.)', '1,800 Sq.Ft.', '35 Years',
    'G + 1 structure, west facing.', true, true)
  returning id into v_id;
  insert into property_images (property_id, storage_path, public_url, alt_text, is_featured_image, sort_order)
  values (v_id, '', base_url || '/images/properties/prop-1-perambur.jpg',
    'Exterior of residential property for sale in Perambur, Office Paper Mills Road', true, 0);

  -- Property 2
  insert into properties (slug, title, category, listing_type, status, location, city,
    display_price, land_area,
    short_description, is_published, is_featured)
  values ('premium-beach-side-land-uthandi', 'Premium Beach-Side Land – Uthandi', 'Land', 'For Sale', 'Available',
    'Uthandi – Before Toll, Sea Side', 'Chennai', '₹15 Crore (Negotiable)', '5.7 Grounds (169 × 82 Ft.)',
    'Rectangular plot, south facing, fully compounded, private road access, direct access to the beach.', true, true)
  returning id into v_id;
  insert into property_images (property_id, storage_path, public_url, alt_text, is_featured_image, sort_order)
  values (v_id, '', base_url || '/images/properties/prop-2-uthandi-land.jpg',
    'Compound wall of beach-side land for sale in Uthandi, before toll', true, 0);

  -- Property 3
  insert into properties (slug, title, category, listing_type, status, location, city,
    display_price, bedrooms, builtup_area, uds, floor_number,
    short_description, is_published, is_featured)
  values ('2bhk-flat-nandanam', '2 BHK Flat – Nandanam', 'Flat', 'For Sale', 'Available',
    'Nandanam', 'Chennai', '₹1.90 Crore', 2, '1,362 Sq.Ft.', 'Approx. 770 Sq.Ft.', '2nd Floor',
    'Total 11 apartments, covered car parking.', true, true)
  returning id into v_id;
  insert into property_images (property_id, storage_path, public_url, alt_text, is_featured_image, sort_order)
  values (v_id, '', base_url || '/images/properties/prop-3-nandanam.jpg',
    'Living room interior of 2 BHK flat for sale in Nandanam', true, 0);

  -- Property 4
  insert into properties (slug, title, category, listing_type, status, location, city,
    display_price, bedrooms, builtup_area,
    short_description, is_published, is_featured)
  values ('5bhk-independent-house-ashok-nagar', '5 BHK Independent House – Ashok Nagar', 'Independent House', 'For Rent', 'Available',
    'Ashok Nagar', 'Chennai', '₹1.50 Lakhs / Month', 5, '3,700 Sq.Ft.',
    'Very close to metro & pillar.', true, true)
  returning id into v_id;
  insert into property_images (property_id, storage_path, public_url, alt_text, is_featured_image, sort_order)
  values (v_id, '', base_url || '/images/properties/prop-4-ashok-nagar.jpg',
    'Interior of independent house for rent in Ashok Nagar', true, 0);

  -- Property 5
  insert into properties (slug, title, category, listing_type, status, location, city,
    display_price, bedrooms, builtup_area, uds, property_age, floor_number, car_parking,
    short_description, is_published, is_featured)
  values ('2bhk-flat-thiruvanmiyur-rajaji-nagar', '2 BHK Flat – Thiruvanmiyur, Rajaji Nagar', 'Flat', 'For Sale', 'Available',
    'Thiruvanmiyur – Rajaji Nagar', 'Chennai', 'Price on Request', 2, '900 Sq.Ft.', '508 Sq.Ft.', '6 Years',
    '1st Floor', '1 Covered Car Park',
    'Lift available.', true, true)
  returning id into v_id;
  insert into property_images (property_id, storage_path, public_url, alt_text, is_featured_image, sort_order)
  values (v_id, '', base_url || '/images/properties/prop-5-thiruvanmiyur.jpg',
    'Interior hallway of 2 BHK flat for sale in Thiruvanmiyur, Rajaji Nagar', true, 0);

end $$;
