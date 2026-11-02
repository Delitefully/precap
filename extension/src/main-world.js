// Precap - page (MAIN world) half.
//
// Runs inside youtube.com's own JS context so it can read `ytcfg` and call
// InnerTube with the page's session, the same way YouTube's own code does.
// It never stores or forwards credentials: the auth header is computed per
// request from the page's cookies and sent only to www.youtube.com.
//
// Protocol (window.postMessage, same window, same origin):
//   UI -> page: { tldw: 1, dir: "req", type: "summarize", id, videoId }
//               { tldw: 1, dir: "req", type: "cancel", id }
//   page -> UI: { tldw: 1, dir: "res", id, status, text?, detail? }
//   status: "ok" | "logged_out" | "unavailable" | "no_ask" | "error" | "aborted"
// Only same-window, same-origin messages are accepted, so iframes (ads,
// embeds) cannot use the bridge. Other scripts in this page's own JS world can,
// but they already have the page's full session; the bridge only lets them ask
// the fixed prompt about a valid videoId, never pick a URL, endpoint or body.
(() => {
  "use strict";
  if (window.__tldwMain) return;
  window.__tldwMain = true;

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

  const session = { unavailable: false, askSeen: false, probe: null };
  const inflight = new Map(); // id -> { ctrl, phase, since, keep }
  const askTimes = []; // performance.now() of each Ask question in the last minute

  const cfg = (k) => (window.ytcfg && typeof window.ytcfg.get === "function" ? window.ytcfg.get(k) : undefined);
  const log = (...a) => { if (DEBUG) console.debug("[tldw]", ...a); };

  function asksLastMinute() {
    const now = performance.now();
    while (askTimes.length && now - askTimes[0] > 60000) askTimes.shift();
    return askTimes.length;
  }

  function getCookie(name) {
    for (const part of document.cookie.split(";")) {
      const s = part.trim();
      if (s.startsWith(name + "=")) return s.slice(name.length + 1);
    }
    return null;
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Mirrors YouTube's own Authorization header:
  //   SAPISIDHASH <ts>_<sha1>[_u] SAPISID1PHASH ... SAPISID3PHASH ...
  // where sha1 = SHA1("[<USER_SESSION_ID> ]<ts> <cookie> <origin>").
  async function authHeader() {
    const userSessionId = cfg("USER_SESSION_ID");
    const pairs = [
      ["SAPISIDHASH", getCookie("SAPISID") || getCookie("__Secure-3PAPISID")],
      ["SAPISID1PHASH", getCookie("__Secure-1PAPISID")],
      ["SAPISID3PHASH", getCookie("__Secure-3PAPISID")],
    ];
    const parts = [];
    for (const [name, value] of pairs) {
      if (!value) continue;
      const ts = Math.floor(Date.now() / 1000);
      const input = (userSessionId ? [userSessionId, ts, value, ORIGIN] : [ts, value, ORIGIN]).join(" ");
      const token = [ts, await sha1Hex(input)];
      if (userSessionId) token.push("u");
      parts.push(name + " " + token.join("_"));
    }
    return parts.length ? parts.join(" ") : null;
  }

  function isLoggedIn() {
    return cfg("LOGGED_IN") === true && !!(getCookie("SAPISID") || getCookie("__Secure-3PAPISID"));
  }

  class HttpError extends Error {
    constructor(status) { super("HTTP " + status); this.status = status; }
  }

  async function innertube(endpoint, body, signal) {
    const context = cfg("INNERTUBE_CONTEXT");
    if (!context) throw new Error("no INNERTUBE_CONTEXT");
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

    // Absolute URL: a relative one would follow a <base href> on the page.
    const res = await nativeFetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ context: structuredClone(context), ...body }),
      signal,
    });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  }

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

  // From a `next` response, pull the tokens the Ask panel would use:
  //   query: the free-text box's continuation (custom prompt)
  //   summarize: the "Summarize the video" chip's continuation (fallback)
  function askTokens(nextJson) {
    const panel = find(nextJson, (o) => o.panelIdentifier === "PAyouchat" && o.engagementPanel);
    if (!panel) return null;
    const send = find(panel, (o) => o.sendUserQueryCommand);
    const query = send?.sendUserQueryCommand?.innertubeCommand?.continuationCommand?.token || null;
    const chips = find(panel, (o) => Array.isArray(o.chipData));
    const first = chips?.chipData?.find((c) => c.continuation);
    const summarize = first?.continuation || null;
    return query || summarize ? { query, summarize } : null;
  }

  function answerText(panelJson) {
    const texts = [];
    const stack = [panelJson];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      const t = o.youChatItemViewModel?.text?.content;
      if (typeof t === "string" && t.trim()) texts.push(t.trim());
      for (const k in o) if (o[k] && typeof o[k] === "object") stack.push(o[k]);
    }
    return texts.length ? texts.reduce((a, b) => (b.length > a.length ? b : a)) : null;
  }

  async function probeAskAvailable(signal) {
    if (!session.probe) {
      session.probe = innertube("next", { videoId: PROBE_VIDEO_ID }, signal)
        .then((j) => !!askTokens(j))
        .catch((e) => { session.probe = null; throw e; });
    }
    return session.probe;
  }

  async function summarize(id, videoId) {
    const ctrl = new AbortController();
    const entry = { ctrl, phase: "next", since: performance.now(), keep: false, timedOut: false };
    inflight.set(id, entry);
    const timer = setTimeout(() => { entry.timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
    try {
      if (FORCE_STATUS) {
        await new Promise((r) => setTimeout(r, 600));
        return { status: FORCE_STATUS };
      }
      if (!isLoggedIn()) return { status: "logged_out" };
      if (session.unavailable) return { status: "unavailable" };
      if (asksLastMinute() >= MAX_ASKS_PER_MIN) return { status: "error", detail: "local rate limit" };

      const next = await innertube("next", { videoId }, ctrl.signal);
      if (next?.responseContext?.mainAppWebResponseContext?.loggedOut === true) return { status: "logged_out" };
      if (!next || typeof next !== "object" || (!next.contents && !next.playerOverlays)) {
        return { status: "error", detail: "unexpected next response" };
      }
      const tokens = askTokens(next);
      if (!tokens) {
        if (!session.askSeen) {
          const ok = await probeAskAvailable(ctrl.signal).catch(() => null);
          if (ok === false) { session.unavailable = true; return { status: "unavailable" }; }
        }
        return { status: "no_ask" };
      }
      session.askSeen = true;

      if (asksLastMinute() >= MAX_ASKS_PER_MIN) return { status: "error", detail: "local rate limit" };
      askTimes.push(performance.now());
      entry.phase = "answer";
      entry.since = performance.now();
      const inputComposerFormData = { clientMessageId: "youchat-" + Date.now(), playerOffsetMs: "0" };
      if (tokens.query) inputComposerFormData.userInputText = PROMPT;
      const panel = await innertube(
        "get_panel",
        { continuation: tokens.query || tokens.summarize, formData: { inputComposerFormData } },
        ctrl.signal
      );
      const text = answerText(panel);
      if (!text) return { status: "error", detail: "no answer in response" };
      if (REGION_RE.test(text) && text.length < 300) { session.unavailable = true; return { status: "unavailable" }; }
      return { status: "ok", text, custom: !!tokens.query };
    } catch (e) {
      if (e?.name === "AbortError") return entry.timedOut ? { status: "error", detail: "timeout" } : { status: "aborted" };
      if (e instanceof HttpError) return { status: "error", detail: e.message, http: e.status };
      return { status: "error", detail: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
      inflight.delete(id);
    }
  }

  function reply(id, result) {
    window.postMessage({ tldw: 1, dir: "res", id, ...result }, ORIGIN);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const m = ev.data;
    if (!m || m.tldw !== 1 || m.dir !== "req" || typeof m.id !== "string") return;
    if (m.type === "summarize") {
      if (typeof m.videoId !== "string" || !/^[\w-]{11}$/.test(m.videoId)) return;
      log("summarize", m.videoId);
      summarize(m.id, m.videoId).then((r) => { log("result", m.videoId, r.status, r.detail || ""); reply(m.id, r); });
    } else if (m.type === "cancel") {
      const e = inflight.get(m.id);
      if (!e) return;
      if (e.phase === "answer" && performance.now() - e.since > KEEP_AFTER_MS) {
        e.keep = true; // almost back: let it land in the cache
        log("cancel ignored, almost done", m.id);
      } else {
        e.ctrl.abort();
      }
    }
  });
})();
