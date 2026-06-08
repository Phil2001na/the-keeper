import { Octokit } from '@octokit/rest';
import { config, type GithubCreds } from '../config.js';

/**
 * Website deployment over GitHub Pages. Ported from Philip's standalone
 * telegram-github-deploy-bot so THE KEEPER can publish and manage static sites
 * itself: send it an .html file and it creates a repo, pushes index.html, and
 * turns on Pages.
 *
 * Every operation is parameterized by GithubCreds (whose account it lands in),
 * so the same code serves Philip's Keeper AND deploy-only guest bots that
 * publish to their own GitHub. The keeper wrappers near the bottom bind Philip's
 * creds so the agent's tool layer (tools.ts) stays unchanged.
 */

/** Are these creds usable for deploying? */
export function githubCredsValid(c: GithubCreds): boolean {
  return Boolean(c.token && c.username);
}

/** Philip's own creds, used by the Keeper agent's deploy tools. */
const keeperCreds: GithubCreds = { token: config.githubToken, username: config.githubUsername };

/** True if the Keeper (Philip) has GitHub configured. */
export function githubEnabled(): boolean {
  return githubCredsValid(keeperCreds);
}

function clientFor(creds: GithubCreds): Octokit {
  return new Octokit({ auth: creds.token });
}

/** A stashed HTML upload awaiting deployment (single-owner bot → one slot). */
export interface PendingHtml {
  filename: string;
  contentBase64: string;
  sizeBytes: number;
}
let pending: PendingHtml | null = null;

export function setPendingHtml(file: PendingHtml): void {
  pending = file;
}
export function getPendingHtml(): PendingHtml | null {
  return pending;
}

/** GitHub repo names allow only letters, digits, '.', '_' and '-'. */
function fileToRepoName(filename: string): string {
  const base = filename
    .replace(/\.html$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return base || 'site';
}

export interface DeployResult {
  ok: boolean;
  repo?: string;
  url?: string;
  note?: string;
  error?: string;
}

/** Deploy a specific HTML file to a given GitHub account's Pages. */
export async function deployHtml(creds: GithubCreds, file: PendingHtml): Promise<DeployResult> {
  const octokit = clientFor(creds);
  const OWNER = creds.username;
  const baseName = fileToRepoName(file.filename);

  try {
    // 1. Create repo, auto-incrementing the name if it's taken.
    let created;
    let attempt = 1;
    let repoName = baseName;
    while (true) {
      try {
        created = await octokit.repos.createForAuthenticatedUser({ name: repoName, private: false, auto_init: false });
        break;
      } catch (e) {
        const err = e as { status?: number; response?: { data?: { errors?: { field?: string }[] } } };
        const nameTaken = err.status === 422 && err.response?.data?.errors?.some((x) => x.field === 'name');
        if (!nameTaken) throw e;
        attempt += 1;
        repoName = `${baseName}-${attempt}`;
        if (attempt > 50) return { ok: false, error: 'Could not find a free repo name.' };
      }
    }
    const branch = created.data.default_branch || 'main';

    // 2. Push index.html via the Git Data API (handles files > 1 MB).
    const blob = await octokit.git.createBlob({ owner: OWNER, repo: repoName, content: file.contentBase64, encoding: 'base64' });
    const tree = await octokit.git.createTree({ owner: OWNER, repo: repoName, tree: [{ path: 'index.html', mode: '100644', type: 'blob', sha: blob.data.sha }] });
    const commit = await octokit.git.createCommit({ owner: OWNER, repo: repoName, message: 'Deploy via THE KEEPER', tree: tree.data.sha, parents: [] });
    await octokit.git.createRef({ owner: OWNER, repo: repoName, ref: `refs/heads/${branch}`, sha: commit.data.sha });

    // 3. Enable GitHub Pages.
    await octokit.repos.createPagesSite({ owner: OWNER, repo: repoName, source: { branch, path: '/' } });

    return {
      ok: true,
      repo: repoName,
      url: `https://${OWNER}.github.io/${repoName}`,
      note: 'GitHub Pages may take 30–60s to go live.',
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function listSitesFor(
  creds: GithubCreds
): Promise<DeployResult & { sites?: { repo: string; url: string; created: string }[] }> {
  const octokit = clientFor(creds);
  const OWNER = creds.username;
  try {
    const res = await octokit.repos.listForAuthenticatedUser({ sort: 'created', direction: 'desc', per_page: 15 });
    return {
      ok: true,
      sites: res.data.map((r) => ({
        repo: r.name,
        url: `https://${OWNER}.github.io/${r.name}`,
        created: r.created_at ?? '',
      })),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function checkSiteStatusFor(
  creds: GithubCreds,
  repo: string
): Promise<DeployResult & { status?: string }> {
  const octokit = clientFor(creds);
  try {
    const res = await octokit.repos.getPages({ owner: creds.username, repo });
    return { ok: true, repo, status: res.data.status ?? 'unknown', url: res.data.html_url };
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 404) return { ok: true, repo, status: 'pages_not_enabled' };
    return { ok: false, error: (e as Error).message };
  }
}

export async function renameSiteFor(creds: GithubCreds, from: string, to: string): Promise<DeployResult> {
  const octokit = clientFor(creds);
  try {
    await octokit.repos.update({ owner: creds.username, repo: from, name: to });
    return { ok: true, repo: to, url: `https://${creds.username}.github.io/${to}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function deleteSiteFor(creds: GithubCreds, repo: string): Promise<DeployResult & { deleted?: string }> {
  const octokit = clientFor(creds);
  try {
    await octokit.repos.delete({ owner: creds.username, repo });
    return { ok: true, deleted: repo };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Keeper wrappers (bind Philip's creds; used by the agent tool layer) ─────

/** Deploy the most recently uploaded HTML file (Keeper agent path). */
export async function deployPending(): Promise<DeployResult> {
  if (!pending) return { ok: false, error: 'No HTML file has been uploaded yet. Send me an .html file first.' };
  const res = await deployHtml(keeperCreds, pending);
  if (res.ok) pending = null; // consume it
  return res;
}

export const listSites = () => listSitesFor(keeperCreds);
export const checkSiteStatus = (repo: string) => checkSiteStatusFor(keeperCreds, repo);
export const renameSite = (from: string, to: string) => renameSiteFor(keeperCreds, from, to);
export const deleteSite = (repo: string) => deleteSiteFor(keeperCreds, repo);
