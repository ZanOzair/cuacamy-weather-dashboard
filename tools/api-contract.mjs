/**
 * Contract tests for every external API CuacaMY depends on.
 *
 * The app has no backend, so an upstream change is a silent production break:
 * nothing fails at build time, the page just stops showing data. This script
 * calls each endpoint for real and asserts the fields the app reads are still
 * there, so a breaking change upstream shows up as a red build instead of a
 * bug report.
 *
 * Run: node tools/api-contract.mjs [--dump]
 *   --dump  also print the response structure, for exploring an API's shape.
 */

const DUMP = process.argv.includes('--dump');
const LAT = 3.139, LON = 101.6869;          // Kuala Lumpur
const results = [];

const iso = (d) => d.toISOString().slice(0, 10);

/** Walk an object and return its shape as dotted paths, for --dump. */
function shape(value, prefix = '', depth = 0, out = []) {
  if (depth > 2 || out.length > 90) return out;
  if (Array.isArray(value)) {
    out.push(`${prefix}[] (${value.length}) e.g. ${JSON.stringify(value[0])?.slice(0, 70)}`);
    if (value.length && typeof value[0] === 'object' && value[0] !== null) {
      shape(value[0], `${prefix}[0]`, depth + 1, out);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') shape(v, path, depth + 1, out);
      else out.push(`${path} = ${JSON.stringify(v)?.slice(0, 70)}`);
    }
    return out;
  }
  out.push(`${prefix} = ${JSON.stringify(value)?.slice(0, 70)}`);
  return out;
}

/** Resolve a dotted path, tolerating arrays via [0]. */
function at(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    const m = key.match(/^(.*)\[(\d+)\]$/);
    if (m) return m[1] ? acc[m[1]]?.[Number(m[2])] : acc[Number(m[2])];
    return acc[key];
  }, obj);
}

async function check(name, url, required) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const ms = Date.now() - started;

    if (!res.ok) {
      results.push({ name, ok: false, detail: `HTTP ${res.status}`, ms });
      console.log(`\n✗ ${name} — HTTP ${res.status}\n  ${url}`);
      console.log(`  body: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = await res.json();

    if (DUMP) {
      console.log(`\n── ${name} (${ms} ms) ──\n  ${url}`);
      for (const line of shape(data)) console.log('  ' + line);
    }

    const missing = required.filter((p) => at(data, p) === undefined);
    const ok = missing.length === 0;
    results.push({ name, ok, detail: ok ? `${required.length} fields present` : `missing: ${missing.join(', ')}`, ms });
    console.log(`${ok ? '✓' : '✗'} ${name} (${ms} ms)${ok ? '' : ' — missing: ' + missing.join(', ')}`);
    return data;
  } catch (err) {
    results.push({ name, ok: false, detail: err.message, ms: Date.now() - started });
    console.log(`✗ ${name} — ${err.message}\n  ${url}`);
    return null;
  }
}

const OM = 'https://api.open-meteo.com/v1/forecast';
const AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FL = 'https://flood-api.open-meteo.com/v1/flood';
const GE = 'https://geocoding-api.open-meteo.com/v1/search';
const AR = 'https://archive-api.open-meteo.com/v1/archive';
const EQ = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

console.log('CuacaMY — external API contract tests\n');

await check('Open-Meteo · forecast',
  `${OM}?latitude=${LAT}&longitude=${LON}` +
  `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
  `&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility,uv_index` +
  `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max` +
  `&timezone=auto&forecast_days=7&wind_speed_unit=ms`,
  ['utc_offset_seconds', 'timezone', 'current.time', 'current.temperature_2m', 'current.weather_code',
   'current.relative_humidity_2m', 'current.apparent_temperature', 'current.is_day',
   'current.pressure_msl', 'current.wind_speed_10m', 'current.wind_direction_10m',
   'current.wind_gusts_10m', 'current.cloud_cover',
   'hourly.time', 'hourly.temperature_2m', 'hourly.precipitation_probability',
   'hourly.weather_code', 'hourly.wind_speed_10m', 'hourly.visibility', 'hourly.uv_index',
   'daily.time', 'daily.weather_code', 'daily.temperature_2m_max', 'daily.temperature_2m_min',
   'daily.sunrise', 'daily.sunset', 'daily.precipitation_sum',
   'daily.precipitation_probability_max', 'daily.wind_gusts_10m_max', 'daily.uv_index_max']);

await check('Open-Meteo · air quality',
  `${AQ}?latitude=${LAT}&longitude=${LON}` +
  `&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,european_aqi` +
  `&hourly=pm2_5&timezone=auto&forecast_days=2`,
  ['current.pm2_5', 'current.pm10', 'current.ozone', 'current.nitrogen_dioxide',
   'current.sulphur_dioxide', 'current.carbon_monoxide', 'hourly.pm2_5', 'hourly.time']);

await check('Open-Meteo · flood (GloFAS)',
  `${FL}?latitude=${LAT}&longitude=${LON}&daily=river_discharge&forecast_days=92`,
  ['daily.time', 'daily.river_discharge']);

await check('Open-Meteo · flood ensemble stats',
  `${FL}?latitude=${LAT}&longitude=${LON}` +
  `&daily=river_discharge,river_discharge_mean,river_discharge_median,river_discharge_max,river_discharge_min`,
  ['daily.river_discharge_median', 'daily.river_discharge_max']);

await check('Open-Meteo · geocoding',
  `${GE}?name=Kuantan&count=5&language=en&format=json`,
  ['results[0].name', 'results[0].latitude', 'results[0].longitude',
   'results[0].country_code', 'results[0].admin1']);

const end = new Date(Date.now() - 7 * 86400000);
const start = new Date(Date.UTC(end.getUTCFullYear() - 3, 0, 1));
await check('Open-Meteo · archive (climate normals)',
  `${AR}?latitude=${LAT}&longitude=${LON}&start_date=${iso(start)}&end_date=${iso(end)}` +
  `&daily=temperature_2m_mean,precipitation_sum&timezone=auto`,
  ['daily.time', 'daily.temperature_2m_mean', 'daily.precipitation_sum']);

const quakeFrom = new Date(Date.now() - 30 * 86400000);
await check('USGS · earthquakes near Malaysia',
  `${EQ}?format=geojson&latitude=${LAT}&longitude=${LON}&maxradiuskm=2000` +
  `&starttime=${iso(quakeFrom)}&minmagnitude=4&orderby=time&limit=20`,
  ['type', 'features', 'metadata.count']);

const quakes = await check('USGS · global significant feed',
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson',
  ['features', 'metadata.generated']);

if (quakes?.features?.length && DUMP) {
  console.log('\n── sample earthquake feature ──');
  for (const line of shape(quakes.features[0])) console.log('  ' + line);
}

console.log('\n' + '─'.repeat(64));
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(38)} ${r.detail}`);
console.log('─'.repeat(64));

if (failed.length) {
  console.log(`\n${failed.length} of ${results.length} contract checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} contract checks passed.`);
