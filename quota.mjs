import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const QUOTA_STALE_MS = 15 * 60 * 1000;

export const quotaWindow = (name, pct, resets_at) => ({ name, pct: Math.round(pct), resets_at: resets_at || null });
const noWindow = (name) => ({ name, pct: null, resets_at: null });

const runRanking = (bin, done) => execFile(bin, ["ranking"], { timeout: 120 * 1000 }, (err) => { if (err) console.error("cpa-route ranking:", err.message); done(); });

// cpa-route's Account flags: `cpa-route ranking` skips disabled and reserved seats, so their cache entries never refresh.
const rankedByCpaRoute = (cred) => !cred.disabled && (!("reserved" in cred) || cred.reserved === false);
const isObject = (x) => Boolean(x) && typeof x === "object";
function oldestFetch(seats) {
  const stamps = seats.map((s) => Date.parse(s.account.fetched_at)).filter(Number.isFinite);
  return stamps.length ? Math.min(...stamps) : null;
}
const teamSuffix = ({ organization_name: org, email }) => typeof org === "string" && org && !org.startsWith(`${email}'s`) ? "-team" : "";

export function createClaudeQuota({ usageCache, authDir, cpaRoute, run = runRanking, now = Date.now, onRefreshed = () => {} }) {
  let refreshing = false, lastStart = -Infinity;
  function refresh(force) {
    // A seat whose refetch fails stays stale, and every page reloads on onRefreshed: without this floor that loop never rests.
    const sinceStart = now() - lastStart;
    if (refreshing || (!force && sinceStart >= 0 && sinceStart <= QUOTA_STALE_MS) || !fs.existsSync(cpaRoute)) return;
    refreshing = true; lastStart = now();
    const finish = () => { refreshing = false; onRefreshed(); };
    try { run(cpaRoute, finish); } catch (err) { console.error("cpa-route ranking:", err.message); finish(); }
  }
  function credential(file) {
    try {
      const cred = JSON.parse(fs.readFileSync(path.join(authDir, file), "utf8"));
      return isObject(cred) ? cred : {};
    } catch { return {}; }
  }
  function onDisk() {
    try { return new Set(fs.readdirSync(authDir)); } catch { return null; }
  }
  function seats() {
    let raw; try { raw = JSON.parse(fs.readFileSync(usageCache, "utf8")); } catch { return null; }
    if (!isObject(raw)) return null;
    // cpa-route keeps entries for retired seats; theirs never refresh.
    const live = onDisk();
    return Object.entries(raw).filter(([file, v]) => file.startsWith("claude-") && isObject(v) && (!live || live.has(file))).map(([file, v]) => {
      const cred = credential(file), u = isObject(v.usage) ? v.usage : {}, m = file.match(/^claude-([0-9a-f]+)-(.+?)\.json$/);
      const fable = (Array.isArray(u.limits) ? u.limits : []).find((l) => l?.kind === "weekly_scoped" && l.scope?.model?.display_name === "Fable");
      const w = (name, x) => x && typeof x.utilization === "number" ? quotaWindow(name, x.utilization, x.resets_at) : noWindow(name);
      return { ranked: rankedByCpaRoute(cred), account: { file, provider: "claude", id: m ? m[1] : file, label: (m ? m[2] : file) + teamSuffix(cred), fetched_at: v.fetched_at || null,
        windows: [w("5 hour", u.five_hour), w("7 day", u.seven_day), fable ? quotaWindow("Fable", fable.percent, fable.resets_at) : noWindow("Fable")] } };
    });
  }
  return {
    read(force) {
      const claude = seats();
      if (!claude) return null;
      const ranked = claude.filter((s) => s.ranked), oldest = oldestFetch(ranked.length ? ranked : claude);
      const stale = oldest === null || now() - oldest > QUOTA_STALE_MS;
      // Only ranked seats can be refetched; an empty cache still is, to fill it.
      if (force || (stale && (ranked.length || !claude.length))) refresh(force);
      return { accounts: claude.map((s) => s.account), fetched_at: oldest === null ? null : new Date(oldest).toISOString(), refreshing };
    },
  };
}
