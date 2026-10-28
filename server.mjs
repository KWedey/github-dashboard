import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLiveSearch, orSaved } from "./live-search.mjs";
import { demoDaily, demoLive, demoQuota, demoRepos, demoUpstream } from "./demo.mjs";
import { createGitHub } from "./github.mjs";
import { DEFAULT_SKIP, createRepoScanner } from "./repos.mjs";
import Dates from "./public/dates.js";
import { createActivity, invalidateDays, API, daysBetween, shift, today } from "./activity.mjs";
import { DEFAULT_FEED_URL, coalesceInvalidations, startCadenceFeed } from "./cadence-feed.mjs";
import { latestLabelTimes } from "./label-times.mjs";
import { compareFork, githubSlug } from "./upstream-drift.mjs";
import { createClaudeQuota, listAuthDir, quotaWindow, readQuota } from "./quota.mjs";
import { createStreams, sseFrame } from "./events.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const untilde = (p) => p.replace(/^~(?=\/|$)/, () => process.env.HOME);
const { MAX_RANGE_DAYS } = Dates;
const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const CACHE_DIR = path.join(ROOT, "cache");
const SESSIONS_FILE = path.join(CACHE_DIR, "sessions.json");
// Kept warm in the background, so the Custom tile's longest quick pick (Past year)
// loads from the cache rather than hundreds of rate-limited searches.
const WARM_DAYS = MAX_RANGE_DAYS;
const DEMO = process.env.DEMO === "1";
const CADENCE_FEED_KEY = process.env.CADENCE_FEED_KEY || "";
const CADENCE_FEED_URL = process.env.CADENCE_FEED_URL || DEFAULT_FEED_URL;
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- owner token from gh ----------
let ownerToken = "";
try { ownerToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}

// ---------- per-token GitHub clients (github.mjs) ----------
const { client, laneFor } = createGitHub({ log: (m) => console.log(m) });

// ---------- sessions ----------
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch {}
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 }); }
function cookie(req, name) { const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? m[1] : null; }
function sessionFor(req) {
  const sid = cookie(req, "ghdash");
  if (sid && sessions[sid]) return { ...sessions[sid], sid };
  const ip = req.socket.remoteAddress;
  if (ownerToken && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return { token: ownerToken, owner: true };
  return null;
}
function newSession(res, token, login) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions[sid] = { token, login, created: new Date().toISOString() };
  saveSessions();
  res.setHeader("Set-Cookie", `ghdash=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`);
}

