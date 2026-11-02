// YT TL;DW - UI half (isolated world).
//
// Watches hovers on video cards with delegated listeners, shows a small
// popover after a ~1 s dwell, and asks the page half (main-world.js) for a
// summary over window.postMessage. Results are cached per videoId in memory
// only, for the life of the page. Everything is rendered with textContent;
// nothing from the network or from messages is ever parsed as HTML.
(() => {
  "use strict";
  if (window.__tldwUi) return;
  window.__tldwUi = true;

  const ORIGIN = location.origin;
  const DWELL_MS = 1000;
  // The dwell only counts while the pointer rests: moving further than this
  // restarts it, so sweeping across the grid never opens anything.
  const SETTLE_PX = 32;
  const CLOSE_GRACE_MS = 300;
  const FADE_OUT_MS = 100; // keep in step with the .tldw-pop transition
  const MAX_INFLIGHT = 2;
  const ACTIVE_PATHS = new Set(["/", "/feed/subscriptions"]);
  const CARD_OUTER = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer";
  const CARD_INNER = "yt-lockup-view-model, ytd-rich-grid-media";

  const MESSAGES = {
    logged_out: "Sign in to see summaries",
    unavailable: "Ask isn’t available for your account or region",
    no_ask: "No summary for this video",
    error: "Couldn’t load summary",
    error_final: "Couldn’t load summary. Try again later.",
  };

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const cache = new Map(); // videoId -> { status: "ok", bullets | text } | { status: "no_ask" }
  const pending = new Map(); // request id -> videoId
  let sessionStatus = null; // "logged_out" | "unavailable" once known
  let queued = null; // videoId waiting for a free request slot
  let seq = 0;

  let hoverCard = null; // card under the pointer or holding keyboard focus
  let dwellTimer = 0;
  let dwellAt = null; // pointer position the dwell is measured from
  let lastPointer = null; // last pointermove position
  // Set when the page scrolls: a card that slides under a still pointer is
  // not a hover, so no dwell starts until the pointer really moves.
  let parkedAt = null;
  let closeTimer = 0;
  let hideTimer = 0;
  let open = null; // { card, videoId, reqId, retried }

  // ---------- helpers ----------

  function isActivePage() {
    return ACTIVE_PATHS.has(location.pathname);
  }

  function cardFrom(el) {
    if (!(el instanceof Element)) return null;
    return el.closest(CARD_OUTER) || el.closest(CARD_INNER);
  }

  const LIVE_BADGE_RE = /^(live|live now|upcoming|premiere|premieres)$/i;
  const LIVE_META_RE = /\b(watching|waiting|scheduled for|premieres)\b/i;

  function isLiveOrUpcoming(card) {
    if (card.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer[overlay-style="LIVE"],' +
      'ytd-thumbnail-overlay-time-status-renderer[overlay-style="UPCOMING"],' +
      ".badge-style-type-live-now, .badge-style-type-live-now-alternate"
    )) return true;
    for (const b of card.querySelectorAll("badge-shape, .yt-badge-shape, .badge-shape-wiz, ytd-thumbnail-overlay-time-status-renderer")) {
      if (LIVE_BADGE_RE.test((b.textContent || "").trim())) return true;
    }
    const meta = card.querySelector("yt-content-metadata-view-model, #metadata-line");
    return !!meta && LIVE_META_RE.test(meta.textContent || "");
  }

  // Returns the videoId to summarize, or null to stay silent (Shorts, ads,
  // playlists/mixes, live and upcoming streams, anything without a watch link).
  function videoIdOf(card) {
    if (card.querySelector("ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-promoted-video-renderer, [is-ad]")) return null;
    if (card.closest("ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer")) return null;
    if (card.querySelector('ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer, a[href^="/shorts/"]')) return null;
    if (card.querySelector("yt-collection-thumbnail-view-model, yt-collections-stack, ytd-playlist-thumbnail")) return null;
    const a = card.querySelector('a[href*="/watch?"]');
    if (!a) return null;
    let url;
    try { url = new URL(a.getAttribute("href"), ORIGIN); } catch { return null; }
    const v = url.searchParams.get("v");
    if (!v || !/^[\w-]{11}$/.test(v)) return null;
    if (isLiveOrUpcoming(card)) return null;
    return v;
  }

  const TS = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
  const TS_GROUP_RE = new RegExp(String.raw`\s*[(\[]\s*${TS}(?:\s*[-–]\s*${TS})?(?:\s*[,;]\s*${TS}(?:\s*[-–]\s*${TS})?)*\s*[)\]]`, "g");
  const BULLET_RE = /^(?:[*\-•]|\d+[.)])\s+/;

  function cleanLine(s) {
    return s.replace(/\*\*|__|`/g, "").replace(TS_GROUP_RE, "").replace(/\s+/g, " ").trim();
  }

  function shorten(s, max) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const i = cut.lastIndexOf(" ");
    return (i > max * 0.6 ? cut.slice(0, i) : cut).replace(/[\s,;:.–-]+$/, "") + "…";
  }

  function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

  // Ask answers are markdown. Keep 2-4 short bullets; fall back to 1-2
  // sentences when the answer is not a list.
  function parseAnswer(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bullets = lines
      .filter((l) => BULLET_RE.test(l))
      .map((l) => cleanLine(l.replace(BULLET_RE, "")))
      .filter(Boolean)
      .slice(0, 4)
      .map((b) => shorten(capitalize(b), 110));
    if (bullets.length) return { status: "ok", bullets };
    const flat = cleanLine(lines.join(" "));
    const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) || [flat];
    return { status: "ok", text: shorten(sentences.slice(0, 2).join(" ").trim(), 220) };
  }

  // ---------- popover ----------

  const SVG_NS = "http://www.w3.org/2000/svg";
  const pop = document.createElement("div");
  pop.className = "tldw-pop";
  pop.setAttribute("role", "tooltip");
  pop.hidden = true;
  // Screen readers hear results through a separate, always-present status
  // region: the popover itself is display:none until shown, and a live region
  // that appears together with its text is often not announced.
  const live = document.createElement("div");
  live.className = "tldw-sr";
  live.setAttribute("role", "status");

  const head = document.createElement("div");
  head.className = "tldw-head";
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M12 2c.7 5.1 4.9 9.3 10 10-5.1.7-9.3 4.9-10 10-.7-5.1-4.9-9.3-10-10 5.1-.7 9.3-4.9 10-10z");
  icon.appendChild(path);
  const label = document.createElement("span");
  label.textContent = "Summary";
  head.append(icon, label);
  const body = document.createElement("div");
  body.className = "tldw-body";
  pop.append(head, body);

  pop.addEventListener("click", (e) => {
    const btn = e.target instanceof Element && e.target.closest(".tldw-retry");
    if (!btn || !open) return;
    e.preventDefault();
    e.stopPropagation();
    open.retried = true;
    render({ status: "loading" });
    request(open.videoId);
  });

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The skeleton has the shape of a typical answer (three bullets of two
  // lines each), so the popover keeps its size when the text arrives.
  const SKELETON = [[100, 72], [100, 48], [100, 64]];

  function render(r) {
    const shown = !pop.hidden && pop.classList.contains("tldw-in");
    const fromHeight = shown ? pop.offsetHeight : 0;
    const swap = shown && pop.dataset.state === "loading" && r.status !== "loading";
    body.replaceChildren();
    pop.dataset.state = r.status;
    pop.setAttribute("aria-busy", r.status === "loading" ? "true" : "false");
    let said = "";
    if (r.status === "loading") {
      const ul = el("ul", "tldw-list tldw-skel-list");
      ul.setAttribute("aria-hidden", "true");
      for (const lines of SKELETON) {
        const li = el("li");
        for (const w of lines) {
          const s = el("span", "tldw-skel");
          s.style.width = w + "%";
          li.appendChild(s);
        }
        ul.appendChild(li);
      }
      body.appendChild(ul);
    } else if (r.status === "ok" && r.bullets) {
      const ul = el("ul", "tldw-list");
      for (const b of r.bullets) ul.appendChild(el("li", null, b));
      body.appendChild(ul);
      said = "Summary: " + r.bullets.join(". ");
    } else if (r.status === "ok") {
      body.appendChild(el("p", "tldw-text", r.text || ""));
      said = "Summary: " + (r.text || "");
    } else {
      const canRetry = r.status === "error" && open && !open.retried;
      const key = r.status === "error" && !canRetry ? "error_final" : r.status;
      const row = el("div", "tldw-row");
      row.appendChild(el("p", "tldw-msg", MESSAGES[key] || MESSAGES.error));
      if (canRetry) {
        const b = el("button", "tldw-retry", "Retry");
        b.type = "button";
        row.appendChild(b);
      }
      body.appendChild(row);
      said = MESSAGES[key] || MESSAGES.error;
    }
    live.textContent = said;
    if (open) place(open.card);
    if (!shown) return;
    // Settle into the new size and fade the answer in over the skeleton,
    // instead of snapping.
    if (swap && body.firstElementChild) {
      body.firstElementChild.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
    }
    const toHeight = pop.offsetHeight;
    if (!reducedMotion.matches && Math.abs(toHeight - fromHeight) > 1) {
      pop.animate([{ height: fromHeight + "px" }, { height: toHeight + "px" }], {
        duration: 200,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
  }

  function topBound() {
    let bottom = 0;
    for (const n of document.querySelectorAll("#masthead-container, ytd-feed-filter-chip-bar-renderer")) {
      const r = n.getBoundingClientRect();
      if (r.height > 0 && r.top <= bottom + 4 && r.bottom > bottom) bottom = r.bottom;
    }
    return (bottom || 56) + 8;
  }

  // Beside the card (right, else left) so the thumbnail and its inline
  // preview stay visible; below the thumbnail only when neither side fits.
  function place(card) {
    if (!card.isConnected) return closeNow();
    const cr = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const gap = 18; // clears YouTube's own hover highlight around the card
    const margin = 8;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left;
    let top = cr.top;
    if (cr.right + gap + w <= vw - margin) {
      left = cr.right + gap;
      pop.dataset.side = "right";
    } else if (cr.left - gap - w >= margin) {
      left = cr.left - gap - w;
      pop.dataset.side = "left";
    } else {
      // Single-column layouts: under the thumbnail, or above the card when
      // there is no room below, so the preview player stays uncovered.
      const thumb = card.querySelector("yt-thumbnail-view-model, ytd-thumbnail, #thumbnail") || card;
      const below = thumb.getBoundingClientRect().bottom + gap;
      const above = cr.top - gap - h;
      left = Math.min(Math.max(cr.left + (cr.width - w) / 2, margin), vw - w - margin);
      if (below + h > vh - margin && above >= topBound()) {
        top = above;
        pop.dataset.side = "above";
      } else {
        top = below;
        pop.dataset.side = "below";
      }
    }
    top = Math.max(topBound(), Math.min(top, vh - h - margin));
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }

  function show(card) {
    const videoId = videoIdOf(card);
    if (!videoId) return;
    closeNow();
    open = { card, videoId, reqId: null, retried: false };
    if (!pop.isConnected) document.body.append(pop, live);
    // Start from the hidden state even if the last popover is still fading
    // out, so it never slides over from the previous card.
    clearTimeout(hideTimer);
    hideTimer = 0;
    pop.hidden = true;
    void pop.offsetWidth;
    pop.hidden = false;

    const cached = cache.get(videoId);
    if (cached) {
      render(cached);
    } else if (sessionStatus) {
      render({ status: sessionStatus });
    } else {
      render({ status: "loading" });
      const inflightId = [...pending].find(([, v]) => v === videoId)?.[0];
      if (inflightId) open.reqId = inflightId;
      else request(videoId);
    }
    requestAnimationFrame(() => { if (open && open.card === card) pop.classList.add("tldw-in"); });
  }

  function closeNow() {
    clearTimeout(closeTimer);
    closeTimer = 0;
    if (!open) return;
    if (open.reqId && pending.has(open.reqId)) post({ type: "cancel", id: open.reqId });
    if (queued === open.videoId) queued = null;
    open = null;
    live.textContent = "";
    pop.classList.remove("tldw-in");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = 0; if (!open) pop.hidden = true; }, FADE_OUT_MS + 20);
  }

  function scheduleClose() {
    if (!open || closeTimer) return;
    closeTimer = setTimeout(() => { closeTimer = 0; closeNow(); }, CLOSE_GRACE_MS);
  }

  function cancelClose() {
    clearTimeout(closeTimer);
    closeTimer = 0;
  }

  function cancelDwell() {
    clearTimeout(dwellTimer);
    dwellTimer = 0;
    dwellAt = null;
  }

  function startDwell(card, at) {
    clearTimeout(dwellTimer);
    dwellAt = at;
    dwellTimer = setTimeout(() => {
      dwellTimer = 0;
      dwellAt = null;
      if (hoverCard === card && card.isConnected && isActivePage()) show(card);
    }, DWELL_MS);
  }

  // ---------- messaging ----------

  function post(msg) {
    window.postMessage({ tldw: 1, dir: "req", ...msg }, ORIGIN);
  }

  function request(videoId) {
    if (pending.size >= MAX_INFLIGHT) {
      queued = videoId;
      return;
    }
    const id = "r" + ++seq + "-" + Math.random().toString(36).slice(2, 8);
    pending.set(id, videoId);
    if (open && open.videoId === videoId) open.reqId = id;
    post({ type: "summarize", id, videoId });
  }

  const STATUSES = new Set(["ok", "logged_out", "unavailable", "no_ask", "error", "aborted"]);

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const m = ev.data;
    if (!m || m.tldw !== 1 || m.dir !== "res" || typeof m.id !== "string" || !STATUSES.has(m.status)) return;
    const videoId = pending.get(m.id);
    if (!videoId) return;
    pending.delete(m.id);

    let result = { status: m.status };
    if (m.status === "ok") {
      result = typeof m.text === "string" && m.text.trim() ? parseAnswer(m.text) : { status: "error" };
    }
    if (result.status === "ok" || result.status === "no_ask") {
      cache.set(videoId, result);
    } else if (result.status === "logged_out" || result.status === "unavailable") {
      sessionStatus = result.status;
    }

    const isOpen = open && open.reqId === m.id;
    if (isOpen) {
      open.reqId = null;
      if (result.status === "aborted") request(open.videoId); // raced with a re-hover
      else render(result);
    }

    if (queued && pending.size < MAX_INFLIGHT) {
      const v = queued;
      queued = null;
      if (open && open.videoId === v && !open.reqId) request(v);
    }
  });

  // ---------- hover tracking (delegated) ----------

  // Pointer and keyboard focus both land here: `card` is what the user is now
  // on (null for anything else), `at` the pointer position or null for focus.
  function aim(card, at) {
    if (card === hoverCard) return;
    hoverCard = card;
    cancelDwell();
    if (open) {
      if (open.card === card) { cancelClose(); return; }
      scheduleClose();
    }
    if (card) startDwell(card, at);
  }

  function enterPopover() {
    hoverCard = pop; // sentinel: leaving the popover for empty space must still close it
    cancelDwell();
    cancelClose();
  }

  function onPointerOver(e) {
    // The page scrolled under a pointer that has not moved: not a hover.
    if (parkedAt && Math.hypot(e.clientX - parkedAt.x, e.clientY - parkedAt.y) < 2) return;
    parkedAt = null;
    const t = e.target;
    if (t instanceof Node && pop.contains(t)) return enterPopover();
    // YouTube's inline-preview player is a separate element laid over the
    // hovered thumbnail; being over it still counts as being over that card.
    if (t instanceof Element && t.closest("ytd-video-preview")) return;
    if (!isActivePage()) {
      hoverCard = null;
      cancelDwell();
      if (open) closeNow();
      return;
    }
    aim(cardFrom(t), { x: e.clientX, y: e.clientY });
  }

  function resetAll() {
    hoverCard = null;
    cancelDwell();
    closeNow();
  }

  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointermove", (e) => {
    const x = e.clientX;
    const y = e.clientY;
    lastPointer = { x, y };
    if (parkedAt) {
      // First real move after a scroll: whatever is under the pointer now
      // counts as hovered.
      if (Math.hypot(x - parkedAt.x, y - parkedAt.y) >= 2) onPointerOver(e);
      return;
    }
    if (!dwellTimer || !dwellAt || !(hoverCard instanceof Element)) return;
    if (Math.hypot(x - dwellAt.x, y - dwellAt.y) > SETTLE_PX) startDwell(hoverCard, { x, y });
  }, { capture: true, passive: true });
  document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) { hoverCard = null; cancelDwell(); scheduleClose(); } }, true);
  document.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Node && pop.contains(e.target)) return;
    resetAll();
  }, true);
  // Keyboard focus on a card (Tab, not a click) opens it like a hover does.
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (pop.contains(t)) return enterPopover();
    if (!t.matches(":focus-visible")) return;
    aim(isActivePage() ? cardFrom(t) : null, null);
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (open || dwellTimer)) resetAll(); }, true);
  // A wheel/touch scroll means the user is moving on: close. Other scrolls
  // (scroll anchoring while thumbnails load, programmatic jumps) only move the
  // card, so the popover follows it.
  window.addEventListener("wheel", (e) => {
    parkedAt = { x: e.clientX, y: e.clientY };
    if (open || dwellTimer) resetAll();
  }, { capture: true, passive: true });
  window.addEventListener("touchmove", () => { if (open || dwellTimer) resetAll(); }, { capture: true, passive: true });
  let scrollRaf = 0;
  window.addEventListener("scroll", () => {
    if (lastPointer) parkedAt = lastPointer;
    if (!open || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!open) return;
      const r = open.card.getBoundingClientRect();
      if (r.bottom < topBound() || r.top > window.innerHeight) closeNow();
      else place(open.card);
    });
  }, { capture: true, passive: true });
  window.addEventListener("resize", resetAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) resetAll(); });
  document.addEventListener("yt-navigate-start", resetAll);
  document.addEventListener("yt-navigate-finish", resetAll);
})();
