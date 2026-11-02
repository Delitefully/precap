// Precap - the popover view: its DOM, how each state renders, where it sits
// beside a card, and its entrance and exit. Everything is rendered with
// textContent; nothing from the network or from messages is ever parsed as HTML.
Precap.popover = (() => {
  "use strict";

  const { FADE_OUT_MS, MESSAGES, UNAVAILABLE_NOTE, ASK_HELP_URL, ASK_HELP_TEXT, BRAND_WORDMARK } = Precap.config;
  const { thumbnailOf, topBound } = Precap.youtube;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svgEl(tag, attrs, ...kids) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    n.append(...kids);
    return n;
  }

  // ---------- brand badge ----------

  // The Precap mark (brand file mark-tight-*.svg): a play triangle cut into
  // three bands, the top one in marker yellow (see popover.css). Each band is
  // the same rounded triangle inside its own nested <svg> viewport, which
  // clips it without ids.
  function mark() {
    return svgEl("svg", { class: "tldw-mark", viewBox: "21.132 10 69.282 80", "aria-hidden": "true" },
      ...[[10, 28], [41.6, 16.8], [62, 28]].map(([y, h]) =>
        svgEl("svg", { x: 21.132, y, width: 69.282, height: h, viewBox: `21.132 ${y} 69.282 ${h}` },
          svgEl("polygon", { points: "27.932,21.778 27.932,78.222 76.815,50" }))));
  }

  function wordmark() {
    if (!BRAND_WORDMARK) return "Precap";
    return svgEl("svg", { class: "tldw-wordmark", viewBox: BRAND_WORDMARK.viewBox, role: "img", "aria-label": "Precap" },
      svgEl("path", { d: BRAND_WORDMARK.d }));
  }

  // Small and muted, so people know the summary comes from the extension,
  // not from YouTube.
  function badge() {
    const head = el("div", "tldw-head");
    head.append(mark(), wordmark());
    return head;
  }

  // ---------- content for each state ----------

  // The shape of a typical answer (three bullets of two lines each), so the
  // popover keeps its size when the text arrives.
  function skeleton() {
    const ul = el("ul", "tldw-list tldw-skel-list");
    ul.setAttribute("aria-hidden", "true");
    for (const w of [72, 48, 64]) {
      const s = el("span", "tldw-skel");
      s.style.width = w + "%";
      ul.appendChild(el("li")).append(el("span", "tldw-skel"), s);
    }
    return ul;
  }

  function answer(r) {
    if (!r.bullets) return el("p", "tldw-text", r.text);
    const ul = el("ul", "tldw-list");
    ul.append(...r.bullets.map((b) => el("li", null, b)));
    return ul;
  }

  function helpLink() {
    return Object.assign(el("a", "tldw-link", ASK_HELP_TEXT), {
      href: ASK_HELP_URL,
      target: "_blank",
      rel: "noopener noreferrer",
      ariaLabel: ASK_HELP_TEXT + " (YouTube Help, opens in a new tab)",
    });
  }

  function notice(key) {
    const said = MESSAGES[key];
    const row = el("div", "tldw-row");
    row.appendChild(el("p", "tldw-msg", said));
    if (key === "error") row.appendChild(Object.assign(el("button", "tldw-retry", "Retry"), { type: "button" }));
    if (key !== "unavailable") return { nodes: [row], said };
    const note = el("p", "tldw-note", UNAVAILABLE_NOTE + " ");
    note.appendChild(helpLink());
    return { nodes: [row, note], said: said + ". " + UNAVAILABLE_NOTE };
  }

  // The body for a result, and what screen readers hear for it.
  function content(r, retried) {
    if (r.status === "loading") return { nodes: [skeleton()], said: "" };
    if (r.status === "ok") return { nodes: [answer(r)], said: "Summary: " + (r.bullets ? r.bullets.join(". ") : r.text) };
    return notice(r.status === "error" && retried ? "error_final" : r.status);
  }

  // ---------- the popover ----------

  // onRetry(hadFocus) returns whether it retried; onCardGone() is called when
  // the card was removed from the page.
  function create({ onRetry, onCardGone }) {
    const pop = el("div", "tldw-pop");
    pop.setAttribute("role", "tooltip");
    pop.hidden = true;
    // Screen readers hear results through a separate, always-present status
    // region: the popover itself is display:none until shown, and a live region
    // that appears together with its text is often not announced.
    const live = el("div", "tldw-sr");
    live.setAttribute("role", "status");
    const body = el("div");
    pop.append(badge(), body);
    let hideTimer = 0;

    pop.addEventListener("click", (e) => {
      // The help link opens in a new tab by itself; keep page handlers out of it.
      if (e.target.closest(".tldw-link")) return e.stopPropagation();
      const btn = e.target.closest(".tldw-retry");
      if (btn && onRetry(document.activeElement === btn)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    function show() {
      if (!pop.isConnected) document.body.append(pop, live);
      clearTimeout(hideTimer);
      pop.hidden = false;
    }

    function enter() {
      pop.classList.add("tldw-in");
    }

    function hide() {
      live.textContent = "";
      pop.classList.remove("tldw-in");
      hideTimer = setTimeout(() => { pop.hidden = true; }, FADE_OUT_MS + 20);
    }

    function render(result, card, retried) {
      const shown = pop.classList.contains("tldw-in");
      const fromHeight = shown ? pop.offsetHeight : 0;
      const swap = shown && pop.dataset.state === "loading" && result.status !== "loading";
      const { nodes, said } = content(result, retried);
      body.replaceChildren(...nodes);
      pop.dataset.state = result.status;
      pop.setAttribute("aria-busy", result.status === "loading" ? "true" : "false");
      live.textContent = said;
      place(card);
      if (shown) settle(fromHeight, swap);
    }

    // Grow or shrink into the new size and fade the answer in over the
    // skeleton, instead of snapping.
    function settle(fromHeight, swap) {
      if (swap) {
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

    // Beside the card (right, else left) so the thumbnail and its inline
    // preview stay visible; below the thumbnail only when neither side fits.
    function place(card) {
      if (!card.isConnected) return onCardGone();
      const cr = card.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const minTop = topBound();
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
        const below = thumbnailOf(card).getBoundingClientRect().bottom + gap;
        const above = cr.top - gap - h;
        left = Math.min(Math.max(cr.left + (cr.width - w) / 2, margin), vw - w - margin);
        if (below + h > vh - margin && above >= minTop) {
          top = above;
          pop.dataset.side = "above";
        } else {
          top = below;
          pop.dataset.side = "below";
        }
      }
      top = Math.max(minTop, Math.min(top, vh - h - margin));
      pop.style.left = Math.round(left) + "px";
      pop.style.top = Math.round(top) + "px";
    }

    return {
      show,
      enter,
      hide,
      render,
      place,
      contains: (node) => pop.contains(node),
      controls: () => [...pop.querySelectorAll("a[href], button")],
    };
  }

  return { create };
})();
