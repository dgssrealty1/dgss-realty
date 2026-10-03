/* ==========================================================================
   EMERGENCY FALLBACK ONLY
   --------------------------------------------------------------------------
   The single source of truth for every public contact detail is the
   Supabase `settings` row (Admin → Contact Details / Settings). These
   values are used ONLY when that row can't be read (Supabase outage) or a
   required field is blank, so Call / WhatsApp / Email buttons never go
   dead. Nothing else in the codebase may hardcode contact details —
   tests/static-audit.test.mjs fails the build if anything does.
   ========================================================================== */
export const SITE_DEFAULTS = Object.freeze({
  company: "DGSS Realty",
  phone: "+91 98410 09059",
  whatsapp: "+91 98410 09059",
  email: "info@dgssrealty.com",
  address: "G2, Vidhya Apartments, No.45, Bazaar Street, KK Nagar West, Chennai - 600078",
  logo: "/icons/dgss-realty-logo-262.png",
  ogImage: "/images/hero-new/hero-apartment.jpg"
});
