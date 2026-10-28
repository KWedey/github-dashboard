import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUOTA_STALE_MS, createClaudeQuota, readQuota } from "../quota.mjs";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const LIVE = "claude-1a2b3c4d-octocat@acme.com.json", RETIRED = "claude-5e6f7a8b-octocat@acme.com.json";
const DISABLED = "claude-9c0d1e2f-hubot@acme.com.json", RESERVED = "claude-3a4b5c6d-monalisa@acme.com.json";
const entry = (minutesOld) => ({ fetched_at: new Date(NOW - minutesOld * 60e3).toISOString(), usage: { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 30, resets_at: null } } });

function setup(cache, credentials = Object.keys(cache), { run, stuckFile, real = false, script = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-")), authDir = path.join(dir, "auth"), usageCache = path.join(dir, "usage-cache.json"), cpaRoute = path.join(dir, "cpa-route");
  fs.mkdirSync(authDir);
  for (const file of credentials) fs.writeFileSync(path.join(authDir, file), JSON.stringify({ email: "octocat@acme.com" }));
  fs.writeFileSync(usageCache, JSON.stringify(cache));
  fs.writeFileSync(cpaRoute, script, { mode: script ? 0o755 : 0o644 });
  const runs = [], clock = { now: NOW }, waiters = [];
  let refreshed = 0;
  const onRefreshed = () => { refreshed++; for (const wake of waiters.splice(0)) wake(); };
  const make = (file = stuckFile) => createClaudeQuota({ usageCache, authDir, cpaRoute, stuckFile: file, now: () => clock.now, run: real ? undefined : run || ((bin, done) => runs.push(done)), onRefreshed });
  const nextRefresh = () => new Promise((wake) => waiters.push(wake));
  // What a ranking run (or cpa-route's hourly apply) writes for a seat it refetched.
  const fetched = (file, minutesOld = 0) => {
    const c = JSON.parse(fs.readFileSync(usageCache, "utf8"));
    c[file] = { ...c[file], fetched_at: new Date(clock.now - minutesOld * 60e3).toISOString() };
    fs.writeFileSync(usageCache, JSON.stringify(c));
  };
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { quota: make(), make, runs, clock, dir, authDir, usageCache, cpaRoute, fetched, nextRefresh, refreshes: () => refreshed };
}
const minutes = (n) => n * 60e3;
// Reads across two hours, finishing every run without touching the seat: cpa-route never refreshes it.
function readsOverTwoHours({ quota, runs, clock }) {
  for (let i = 0; i < 9; i++) {
    quota.read(false);
    while (runs.length && runs.at(-1).pending !== false) { const done = runs.at(-1); done.pending = false; done(); }
    clock.now += minutes(16);
  }
  return quota.read(false);
}

test("a cache entry for a credential no longer on disk is neither shown nor counted as stale", () => {
  const { quota, runs } = setup({ [LIVE]: entry(5), [RETIRED]: entry(36 * 60) }, [LIVE]);
  const read = quota.read(false);
  assert.deepEqual(read.accounts.map((a) => a.file), [LIVE]);
  assert.equal(read.fetched_at, entry(5).fetched_at);
  assert.equal(runs.length, 0);
});

test("an orphan seat starts no ranking run, however long it sits", () => {
  const t = setup({ [RETIRED]: entry(36 * 60) }, []);
  assert.deepEqual(readsOverTwoHours(t).accounts, []);
  assert.equal(t.runs.length, 1, "only the empty-cache fill");
});

test("a disabled seat starts one ranking run, then shows as stale and starts no more", () => {
  const t = setup({ [DISABLED]: entry(36 * 60) });
  fs.writeFileSync(path.join(t.authDir, DISABLED), JSON.stringify({ email: "hubot@acme.com", disabled: true }));
  const read = readsOverTwoHours(t);
  assert.equal(t.runs.length, 1);
  assert.equal(read.accounts[0].stale, true);
  assert.equal(read.fetched_at, entry(36 * 60).fetched_at, "the header keeps its age");
});

test("a seat reserved through cpa-route's pinning pool, invisible in its auth file, starts one run and no more", () => {
  const t = setup({ [RESERVED]: entry(36 * 60) });
  assert.equal(readsOverTwoHours(t).accounts[0].stale, true);
  assert.equal(t.runs.length, 1);
});

test("a seat whose usage fetch fails every run starts one run and no more", () => {
  const t = setup({ [LIVE]: entry(5), [DISABLED]: entry(20) });
  t.quota.read(false);
  t.runs[0]();
  t.fetched(LIVE);
  for (let i = 0; i < 8; i++) {
    t.clock.now += minutes(16);
    t.quota.read(false);
    for (const done of t.runs.slice(1)) if (done.pending !== false) { done.pending = false; t.fetched(LIVE); done(); }
  }
  const read = t.quota.read(false);
  assert.equal(t.runs.length, 9, "LIVE alone keeps the 15-minute runs going");
  assert.equal(read.accounts.find((a) => a.file === DISABLED).stale, true);
  assert.equal(read.accounts.find((a) => a.file === LIVE).stale, undefined);
});

test("a seat that refreshes keeps the 15-minute check, even beside a stuck one", () => {
  const t = setup({ [LIVE]: entry(1), [DISABLED]: entry(20) });
  t.quota.read(false);
  assert.equal(t.runs.length, 1, "the stale seat starts a run");
  t.runs[0]();
  t.clock.now += minutes(14);
  t.quota.read(false);
  assert.equal(t.runs.length, 1, "LIVE is 15 min old, not past it");
  t.clock.now += minutes(2);
  t.quota.read(false);
  assert.equal(t.runs.length, 2, "LIVE was fresh at the first run, so that run did not mark it stuck");
});

test("a stuck seat whose fetched_at moves counts again", () => {
  const t = setup({ [DISABLED]: entry(20) });
  t.quota.read(false);
  t.runs[0]();
  t.clock.now += minutes(30);
  t.quota.read(false);
  assert.equal(t.runs.length, 1);
  t.fetched(DISABLED, 20);
  assert.equal(t.quota.read(false).accounts[0].stale, undefined);
  assert.equal(t.runs.length, 2);
});

test("stuck seats survive a server restart", () => {
  const t = setup({ [DISABLED]: entry(20) }, undefined, { stuckFile: null });
  const stuckFile = path.join(t.dir, "stuck.json"), first = t.make(stuckFile);
  first.read(false);
  t.runs[0]();
  t.clock.now += minutes(30);
  const restarted = t.make(stuckFile);
  assert.equal(restarted.read(false).accounts[0].stale, true);
  assert.equal(t.runs.length, 1);
});

test("a run that advances a seat but leaves it stale waits out the floor", () => {
  const t = setup({ [LIVE]: entry(40) });
  t.quota.read(false);
  t.fetched(LIVE, 20);
  t.runs[0]();
  t.quota.read(false);
  t.clock.now += QUOTA_STALE_MS;
  t.quota.read(false);
  assert.equal(t.runs.length, 1);
  t.clock.now += 1;
  t.quota.read(false);
  assert.equal(t.runs.length, 2);
});

test("a wall clock stepped back past the last run does not hold the floor shut", () => {
  const t = setup({ [LIVE]: entry(120) });
  t.quota.read(false);
  t.fetched(LIVE, 100);
  t.runs[0]();
  t.clock.now -= minutes(60);
  t.quota.read(false);
  assert.equal(t.runs.length, 2);
  t.fetched(LIVE, 80);
  t.runs[1]();
  t.quota.read(false);
  assert.equal(t.runs.length, 2);
});

test("after a fill run finds no seat, a seat that later lands in the cache starts runs again", () => {
  const t = setup({}, [LIVE]);
  t.quota.read(false);
  t.runs[0]();
  t.clock.now += minutes(30);
  t.quota.read(false);
  assert.equal(t.runs.length, 1);
  t.fetched(LIVE, 20);
  t.quota.read(false);
  assert.equal(t.runs.length, 2);
});

test("a cache with no Claude seat yet starts a ranking run to fill it", () => {
  const { quota, runs } = setup({});
  assert.deepEqual(quota.read(false), { accounts: [], fetched_at: null, refreshing: true });
  assert.equal(runs.length, 1);
});

test("a ranking run that throws on start is not left in flight and still arms the floor", (t) => {
  t.mock.method(console, "error", () => {});
  let starts = 0;
  const { quota, refreshes } = setup({ [LIVE]: entry(20) }, undefined, { run: () => { starts++; throw new Error("spawn EPERM"); } });
  assert.equal(quota.read(false).refreshing, false);
  assert.equal(refreshes(), 1);
  quota.read(false);
  assert.equal(starts, 1);
  quota.read(true);
  assert.equal(starts, 2);
});

test("a cpa-route that cannot be started marks no seat stuck", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = setup({ [LIVE]: entry(20) }, undefined, { real: true });
  s.quota.read(false);
  await s.nextRefresh();
  assert.equal(s.quota.read(false).accounts[0].stale, undefined);
  s.clock.now += QUOTA_STALE_MS + 1;
  assert.equal(s.quota.read(false).refreshing, true, "the seat still counts, so the next run starts once the floor passes");
  await s.nextRefresh();
});

