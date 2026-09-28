// Subscriber for Cadence's GitHub webhook feed (GET /api/webhooks/feed, Server-Sent Events).
// The feed has no replay, so it is an invalidation channel: every (re)connect must be followed by a poll.

export const DEFAULT_FEED_URL = "https://cadence.trainerroad.com/api/webhooks/feed";
const HEARTBEAT_MS = 15_000;
const STALL_MS = HEARTBEAT_MS * 4;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const SEEN_MAX = 5_000;

export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = "", frame = { event: "message", id: null, data: [] };
  const flush = () => { const f = frame; frame = { event: "message", id: null, data: [] }; return { event: f.event, id: f.id, data: f.data.join("\n") }; };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") { if (frame.data.length || frame.id !== null || frame.event !== "message") yield flush(); continue; }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") frame.event = value;
      else if (field === "data") frame.data.push(value);
      else if (field === "id") frame.id = value;
    }
  }
  if (frame.data.length) yield flush();
}

const TRACKED_EVENTS = new Set(["issues", "pull_request", "pull_request_review", "pull_request_review_thread"]);

export function touchedLogins(envelope) {
  if (!envelope || !TRACKED_EVENTS.has(envelope.eventType)) return null;
  if (envelope.payloadOmitted || !envelope.payload) return new Set();
  const p = envelope.payload, subject = p.pull_request || p.issue || {};
  const logins = new Set();
  const add = (u) => { if (u && typeof u.login === "string") logins.add(u.login.toLowerCase()); };
  add(p.sender); add(subject.user); add(p.assignee); add(p.requested_reviewer);
  for (const a of subject.assignees || []) add(a);
  for (const r of subject.requested_reviewers || []) add(r);
  if (p.review) add(p.review.user);
  return logins;
}

export function startCadenceFeed({ key, url = DEFAULT_FEED_URL, onInvalidate, onStatus = () => {}, log = console, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!key) { onStatus({ state: "off", detail: "CADENCE_FEED_KEY not set" }); return { stop() {} }; }
  let stopped = false, controller = null, backoff = RECONNECT_MIN_MS;
  const seen = new Set();
  const remember = (id) => { if (!id) return true; if (seen.has(id)) return false; seen.add(id); if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value); return true; };

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      let stall = null;
      const armStall = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(new Error("no heartbeat")), STALL_MS); };
      try {
        onStatus({ state: "connecting" });
        const res = await fetchImpl(url, { headers: { "x-relay-key": key, Accept: "text/event-stream" }, signal: controller.signal, redirect: "manual" });
        if (res.status >= 300 && res.status < 400) { onStatus({ state: "error", detail: `Cadence feed URL redirects (${res.status}); the key is only sent to the configured host` }); return; }
        if (res.status === 401) { onStatus({ state: "error", detail: "Cadence rejected the feed key (401); reissue it at Settings → Feed Keys" }); return; }
        if (res.status === 429) {
          const wait = Math.max(1, Number(res.headers.get("retry-after")) || 30) * 1000;
          onStatus({ state: "waiting", detail: `Cadence says this key has too many streams open; retrying in ${Math.round(wait / 1000)}s` });
          await sleep(wait); continue;
        }
        if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
        onStatus({ state: "live" });
        backoff = RECONNECT_MIN_MS;
        armStall();
        await onInvalidate(null, "connected");
        for await (const frame of parseSse(res.body)) {
          armStall();
          if (frame.event === "displaced") {
            onStatus({ state: "error", detail: "Cadence displaced this stream: another tool is using the same feed key. Give this dashboard its own key." });
            return;
          }
          if (frame.event !== "github") continue;
          let envelope; try { envelope = JSON.parse(frame.data); } catch { continue; }
          if (!remember(frame.id || envelope.deliveryIdentifier)) continue;
          const logins = touchedLogins(envelope);
          if (logins) await onInvalidate(logins, envelope.eventType);
        }
        onStatus({ state: "reconnecting", detail: "stream ended" });
      } catch (e) {
        if (stopped) return;
        onStatus({ state: "reconnecting", detail: e.message });
        log.error("cadence feed:", e.message);
      } finally { clearTimeout(stall); }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  };
  run();
  return { stop() { stopped = true; controller?.abort(new Error("stopped")); onStatus({ state: "off", detail: "stopped" }); } };
}

export function coalesceInvalidations(invalidate, minGapMs = 30_000, now = Date.now, schedule = setTimeout) {
  const last = new Map(), pending = new Map();
  const fire = (login, reason) => { last.set(login, now()); pending.delete(login); invalidate(login === "*" ? null : new Set([login]), reason); };
  return (logins, reason) => {
    if (!logins) { fire("*", reason); return; }
    for (const login of logins) {
      if (pending.has(login)) continue;
      const wait = last.has(login) ? last.get(login) + minGapMs - now() : 0;
      if (wait <= 0) fire(login, reason);
      else pending.set(login, schedule(() => fire(login, reason), wait));
    }
  };
}
