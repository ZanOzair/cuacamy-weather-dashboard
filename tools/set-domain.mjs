/**
 * Point CuacaMY at your own domain — or back at github.io.
 *
 *   node tools/set-domain.mjs cuacamy.my     # switch to your domain
 *   node tools/set-domain.mjs --clear        # back to the github.io address
 *
 * Switching by hand means writing a CNAME file and remembering every place the
 * old address is written down. Miss one and the guide sends people somewhere
 * that redirects at best. This does both, validates the domain first, and
 * prints exactly what still needs doing outside this repository.
 *
 * It changes files only. DNS, the Pages setting and the Google OAuth origins
 * are yours — the reminders at the end say so, because forgetting the OAuth
 * origin breaks sign-in silently.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const GITHUB_IO = 'https://zanozair.github.io/cuacamy-weather-dashboard/';
const arg = process.argv[2];

if (!arg || arg === '--help' || arg === '-h') {
  console.log(`
Usage:
  node tools/set-domain.mjs <domain>   e.g. cuacamy.my
  node tools/set-domain.mjs --clear    revert to ${GITHUB_IO}

Read docs/CUSTOM-DOMAIN.md first — the DNS records have to be in place, or the
site will not resolve once GitHub is told to expect the domain.
`);
  process.exit(arg ? 0 : 1);
}

/* ── Reverting ─────────────────────────────────────────────────────────── */
if (arg === '--clear') {
  // Read the domain BEFORE deleting the file. Reverting by pattern-matching
  // "any URL that is not github.io" would also rewrite the links to
  // open-meteo.com, met.gov.my and every other source the guide cites. The
  // only safe thing to replace is the exact domain that was set.
  if (!existsSync('CNAME')) {
    console.log('· No CNAME file — nothing to revert.');
    console.log('  If the README still shows a custom domain, edit it by hand:');
    console.log('  there is no record of which domain to replace.');
    process.exit(0);
  }

  const domain = readFileSync('CNAME', 'utf8').trim();
  unlinkSync('CNAME');
  console.log(`· Removed CNAME (was ${domain})`);

  const readme = readFileSync('README.md', 'utf8');
  const restored = readme
    .replaceAll(`https://${domain}/`, GITHUB_IO)
    .replaceAll(`https://${domain}`, GITHUB_IO.replace(/\/$/, ''));
  const changed = readme !== restored;
  writeFileSync('README.md', restored);
  console.log(changed
    ? `· README points back at ${GITHUB_IO}`
    : '· README already had no reference to that domain');
  console.log('\nAlso clear the custom domain in Settings → Pages.');
  process.exit(0);
}

/* ── Setting a domain ──────────────────────────────────────────────────── */
const domain = arg.trim()
  .replace(/^https?:\/\//i, '')      // people paste the whole URL
  .replace(/\/+$/, '')               // and a trailing slash
  .toLowerCase();

const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain);
if (!valid) {
  console.error(`✗ "${arg}" is not a valid hostname.`);
  console.error('  Give the bare domain only — cuacamy.my, not https://cuacamy.my/');
  process.exit(1);
}
if (!domain.includes('.')) {
  console.error(`✗ "${domain}" has no top-level domain.`);
  process.exit(1);
}

writeFileSync('CNAME', domain + '\n');
console.log(`· Wrote CNAME → ${domain}`);

const url = `https://${domain}/`;
let readme = readFileSync('README.md', 'utf8');
readme = readme.replaceAll(GITHUB_IO, url);
// The bare form appears in prose and in the OAuth example.
readme = readme.replaceAll('https://zanozair.github.io/cuacamy-weather-dashboard', url.replace(/\/$/, ''));
writeFileSync('README.md', readme);

// Report the state that resulted, not how many edits this particular run made
// — a second run legitimately changes nothing and "0 links" reads like failure.
const now = (readme.match(new RegExp(`https://${domain.replace(/\./g, '\\.')}`, 'g')) || []).length;
const stale = (readme.match(/zanozair\.github\.io\/cuacamy-weather-dashboard/g) || []).length;
console.log(`· README now names ${url} in ${now} place${now === 1 ? '' : 's'}` +
            (stale ? ` — but ${stale} github.io reference${stale === 1 ? '' : 's'} remain` : ''));

console.log(`
Done in this repository. Three things remain outside it:

  1. DNS — add GitHub's A and AAAA records at your registrar.
     See docs/CUSTOM-DOMAIN.md, step 2.

  2. GitHub — Settings → Pages → Custom domain → ${domain} → Save,
     then tick "Enforce HTTPS" once it stops being greyed out.

  3. Google sign-in — if you set it up, authorise the new origin at
     console.cloud.google.com/apis/credentials:
       add  https://${domain}  to BOTH "Authorised JavaScript origins"
       and "Authorised redirect URIs".
     Skip this and sign-in fails silently on the new address.

Then commit and push. The deploy will verify ${url} rather than github.io.
`);
