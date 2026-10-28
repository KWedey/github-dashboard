// How a quota card shows its windows. Loaded as a classic script by index.html (exposes window.QuotaView)
// and required by test/quota-view.test.js under Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.QuotaView = api;
})(this, function () {
  const SPENT_PCT = 95, WARN_PCT = 75;
  // A healthy seat peaks near 22 min old: the 15-min window, the page's 5-min poll, a run of up to 2 min.
  // Past two windows at least one refresh has failed, so the numbers are no longer current.
  const OLD_AFTER_MS = 30 * 60 * 1000;
  function untilText(iso, now = Date.now()) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    const mins = Math.round((at - now) / 60000);
    if (mins <= 0) return "resetting";
    const h = Math.floor(mins / 60), m = mins % 60;
    return h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }
  // A stale card's numbers are old: no spent or warning state, and a reset time already behind us says so.
  function windowView(w, { stale = false, now = Date.now() } = {}) {
    const level = stale ? "" : w.pct >= SPENT_PCT ? "bad" : w.pct >= WARN_PCT ? "warn" : "";
    const until = untilText(w.resets_at, now), resetPassed = stale && Date.parse(w.resets_at) <= now;
    const reset = resetPassed ? "reset passed" : until === "resetting" ? "<b>resetting</b>" : until ? `resets in <b>${until}</b>` : w.pct ? "reset unknown" : "unused";
    return { cls: level ? ` ${level}` : "", state: { bad: "Spent", warn: "Warning" }[level] || "", reset, showWhen: Boolean(until) && !resetPassed };
  }
  const cardStale = (a, now = Date.now()) => Boolean(a.stale) || now - Date.parse(a.fetched_at) > OLD_AFTER_MS;
  const cardSpent = (a, now = Date.now()) => !cardStale(a, now) && a.windows.some((w) => /^(5 hour|7 day)$/.test(w.name) && (w.pct || 0) >= SPENT_PCT);
  return { untilText, windowView, cardStale, cardSpent, OLD_AFTER_MS };
});
