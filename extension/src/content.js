// Precap - UI half (isolated world).
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
  // Shown under the "unavailable" message, with a link to YouTube's Help page
  // on who can use Ask (fixed URL, never built from data).
  const UNAVAILABLE_NOTE = "This is not an issue with Precap. Precap depends on YouTube’s Ask feature to work.";
  const ASK_HELP_URL = "https://support.google.com/youtube/answer/14110396";
  const ASK_HELP_TEXT = "See who can use Ask";

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
  let opener = null; // element whose keyboard focus opened the popover
  let quietFocus = null; // element being refocused by us; its focusin is ignored

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

  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  // The Precap mark (brand file mark-tight-*.svg): a play triangle cut into
  // three bands, the top one in marker yellow. Each band is the same rounded
  // triangle inside its own nested <svg> viewport, which clips it without ids.
  function brandMark() {
    const svg = svgEl("svg", { class: "tldw-mark", viewBox: "21.132 10 69.282 80", "aria-hidden": "true", focusable: "false" });
    for (const [y, h, cls] of [[10, 28, "tldw-mark-top"], [41.6, 16.8, "tldw-mark-rest"], [62, 28, "tldw-mark-rest"]]) {
      const band = svgEl("svg", { x: 21.132, y, width: 69.282, height: h, viewBox: `21.132 ${y} 69.282 ${h}` });
      band.appendChild(svgEl("polygon", {
        class: cls,
        points: "27.932,21.778 27.932,78.222 76.815,50",
        "stroke-width": 13.6,
        "stroke-linejoin": "round",
      }));
      svg.appendChild(band);
    }
    return svg;
  }

  // Brand wordmark: "Precap" in Recursive (Casual), outlined as one SVG path.
  // This constant is the only place it lives; swap in a new outline here as
  // { viewBox: "minX minY width height", d: "<path data>" }, with the viewBox
  // running from the cap top to the baseline (descenders hang below and are
  // allowed to overflow). Set it to null to fall back to "Precap" set in
  // Roboto 500.
  const BRAND_WORDMARK = {
    viewBox: "8 -700 3243 700",
    d: "M270 0Q250 4 230.5 6.5Q211 9 188 9Q119 9 87.0 -18.5Q55 -46 55 -105Q55 -163 55.0 -220.0Q55 -277 55.0 -335.0Q55 -393 55.0 -450.5Q55 -508 55 -566H247L226 -516Q246 -500 252.0 -478.5Q258 -457 258 -427Q258 -382 258.0 -331.5Q258 -281 258.0 -229.0Q258 -177 258 -125Q258 -89 261.0 -58.0Q264 -27 270 0ZM18 -693Q84 -704 160.0 -708.5Q236 -713 313 -713Q360 -713 399.5 -702.0Q439 -691 470.5 -670.5Q502 -650 524.5 -621.0Q547 -592 558.5 -556.0Q570 -520 570 -478V-470Q570 -396 554.5 -337.0Q539 -278 512.0 -236.5Q485 -195 447.5 -174.0Q410 -153 366 -153Q336 -153 308.5 -164.0Q281 -175 264 -195H224V-346Q243 -335 261.0 -331.0Q279 -327 301 -327Q317 -327 329.0 -333.5Q341 -340 348.5 -354.5Q356 -369 360.0 -392.5Q364 -416 364 -451V-463Q364 -477 362.5 -490.0Q361 -503 357 -513Q342 -518 321.5 -520.5Q301 -523 274 -523Q210 -523 166.5 -518.0Q123 -513 95.0 -508.0Q67 -503 50 -503Q27 -503 17.5 -525.5Q8 -548 8 -601Q8 -632 11.0 -654.0Q14 -676 18 -693Z M802.0 -389H840.0Q850.0 -451 866.5 -489.5Q883.0 -528 903.5 -545.5Q924.0 -563 946.0 -563Q958.0 -563 967.0 -559.5Q976.0 -556 985.0 -548Q1000.0 -533 1008.0 -501.0Q1016.0 -469 1016.0 -419Q1016.0 -404 1015.5 -390.5Q1015.0 -377 1014.0 -365.0Q1013.0 -353 1011.0 -341.5Q1009.0 -330 1006.0 -319H1000.0Q986.0 -327 973.0 -330.5Q960.0 -334 940.0 -334Q917.0 -334 897.0 -324.0Q877.0 -314 858.0 -292.5Q839.0 -271 821.0 -236ZM833.0 0Q821.0 2 809.5 3.5Q798.0 5 786.0 5.5Q774.0 6 762.0 6Q724.0 6 699.5 1.5Q675.0 -3 661.5 -13.0Q648.0 -23 642.0 -40.0Q636.0 -57 636.0 -80Q636.0 -116 636.0 -150.5Q636.0 -185 636.0 -219.0Q636.0 -253 636.0 -286.5Q636.0 -320 636.0 -353.5Q636.0 -387 636.0 -420Q636.0 -457 632.5 -489.5Q629.0 -522 622.0 -547Q635.0 -550 648.0 -551.5Q661.0 -553 675.5 -554.0Q690.0 -555 705.0 -555Q749.0 -555 777.5 -540.0Q806.0 -525 819.5 -488.0Q833.0 -451 833.0 -386Q833.0 -347 833.0 -307.5Q833.0 -268 833.0 -229.0Q833.0 -190 833.0 -151.0Q833.0 -112 833.0 -74.0Q833.0 -36 833.0 0Z M1345.0 -561Q1411.0 -561 1462.5 -532.5Q1514.0 -504 1544.0 -453.0Q1574.0 -402 1574.0 -334V-331Q1574.0 -284 1568.0 -262.0Q1562.0 -240 1553.0 -234.0Q1544.0 -228 1534.0 -228H1342.0Q1306.0 -228 1281.5 -237.0Q1257.0 -246 1242.0 -259L1222.0 -251L1224.0 -315H1391.0Q1393.0 -320 1393.5 -326.0Q1394.0 -332 1394.0 -339Q1394.0 -354 1390.5 -369.0Q1387.0 -384 1380.0 -395Q1371.0 -398 1361.5 -399.0Q1352.0 -400 1339.0 -400Q1292.0 -400 1265.0 -367.0Q1238.0 -334 1238.0 -269V-240Q1238.0 -225 1239.0 -211.5Q1240.0 -198 1242.5 -185.0Q1245.0 -172 1249.0 -160Q1270.0 -153 1292.5 -150.0Q1315.0 -147 1343.0 -147Q1384.0 -147 1417.0 -150.5Q1450.0 -154 1481.5 -163.0Q1513.0 -172 1545.0 -188H1551.0Q1555.0 -172 1557.0 -158.0Q1559.0 -144 1559.0 -129Q1559.0 -94 1548.0 -69.0Q1537.0 -44 1516.0 -26Q1500.0 -12 1475.5 -3.0Q1451.0 6 1418.0 10.5Q1385.0 15 1341.0 15Q1272.0 15 1217.5 -4.5Q1163.0 -24 1125.0 -59.0Q1087.0 -94 1067.0 -144.0Q1047.0 -194 1047.0 -255V-263Q1047.0 -327 1068.5 -381.5Q1090.0 -436 1130.0 -476.5Q1170.0 -517 1224.5 -539.0Q1279.0 -561 1345.0 -561Z M1922.0 -560Q1954.0 -560 1977.5 -556.5Q2001.0 -553 2018.5 -546.0Q2036.0 -539 2048.0 -526Q2063.0 -512 2070.0 -489.0Q2077.0 -466 2077.0 -430Q2077.0 -408 2073.5 -385.5Q2070.0 -363 2062.0 -342H2056.0Q2018.0 -367 1989.0 -376.0Q1960.0 -385 1922.0 -385Q1887.0 -385 1864.0 -370.0Q1841.0 -355 1829.5 -327.0Q1818.0 -299 1818.0 -258V-249Q1818.0 -230 1820.5 -212.5Q1823.0 -195 1827.0 -178Q1846.0 -171 1866.0 -167.5Q1886.0 -164 1908.0 -164Q1940.0 -164 1964.5 -168.0Q1989.0 -172 2013.0 -181.5Q2037.0 -191 2064.0 -207H2070.0Q2074.0 -190 2076.5 -171.0Q2079.0 -152 2079.0 -133Q2079.0 -94 2070.5 -67.0Q2062.0 -40 2045.0 -22Q2033.0 -10 2012.0 -2.0Q1991.0 6 1960.5 9.5Q1930.0 13 1891.0 13Q1831.0 13 1782.0 -4.5Q1733.0 -22 1698.5 -56.0Q1664.0 -90 1645.5 -140.0Q1627.0 -190 1627.0 -254V-266Q1627.0 -354 1662.5 -420.0Q1698.0 -486 1764.0 -523.0Q1830.0 -560 1922.0 -560Z M2630.0 -351Q2630.0 -337 2630.0 -322.5Q2630.0 -308 2630.0 -293.0Q2630.0 -278 2630.0 -263.5Q2630.0 -249 2630.0 -234Q2630.0 -219 2630.0 -204.0Q2630.0 -189 2630.0 -174Q2631.0 -174 2634.0 -173.5Q2637.0 -173 2639.0 -173Q2647.0 -173 2656.0 -176.5Q2665.0 -180 2671.0 -186H2677.0Q2679.0 -180 2680.5 -169.0Q2682.0 -158 2682.0 -144Q2682.0 -103 2671.5 -70.5Q2661.0 -38 2646.0 -22Q2629.0 -5 2610.0 2.0Q2591.0 9 2570.0 9Q2545.0 9 2521.0 -4.0Q2497.0 -17 2477.0 -39.0Q2457.0 -61 2445.5 -89.5Q2434.0 -118 2434.0 -148Q2434.0 -181 2434.0 -212.5Q2434.0 -244 2434.0 -277Q2434.0 -291 2436.5 -306.5Q2439.0 -322 2443.0 -338.5Q2447.0 -355 2452.0 -372Q2435.0 -379 2416.0 -382.5Q2397.0 -386 2377.0 -388.0Q2357.0 -390 2335.0 -390Q2305.0 -390 2277.0 -387.0Q2249.0 -384 2221.5 -378.0Q2194.0 -372 2165.0 -363H2159.0Q2156.0 -378 2154.5 -393.5Q2153.0 -409 2153.0 -426Q2153.0 -454 2158.5 -476.5Q2164.0 -499 2180.0 -515Q2195.0 -530 2217.0 -540.0Q2239.0 -550 2278.0 -554.0Q2317.0 -558 2383.0 -558Q2436.0 -558 2480.5 -540.5Q2525.0 -523 2558.5 -493.0Q2592.0 -463 2611.0 -426.5Q2630.0 -390 2630.0 -351ZM2313.0 -180Q2313.0 -162 2320.0 -156.0Q2327.0 -150 2349.0 -150Q2370.0 -150 2388.0 -153.5Q2406.0 -157 2423.5 -166.0Q2441.0 -175 2460.0 -189L2467.0 -91H2438.0Q2427.0 -64 2405.0 -41.0Q2383.0 -18 2351.5 -4.0Q2320.0 10 2279.0 10Q2228.0 10 2192.0 -9.5Q2156.0 -29 2137.0 -65.0Q2118.0 -101 2118.0 -151V-160Q2118.0 -190 2132.5 -219.5Q2147.0 -249 2172.0 -273.5Q2197.0 -298 2228.5 -312.5Q2260.0 -327 2293.0 -327Q2336.0 -327 2370.5 -322.0Q2405.0 -317 2431.0 -307.5Q2457.0 -298 2473.0 -285Q2482.0 -279 2487.5 -268.0Q2493.0 -257 2495.5 -241.5Q2498.0 -226 2498.0 -205Q2476.0 -213 2453.0 -217.0Q2430.0 -221 2408.0 -223.0Q2386.0 -225 2367.0 -225Q2353.0 -225 2341.0 -224.0Q2329.0 -223 2318.0 -220Q2315.0 -210 2314.0 -201.0Q2313.0 -192 2313.0 -182Z M2707.0 -547Q2720.0 -550 2732.5 -551.5Q2745.0 -553 2757.5 -554.0Q2770.0 -555 2783.0 -555Q2830.0 -555 2861.5 -539.5Q2893.0 -524 2909.0 -488.5Q2925.0 -453 2925.0 -392Q2925.0 -318 2925.0 -244.5Q2925.0 -171 2925.0 -98.0Q2925.0 -25 2925.0 48.0Q2925.0 121 2925.0 194Q2913.0 196 2902.0 197.5Q2891.0 199 2879.5 199.5Q2868.0 200 2855.0 200Q2809.0 200 2780.0 180.5Q2751.0 161 2738.0 125.0Q2725.0 89 2725.0 39Q2725.0 -19 2725.0 -73.0Q2725.0 -127 2725.0 -182.0Q2725.0 -237 2725.0 -295.5Q2725.0 -354 2725.0 -420Q2725.0 -457 2721.0 -490.0Q2717.0 -523 2707.0 -547ZM3095.0 -559Q3139.0 -559 3174.5 -531.5Q3210.0 -504 3230.5 -458.0Q3251.0 -412 3251.0 -357V-345Q3251.0 -243 3236.5 -174.0Q3222.0 -105 3196.5 -65.0Q3171.0 -25 3136.5 -7.0Q3102.0 11 3063.0 11Q3033.0 11 3007.5 -0.5Q2982.0 -12 2963.0 -32.0Q2944.0 -52 2931.0 -77H2915.0V-171Q2926.0 -164 2941.0 -159.0Q2956.0 -154 2975.0 -154Q2997.0 -154 3013.0 -165.5Q3029.0 -177 3038.0 -206.5Q3047.0 -236 3047.0 -289V-297Q3047.0 -321 3046.0 -337.5Q3045.0 -354 3043.0 -367Q3038.0 -369 3032.5 -369.5Q3027.0 -370 3022.0 -370Q3001.0 -370 2981.5 -360.0Q2962.0 -350 2946.0 -327.0Q2930.0 -304 2917.0 -265V-423H2931.0Q2950.0 -466 2975.0 -496.0Q3000.0 -526 3030.0 -542.5Q3060.0 -559 3095.0 -559Z",
  };

  function brandWordmark() {
    if (!BRAND_WORDMARK) return el("span", "tldw-wordmark-text", "Precap");
    const svg = svgEl("svg", { class: "tldw-wordmark", viewBox: BRAND_WORDMARK.viewBox, role: "img", "aria-label": "Precap" });
    svg.appendChild(svgEl("path", { d: BRAND_WORDMARK.d }));
    return svg;
  }

  // Small, muted badge in the top-left corner so people know the summary
  // comes from the extension, not from YouTube.
  const head = el("div", "tldw-head");
  head.append(brandMark(), brandWordmark());
  const body = el("div", "tldw-body");
  pop.append(head, body);

  pop.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    // The help link opens in a new tab by itself; keep page handlers out of it.
    if (t && t.closest(".tldw-link")) { e.stopPropagation(); return; }
    const btn = t && t.closest(".tldw-retry");
    if (!btn || !open) return;
    e.preventDefault();
    e.stopPropagation();
    const hadFocus = document.activeElement === btn;
    open.retried = true;
    render({ status: "loading" });
    request(open.videoId);
    if (hadFocus && opener) opener.focus({ preventScroll: true }); // the button is gone
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
    const a = document.activeElement;
    opener = a instanceof Element && card.contains(a) && a.matches(":focus-visible") ? a : null;
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
    if (!(t instanceof Element) || t === quietFocus) return;
    if (pop.contains(t)) return enterPopover();
    if (!t.matches(":focus-visible")) return;
    aim(isActivePage() ? cardFrom(t) : null, null);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (open || dwellTimer)) resetAll();
    else if (e.key === "Tab") tabThroughPopover(e);
  }, true);

  // A popover opened from the keyboard sits at the end of the page, so Tab
  // would never reach its link or button. Tab from the card that opened it
  // steps into the popover's controls, and past the last one (or Shift+Tab
  // past the first) goes back to that card and on through the page.
  function tabThroughPopover(e) {
    if (!open || !opener || !opener.isConnected) return;
    const controls = [...pop.querySelectorAll("a[href], button")];
    if (!controls.length) return;
    const a = document.activeElement;
    if (a === opener) {
      if (!e.shiftKey) { e.preventDefault(); controls[0].focus(); }
      return;
    }
    const i = controls.indexOf(a);
    if (i < 0) return;
    const next = i + (e.shiftKey ? -1 : 1);
    if (next >= 0 && next < controls.length) {
      e.preventDefault();
      controls[next].focus();
    } else {
      if (e.shiftKey) e.preventDefault();
      opener.focus({ preventScroll: true }); // without Shift, Tab then moves on from the card
    }
  }
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
