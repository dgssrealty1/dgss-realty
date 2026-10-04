/* ==========================================================================
   CMS → PUBLIC HTML
   --------------------------------------------------------------------------
   One mapping from the Supabase `settings` row to every place it appears
   on the public site. Static HTML marks the places with attributes:

     data-cms-text="key"        element text  ("" value → element hidden)
     data-cms-html="hero_heading"  heading with optional accent 2nd line
     data-cms-paras="key"       paragraphs (blank-line separated)
     data-cms-href="key"        link target   ("" value → element hidden)
     data-cms-wa-text="message" pre-filled WhatsApp message (with href=whatsapp)
     data-cms-src="key"         img / iframe source
     data-cms-alt="key"         alt text
     data-cms-picture="key"     <picture> replaced by a plain <img> when set
     data-cms-hide-unless="key" element hidden when that value is empty
     <!--cms:name--> … <!--/cms:name-->   whole regions (head SEO, JSON-LD,
                                         property grid, testimonials, data)

   Content fields (hero, founder) left blank in Admin keep the site's
   built-in wording. Contact fields always come from settings; the only
   fallback is src/site-defaults.js, used when Supabase is unreachable.
   The same keys are applied in the browser by js/common.js for static
   pages (404.html) via /api/site-settings.
   ========================================================================== */
import { SITE_DEFAULTS as D } from "./site-defaults.js";

export const SETTINGS_COLUMNS_V1 = [
  "company_name", "logo_url", "phone", "whatsapp", "email", "office_address", "google_maps_url",
  "instagram_url", "facebook_url", "youtube_url", "default_seo_title", "default_seo_description",
  "hero_heading", "hero_subheading", "hero_cta_text",
  "founder_name", "founder_designation", "founder_location", "founder_experience", "founder_credential_line",
  "founder_photo_url", "founder_bio_intro", "founder_bio_top", "founder_bio_bottom", "founder_quote"
];
// Added by migration 05.
export const SETTINGS_COLUMNS = SETTINGS_COLUMNS_V1.concat([
  "home_seo_title", "home_seo_description", "default_og_image_url", "office_hours"
]);

