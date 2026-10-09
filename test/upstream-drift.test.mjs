import test from "node:test";
import assert from "node:assert/strict";
import { compareFork, githubSlug } from "../upstream-drift.mjs";

test("githubSlug reads https, ssh, and trailing-slash remotes and rejects other hosts", () => {
  assert.equal(githubSlug("https://github.com/adamofmoore/github-dashboard.git"), "adamofmoore/github-dashboard");
  assert.equal(githubSlug("git@github.com:KWedey/github-dashboard.git"), "KWedey/github-dashboard");
  assert.equal(githubSlug("https://github.com/KWedey/github-dashboard/"), "KWedey/github-dashboard");
  assert.equal(githubSlug("https://gitlab.com/a/b.git"), null);
  assert.equal(githubSlug(null), null);
});

const commit = (i) => ({ sha: `c${String(i).padStart(6, "0")}ffff`, author: { login: "mona" }, commit: { message: `commit ${i}\n\nbody`, committer: { date: "2026-01-01T00:00:00Z" } } });
function fakeGitHub(ahead, behind) {
  const calls = [], history = Array.from({ length: ahead }, (_, i) => commit(i));
  const repo = { "/repos/up/dash": { name: "dash", owner: { login: "up" }, default_branch: "trunk" }, "/repos/me/dash": { name: "dash", owner: { login: "me" }, default_branch: "main" } };
  const gh = async (p) => {
    calls.push(p);
    if (repo[p]) return repo[p];
    assert.equal(p, "/repos/up/dash/compare/me%3Adash%3Amain...up%3Adash%3Atrunk", `unexpected request ${p}`);
    return { ahead_by: ahead, behind_by: behind, commits: history.slice(-250) };
  };
  return { gh, calls };
}

test("compareFork compares owner:repo:branch refs and lists the newest commits first", async () => {
  const { gh, calls } = fakeGitHub(12, 3);
  const d = await compareFork(gh, "up/dash", "me/dash");
  assert.deepEqual({ ahead: d.ahead, behind: d.behind, branch: d.branch, url: d.url }, { ahead: 12, behind: 3, branch: "trunk", url: "https://github.com/up/dash/compare/me:dash:main...up:dash:trunk" });
  assert.deepEqual(d.commits.map((x) => x.title), Array.from({ length: 10 }, (_, i) => `commit ${11 - i}`));
  assert.deepEqual(d.commits[0], { sha: "c000011", title: "commit 11", author: "mona", at: "2026-01-01T00:00:00Z" });
  assert.equal(calls.length, 3);
});

test("compareFork takes the newest ten from one unpaged compare when upstream is past GitHub's 250-commit cap", async () => {
  const { gh, calls } = fakeGitHub(605, 0);
  const d = await compareFork(gh, "up/dash", "me/dash");
  assert.equal(d.ahead, 605);
  assert.deepEqual(d.commits.map((x) => x.title), Array.from({ length: 10 }, (_, i) => `commit ${604 - i}`));
  assert.equal(calls.length, 3);
});
