import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const QUOTA_STALE_MS = 15 * 60 * 1000;

export const quotaWindow = (name, pct, resets_at) => ({ name, pct: Math.round(pct), resets_at: resets_at || null });
const noWindow = (name) => ({ name, pct: null, resets_at: null });

// A seat cpa-route still calls fresh would look stuck, so its freshness window is pinned to ours.
const rankingEnv = () => ({ ...process.env, CPA_CACHE_TTL: String(QUOTA_STALE_MS / 1000) });
// cpa-route's exit when every credential is reserved or disabled, or none exists.
export const EXIT_NOTHING_TO_RANK = 3;
const runRanking = (bin, done) => execFile(bin, ["ranking"], { timeout: 120 * 1000, env: rankingEnv() }, (err) => { if (err) console.error("cpa-route ranking:", err.message); done(err); });

const isObject = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const isClaudeCredential = (file) => file.startsWith("claude-") && file.endsWith(".json");
function oldestFetch(seats) {
  const stamps = seats.map((s) => Date.parse(s.fetched_at)).filter(Number.isFinite);
  return stamps.length ? Math.min(...stamps) : null;
}
const isStale = (fetchedAt, at) => { const t = Date.parse(fetchedAt); return !Number.isFinite(t) || at - t > QUOTA_STALE_MS; };
const teamSuffix = ({ organization_name: org, email }) => typeof org === "string" && org && !org.startsWith(`${email}'s`) ? "-team" : "";

export function listAuthDir(authDir) {
  try { return fs.readdirSync(authDir); } catch { return null; }
}

export function createClaudeQuota({ usageCache, authDir, cpaRoute, stuckFile = null, run = runRanking, now = Date.now, onRefreshed = () => {} }) {
  let refreshing = false, lastStart = -Infinity;
  // file -> the fetched_at a ranking run left unchanged. cpa-route will not refresh that seat (reserved, disabled, failing),
  // so it leaves the staleness check until its fetched_at moves.
  let stuck = {};
  try { const saved = JSON.parse(fs.readFileSync(stuckFile, "utf8")); if (isObject(saved)) stuck = saved; } catch {}
  const EMPTY = ""; // a run left the cache with no live seat, so an empty cache is no reason for another
  const isStuck = (a) => Object.hasOwn(stuck, a.file) && stuck[a.file] === a.fetched_at;
  function settle(owed) {
    const after = new Map((accounts(listAuthDir(authDir)) || []).map((a) => [a.file, a.fetched_at]));
    for (const file of Object.keys(stuck)) if (file !== EMPTY && !after.has(file)) delete stuck[file];
    if (after.size) delete stuck[EMPTY]; else stuck[EMPTY] = null;
    for (const [file, at] of owed) if (after.get(file) === at) stuck[file] = at; else delete stuck[file];
    if (stuckFile) try { fs.writeFileSync(stuckFile, JSON.stringify(stuck)); } catch (err) { console.error("quota stuck seats:", err.message); }
  }
  function refresh(force, seats) {
    // A ranking run ends with onRefreshed, and every page reloads on it: this floor keeps a reload from starting the next run.
    const sinceStart = now() - lastStart;
    if (refreshing || (!force && sinceStart >= 0 && sinceStart <= QUOTA_STALE_MS) || !fs.existsSync(cpaRoute)) return;
    refreshing = true; lastStart = now();
    const owed = new Map(seats.filter((a) => isStale(a.fetched_at, lastStart)).map((a) => [a.file, a.fetched_at]));
    const finish = (ran) => { refreshing = false; if (ran) settle(owed); onRefreshed(); };
    // Only a clean exit or "nothing to rank" says cpa-route chose to skip a seat; an outage (exit 2) or a kill says nothing about it.
    try { run(cpaRoute, (err) => finish(!err || err.code === EXIT_NOTHING_TO_RANK)); } catch (err) { console.error("cpa-route ranking:", err.message); finish(false); }
  }
  function credential(file) {
    try {
      const cred = JSON.parse(fs.readFileSync(path.join(authDir, file), "utf8"));
      return isObject(cred) ? cred : {};
    } catch { return {}; }
  }
  function accounts(files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(usageCache, "utf8")); } catch { return null; }
    if (!isObject(raw)) return null;
    // cpa-route keeps entries for retired seats; a seat with no auth file is gone.
    const live = files && new Set(files);
    return Object.entries(raw).filter(([file, v]) => file.startsWith("claude-") && isObject(v) && (!live || live.has(file))).map(([file, v]) => {
      const u = isObject(v.usage) ? v.usage : {}, m = file.match(/^claude-([0-9a-f]+)-(.+?)\.json$/);
      const fable = (Array.isArray(u.limits) ? u.limits : []).find((l) => l?.kind === "weekly_scoped" && l.scope?.model?.display_name === "Fable");
      const w = (name, x, pct) => typeof pct === "number" ? quotaWindow(name, pct, x.resets_at) : noWindow(name);
      return { file, provider: "claude", id: m ? m[1] : file, label: (m ? m[2] : file) + teamSuffix(credential(file)), fetched_at: v.fetched_at || null,
        windows: [w("5 hour", u.five_hour, u.five_hour?.utilization), w("7 day", u.seven_day, u.seven_day?.utilization), w("Fable", fable, fable?.percent)] };
    });
  }
  return {
    read(force, files = listAuthDir(authDir)) {
      const claude = accounts(files);
      if (!claude) return null;
      const counted = claude.filter((a) => !isStuck(a)), oldest = oldestFetch(counted.length ? counted : claude);
      const stale = oldest === null || now() - oldest > QUOTA_STALE_MS;
      // cpa-route refuses with exit 2 when the auth folder holds no Claude credential, and a refusal records no EMPTY.
      const fillable = !files || files.some(isClaudeCredential);
      if (force || (stale && (counted.length || (!claude.length && fillable && !Object.hasOwn(stuck, EMPTY))))) refresh(force, claude);
      return { accounts: claude.map((a) => isStuck(a) ? { ...a, stale: true } : a), fetched_at: oldest === null ? null : new Date(oldest).toISOString(), refreshing };
    },
  };
}

export async function readQuota(claudeQuota, codexAccounts, force, files) {
  if (!claudeQuota.read(force, files)) return { available: false };
  const codex = await codexAccounts(force, files);
  // A ranking run that ended during the Codex fetch has already told pages to reload; a snapshot from before it would land after theirs.
  const claude = claudeQuota.read(false, files);
  if (!claude) return { available: false };
  return { available: true, fetched_at: claude.fetched_at, refreshing: claude.refreshing, accounts: [...claude.accounts, ...codex] };
}