export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const clean = v => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/* https:// links or /paths on this site only (never javascript:, data:, //host). */
export function safeUrl(v) {
  const s = clean(v);
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (/^\/[A-Za-z0-9][^\s"'<>]*$/.test(s)) return s;
  return "";
}
const safeHttps = v => { const s = safeUrl(v); return s.startsWith("https://") ? s : ""; };

/* Exact coordinates from a full Google Maps place link (Share → open the
   short link → copy the address-bar URL). The place pin ("!3d<lat>!4d<lng>")
   wins over the map-view centre ("@<lat>,<lng>"); "?q=<lat>,<lng>" also
   works. Short maps.app.goo.gl links carry no coordinates → null. */
export function mapCoords(link) {
  const u = safeHttps(link);
  if (!u || !/^https:\/\/(www\.)?(google\.[a-z.]+|maps\.google\.[a-z.]+)\//i.test(u)) return null;
  const num = "(-?\\d{1,3}\\.\\d+)";
  const m = u.match(new RegExp(`!3d${num}!4d${num}`)) || u.match(new RegExp(`@${num},${num}`)) ||
    u.match(new RegExp(`[?&](?:q|query|ll)=${num},(?:%20|\\+)?${num}(?:&|$)`));
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat: m[1], lng: m[2] } : null;
}
export function mapEmbedUrl(coords, address) {
  if (coords) return `https://maps.google.com/maps?q=${coords.lat},${coords.lng}&z=17&output=embed`;
  return address ? `https://maps.google.com/maps?q=${encodeURIComponent(address)}&z=16&output=embed` : "";
}
const validEmail = v => { const s = clean(v); return /^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i.test(s) ? s : ""; };

/* Indian 10-digit mobiles get +91; anything else keeps its country code. */
export function telHref(v) {
  const raw = clean(v);
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  return raw.startsWith("+") ? `+${digits}` : digits.length > 10 ? `+${digits}` : digits;
}
export function waDigits(v) {
  const digits = clean(v).replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  return digits;
}

/* raw = the settings row, or null when Supabase couldn't be read. */
export function normalizeSettings(raw) {
  const r = raw || {};
  const live = !!raw;
  const phoneDisplay = clean(r.phone) || D.phone;
  const whatsappDisplay = clean(r.whatsapp) || clean(r.phone) || D.whatsapp;
  const address = clean(r.office_address) || (live ? "" : D.address);
  const company = clean(r.company_name) || D.company;
  return {
    live,
    company,
    phoneDisplay,
    phone: telHref(phoneDisplay),
    whatsappDisplay,
    whatsapp: waDigits(whatsappDisplay),
    email: validEmail(r.email) || D.email,
    address,
    hours: clean(r.office_hours),
    // The admin's own map link wins; otherwise a search for the address.
    mapsUrl: safeHttps(r.google_maps_url) || (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : ""),
    // Exact pin from the admin's Google Maps link when it carries
    // coordinates; otherwise the map searches for the address text.
    mapEmbed: mapEmbedUrl(mapCoords(r.google_maps_url), address),
    logo: safeUrl(r.logo_url) || D.logo,
    socials: {
      instagram: safeHttps(r.instagram_url),
      facebook: safeHttps(r.facebook_url),
      youtube: safeHttps(r.youtube_url)
    },
    hero: { heading: clean(r.hero_heading), subheading: clean(r.hero_subheading), cta: clean(r.hero_cta_text) },
    seo: {
      defaultTitle: clean(r.default_seo_title),
      defaultDescription: clean(r.default_seo_description),
      homeTitle: clean(r.home_seo_title),
      homeDescription: clean(r.home_seo_description),
      ogImage: safeUrl(r.default_og_image_url)
    },
    founder: {
      name: clean(r.founder_name),
      designation: clean(r.founder_designation),
      location: clean(r.founder_location),
      experience: clean(r.founder_experience),
      credentialLine: clean(r.founder_credential_line),
      photo: safeUrl(r.founder_photo_url),
      bioIntro: clean(r.founder_bio_intro),
      bioTop: clean(r.founder_bio_top),
      bioBottom: clean(r.founder_bio_bottom),
      quote: clean(r.founder_quote)
    }
  };
}

/* What the browser may see (embedded in pages / served by /api/site-settings). */
export function publicSettings(s) {
  return {
    company: s.company, phone: s.phone, phoneDisplay: s.phoneDisplay, whatsapp: s.whatsapp,
    whatsappDisplay: s.whatsappDisplay, email: s.email, address: s.address, hours: s.hours,
    mapsUrl: s.mapsUrl, mapEmbed: s.mapEmbed, logo: s.logo, socials: { ...s.socials }
  };
}

const initials = name => String(name || "").split(/\s+/).filter(Boolean)
  .filter(w => /[A-Za-z]/.test(w)).slice(0, 2).map(w => w.replace(/[^A-Za-z]/g, "")[0].toUpperCase()).join("");

/* null = leave the element as it is; "" = hide it; anything else = use it. */
export function cmsValue(kind, key, s) {
  const f = s.founder;
  if (kind === "text") {
    switch (key) {
      case "company": return s.company;
      case "phone": return s.phoneDisplay;
      case "whatsapp": return s.whatsappDisplay;
      case "email": return s.email;
      case "address": return s.address;
      case "hours": return s.hours;
      case "year": return String(new Date().getFullYear());
      case "hero_subheading": return s.hero.subheading || null;
      case "hero_cta": return s.hero.cta || null;
      case "founder_name": return f.name || null;
      case "founder_designation": return f.designation || null;
      case "founder_designation_comma": return f.designation ? `${f.designation}, ${s.company}` : null;
      case "founder_designation_dash": return f.designation ? `${f.designation} – ${s.company}` : null;
      case "founder_location": return f.location || null;
      case "founder_experience": return f.experience || null;
      case "founder_credential_line": return f.credentialLine || null;
      case "founder_bio_intro": return f.bioIntro || null;
      case "founder_quote": return f.quote || null;
      case "founder_initials": return f.name ? (initials(f.name) || null) : null;
      default: return null;
    }
  }
  if (kind === "href") {
    switch (key) {
      case "tel": return s.phone ? `tel:${s.phone}` : "";
      case "whatsapp": return s.whatsapp ? `https://wa.me/${s.whatsapp}` : "";
      case "mailto": return s.email ? `mailto:${s.email}` : "";
      case "maps": return s.mapsUrl;
      case "instagram": case "facebook": case "youtube": return s.socials[key];
      default: return null;
    }
  }
  if (kind === "src") {
    switch (key) {
      case "logo": return s.logo;
      case "map_embed": return s.mapEmbed;
      case "founder_photo": return f.photo || null;
      default: return null;
    }
  }
  if (kind === "alt") {
    switch (key) {
      case "company": return s.company;
      case "founder_photo": {
        const name = f.name;
        if (!name) return null;
        return f.designation ? `${name}, ${f.designation} of ${s.company}` : name;
      }
      default: return null;
    }
  }
  return null;
}

/* A heading made of several short sentences ("Discover the Right Property.
   Make the Right Deal.") gets one span per sentence, so each sentence starts
   on its own line and never breaks awkwardly mid-phrase on phones. A single
   sentence is returned exactly as before. */
export function heroSentencesHtml(text) {
  const parts = String(text || "").split(/(?<=[.!?])\s+(?=\S)/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return esc(String(text || "").trim());
  return parts.map(p => `<span class="hero-h1-part">${esc(p)}</span>`).join(" ");
}
export function heroHeadingHtml(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return heroSentencesHtml(lines[0] || "");
  const last = lines.pop();
  return `${heroSentencesHtml(lines.join(" "))}<br><span class="accent">${esc(last)}</span>`;
}
export function parasHtml(text) {
  return String(text || "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${esc(p)}</p>`).join("");
}

/* ---------------- tiny, strict HTML rewriter for our own markup -------- */
const ATTR_RE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function parseAttrs(str) {
  const list = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(str))) {
    list.push({ name: m[1], raw: m[0], value: m[2] ?? m[3] ?? m[4] ?? null });
  }
  return list;
}
function setAttr(list, name, value) {
  const item = { name, raw: `${name}="${esc(value)}"`, value };
  const i = list.findIndex(a => a.name.toLowerCase() === name);
  if (i >= 0) list[i] = item; else list.push(item);
}
const hasAttr = (list, name) => list.some(a => a.name.toLowerCase() === name);
const getAttr = (list, name) => (list.find(a => a.name.toLowerCase() === name) || {}).value;
const serialize = list => list.map(a => " " + a.raw).join("");

function findClose(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { if (--depth === 0) return { start: m.index, end: re.lastIndex }; }
    else if (!m[0].endsWith("/>")) depth++;
  }
  return null;
}

const OPEN_RE = /<([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*?\bdata-cms-[a-z-]+[^<>]*?)(\/?)>/g;

/* regions: { name: html } replaces <!--cms:name-->…<!--/cms:name-->. */
export function applyCms(html, s, regions = {}) {
  let out = String(html).replace(/<!--cms:([a-z0-9-]+)-->([\s\S]*?)<!--\/cms:\1-->/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(regions, name) ? `<!--cms:${name}-->${regions[name]}<!--/cms:${name}-->` : m);

  let result = "";
  let i = 0;
  let m;
  OPEN_RE.lastIndex = 0;
  while ((m = OPEN_RE.exec(out))) {
    result += out.slice(i, m.index);
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    let inner = null;
    let hide = false;

    const textKey = getAttr(attrs, "data-cms-text");
    const htmlKey = getAttr(attrs, "data-cms-html");
    const parasKey = getAttr(attrs, "data-cms-paras");
    const hrefKey = getAttr(attrs, "data-cms-href");
    const srcKey = getAttr(attrs, "data-cms-src");
    const altKey = getAttr(attrs, "data-cms-alt");
    const pictureKey = getAttr(attrs, "data-cms-picture");
    const hideUnless = getAttr(attrs, "data-cms-hide-unless");

    if (textKey) {
      const v = cmsValue("text", textKey, s);
      if (v === "") hide = true; else if (v !== null) inner = esc(v);
    }
    if (htmlKey === "hero_heading" && s.hero.heading) inner = heroHeadingHtml(s.hero.heading);
    if (parasKey) {
      const v = parasKey === "founder_bio_top" ? s.founder.bioTop : parasKey === "founder_bio_bottom" ? s.founder.bioBottom : "";
      if (v) inner = parasHtml(v);
    }
    if (hrefKey) {
      let v = cmsValue("href", hrefKey, s);
      if (v === "") hide = true;
      else if (v !== null) {
        const msg = getAttr(attrs, "data-cms-wa-text");
        if (msg && hrefKey === "whatsapp") v += `?text=${encodeURIComponent(msg.replace(/\{company\}/g, s.company))}`;
        setAttr(attrs, "href", v);
      }
    }
    if (srcKey) {
      const v = cmsValue("src", srcKey, s);
      if (v === "") hide = true; else if (v !== null) setAttr(attrs, "src", v);
    }
    if (altKey) {
      const v = cmsValue("alt", altKey, s);
      if (v) setAttr(attrs, "alt", v);
      if (altKey === "company" && hasAttr(attrs, "aria-label")) setAttr(attrs, "aria-label", `${s.company} home`);
    }
    if (hideUnless) {
      const v = cmsValue("text", hideUnless, s) ?? cmsValue("href", hideUnless, s) ?? cmsValue("src", hideUnless, s);
      if (!v) hide = true;
    }
    if (hide && !hasAttr(attrs, "hidden")) attrs.push({ name: "hidden", raw: "hidden", value: "" });

    if (pictureKey && tag === "picture") {
      const v = cmsValue("src", pictureKey, s);
      const close = findClose(out, "picture", OPEN_RE.lastIndex);
      if (v && close) {
        // Replace <picture>…</picture> with the inner <img>, pointing at the new photo.
        const body = out.slice(OPEN_RE.lastIndex, close.start);
        const imgMatch = body.match(/<img\b([^<>]*?)\/?>/i);
        const imgAttrs = parseAttrs(imgMatch ? imgMatch[1] : "");
        setAttr(imgAttrs, "src", v);
        const alt = cmsValue("alt", pictureKey, s);
        if (alt) setAttr(imgAttrs, "alt", alt);
        result += `<img${serialize(imgAttrs)}>`;
        i = close.end;
        OPEN_RE.lastIndex = close.end;
        continue;
      }
    }

    if (inner !== null && !m[3]) {
      const close = findClose(out, tag, OPEN_RE.lastIndex);
      if (close) {
        result += `<${tag}${serialize(attrs)}>${inner}</${tag}>`;
        i = close.end;
        OPEN_RE.lastIndex = close.end;
        continue;
      }
    }
    result += `<${tag}${serialize(attrs)}${m[3] ? " /" : ""}>`;
    i = OPEN_RE.lastIndex;
  }
  result += out.slice(i);
  return result;
}
