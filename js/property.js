/* ==========================================================================
   DGSS REALTY — PROPERTY / AREA PAGE SCRIPT
   Gallery (thumbs, prev/next, swipe, keyboard, full-screen), share,
   enquiry form, mobile menu. Works without Supabase in the browser — the
   page itself is rendered on the server with the property's data.
   ========================================================================== */
(function () {
  "use strict";
  const DGSS = window.DGSS || { track() {}, submitLead: async () => ({ ok: false }), validators: {} };

  let pageData = null;
  try {
    const node = document.getElementById("pageData");
    if (node) pageData = JSON.parse(node.textContent);
  } catch (_) { pageData = null; }

  /* ---------- mobile menu ---------- */
  function initMobileNav() {
    const hamburger = document.getElementById("hamburger");
    const nav = document.getElementById("mobileNav");
    const overlay = document.getElementById("mobileNavOverlay");
    const closeBtn = document.getElementById("mobileNavClose");
    if (!hamburger || !nav || !overlay) return;
    const open = () => { nav.classList.add("open"); overlay.classList.add("open"); hamburger.setAttribute("aria-expanded", "true"); document.body.classList.add("no-scroll"); (closeBtn || nav).focus(); };
    const close = () => { nav.classList.remove("open"); overlay.classList.remove("open"); hamburger.setAttribute("aria-expanded", "false"); document.body.classList.remove("no-scroll"); };
    hamburger.addEventListener("click", () => (nav.classList.contains("open") ? close() : open()));
    overlay.addEventListener("click", close);
    if (closeBtn) closeBtn.addEventListener("click", () => { close(); hamburger.focus(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && nav.classList.contains("open")) { close(); hamburger.focus(); } });
    nav.querySelectorAll("a").forEach(a => a.addEventListener("click", close));
  }

  /* ---------- gallery ---------- */
  function initGallery() {
    const root = document.querySelector("[data-gallery]");
    if (!root) return;
    const slides = Array.from(root.querySelectorAll(".pg-slide"));
    const thumbs = Array.from(root.querySelectorAll("[data-goto]"));
    const current = root.querySelector("[data-current]");
    const lightbox = document.getElementById("pgLightbox");
    const lbImg = lightbox && lightbox.querySelector(".pg-lb-img");
    const lbCounter = lightbox && lightbox.querySelector(".pg-lb-counter");
    const images = (pageData && pageData.images) || [];
    let index = 0;

    function show(i) {
      if (!slides.length) return;
      index = (i + slides.length) % slides.length;
      slides.forEach((s, si) => {
        const on = si === index;
        s.classList.toggle("is-active", on);
        if (on) s.removeAttribute("aria-hidden"); else s.setAttribute("aria-hidden", "true");
        // Load the image being shown (and the next one) on demand.
        if (on || si === (index + 1) % slides.length) {
          const img = s.querySelector("img");
          if (img && img.loading === "lazy") img.loading = "eager";
        }
      });
      thumbs.forEach((t, ti) => {
        const on = ti === index;
        t.classList.toggle("is-active", on);
        if (on) { t.setAttribute("aria-current", "true"); t.scrollIntoView({ block: "nearest", inline: "nearest" }); }
        else t.removeAttribute("aria-current");
      });
      if (current) current.textContent = String(index + 1);
      if (lightbox && lightbox.open) renderLightbox();
    }

    function renderLightbox() {
      const img = images[index];
      if (!img || !lbImg) return;
      lbImg.src = img.src;
      lbImg.alt = img.alt;
      if (lbCounter) lbCounter.textContent = `${index + 1} / ${images.length}`;
    }

    root.querySelectorAll("[data-prev]").forEach(b => b.addEventListener("click", () => show(index - 1)));
    root.querySelectorAll("[data-next]").forEach(b => b.addEventListener("click", () => show(index + 1)));
    thumbs.forEach(t => t.addEventListener("click", () => show(Number(t.dataset.goto))));

    // Keyboard (when focus is inside the gallery)
    root.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft") { show(index - 1); e.preventDefault(); }
      if (e.key === "ArrowRight") { show(index + 1); e.preventDefault(); }
    });

    // Touch swipe
    const stage = root.querySelector(".pg-slides");
    let startX = null, startY = null;
    if (stage) {
      stage.addEventListener("touchstart", e => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
      stage.addEventListener("touchend", e => {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(index + (dx < 0 ? 1 : -1));
        startX = startY = null;
      });
    }

    // Full screen (native <dialog>: focus trap + Esc for free)
    const openBtn = root.querySelector("[data-fullscreen]");
    let lastFocus = null;
    if (lightbox && openBtn && typeof lightbox.showModal === "function") {
      const openLb = () => { lastFocus = document.activeElement; renderLightbox(); lightbox.showModal(); };
      openBtn.addEventListener("click", openLb);
      slides.forEach(s => s.addEventListener("click", openLb));
      lightbox.querySelector("[data-lb-close]").addEventListener("click", () => lightbox.close());
      lightbox.querySelector("[data-lb-prev]").addEventListener("click", () => show(index - 1));
      lightbox.querySelector("[data-lb-next]").addEventListener("click", () => show(index + 1));
      lightbox.addEventListener("keydown", e => {
        if (e.key === "ArrowLeft") show(index - 1);
        if (e.key === "ArrowRight") show(index + 1);
      });
      lightbox.addEventListener("close", () => { if (lastFocus) lastFocus.focus(); });
      if (images.length < 2) lightbox.querySelectorAll("[data-lb-prev],[data-lb-next]").forEach(b => { b.hidden = true; });
    } else if (openBtn) {
      openBtn.hidden = true;
    }
  }

  /* ---------- share ---------- */
  function initShare() {
    const status = document.querySelector(".pd-copied");
    const flash = msg => { if (status) { status.textContent = msg; setTimeout(() => { status.textContent = ""; }, 2200); } };
    async function copy(url) {
      try { await navigator.clipboard.writeText(url); flash("Link copied"); }
      catch (_) { window.prompt("Copy this link:", url); }
      DGSS.track("property_share", { method: "copy_link" });
    }
    document.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copy(b.dataset.url)));
    document.querySelectorAll("[data-share]").forEach(b => b.addEventListener("click", async () => {
      const url = b.dataset.url;
      if (navigator.share) {
        try { await navigator.share({ title: b.dataset.title, text: `${b.dataset.title} — DGSS Realty`, url }); DGSS.track("property_share", { method: "native" }); }
        catch (_) { /* user cancelled */ }
      } else {
        copy(url);
      }
    }));
  }

  /* ---------- enquiry form ---------- */
  function initEnquiryForm() {
    const form = document.getElementById("enquiryForm");
    if (!form) return;
    const status = form.querySelector(".form-status");
    const button = form.querySelector('button[type="submit"]');
    const setStatus = (msg, kind) => { status.textContent = msg; status.className = "form-status" + (kind ? " is-" + kind : ""); };
    const V = DGSS.validators || {};

    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (pageData && pageData.preview) { setStatus("This is a preview — enquiries are disabled.", "error"); return; }

      const get = name => (form.elements[name] ? form.elements[name].value.trim() : "");
      const checks = [
        ["name", V.name ? V.name(get("name")) : get("name").length >= 2],
        ["phone", V.phone ? V.phone(get("phone")) : !!get("phone")],
        ["email", V.email ? V.email(get("email")) : true],
        ["message", get("message").length <= 2000]
      ];
      let firstBad = null;
      checks.forEach(([name, ok]) => {
        const field = form.elements[name] && form.elements[name].closest(".field");
        if (field) field.classList.toggle("invalid", !ok);
        if (form.elements[name]) form.elements[name].setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok && !firstBad) firstBad = form.elements[name];
      });
      if (firstBad) { firstBad.focus(); setStatus("Please check the highlighted fields.", "error"); return; }

      const turnstile = form.querySelector('[name="cf-turnstile-response"]');
      button.disabled = true;
      const label = button.textContent;
      button.textContent = "Sending…";
      setStatus("", "");

      const result = await DGSS.submitLead({
        source: "property_enquiry",
        propertyId: get("propertyId") || null,
        name: get("name"), phone: get("phone"), email: get("email"), message: get("message"),
        website: get("website"),
        turnstileToken: turnstile ? turnstile.value : undefined
      });

      button.disabled = false;
      button.textContent = label;
      if (result.ok) {
        setStatus("Thank you! Your enquiry has been sent. We'll contact you shortly.", "success");
        DGSS.track("enquiry_submit", { source: "property_page" });
        form.reset();
        if (window.turnstile) try { window.turnstile.reset(); } catch (_) { /* ignore */ }
      } else {
        setStatus(result.message || "Something went wrong. Please call or WhatsApp us.", "error");
        if (window.turnstile) try { window.turnstile.reset(); } catch (_) { /* ignore */ }
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMobileNav();
    initGallery();
    initShare();
    initEnquiryForm();
    if (pageData && pageData.url && !pageData.preview) DGSS.track("property_view", { property: new URL(pageData.url).pathname });
  });
})();