test("a ranking run killed by its timeout marks no seat stuck", () => {
  const { quota, runs } = setup({ [LIVE]: entry(20) });
  quota.read(false);
  runs[0](Object.assign(new Error("cpa-route ranking timed out"), { code: null, killed: true, signal: "SIGTERM" }));
  assert.equal(quota.read(false).accounts[0].stale, undefined);
});

test("a ranking run cpa-route refuses with an exit status still marks the seats it left unchanged", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = setup({ [DISABLED]: entry(20) }, undefined, { real: true, script: "#!/bin/sh\nexit 2\n" });
  s.quota.read(false);
  await s.nextRefresh();
  assert.equal(s.quota.read(false).accounts[0].stale, true);
});

test("a forced read refreshes even right after a refresh", () => {
  const { quota, runs } = setup({ [LIVE]: entry(20) });
  quota.read(false);
  runs[0]();
  quota.read(true);
  assert.equal(runs.length, 2);
});

test("reads during a refresh share it and report it", () => {
  const { quota, runs } = setup({ [LIVE]: entry(20) });
  quota.read(false);
  assert.equal(quota.read(true).refreshing, true);
  assert.equal(runs.length, 1);
  runs[0]();
  assert.equal(quota.read(false).refreshing, false);
});

test("an unreadable auth folder shows every cached seat rather than none", () => {
  const { quota, authDir } = setup({ [LIVE]: entry(5), [RETIRED]: entry(5) }, [LIVE]);
  fs.rmSync(authDir, { recursive: true });
  assert.deepEqual(quota.read(false).accounts.map((a) => a.file).sort(), [LIVE, RETIRED].sort());
});

