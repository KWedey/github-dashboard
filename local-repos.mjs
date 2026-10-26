import fs from "node:fs/promises";
import path from "node:path";

// Desktop and Documents are privacy-protected on macOS: opening them from a launchd job waits on a permission prompt nobody sees.
export const DEFAULT_SKIP = ["node_modules", "Library", ".worktrees", "worktrees", ".git", "Desktop", "Documents", "Downloads", "Applications", "Movies", "Music", "Pictures"];

async function remoteRepo(dir) {
  try {
    const m = (await fs.readFile(path.join(dir, ".git", "config"), "utf8")).match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    const u = m && m[1].match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    return u ? u[1] : null;
  } catch { return null; }
}

async function scan(root, depth, { home, skip }, out) {
  if (depth < 0) return;
  let entries; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === ".git")) { const r = await remoteRepo(root); if (r) out.set(r.toLowerCase(), { repo: r, path: root }); return; }
  for (const e of entries) {
    if (!e.isDirectory() || skip.has(e.name) || (e.name.startsWith(".") && root === home)) continue;
    await scan(path.join(root, e.name), depth - 1, { home, skip }, out);
  }
}

export async function scanRepos(roots, { home, skip = DEFAULT_SKIP, depth = 6 }) {
  const out = new Map(), opts = { home, skip: new Set(skip) };
  for (const r of roots) await scan(r, depth, opts, out);
  return [...out.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}
