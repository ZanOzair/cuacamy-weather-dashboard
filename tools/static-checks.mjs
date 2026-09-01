/**
 * Structural checks on the source itself.
 *
 * These exist because each one caught a real bug that no syntax check would
 * ever see: a duplicated element id (getElementById returns the first match,
 * so the second element silently never gets wired up), a `$('#thing')` whose
 * element had been renamed (throws on the line that adds its listener, which
 * takes out every listener registered after it), and a new API host that the
 * Content-Security-Policy did not allow (every request to it blocked, in
 * production only, because CI had no CSP).
 *
 * Run: node tools/static-checks.mjs
 */

import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const app  = readFileSync('app.js', 'utf8');
const css  = readFileSync('style.css', 'utf8');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};

/* ── 1 · No duplicate element ids ─────────────────────────────────────── */
const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set();
const duplicated = [...new Set(allIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
check('No duplicate element ids', duplicated.length === 0, duplicated.join(', '));

/* ── 2 · Every selector in app.js resolves ────────────────────────────── */
const ids = new Set(allIds);
// Two selectors are built by concatenation at runtime: '#view-' + name.
const DYNAMIC = new Set(['view-', 'tab-']);
const queried = [...new Set([...app.matchAll(/\$\(['"]#([a-zA-Z0-9_-]+)['"]/g)].map((m) => m[1]))];
const unresolved = queried.filter((id) => !ids.has(id) && !DYNAMIC.has(id));
check(`Every element selector resolves (${queried.length} checked)`,
  unresolved.length === 0, unresolved.join(', '));

/* ── 3 · The CSP allows every host the app fetches ────────────────────── */
const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/s) || [])[1] || '';
check('A Content-Security-Policy is present', csp.length > 0);

// Hosts the app only ever links to or opens in a new tab. CSP connect-src does
// not govern navigation, so their absence from it is correct.
const NAVIGATION_ONLY = new Set([
  'www.waze.com', 'www.google.com', 'mail.google.com',
  'www.mkn.gov.my', 'www.bomba.gov.my', 'www.civildefence.gov.my', 'www.met.gov.my',
  'publicinfobanjir.water.gov.my', 'www.water.gov.my', 'www.nadma.gov.my',
  'www.airselangor.com', 'apims.doe.gov.my', 'www.doe.gov.my', 'www.moh.gov.my',
  'www.tnb.com.my', 'aduan.skmm.gov.my', 'www.mcmc.gov.my', 'www.tm.com.my',
  'www.maxis.com.my', 'www.celcomdigi.com', 'www.u.com.my', 'www.llm.gov.my',
  'console.cloud.google.com', 'console.firebase.google.com', 'firebase.google.com',
  'global-flood.emergency.copernicus.eu', 'open-meteo.com', 'www.ecmwf.int'
]);
const hosts = new Set([...app.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
const uncovered = [...hosts].filter((h) => !csp.includes(h) && !NAVIGATION_ONLY.has(h));
check(`CSP covers every fetched host (${hosts.size} seen)`, uncovered.length === 0,
  uncovered.length ? uncovered.join(', ') + ' — add to connect-src, or to NAVIGATION_ONLY if only linked' : '');

/* ── 4 · The service worker knows about every API host ────────────────── */
const sw = readFileSync('sw.js', 'utf8');
const swHosts = new Set([...(sw.match(/'[a-z0-9.-]+\.(org|com|net|gov)'/g) || [])].map((s) => s.replace(/'/g, '')));
const apiHosts = [...hosts].filter((h) => /^(api|air-quality-api|geocoding-api|flood-api|archive-api|earthquake)\./.test(h));
const missedBySw = apiHosts.filter((h) => !swHosts.has(h));
check('The service worker network-firsts every API host', missedBySw.length === 0, missedBySw.join(', '));

/* ── 5 · No innerHTML anywhere ────────────────────────────────────────── */
// The whole injection-safety story rests on this one rule.
const innerHtml = [...app.matchAll(/\.innerHTML\s*=/g)].length;
check('No innerHTML assignment in app.js', innerHtml === 0, `${innerHtml} found`);

/* ── 6 · [hidden] is still enforced globally ──────────────────────────── */
check('[hidden] is forced to display:none', /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css));

/* ── 7 · Every external link is rel-protected ─────────────────────────── */
const targetBlank = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((m) => m[0]);
const unprotected = targetBlank.filter((tag) => !/rel="noopener noreferrer"/.test(tag));
check(`Every target="_blank" link is rel-protected (${targetBlank.length} links)`,
  unprotected.length === 0, unprotected.slice(0, 2).join(' '));

/* ── 8 · app.js and sw.js agree on the version ────────────────────────── */
const appVersion = (app.match(/^const VERSION = '([^']+)'/m) || [])[1];
const swVersion  = (sw.match(/^const VERSION\s+= 'v([^']+)'/m) || [])[1];
check('app.js and sw.js report the same version', Boolean(appVersion) && appVersion === swVersion,
  `app ${appVersion} / sw ${swVersion}`);

/* ── 9 · The guide must describe the app that exists ──────────────────── */
// A README that names a button which was renamed is worse than no README: it
// sends people looking for something that is not there. Every control the
// guide tells a reader to press is checked against the markup.
const readme = readFileSync('README.md', 'utf8');
const PROMISED_CONTROLS = [
  'Install app', 'Use my location', 'Enable notifications', 'Hear the alarm',
  'Compute for this location', 'Compare state capitals', 'Force a fresh copy',
  'Check for updates', 'Continue with Google', 'Not now'
];
const decoded = html.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
const absent = PROMISED_CONTROLS.filter((label) =>
  readme.includes(label) && !decoded.includes(label));
check('Every control the README names exists in the UI', absent.length === 0, absent.join(', '));

// In-page links, using GitHub's slug rule: strip punctuation, then replace each
// space with a hyphen WITHOUT collapsing runs (an em dash leaves two hyphens).
const slug = (h) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');
const headings = new Set([...readme.matchAll(/^#{2,4}\s+(.+)$/gm)].map((m) => slug(m[1])));
const brokenAnchors = [...readme.matchAll(/\]\(#([^)]+)\)/g)]
  .map((m) => m[1]).filter((a) => !headings.has(a));
check('Every in-page README link resolves', brokenAnchors.length === 0, brokenAnchors.join(', '));

/* ── 10 · A custom domain, if configured, must be well formed ─────────── */
// GitHub Pages reads this file literally. A stray "https://", a trailing slash
// or a second line does not produce a helpful error — the domain simply does
// not serve, and the cause is invisible.
if (existsSync('CNAME')) {
  const raw = readFileSync('CNAME', 'utf8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const domain = lines[0] || '';
  const problems = [];
  if (lines.length !== 1) problems.push(`expected exactly one line, found ${lines.length}`);
  if (/^https?:\/\//i.test(domain)) problems.push('remove the https:// prefix');
  if (domain.endsWith('/')) problems.push('remove the trailing slash');
  if (domain.includes('/')) problems.push('a path is not allowed — the hostname only');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    problems.push(`"${domain}" is not a valid hostname`);
  }
  check('The CNAME custom domain is well formed', problems.length === 0, problems.join('; '));

  // The README should send people to the site that actually serves them.
  const stillOld = readme.includes('zanozair.github.io/cuacamy-weather-dashboard');
  check('The README points at the custom domain, not the old github.io address',
    !stillOld, stillOld ? `CNAME says ${domain} but the README still links github.io` : '');
} else {
  console.log('· No CNAME file — the site serves from github.io (see docs/CUSTOM-DOMAIN.md)');
}

console.log('');
if (failures.length) {
  console.log(`${failures.length} static check(s) failed:`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All static checks passed.');