test("a malformed cache entry is left out instead of failing the whole read", () => {
  const { quota } = setup({ [LIVE]: { ...entry(5), usage: { ...entry(5).usage, limits: "none" } }, [RETIRED]: null });
  const read = quota.read(false);
  assert.deepEqual(read.accounts.map((a) => a.file), [LIVE]);
  assert.deepEqual(read.accounts[0].windows.map((w) => w.pct), [12, 30, null]);
});

test("a cache file holding no object reads as unavailable", () => {
  const { quota, usageCache, runs } = setup({});
  fs.writeFileSync(usageCache, "null");
  assert.equal(quota.read(false), null);
  assert.equal(runs.length, 0);
});

test("a quota read reports the Claude state after its Codex fetch, not before it", async () => {
  const { quota, runs } = setup({ [LIVE]: entry(20) });
  quota.read(false);
  const codex = { file: "codex-7e8f9a0b-octocat@acme.com.json", provider: "codex" };
  const read = await readQuota(quota, async () => { runs[0](); return [codex]; }, false);
  assert.equal(read.refreshing, false);
  assert.deepEqual(read.accounts.map((a) => a.file), [LIVE, codex.file]);
  assert.equal(runs.length, 1);
});

test("a quota read with no Claude cache skips the Codex fetch", async () => {
  const { quota, usageCache } = setup({});
  fs.rmSync(usageCache);
  let codexCalls = 0;
  assert.deepEqual(await readQuota(quota, async () => { codexCalls++; return []; }, true), { available: false });
  assert.equal(codexCalls, 0);
});

test("a quota read hands one auth-folder listing to the Claude reads and the Codex fetch", async () => {
  const seen = [], files = [LIVE, "codex-7e8f9a0b-octocat@acme.com.json"];
  const claude = { read: (force, f) => { seen.push(f); return { accounts: [], fetched_at: null, refreshing: false }; } };
  await readQuota(claude, async (force, f) => { seen.push(f); return []; }, false, files);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((f) => f === files));
});
