import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUOTA_STALE_MS, createClaudeQuota } from "../quota.mjs";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const LIVE = "claude-1a2b3c4d-octocat@acme.com.json", RETIRED = "claude-5e6f7a8b-octocat@acme.com.json";
const entry = (minutesOld) => ({ fetched_at: new Date(NOW - minutesOld * 60e3).toISOString(), usage: { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 30, resets_at: null } } });

function setup(cache, credentials = Object.keys(cache), { run } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-")), authDir = path.join(dir, "auth"), usageCache = path.join(dir, "usage-cache.json"), cpaRoute = path.join(dir, "cpa-route");
  fs.mkdirSync(authDir);
  for (const file of credentials) fs.writeFileSync(path.join(authDir, file), JSON.stringify({ email: "octocat@acme.com" }));
  fs.writeFileSync(usageCache, JSON.stringify(cache));
  fs.writeFileSync(cpaRoute, "");
  const runs = [], clock = { now: NOW };
  let refreshed = 0;
  const quota = createClaudeQuota({ usageCache, authDir, cpaRoute, now: () => clock.now, run: run || ((bin, done) => runs.push(done)), onRefreshed: () => refreshed++ });
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { quota, runs, clock, authDir, refreshes: () => refreshed };
}

test("a cache entry for a credential no longer on disk is neither shown nor counted as stale", () => {
  const { quota, runs } = setup({ [LIVE]: entry(5), [RETIRED]: entry(36 * 60) }, [LIVE]);
  const read = quota.read(false);
  assert.deepEqual(read.accounts.map((a) => a.file), [LIVE]);
  assert.equal(read.fetched_at, entry(5).fetched_at);
  assert.equal(runs.length, 0);
});

test("a disabled or reserved seat is shown but not counted as stale, since cpa-route ranking skips it", () => {
  const DISABLED = "claude-9c0d1e2f-hubot@acme.com.json", RESERVED = "claude-3a4b5c6d-monalisa@acme.com.json";
  const { quota, runs, authDir } = setup({ [LIVE]: entry(5), [DISABLED]: entry(36 * 60), [RESERVED]: entry(36 * 60) });
  fs.writeFileSync(path.join(authDir, DISABLED), JSON.stringify({ email: "hubot@acme.com", disabled: true }));
  fs.writeFileSync(path.join(authDir, RESERVED), JSON.stringify({ email: "monalisa@acme.com", reserved: true }));
  const read = quota.read(false);
  assert.deepEqual(read.accounts.map((a) => a.file).sort(), [LIVE, DISABLED, RESERVED].sort());
  assert.equal(read.fetched_at, entry(5).fetched_at);
  assert.equal(runs.length, 0);
});

test("a seat whose auth file says reserved: false is ranked, so its stale entry starts a refresh", () => {
  const { quota, runs, authDir } = setup({ [LIVE]: entry(20) });
  fs.writeFileSync(path.join(authDir, LIVE), JSON.stringify({ email: "octocat@acme.com", reserved: false }));
  assert.equal(quota.read(false).fetched_at, entry(20).fetched_at);
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

test("a refresh that leaves a seat stale does not start another until the stale window has passed", () => {
  const { quota, runs, clock, refreshes } = setup({ [LIVE]: entry(20) });
  quota.read(false);
  assert.equal(runs.length, 1);
  runs[0]();
  assert.equal(refreshes(), 1);
  // Every open page reloads on the refreshed event; the cache is unchanged, so this read still sees a stale seat.
  quota.read(false);
  clock.now += QUOTA_STALE_MS;
  quota.read(false);
  assert.equal(runs.length, 1);
  clock.now += 1;
  quota.read(false);
  assert.equal(runs.length, 2);
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
