const test = require("node:test");
const assert = require("node:assert/strict");
const { windowView, cardSpent } = require("../public/quota-view.js");

const NOW = Date.parse("2026-10-28T12:00:00Z");
const at = (hours) => new Date(NOW + hours * 3600e3).toISOString();

test("a live window past 95% is spent, with its reset countdown", () => {
  assert.deepEqual(windowView({ name: "7 day", pct: 100, resets_at: at(7) }, { now: NOW }), { cls: " bad", state: "Spent", reset: "resets in <b>7h 00m</b>", showWhen: true });
  assert.equal(windowView({ name: "5 hour", pct: 80, resets_at: at(2) }, { now: NOW }).state, "Warning");
});

test("a stale window has no spent or warning state", () => {
  const v = windowView({ name: "7 day", pct: 100, resets_at: at(7) }, { stale: true, now: NOW });
  assert.equal(v.cls, "");
  assert.equal(v.state, "");
  assert.equal(v.reset, "resets in <b>7h 00m</b>");
});

test("a stale window whose reset is behind us says reset passed, not resetting", () => {
  assert.deepEqual(windowView({ name: "5 hour", pct: 100, resets_at: at(-30) }, { stale: true, now: NOW }), { cls: "", state: "", reset: "reset passed", showWhen: false });
  assert.equal(windowView({ name: "5 hour", pct: 100, resets_at: at(-30) }, { now: NOW }).reset, "<b>resetting</b>", "a live card's numbers are current, so it is resetting now");
});

test("a reset under a minute away reads resetting, not resets in resetting", () => {
  const soon = new Date(NOW + 20e3).toISOString();
  assert.equal(windowView({ name: "5 hour", pct: 100, resets_at: soon }, { now: NOW }).reset, "<b>resetting</b>");
  assert.deepEqual(windowView({ name: "5 hour", pct: 100, resets_at: soon }, { stale: true, now: NOW }), { cls: "", state: "", reset: "<b>resetting</b>", showWhen: true });
});

test("an unparseable reset time reads as unknown, with no date beside it", () => {
  assert.deepEqual(windowView({ name: "7 day", pct: 40, resets_at: "soon" }, { now: NOW }), { cls: "", state: "", reset: "reset unknown", showWhen: false });
  assert.deepEqual(windowView({ name: "7 day", pct: 40, resets_at: "soon" }, { stale: true, now: NOW }), { cls: "", state: "", reset: "reset unknown", showWhen: false });
});

test("a stale card never shows as spent", () => {
  const windows = [{ name: "7 day", pct: 100, resets_at: at(-1) }];
  assert.equal(cardSpent({ windows }), true);
  assert.equal(cardSpent({ windows, stale: true }), false);
});
