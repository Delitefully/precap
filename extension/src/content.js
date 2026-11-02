// Precap - UI entry point (isolated world). Runs the open popover: shows it
// for the card hover.js settles on, asks the bridge for a summary, renders
// the result, and closes it. Wires the other files together.
(() => {
  "use strict";

  const { CLOSE_GRACE_MS } = Precap.config;
  const { youtube, bridge } = Precap;
  const LOADING = { status: "loading" };

  const view = Precap.popover.create({ onRetry: retry, onCardGone: closeNow });

  // The open popover: { card, videoId, reqId, retried, opener, status }, where
  // opener is the element whose keyboard focus opened it (null for a hover).
  let open = null;
  let closeTimer = 0;
  let refocusing = null; // the opener getting focus back from a closing popover
  let scrollRaf = 0;

  function render(result) {
    open.status = result.status;
    view.render(result, open.card, open.retried);
  }

  function show(card) {
    const videoId = youtube.videoIdOf(card);
    if (!videoId) return;
    closeNow();
    const a = document.activeElement;
    const opener = card.contains(a) && a.matches(":focus-visible") ? a : null;
    open = { card, videoId, reqId: null, retried: false, opener, status: null };
    view.show();
    const known = bridge.known(videoId);
    if (known) {
      render(known);
    } else {
      open.reqId = bridge.pendingFor(videoId);
      render(LOADING);
      request();
    }
    requestAnimationFrame(() => { if (open && open.card === card) view.enter(); });
  }

  function closeNow() {
    cancelClose();
    if (!open) return;
    if (open.reqId) bridge.cancel(open.reqId);
    const { opener } = open;
    open = null;
    // Focus inside a closing popover would be lost: hand it back to the card.
    if (opener?.isConnected && view.contains(document.activeElement)) {
      refocusing = opener;
      opener.focus({ preventScroll: true });
      refocusing = null;
    }
    view.hide();
  }

  function closeSoon() {
    if (!closeTimer) closeTimer = setTimeout(closeNow, CLOSE_GRACE_MS);
  }

  function cancelClose() {
    clearTimeout(closeTimer);
    closeTimer = 0;
  }

  // Asks for the open popover's video when it is loading with no request yet
  // and a slot is free; called again whenever a reply frees one.
  function request() {
    if (!open || open.reqId || open.status !== "loading") return;
    open.reqId = bridge.ask(open.videoId);
  }

  function onReply(id, result) {
    if (open && open.reqId === id) {
      open.reqId = null;
      // Aborted: the cancel raced with a re-hover; still loading, so ask again.
      if (result.status !== "aborted") render(result);
    }
    request();
  }

  function retry(hadFocus) {
    if (!open) return false;
    open.retried = true;
    render(LOADING);
    request();
    if (hadFocus && open?.opener) open.opener.focus({ preventScroll: true }); // the button is gone
    return true;
  }

  // Scrolls that aren't the user's (scroll anchoring while thumbnails load,
  // programmatic jumps) only move the card, so the popover follows it.
  function follow() {
    if (!open || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!open) return;
      const r = open.card.getBoundingClientRect();
      if (r.bottom < youtube.topBound() || r.top > window.innerHeight) closeNow();
      else view.place(open.card);
    });
  }

  bridge.onReply(onReply);
  Precap.hover.start({
    card: () => open?.card ?? null,
    opener: () => open?.opener,
    isRefocus: (el) => el === refocusing,
    show,
    closeNow,
    closeSoon,
    cancelClose,
    contains: view.contains,
    controls: view.controls,
  });
  window.addEventListener("scroll", follow, true);
})();
