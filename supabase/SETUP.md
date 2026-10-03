# DGSS Realty CMS — one-time setup

Do this once. Takes about 10 minutes.

## 1. Create the Supabase project

1. Go to https://supabase.com → Sign up / log in (free).
2. Click **New Project**.
3. Name it something like `dgss-realty` (keep it separate from your Aventrix project).
4. Set a strong database password and save it somewhere safe.
5. Pick a region close to Chennai (e.g. Singapore) for faster loading.
6. Wait ~2 minutes for it to finish provisioning.

## 2. Run the database schema

1. In your new project, go to **SQL Editor** (left sidebar) → **New query**.
2. Open `supabase/schema.sql` from this project, copy the whole file, paste it in, click **Run**.
3. You should see "Success. No rows returned."
4. Then run `supabase/add-founder-settings.sql`, and every file in `supabase/migrations/` in order (01 → 05) — see `supabase/migrations/README.md`.

## 3. (Optional) Load your existing 5 properties

1. Open `supabase/seed-existing-properties.sql`, replace `YOUR-DOMAIN` near the top with your actual live domain (e.g. `dgssrealty.pages.dev` or your custom domain).
2. Paste the whole file into a new SQL Editor query, click **Run**.
3. Go to **Table Editor → properties** — you should see all 5 listed.

## 4. Get your project keys

1. Go to **Project Settings** (gear icon) → **API**.
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **anon / public** key (a long string starting with `eyJ...`). Do NOT copy the `service_role` key — never put that one in website code.

## 5. Add the keys to the site

1. Open `js/supabase-client.js` in this project.
2. Replace `YOUR_SUPABASE_PROJECT_URL` with your Project URL.
3. Replace `YOUR_SUPABASE_ANON_KEY` with your anon key.
4. Save, then deploy with `npx wrangler deploy` (GitHub pushes do not deploy on their own).

## 6. Create your admin login

1. In Supabase, go to **Authentication → Users → Add user**.
2. Enter your email and a password. Leave "Auto Confirm User" checked.
3. That's your login for `/admin/login.html`.

Creating a login is NOT enough to get into the admin panel — the account must also be on the staff list with a role (super_admin, admin, editor, sales or viewer). After the first super admin exists, add everyone else from **Admin → Staff Management** (no SQL needed). Also turn off public sign-ups (Authentication → Providers → Email → "Allow new users to sign up").

## 7. Test it

1. Visit `/admin/login.html` on your deployed site, log in.
2. You should land on the dashboard showing your 5 properties.
3. Visit your normal homepage — properties should still load exactly as before (now coming live from the database instead of the hardcoded list).

## If something looks broken

If Supabase can't be reached, the homepage shows **"Property listings are temporarily unavailable"** with Call and WhatsApp buttons — it never shows old or sample listings, because stale prices must not look live. Contact buttons then use the emergency defaults in `src/site-defaults.js`. If Supabase works but nothing is published, the homepage honestly says new listings are being added.

All contact details, logo, social links, hero text, founder text and SEO defaults come from **Admin → Contact Details / Branding / Homepage / SEO**. Don't edit them in the HTML — the build's tests fail if contact details are hardcoded anywhere else.
