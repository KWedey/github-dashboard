import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const QUOTA_STALE_MS = 15 * 60 * 1000;

export const quotaWindow = (name, pct, resets_at) => ({ name, pct: Math.round(pct), resets_at: resets_at || null });

const runRanking = (bin, done) => execFile(bin, ["ranking"], { timeout: 120 * 1000 }, (err) => { if (err) console.error("cpa-route ranking:", err.message); done(); });

// Claude quotas from cpa-route's usage cache; a stale cache starts `cpa-route ranking` in the background.
export function createClaudeQuota({ usageCache, authDir, cpaRoute, run = runRanking, now = Date.now, onRefreshed = () => {} }) {
  let refreshing = false, lastStart = -Infinity;
  function refresh(force) {
    // A seat whose refetch fails stays stale, and every page reloads on onRefreshed: without this floor that loop never rests.
    if (refreshing || (!force && now() - lastStart <= QUOTA_STALE_MS) || !fs.existsSync(cpaRoute)) return;
    refreshing = true; lastStart = now();
    run(cpaRoute, () => { refreshing = false; onRefreshed(); });
  }
  function orgSuffix(file) {
    try {
      const { organization_name: org, email } = JSON.parse(fs.readFileSync(path.join(authDir, file), "utf8"));
      return org && !org.startsWith(`${email}'s`) ? "-team" : "";
    } catch { return ""; }
  }
  function onDisk() {
    try { return new Set(fs.readdirSync(authDir)); } catch { return null; }
  }
  function accounts() {
    let raw; try { raw = JSON.parse(fs.readFileSync(usageCache, "utf8")); } catch { return null; }
    // cpa-route keeps entries for retired seats; theirs never refresh.
    const live = onDisk();
    return Object.entries(raw).filter(([file]) => file.startsWith("claude-") && (!live || live.has(file))).map(([file, v]) => {
      const u = v.usage || {}, m = file.match(/^claude-([0-9a-f]+)-(.+?)\.json$/);
      const fable = (u.limits || []).find((l) => l.kind === "weekly_scoped" && l.scope?.model?.display_name === "Fable");
      const w = (name, x) => x && typeof x.utilization === "number" ? quotaWindow(name, x.utilization, x.resets_at) : { name, pct: null, resets_at: null };
      return { file, provider: "claude", id: m ? m[1] : file, label: (m ? m[2] : file) + orgSuffix(file), fetched_at: v.fetched_at || null,
        windows: [w("5 hour", u.five_hour), w("7 day", u.seven_day), fable ? quotaWindow("Fable", fable.percent, fable.resets_at) : { name: "Fable", pct: null, resets_at: null }] };
    });
  }
  return {
    read(force) {
      const claude = accounts();
      if (!claude) return null;
      const fetched = claude.map((a) => Date.parse(a.fetched_at)).filter(Number.isFinite);
      const oldest = fetched.length ? Math.min(...fetched) : 0;
      if (force || !oldest || now() - oldest > QUOTA_STALE_MS) refresh(force);
      return { accounts: claude, fetched_at: oldest ? new Date(oldest).toISOString() : null, refreshing };
    },
  };
}
