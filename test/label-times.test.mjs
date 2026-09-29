import test from "node:test";
import assert from "node:assert/strict";
import { latestLabelTimes } from "../label-times.mjs";

test("latestLabelTimes keeps the most recent time per label, case-insensitive", () => {
  const times = latestLabelTimes([
    { createdAt: "2026-09-01T00:00:00Z", label: { name: "Needs Testing" } },
    { createdAt: "2026-09-10T00:00:00Z", label: { name: "needs testing" } },
    { createdAt: "2026-09-05T00:00:00Z", label: { name: "Needs Testing" } },
    { createdAt: "2026-09-03T00:00:00Z", label: { name: "stale" } },
    {},
  ]);
  assert.deepEqual(times, { "needs testing": "2026-09-10T00:00:00Z", stale: "2026-09-03T00:00:00Z" });
});

test("latestLabelTimes tolerates a missing timeline", () => {
  assert.deepEqual(latestLabelTimes(undefined), {});
});
