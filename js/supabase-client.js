/* ==========================================================================
   SUPABASE CLIENT — shared by the public site and the admin panel
   ------------------------------------------------------------------------
   Fill in SUPABASE_URL and SUPABASE_ANON_KEY below once you've created
   your Supabase project (see /supabase/SETUP.md for exact steps).

   IMPORTANT: the "anon" key is meant to be public — it's safe to ship in
   frontend JavaScript. It only allows what your Row Level Security
   policies (see schema.sql) explicitly permit: public read of published
   content, public insert of leads, and nothing else without a logged-in
   admin session. Never put your Supabase "service_role" key here or
   anywhere in frontend code — that key bypasses RLS entirely.
   ========================================================================== */

const SUPABASE_URL = "https://uiirwgzyuhxyerakvzzf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_vmxX9w4jlsBROUKBn181hA_quVr-0ts";
// Loaded via the CDN script tag in index.html / admin pages:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
//
// Explicitly attached to `window` (not just a top-level const) so that
// script.js — a separate <script> tag — can reliably check for it with
// `window.supabaseClient` even across classic (non-module) script
// boundaries. Wrapped in try/catch and a placeholder check so that
// deploying this file before running through supabase/SETUP.md can
// never throw and break the whole page — it just quietly stays null,
// and script.js's fallback to the built-in sample properties kicks in.
window.supabaseClient = null;
const isConfigured = window.supabase && !SUPABASE_URL.includes("YOUR_SUPABASE") && !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

if (isConfigured) {
  try {
    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.error("Supabase client failed to initialize — check the URL/key in js/supabase-client.js.", err);
  }
} else {
  console.info("Supabase isn't configured yet — see supabase/SETUP.md. The site will use its built-in sample data until then.");
}
