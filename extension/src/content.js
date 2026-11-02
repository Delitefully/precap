// Precap - UI half (isolated world).
//
// Watches hovers on video cards with delegated listeners, shows a small
// popover after a ~1 s dwell, and asks the page half (main-world.js) for a
// summary over window.postMessage. Results are cached per videoId in memory
// only, for the life of the page. Everything is rendered with textContent;
// nothing from the network or from messages is ever parsed as HTML.
(() => {
  "use strict";

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
  // Shown under the "unavailable" message, with a link to YouTube's Help page
  // on who can use Ask (fixed URL, never built from data).
  const UNAVAILABLE_NOTE = "This is not an issue with Precap. Precap depends on YouTube’s Ask feature to work.";
  const ASK_HELP_URL = "https://support.google.com/youtube/answer/14110396";
  const ASK_HELP_TEXT = "See who can use Ask";

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const cache = new Map(); // videoId -> { status: "ok", bullets | text } | { status: "no_ask" }
  const pending = new Map(); // request id -> videoId
  let sessionStatus = null; // "logged_out" | "unavailable" once known
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
  let opener = null; // element whose keyboard focus opened the popover
  let quietFocus = null; // element being refocused by us; its focusin is ignored

  // ---------- helpers ----------

  function isActivePage() {
    return ACTIVE_PATHS.has(location.pathname);
  }

  function cardFrom(el) {
    return el.closest(CARD_OUTER) || el.closest(CARD_INNER);
  }

  const SKIP =
    "ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-promoted-video-renderer, [is-ad], " +
    'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer, a[href^="/shorts/"], ' +
    "yt-collection-thumbnail-view-model, yt-collections-stack, ytd-playlist-thumbnail, " +
    'ytd-thumbnail-overlay-time-status-renderer[overlay-style="LIVE"], ytd-thumbnail-overlay-time-status-renderer[overlay-style="UPCOMING"], ' +
    ".badge-style-type-live-now, .badge-style-type-live-now-alternate";
  const LIVE_BADGE_RE = /^(live|live now|upcoming|premiere|premieres)$/i;
  const LIVE_META_RE = /\b(watching|waiting|scheduled for|premieres)\b/i;

  // Returns the videoId to summarize, or null to stay silent (Shorts, ads,
  // playlists/mixes, live and upcoming streams, anything without a watch link).
  function videoIdOf(card) {
    if (card.querySelector(SKIP) || card.closest("ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer")) return null;
    for (const b of card.querySelectorAll("badge-shape, .yt-badge-shape, .badge-shape-wiz, ytd-thumbnail-overlay-time-status-renderer")) {
      if (LIVE_BADGE_RE.test(b.textContent.trim())) return null;
    }
    if (LIVE_META_RE.test(card.querySelector("yt-content-metadata-view-model, #metadata-line")?.textContent ?? "")) return null;
    const v = new URLSearchParams(card.querySelector('a[href*="/watch?"]')?.search).get("v");
    return v && /^[\w-]{11}$/.test(v) ? v : null;
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

  // Ask answers are markdown. Keep 2-4 short bullets; fall back to 1-2
  // sentences when the answer is not a list.
  function parseAnswer(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bullets = lines
      .filter((l) => BULLET_RE.test(l))
      .map((l) => cleanLine(l.replace(BULLET_RE, "")))
      .filter(Boolean)
      .slice(0, 4)
      .map((b) => shorten(b[0].toUpperCase() + b.slice(1), 110));
    if (bullets.length) return { status: "ok", bullets };
    const flat = cleanLine(lines.join(" "));
    const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) || [flat];
    return { status: "ok", text: shorten(sentences.slice(0, 2).join(" ").trim(), 220) };
  }

  // ---------- popover ----------

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

  function svgEl(tag, attrs, ...kids) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    n.append(...kids);
    return n;
  }

  // The Precap mark (brand file mark-tight-*.svg): a play triangle cut into
  // three bands, the top one in marker yellow (see popover.css). Each band is
  // the same rounded triangle inside its own nested <svg> viewport, which
  // clips it without ids.
  const mark = svgEl("svg", { class: "tldw-mark", viewBox: "21.132 10 69.282 80", "aria-hidden": "true" },
    ...[[10, 28], [41.6, 16.8], [62, 28]].map(([y, h]) =>
      svgEl("svg", { x: 21.132, y, width: 69.282, height: h, viewBox: `21.132 ${y} 69.282 ${h}` },
        svgEl("polygon", { points: "27.932,21.778 27.932,78.222 76.815,50" }))));

  // Brand wordmark: "Precap" in Recursive (Casual), outlined as one SVG path.
  // This constant is the only place it lives; swap in a new outline here as
  // { viewBox: "minX minY width height", d: "<path data>" }, with the viewBox
  // running from the cap top to the baseline (descenders hang below and are
  // allowed to overflow). Set it to null to fall back to "Precap" set in
  // Roboto 500.
  const BRAND_WORDMARK = {
    viewBox: "20 -700 3215 700",
    d: "M233 0Q221 3 210.5 4.5Q200 6 185 6Q130 6 104.5 -18.0Q79 -42 79 -96Q79 -160 79.0 -223.5Q79 -287 79.0 -350.5Q79 -414 79.0 -477.5Q79 -541 79 -605H199L188 -575Q206 -563 214.5 -542.0Q223 -521 223 -490Q223 -425 223.0 -360.0Q223 -295 223.0 -229.5Q223 -164 223 -97Q223 -74 224.5 -48.5Q226 -23 233 0ZM25 -700Q91 -711 159.5 -715.5Q228 -720 292 -720Q338 -720 377.0 -709.0Q416 -698 447.5 -677.5Q479 -657 501.0 -630.0Q523 -603 534.5 -570.0Q546 -537 546 -500V-491Q546 -409 527.0 -347.5Q508 -286 474.5 -244.5Q441 -203 399.0 -182.5Q357 -162 311 -162Q285 -162 264.0 -175.5Q243 -189 229 -213L199 -212V-301Q217 -296 235.0 -293.0Q253 -290 275 -290Q303 -290 326.5 -302.0Q350 -314 367.5 -338.0Q385 -362 394.5 -399.0Q404 -436 404 -488V-503Q404 -519 402.5 -533.5Q401 -548 397 -560Q375 -573 347.5 -579.0Q320 -585 281 -585Q226 -585 180.0 -580.0Q134 -575 103.0 -570.0Q72 -565 62 -565Q40 -565 30.0 -585.5Q20 -606 20 -650Q20 -665 21.5 -677.0Q23 -689 25 -700Z M793.0 -372H805.0Q821.0 -431 840.5 -472.5Q860.0 -514 885.0 -535.5Q910.0 -557 940.0 -557Q953.0 -557 963.5 -554.0Q974.0 -551 982.0 -542Q994.0 -531 1000.0 -509.5Q1006.0 -488 1006.0 -450Q1006.0 -440 1005.5 -430.5Q1005.0 -421 1004.0 -411.5Q1003.0 -402 1001.0 -393.0Q999.0 -384 996.0 -376H990.0Q977.0 -385 964.0 -389.0Q951.0 -393 933.0 -393Q903.0 -393 878.5 -372.0Q854.0 -351 833.0 -306.5Q812.0 -262 793.0 -191ZM799.0 1Q791.0 2 785.0 2.5Q779.0 3 773.0 3.5Q767.0 4 760.0 4Q732.0 4 713.5 -1.5Q695.0 -7 684.0 -18.0Q673.0 -29 668.5 -44.5Q664.0 -60 664.0 -79Q664.0 -119 664.0 -157.0Q664.0 -195 664.0 -231.5Q664.0 -268 664.0 -302.5Q664.0 -337 664.0 -372.0Q664.0 -407 664.0 -441Q664.0 -468 659.5 -494.0Q655.0 -520 645.0 -538Q652.0 -540 659.0 -541.0Q666.0 -542 672.5 -543.0Q679.0 -544 686.0 -544Q718.0 -544 744.0 -529.5Q770.0 -515 784.5 -480.0Q799.0 -445 799.0 -382Q799.0 -343 799.0 -302.5Q799.0 -262 799.0 -222.5Q799.0 -183 799.0 -144.5Q799.0 -106 799.0 -69.5Q799.0 -33 799.0 1Z M1335.0 -553Q1405.0 -553 1454.0 -524.5Q1503.0 -496 1529.5 -445.5Q1556.0 -395 1556.0 -329V-324Q1556.0 -286 1551.5 -266.0Q1547.0 -246 1539.0 -239.5Q1531.0 -233 1521.0 -233H1297.0Q1268.0 -233 1244.0 -241.0Q1220.0 -249 1206.0 -262L1185.0 -252L1189.0 -314H1420.0Q1422.0 -321 1422.5 -329.5Q1423.0 -338 1423.0 -345Q1423.0 -369 1418.0 -390.5Q1413.0 -412 1400.0 -429Q1388.0 -434 1377.0 -436.0Q1366.0 -438 1345.0 -438Q1280.0 -438 1240.0 -387.5Q1200.0 -337 1200.0 -234V-229Q1200.0 -209 1202.0 -192.0Q1204.0 -175 1208.5 -160.0Q1213.0 -145 1218.0 -132Q1242.0 -120 1272.5 -114.5Q1303.0 -109 1347.0 -109Q1380.0 -109 1411.0 -113.5Q1442.0 -118 1471.5 -128.0Q1501.0 -138 1528.0 -154H1534.0Q1536.0 -145 1537.0 -136.0Q1538.0 -127 1538.0 -118Q1538.0 -87 1529.5 -66.0Q1521.0 -45 1505.0 -29Q1489.0 -13 1464.0 -3.5Q1439.0 6 1409.0 10.5Q1379.0 15 1346.0 15Q1284.0 15 1232.5 -4.0Q1181.0 -23 1143.5 -58.5Q1106.0 -94 1085.5 -144.5Q1065.0 -195 1065.0 -258V-263Q1065.0 -327 1085.0 -380.0Q1105.0 -433 1141.0 -472.0Q1177.0 -511 1226.5 -532.0Q1276.0 -553 1335.0 -553Z M1928.0 -550Q1954.0 -550 1974.5 -546.5Q1995.0 -543 2010.0 -537.0Q2025.0 -531 2034.0 -521Q2045.0 -510 2050.5 -495.0Q2056.0 -480 2056.0 -452Q2056.0 -429 2052.5 -410.0Q2049.0 -391 2041.0 -373H2036.0Q2008.0 -394 1982.5 -402.5Q1957.0 -411 1918.0 -411Q1876.0 -411 1847.0 -389.0Q1818.0 -367 1803.0 -328.5Q1788.0 -290 1788.0 -241V-229Q1788.0 -206 1792.5 -185.0Q1797.0 -164 1805.0 -146Q1828.0 -131 1853.5 -125.0Q1879.0 -119 1908.0 -119Q1938.0 -119 1962.5 -124.0Q1987.0 -129 2009.0 -140.0Q2031.0 -151 2053.0 -168H2059.0Q2061.0 -158 2062.0 -148.0Q2063.0 -138 2063.0 -123Q2063.0 -88 2056.0 -62.5Q2049.0 -37 2033.0 -21Q2023.0 -11 2004.0 -3.5Q1985.0 4 1959.0 8.0Q1933.0 12 1901.0 12Q1849.0 12 1804.0 -2.5Q1759.0 -17 1725.0 -47.5Q1691.0 -78 1672.0 -126.0Q1653.0 -174 1653.0 -240V-254Q1653.0 -342 1687.5 -408.5Q1722.0 -475 1784.0 -512.5Q1846.0 -550 1928.0 -550Z M2600.0 -354Q2600.0 -332 2600.0 -310.0Q2600.0 -288 2600.0 -266.5Q2600.0 -245 2600.0 -223.0Q2600.0 -201 2600.0 -179Q2600.0 -167 2600.0 -155.5Q2600.0 -144 2600.0 -132Q2604.0 -130 2610.0 -128.5Q2616.0 -127 2620.0 -127Q2631.0 -127 2642.0 -130.5Q2653.0 -134 2663.0 -142H2669.0Q2670.0 -136 2670.5 -131.5Q2671.0 -127 2671.0 -120Q2671.0 -92 2661.5 -64.5Q2652.0 -37 2637.0 -22Q2621.0 -6 2606.0 0.5Q2591.0 7 2576.0 7Q2550.0 7 2527.5 -7.5Q2505.0 -22 2489.5 -44.5Q2474.0 -67 2465.0 -94.0Q2456.0 -121 2456.0 -145Q2456.0 -168 2456.0 -190.5Q2456.0 -213 2456.0 -233Q2456.0 -257 2458.0 -282.0Q2460.0 -307 2464.5 -335.0Q2469.0 -363 2475.0 -396Q2456.0 -405 2437.5 -410.0Q2419.0 -415 2398.5 -417.0Q2378.0 -419 2353.0 -419Q2323.0 -419 2298.0 -416.5Q2273.0 -414 2249.0 -409.5Q2225.0 -405 2199.0 -397H2193.0Q2192.0 -406 2190.5 -417.5Q2189.0 -429 2189.0 -441Q2189.0 -462 2195.0 -482.0Q2201.0 -502 2214.0 -515Q2226.0 -526 2246.0 -533.5Q2266.0 -541 2300.0 -544.5Q2334.0 -548 2385.0 -548Q2437.0 -548 2476.5 -531.0Q2516.0 -514 2543.5 -485.0Q2571.0 -456 2585.5 -422.0Q2600.0 -388 2600.0 -354ZM2284.0 -155Q2284.0 -128 2295.5 -118.0Q2307.0 -108 2340.0 -108Q2361.0 -108 2383.0 -115.0Q2405.0 -122 2427.0 -137.0Q2449.0 -152 2469.0 -177L2475.0 -96H2460.0Q2447.0 -70 2422.5 -45.5Q2398.0 -21 2365.0 -5.5Q2332.0 10 2294.0 10Q2245.0 10 2210.5 -7.5Q2176.0 -25 2158.0 -59.5Q2140.0 -94 2140.0 -147V-154Q2140.0 -182 2154.5 -209.5Q2169.0 -237 2193.5 -261.0Q2218.0 -285 2250.5 -299.0Q2283.0 -313 2318.0 -313Q2361.0 -313 2397.5 -308.5Q2434.0 -304 2461.0 -295.5Q2488.0 -287 2499.0 -276Q2505.0 -271 2510.0 -262.0Q2515.0 -253 2518.0 -240.0Q2521.0 -227 2521.0 -208Q2494.0 -215 2465.5 -219.0Q2437.0 -223 2410.0 -225.0Q2383.0 -227 2359.0 -227Q2338.0 -227 2322.0 -224.5Q2306.0 -222 2292.0 -215Q2288.0 -200 2286.0 -186.5Q2284.0 -173 2284.0 -157Z M2733.0 -539Q2740.0 -540 2747.0 -541.0Q2754.0 -542 2760.5 -543.0Q2767.0 -544 2774.0 -544Q2804.0 -544 2829.5 -529.5Q2855.0 -515 2871.0 -480.0Q2887.0 -445 2887.0 -382Q2887.0 -307 2887.0 -234.5Q2887.0 -162 2887.0 -90.5Q2887.0 -19 2887.0 52.5Q2887.0 124 2887.0 197Q2879.0 198 2873.0 199.0Q2867.0 200 2862.0 200.0Q2857.0 200 2850.0 200Q2813.0 200 2791.0 180.5Q2769.0 161 2760.5 129.0Q2752.0 97 2752.0 62Q2752.0 -11 2752.0 -73.0Q2752.0 -135 2752.0 -193.5Q2752.0 -252 2752.0 -312.0Q2752.0 -372 2752.0 -441Q2752.0 -468 2747.5 -494.0Q2743.0 -520 2733.0 -539ZM3079.0 -550Q3120.0 -550 3155.5 -522.0Q3191.0 -494 3213.0 -446.5Q3235.0 -399 3235.0 -342V-321Q3235.0 -233 3217.0 -169.5Q3199.0 -106 3168.5 -66.0Q3138.0 -26 3100.5 -7.0Q3063.0 12 3024.0 12Q2994.0 12 2968.0 0.5Q2942.0 -11 2922.5 -29.5Q2903.0 -48 2893.0 -67H2871.0V-166Q2893.0 -143 2918.0 -131.0Q2943.0 -119 2978.0 -119Q3017.0 -119 3043.5 -140.0Q3070.0 -161 3082.5 -201.5Q3095.0 -242 3095.0 -301V-312Q3095.0 -343 3093.5 -362.5Q3092.0 -382 3087.0 -395Q3082.0 -401 3076.0 -403.0Q3070.0 -405 3063.0 -405Q3024.0 -405 2989.5 -387.0Q2955.0 -369 2927.5 -327.0Q2900.0 -285 2877.0 -214V-388H2893.0Q2910.0 -433 2939.0 -469.5Q2968.0 -506 3004.5 -528.0Q3041.0 -550 3079.0 -550Z",
  };

  // Small, muted badge in the top-left corner so people know the summary
  // comes from the extension, not from YouTube.
  const head = el("div", "tldw-head");
  head.append(mark, BRAND_WORDMARK
    ? svgEl("svg", { class: "tldw-wordmark", viewBox: BRAND_WORDMARK.viewBox, role: "img", "aria-label": "Precap" },
      svgEl("path", { d: BRAND_WORDMARK.d }))
    : "Precap");
  const body = el("div");
  pop.append(head, body);

  pop.addEventListener("click", (e) => {
    // The help link opens in a new tab by itself; keep page handlers out of it.
    if (e.target.closest(".tldw-link")) return e.stopPropagation();
    const btn = e.target.closest(".tldw-retry");
    if (!btn || !open) return;
    e.preventDefault();
    e.stopPropagation();
    const hadFocus = document.activeElement === btn;
    open.retried = true;
    render({ status: "loading" });
    request();
    if (hadFocus && opener) opener.focus({ preventScroll: true }); // the button is gone
  });

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render(r) {
    const shown = pop.classList.contains("tldw-in");
    const fromHeight = shown ? pop.offsetHeight : 0;
    const swap = shown && pop.dataset.state === "loading" && r.status !== "loading";
    body.replaceChildren();
    pop.dataset.state = r.status;
    pop.setAttribute("aria-busy", r.status === "loading" ? "true" : "false");
    let said = "";
    if (r.status === "loading") {
      // The shape of a typical answer (three bullets of two lines each), so
      // the popover keeps its size when the text arrives.
      const ul = body.appendChild(el("ul", "tldw-list tldw-skel-list"));
      ul.setAttribute("aria-hidden", "true");
      for (const w of [72, 48, 64]) {
        const s = el("span", "tldw-skel");
        s.style.width = w + "%";
        ul.appendChild(el("li")).append(el("span", "tldw-skel"), s);
      }
    } else if (r.status === "ok") {
      if (r.bullets) body.appendChild(el("ul", "tldw-list")).append(...r.bullets.map((b) => el("li", null, b)));
      else body.appendChild(el("p", "tldw-text", r.text));
      said = "Summary: " + (r.bullets ? r.bullets.join(". ") : r.text);
    } else {
      const canRetry = r.status === "error" && !open.retried;
      said = MESSAGES[r.status === "error" && !canRetry ? "error_final" : r.status];
      const row = body.appendChild(el("div", "tldw-row"));
      row.appendChild(el("p", "tldw-msg", said));
      if (canRetry) {
        const b = el("button", "tldw-retry", "Retry");
        b.type = "button";
        row.appendChild(b);
      }
      if (r.status === "unavailable") {
        const note = el("p", "tldw-note", UNAVAILABLE_NOTE + " ");
        const a = el("a", "tldw-link", ASK_HELP_TEXT);
        a.href = ASK_HELP_URL;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", ASK_HELP_TEXT + " (YouTube Help, opens in a new tab)");
        note.appendChild(a);
        body.appendChild(note);
        said += ". " + UNAVAILABLE_NOTE;
      }
    }
    live.textContent = said;
    place(open.card);
    if (!shown) return;
    // Settle into the new size and fade the answer in over the skeleton,
    // instead of snapping.
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
      const thumb = card.querySelector("yt-thumbnail-view-model, ytd-thumbnail, #thumbnail") || card;
      const below = thumb.getBoundingClientRect().bottom + gap;
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

  function show(card) {
    const videoId = videoIdOf(card);
    if (!videoId) return;
    closeNow();
    open = { card, videoId, reqId: null, retried: false };
    const a = document.activeElement;
    opener = card.contains(a) && a.matches(":focus-visible") ? a : null;
    if (!pop.isConnected) document.body.append(pop, live);
    // Start from the hidden state even if the last popover is still fading
    // out, so it never slides over from the previous card.
    clearTimeout(hideTimer);
    pop.hidden = true;
    void pop.offsetWidth;
    pop.hidden = false;

    const cached = cache.get(videoId);
    if (cached) {
      render(cached);
    } else if (sessionStatus) {
      render({ status: sessionStatus });
    } else {
      open.reqId = [...pending].find(([, v]) => v === videoId)?.[0];
      render({ status: "loading" });
      request();
    }
    requestAnimationFrame(() => { if (open && open.card === card) pop.classList.add("tldw-in"); });
  }

  function closeNow() {
    cancelClose();
    if (!open) return;
    if (open.reqId) post({ type: "cancel", id: open.reqId });
    open = null;
    // Focus inside a closing popover would be lost: hand it back to the card.
    if (opener && opener.isConnected && pop.contains(document.activeElement)) {
      quietFocus = opener;
      opener.focus({ preventScroll: true });
      quietFocus = null;
    }
    opener = null;
    live.textContent = "";
    pop.classList.remove("tldw-in");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { pop.hidden = true; }, FADE_OUT_MS + 20);
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
      cancelDwell();
      if (hoverCard === card && card.isConnected && isActivePage()) show(card);
    }, DWELL_MS);
  }

  // ---------- messaging ----------

  function post(msg) {
    window.postMessage({ tldw: 1, dir: "req", ...msg }, ORIGIN);
  }

  // Asks for the open popover's video when it is loading with no request yet
  // and a slot is free; called again whenever a reply frees one.
  function request() {
    if (!open || open.reqId || pop.dataset.state !== "loading" || pending.size >= MAX_INFLIGHT) return;
    const id = "r" + ++seq + "-" + Math.random().toString(36).slice(2, 8);
    pending.set(id, open.videoId);
    open.reqId = id;
    post({ type: "summarize", id, videoId: open.videoId });
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

    if (open && open.reqId === m.id) {
      open.reqId = null;
      // Aborted: the cancel raced with a re-hover; still loading, so ask again.
      if (result.status !== "aborted") render(result);
    }
    request();
  });

  // ---------- hover tracking (delegated) ----------

  // Pointer and keyboard focus both land here: `card` is what the user is now
  // on (null for anything else), `at` the pointer position or null for focus.
  // The open popover counts as part of its card.
  function aim(card, at) {
    if (card === hoverCard) return;
    hoverCard = card;
    cancelDwell();
    if (open) {
      if (open.card === card) { cancelClose(); return; }
      if (!closeTimer) closeTimer = setTimeout(closeNow, CLOSE_GRACE_MS);
    }
    if (card) startDwell(card, at);
  }

  function onPointerOver(e) {
    // The page scrolled under a pointer that has not moved: not a hover.
    if (parkedAt && Math.hypot(e.clientX - parkedAt.x, e.clientY - parkedAt.y) < 2) return;
    parkedAt = null;
    const t = e.target;
    if (pop.contains(t)) return open && aim(open.card);
    // YouTube's inline-preview player is a separate element laid over the
    // hovered thumbnail; being over it still counts as being over that card.
    if (t.closest("ytd-video-preview")) return;
    if (!isActivePage()) return resetAll();
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
    // First real move after a scroll: whatever is under the pointer now
    // counts as hovered.
    if (parkedAt) return onPointerOver(e);
    if (dwellAt && Math.hypot(x - dwellAt.x, y - dwellAt.y) > SETTLE_PX) startDwell(hoverCard, { x, y });
  }, { capture: true, passive: true });
  document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) aim(null); }, true);
  document.addEventListener("pointerdown", (e) => { if (!pop.contains(e.target)) resetAll(); }, true);
  // Keyboard focus on a card (Tab, not a click) opens it like a hover does.
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t === quietFocus) return;
    if (pop.contains(t)) return open && aim(open.card);
    if (!t.matches(":focus-visible")) return;
    aim(isActivePage() ? cardFrom(t) : null, null);
  }, true);
  // Esc closes. A popover opened from the keyboard sits at the end of the
  // page, so Tab would never reach its link or button. Tab from the card that
  // opened it steps into the popover's controls, and past the last one (or
  // Shift+Tab past the first) goes back to that card and on through the page.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (open || dwellTimer)) return resetAll();
    if (e.key !== "Tab" || !open || !opener || !opener.isConnected) return;
    const controls = [...pop.querySelectorAll("a[href], button")];
    const a = document.activeElement;
    if (a === opener && !e.shiftKey && controls.length) { e.preventDefault(); return controls[0].focus(); }
    const i = controls.indexOf(a);
    if (i < 0) return;
    const next = controls[i + (e.shiftKey ? -1 : 1)];
    if (next || e.shiftKey) e.preventDefault();
    if (next) next.focus();
    else opener.focus({ preventScroll: true }); // without Shift, Tab then moves on from the card
  }, true);
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
