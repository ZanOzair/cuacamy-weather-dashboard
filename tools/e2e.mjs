/**
 * End-to-end smoke test against real APIs.
 *
 * The contract tests prove the endpoints still answer; this proves the app
 * actually renders what they return. It runs in CI because that is the only
 * place with unrestricted network access, and it fails the build on any
 * console error, any missing data, or any horizontal overflow on a phone.
 *
 * Run: node tools/e2e.mjs  (expects a static server on PORT, default 8080)
 */

import { chromium } from 'playwright';

const BASE = `http://127.0.0.1:${process.env.PORT || 8080}/index.html`;
const failures = [];
const notes = [];

const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(`${label}${detail ? ': ' + detail : ''}`);
};

/**
 * Poll a page predicate until it holds. Written out rather than using
 * page.waitForFunction because its second parameter is the argument passed to
 * the page function, not the options — an easy call to get wrong, and a wait
 * that silently does not wait is worse than no wait at all.
 */
async function waitFor(page, label, predicate, { timeout = 60000, interval = 500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    let ok = false;
    try { ok = await page.evaluate(predicate); } catch { /* mid-navigation */ }
    if (ok) {
      console.log(`  … ${label} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return true;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  console.log(`  … ${label} TIMED OUT after ${(timeout / 1000).toFixed(0)}s`);
  return false;
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  // Somewhere with real weather, real rivers and real seismicity nearby.
  geolocation: { latitude: 3.139, longitude: 101.6869 },
  permissions: [],
  locale: 'en-MY'
});
const page = await context.newPage();

const consoleErrors = [];
const requestFailures = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', (r) => requestFailures.push(`${r.url()} :: ${r.failure()?.errorText || ''}`));

console.log(`\nEnd-to-end smoke test — ${BASE}\n`);

await page.goto(BASE, { waitUntil: 'load' });

// Wait for live data rather than a fixed sleep.
await waitFor(page, 'temperature rendered',
  () => /^-?\d+$/.test((document.querySelector('#cur-temp')?.textContent || '').trim()),
  { timeout: 60000 });

const dash = await page.evaluate(() => ({
  temp: document.querySelector('#cur-temp')?.textContent?.trim(),
  desc: document.querySelector('#cur-desc')?.textContent?.trim(),
  source: document.querySelector('#cur-source')?.textContent?.trim(),
  humidity: document.querySelector('#m-humidity')?.textContent?.trim(),
  wind: document.querySelector('#m-wind')?.textContent?.trim(),
  aqi: document.querySelector('#aqi-score')?.textContent?.trim(),
  aqiLabel: document.querySelector('#aqi-label')?.textContent?.trim(),
  forecastCards: document.querySelectorAll('.fcard').length,
  highs: [...document.querySelectorAll('.fcard__hi')].map((n) => n.textContent),
  briefing: document.querySelector('#assistant-briefing')?.textContent?.trim(),
  chartPixels: (() => {
    const c = document.querySelector('#hourly-chart');
    if (!c) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  })()
}));

check('Live temperature rendered', /^-?\d+$/.test(dash.temp || ''), `"${dash.temp}"`);
check('Served by a live provider, not the offline model',
      /Live · (Open-Meteo|OpenWeatherMap)/.test(dash.source || ''), dash.source);
check('Condition text present', Boolean(dash.desc) && dash.desc !== '—', dash.desc);
check('Humidity present', /\d+%/.test(dash.humidity || ''), dash.humidity);
check('Wind present', /\d/.test(dash.wind || ''), dash.wind);
check('Five forecast cards', dash.forecastCards === 5, `${dash.forecastCards} cards`);
check('Forecast highs are numbers', dash.highs.every((h) => /-?\d+°/.test(h)), dash.highs.join(' '));
check('Hourly chart painted', dash.chartPixels > 5000, `${dash.chartPixels} px`);
check('Air Pollutant Index computed', /^\d+$/.test(dash.aqi || ''), `${dash.aqi} ${dash.aqiLabel}`);
check('Assistant briefing generated',
      Boolean(dash.briefing) && !dash.briefing.startsWith('Load a location'),
      (dash.briefing || '').slice(0, 90));

// The hazard sweep makes its own calls; give it room.
await waitFor(page, 'hazard sweep finished',
  () => document.querySelector('#hazard-strip')?.dataset.state === 'ready',
  { timeout: 60000 });

const hazard = await page.evaluate(() => ({
  state: document.querySelector('#hazard-strip')?.dataset.state,
  text: document.querySelector('#hazard-strip')?.textContent?.replace(/\s+/g, ' ').trim(),
  alerts: document.querySelectorAll('.alert').length
}));
check('Hazard sweep completed', hazard.state === 'ready', hazard.state);
check('Hazard strip has content', (hazard.text || '').length > 20, (hazard.text || '').slice(0, 80));

// Alerts view — the earthquake list needs a real USGS response.
await page.click('#tab-alerts');
await page.waitForTimeout(3000);
const alerts = await page.evaluate(() => ({
  cards: document.querySelectorAll('.alert').length,
  quakes: document.querySelectorAll('.quake').length,
  quakeEmptyHidden: document.querySelector('#quake-empty')?.hidden,
  floodShown: !document.querySelector('#flood-panel')?.hidden,
  floodNow: document.querySelector('#flood-now')?.textContent
}));
check('At least one alert card (seasonal context always present)', alerts.cards >= 1, `${alerts.cards}`);
check('Earthquake feed reached USGS',
      alerts.quakes > 0 || alerts.quakeEmptyHidden === false,
      `${alerts.quakes} listed`);
check('Flood panel populated from GloFAS', alerts.floodShown, alerts.floodNow);
notes.push(`Earthquakes listed: ${alerts.quakes}`);

// Assistant answers.
await page.click('#tab-dashboard');
await page.waitForTimeout(500);
await page.fill('#assistant-input', 'Will it rain today?');
await page.click('#assistant-form button[type=submit]');
await page.waitForTimeout(400);
const answer = await page.$eval('.ask--a p', (n) => n.textContent);
check('Assistant answered a question', (answer || '').length > 40, (answer || '').slice(0, 80));

// Climate normals — the heaviest call in the app.
await page.click('#tab-climate');
await page.waitForTimeout(600);
const monsoon = await page.textContent('#monsoon-name');
check('Monsoon phase resolved', Boolean(monsoon) && monsoon !== '—', monsoon);

await page.click('#btn-climate');
await waitFor(page, 'climate normal computed',
  () => !document.querySelector('#climate-body')?.hidden ||
        (document.querySelector('#climate-status')?.textContent || '').includes('Could not'),
  { timeout: 120000, interval: 1000 });
const climate = await page.evaluate(() => ({
  shown: !document.querySelector('#climate-body')?.hidden,
  normalTemp: document.querySelector('#climate-normal-temp')?.textContent,
  normalRain: document.querySelector('#climate-normal-rain')?.textContent,
  actualTemp: document.querySelector('#climate-actual-temp')?.textContent,
  actualRain: document.querySelector('#climate-actual-rain')?.textContent,
  anom: document.querySelector('#climate-temp-anom')?.textContent,
  rainAnom: document.querySelector('#climate-rain-anom')?.textContent,
  note: document.querySelector('#climate-note')?.textContent,
  status: document.querySelector('#climate-status')?.textContent
}));
check('Climate normal computed from the 1991-2020 archive', climate.shown,
      climate.shown ? `normal ${climate.normalTemp} / observed ${climate.actualTemp} / ${climate.anom}` : climate.status);
if (climate.shown) {
  notes.push(`Climate — normal ${climate.normalTemp}, observed ${climate.actualTemp}, ${climate.anom}`);
  notes.push(`Climate — rain normal ${climate.normalRain}, observed ${climate.actualRain}, ${climate.rainAnom}`);
  notes.push(`Climate note: ${(climate.note || '').slice(0, 160)}`);
  // Two legitimate outcomes, and the test has to accept both.
  //
  // ERA5 reanalysis is finalised about five days behind real time, so in the
  // first days of a month there is genuinely nothing to compare against yet.
  // The app says so plainly and shows no anomaly — that is correct behaviour,
  // not a failure. Asserting a number unconditionally made this build fail on
  // the 1st of September for a reason that had nothing to do with the commit,
  // and would have done the same at the start of every month.
  //
  // When there IS an observed month-to-date, the bound still applies: a monthly
  // mean anomaly beyond 3 °C in the tropics is far more likely to be a bug in
  // the comparison than real weather. That bound is what caught the two
  // different reanalysis models being differenced against each other.
  const a = parseFloat((climate.anom || '').replace(/[^0-9.+-]/g, ''));
  const noDataYet = /no finalised reanalysis days yet/i.test(climate.note || '');

  if (noDataYet) {
    check('Month-to-date is honestly reported as not yet available',
      !Number.isFinite(a),
      `note says no data, but an anomaly of "${climate.anom}" was shown anyway`);
    notes.push('Climate: month-to-date not yet finalised by ERA5 — anomaly correctly withheld');
  } else {
    check('Temperature anomaly is physically plausible', Number.isFinite(a) && Math.abs(a) <= 3,
          `${climate.anom} (normal ${climate.normalTemp}, observed ${climate.actualTemp})`);
  }

  // Either way the 30-year normal itself must be a sane tropical temperature —
  // that half of the computation does not depend on the current month at all.
  const n = parseFloat((climate.normalTemp || '').replace(/[^0-9.-]/g, ''));
  check('The 30-year normal is a plausible Malaysian temperature',
    Number.isFinite(n) && n >= 20 && n <= 33, climate.normalTemp);
}

// Weather analysis — the heaviest view, and the one the whole tab is now for.
await page.click('#tab-analytics');
await waitFor(page, 'weather analysis computed',
  () => !document.querySelector('#wx-body')?.hidden ||
        (document.querySelector('#wx-status')?.textContent || '').includes('Could not'),
  { timeout: 90000 });

const wx = await page.evaluate(() => {
  const painted = (id) => {
    const c = document.querySelector(id);
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
    return n;
  };
  return {
    shown: !document.querySelector('#wx-body')?.hidden,
    status: document.querySelector('#wx-status')?.textContent,
    scope: document.querySelector('#wx-scope')?.textContent,
    charts: {
      temperature: painted('#wx-temp'),
      diurnalTemp: painted('#wx-diurnal-temp'),
      diurnalRain: painted('#wx-diurnal-rain'),
      rainDaily: painted('#wx-rain-daily'),
      rainCumulative: painted('#wx-rain-cum'),
      windRose: painted('#wx-rose'),
      pressure: painted('#wx-pressure'),
      heatStress: painted('#wx-heat')
    },
    tables: document.querySelectorAll('.table--stats').length,
    tableRows: document.querySelectorAll('.table--stats tbody tr').length,
    insights: [...document.querySelectorAll('.viz-insight')]
      .map((n) => n.textContent.trim()).filter((t) => t.length > 30).length,
    legendItems: document.querySelectorAll('.viz-legend__item').length
  };
});

check('Weather analysis computed', wx.shown, wx.shown ? wx.scope : wx.status);
for (const [name, px] of Object.entries(wx.charts)) {
  check(`Chart painted — ${name}`, px > 2000, `${px} px`);
}
check('Every figure has a table view', wx.tables >= 7, `${wx.tables} tables, ${wx.tableRows} rows`);
check('Insight prose generated for each section', wx.insights >= 6, `${wx.insights} passages`);
check('Legends present for multi-series charts', wx.legendItems >= 6, `${wx.legendItems} legend items`);
notes.push(`Analysis scope: ${wx.scope}`);

// The hover layer is part of the chart, not a nicety — verify it responds.
const chart = await page.$('#wx-temp');
if (chart) {
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(400);
  const tip = await page.evaluate(() => {
    const t = document.querySelector('#wx-temp')?.parentElement?.querySelector('.viz-tip');
    return { shown: t && !t.hidden, text: (t?.textContent || '').slice(0, 80) };
  });
  check('Chart tooltip responds to hover', tip.shown, tip.text);
}

// Google sign-in must never be a dead button.
await page.click('#tab-dashboard');
await page.click('#btn-account');
await page.waitForTimeout(400);
const google = await page.evaluate(() => ({
  disabled: document.querySelector('#btn-google')?.disabled,
  label: document.querySelector('#btn-google-label')?.textContent
}));
check('Google button is actionable, not disabled', google.disabled === false, google.label);
await page.keyboard.press('Escape');

/* ── The notification system ─────────────────────────────────────────────
 * Every one of these assertions exists because the behaviour it checks was
 * broken at some point: toasts stacked without limit, a dismissal drained two
 * queue slots at once, a sticky hazard warning queued behind four routine
 * confirmations, and "clear all" logged its own confirmation back into the
 * list it had just emptied. */
await page.evaluate(() => {
  for (let i = 0; i < 9; i += 1) window.CuacaMY.toast('Queue test ' + i, 'info', { title: 'Q' + i });
});
await page.waitForTimeout(400);
const stacked = await page.$$eval('.toast', (n) => n.length);
check('At most 4 toasts on screen; the rest queue', stacked === 4, `${stacked} shown`);

await page.click('.toast .toast__close');
await page.waitForTimeout(700);
const afterDismiss = await page.$$eval('.toast', (n) => n.length);
check('Dismissing one toast promotes exactly one from the queue', afterDismiss === 4, `${afterDismiss} shown`);

const jumped = await page.evaluate(async () => {
  window.CuacaMY.toast('URGENT-JUMP', 'hazard', { sticky: true, title: 'Urgent', id: 'e2e:urgent' });
  await new Promise((r) => setTimeout(r, 300));
  return [...document.querySelectorAll('.toast')].some((n) => n.textContent.includes('URGENT-JUMP'));
});
check('An urgent alert jumps the queue instead of waiting behind routine toasts', jumped);

const noTimer = await page.$$eval('.toast', (ns) =>
  ns.some((n) => n.textContent.includes('URGENT-JUMP') && !n.querySelector('.toast__timer')));
check('A sticky alert has no auto-dismiss timer', noTimer);

// Jumping the queue must not also break the cap. Evicting a toast used to run
// the normal drain, which promoted a queued item into the slot the urgent
// alert was meant to take, leaving five on screen.
const capped = await page.evaluate(() => {
  const t = window.CuacaMY.toasts();
  return { visible: t.visible.length, dom: document.querySelectorAll('.toast:not(.is-out)').length };
});
check('Queue-jumping still respects the four-toast cap',
  capped.visible <= 4 && capped.dom <= 4, JSON.stringify(capped));

await page.evaluate(() => {
  window.CuacaMY.toast('One', 'warn', { id: 'e2e:dup', title: 'Dup' });
  window.CuacaMY.toast('Two', 'warn', { id: 'e2e:dup', title: 'Dup' });
});
await page.waitForTimeout(500);
// Count copies wherever they are. Asserting only on what is painted would pass
// while a hundred identical warnings piled up invisibly in the queue.
const dupes = await page.evaluate(() => {
  const t = window.CuacaMY.toasts();
  return [...t.visible, ...t.queued].filter((m) => m === 'One' || m === 'Two').length;
});
check('An id collapses repeats on screen and in the queue alike', dupes === 1, `${dupes} copies`);

await page.click('#btn-notif');
await page.waitForTimeout(300);
check('The notification centre opens', await page.isVisible('#notif-panel'));
check('It lists the history', (await page.$$eval('#notif-list .notif', (n) => n.length)) > 0);
check('Opening it clears the unread badge', await page.isHidden('#notif-count'));
await page.click('#btn-notif-clear');
await page.waitForTimeout(400);
const cleared = await page.$$eval('#notif-list .notif', (n) => n.length);
check('Clear all really empties the history', cleared === 0, `${cleared} left`);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

/* ── Signing in ──────────────────────────────────────────────────────────
 * The rule that matters here: a visitor must never be shown a control that
 * cannot do anything for them. With no Google provider connected, the whole
 * Google block is absent — not greyed out, not a button that opens a Google
 * Cloud wizard the visitor has no business seeing. */
await page.click('#btn-account');
await page.waitForTimeout(500);
check('With no provider connected, the Google block is not shown at all',
  await page.isHidden('#google-block'));
check('The email form is still offered', await page.isVisible('#auth-form'));
const modeNote = await page.textContent('#auth-mode-note');
check('The sign-in note does not push owner setup at a visitor',
  !/set up|wizard|client id|firebase/i.test(modeNote), modeNote.slice(0, 70) + '…');

// The wizard still exists — it just belongs to the owner, reached from Settings.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#btn-settings')?.click());
await page.waitForTimeout(500);
await page.click('#set-google-wizard');
await page.waitForTimeout(500);
check('The owner can reach the Google wizard from Settings',
  await page.isVisible('#google-setup-dialog'));
check('The wizard is labelled as owner-only', await page.isVisible('.owner-flag'));
const shownOrigin = await page.textContent('#gs-origin');
check('The wizard shows the exact origin to authorise with Google',
  shownOrigin === new URL(BASE).origin, shownOrigin);
await page.fill('#gs-client-id', 'not-a-client-id');
await page.click('#gs-save');
await page.waitForTimeout(300);
check('A malformed client ID is rejected before Google ever sees it',
  (await page.textContent('#gs-err')).length > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ── Installing as an app ────────────────────────────────────────────────
 * Chromium in CI does not fire beforeinstallprompt, so the button falls back
 * to per-platform instructions — which is exactly the path an iPhone user
 * takes, and the one worth proving works. */
await page.evaluate(() => document.querySelector('#install-card-cta')?.click());
await page.waitForTimeout(500);
check('Pressing Install always shows something', await page.isVisible('#install-dialog'));
const platformBlocks = await page.$$eval('[data-platform]',
  (ns) => ns.filter((n) => !n.hidden).map((n) => n.dataset.platform));
check('Exactly one set of platform steps is shown, matching this browser',
  platformBlocks.length === 1, platformBlocks.join(', ') || 'none');
const stepCount = await page.$$eval('[data-platform]:not([hidden]) .install-steps li', (n) => n.length);
check('Those steps are real instructions, not an empty panel', stepCount >= 1 || platformBlocks[0] === 'desktop-firefox',
  `${stepCount} steps for ${platformBlocks[0]}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
notes.push(`Install path verified for platform "${platformBlocks[0]}"`);

/* ── Official agency directory ───────────────────────────────────────── */
await page.click('#tab-alerts');
await page.waitForTimeout(1200);
const agencyGroups = await page.$$eval('.agency-group', (n) => n.length);
const agencyCount  = await page.$$eval('.agency', (n) => n.length);
check('The agency directory renders every group', agencyGroups === 5, `${agencyGroups} groups`);
check('The agency directory renders every entry', agencyCount >= 16, `${agencyCount} agencies`);
const unsafeLinks = await page.$$eval('.agency__link, .footer__links a', (ns) =>
  ns.filter((a) => !/^https:\/\//.test(a.href) || a.rel !== 'noopener noreferrer')
    .map((a) => a.textContent.trim()));
check('Every outbound agency link is https and rel-protected',
  unsafeLinks.length === 0, unsafeLinks.slice(0, 3).join(', '));
const telLinks = await page.$$eval('.agency__call', (ns) => ns.map((a) => a.getAttribute('href')));
check('Agency phone numbers are tappable tel: links',
  telLinks.length >= 10 && telLinks.every((h) => h.startsWith('tel:')), `${telLinks.length} numbers`);
check('999 is one tap away in the footer',
  (await page.getAttribute('.footer__999', 'href')) === 'tel:999');
notes.push(`Agency directory: ${agencyCount} agencies across ${agencyGroups} groups, ${telLinks.length} phone numbers`);

/* ── Saved places explain themselves ─────────────────────────────────── */
await page.click('#tab-dashboard');
await page.waitForTimeout(500);
const emptyText = (await page.textContent('#saved-empty')).replace(/\s+/g, ' ').trim();
check('The saved-places empty state explains what it is for', emptyText.length > 120, emptyText.slice(0, 60) + '…');
check('…and offers a way out of it', await page.isVisible('#saved-empty-cta'));

// Every view, on a phone, with no horizontal overflow.
const mobile = await context.newPage();
await mobile.goto(BASE, { waitUntil: 'load' });
await mobile.setViewportSize({ width: 390, height: 844 });
await waitFor(mobile, 'mobile dashboard populated',
  () => /^-?\d+$/.test((document.querySelector('#cur-temp')?.textContent || '').trim()),
  { timeout: 60000 });
/* Real handset sizes rather than one convenient width. 320 is a first-
 * generation SE, 360 is the most common Android in Malaysia, and the
 * landscape entry catches dialogs sized only for portrait. */
const HANDSETS = [
  { name: 'iPhone SE 320',  width: 320, height: 568 },
  { name: 'Android 360',    width: 360, height: 800 },
  { name: 'iPhone 390',     width: 390, height: 844 },
  { name: 'Pixel 412',      width: 412, height: 915 },
  { name: 'Max 430',        width: 430, height: 932 },
  { name: 'Landscape 844',  width: 844, height: 390 }
];
for (const device of HANDSETS) {
  await mobile.setViewportSize({ width: device.width, height: device.height });
  await mobile.waitForTimeout(300);
  for (const view of ['dashboard', 'alerts', 'climate', 'explore', 'analytics']) {
    await mobile.click('#tab-' + view);
    await mobile.waitForTimeout(view === 'analytics' ? 6000 : 600);
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${device.name} · ${view} — no horizontal overflow`, overflow <= 1, `${overflow}px`);
  }
}
notes.push(`Layout verified across ${HANDSETS.length} handset viewports × 5 views`);

/* Touch targets. A control smaller than 44px is a miss waiting to happen, and
 * an input under 16px makes iOS zoom the whole page on focus. */
// This needs its OWN context: the 44px rules are behind `@media (pointer:
// coarse)`, and resizing a desktop context does not make that match. Without
// hasTouch the check silently measures the mouse layout and reports failures
// that do not exist on a phone.
const touchContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  locale: 'en-MY'
});
const touch = await touchContext.newPage();
await touch.goto(BASE, { waitUntil: 'load' });
await waitFor(touch, 'touch-target page ready',
  () => Boolean(document.querySelector('#place-name')?.textContent?.trim()), { timeout: 60000 });
await touch.click('#tab-alerts');
await touch.waitForTimeout(1500);
const undersized = await touch.$$eval(
  'button, a.btn, .icon-btn, .tab, .agency__call, .agency__link',
  (ns) => ns.filter((n) => {
    const b = n.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.height < 40;
  }).map((n) => (n.id || n.className) + ':' + Math.round(n.getBoundingClientRect().height)));
check('No control is smaller than a fingertip', undersized.length === 0, undersized.slice(0, 5).join(', '));
const zoomers = await touch.$$eval('input, select, textarea', (ns) =>
  ns.filter((n) => parseFloat(getComputedStyle(n).fontSize) < 16).map((n) => n.id));
check('No input under 16px, so iOS never zooms on focus', zoomers.length === 0, zoomers.join(', '));

/* The service worker must register, or offline support and the update prompt
 * both quietly do nothing. isSecureContext — not a hostname string — is the
 * rule the browser actually applies. */
const swState = await touch.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const regs = await navigator.serviceWorker.getRegistrations();
  return { supported: true, secure: window.isSecureContext, count: regs.length };
});
check('The service worker registers', swState.count >= 1, JSON.stringify(swState));
check('A hard-refresh escape hatch is published',
  await touch.evaluate(() => typeof window.CuacaMY?.hardRefresh === 'function'));

// [hidden] is a user-agent rule, so any author `display` declaration silently
// overrides it. Assert nothing marked hidden is actually on screen.
const leaking = await page.evaluate(() =>
  [...document.querySelectorAll('[hidden]')]
    .filter((n) => getComputedStyle(n).display !== 'none')
    .map((n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')));
check('Nothing marked [hidden] is visible', leaking.length === 0, leaking.join(', '));

// Console must be clean. Firebase is optional and absent here by design.
const realErrors = consoleErrors.filter((e) => !/firebase|config\.js/i.test(e));
check('No console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
// ERR_ABORTED is what Chromium reports for AbortController.abort(), which this
// app does on purpose: request timeouts, and superseding an in-flight fetch
// when the user switches place before the first one lands. Counting a
// deliberate cancellation as a failure would fail the build for working
// correctly. Every other failure category still counts.
const realFailures = requestFailures.filter((f) =>
  !/firebase|config\.js/i.test(f) && !/ERR_ABORTED/.test(f));
check('No failed requests', realFailures.length === 0, realFailures.slice(0, 3).join(' | '));

await browser.close();

console.log('\n' + '─'.repeat(64));
for (const n of notes) console.log('· ' + n);
if (failures.length) {
  console.log(`\n${failures.length} end-to-end check(s) failed:`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\nAll end-to-end checks passed against live APIs.');
