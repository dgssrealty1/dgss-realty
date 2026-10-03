-- TEST-ONLY: Admin settings for the e2e run (distinct values so the
-- browser test can prove the public site reads them).
update settings set
  company_name = 'DGSS Realty', phone = '+91 90000 11111', whatsapp = '+91 90000 22222',
  email = 'hello@e2e.example', office_address = '12 Test Street, Adyar, Chennai - 600020',
  office_hours = 'Mon–Sat 10–6', instagram_url = 'https://instagram.com/e2e',
  hero_heading = 'E2E hero heading' || chr(10) || 'Accent line', hero_cta_text = 'Browse Listings'
where id = 1;
insert into admin_users(user_id, role, display_name)
  select id, 'admin', 'Asha Admin' from auth.users where email = 'admin@test.local' on conflict do nothing;
-- 45 leads for pagination
insert into leads(name, phone, source, lead_type, status, created_at)
  select 'Lead ' || g, '98410' || lpad(g::text, 5, '0'), 'contact_form', 'general_contact',
         (array['New','Contacted','Follow-up'])[1 + g % 3], now() - (g || ' hours')::interval
  from generate_series(1, 45) g;
