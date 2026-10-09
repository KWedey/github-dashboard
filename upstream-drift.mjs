export const githubSlug = (url) => url?.match(/(?:^|[@/])github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null;

export async function compareFork(gh, upstream, fork) {
  const [up, fk] = await Promise.all([gh(`/repos/${upstream}`), gh(`/repos/${fork}`)]);
  const ref = (r) => `${r.owner.login}:${r.name}:${r.default_branch}`, base = ref(fk), head = ref(up);
  const compare = `/repos/${upstream}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  // Unpaged, GitHub returns the newest 250 commits oldest-first, so the tail is the newest ten at any distance.
  const cmp = await gh(compare), { commits } = cmp;
  return { available: true, upstream, fork, branch: up.default_branch, ahead: cmp.ahead_by, behind: cmp.behind_by, url: `https://github.com/${upstream}/compare/${base}...${head}`,
    commits: commits.slice(-10).reverse().map((x) => ({ sha: x.sha.slice(0, 7), title: x.commit.message.split("\n")[0], author: x.author?.login || x.commit.author?.name || "", at: x.commit.committer?.date || null })) };
}
