import test from "node:test";
import assert from "node:assert/strict";
import { parseSse, touchedLogins, startCadenceFeed, coalesceInvalidations } from "../cadence-feed.mjs";

const enc = new TextEncoder();
async function* chunks(...parts) { for (const p of parts) yield enc.encode(p); }
async function collect(gen) { const out = []; for await (const f of gen) out.push(f); return out; }

test("parseSse reassembles frames split across chunks and keeps multi-line data", async () => {
  const frames = await collect(parseSse(chunks("event: heartbeat\ndata:\n\nevent: git", "hub\nid: d-1\ndata: {\"a\":1}\r\n\r\n: comment\ndata: x\ndata: y\n\n")));
  assert.deepEqual(frames, [
    { event: "heartbeat", id: null, data: "" },
    { event: "github", id: "d-1", data: '{"a":1}' },
    { event: "message", id: null, data: "x\ny" },
  ]);
});

test("touchedLogins ignores event types the dashboard does not track", () => {
  assert.equal(touchedLogins({ eventType: "push", payload: { sender: { login: "kwedey" } } }), null);
  assert.equal(touchedLogins({ eventType: "check_run", payload: {} }), null);
});

test("touchedLogins collects author, sender, assignees and reviewers, lower-cased", () => {
  const logins = touchedLogins({ eventType: "pull_request", payload: {
    action: "review_requested", sender: { login: "Alice" }, requested_reviewer: { login: "Bob" },
    pull_request: { user: { login: "Carol" }, assignees: [{ login: "Dave" }], requested_reviewers: [{ login: "Bob" }, { login: "Erin" }] },
  } });
  assert.deepEqual([...logins].sort(), ["alice", "bob", "carol", "dave", "erin"]);
});

test("touchedLogins on an oversize delivery is empty, meaning everyone must reconcile", () => {
  const logins = touchedLogins({ eventType: "issues", payload: null, payloadOmitted: true });
  assert.ok(logins instanceof Set);
  assert.equal(logins.size, 0);
});

function stream(...frames) {
  return { status: 200, ok: true, statusText: "OK", headers: new Headers(), body: chunks(...frames) };
}
const envelope = (id, login, eventType = "issues") => `event: github\nid: ${id}\ndata: ${JSON.stringify({ eventType, deliveryIdentifier: id, payload: { sender: { login } } })}\n\n`;

test("feed polls once on connect, invalidates tracked deliveries, dedupes on delivery id, reconnects on plain close", async () => {
  const calls = [], statuses = [], sleeps = [];
  let opened = 0;
  const feed = startCadenceFeed({
    key: "cdnf.x.y", log: { error() {} },
    fetchImpl: async () => { opened++; return opened === 1 ? stream("event: heartbeat\ndata:\n\n", envelope("d1", "kyle"), envelope("d1", "kyle"), envelope("d2", "kyle", "push")) : stream(); },
    onInvalidate: (logins, reason) => { calls.push([logins ? [...logins] : null, reason]); },
    onStatus: (s) => statuses.push(s.state),
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 2) feed.stop(); },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [[null, "connected"], [["kyle"], "issues"], [null, "connected"]]);
  assert.equal(opened, 2);
  assert.deepEqual(sleeps, [1000, 1000], "a successful connect resets the backoff");
  assert.ok(statuses.includes("live") && statuses.includes("reconnecting"));
});

test("feed backs off exponentially while connects keep failing", async () => {
  const sleeps = [];
  const feed = startCadenceFeed({
    key: "cdnf.x.y", log: { error() {} }, onInvalidate() {}, onStatus() {},
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 3) feed.stop(); },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("feed never reconnects after displaced", async () => {
  let opened = 0; const statuses = [];
  startCadenceFeed({
    key: "cdnf.x.y", log: { error() {} }, onInvalidate() {}, onStatus: (s) => statuses.push(s),
    fetchImpl: async () => { opened++; return stream("event: displaced\ndata:\n\n"); },
    sleep: async () => { throw new Error("should not sleep"); },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(opened, 1);
  assert.equal(statuses.at(-1).state, "error");
  assert.match(statuses.at(-1).detail, /own key/);
});

test("feed stops on 401 and honours Retry-After on 429", async () => {
  let opened = 0; const sleeps = []; const statuses = [];
  const feed = startCadenceFeed({
    key: "cdnf.x.y", log: { error() {} }, onInvalidate() {}, onStatus: (s) => statuses.push(s),
    fetchImpl: async () => { opened++; return opened === 1 ? { status: 429, ok: false, headers: new Headers({ "retry-after": "7" }) } : { status: 401, ok: false, headers: new Headers() }; },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sleeps, [7000]);
  assert.equal(opened, 2);
  assert.equal(statuses.at(-1).state, "error");
  assert.match(statuses.at(-1).detail, /401/);
  feed.stop();
});

test("no key means the feed is off and nothing is fetched", () => {
  let fetched = false; const statuses = [];
  startCadenceFeed({ key: "", fetchImpl: async () => { fetched = true; }, onInvalidate() {}, onStatus: (s) => statuses.push(s) });
  assert.equal(fetched, false);
  assert.deepEqual(statuses, [{ state: "off", detail: "CADENCE_FEED_KEY not set" }]);
});

test("feed refuses to follow a redirect so the key never reaches another host", async () => {
  let opened = 0; const statuses = []; let init;
  startCadenceFeed({
    key: "cdnf.x.y", log: { error() {} }, onInvalidate() {}, onStatus: (s) => statuses.push(s),
    fetchImpl: async (_url, i) => { opened++; init = i; return { status: 302, ok: false, headers: new Headers({ location: "https://evil.example/feed" }) }; },
    sleep: async () => { throw new Error("should not sleep"); },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(init.redirect, "manual");
  assert.equal(opened, 1);
  assert.equal(statuses.at(-1).state, "error");
  assert.match(statuses.at(-1).detail, /redirect/);
});

test("coalesceInvalidations fires once per login per gap, trailing edge, and passes reconnects straight through", () => {
  let t = 0; const calls = [], timers = [];
  const fn = coalesceInvalidations((logins, reason) => calls.push([logins ? [...logins] : null, reason]), 30_000, () => t, (cb, ms) => { timers.push({ cb, at: t + ms }); return timers.length; });
  fn(new Set(["kyle"]), "issues");
  t = 5_000; fn(new Set(["kyle", "sam"]), "pull_request");
  t = 10_000; fn(new Set(["kyle"]), "pull_request_review");
  fn(null, "connected");
  assert.deepEqual(calls, [[["kyle"], "issues"], [["sam"], "pull_request"], [null, "connected"]]);
  assert.deepEqual(timers.map((x) => x.at), [30_000]);
  t = 30_000; timers[0].cb();
  assert.deepEqual(calls.at(-1), [["kyle"], "pull_request"]);
  fn(new Set(["kyle"]), "issues");
  assert.equal(calls.length, 4, "a delivery right after the trailing fire waits for the next gap");
});
