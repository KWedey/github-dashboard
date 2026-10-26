import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SKIP, scanRepos } from "../local-repos.mjs";

function repo(dir, url) {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "local-repos-"));
  repo(path.join(home, "dev", "zeta"), "git@github.com:acme/zeta.git");
  repo(path.join(home, "dev", "alpha"), "https://github.com/acme/Alpha");
  repo(path.join(home, "dev", "gitlab-only"), "git@gitlab.com:acme/other.git");
  repo(path.join(home, "Documents", "secret"), "git@github.com:acme/secret.git");
  repo(path.join(home, "Desktop", "scratch"), "git@github.com:acme/scratch.git");
  repo(path.join(home, ".hidden", "dot"), "git@github.com:acme/dot.git");
  repo(path.join(home, "a", "b", "c", "too-deep"), "git@github.com:acme/deep.git");
  return home;
}

test("scanRepos finds GitHub clones sorted by name and never opens Desktop, Documents or home dot-folders", async () => {
  const home = fakeHome();
  const list = await scanRepos([home], { home });
  assert.deepEqual(list, [
    { repo: "acme/Alpha", path: path.join(home, "dev", "alpha") },
    { repo: "acme/deep", path: path.join(home, "a", "b", "c", "too-deep") },
    { repo: "acme/zeta", path: path.join(home, "dev", "zeta") },
  ]);
});

test("scanRepos stops at the depth limit and skips every name in the skip list", async () => {
  const home = fakeHome();
  const list = await scanRepos([home], { home, depth: 2, skip: [...DEFAULT_SKIP, "zeta"] });
  assert.deepEqual(list.map((r) => r.repo), ["acme/Alpha"]);
});

test("scanRepos does not block the event loop while it walks folders", async () => {
  const home = fakeHome();
  let ticked = false;
  const scan = scanRepos([home], { home });
  setImmediate(() => { ticked = true; });
  await scan;
  assert.equal(ticked, true);
});
