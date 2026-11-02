// Precap - works out which card the user is on: the pointer resting on it
// (the dwell) or keyboard focus, and the moves that mean they have moved on.
// It drives the popover through the controls content.js passes to start().
Precap.hover = (() => {
  "use strict";

  const { DWELL_MS, SETTLE_PX } = Precap.config;
  const youtube = Precap.youtube;

  let popover = null; // the controls from start()
  let hoverCard = null; // card under the pointer or holding keyboard focus
  let dwellTimer = 0;
  let dwellAt = null; // pointer event (x, y) the dwell is measured from
  let lastPointer = null; // last pointermove event
  // Set when the page scrolls: a card that slides under a still pointer is
  // not a hover, so no dwell starts until the pointer really moves.
  let parkedAt = null;

  // ---------- dwell ----------

  function cancelDwell() {
    clearTimeout(dwellTimer);
    dwellTimer = 0;
    dwellAt = null;
  }

  function startDwell(card, at) {
    clearTimeout(dwellTimer);
    dwellAt = at;
    dwellTimer = setTimeout(() => {
      cancelDwell();
      if (hoverCard === card && card.isConnected && youtube.isActivePage()) popover.show(card);
    }, DWELL_MS);
  }

  // Pointer and keyboard focus both land here: `card` is what the user is now
  // on (null for anything else), `at` the pointer event or null for focus.
  // The open popover counts as part of its card.
  function aim(card, at) {
    if (card === hoverCard) return;
    hoverCard = card;
    cancelDwell();
    const openCard = popover.card();
    if (openCard) {
      if (openCard === card) return popover.cancelClose();
      popover.closeSoon();
    }
    if (card) startDwell(card, at);
  }

  function aimAtOpenCard() {
    const card = popover.card();
    if (card) aim(card);
  }

  function resetAll() {
    popover.closeNow();
    aim(null);
  }

  // ---------- pointer ----------

  function onPointerOver(e) {
    // The page scrolled under a pointer that has not moved: not a hover.
    if (parkedAt && Math.hypot(e.x - parkedAt.x, e.y - parkedAt.y) < 2) return;
    parkedAt = null;
    const t = e.target;
    if (popover.contains(t)) return aimAtOpenCard();
    // Being over the inline preview still counts as being over its card.
    if (youtube.isPreview(t)) return;
    if (!youtube.isActivePage()) return resetAll();
    aim(youtube.cardFrom(t), e);
  }

  function onPointerMove(e) {
    lastPointer = e;
    // First real move after a scroll: whatever is under the pointer now
    // counts as hovered.
    if (parkedAt) return onPointerOver(e);
    if (dwellAt && Math.hypot(e.x - dwellAt.x, e.y - dwellAt.y) > SETTLE_PX) startDwell(hoverCard, e);
  }

  // ---------- keyboard ----------

  // Keyboard focus on a card (Tab, not a click) opens it like a hover does.
  function onFocusIn(e) {
    const t = e.target;
    if (popover.isRefocus(t)) return;
    if (popover.contains(t)) return aimAtOpenCard();
    if (!t.matches(":focus-visible")) return;
    aim(youtube.isActivePage() ? youtube.cardFrom(t) : null, null);
  }

  // Esc closes. A popover opened from the keyboard sits at the end of the
  // page, so Tab would never reach its link or button. Tab from the card that
  // opened it steps into the popover's controls, and past the last one (or
  // Shift+Tab past the first) goes back to that card and on through the page.
  function onKeyDown(e) {
    if (e.key === "Escape" && (popover.card() || dwellTimer)) return resetAll();
    const opener = popover.opener();
    if (e.key !== "Tab" || !opener?.isConnected) return;
    const controls = popover.controls();
    const a = document.activeElement;
    if (a === opener && !e.shiftKey && controls.length) { e.preventDefault(); return controls[0].focus(); }
    const i = controls.indexOf(a);
    if (i < 0) return;
    const next = controls[i + (e.shiftKey ? -1 : 1)];
    if (next || e.shiftKey) e.preventDefault();
    if (next) next.focus();
    else opener.focus({ preventScroll: true }); // without Shift, Tab then moves on from the card
  }

  // ---------- scrolling ----------

  // A wheel or touch scroll means the user is moving on: close.
  function onWheel(e) {
    parkedAt = e;
    if (popover.card() || dwellTimer) resetAll();
  }

  function onTouchMove() {
    if (popover.card() || dwellTimer) resetAll();
  }

  function onScroll() {
    if (lastPointer) parkedAt = lastPointer;
  }

  // `controls`: { card(), opener(), isRefocus(el), show(card), closeNow(),
  // closeSoon(), cancelClose(), contains(node), controls() }.
  function start(controls) {
    popover = controls;
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) aim(null); }, true);
    document.addEventListener("pointerdown", (e) => { if (!popover.contains(e.target)) resetAll(); }, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onWheel, true);
    window.addEventListener("touchmove", onTouchMove, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", resetAll);
    document.addEventListener("visibilitychange", () => { if (document.hidden) resetAll(); });
    document.addEventListener("yt-navigate-start", resetAll);
    document.addEventListener("yt-navigate-finish", resetAll);
  }

  return { start };
})();
