// YT TL;DW - UI half (isolated world).
//
// Watches hovers on video cards with delegated listeners, shows a small
// popover after a ~1 s dwell, and asks the page half (main-world.js) for a
// summary over window.postMessage. Results are cached per videoId for the tab
// session. Everything is rendered with textContent; nothing from the network
// or from messages is ever parsed as HTML.
(() => {
  "use strict";
  if (window.__tldwUi) return;
  window.__tldwUi = true;

  const ORIGIN = location.origin;
  const DWELL_MS = 1000;
  const CLOSE_GRACE_MS = 300;
  const MAX_INFLIGHT = 2;
  const ACTIVE_PATHS = new Set(["/", "/feed/subscriptions"]);
  const CARD_OUTER = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer";
  const CARD_INNER = "yt-lockup-view-model, ytd-rich-grid-media";
  const STORE_PREFIX = "tldw:v:";

  const MESSAGES = {
    logged_out: "Sign in to YouTube to see summaries",
    unavailable: "YouTube’s Ask isn’t available on this account or in your region",
    no_ask: "No summary for this video",
    error: "Couldn’t load a summary",
  };

  const cache = new Map(); // videoId -> { status: "ok", bullets | text } | { status: "no_ask" }
  const pending = new Map(); // request id -> videoId
  let sessionStatus = null; // "logged_out" | "unavailable" once known
  let queued = null; // videoId waiting for a free request slot
  let seq = 0;

  let hoverCard = null;
  let dwellTimer = 0;
  let closeTimer = 0;
  let open = null; // { card, videoId, reqId, retried }

  // ---------- helpers ----------

  const store = {
    get(id) {
      try { const s = sessionStorage.getItem(STORE_PREFIX + id); return s ? JSON.parse(s) : null; } catch { return null; }
    },
    set(id, v) {
      try { sessionStorage.setItem(STORE_PREFIX + id, JSON.stringify(v)); } catch { /* quota or blocked */ }
    },
  };

  function flag(name) {
    try { return sessionStorage.getItem("tldw:" + name) || ""; } catch { return ""; }
  }

  function isActivePage() {
    return ACTIVE_PATHS.has(location.pathname) || flag("pages") === "all";
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
  pop.setAttribute("aria-live", "polite");
  pop.hidden = true;

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

  function render(r) {
    body.replaceChildren();
    pop.dataset.state = r.status;
    pop.setAttribute("aria-busy", r.status === "loading" ? "true" : "false");
    if (r.status === "loading") {
      for (const w of [92, 80, 62]) {
        const s = el("div", "tldw-skel");
        s.style.width = w + "%";
        body.appendChild(s);
      }
    } else if (r.status === "ok" && r.bullets) {
      const ul = el("ul", "tldw-list");
      for (const b of r.bullets) ul.appendChild(el("li", null, b));
      body.appendChild(ul);
    } else if (r.status === "ok") {
      body.appendChild(el("p", "tldw-text", r.text || ""));
    } else {
      const p = el("p", "tldw-msg", MESSAGES[r.status] || MESSAGES.error);
      if (r.status === "error" && open && !open.retried) {
        const b = el("button", "tldw-retry", "Retry");
        b.type = "button";
        p.append(" ", b);
      }
      body.appendChild(p);
    }
    if (open) place(open.card);
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
      const thumb = card.querySelector("yt-thumbnail-view-model, ytd-thumbnail, #thumbnail") || card;
      left = Math.min(Math.max(cr.left + (cr.width - w) / 2, margin), vw - w - margin);
      top = thumb.getBoundingClientRect().bottom + gap;
      pop.dataset.side = "below";
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
    if (!pop.isConnected) document.body.appendChild(pop);
    pop.hidden = false;
    pop.classList.remove("tldw-in");

    const cached = cache.get(videoId) || store.get(videoId);
    if (cached) {
      cache.set(videoId, cached);
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
    pop.hidden = true;
    pop.classList.remove("tldw-in");
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
      store.set(videoId, result);
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

  function onPointerOver(e) {
    const t = e.target;
    if (t instanceof Node && pop.contains(t)) {
      hoverCard = pop; // sentinel: leaving the popover for empty space must still close it
      cancelDwell();
      cancelClose();
      return;
    }
    // YouTube's inline-preview player is a separate element laid over the
    // hovered thumbnail; being over it still counts as being over that card.
    if (t instanceof Element && t.closest("ytd-video-preview")) return;
    if (!isActivePage()) {
      hoverCard = null;
      cancelDwell();
      if (open) closeNow();
      return;
    }
    const card = cardFrom(t);
    if (card === hoverCard) return;
    hoverCard = card;
    cancelDwell();
    if (open) {
      if (open.card === card) { cancelClose(); return; }
      scheduleClose();
    }
    if (card) {
      dwellTimer = setTimeout(() => {
        dwellTimer = 0;
        if (hoverCard === card && card.isConnected && isActivePage()) show(card);
      }, DWELL_MS);
    }
  }

  function resetAll() {
    hoverCard = null;
    cancelDwell();
    closeNow();
  }

  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) { hoverCard = null; cancelDwell(); scheduleClose(); } }, true);
  document.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Node && pop.contains(e.target)) return;
    resetAll();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") resetAll(); }, true);
  // A wheel/touch scroll means the user is moving on: close. Other scrolls
  // (scroll anchoring while thumbnails load, programmatic jumps) only move the
  // card, so the popover follows it.
  window.addEventListener("wheel", () => { if (open || dwellTimer) resetAll(); }, { capture: true, passive: true });
  window.addEventListener("touchmove", () => { if (open || dwellTimer) resetAll(); }, { capture: true, passive: true });
  let scrollRaf = 0;
  window.addEventListener("scroll", () => {
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
