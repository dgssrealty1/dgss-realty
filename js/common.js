/* ==========================================================================
   DGSS REALTY — SHARED BROWSER HELPERS (homepage + property/area pages)
   --------------------------------------------------------------------------
   window.DGSS.track(event, params)   privacy-friendly conversion hook
   window.DGSS.submitLead(payload)    the one way forms save enquiries
   window.DGSS.esc(value)             HTML-escape for innerHTML templates
   window.DGSS.applySettings(s)       fill data-cms-* markers (static pages)
   window.DGSS.siteSettingsReady      Promise of the public contact details
   ========================================================================== */
(function () {
  "use strict";

  /* Analytics hook. No analytics tool is installed on this site today, so
     this only forwards to one if you add it later (Google Analytics 4 via
     gtag, or Google Tag Manager via dataLayer). No personal data (names,
     phones, emails, messages) is ever passed — only event names and
     non-identifying context such as a property slug or a filter value. */
  function track(event, params) {
    const data = Object.assign({}, params || {});
    try {
      if (typeof window.gtag === "function") window.gtag("event", event, data);
      else if (Array.isArray(window.dataLayer)) window.dataLayer.push(Object.assign({ event }, data));
    } catch (_) { /* never let analytics break the page */ }
  }

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  const FRIENDLY = {
    invalid_name: "Please enter your name (2–100 characters).",
    invalid_phone: "Please enter a valid phone number (8–15 digits).",
    invalid_whatsapp: "Please enter a valid WhatsApp number, or leave it blank.",
    invalid_email: "Please enter a valid email address, or leave it blank.",
    message_too_long: "Please keep your message under 2,000 characters.",
    invalid_property: "This property is no longer available. Please contact us directly.",
    rate_limited: "We've received several enquiries from you recently — we'll be in touch soon, or call us directly.",
    server_error: "We couldn't save your enquiry right now. Please call or WhatsApp us."
  };

  /* payload: { source, name, phone, email, whatsapp, message, propertyId,
                details: {label: value}, website (honeypot), turnstileToken }
     Resolves to { ok: true } or { ok: false, error, message, offline }.
     Route 1: the site's Worker at /api/lead (validation + optional
       Turnstile, then the database's submit_lead()).
     Route 2 (only if the Worker endpoint isn't there, e.g. when the site
       is opened as plain static files): call submit_lead() directly with
       the public key — the database still validates and rate-limits. */
  async function submitLead(payload) {
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const ct = res.headers.get("Content-Type") || "";
      if (ct.includes("application/json")) {
        const data = await res.json();
        if (!data.ok && !data.message) data.message = FRIENDLY[data.error] || FRIENDLY.server_error;
        return data;
      }
      if (res.status !== 404 && res.status !== 405) {
        return { ok: false, error: "server_error", message: FRIENDLY.server_error };
      }
    } catch (err) {
      console.warn("Lead endpoint unreachable, trying database directly.", err);
    }

    if (window.supabaseClient) {
      const { data, error } = await window.supabaseClient.rpc("submit_lead", {
        p_source: payload.source,
        p_name: payload.name || null,
        p_phone: payload.phone || null,
        p_email: payload.email || null,
        p_whatsapp: payload.whatsapp || null,
        p_message: payload.message || null,
        p_property_id: payload.propertyId || null,
        p_source_details: payload.details && Object.keys(payload.details).length ? payload.details : null,
        p_honeypot: payload.website || null
      });
      if (error) {
        console.error("submit_lead failed:", error);
        return { ok: false, error: "server_error", message: FRIENDLY.server_error, offline: true };
      }
      if (data && data.ok) return { ok: true };
      const code = (data && data.error) || "server_error";
      return { ok: false, error: code, message: FRIENDLY[code] || FRIENDLY.server_error };
    }
    return { ok: false, error: "server_error", message: FRIENDLY.server_error, offline: true };
  }

  /* Basic client-side checks that mirror the server's rules, so visitors
     get instant feedback. The server re-checks everything. */
  const validators = {
    phone: v => /^\+?[0-9 ()\-.]{8,25}$/.test(v) && v.replace(/\D/g, "").length >= 8 && v.replace(/\D/g, "").length <= 15,
    email: v => !v || /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(v),
    name: v => v.length >= 2 && v.length <= 100
  };

  // Delegate clicks on anything marked data-track="event_name".
  document.addEventListener("click", e => {
    const el = e.target.closest && e.target.closest("[data-track]");
    if (!el) return;
    const params = {};
    if (el.dataset.trackMethod) params.method = el.dataset.trackMethod;
    const page = document.getElementById("pageData");
    if (page) {
      try { params.property = new URL(JSON.parse(page.textContent).url).pathname; } catch (_) { /* ignore */ }
    }
    track(el.dataset.track, params);
  });

  /* Contact details on static pages (404.html, or the homepage opened
     without the Worker). Same data-cms-* conventions and the same values
     as the Worker (src/cms.js) — Admin → Contact Details is the only
     source; /api/site-settings serves it. Pages rendered by the Worker
     already contain the values, so nothing is fetched there. */
  function hrefFor(key, s) {
    switch (key) {
      case "tel": return s.phone ? "tel:" + s.phone : "";
      case "whatsapp": return s.whatsapp ? "https://wa.me/" + s.whatsapp : "";
      case "mailto": return s.email ? "mailto:" + s.email : "";
      case "maps": return s.mapsUrl || "";
      case "instagram": case "facebook": case "youtube": return (s.socials && s.socials[key]) || "";
      default: return null;
    }
  }
  function textFor(key, s) {
    switch (key) {
      case "company": return s.company || null;
      case "phone": return s.phoneDisplay || "";
      case "whatsapp": return s.whatsappDisplay || s.phoneDisplay || "";
      case "email": return s.email || "";
      case "address": return s.address || "";
      case "hours": return s.hours || "";
      default: return null;
    }
  }
  const safe = u => /^(https:\/\/|tel:|mailto:|\/[A-Za-z0-9])[^\s"'<>]*$/i.test(String(u || ""));
  function applySettings(s, root) {
    if (!s) return;
    const scope = root || document;
    scope.querySelectorAll("[data-cms-text]").forEach(el => {
      const v = textFor(el.dataset.cmsText, s);
      if (v === "") el.hidden = true; else if (v !== null) el.textContent = v;
    });
    scope.querySelectorAll("[data-cms-href]").forEach(el => {
      const v = hrefFor(el.dataset.cmsHref, s);
      if (v === "" || (v && !safe(v))) el.hidden = true;
      else if (v !== null) { el.setAttribute("href", v); el.hidden = false; }
    });
    scope.querySelectorAll("[data-cms-src]").forEach(el => {
      const key = el.dataset.cmsSrc;
      const v = key === "logo" ? s.logo : key === "map_embed" ? s.mapEmbed : null;
      if (v === "") el.hidden = true; else if (v && (safe(v) || key === "map_embed")) el.setAttribute("src", v);
    });
    scope.querySelectorAll('[data-cms-alt="company"]').forEach(el => {
      if (!s.company) return;
      if (el.tagName === "IMG") el.alt = s.company;
      else if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", s.company + " home");
    });
    scope.querySelectorAll("[data-cms-hide-unless]").forEach(el => {
      const key = el.dataset.cmsHideUnless;
      const v = textFor(key, s) ?? hrefFor(key, s) ?? (key === "map_embed" ? s.mapEmbed : null);
      if (!v) el.hidden = true;
    });
  }

  let siteSettingsReady = Promise.resolve(null);
  const embedded = document.getElementById("homeData") || document.getElementById("pageData");
  const needsSettings = !embedded && document.querySelector("[data-cms-href],[data-cms-text]");
  if (needsSettings && typeof fetch === "function") {
    siteSettingsReady = fetch("/api/site-settings", { headers: { Accept: "application/json" } })
      .then(r => (r.ok && (r.headers.get("Content-Type") || "").includes("application/json") ? r.json() : null))
      .then(s => {
        if (s) {
          if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => applySettings(s));
          else applySettings(s);
        }
        return s;
      })
      .catch(() => null);
  }

  window.DGSS = { track, esc, submitLead, validators, applySettings, siteSettingsReady };
})();