// ---------- device flow ----------
const pendingDevice = new Map();
async function deviceStart() {
  const r = await fetch("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CLIENT_ID, scope: "repo read:org" }) });
  const j = await r.json();
  if (!j.device_code) throw new Error(j.error_description || "device flow failed");
  pendingDevice.set(j.device_code, { interval: j.interval || 5, last: 0 });
  return { device_code: j.device_code, user_code: j.user_code, verification_uri: j.verification_uri, interval: j.interval || 5, expires_in: j.expires_in };
}
async function devicePoll(device_code) {
  const p = pendingDevice.get(device_code);
  if (!p) return { status: "unknown" };
  if (Date.now() - p.last < p.interval * 1000) return { status: "pending" };
  p.last = Date.now();
  const r = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CLIENT_ID, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
  const j = await r.json();
  if (j.access_token) { pendingDevice.delete(device_code); return { status: "ok", token: j.access_token }; }
  if (j.error === "slow_down") { p.interval += 5; return { status: "pending" }; }
  if (j.error === "authorization_pending") return { status: "pending" };
  pendingDevice.delete(device_code);
  return { status: "error", error: j.error_description || j.error };
}

// ---------- per-user day cache ----------
const caches = new Map();
function cacheFor(login) {
  if (caches.has(login)) return caches.get(login);
  const file = path.join(CACHE_DIR, `days-${login}.json`);
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  // Legacy files were a bare { "metric:day": items } map with no fetch times; a day
  // from one of those refetches once and is then settled like any other.
  const stored = raw.days && raw.fetchedAt ? raw : { days: raw, fetchedAt: {} };
  stored.emptyAt ||= {};
  let timer = null;
  const entry = { data: stored.days, fetchedAt: stored.fetchedAt, emptyAt: stored.emptyAt, save() { clearTimeout(timer); timer = setTimeout(() => fs.writeFileSync(file, JSON.stringify(stored)), 250); } };
  caches.set(login, entry);
  return entry;
}
const { dailyData } = createActivity({ cacheFor, laneFor, log: (m) => console.log(m) });

// ---------- live (GraphQL) ----------
// Page size, retries and completeness checks live in live-search.mjs. The explicit sort
// gives every page the same order, so the offset cursors cannot skip or repeat a result.
// One per client, i.e. per token: two tokens for the same login can see different repos,
// so neither a shared in-flight fetch nor the remembered counts may cross between them.
const liveSearches = new WeakMap();
async function searchAll(c, q, fragment) {
  const query = `query($q:String!,$first:Int!,$after:String){ search(query:$q,type:ISSUE,first:$first,after:$after){ issueCount pageInfo{hasNextPage endCursor} nodes{ ${fragment} } } }`;
  const sorted = `${q} sort:created-desc`;
  if (!liveSearches.has(c)) liveSearches.set(c, createLiveSearch());
  return liveSearches.get(c)(sorted, async (after, first) => (await c.graphql(query, { q: sorted, first, after })).search,
    { q: sorted, log: (msg) => console.log(`[${c.login || "?"}] live search "${sorted}": ${msg}`) });
}
const ISSUE_FRAG = `... on Issue { number title url createdAt updatedAt bodyText comments{ totalCount } repository{ nameWithOwner } labels(first:10){ nodes{ name color } } milestone{ title }
  linkedPrs: closedByPullRequestsReferences(first:10, includeClosedPrs:false){ nodes{ number title url isDraft state repository{ nameWithOwner } } } }`;
const PR_FRAG = `... on PullRequest { number title url createdAt updatedAt isDraft reviewDecision mergeable headRefName baseRefName additions deletions author{ login } repository{ nameWithOwner }
  labels(first:30){ nodes{ name color } } assignees(first:10){ nodes{ login } } statusCheckRollup{ state }
  latestReviews(first:20){ nodes{ author{ login } state submittedAt } } commits(last:1){ nodes{ commit{ committedDate } } } closingIssuesReferences(first:5){ nodes{ number title url } }
  reviewRequests(first:5){ nodes{ requestedReviewer{ ... on User{ login } ... on Team{ name } } } }
  timelineItems(itemTypes:[LABELED_EVENT], last:50){ nodes{ ... on LabeledEvent{ createdAt label{ name } } } } }`;
function firstLine(text) {
  const line = (text || "").split("\n").map((l) => l.trim()).find((l) => l.length > 20 && !/^#|^\*\*|^[-*] |^\[/.test(l)) || "";
  return line.length > 180 ? line.slice(0, 177).replace(/\s+\S*$/, "") + "…" : line;
}
function slimPr(n) {
  return { repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, author: n.author?.login || null, created_at: n.createdAt, updated_at: n.updatedAt, draft: n.isDraft, reviewDecision: n.reviewDecision, mergeable: n.mergeable, checks: n.statusCheckRollup?.state || null, head: n.headRefName, base: n.baseRefName, additions: n.additions, deletions: n.deletions, labels: n.labels.nodes, labeledAt: latestLabelTimes(n.timelineItems?.nodes), assignees: n.assignees.nodes.map((a) => a.login), reviews: (n.latestReviews?.nodes || []).map((r) => ({ by: r.author?.login || null, state: r.state, at: r.submittedAt })), pushed_at: n.commits?.nodes[0]?.commit.committedDate || null, closes: n.closingIssuesReferences.nodes, reviewers: n.reviewRequests.nodes.map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name).filter(Boolean) };
}
function slimIssue(n) {
  return { repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, created_at: n.createdAt, updated_at: n.updatedAt, labels: n.labels.nodes, comments: n.comments.totalCount, why: firstLine(n.bodyText), milestone: n.milestone?.title || null, linkedPrs: n.linkedPrs.nodes.map((p) => ({ repo: p.repository.nameWithOwner, number: p.number, title: p.title, url: p.url, draft: p.isDraft, state: p.state })) };
}
const QUEUES = { needsCodeReview: "Needs Code Review", needsTesting: "Needs Testing" };
const REVIEW_AUTHORS = (process.env.REVIEW_AUTHORS || "RileyPascal,justib99,PaulDeister,reynaldotr").split(",").map((x) => x.trim()).filter(Boolean);
const TEST_TEAM = process.env.TEST_TEAM || "test-team";
const TESTERS = (process.env.TESTERS || "").split(",").map((x) => x.trim()).filter(Boolean);
async function testers(c) {
  if (TESTERS.length) return TESTERS;
  if (!c.testers) {
    const found = new Set();
    let settled = true;
    for (const org of c.orgs) {
      try { for (const m of await c.gh(`${API}/orgs/${org}/teams/${TEST_TEAM}/members?per_page=100`)) found.add(m.login); }
      catch (e) {
        // No such team, or not visible to this token, stays true; a rate limit or outage is asked again next poll.
        if (e.status !== 404 && e.status !== 403) settled = false;
        console.log(`no ${org}/${TEST_TEAM} team for ${c.login}: ${e.message}`);
      }
    }
    if (!settled) return [...found];
    c.testers = [...found];
  }
  return c.testers;
}
async function queueScope(c) {
  const user = await c.me();
  if (!c.orgs) c.orgs = (await c.gh(`${API}/user/orgs?per_page=100`)).map((o) => o.login);
  return [`user:${user}`, ...c.orgs.map((o) => `org:${o}`)].join(" ");
}
// The last lists each token fetched, kept on disk so a page load (even after a restart)
// shows them at once while fresh ones load. Files are named by a hash of the token, so
// no token is written out.
const savedLive = new Map();
const liveFile = (token) => path.join(CACHE_DIR, `live-${crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)}.json`);
function lastLive(token) {
  if (!savedLive.has(token)) { let v = null; try { v = JSON.parse(fs.readFileSync(liveFile(token), "utf8")); } catch {} savedLive.set(token, v); }
  return savedLive.get(token);
}

async function liveData(c, token) {
  const user = await c.me();
  const scope = await queueScope(c);
  const prev = lastLive(token), stale = {};
  const list = (key, q, fragment, slim) => orSaved(searchAll(c, q, fragment).then((nodes) => nodes.map(slim)), prev, key,
    (e, at) => { stale[key] = at; console.log(`${e.message}; showing the ${key} list saved at ${at}`); });
  const [issues, prs, reviewRequests, needsCodeReview, needsTesting] = await Promise.all([
    list("issues", `assignee:${user} is:issue is:open`, ISSUE_FRAG, slimIssue),
    list("prs", `author:${user} is:pr is:open`, PR_FRAG, slimPr),
    list("reviewRequests", `review-requested:${user} is:pr is:open`, PR_FRAG, slimPr),
    list("needsCodeReview", `${scope} is:pr is:open label:"${QUEUES.needsCodeReview}"`, PR_FRAG, slimPr),
    list("needsTesting", `${scope} is:pr is:open label:"${QUEUES.needsTesting}"`, PR_FRAG, slimPr),
  ]);
  const data = { user, fetchedAt: new Date().toISOString(), reviewAuthors: REVIEW_AUTHORS, testers: await testers(c), issues, prs, reviewRequests, needsCodeReview, needsTesting, stale };
  savedLive.set(token, data);
  fs.promises.writeFile(liveFile(token), JSON.stringify(data), { mode: 0o600 }).catch((e) => console.log(`could not save live lists: ${e.message}`));
  return data;
}

// ---------- Claude quotas from cpa-route (owner only) ----------
const AUTH_DIR = untilde(process.env.CPA_AUTH_DIR || "~/.cli-proxy-api");
const claudeQuota = createClaudeQuota({
  usageCache: untilde(process.env.CPA_USAGE_CACHE || "~/.config/cpa-route/usage-cache.json"),
  cpaRoute: untilde(process.env.CPA_ROUTE_BIN || "~/.local/bin/cpa-route"),
  authDir: AUTH_DIR,
  stuckFile: path.join(CACHE_DIR, "quota-stuck-seats.json"),
  onRefreshed: () => streams.broadcast("quota", { at: new Date().toISOString() }, (s) => s.owner),
});
const CODEX_UA = "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)";
const CODEX_TTL_MS = 5 * 60 * 1000;
const codexCache = new Map();
async function codexJson(url, auth) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.access_token}`, "ChatGPT-Account-Id": auth.account_id || "", "Content-Type": "application/json", "User-Agent": CODEX_UA } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
const codexWindow = (name, w) => w && typeof w.used_percent === "number" ? quotaWindow(name, w.used_percent, w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null) : null;
const secondsName = (sec) => sec % 86400 === 0 ? `${sec / 86400} day` : sec % 3600 === 0 ? `${sec / 3600} hour` : `${Math.round(sec / 60)} min`;
async function codexAccount(file, force) {
  const hit = codexCache.get(file);
  if (hit && !force && Date.now() - hit.at < CODEX_TTL_MS) return hit.data;
  let auth; try { auth = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, file), "utf8")); } catch { return null; }
  const m = file.match(/^codex-([0-9a-f]+)-(.+?)(?:-(\w+))?\.json$/);
  const base = { file, provider: "codex", id: m ? m[1] : file, label: m ? m[2] : auth.email || file, fetched_at: new Date().toISOString(), windows: [], resets: null };
  try {
    const [usage, credits] = await Promise.all([codexJson("https://chatgpt.com/backend-api/wham/usage", auth), codexJson("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", auth).catch(() => null)]);
    const rl = usage.rate_limit || {};
    base.label += usage.plan_type ? `-${usage.plan_type}` : "";
    base.windows = [codexWindow(rl.secondary_window ? secondsName(rl.secondary_window.limit_window_seconds) : "5 hour", rl.secondary_window), codexWindow(rl.primary_window ? secondsName(rl.primary_window.limit_window_seconds) : "7 day", rl.primary_window)].filter(Boolean);
    for (const extra of usage.additional_rate_limits || []) { const w = codexWindow(`${extra.limit_name} ${secondsName(extra.rate_limit?.primary_window?.limit_window_seconds || 0)}`, extra.rate_limit?.primary_window); if (w) base.windows.push(w); }
    const available = (credits?.credits || []).filter((c) => c.status === "available");
    base.resets = { available: credits ? available.length : usage.rate_limit_reset_credits?.available_count ?? null, expires_at: available.map((c) => c.expires_at).filter(Boolean).sort()[0] || null };
  } catch (e) { console.error(`codex quota for ${file}:`, e.message); base.error = e.message; }
  codexCache.set(file, { at: Date.now(), data: base });
  return base;
}
async function codexAccounts(force, files) {
  const codex = (files || []).filter((f) => f.startsWith("codex-") && f.endsWith(".json"));
  return (await Promise.all(codex.map((f) => codexAccount(f, force)))).filter(Boolean);
}

// ---------- upstream drift of this dashboard's own repo ----------
// The ceiling stops git climbing into a parent repo when this folder is not a checkout of its own.
const gitRemote = (name) => new Promise((resolve) => execFile("git", ["-C", ROOT, "remote", "get-url", name], { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(ROOT) } }, (err, out) => resolve(err ? null : githubSlug(out.trim()))));
// Shorter than the page's 30-minute poll, so every poll sees a fresh comparison instead of every other one.
const DRIFT_TTL_MS = 25 * 60 * 1000;
let drift = { at: 0, data: null }, driftPending = null;
async function loadDrift(c) {
  const [upstream, fork] = await Promise.all([gitRemote("upstream"), gitRemote("origin")]);
  if (!upstream || !fork || upstream.toLowerCase() === fork.toLowerCase()) return { at: Date.now(), data: { available: false } };
  try { return { at: Date.now(), data: await compareFork((p) => c.gh(API + p), upstream, fork) }; }
  catch (e) { console.error("upstream drift:", e.message); return { at: Date.now() - DRIFT_TTL_MS + 5 * 60 * 1000, data: { available: false, error: e.message.split(": {")[0].slice(0, 200) } }; }
}
function upstreamDrift(c) {
  if (Date.now() - drift.at < DRIFT_TTL_MS) return drift.data;
  return (driftPending ||= loadDrift(c).then((d) => (drift = d).data).finally(() => { driftPending = null; }));
}

// ---------- local repos (owner only, repos.mjs) ----------
const localRepos = createRepoScanner({
  roots: (process.env.REPO_ROOTS || "~,~/Studio").split(",").map((r) => untilde(r.trim())).filter(Boolean),
  skip: new Set([...DEFAULT_SKIP, ...(process.env.REPO_SKIP || "Dropbox (Personal),TrainerRoad Dropbox").split(",").map((x) => x.trim()).filter(Boolean)]),
  file: path.join(CACHE_DIR, "local-repos.json"),
  log: (m) => console.log(m),
});
if (ownerToken && !DEMO) localRepos.list().catch((e) => console.log(`local repo scan failed: ${e.message}`)); // ready before the first page asks

// ---------- browser event stream + Cadence webhook feed ----------
let feedStatus = { state: "off", detail: DEMO ? "demo mode" : "CADENCE_FEED_KEY not set" };
const streams = createStreams({ first: () => sseFrame("feed", feedStatus) });
function invalidate(logins, reason) {
  const t = today(), y = shift(t, -1);
  for (const [login, cache] of caches) {
    if (logins && !logins.has(login.toLowerCase())) continue;
    invalidateDays(cache, [t, y]);
  }
  streams.broadcast("refresh", { reason, at: new Date().toISOString() }, (s) => !logins || logins.has(s.login.toLowerCase()));
}
if (!DEMO) startCadenceFeed({ key: CADENCE_FEED_KEY, url: CADENCE_FEED_URL, onInvalidate: coalesceInvalidations(invalidate), onStatus: (st) => { feedStatus = st; console.log(`cadence feed: ${st.state}${st.detail ? ` (${st.detail})` : ""}`); streams.broadcast("feed", st); } });

// ---------- background warm for every known token ----------
let warming = false;
async function warm() {
  if (warming) return; warming = true;
  const tokens = new Set([ownerToken, ...Object.values(sessions).map((s) => s.token)].filter(Boolean));
  for (const token of tokens) {
    const c = client(token);
    // The two passes fail independently, so a refused yesterday..today refresh still lets
    // the warm pass fill in whatever is missing. Filling a year from empty takes several
    // passes; each saves what it got.
    const t = today();
    for (const [from, force, what] of [[shift(t, -1), true, "refresh"], [shift(t, -(WARM_DAYS - 1)), false, `${WARM_DAYS}-day warm`]]) {
      try { await dailyData(c, from, t, force, true); }
      catch (e) { console.error(`${what} failed for ${c.login || "?"}:`, e.message); }
    }
  }
  warming = false;
}
if (!DEMO) { setTimeout(warm, 500); setInterval(warm, 5 * 60 * 1000); }

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
function send(res, code, body, type = "application/json", headers = {}) { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...headers }); res.end(type.startsWith("application/json") ? JSON.stringify(body) : body); }
function readBody(req) { return new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)).on("end", () => r(s)); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (DEMO && url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/auth/status" || url.pathname === "/api/me") return send(res, 200, { loggedIn: true, login: "octocat", owner: true, deviceFlow: false });
      if (url.pathname === "/api/live") return send(res, 200, demoLive(today()));
      if (url.pathname === "/api/repos") return send(res, 200, { repos: demoRepos });
      if (url.pathname === "/api/quota") return send(res, 200, demoQuota());
      if (url.pathname === "/api/upstream") return send(res, 200, demoUpstream());
      if (url.pathname === "/api/events") return streams.open(req, res, { login: "octocat", owner: true });
      if (url.pathname === "/api/daily") {
        const to = url.searchParams.get("to") || today(), from = url.searchParams.get("from") || to, days = daysBetween(from, to);
        return send(res, 200, { user: "octocat", from, to, today: today(), days, metrics: demoDaily(days, today()) });
      }
      return send(res, 404, { error: "not found" });
    }
    if (url.pathname === "/api/auth/status") {
      const s = sessionFor(req);
      if (!s) return send(res, 200, { loggedIn: false, deviceFlow: Boolean(CLIENT_ID) });
      try { const login = await client(s.token).me(); return send(res, 200, { loggedIn: true, login, owner: Boolean(s.owner), deviceFlow: Boolean(CLIENT_ID) }); }
      catch (e) { if (e.code === 401) { if (s.sid) { delete sessions[s.sid]; saveSessions(); } return send(res, 200, { loggedIn: false, deviceFlow: Boolean(CLIENT_ID), error: "Saved token was rejected, sign in again" }); } throw e; }
    }
    if (url.pathname === "/api/auth/device/start" && req.method === "POST") {
      if (!CLIENT_ID) return send(res, 400, { error: "GITHUB_CLIENT_ID is not set on the server" });
      return send(res, 200, await deviceStart());
    }
    if (url.pathname === "/api/auth/device/poll" && req.method === "POST") {
      const { device_code } = JSON.parse(await readBody(req) || "{}");
      const r = await devicePoll(device_code);
      if (r.status === "ok") {
        // GitHub has already handed over the token and forgotten the device code, so a rate
        // limit on reading the login must not lose it; the login is read again on next use.
        let login = null;
        try { login = await client(r.token).me(); } catch (e) { if (e.code !== 429) throw e; console.log(`device sign-in: ${e.message}; saving the session without a login`); }
        newSession(res, r.token, login); setTimeout(warm, 100); return send(res, 200, { status: "ok", login });
      }
      return send(res, 200, r);
    }
    if (url.pathname === "/api/auth/token" && req.method === "POST") {
      const { token } = JSON.parse(await readBody(req) || "{}");
      if (!token || !/^[\w-]+$/.test(token)) return send(res, 400, { error: "Paste a GitHub token" });
      try { const login = await client(token).me(); newSession(res, token, login); setTimeout(warm, 100); return send(res, 200, { status: "ok", login }); }
      catch (e) { if (e.code === 401) return send(res, 401, { error: "GitHub rejected that token" }); throw e; }
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const sid = cookie(req, "ghdash"); if (sid) { delete sessions[sid]; saveSessions(); }
      res.setHeader("Set-Cookie", "ghdash=; Path=/; Max-Age=0"); return send(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/")) {
      const s = sessionFor(req);
      if (!s) return send(res, 401, { error: "Sign in with GitHub first" });
      const c = client(s.token);
      if (url.pathname === "/api/live" && url.searchParams.get("saved") === "1") return send(res, 200, lastLive(s.token) || { none: true });
      if (url.pathname === "/api/live") return send(res, 200, await liveData(c, s.token));
      if (url.pathname === "/api/events") return streams.open(req, res, { login: await c.me(), owner: Boolean(s.owner) });
      if (url.pathname === "/api/me") return send(res, 200, { login: await c.me(), owner: Boolean(s.owner) });
      if (url.pathname === "/api/repos") return send(res, 200, { repos: s.owner ? await localRepos.list() : [] });
      if (url.pathname === "/api/quota") return send(res, 200, s.owner ? await readQuota(claudeQuota, codexAccounts, url.searchParams.get("force") === "1", listAuthDir(AUTH_DIR)) : { available: false });
      if (url.pathname === "/api/upstream") return send(res, 200, s.owner ? await upstreamDrift(c) : { available: false });
      if (url.pathname === "/api/daily") {
        const to = url.searchParams.get("to") || today(), from = url.searchParams.get("from") || to;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return send(res, 400, { error: "bad range" });
        if (daysBetween(from, to).length > MAX_RANGE_DAYS) return send(res, 400, { error: `range over ${MAX_RANGE_DAYS} days` });
        return send(res, 200, await laneFor(await c.me()).whileUser(() => dailyData(c, from, to, url.searchParams.get("force") === "1")));
      }
      return send(res, 404, { error: "not found" });
    }

    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.join(ROOT, "public", path.normalize(file));
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    if (e.code === 429) {
      console.log(`${url.pathname}: ${e.message}`);
      return send(res, 429, { error: e.message, until: e.until }, "application/json", { "Retry-After": String(Math.max(Math.ceil((e.until - Date.now()) / 1000), 1)) });
    }
    console.error(e);
    if (e.code === 401) return send(res, 401, { error: "Sign in with GitHub first" });
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`github-dashboard → http://${HOST}:${PORT}${CLIENT_ID ? " (device-flow sign-in enabled)" : " (sign-in by pasted token only; set GITHUB_CLIENT_ID for one-click GitHub sign-in)"}`));
