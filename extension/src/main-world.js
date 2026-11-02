// Precap - page half (MAIN world). Runs in youtube.com's own JS world so it
// can read `ytcfg` and call InnerTube with the page's session, the same way
// YouTube's own code does. It exposes nothing on `window`, and never stores or
// forwards credentials: the auth header is computed per request from the
// page's cookies and sent only to www.youtube.com.
//
// Protocol (window.postMessage, same window, same origin):
//   UI -> page: { tldw: 1, dir: "req", type: "summarize", id, videoId }
//               { tldw: 1, dir: "req", type: "cancel", id }
//   page -> UI: { tldw: 1, dir: "res", id, status, text?, detail? }
//   status: "ok" | "logged_out" | "unavailable" | "no_ask" | "error" | "aborted"
(() => {
  "use strict";

  const ORIGIN = location.origin;
  const nativeFetch = window.fetch.bind(window);

  const PROMPT =
    "TL;DW: give the point of this video as 2 or 3 bullet points, " +
    "each a short statement of at most 10 words. Lead with the main takeaway. " +
    "No intro, no timestamps, no bold, no ending periods.";

  // A long-lived video that has always had Ask. Used once per session to tell
  // "this video has no Ask" apart from "Ask is off for this account/region".
  const PROBE_VIDEO_ID = "aircAruvnKk";
  const TIMEOUT_MS = 15000;
  // A request that has been waiting this long for the answer is "almost back":
  // a cancel lets it finish so the result lands in the cache.
  const KEEP_AFTER_MS = 1500;
  // Hard cap on Ask questions sent as the user, whatever the UI does.
  const MAX_ASKS_PER_MIN = 10;
  // Dev only, edit here (never read from the page): log to the console, or
  // force a guard state ("logged_out" | "unavailable" | "no_ask" | "error").
  const DEBUG = false;
  const FORCE_STATUS = "";
  const REGION_RE =
    /(not|isn't|is not) (yet )?available (in your (country|region|language)|for your account)/i;
  const VIDEO_ID_RE = /^[\w-]{11}$/;
  const RATE_LIMITED = { status: "error", detail: "local rate limit" };

  const session = { unavailable: false, askSeen: false, probe: null };
  const inflight = new Map(); // id -> { ctrl, answerAt, timedOut }
  const askTimes = []; // performance.now() of each Ask question in the last minute

  const cfg = (k) => window.ytcfg?.get?.(k);
  const log = (...a) => { if (DEBUG) console.debug("[tldw]", ...a); };

  function atCap() {
    const now = performance.now();
    while (askTimes.length && now - askTimes[0] > 60000) askTimes.shift();
    return askTimes.length >= MAX_ASKS_PER_MIN;
  }

  // ---------- auth headers ----------

  function getCookie(name) {
    for (const part of document.cookie.split(";")) {
      const s = part.trim();
      if (s.startsWith(name + "=")) return s.slice(name.length + 1);
    }
    return null;
  }

  const sapisid = () => getCookie("SAPISID") || getCookie("__Secure-3PAPISID");

  // Mirrors YouTube's own Authorization header:
  //   SAPISIDHASH <ts>_<sha1>[_u] SAPISID1PHASH ... SAPISID3PHASH ...
  // where sha1 = SHA1("[<USER_SESSION_ID> ]<ts> <cookie> <origin>").
  async function authHeader() {
    const userSessionId = cfg("USER_SESSION_ID");
    const pairs = [
      ["SAPISIDHASH", sapisid()],
      ["SAPISID1PHASH", getCookie("__Secure-1PAPISID")],
      ["SAPISID3PHASH", getCookie("__Secure-3PAPISID")],
    ];
    const parts = [];
    for (const [name, value] of pairs) {
      if (!value) continue;
      const ts = Math.floor(Date.now() / 1000);
      const input = new TextEncoder().encode([userSessionId, ts, value, ORIGIN].filter(Boolean).join(" "));
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).toHex();
      parts.push(`${name} ${ts}_${hash}${userSessionId ? "_u" : ""}`);
    }
    return parts.join(" ");
  }

  async function innertubeHeaders(context) {
    const headers = {
      "Content-Type": "application/json",
      "X-Origin": ORIGIN,
      "X-Youtube-Client-Name": String(cfg("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 1),
      "X-Youtube-Client-Version": String(cfg("INNERTUBE_CLIENT_VERSION") || context.client?.clientVersion || ""),
      "X-Youtube-Bootstrap-Logged-In": "true",
    };
    const visitor = cfg("VISITOR_DATA") || context.client?.visitorData;
    if (visitor) headers["X-Goog-Visitor-Id"] = visitor;
    const auth = await authHeader();
    if (auth) {
      headers["Authorization"] = auth;
      headers["X-Goog-AuthUser"] = String(cfg("SESSION_INDEX") ?? 0);
    }
    const pageId = cfg("DELEGATED_SESSION_ID");
    if (pageId) headers["X-Goog-PageId"] = String(pageId);
    return headers;
  }

  // ---------- InnerTube calls ----------

  async function innertube(endpoint, body, signal) {
    const context = cfg("INNERTUBE_CONTEXT");
    if (!context) throw new Error("no INNERTUBE_CONTEXT");
    const headers = await innertubeHeaders(context);
    // Absolute URL: a relative one would follow a <base href> on the page.
    const res = await nativeFetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers,
      body: JSON.stringify({ context, ...body }),
      signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // Asks the prompt through the Ask panel's free-text box, or falls back to
  // its "Summarize the video" chip.
  function askPanel(tokens, signal) {
    const inputComposerFormData = { clientMessageId: "youchat-" + Date.now(), playerOffsetMs: "0" };
    if (tokens.query) inputComposerFormData.userInputText = PROMPT;
    return innertube(
      "get_panel",
      { continuation: tokens.query || tokens.summarize, formData: { inputComposerFormData } },
      signal
    );
  }

  // ---------- answer parsing ----------

  // Depth-first search for the first object that satisfies `pred`.
  function find(root, pred) {
    const stack = [root];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      if (pred(o)) return o;
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return null;
  }

  // From a `next` response, the tokens the Ask panel would use:
  //   query: the free-text box's continuation (custom prompt)
  //   summarize: the "Summarize the video" chip's continuation (fallback)
  function askTokens(nextJson) {
    const panel = find(nextJson, (o) => o.panelIdentifier === "PAyouchat" && o.engagementPanel);
    if (!panel) return null;
    const query = find(panel, (o) => o.sendUserQueryCommand)?.sendUserQueryCommand.innertubeCommand?.continuationCommand?.token;
    const summarize = find(panel, (o) => Array.isArray(o.chipData))?.chipData.find((c) => c.continuation)?.continuation;
    return query || summarize ? { query, summarize } : null;
  }

  // The longest answer text in a get_panel response (first one on a tie).
  function answerText(panelJson) {
    let best = null;
    find(panelJson, (o) => {
      const t = o.youChatItemViewModel?.text?.content;
      if (typeof t === "string" && t.trim().length > (best?.length ?? 0)) best = t.trim();
    });
    return best;
  }

  // ---------- summarize ----------

  // A video without Ask: "no_ask", or "unavailable" when the probe video has
  // no Ask either (checked once, and only until any video has shown Ask).
  async function withoutAsk(signal) {
    if (!session.askSeen) {
      session.probe ??= innertube("next", { videoId: PROBE_VIDEO_ID }, signal)
        .then((j) => !!askTokens(j), () => { session.probe = null; });
      if ((await session.probe) === false) { session.unavailable = true; return { status: "unavailable" }; }
    }
    return { status: "no_ask" };
  }

  async function askAbout(videoId, entry) {
    const { signal } = entry.ctrl;
    if (FORCE_STATUS) {
      await new Promise((r) => setTimeout(r, 600));
      return { status: FORCE_STATUS };
    }
    if (cfg("LOGGED_IN") !== true || !sapisid()) return { status: "logged_out" };
    if (session.unavailable) return { status: "unavailable" };
    if (atCap()) return RATE_LIMITED;

    const next = await innertube("next", { videoId }, signal);
    if (next?.responseContext?.mainAppWebResponseContext?.loggedOut === true) return { status: "logged_out" };
    if (!next?.contents && !next?.playerOverlays) return { status: "error", detail: "unexpected next response" };
    const tokens = askTokens(next);
    if (!tokens) return withoutAsk(signal);
    session.askSeen = true;

    if (atCap()) return RATE_LIMITED;
    askTimes.push(performance.now());
    entry.answerAt = performance.now();
    const text = answerText(await askPanel(tokens, signal));
    if (!text) return { status: "error", detail: "no answer in response" };
    if (REGION_RE.test(text) && text.length < 300) { session.unavailable = true; return { status: "unavailable" }; }
    return { status: "ok", text };
  }

  // Tracks the request so it can be cancelled or time out, and turns any
  // failure into a status.
  async function summarize(id, videoId) {
    const ctrl = new AbortController();
    const entry = { ctrl, answerAt: 0, timedOut: false };
    inflight.set(id, entry);
    const timer = setTimeout(() => { entry.timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
    try {
      return await askAbout(videoId, entry);
    } catch (e) {
      if (e?.name === "AbortError") return entry.timedOut ? { status: "error", detail: "timeout" } : { status: "aborted" };
      return { status: "error", detail: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
      inflight.delete(id);
    }
  }

  function cancel(id) {
    const e = inflight.get(id);
    if (!e) return;
    if (e.answerAt && performance.now() - e.answerAt > KEEP_AFTER_MS) log("cancel ignored, almost done", id);
    else e.ctrl.abort();
  }

  // ---------- messages ----------

  // Only same-window, same-origin messages are accepted, so iframes (ads,
  // embeds) cannot use the bridge. Other scripts in this page's own JS world
  // can, but they already have the page's full session; the bridge only lets
  // them ask the fixed prompt about a valid videoId, never pick a URL,
  // endpoint or body.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const m = ev.data;
    if (!m || m.tldw !== 1 || m.dir !== "req" || typeof m.id !== "string") return;
    if (m.type === "summarize") {
      if (typeof m.videoId !== "string" || !VIDEO_ID_RE.test(m.videoId)) return;
      log("summarize", m.videoId);
      summarize(m.id, m.videoId).then((r) => {
        log("result", m.videoId, r.status, r.detail || "");
        window.postMessage({ tldw: 1, dir: "res", id: m.id, ...r }, ORIGIN);
      });
    } else if (m.type === "cancel") {
      cancel(m.id);
    }
  });
})();
