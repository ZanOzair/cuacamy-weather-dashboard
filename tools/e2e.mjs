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
await page.waitForFunction(
  () => {
    const t = document.querySelector('#cur-temp')?.textContent || '';
    return /^-?\d+$/.test(t.trim());
  },
  { timeout: 45000 }
).catch(() => {});

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
await page.waitForFunction(
  () => document.querySelector('#hazard-strip')?.dataset.state === 'ready',
  { timeout: 45000 }
).catch(() => {});

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
await page.waitForFunction(
  () => !document.querySelector('#climate-body')?.hidden ||
        (document.querySelector('#climate-status')?.textContent || '').includes('Could not'),
  { timeout: 90000 }
).catch(() => {});
const climate = await page.evaluate(() => ({
  shown: !document.querySelector('#climate-body')?.hidden,
  normalTemp: document.querySelector('#climate-normal-temp')?.textContent,
  normalRain: document.querySelector('#climate-normal-rain')?.textContent,
  anom: document.querySelector('#climate-temp-anom')?.textContent,
  status: document.querySelector('#climate-status')?.textContent
}));
check('Climate normal computed from the 1991-2020 archive', climate.shown,
      climate.shown ? `${climate.normalTemp} / ${climate.normalRain} / ${climate.anom}` : climate.status);

// Every view, on a phone, with no horizontal overflow.
const mobile = await context.newPage();
await mobile.goto(BASE, { waitUntil: 'load' });
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.waitForTimeout(6000);
for (const view of ['dashboard', 'alerts', 'climate', 'explore', 'analytics']) {
  await mobile.click('#tab-' + view);
  await mobile.waitForTimeout(700);
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`No horizontal overflow at 390px — ${view}`, overflow <= 0, `${overflow}px`);
}

// Console must be clean. Firebase is optional and absent here by design.
const realErrors = consoleErrors.filter((e) => !/firebase|config\.js/i.test(e));
check('No console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
const realFailures = requestFailures.filter((f) => !/firebase|config\.js/i.test(f));
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
