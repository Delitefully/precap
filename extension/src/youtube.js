// Precap - everything that depends on YouTube's markup: which pages are
// active, what a video card is, which cards to skip, and the page chrome the
// popover has to stay clear of.
Precap.youtube = (() => {
  "use strict";

  const { ACTIVE_PATHS } = Precap.config;

  const CARD_OUTER = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer";
  const CARD_INNER = "yt-lockup-view-model, ytd-rich-grid-media";
  const THUMBNAIL = "yt-thumbnail-view-model, ytd-thumbnail, #thumbnail";
  const TOP_BARS = "#masthead-container, ytd-feed-filter-chip-bar-renderer";
  const SKIP =
    "ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-promoted-video-renderer, [is-ad], " +
    'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer, a[href^="/shorts/"], ' +
    "yt-collection-thumbnail-view-model, yt-collections-stack, ytd-playlist-thumbnail, " +
    'ytd-thumbnail-overlay-time-status-renderer[overlay-style="LIVE"], ytd-thumbnail-overlay-time-status-renderer[overlay-style="UPCOMING"], ' +
    ".badge-style-type-live-now, .badge-style-type-live-now-alternate";
  const SHORTS_SHELF = "ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer";
  const BADGES = "badge-shape, .yt-badge-shape, .badge-shape-wiz, ytd-thumbnail-overlay-time-status-renderer";
  const METADATA = "yt-content-metadata-view-model, #metadata-line";
  const LIVE_BADGE_RE = /^(live|live now|upcoming|premiere|premieres)$/i;
  const LIVE_META_RE = /\b(watching|waiting|scheduled for|premieres)\b/i;
  const VIDEO_ID_RE = /^[\w-]{11}$/;

  function isActivePage() {
    return ACTIVE_PATHS.has(location.pathname);
  }

  function cardFrom(el) {
    return el.closest(CARD_OUTER) || el.closest(CARD_INNER);
  }

  // Shorts, ads, playlists and mixes, live and upcoming streams.
  function isSkipped(card) {
    if (card.querySelector(SKIP) || card.closest(SHORTS_SHELF)) return true;
    for (const b of card.querySelectorAll(BADGES)) {
      if (LIVE_BADGE_RE.test(b.textContent.trim())) return true;
    }
    return LIVE_META_RE.test(card.querySelector(METADATA)?.textContent ?? "");
  }

  // The videoId to summarize, or null to stay silent.
  function videoIdOf(card) {
    if (isSkipped(card)) return null;
    const v = new URLSearchParams(card.querySelector('a[href*="/watch?"]')?.search).get("v");
    return v && VIDEO_ID_RE.test(v) ? v : null;
  }

  // YouTube's inline-preview player, laid over the hovered thumbnail.
  function isPreview(el) {
    return !!el.closest("ytd-video-preview");
  }

  function thumbnailOf(card) {
    return card.querySelector(THUMBNAIL) || card;
  }

  // The lowest y the popover may use: below the masthead and the chip bar.
  function topBound() {
    let bottom = 0;
    for (const n of document.querySelectorAll(TOP_BARS)) {
      const r = n.getBoundingClientRect();
      if (r.height > 0 && r.top <= bottom + 4 && r.bottom > bottom) bottom = r.bottom;
    }
    return (bottom || 56) + 8;
  }

  return { isActivePage, cardFrom, videoIdOf, isPreview, thumbnailOf, topBound };
})();
