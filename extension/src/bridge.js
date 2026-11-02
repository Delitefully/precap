// Precap - client for the page half (main-world.js). Sends summarize and
// cancel requests over window.postMessage, at most MAX_INFLIGHT at once, turns
// replies into results, and keeps them in memory for the life of the page.
Precap.bridge = (() => {
  "use strict";

  const { MAX_INFLIGHT } = Precap.config;
  const ORIGIN = location.origin;
  const STATUSES = new Set(["ok", "logged_out", "unavailable", "no_ask", "error", "aborted"]);

  const cache = new Map(); // videoId -> { status: "ok", bullets | text } | { status: "no_ask" }
  const pending = new Map(); // request id -> videoId
  let sessionResult = null; // { status: "logged_out" | "unavailable" } once known
  let seq = 0;
  let replyHandler = () => {};

  // ---------- answer text ----------

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

  // ---------- requests ----------

  function post(msg) {
    window.postMessage({ tldw: 1, dir: "req", ...msg }, ORIGIN);
  }

  // What is known about a video without asking: its cached result, or a
  // status that holds for every video this session.
  function known(videoId) {
    return cache.get(videoId) || sessionResult;
  }

  function pendingFor(videoId) {
    return [...pending].find(([, v]) => v === videoId)?.[0];
  }

  // Returns the new request's id, or null while MAX_INFLIGHT are pending.
  function ask(videoId) {
    if (pending.size >= MAX_INFLIGHT) return null;
    const id = "r" + ++seq + "-" + Math.random().toString(36).slice(2, 8);
    pending.set(id, videoId);
    post({ type: "summarize", id, videoId });
    return id;
  }

  function cancel(id) {
    post({ type: "cancel", id });
  }

  // ---------- replies ----------

  function resultOf(m) {
    if (m.status !== "ok") return { status: m.status };
    return typeof m.text === "string" && m.text.trim() ? parseAnswer(m.text) : { status: "error" };
  }

  function remember(videoId, result) {
    if (result.status === "ok" || result.status === "no_ask") cache.set(videoId, result);
    else if (result.status === "logged_out" || result.status === "unavailable") sessionResult = result;
  }

  // Only well-formed replies from this window, for a request still pending,
  // are used; anything else is dropped.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const m = ev.data;
    if (!m || m.tldw !== 1 || m.dir !== "res" || typeof m.id !== "string" || !STATUSES.has(m.status)) return;
    const videoId = pending.get(m.id);
    if (!videoId) return;
    pending.delete(m.id);
    const result = resultOf(m);
    remember(videoId, result);
    replyHandler(m.id, result);
  });

  function onReply(fn) {
    replyHandler = fn;
  }

  return { known, pendingFor, ask, cancel, onReply };
})();
