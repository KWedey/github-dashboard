// How a quota card shows its windows. Loaded as a classic script by index.html (exposes window.QuotaView)
// and required by test/quota-view.test.js under Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.QuotaView = api;
})(this, function () {
  function untilText(iso, now = Date.now()) {
    if (!iso) return "";
    const mins = Math.round((new Date(iso) - now) / 60000);
    if (mins <= 0) return "resetting";
    const h = Math.floor(mins / 60), m = mins % 60;
    return h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }
  // A stale card's numbers are old: no spent or warning state, and a reset time already behind us says so.
  function windowView(w, { stale = false, now = Date.now() } = {}) {
    const level = stale ? "" : w.pct >= 95 ? "bad" : w.pct >= 75 ? "warn" : "";
    const state = { bad: "Spent", warn: "Warning" }[level] || "";
    const passed = w.resets_at && new Date(w.resets_at) <= now;
    const reset = stale && passed ? "reset passed" : w.resets_at ? `resets in <b>${untilText(w.resets_at, now)}</b>` : w.pct ? "reset unknown" : "unused";
    return { cls: level ? ` ${level}` : "", state, reset, showWhen: Boolean(w.resets_at) && !(stale && passed) };
  }
  const cardSpent = (a) => !a.stale && a.windows.some((w) => /^(5 hour|7 day)$/.test(w.name) && (w.pct || 0) >= 95);
  return { untilText, windowView, cardSpent };
});
