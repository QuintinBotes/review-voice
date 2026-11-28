/**
 * The one GitHub API root this installation talks to, and the web host that
 * goes with it (docs/adr/0002, amended for #545).
 *
 * It comes from `GITHUB_API_URL` and nowhere else: the Actions runner sets it
 * (and a step cannot override a `GITHUB_*` variable), and locally the operator
 * sets it. Nothing from a pull request or the repository under review can.
 * Unset, it is `https://api.github.com`, as before.
 */
export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['GITHUB_API_URL'];
  if (value === undefined || value === '') return 'https://api.github.com';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GITHUB_API_URL is not a URL.');
  }
  // The token is sent here: https only, with no credentials, query or fragment.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`GITHUB_API_URL must be a plain https URL such as https://ghe.example.com/api/v3.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The web host for that API root: `github.com` for api.github.com, `<host>`
 * for Enterprise Server's `https://<host>/api/v3`, and `<sub>.ghe.com` for
 * `https://api.<sub>.ghe.com`.
 */
export function webHost(baseUrl: string = apiBaseUrl()): string {
  const url = new URL(baseUrl);
  if (url.hostname === 'api.github.com') return 'github.com';
  if (/^api\.[^.]+\.ghe\.com$/.test(url.hostname)) return url.host.slice('api.'.length);
  return url.host;
}

/** owner/repo of a git remote URL on that web host, or null. */
export function remoteRepository(url: string, host: string = webHost()): string | null {
  let authority: string;
  let path: string;
  if (url.includes('://')) {
    const remote = URL.parse(url);
    if (!remote || !['https:', 'http:', 'git:', 'ssh:'].includes(remote.protocol) || remote.search || remote.hash) return null;
    authority = remote.host;
    path = remote.pathname.slice(1);
  } else {
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(url);
    if (!scp) return null;
    authority = scp[1]!;
    path = scp[2]!;
  }
  if (authority.toLowerCase() !== host.toLowerCase()) return null;
  return /^([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(path)?.[1] ?? null;
}
