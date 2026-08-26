/* =============================================================================
 * CuacaMY — Malaysia Weather Dashboard
 * -----------------------------------------------------------------------------
 * A single-file, dependency-free ES module. Everything the dashboard does —
 * networking, caching, charting, authentication, storage and analytics — is
 * implemented here with browser-native APIs only.
 *
 * Architecture, top to bottom:
 *
 *   01  Configuration & constants
 *   02  Bundled Malaysia gazetteer (states + ~200 towns, offline)
 *   03  Small utilities (DOM, formatting, math)
 *   04  Telemetry — local performance + usage analytics
 *   05  HTTP layer — timeout, retry, de-duplication, stale-while-revalidate
 *   06  OpenWeatherMap API client (+ offline demo generator)
 *   07  Icon mapping
 *   08  Persistence — IndexedDB, with optional Firestore mirror
 *   09  Authentication — local (WebCrypto PBKDF2) or Firebase
 *   10  Application state
 *   11  Rendering — dashboard, charts, explore, analytics
 *   12  Search combobox
 *   13  Event wiring & boot
 *
 * The `fetch` explanations the brief asked for live in section 05, where the
 * network layer is built up step by step.
 * =========================================================================== */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
 * 01 · CONFIGURATION & CONSTANTS
 * ═══════════════════════════════════════════════════════════════════════════ */

const VERSION = '1.1.0';

/**
 * Runtime configuration, resolved in priority order:
 *   1. `config.js`      — a git-ignored file you create from config.example.js
 *   2. `localStorage`   — a key pasted into the in-app Settings dialog
 *   3. demo mode        — deterministic synthetic data, so the UI is never blank
 *
 * `config.js` is loaded with a *dynamic* import wrapped in `.catch()`. A static
 * `<script src>` would log a 404 in the console when the file is absent; a
 * dynamic import rejects with a Promise we can quietly swallow instead.
 */
const CONFIG = {
  openWeatherKey: '',
  firebase: null,          // paste your Firebase web config object here
  googleMapsKey: '',       // optional; only used to build richer map links
  defaultCity: { name: 'Kuala Lumpur', state: 'W.P. Kuala Lumpur', country: 'MY', lat: 3.1390, lon: 101.6869 }
};

const OWM = {
  base: 'https://api.openweathermap.org',
  weather:  '/data/2.5/weather',
  forecast: '/data/2.5/forecast',
  air:      '/data/2.5/air_pollution',
  geoDirect:  '/geo/1.0/direct',
  geoReverse: '/geo/1.0/reverse'
};

const LS = {
  settings:  'cuacamy.settings.v1',
  firebase:  'cuacamy.firebase.v1',
  apiKey:    'cuacamy.apikey.v1',
  session:   'cuacamy.session.v1',
  analytics: 'cuacamy.analytics.v1',
  lastPlace: 'cuacamy.lastplace.v1'
};

/** How long each kind of response stays fresh in the local cache (ms). */
const TTL = {
  weather:  10 * 60 * 1000,   // conditions change slowly; 10 minutes is plenty
  forecast: 60 * 60 * 1000,   // OWM only recomputes the 5-day model hourly
  air:      30 * 60 * 1000,
  geo:      30 * 24 * 60 * 60 * 1000  // place coordinates essentially never move
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 02 · BUNDLED MALAYSIA GAZETTEER
 * ---------------------------------------------------------------------------
 * All 13 states + 3 federal territories, and roughly 200 towns and districts,
 * are compiled into the bundle. Searching for a Malaysian place therefore
 * resolves instantly and works with no network at all — the geocoding API is
 * only consulted for places outside this list.
 *
 * Encoding: "Name|stateCode|lat|lon[|C]" where a trailing C marks a state
 * capital or administrative seat. Packing it as a string instead of an array of
 * objects keeps the payload roughly 60% smaller.
 * ═══════════════════════════════════════════════════════════════════════════ */

const MY_STATES = {
  JHR: 'Johor',            KDH: 'Kedah',           KTN: 'Kelantan',
  MLK: 'Melaka',           NSN: 'Negeri Sembilan', PHG: 'Pahang',
  PRK: 'Perak',            PLS: 'Perlis',          PNG: 'Pulau Pinang',
  SBH: 'Sabah',            SWK: 'Sarawak',         SGR: 'Selangor',
  TRG: 'Terengganu',       KUL: 'W.P. Kuala Lumpur',
  LBN: 'W.P. Labuan',      PJY: 'W.P. Putrajaya'
};

const MY_PLACES_RAW = [
  /* Johor */
  'Johor Bahru|JHR|1.4655|103.7578|C','Iskandar Puteri|JHR|1.4271|103.6296',
  'Pasir Gudang|JHR|1.4735|103.8918','Kulai|JHR|1.6592|103.6031',
  'Skudai|JHR|1.5386|103.6597','Batu Pahat|JHR|1.8548|102.9325',
  'Muar|JHR|2.0442|102.5689','Kluang|JHR|2.0250|103.3185',
  'Segamat|JHR|2.5148|102.8158','Pontian|JHR|1.4869|103.3894',
  'Kota Tinggi|JHR|1.7381|103.8998','Mersing|JHR|2.4312|103.8405',
  'Yong Peng|JHR|2.0122|103.0762','Tangkak|JHR|2.2670|102.5450',
  'Labis|JHR|2.3833|103.0167','Simpang Renggam|JHR|1.8500|103.3167',
  'Ayer Hitam|JHR|1.9200|103.1800','Pengerang|JHR|1.3833|104.1167',
  'Desaru|JHR|1.5528|104.2694','Bukit Indah|JHR|1.4867|103.6603',
  /* Kedah */
  'Alor Setar|KDH|6.1248|100.3678|C','Sungai Petani|KDH|5.6470|100.4874',
  'Kulim|KDH|5.3653|100.5615','Langkawi|KDH|6.3167|99.8500',
  'Jitra|KDH|6.2667|100.4222','Baling|KDH|5.6772|100.9169',
  'Yan|KDH|5.8000|100.3833','Pendang|KDH|5.9908|100.4736',
  'Kuala Kedah|KDH|6.1000|100.2967','Gurun|KDH|5.8167|100.4667',
  'Bandar Baharu|KDH|5.0833|100.4667','Sik|KDH|5.8167|100.7333',
  'Kuala Nerang|KDH|6.2500|100.6000','Kuala Muda|KDH|5.6167|100.4333',
  /* Kelantan */
  'Kota Bharu|KTN|6.1333|102.2386|C','Pasir Mas|KTN|6.0489|102.1400',
  'Tanah Merah|KTN|5.8000|102.1500','Machang|KTN|5.7667|102.2167',
  'Kuala Krai|KTN|5.5333|102.2000','Gua Musang|KTN|4.8833|101.9667',
  'Pasir Puteh|KTN|5.8333|102.4000','Bachok|KTN|6.0667|102.4000',
  'Tumpat|KTN|6.2000|102.1667','Jeli|KTN|5.7000|101.8500',
  'Rantau Panjang|KTN|6.0333|101.9833','Wakaf Bharu|KTN|6.1500|102.2167',
  /* Melaka */
  'Bandar Melaka|MLK|2.1896|102.2501|C','Ayer Keroh|MLK|2.2667|102.2833',
  'Alor Gajah|MLK|2.3803|102.2083','Jasin|MLK|2.3083|102.4333',
  'Masjid Tanah|MLK|2.3500|102.1000','Merlimau|MLK|2.1500|102.4333',
  'Bukit Katil|MLK|2.2500|102.2833',
  /* Negeri Sembilan */
  'Seremban|NSN|2.7297|101.9381|C','Port Dickson|NSN|2.5228|101.7960',
  'Nilai|NSN|2.8148|101.7972','Bahau|NSN|2.8000|102.4167',
  'Kuala Pilah|NSN|2.7333|102.2500','Tampin|NSN|2.4667|102.2333',
  'Rembau|NSN|2.5931|102.0928','Kuala Klawang|NSN|2.9500|102.0667',
  'Senawang|NSN|2.6833|101.9667','Gemas|NSN|2.5928|102.6108',
  /* Pahang */
  'Kuantan|PHG|3.8077|103.3260|C','Temerloh|PHG|3.4500|102.4167',
  'Bentong|PHG|3.5222|101.9083','Raub|PHG|3.7936|101.8572',
  'Jerantut|PHG|3.9364|102.3625','Pekan|PHG|3.4894|103.3894',
  'Tanah Rata|PHG|4.4700|101.3800','Genting Highlands|PHG|3.4231|101.7936',
  'Kuala Lipis|PHG|4.1833|102.0500','Maran|PHG|3.5667|102.7667',
  'Rompin|PHG|2.8000|103.4667','Cherating|PHG|4.1264|103.3908',
  'Fraser Hill|PHG|3.7167|101.7333','Muadzam Shah|PHG|3.0500|103.0833',
  'Gambang|PHG|3.7167|103.1167','Brinchang|PHG|4.5122|101.3869',
  /* Perak */
  'Ipoh|PRK|4.5975|101.0901|C','Taiping|PRK|4.8500|100.7333',
  'Teluk Intan|PRK|4.0233|101.0208','Sitiawan|PRK|4.2167|100.7000',
  'Lumut|PRK|4.2333|100.6333','Kuala Kangsar|PRK|4.7667|100.9333',
  'Batu Gajah|PRK|4.4667|101.0333','Parit Buntar|PRK|5.1264|100.4931',
  'Kampar|PRK|4.3000|101.1500','Tapah|PRK|4.2000|101.2667',
  'Bagan Serai|PRK|5.0167|100.5333','Gerik|PRK|5.4269|101.1319',
  'Tanjung Malim|PRK|3.6833|101.5167','Slim River|PRK|3.8167|101.4000',
  'Pangkor|PRK|4.2167|100.5500','Sungai Siput|PRK|4.8167|101.0667',
  'Bidor|PRK|4.1167|101.2833','Ayer Tawar|PRK|4.3167|100.7500',
  /* Perlis */
  'Kangar|PLS|6.4414|100.1986|C','Arau|PLS|6.4333|100.2667',
  'Padang Besar|PLS|6.6572|100.3200','Kuala Perlis|PLS|6.4000|100.1333',
  /* Pulau Pinang */
  'George Town|PNG|5.4141|100.3288|C','Butterworth|PNG|5.3991|100.3638',
  'Bayan Lepas|PNG|5.2945|100.2782','Bukit Mertajam|PNG|5.3639|100.4667',
  'Nibong Tebal|PNG|5.1667|100.4833','Balik Pulau|PNG|5.3500|100.2333',
  'Tanjung Bungah|PNG|5.4667|100.2833','Batu Ferringhi|PNG|5.4722|100.2472',
  'Seberang Jaya|PNG|5.3894|100.3939','Air Itam|PNG|5.4000|100.2833',
  'Gelugor|PNG|5.3667|100.3000',
  /* Sabah */
  'Kota Kinabalu|SBH|5.9804|116.0735|C','Sandakan|SBH|5.8402|118.1179',
  'Tawau|SBH|4.2448|117.8912','Lahad Datu|SBH|5.0269|118.3269',
  'Keningau|SBH|5.3378|116.1608','Kudat|SBH|6.8833|116.8333',
  'Semporna|SBH|4.4817|118.6108','Beaufort|SBH|5.3500|115.7500',
  'Papar|SBH|5.7333|115.9333','Ranau|SBH|5.9500|116.6667',
  'Kota Belud|SBH|6.3500|116.4333','Tuaran|SBH|6.1833|116.2333',
  'Penampang|SBH|5.9167|116.1000','Kinabatangan|SBH|5.5167|118.0333',
  'Kunak|SBH|4.7000|118.2500','Beluran|SBH|5.7667|117.5333',
  'Sipitang|SBH|5.0833|115.5500','Tenom|SBH|5.1333|115.9500',
  'Kundasang|SBH|5.9833|116.5833','Tambunan|SBH|5.6667|116.3667',
  /* Sarawak */
  'Kuching|SWK|1.5533|110.3592|C','Miri|SWK|4.3995|113.9914',
  'Sibu|SWK|2.2870|111.8305','Bintulu|SWK|3.1667|113.0333',
  'Limbang|SWK|4.7500|115.0000','Sarikei|SWK|2.1167|111.5167',
  'Sri Aman|SWK|1.2372|111.4622','Kapit|SWK|2.0167|112.9333',
  'Mukah|SWK|2.8964|112.0900','Betong|SWK|1.4000|111.5333',
  'Serian|SWK|1.1667|110.5667','Bau|SWK|1.4167|110.1500',
  'Lawas|SWK|4.8500|115.4000','Marudi|SWK|4.1833|114.3167',
  'Kota Samarahan|SWK|1.4667|110.4333','Bario|SWK|3.7500|115.4667',
  'Lundu|SWK|1.6667|109.8500',
  /* Selangor */
  'Shah Alam|SGR|3.0733|101.5185|C','Petaling Jaya|SGR|3.1073|101.6067',
  'Subang Jaya|SGR|3.0567|101.5851','Klang|SGR|3.0449|101.4455',
  'Kajang|SGR|2.9927|101.7909','Ampang|SGR|3.1500|101.7667',
  'Puchong|SGR|3.0319|101.6169','Cyberjaya|SGR|2.9213|101.6559',
  'Rawang|SGR|3.3212|101.5769','Sepang|SGR|2.6900|101.7500',
  'Banting|SGR|2.8167|101.5000','Kuala Selangor|SGR|3.3400|101.2500',
  'Sabak Bernam|SGR|3.7667|100.9833','Semenyih|SGR|2.9500|101.8500',
  'Bandar Baru Bangi|SGR|2.9333|101.7667','Seri Kembangan|SGR|3.0167|101.7000',
  'Selayang|SGR|3.2500|101.6500','Gombak|SGR|3.2500|101.7000',
  'Sungai Buloh|SGR|3.2000|101.5667','Hulu Langat|SGR|3.1500|101.8500',
  'Batang Kali|SGR|3.4667|101.6333','Port Klang|SGR|3.0000|101.4000',
  'Sekinchan|SGR|3.5000|101.1000','Kuala Kubu Bharu|SGR|3.5667|101.6500',
  'Damansara|SGR|3.1478|101.5906','Bukit Jelutong|SGR|3.1000|101.5333',
  /* Terengganu */
  'Kuala Terengganu|TRG|5.3302|103.1408|C','Chukai|TRG|4.2333|103.4333',
  'Kemaman|TRG|4.2333|103.4167','Dungun|TRG|4.7833|103.4167',
  'Marang|TRG|5.2000|103.2000','Jerteh|TRG|5.7500|102.5000',
  'Setiu|TRG|5.5000|102.9000','Kuala Berang|TRG|5.0667|102.9000',
  'Paka|TRG|4.6333|103.4333','Kerteh|TRG|4.5167|103.4500',
  'Redang|TRG|5.7833|103.0167','Ajil|TRG|5.0833|103.0333',
  /* W.P. Kuala Lumpur */
  'Kuala Lumpur|KUL|3.1390|101.6869|C','Bukit Bintang|KUL|3.1465|101.7107',
  'KLCC|KUL|3.1578|101.7117','Cheras|KUL|3.1000|101.7500',
  'Setapak|KUL|3.2000|101.7167','Kepong|KUL|3.2167|101.6333',
  'Bangsar|KUL|3.1300|101.6700','Mont Kiara|KUL|3.1667|101.6500',
  'Sentul|KUL|3.1833|101.6833','Wangsa Maju|KUL|3.2000|101.7333',
  'Titiwangsa|KUL|3.1750|101.7000','Seputeh|KUL|3.1167|101.6833',
  'Sri Petaling|KUL|3.0667|101.6833','Bukit Jalil|KUL|3.0500|101.6833',
  'Setiawangsa|KUL|3.1833|101.7333',
  /* W.P. Putrajaya & Labuan */
  'Putrajaya|PJY|2.9264|101.6964|C','Presint 9|PJY|2.9450|101.6800',
  'Victoria|LBN|5.2767|115.2417|C','Labuan|LBN|5.2831|115.2308'
].join(';');

/** Parsed once at module load into an array of place objects. */
const MY_PLACES = MY_PLACES_RAW.split(';').map((row) => {
  const [name, code, lat, lon, cap] = row.split('|');
  return {
    name,
    stateCode: code,
    state: MY_STATES[code],
    country: 'MY',
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    capital: cap === 'C',
    /* Pre-lowercased once so the search loop never allocates a new string. */
    _key: (name + ' ' + MY_STATES[code]).toLowerCase()
  };
});

const MY_CAPITALS = MY_PLACES.filter((p) => p.capital);

/* ═══════════════════════════════════════════════════════════════════════════
 * 03 · UTILITIES
 * ═══════════════════════════════════════════════════════════════════════════ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Create an element. `props` maps to properties (className, textContent…),
 * `attrs` to real attributes. Text always goes through textContent, never
 * innerHTML — that single rule makes the app immune to injection from API
 * responses and from anything a user types into the search box.
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'dataset') { Object.assign(node.dataset, v); }
    else if (k === 'attrs') { for (const [a, b] of Object.entries(v)) node.setAttribute(a, b); }
    else node[k] = v;
  }
  for (const c of [].concat(children)) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** An <svg><use href="#id"> node — the only way icons enter the DOM. */
function icon(id, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', id.startsWith('wx-') ? '0 0 64 64' : '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, d = 0) => { const f = 10 ** d; return Math.round(n * f) / f; };

/** Debounce: collapse a burst of calls into the last one after `wait` ms. */
function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/** Throttle by animation frame — used for resize-driven canvas redraws. */
function rafThrottle(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}

/** Great-circle distance in km — ranks search results by proximity. */
function haversine(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Percentile of an unsorted numeric array (linear interpolation). */
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/* ── Formatting ───────────────────────────────────────────────────────────── */

const fmt = {
  /** Temperature. OWM already returns the right unit; we only shape it. */
  temp: (v, withUnit = false) =>
    v === null || v === undefined || Number.isNaN(v)
      ? '--°'
      : `${Math.round(v)}°${withUnit ? (state.units === 'imperial' ? 'F' : 'C') : ''}`,

  /** OWM gives m/s for metric and mph for imperial. Malaysians read km/h. */
  wind(v) {
    if (v === null || v === undefined) return '--';
    return state.units === 'imperial'
      ? `${round(v, 1)} mph`
      : `${round(v * 3.6, 1)} km/h`;
  },

  /** 16-point compass rose from a meteorological bearing. */
  bearing(deg) {
    if (deg === null || deg === undefined) return '—';
    const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return `${pts[Math.round(deg / 22.5) % 16]} · ${Math.round(deg)}°`;
  },

  /** Render a UTC timestamp in the *target city's* local time, not the user's. */
  clock(unixSeconds, tzOffsetSeconds, opts = {}) {
    const d = new Date((unixSeconds + tzOffsetSeconds) * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    if (opts.withDay) {
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return `${days[d.getUTCDay()]} ${hh}:${mm}`;
    }
    return `${hh}:${mm}`;
  },

  dayName: (unixSeconds, tzOffsetSeconds, long = false) => {
    const d = new Date((unixSeconds + tzOffsetSeconds) * 1000);
    const short = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const full  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return (long ? full : short)[d.getUTCDay()];
  },

  dayDate: (unixSeconds, tzOffsetSeconds) => {
    const d = new Date((unixSeconds + tzOffsetSeconds) * 1000);
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getUTCDate()} ${mon[d.getUTCMonth()]}`;
  },

  ms: (v) => (v === null || v === undefined ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${round(v / 1000, 2)} s`),

  relative(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },

  bytes: (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${round(n / 1024, 1)} KB` : `${round(n / 1048576, 2)} MB`),

  coords: (lat, lon) => `${round(lat, 4)}, ${round(lon, 4)}`
};

/** Dew point via the Magnus-Tetens approximation (input/output in °C). */
function dewPointC(tempC, rh) {
  const a = 17.27, b = 237.7;
  const alpha = ((a * tempC) / (b + tempC)) + Math.log(clamp(rh, 1, 100) / 100);
  return (b * alpha) / (a - alpha);
}

/** Malaysia is humid; this label is what people actually care about. */
function comfortLabel(dewC) {
  if (dewC < 13) return 'Dry and pleasant';
  if (dewC < 16) return 'Comfortable';
  if (dewC < 18) return 'Slightly humid';
  if (dewC < 21) return 'Humid';
  if (dewC < 24) return 'Very humid';
  return 'Oppressive — stay hydrated';
}

/* ── Toast notifications ──────────────────────────────────────────────────── */

function toast(message, type = 'info', ms = 4200) {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { className: 'toast', dataset: { type } }, [message]);
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }, ms);
}

function setStatus(text) {
  const n = $('#foot-status');
  if (n) n.textContent = text;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 04 · TELEMETRY
 * ---------------------------------------------------------------------------
 * Entirely local. Nothing is transmitted anywhere — the Analytics tab reads
 * from this object, and "Export JSON" hands the raw data back to the user.
 * ═══════════════════════════════════════════════════════════════════════════ */

const Telemetry = {
  enabled: true,
  latencies: [],            // { t, ms, endpoint, ok }
  counts: { req: 0, err: 0, hit: 0, miss: 0, bytesSaved: 0 },
  places: Object.create(null),
  log: [],
  vitals: { lcp: null, cls: 0, inp: null, ttfb: null },

  record(kind, detail = {}) {
    if (!this.enabled) return;
    this.log.push({ t: Date.now(), kind, ...detail });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    /* The analytics view is weather analysis now; telemetry only feeds the
       collapsed diagnostics panel, which is painted when that view opens. */
  },

  timing(endpoint, ms, ok) {
    this.latencies.push({ t: Date.now(), ms, endpoint, ok });
    if (this.latencies.length > 200) this.latencies.shift();
    this.counts.req += 1;
    if (!ok) this.counts.err += 1;
    this.record('fetch', { lvl: ok ? 'perf' : 'error', msg: `${endpoint} — ${fmt.ms(ms)}` });
  },

  cache(hit, approxBytes = 0) {
    if (hit) { this.counts.hit += 1; this.counts.bytesSaved += approxBytes; }
    else this.counts.miss += 1;
  },

  place(name) {
    this.places[name] = (this.places[name] || 0) + 1;
  },

  snapshot() {
    const ms = this.latencies.map((l) => l.ms);
    return {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      vitals: this.vitals,
      requests: this.counts,
      latency: {
        p50: percentile(ms, 0.5), p95: percentile(ms, 0.95),
        max: ms.length ? Math.max(...ms) : null, samples: ms.length
      },
      places: this.places,
      log: this.log
    };
  },

  save() {
    if (!this.enabled) return;
    try {
      localStorage.setItem(LS.analytics, JSON.stringify({
        places: this.places, counts: this.counts
      }));
    } catch { /* private mode or quota exceeded — analytics are expendable */ }
  },

  restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS.analytics) || '{}');
      if (raw.places) this.places = raw.places;
      if (raw.counts) Object.assign(this.counts, raw.counts);
    } catch { /* ignore malformed payloads */ }
  },

  reset() {
    this.latencies = []; this.log = []; this.places = Object.create(null);
    this.counts = { req: 0, err: 0, hit: 0, miss: 0, bytesSaved: 0 };
    try { localStorage.removeItem(LS.analytics); } catch { /* noop */ }
  }
};

/**
 * Core Web Vitals, straight from PerformanceObserver — no analytics vendor.
 * Each observer is wrapped in its own try/catch because entry types are
 * supported unevenly across browsers, and an unsupported type throws.
 */
function observeVitals() {
  // TTFB comes from the navigation timing entry, available immediately.
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) Telemetry.vitals.ttfb = nav.responseStart;
  } catch { /* noop */ }

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      Telemetry.vitals.lcp = entries[entries.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* noop */ }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Shifts the user caused (by scrolling, clicking) are not penalised.
        if (!entry.hadRecentInput) Telemetry.vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* noop */ }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const d = entry.duration;
        if (Telemetry.vitals.inp === null || d > Telemetry.vitals.inp) Telemetry.vitals.inp = d;
      }
    }).observe({ type: 'event', durationThreshold: 40, buffered: true });
  } catch { /* noop */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 05 · HTTP LAYER — how the fetch API is used here
 * ---------------------------------------------------------------------------
 * `fetch(url, options)` returns a Promise that resolves with a Response object
 * as soon as the *headers* arrive. Two consequences trip people up constantly:
 *
 *   1. The Promise resolves for 404 and 500 as well. `fetch` only rejects on a
 *      genuine network failure (DNS, TLS, offline, CORS block). You must check
 *      `response.ok` (true for status 200-299) and throw yourself.
 *
 *   2. The body has not been downloaded yet. Reading it is a second async step:
 *      `await response.json()`, which itself returns a Promise and rejects if
 *      the payload is not valid JSON.
 *
 * On top of the raw call this layer adds four things a production dashboard
 * needs, none of which fetch gives you for free:
 *
 *   • a timeout, via AbortController (fetch has no timeout option at all);
 *   • retries with exponential backoff for transient 5xx / network errors;
 *   • in-flight de-duplication, so ten cards asking for the same URL make one
 *     request and share one Promise;
 *   • stale-while-revalidate caching in memory + localStorage, so revisiting a
 *      city paints instantly and refreshes in the background.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** URLs currently in flight, keyed by URL → Promise. */
const inflight = new Map();

/** Two-tier response cache: a Map for this page load, localStorage across loads. */
const memCache = new Map();

const CachePolicy = {
  read(key) {
    const hit = memCache.get(key);
    if (hit) return hit;
    try {
      const raw = localStorage.getItem('cuacamy.cache.' + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      memCache.set(key, parsed);
      return parsed;
    } catch { return null; }
  },

  write(key, data, bytes) {
    const entry = { data, at: Date.now(), bytes };
    memCache.set(key, entry);
    try {
      localStorage.setItem('cuacamy.cache.' + key, JSON.stringify(entry));
    } catch {
      // Quota exceeded: drop the oldest third of cached responses and move on.
      this.evict();
    }
  },

  evict() {
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith('cuacamy.cache.'));
      keys.slice(0, Math.ceil(keys.length / 3)).forEach((k) => localStorage.removeItem(k));
    } catch { /* noop */ }
  },

  clear() {
    memCache.clear();
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('cuacamy.cache.'))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* noop */ }
  }
};

/**
 * One network request, with a hard timeout.
 *
 * AbortController is the standard way to cancel a fetch: you pass its `signal`
 * into the request and call `abort()` to tear the request down. A timer does
 * the calling, so a request that hangs cannot wedge the UI forever.
 */
async function fetchWithTimeout(url, { timeout = 9000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    // Always clear the timer, whether the request resolved or threw, so a
    // successful early response cannot fire a stray abort later on.
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON with retry + backoff.
 *
 * Retries are limited to failures that are plausibly transient: network errors
 * and 5xx / 429 responses. A 401 (bad API key) or 404 (unknown city) is a
 * permanent answer — retrying it just wastes the user's quota.
 */
async function fetchJSON(url, { retries = 2, timeout = 9000, label = 'api' } = {}) {
  const started = performance.now();
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { timeout, headers: { Accept: 'application/json' } });

      // Permanent client errors: surface immediately, do not retry.
      if (response.status === 401) throw new ApiError('Invalid or missing API key.', 401);
      if (response.status === 404) throw new ApiError('Location not found.', 404);

      // Transient: retry unless we are out of attempts.
      if (!response.ok) {
        if ((response.status >= 500 || response.status === 429) && attempt < retries) {
          await sleep(400 * 2 ** attempt + Math.random() * 200); // full jitter
          continue;
        }
        throw new ApiError(`Request failed with status ${response.status}.`, response.status);
      }

      // Headers arrived; now stream and parse the body.
      const text = await response.text();
      const bytes = text.length;
      let data;
      try { data = JSON.parse(text); }
      catch { throw new ApiError('The server returned a malformed response.', 0); }

      Telemetry.timing(label, performance.now() - started, true);
      return { data, bytes };
    } catch (err) {
      lastError = err;

      // AbortError means our own timeout fired.
      if (err.name === 'AbortError') lastError = new ApiError('The request timed out.', 0);

      // Permanent errors short-circuit the retry loop.
      if (err instanceof ApiError && [401, 404].includes(err.status)) break;

      if (attempt < retries) {
        await sleep(400 * 2 ** attempt + Math.random() * 200);
        continue;
      }
    }
  }

  Telemetry.timing(label, performance.now() - started, false);
  throw lastError instanceof ApiError
    ? lastError
    : new ApiError(navigator.onLine ? 'Could not reach the weather service.' : 'You appear to be offline.', 0);
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The function the rest of the app actually calls.
 *
 * Stale-while-revalidate: if a cached copy exists and is still inside its TTL,
 * return it immediately (zero latency). If it exists but is stale, still return
 * it right away *and* kick off a background refresh, so the user sees numbers
 * instantly and correct numbers a moment later.
 */
async function request(url, { ttl, label, cacheKey, onRefresh } = {}) {
  const key = cacheKey || url;
  const cached = CachePolicy.read(key);
  const fresh = cached && Date.now() - cached.at < ttl;

  if (cached) {
    Telemetry.cache(true, cached.bytes || 0);
    if (!fresh && navigator.onLine) {
      // Revalidate in the background. Errors here are deliberately silent —
      // the user already has usable data on screen.
      dedupe(key, url, ttl, label)
        .then((next) => { if (onRefresh) onRefresh(next); })
        .catch(() => { /* keep showing the stale copy */ });
    }
    return { data: cached.data, stale: !fresh, fromCache: true };
  }

  Telemetry.cache(false);
  const data = await dedupe(key, url, ttl, label);
  return { data, stale: false, fromCache: false };
}

/** Collapse concurrent requests for the same URL into a single fetch. */
function dedupe(key, url, ttl, label) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fetchJSON(url, { label })
    .then(({ data, bytes }) => { CachePolicy.write(key, data, bytes); return data; })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 06 · OPENWEATHERMAP CLIENT
 * ---------------------------------------------------------------------------
 * Only endpoints on OpenWeatherMap's free tier are used, so a brand-new key
 * works straight away:
 *   /data/2.5/weather        current conditions
 *   /data/2.5/forecast       3-hourly forecast, 5 days (40 slots)
 *   /data/2.5/air_pollution  AQI + pollutant concentrations
 *   /geo/1.0/direct          city name  → coordinates
 *   /geo/1.0/reverse         coordinates → city name
 * ═══════════════════════════════════════════════════════════════════════════ */

function apiKey() {
  return CONFIG.openWeatherKey || safeLocal.get(LS.apiKey) || '';
}

const hasKey = () => Boolean(apiKey());

/** Build an OWM URL with the shared query parameters applied. */
function owmURL(path, params = {}) {
  const url = new URL(OWM.base + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('appid', apiKey());
  return url.toString();
}

/**
 * Demo responses take the same road as real ones: same cache keys, same TTLs,
 * same telemetry. That keeps the caching and analytics behaviour identical
 * whether or not a key is configured — so the public demo shows a live
 * Analytics tab rather than a table of zeroes.
 */
function demoRequest(cacheKey, ttl, label, produce) {
  const cached = CachePolicy.read(cacheKey);
  if (cached && Date.now() - cached.at < ttl) {
    Telemetry.cache(true, cached.bytes || 0);
    return { data: cached.data, stale: false, fromCache: true, demo: true };
  }
  Telemetry.cache(false);
  const started = performance.now();
  const { data } = produce();
  const bytes = JSON.stringify(data).length;
  CachePolicy.write(cacheKey, data, bytes);
  Telemetry.timing(label + ' (demo)', performance.now() - started, true);
  return { data, stale: false, fromCache: false, demo: true };
}

/**
 * Which provider serves a request.
 *   'auto'        OpenWeatherMap when a key exists, otherwise Open-Meteo
 *   'open-meteo'  always keyless
 *   'owm'         always OpenWeatherMap (falls back if no key)
 */
function provider() {
  if (state.provider === 'open-meteo') return 'open-meteo';
  if (state.provider === 'owm' && hasKey()) return 'owm';
  return hasKey() ? 'owm' : 'open-meteo';
}

const Api = {
  /**
   * Open-Meteo answers current conditions, the hourly series and the daily
   * series in one response. current() and forecast() therefore request the
   * same URL, and the in-flight de-duplication in request() collapses them
   * into a single network call rather than two.
   */
  async current(lat, lon, units) {
    const key = `w:${round(lat, 2)}:${round(lon, 2)}:${units}`;
    try {
      if (provider() === 'open-meteo') {
        const res = await OpenMeteo.bundle(lat, lon, units);
        const { current } = OpenMeteo.normalise(res.data, lat, lon);
        return { ...res, data: current };
      }
      const url = owmURL(OWM.weather, { lat: round(lat, 4), lon: round(lon, 4), units });
      return await request(url, { ttl: TTL.weather, label: 'weather', cacheKey: key });
    } catch (err) {
      return this.fallback(err, key, TTL.weather, 'weather', () => Demo.current(lat, lon, units));
    }
  },

  async forecast(lat, lon, units) {
    const key = `f:${round(lat, 2)}:${round(lon, 2)}:${units}`;
    try {
      if (provider() === 'open-meteo') {
        const res = await OpenMeteo.bundle(lat, lon, units);
        const { forecast } = OpenMeteo.normalise(res.data, lat, lon);
        return { ...res, data: forecast };
      }
      const url = owmURL(OWM.forecast, { lat: round(lat, 4), lon: round(lon, 4), units });
      return await request(url, { ttl: TTL.forecast, label: 'forecast', cacheKey: key });
    } catch (err) {
      return this.fallback(err, key, TTL.forecast, 'forecast', () => Demo.forecast(lat, lon, units));
    }
  },

  async air(lat, lon) {
    const key = `a:${round(lat, 2)}:${round(lon, 2)}`;
    try {
      if (provider() === 'open-meteo') return await OpenMeteo.air(lat, lon);
      const url = owmURL(OWM.air, { lat: round(lat, 4), lon: round(lon, 4) });
      return await request(url, { ttl: TTL.air, label: 'air', cacheKey: key });
    } catch (err) {
      return this.fallback(err, key, TTL.air, 'air', () => Demo.air(lat, lon));
    }
  },

  /**
   * Last line of defence. A provider outage or a dead connection must not
   * leave an empty dashboard, so the bundled synthetic model takes over and
   * the UI labels it clearly as demo data.
   */
  fallback(err, cacheKey, ttl, label, produce) {
    Telemetry.record('provider', { lvl: 'warn', msg: `${label} failed (${err.message}); using bundled data` });
    return demoRequest(cacheKey + ':demo', ttl, label, produce);
  },

  /** Geocode free text. Open-Meteo needs no key, so it is tried first. */
  async geocode(query, limit = 6) {
    try {
      const results = await OpenMeteo.geocode(query, limit);
      if (results.length || !hasKey()) return results;
    } catch {
      if (!hasKey()) return [];
    }
    const url = owmURL(OWM.geoDirect, { q: query, limit });
    const { data } = await request(url, {
      ttl: TTL.geo, label: 'geocode', cacheKey: `g:${query.toLowerCase()}:${limit}`
    });
    return (Array.isArray(data) ? data : []).map((r) => ({
      name: r.name, state: r.state || '', country: r.country,
      lat: r.lat, lon: r.lon, source: 'owm'
    }));
  },

  /**
   * Coordinates -> place name, in order of confidence:
   *   1. the bundled Malaysian gazetteer, if a town is within 25 km — instant,
   *      works offline, and names the place the way a Malaysian would;
   *   2. BigDataCloud's keyless reverse geocoder, for everywhere else;
   *   3. OpenWeatherMap's reverse endpoint, when a key is configured;
   *   4. the raw coordinates, so the dashboard still loads.
   */
  async reverse(lat, lon) {
    const local = nearestLocalPlace(lat, lon, 25);
    if (local) return local;

    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${round(lat, 4)}&longitude=${round(lon, 4)}&localityLanguage=en`;
      const { data } = await request(url, {
        ttl: TTL.geo, label: 'reverse', cacheKey: `r:${round(lat, 3)}:${round(lon, 3)}`
      });
      const name = data.city || data.locality || data.principalSubdivision;
      if (name) {
        return { name, state: data.principalSubdivision || '', country: data.countryCode || '', lat, lon };
      }
    } catch { /* fall through */ }

    if (hasKey()) {
      try {
        const url = owmURL(OWM.geoReverse, { lat: round(lat, 4), lon: round(lon, 4), limit: 1 });
        const { data } = await request(url, {
          ttl: TTL.geo, label: 'reverse-owm', cacheKey: `ro:${round(lat, 3)}:${round(lon, 3)}`
        });
        const r = Array.isArray(data) && data[0];
        if (r) return { name: r.name, state: r.state || '', country: r.country, lat, lon };
      } catch { /* fall through */ }
    }

    return nearestLocalPlace(lat, lon, Infinity)
        || { name: 'Your location', state: '', country: '', lat, lon };
  }
};

/**
 * Closest bundled Malaysian place within `maxKm`, or null if nothing is near.
 * This is what makes "find me" work with no network at all inside Malaysia.
 */
function nearestLocalPlace(lat, lon, maxKm = 60) {
  let best = null, bestD = Infinity;
  for (const p of MY_PLACES) {
    const d = haversine({ lat, lon }, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best || bestD > maxKm) return null;
  return { name: best.name, state: best.state, country: 'MY', lat, lon, distanceKm: bestD };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 06B · OPEN-METEO — the keyless default provider
 * ---------------------------------------------------------------------------
 * OpenWeatherMap needs an API key, which means a visitor to a public
 * deployment would see nothing until the owner signs up. Open-Meteo needs no
 * key, no sign-up, and sends `Access-Control-Allow-Origin: *`, so it can be
 * called straight from the browser. It is therefore the default here, and
 * OpenWeatherMap becomes an opt-in alternative for anyone who has a key.
 *
 * Every response is normalised into the same internal shape the renderers
 * already consume, so no view code cares which provider produced the data.
 *
 * Endpoints (all verified by tools/api-contract.mjs on every CI run):
 *   api.open-meteo.com/v1/forecast              current + hourly + daily
 *   air-quality-api.open-meteo.com/v1/air-quality  pollutants
 *   geocoding-api.open-meteo.com/v1/search      place name -> coordinates
 *   flood-api.open-meteo.com/v1/flood           GloFAS river discharge
 *   archive-api.open-meteo.com/v1/archive       reanalysis back to 1940
 * ═══════════════════════════════════════════════════════════════════════════ */

const OM = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  air:      'https://air-quality-api.open-meteo.com/v1/air-quality',
  geo:      'https://geocoding-api.open-meteo.com/v1/search',
  reverse:  'https://geocoding-api.open-meteo.com/v1/search',
  flood:    'https://flood-api.open-meteo.com/v1/flood',
  archive:  'https://archive-api.open-meteo.com/v1/archive'
};

/**
 * WMO weather interpretation codes -> the OpenWeatherMap condition vocabulary.
 *
 * Mapping into the shape the app already speaks means the icon table, the
 * forecast aggregation and every template keep working untouched, whichever
 * provider is in use.
 */
const WMO = {
  0:  [800, 'Clear',        'clear sky'],
  1:  [801, 'Clouds',       'mainly clear'],
  2:  [802, 'Clouds',       'partly cloudy'],
  3:  [804, 'Clouds',       'overcast'],
  45: [741, 'Fog',          'fog'],
  48: [741, 'Fog',          'depositing rime fog'],
  51: [300, 'Drizzle',      'light drizzle'],
  53: [301, 'Drizzle',      'moderate drizzle'],
  55: [302, 'Drizzle',      'dense drizzle'],
  56: [511, 'Drizzle',      'light freezing drizzle'],
  57: [511, 'Drizzle',      'dense freezing drizzle'],
  61: [500, 'Rain',         'slight rain'],
  63: [501, 'Rain',         'moderate rain'],
  65: [502, 'Rain',         'heavy rain'],
  66: [511, 'Rain',         'light freezing rain'],
  67: [511, 'Rain',         'heavy freezing rain'],
  71: [600, 'Snow',         'slight snowfall'],
  73: [601, 'Snow',         'moderate snowfall'],
  75: [602, 'Snow',         'heavy snowfall'],
  77: [601, 'Snow',         'snow grains'],
  80: [520, 'Rain',         'slight rain showers'],
  81: [521, 'Rain',         'moderate rain showers'],
  82: [522, 'Rain',         'violent rain showers'],
  85: [620, 'Snow',         'slight snow showers'],
  86: [622, 'Snow',         'heavy snow showers'],
  95: [200, 'Thunderstorm', 'thunderstorm'],
  96: [201, 'Thunderstorm', 'thunderstorm with slight hail'],
  99: [202, 'Thunderstorm', 'thunderstorm with heavy hail']
};

const wmo = (code) => {
  const [id, main, description] = WMO[code] || [804, 'Clouds', 'cloudy'];
  return { id, main, description };
};

/**
 * Open-Meteo returns local wall-clock strings ("2026-08-25T07:03") together
 * with the location's `utc_offset_seconds`. Appending Z parses the string as
 * if it were UTC; subtracting the offset then recovers the true instant.
 */
const omTime = (isoLocal, offsetSeconds) =>
  Math.round(Date.parse(isoLocal + 'Z') / 1000) - offsetSeconds;

const OpenMeteo = {
  /** Shared query parameters. Units are chosen to match OpenWeatherMap's. */
  units(units) {
    return units === 'imperial'
      ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' }
      : { temperature_unit: 'celsius',    wind_speed_unit: 'ms',  precipitation_unit: 'mm' };
  },

  url(base, params) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    return url.toString();
  },

  /**
   * One request covers current conditions, the hourly series and the daily
   * series — so the dashboard's three panels cost a single round-trip instead
   * of three, which is why this provider feels faster than the OWM path.
   */
  async bundle(lat, lon, units) {
    const url = this.url(OM.forecast, {
      latitude: round(lat, 4),
      longitude: round(lon, 4),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,' +
               'weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
      hourly: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,' +
              'precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility,uv_index',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,' +
             'precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max',
      timezone: 'auto',
      forecast_days: 7,
      ...this.units(units)
    });
    return request(url, {
      ttl: TTL.weather,
      label: 'open-meteo',
      cacheKey: `om:${round(lat, 2)}:${round(lon, 2)}:${units}`
    });
  },

  /** Normalise the bundle into the OpenWeatherMap-shaped payloads the UI reads. */
  normalise(raw, lat, lon) {
    const tz = raw.utc_offset_seconds ?? 0;
    const c = raw.current || {};
    const h = raw.hourly || {};
    const d = raw.daily || {};

    const nowIso = c.time;
    // Visibility and UV live only on the hourly series, so find the row that
    // matches the current timestamp rather than assuming index 0.
    const hIndex = Math.max(0, (h.time || []).indexOf(nowIso));

    const current = {
      coord: { lat, lon },
      weather: [wmo(c.weather_code)],
      main: {
        temp: c.temperature_2m,
        feels_like: c.apparent_temperature,
        temp_min: d.temperature_2m_min?.[0],
        temp_max: d.temperature_2m_max?.[0],
        pressure: Math.round(c.pressure_msl ?? 1010),
        humidity: c.relative_humidity_2m
      },
      visibility: h.visibility?.[hIndex] ?? null,
      wind: { speed: c.wind_speed_10m, deg: c.wind_direction_10m, gust: c.wind_gusts_10m },
      clouds: { all: c.cloud_cover },
      dt: nowIso ? omTime(nowIso, tz) : Math.floor(Date.now() / 1000),
      sys: {
        sunrise: d.sunrise?.[0] ? omTime(d.sunrise[0], tz) : null,
        sunset:  d.sunset?.[0]  ? omTime(d.sunset[0],  tz) : null
      },
      timezone: tz,
      name: '',
      uvi: h.uv_index?.[hIndex] ?? d.uv_index_max?.[0] ?? null,
      isDay: c.is_day === 1,
      provider: 'open-meteo'
    };

    // Rebuild the 3-hourly list the forecast aggregator expects. Open-Meteo is
    // hourly, so every third row is taken; nothing is interpolated.
    const list = [];
    const times = h.time || [];
    for (let i = 0; i < times.length; i += 3) {
      list.push({
        dt: omTime(times[i], tz),
        main: {
          temp: h.temperature_2m?.[i],
          feels_like: h.apparent_temperature?.[i],
          temp_min: h.temperature_2m?.[i],
          temp_max: h.temperature_2m?.[i],
          humidity: h.relative_humidity_2m?.[i],
          pressure: Math.round(c.pressure_msl ?? 1010)
        },
        weather: [wmo(h.weather_code?.[i])],
        clouds: { all: c.cloud_cover },
        wind: { speed: h.wind_speed_10m?.[i], deg: c.wind_direction_10m, gust: h.wind_gusts_10m?.[i] },
        pop: (h.precipitation_probability?.[i] ?? 0) / 100,
        rain: h.precipitation?.[i] ?? 0,
        visibility: h.visibility?.[i] ?? null,
        uvi: h.uv_index?.[i] ?? null
      });
    }

    return {
      current,
      forecast: {
        list,
        city: { timezone: tz },
        // The daily arrays are kept verbatim: the hazard engine reads real
        // daily precipitation totals from them rather than re-deriving totals
        // from 3-hourly samples, which would understate them.
        om_daily: d,
        om_hourly: h,
        om_offset: tz
      }
    };
  },

  async air(lat, lon) {
    const url = this.url(OM.air, {
      latitude: round(lat, 4),
      longitude: round(lon, 4),
      current: 'pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,european_aqi',
      hourly: 'pm2_5,pm10',
      past_days: 1,
      forecast_days: 1,
      timezone: 'auto'
    });
    const res = await request(url, {
      ttl: TTL.air, label: 'open-meteo-air', cacheKey: `oma:${round(lat, 2)}:${round(lon, 2)}`
    });
    const c = res.data.current || {};
    const h = res.data.hourly || {};

    return {
      ...res,
      data: {
        list: [{
          main: { aqi: euAqiToBand(c.european_aqi) },
          components: {
            pm2_5: c.pm2_5, pm10: c.pm10, o3: c.ozone,
            no2: c.nitrogen_dioxide, so2: c.sulphur_dioxide, co: c.carbon_monoxide
          }
        }],
        // 24-hour means are what the Malaysian index is defined on.
        pm25_24h: mean24(h.pm2_5),
        pm10_24h: mean24(h.pm10),
        us_aqi: c.us_aqi,
        provider: 'open-meteo'
      }
    };
  },

  async geocode(query, limit = 6) {
    const url = this.url(OM.geo, { name: query, count: limit, language: 'en', format: 'json' });
    const { data } = await request(url, {
      ttl: TTL.geo, label: 'open-meteo-geo', cacheKey: `omg:${query.toLowerCase()}:${limit}`
    });
    return (data.results || []).map((r) => ({
      name: r.name,
      state: r.admin1 || '',
      country: r.country_code,
      countryName: r.country,
      lat: r.latitude,
      lon: r.longitude,
      population: r.population,
      source: 'open-meteo'
    }));
  },

  /**
   * GloFAS river discharge for the nearest modelled river reach. Comparing
   * today's forecast discharge against the 92-day distribution gives a usable
   * relative flood signal without needing a gauge network.
   */
  async flood(lat, lon) {
    const url = this.url(OM.flood, {
      latitude: round(lat, 3),
      longitude: round(lon, 3),
      daily: 'river_discharge,river_discharge_mean,river_discharge_median,river_discharge_max',
      forecast_days: 92
    });
    return request(url, {
      ttl: 6 * 60 * 60 * 1000, label: 'open-meteo-flood',
      cacheKey: `omf:${round(lat, 2)}:${round(lon, 2)}`
    });
  },

  /**
   * Daily reanalysis, used to compute a real local climate normal.
   *
   * `models=era5` is pinned deliberately. Left to its default the archive
   * picks the best available model for each date range, which means a
   * thirty-year baseline comes from ERA5 at 31 km while the last few weeks
   * can come from ECMWF IFS at 9 km. Differencing those two produces an
   * anomaly that is really just a change of grid resolution — a coarse cell
   * averages in cooler surrounding terrain, a fine cell sits over the city.
   * Both sides of the comparison must come from the same model.
   */
  async archive(lat, lon, startDate, endDate) {
    const url = this.url(OM.archive, {
      latitude: round(lat, 3),
      longitude: round(lon, 3),
      start_date: startDate,
      end_date: endDate,
      daily: 'temperature_2m_mean,temperature_2m_max,precipitation_sum',
      models: 'era5',
      timezone: 'auto'
    });
    // Thirty years of daily rows is a large payload, so it bypasses the shared
    // response cache (which lives in localStorage) and is stored in IndexedDB
    // by the caller instead.
    const { data } = await fetchJSON(url, { label: 'open-meteo-archive', timeout: 45000, retries: 1 });
    return data;
  }
};

/** Mean of the trailing 24 values of an hourly series. */
function mean24(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const tail = series.slice(-24).filter((v) => typeof v === 'number');
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : null;
}

/** European AQI (0-100+) collapsed onto the 1-5 band the AQI card was built for. */
function euAqiToBand(v) {
  if (v === null || v === undefined) return null;
  if (v <= 20) return 1;
  if (v <= 40) return 2;
  if (v <= 60) return 3;
  if (v <= 80) return 4;
  return 5;
}

/* ── Malaysian Air Pollutant Index ────────────────────────────────────────────
 * Malaysia does not use the US or European AQI. The Department of Environment
 * publishes an Air Pollutant Index on a 0-500 scale, computed as a piecewise
 * linear sub-index per pollutant on a 24-hour running mean, with the highest
 * sub-index becoming the reported API.
 *
 * PM2.5 became the dominant indicator in 2020, so it and PM10 are computed
 * here. This is a modelled estimate from Open-Meteo's reanalysis, not a
 * reading from a DOE monitoring station — the UI says so.
 * ------------------------------------------------------------------------- */

const API_PM25_BREAKS = [
  [0,     12.0,   0,   50],
  [12.1,  35.4,  51,  100],
  [35.5,  55.4, 101,  200],
  [55.5, 150.4, 201,  300],
  [150.5, 250.4, 301, 400],
  [250.5, 500.4, 401, 500]
];

const API_PM10_BREAKS = [
  [0,    50,    0,   50],
  [51,  150,   51,  100],
  [151, 350,  101,  200],
  [351, 420,  201,  300],
  [421, 500,  301,  400],
  [501, 600,  401,  500]
];

function subIndex(concentration, breaks) {
  if (concentration === null || concentration === undefined || Number.isNaN(concentration)) return null;
  for (const [cLo, cHi, iLo, iHi] of breaks) {
    if (concentration <= cHi) {
      return Math.round(iLo + ((iHi - iLo) / (cHi - cLo)) * (concentration - cLo));
    }
  }
  return 500;
}

const MY_API_BANDS = [
  { max: 50,  label: 'Good',           tone: 'good',
    note: 'Low pollution with no ill effects on health.' },
  { max: 100, label: 'Moderate',       tone: 'ok',
    note: 'Moderate pollution. No ill effects for the general population.' },
  { max: 200, label: 'Unhealthy',      tone: 'warn',
    note: 'Mild aggravation for people with heart or lung conditions. Limit prolonged outdoor exertion.' },
  { max: 300, label: 'Very unhealthy', tone: 'bad',
    note: 'Significant aggravation and reduced tolerance to exercise. Avoid outdoor activity; wear a mask outdoors.' },
  { max: Infinity, label: 'Hazardous', tone: 'severe',
    note: 'Serious risk to everyone. Stay indoors, seal windows, and follow official haze advisories.' }
];

/** Returns { value, label, tone, note, driver } or null when no data. */
function malaysianAPI(pm25, pm10) {
  const s25 = subIndex(pm25, API_PM25_BREAKS);
  const s10 = subIndex(pm10, API_PM10_BREAKS);
  if (s25 === null && s10 === null) return null;
  const value = Math.max(s25 ?? 0, s10 ?? 0);
  const band = MY_API_BANDS.find((b) => value <= b.max);
  return {
    value,
    label: band.label,
    tone: band.tone,
    note: band.note,
    driver: (s25 ?? -1) >= (s10 ?? -1) ? 'PM2.5' : 'PM10'
  };
}

/* ── Demo engine ──────────────────────────────────────────────────────────────
 * With no API key the dashboard still has to look and behave like the real
 * thing — for screenshots, for offline demos, and so a recruiter clicking the
 * GitHub Pages link never sees an empty page. Values are generated from a
 * seeded PRNG keyed on the coordinates, so the same city always produces the
 * same plausible weather rather than flickering noise on every reload.
 * ------------------------------------------------------------------------- */

const Demo = {
  seedFrom(lat, lon) {
    let h = 2166136261;
    const s = `${round(lat, 2)},${round(lon, 2)}`;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  },

  /** mulberry32 — tiny, fast, deterministic. */
  rng(seed) {
    return function next() {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  /** Tropical climate model: hot, humid, afternoon convective storms. */
  profile(lat, lon, when = Date.now()) {
    const rand = this.rng(this.seedFrom(lat, lon));
    const tropical = Math.abs(lat) < 12;
    const baseC = tropical ? 27 + rand() * 4 : 22 - Math.abs(lat) * 0.35 + rand() * 6;
    const hour = new Date(when).getUTCHours() + lon / 15;
    const diurnal = Math.sin(((hour - 9) / 24) * 2 * Math.PI) * (tropical ? 3.2 : 5.5);
    const humidity = Math.round(tropical ? 72 + rand() * 20 : 55 + rand() * 30);
    const stormy = tropical && ((hour % 24) > 14 && (hour % 24) < 20) && rand() > 0.45;
    return { baseC, diurnal, humidity, stormy, rand };
  },

  toUnits: (c, units) => (units === 'imperial' ? c * 9 / 5 + 32 : c),

  current(lat, lon, units) {
    const p = this.profile(lat, lon);
    const c = p.baseC + p.diurnal;
    const id = p.stormy ? 201 : p.rand() > 0.55 ? 802 : 801;
    const now = Math.floor(Date.now() / 1000);
    const tz = Math.round(lon / 15) * 3600;
    return {
      data: {
        coord: { lat, lon },
        weather: [{ id, main: p.stormy ? 'Thunderstorm' : 'Clouds',
                    description: p.stormy ? 'thunderstorm with rain' : 'scattered clouds' }],
        main: {
          temp: this.toUnits(c, units),
          feels_like: this.toUnits(c + (p.humidity > 75 ? 3.4 : 1.1), units),
          temp_min: this.toUnits(c - 1.6, units),
          temp_max: this.toUnits(c + 1.9, units),
          pressure: 1008 + Math.round(p.rand() * 8),
          humidity: p.humidity
        },
        visibility: p.stormy ? 4000 : 10000,
        wind: { speed: units === 'imperial' ? 4 + p.rand() * 6 : 1.8 + p.rand() * 3, deg: Math.round(p.rand() * 360) },
        clouds: { all: p.stormy ? 92 : 40 + Math.round(p.rand() * 35) },
        dt: now,
        sys: { sunrise: now - ((now + tz) % 86400) + 25200, sunset: now - ((now + tz) % 86400) + 68400 },
        timezone: tz,
        name: 'Demo location',
        _demo: true
      },
      stale: false, fromCache: false, demo: true
    };
  },

  forecast(lat, lon, units) {
    const p = this.profile(lat, lon);
    const list = [];
    const start = Math.floor(Date.now() / 1000 / 10800) * 10800;
    for (let i = 0; i < 40; i += 1) {
      const t = start + i * 10800;
      const hourLocal = ((t + Math.round(lon / 15) * 3600) / 3600) % 24;
      const diurnal = Math.sin(((hourLocal - 9) / 24) * 2 * Math.PI) * 3.2;
      const r = this.rng(this.seedFrom(lat + i * 0.013, lon))();
      const storm = hourLocal > 14 && hourLocal < 20 && r > 0.5;
      const c = p.baseC + diurnal + (r - 0.5) * 1.6;
      list.push({
        dt: t,
        main: {
          temp: this.toUnits(c, units),
          feels_like: this.toUnits(c + 3, units),
          temp_min: this.toUnits(c - 1.2, units),
          temp_max: this.toUnits(c + 1.2, units),
          humidity: Math.round(p.humidity + (r - 0.5) * 10),
          pressure: 1009
        },
        weather: [{ id: storm ? 201 : r > 0.6 ? 500 : 802,
                    main: storm ? 'Thunderstorm' : r > 0.6 ? 'Rain' : 'Clouds',
                    description: storm ? 'thunderstorm' : r > 0.6 ? 'light rain' : 'scattered clouds' }],
        clouds: { all: storm ? 90 : 45 },
        wind: { speed: units === 'imperial' ? 5 + r * 5 : 2 + r * 2.4, deg: Math.round(r * 360) },
        pop: storm ? 0.7 + r * 0.25 : r * 0.4,
        // Rainfall has to track the probability, or the offline estimate
        // reports an 85% chance of rain alongside a 0 mm total.
        rain: storm ? round(8 + r * 22, 1) : r > 0.6 ? round(r * 6, 1) : 0,
        visibility: storm ? 4000 : 10000
      });
    }
    return { data: { list, city: { timezone: Math.round(lon / 15) * 3600 }, _demo: true },
             stale: false, fromCache: false, demo: true };
  },

  air(lat, lon) {
    const r = this.rng(this.seedFrom(lat, lon));
    const aqi = 1 + Math.floor(r() * 3);
    return {
      data: { list: [{ main: { aqi }, components: {
        pm2_5: round(6 + r() * 28, 1), pm10: round(12 + r() * 40, 1),
        o3: round(20 + r() * 60, 1), no2: round(4 + r() * 26, 1),
        so2: round(1 + r() * 9, 1), co: round(180 + r() * 400, 1)
      } }], _demo: true },
      stale: false, fromCache: false, demo: true
    };
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 07 · ICON MAPPING
 * ---------------------------------------------------------------------------
 * OpenWeatherMap condition IDs are grouped by hundreds:
 *   2xx thunderstorm · 3xx drizzle · 5xx rain · 6xx snow
 *   7xx atmosphere (mist, haze, smoke) · 800 clear · 80x clouds
 * ═══════════════════════════════════════════════════════════════════════════ */

function iconFor(conditionId, isDay = true) {
  const g = Math.floor(conditionId / 100);
  if (g === 2) return 'wx-thunder';
  if (g === 3) return 'wx-showers';
  if (g === 5) return conditionId >= 502 ? 'wx-showers' : 'wx-rain';
  if (g === 6) return 'wx-snow';
  if (g === 7) return 'wx-mist';
  if (conditionId === 800) return isDay ? 'wx-clear-day' : 'wx-clear-night';
  if (conditionId === 801 || conditionId === 802) return isDay ? 'wx-partly-day' : 'wx-partly-night';
  if (conditionId === 803) return 'wx-cloudy';
  return 'wx-overcast';
}

/** Is it daytime at the observed location? Falls back to the local clock. */
function isDaytime(dt, sunrise, sunset) {
  if (sunrise && sunset) return dt >= sunrise && dt < sunset;
  const h = new Date(dt * 1000).getUTCHours();
  return h >= 6 && h < 18;
}

const AQI_SCALE = [
  null,
  { label: 'Good',      note: 'Air quality is satisfactory; outdoor activity carries no risk.' },
  { label: 'Fair',      note: 'Acceptable, though unusually sensitive people may notice irritation.' },
  { label: 'Moderate',  note: 'Sensitive groups should consider shortening intense outdoor exertion.' },
  { label: 'Poor',      note: 'Reduce prolonged outdoor exertion; consider a mask outdoors.' },
  { label: 'Very poor', note: 'Avoid outdoor exertion. Keep windows closed and use filtration indoors.' }
];

/* ═══════════════════════════════════════════════════════════════════════════
 * 08 · PERSISTENCE
 * ---------------------------------------------------------------------------
 * Two interchangeable back ends behind one interface:
 *
 *   • LocalStore    IndexedDB in the browser. Always available, works offline,
 *                   needs no server, and is what the app uses by default.
 *   • CloudStore    Cloud Firestore, activated only when you supply a Firebase
 *                   config. Same methods, so the UI never knows the difference.
 *
 * The app writes to the local store first and mirrors to the cloud when signed
 * in, which keeps the interface responsive and correct while offline.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** localStorage that never throws — Safari private mode disables it entirely. */
const safeLocal = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  del(key) { try { localStorage.removeItem(key); } catch { /* noop */ } },
  json(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
};

const IDB = {
  name: 'cuacamy',
  version: 1,
  db: null,

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(this.name, this.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('users'))  db.createObjectStore('users',  { keyPath: 'email' });
        if (!db.objectStoreNames.contains('kv'))     db.createObjectStore('kv',     { keyPath: 'key' });
        if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },

  async tx(store, mode, run) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = run(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  },

  get(store, key)  { return this.tx(store, 'readonly',  (s) => s.get(key)); },
  all(store)       { return this.tx(store, 'readonly',  (s) => s.getAll()); },
  put(store, val)  { return this.tx(store, 'readwrite', (s) => s.put(val)); },
  del(store, key)  { return this.tx(store, 'readwrite', (s) => s.delete(key)); },
  clear(store)     { return this.tx(store, 'readwrite', (s) => s.clear()); }
};

const LocalStore = {
  kind: 'IndexedDB (this device)',

  async getProfile(uid) {
    try { return (await IDB.get('kv', 'profile:' + uid))?.value ?? null; }
    catch { return safeLocal.json('cuacamy.profile.' + uid, null); }
  },

  async setProfile(uid, profile) {
    try { await IDB.put('kv', { key: 'profile:' + uid, value: profile }); }
    catch { safeLocal.set('cuacamy.profile.' + uid, JSON.stringify(profile)); }
  },

  async getFavourites(uid) {
    const p = await this.getProfile(uid);
    return p?.favourites ?? [];
  },

  async setFavourites(uid, favourites) {
    const p = (await this.getProfile(uid)) || {};
    p.favourites = favourites;
    p.updatedAt = Date.now();
    await this.setProfile(uid, p);
  }
};

/** Firestore-backed mirror. Only constructed when Firebase is configured. */
function makeCloudStore(db, fbApi) {
  return {
    kind: 'Cloud Firestore (synced)',

    async getProfile(uid) {
      const snap = await fbApi.getDoc(fbApi.doc(db, 'users', uid));
      return snap.exists() ? snap.data() : null;
    },

    async setProfile(uid, profile) {
      await fbApi.setDoc(fbApi.doc(db, 'users', uid), profile, { merge: true });
    },

    async getFavourites(uid) {
      const p = await this.getProfile(uid);
      return p?.favourites ?? [];
    },

    async setFavourites(uid, favourites) {
      await fbApi.setDoc(
        fbApi.doc(db, 'users', uid),
        { favourites, updatedAt: Date.now() },
        { merge: true }
      );
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 09 · AUTHENTICATION
 * ---------------------------------------------------------------------------
 * Two modes, chosen automatically:
 *
 *   Firebase mode — active when CONFIG.firebase is filled in. Email/password
 *   plus Google sign-in (which is the Google Identity/Gmail account flow), with
 *   real server-side verification and cross-device sync via Firestore.
 *
 *   Local mode — the default for a zero-backend static deployment. Credentials
 *   never leave the browser: the password is stretched with PBKDF2-SHA256
 *   (210,000 iterations, per-user random salt) through WebCrypto and only the
 *   derived hash is stored in IndexedDB.
 *
 *   Local mode is a genuine convenience feature, not a security boundary —
 *   anything in a browser database is readable by anyone with the device. Use
 *   Firebase mode for a deployment that needs real account security.
 * ═══════════════════════════════════════════════════════════════════════════ */

const PBKDF2_ITERATIONS = 210000;

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function derivePassword(password, saltBytes) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material, 256
  );
  return toB64(bits);
}

/** Constant-time-ish comparison, so timing does not leak the stored hash. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const Auth = {
  mode: 'local',       // 'local' | 'firebase'
  user: null,          // { uid, email, name, photo, createdAt }
  store: LocalStore,
  _fb: null,
  _listeners: new Set(),

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  _emit() { this._listeners.forEach((fn) => fn(this.user)); },

  /** Try Firebase; fall back to local mode on any failure. */
  /** Firebase config from config.js, or pasted into Settings by the user. */
  config() {
    if (CONFIG.firebase && CONFIG.firebase.apiKey) return CONFIG.firebase;
    const stored = safeLocal.json(LS.firebase, null);
    return stored && stored.apiKey ? stored : null;
  },

  async init() {
    if (this.config()) {
      try {
        await this._initFirebase();
        this.mode = 'firebase';
      } catch (err) {
        Telemetry.record('auth', { lvl: 'warn', msg: 'Firebase unavailable, using local accounts: ' + err.message });
        this.mode = 'local';
      }
    }
    if (this.mode === 'local') await this._restoreLocalSession();
    this._emit();
  },

  async _initFirebase() {
    const V = '10.12.2';
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
    ]);
    const app = appMod.initializeApp(this.config());
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);

    this._fb = { app, auth, db, authMod, fsMod };
    this.store = makeCloudStore(db, fsMod);

    authMod.onAuthStateChanged(auth, (u) => {
      this.user = u ? {
        uid: u.uid,
        email: u.email,
        name: u.displayName || (u.email || '').split('@')[0],
        photo: u.photoURL || '',
        createdAt: Number(u.metadata?.createdAt) || Date.now(),
        verified: u.emailVerified
      } : null;
      this._emit();
    });
  },

  async signUp(email, password) {
    if (this.mode === 'firebase') {
      const { createUserWithEmailAndPassword, sendEmailVerification } = this._fb.authMod;
      const cred = await createUserWithEmailAndPassword(this._fb.auth, email, password);
      // Uses Google's transactional email service to verify ownership.
      try { await sendEmailVerification(cred.user); } catch { /* non-fatal */ }
      return cred.user;
    }
    const existing = await IDB.get('users', email).catch(() => null);
    if (existing) throw new Error('An account already exists for that email address.');

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePassword(password, salt);
    const record = {
      email,
      salt: toB64(salt),
      hash,
      iterations: PBKDF2_ITERATIONS,
      uid: 'local_' + toB64(crypto.getRandomValues(new Uint8Array(9))).replace(/[^a-zA-Z0-9]/g, ''),
      name: email.split('@')[0],
      createdAt: Date.now()
    };
    await IDB.put('users', record);
    await this._startLocalSession(record);
    return record;
  },

  async signIn(email, password) {
    if (this.mode === 'firebase') {
      const { signInWithEmailAndPassword } = this._fb.authMod;
      const cred = await signInWithEmailAndPassword(this._fb.auth, email, password);
      return cred.user;
    }
    const record = await IDB.get('users', email).catch(() => null);
    // Derive regardless of whether the account exists, so a wrong email and a
    // wrong password take the same amount of time to reject.
    const salt = record ? fromB64(record.salt) : new Uint8Array(16);
    const hash = await derivePassword(password, salt);
    if (!record || !safeEqual(hash, record.hash)) {
      throw new Error('That email and password combination does not match an account.');
    }
    await this._startLocalSession(record);
    return record;
  },

  async signInWithGoogle() {
    if (this.mode !== 'firebase') {
      throw new Error('NEEDS_FIREBASE');
    }
    const { GoogleAuthProvider, signInWithPopup } = this._fb.authMod;
    const provider = new GoogleAuthProvider();
    provider.addScope('email');
    provider.setCustomParameters({ prompt: 'select_account' });
    return signInWithPopup(this._fb.auth, provider);
  },

  async signOut() {
    if (this.mode === 'firebase') { await this._fb.authMod.signOut(this._fb.auth); return; }
    safeLocal.del(LS.session);
    this.user = null;
    this._emit();
  },

  async _startLocalSession(record) {
    const session = {
      uid: record.uid,
      email: record.email,
      name: record.name,
      createdAt: record.createdAt,
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000
    };
    safeLocal.set(LS.session, JSON.stringify(session));
    this.user = { ...session, photo: '' };
    this._emit();
  },

  async _restoreLocalSession() {
    const s = safeLocal.json(LS.session, null);
    if (!s || !s.expires || s.expires < Date.now()) { safeLocal.del(LS.session); return; }
    this.user = { ...s, photo: '' };
  }
};

/** Password strength — length dominates, variety helps. Score 0-4. */
function passwordScore(pw) {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw) && /[^\w\s]/.test(pw)) score += 1;
  if (/^(.)\1+$/.test(pw) || /^(?:123|abc|password|qwerty)/i.test(pw)) score = Math.min(score, 1);
  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  return { score, label: labels[clamp(score, 0, 4)] };
}

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v).trim());

/* ═══════════════════════════════════════════════════════════════════════════
 * 10 · APPLICATION STATE
 * ═══════════════════════════════════════════════════════════════════════════ */

const defaultSettings = {
  units: 'metric',
  theme: 'dark',
  home: 'geo',            // detect the visitor's location on arrival
  provider: 'auto',       // 'auto' | 'open-meteo' | 'owm'
  analytics: true,
  reduceMotion: false,
  alertsEnabled: true,
  alertMinSeverity: 3,    // 1 info · 2 advisory · 3 warning · 4 danger
  alertSound: true,
  notifications: false    // only ever true after the user grants permission
};

const state = {
  ...defaultSettings,
  units: 'metric',
  place: null,        // { name, state, country, lat, lon }
  current: null,      // raw OWM /weather payload
  forecast: null,     // raw OWM /forecast payload
  air: null,          // raw OWM /air_pollution payload
  daily: [],          // derived 5-day summary
  hourly: [],         // derived next-24h slots
  favourites: [],
  hourlySeries: 'temp',
  selectedDay: null,
  loading: false,
  source: 'live',     // 'live' | 'cache' | 'demo'
  providerUsed: '',
  hazards: [],        // ranked alerts from the hazard engine
  quakes: [],         // raw USGS features, for the alerts view
  flood: null,        // GloFAS river-discharge assessment
  airIndex: null,     // Malaysian Air Pollutant Index
  climate: null,      // computed local climate normal
  seenHazards: new Set()
};

let activeView = 'dashboard';

function loadSettings() {
  const saved = safeLocal.json(LS.settings, {});
  Object.assign(state, defaultSettings, saved);
  Telemetry.enabled = state.analytics !== false;
}

function saveSettings() {
  safeLocal.set(LS.settings, JSON.stringify({
    units: state.units, theme: state.theme, home: state.home,
    provider: state.provider, analytics: state.analytics,
    reduceMotion: state.reduceMotion, alertsEnabled: state.alertsEnabled,
    alertMinSeverity: state.alertMinSeverity, alertSound: state.alertSound,
    notifications: state.notifications
  }));
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.theme === 'light' ? '#eef2fb' : '#0b1020');
}

function applyMotion() {
  document.documentElement.setAttribute('data-motion', state.reduceMotion ? 'reduced' : 'full');
}

function applyUnits() {
  $$('.unit-toggle__opt').forEach((n) => n.classList.toggle('is-active', n.dataset.unit === state.units));
  const u = $('#cur-unit');
  if (u) u.textContent = state.units === 'imperial' ? '°F' : '°C';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 11 · DATA ORCHESTRATION
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Fetch everything for a place and repaint. All three calls run in parallel. */
async function loadPlace(place, { silent = false } = {}) {
  state.place = place;
  state.loading = true;
  state.selectedDay = null;
  if (!silent) {
    $('#dash-grid').classList.add('is-loading');
    setStatus('Loading ' + place.name + '…');
  }
  $('#error-box').hidden = true;
  renderPlaceHeader();

  const started = performance.now();

  // Promise.allSettled, not Promise.all: air quality is a bonus, and a failure
  // there must not blank out the temperature the user came for.
  const [cur, fc, air] = await Promise.allSettled([
    Api.current(place.lat, place.lon, state.units),
    Api.forecast(place.lat, place.lon, state.units),
    Api.air(place.lat, place.lon)
  ]);

  state.loading = false;
  $('#dash-grid').classList.remove('is-loading');

  if (cur.status === 'rejected') {
    showError(cur.reason);
    return;
  }

  state.current = cur.value.data;
  state.source = cur.value.demo ? 'demo' : cur.value.fromCache ? 'cache' : 'live';
  state.providerUsed = cur.value.data?.provider || (cur.value.demo ? 'bundled' : provider());
  state.forecast = fc.status === 'fulfilled' ? fc.value.data : null;
  state.air = air.status === 'fulfilled' ? air.value.data : null;

  deriveSeries();
  state.airIndex = computeAirIndex();
  renderAll();

  // The hazard sweep makes its own network calls, so it runs after the
  // dashboard has already painted rather than delaying it.
  runHazards();

  wxState = null;   // the analysis record set belongs to the previous place
  Telemetry.place(place.name);
  Telemetry.record('view', { lvl: 'info', msg: `${place.name} rendered in ${fmt.ms(performance.now() - started)}` });
  Telemetry.save();

  safeLocal.set(LS.lastPlace, JSON.stringify(place));
  setStatus('Ready');
  $('#banner-setup').hidden = state.source !== 'demo';
}

function showError(err) {
  const box = $('#error-box');
  const status = err?.status;
  $('#error-title').textContent =
    status === 401 ? 'API key rejected'
    : status === 404 ? 'Location not found'
    : !navigator.onLine ? 'You are offline'
    : 'Could not load the weather';
  $('#error-msg').textContent =
    status === 401 ? 'OpenWeatherMap rejected the key. New keys can take up to two hours to activate — check it in Settings.'
    : (err?.message || 'An unexpected error occurred.');
  box.hidden = false;
  setStatus('Error');
  Telemetry.record('error', { lvl: 'error', msg: err?.message || String(err) });
}

/**
 * Turn the flat 40-slot, 3-hourly forecast into what the UI needs:
 * a 5-day daily summary and a 24-hour strip.
 *
 * OWM does not return daily aggregates on the free tier, so we bucket the
 * slots by local calendar day, then reduce each bucket to min/max/dominant
 * condition. Bucketing uses the *city's* UTC offset, otherwise a Malaysian
 * evening lands on the previous day for a viewer in Europe.
 */
function deriveSeries() {
  state.daily = [];
  state.hourly = [];
  if (!state.forecast?.list?.length) return;

  const tz = state.forecast.city?.timezone ?? state.current?.timezone ?? 0;
  const buckets = new Map();

  for (const slot of state.forecast.list) {
    const localDay = Math.floor((slot.dt + tz) / 86400);
    if (!buckets.has(localDay)) buckets.set(localDay, []);
    buckets.get(localDay).push(slot);
  }

  for (const [day, slots] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const temps = slots.map((s) => s.main.temp);
    const counts = new Map();
    for (const s of slots) {
      // Weight midday conditions higher: they represent the day people plan around.
      const hour = ((s.dt + tz) / 3600) % 24;
      const weight = hour >= 9 && hour <= 18 ? 2 : 1;
      const id = s.weather[0].id;
      counts.set(id, (counts.get(id) || 0) + weight);
    }
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const sample = slots.find((s) => s.weather[0].id === dominant) || slots[0];

    state.daily.push({
      day,
      dt: slots[Math.floor(slots.length / 2)].dt,
      min: Math.min(...temps),
      max: Math.max(...temps),
      id: dominant,
      description: sample.weather[0].description,
      pop: Math.max(...slots.map((s) => s.pop ?? 0)),
      humidity: Math.round(slots.reduce((a, s) => a + s.main.humidity, 0) / slots.length),
      wind: Math.max(...slots.map((s) => s.wind?.speed ?? 0)),
      // Summing 3-hourly samples understates a daily total, so the provider's
      // own daily figures are preferred and only derived as a fallback.
      precipMm: sumPrecip(slots),
      gustKmh: maxGust(slots),
      uvMax: Math.max(0, ...slots.map((s) => s.uvi ?? 0)) || null,
      slots,
      tz
    });
  }

  state.daily = state.daily.slice(0, 5);

  // Open-Meteo returns real daily aggregates; use them in preference to the
  // values reduced from 3-hourly slots above.
  const omd = state.forecast.om_daily;
  if (omd?.time?.length) {
    const off = state.forecast.om_offset ?? 0;
    for (const d of state.daily) {
      const i = omd.time.findIndex((t) => Math.floor((omTime(t + 'T12:00', off) + off) / 86400) === d.day);
      if (i < 0) continue;
      if (typeof omd.precipitation_sum?.[i] === 'number')  d.precipMm = omd.precipitation_sum[i];
      if (typeof omd.wind_gusts_10m_max?.[i] === 'number') d.gustKmh = omd.wind_gusts_10m_max[i] * (state.units === 'imperial' ? 1.609 : 3.6);
      if (typeof omd.uv_index_max?.[i] === 'number')       d.uvMax = omd.uv_index_max[i];
      if (typeof omd.precipitation_probability_max?.[i] === 'number') d.pop = omd.precipitation_probability_max[i] / 100;
      if (typeof omd.temperature_2m_max?.[i] === 'number') d.max = omd.temperature_2m_max[i];
      if (typeof omd.temperature_2m_min?.[i] === 'number') d.min = omd.temperature_2m_min[i];
    }
  }

  const now = Math.floor(Date.now() / 1000);
  state.hourly = state.forecast.list
    .filter((s) => s.dt >= now - 5400)
    .slice(0, 9)
    .map((s) => ({
      dt: s.dt, tz,
      temp: s.main.temp,
      pop: (s.pop ?? 0) * 100,
      wind: state.units === 'imperial' ? s.wind.speed : s.wind.speed * 3.6,
      rainMm: precipOf(s),
      uvi: s.uvi ?? null,
      id: s.weather[0].id
    }));

  // Scale the whole-range bars on the forecast cards against the 5-day extremes.
  const allMin = Math.min(...state.daily.map((d) => d.min));
  const allMax = Math.max(...state.daily.map((d) => d.max));
  for (const d of state.daily) {
    const span = allMax - allMin || 1;
    d.barLeft = ((d.min - allMin) / span) * 100;
    d.barWidth = Math.max(8, ((d.max - d.min) / span) * 100);
  }
}

/** Precipitation in mm for one forecast slot, across both provider shapes. */
function precipOf(slot) {
  if (typeof slot.rain === 'number') return slot.rain;            // Open-Meteo
  if (slot.rain && typeof slot.rain['3h'] === 'number') return slot.rain['3h'];  // OWM
  if (slot.snow && typeof slot.snow['3h'] === 'number') return slot.snow['3h'];
  return 0;
}

const sumPrecip = (slots) => slots.reduce((a, s) => a + precipOf(s), 0);

/** Peak gust for a day, in km/h (or mph when imperial units are selected). */
function maxGust(slots) {
  const speeds = slots.map((s) => s.wind?.gust ?? s.wind?.speed ?? 0);
  const peak = Math.max(0, ...speeds);
  return state.units === 'imperial' ? peak : peak * 3.6;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 12 · RENDERING — DASHBOARD
 * ═══════════════════════════════════════════════════════════════════════════ */

function renderAll() {
  renderPlaceHeader();
  renderCurrent();
  renderMetrics();
  renderAir();
  renderHourly();
  renderForecast();
  renderSavedList();
  renderAssistant();
}

function renderPlaceHeader() {
  const p = state.place;
  if (!p) return;

  $('#place-name').textContent = p.name;
  $('#place-region').textContent = [p.state, p.country === 'MY' ? 'Malaysia' : p.country]
    .filter(Boolean).join(', ');
  $('#place-coords').textContent = fmt.coords(p.lat, p.lon);

  const tz = state.current?.timezone ?? 0;
  $('#place-time').textContent = state.current
    ? 'Local time ' + fmt.clock(Math.floor(Date.now() / 1000), tz)
    : '';

  // Deep links. Waze accepts ll=lat,lon with navigate=yes to start routing
  // immediately; Google Maps uses its documented universal URL scheme. Both
  // work on desktop web and hand off to the native app on Android and iOS.
  $('#link-waze').href = `https://www.waze.com/ul?ll=${p.lat}%2C${p.lon}&navigate=yes&zoom=15`;
  $('#link-gmaps').href = `https://www.google.com/maps/search/?api=1&query=${p.lat}%2C${p.lon}`;

  const saved = isFavourite(p);
  const favBtn = $('#btn-fav');
  favBtn.setAttribute('aria-pressed', String(saved));
  $('#btn-fav-label').textContent = saved ? 'Saved' : 'Save';

  document.title = state.current
    ? `${fmt.temp(state.current.main.temp)} ${p.name} — CuacaMY`
    : 'CuacaMY — Malaysia Weather Dashboard';
}

function renderCurrent() {
  const c = state.current;
  if (!c) return;
  const day = isDaytime(c.dt, c.sys?.sunrise, c.sys?.sunset);
  const tz = c.timezone ?? 0;

  $('#cur-icon').firstElementChild.setAttribute('href', '#' + iconFor(c.weather[0].id, day));
  $('#cur-temp').textContent = String(Math.round(c.main.temp));
  $('#cur-unit').textContent = state.units === 'imperial' ? '°F' : '°C';
  $('#cur-desc').textContent = c.weather[0].description;
  $('#cur-feels').textContent = fmt.temp(c.main.feels_like);

  // The current-conditions endpoint reports a narrow min/max; the forecast
  // model gives the real range for today, so prefer it when we have it.
  const today = state.daily[0];
  $('#cur-hi').textContent = fmt.temp(today ? today.max : c.main.temp_max);
  $('#cur-lo').textContent = fmt.temp(today ? today.min : c.main.temp_min);
  $('#cur-sunrise').textContent = c.sys?.sunrise ? fmt.clock(c.sys.sunrise, tz) : '—';
  $('#cur-sunset').textContent  = c.sys?.sunset  ? fmt.clock(c.sys.sunset,  tz) : '—';

  $('#cur-updated').textContent = fmt.relative(c.dt * 1000);
  const tag = $('#cur-source');
  const providerName = state.providerUsed === 'open-meteo' ? 'Open-Meteo'
                     : state.providerUsed === 'owm' ? 'OpenWeatherMap' : 'bundled model';
  tag.textContent = state.source === 'demo' ? 'Offline estimate'
                  : state.source === 'cache' ? `Cached · ${providerName}`
                  : `Live · ${providerName}`;
  tag.dataset.kind = state.source === 'demo' ? 'demo' : state.source === 'cache' ? 'cache' : 'live';
}

function renderMetrics() {
  const c = state.current;
  if (!c) return;

  const humidity = c.main.humidity;
  $('#m-humidity').textContent = humidity + '%';
  $('#m-humidity-bar').style.setProperty('width', humidity + '%');

  $('#m-wind').textContent = fmt.wind(c.wind?.speed);
  $('#m-wind-dir').textContent = fmt.bearing(c.wind?.deg);

  $('#m-pressure').textContent = `${c.main.pressure} hPa`;
  $('#m-pressure-trend').textContent =
    c.main.pressure > 1015 ? 'High — settled' : c.main.pressure < 1005 ? 'Low — unsettled' : 'Normal';

  $('#m-visibility').textContent = c.visibility != null
    ? `${round(c.visibility / 1000, 1)} km` : '—';

  const clouds = c.clouds?.all ?? 0;
  $('#m-clouds').textContent = clouds + '%';
  $('#m-clouds-bar').style.setProperty('width', clouds + '%');

  // Dew point is computed in °C, then converted back for display.
  const tempC = state.units === 'imperial' ? (c.main.temp - 32) * 5 / 9 : c.main.temp;
  const dewC = dewPointC(tempC, humidity);
  const dewShown = state.units === 'imperial' ? dewC * 9 / 5 + 32 : dewC;
  $('#m-dew').textContent = fmt.temp(dewShown);
  $('#m-comfort').textContent = comfortLabel(dewC);
}

function renderAir() {
  const entry = state.air?.list?.[0];
  const badge = $('#aqi-badge');
  const list = $('#aqi-pollutants');
  list.replaceChildren();

  if (!entry) {
    badge.dataset.level = '0';
    $('#aqi-score').textContent = '—';
    $('#aqi-label').textContent = 'No data';
    $('#aqi-note').textContent = 'Air quality is unavailable for this location.';
    return;
  }

  // Malaysia publishes its own 0-500 Air Pollutant Index rather than using the
  // US or European scale, so that is what is shown when we can compute it.
  const my = state.airIndex;
  if (my) {
    badge.dataset.level = my.value > 300 ? '5' : my.value > 200 ? '4'
                        : my.value > 100 ? '3' : my.value > 50 ? '2' : '1';
    $('#aqi-score').textContent = String(my.value);
    $('#aqi-label').textContent = `API · ${my.label}`;
    $('#aqi-note').textContent = `${my.note} Driven by ${my.driver}. Modelled estimate, not a DOE station reading.`;
  } else {
    const aqi = entry.main.aqi;
    const scale = AQI_SCALE[aqi] || AQI_SCALE[3];
    badge.dataset.level = String(aqi);
    $('#aqi-score').textContent = String(aqi);
    $('#aqi-label').textContent = scale.label;
    $('#aqi-note').textContent = scale.note;
  }

  const labels = {
    pm2_5: 'PM2.5', pm10: 'PM10', o3: 'Ozone',
    no2: 'NO₂', so2: 'SO₂', co: 'CO'
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = entry.components?.[key];
    if (value === undefined) continue;
    list.appendChild(el('li', { className: 'pollutant' }, [
      el('span', { textContent: label }),
      el('strong', { textContent: String(round(value, 1)) })
    ]));
  }
  list.appendChild(el('li', { className: 'aqi__units', textContent: 'Concentrations in µg/m³' }));
}

function renderForecast() {
  const host = $('#forecast-list');
  host.replaceChildren();

  if (!state.daily.length) {
    host.appendChild(el('p', { className: 'empty', textContent: 'Forecast data is unavailable right now.' }));
    return;
  }

  state.daily.forEach((d, index) => {
    const card = el('button', {
      className: 'fcard' + (state.selectedDay === index ? ' is-active' : ''),
      type: 'button',
      attrs: { 'aria-label':
        `${fmt.dayName(d.dt, d.tz, true)} ${fmt.dayDate(d.dt, d.tz)}: ${d.description}, high ${fmt.temp(d.max)}, low ${fmt.temp(d.min)}, ${Math.round(d.pop * 100)}% chance of rain` }
    });
    card.appendChild(el('span', { className: 'fcard__day', textContent: index === 0 ? 'Today' : fmt.dayName(d.dt, d.tz) }));
    card.appendChild(el('span', { className: 'fcard__date', textContent: fmt.dayDate(d.dt, d.tz) }));
    card.appendChild(icon(iconFor(d.id, true), 'fcard__icon'));
    card.appendChild(el('span', { className: 'fcard__desc', textContent: d.description }));

    const temps = el('span', { className: 'fcard__temps' }, [
      el('strong', { className: 'fcard__hi', textContent: fmt.temp(d.max) }),
      el('span', { className: 'fcard__lo', textContent: fmt.temp(d.min) })
    ]);
    card.appendChild(temps);

    const range = el('span', { className: 'fcard__range' });
    const fill = el('i');
    fill.style.setProperty('margin-left', d.barLeft + '%');
    fill.style.setProperty('width', d.barWidth + '%');
    range.appendChild(fill);
    card.appendChild(range);

    const pop = el('span', { className: 'fcard__pop' });
    pop.appendChild(icon('i-drop'));
    pop.appendChild(document.createTextNode(Math.round(d.pop * 100) + '%'));
    card.appendChild(pop);

    card.addEventListener('click', () => selectDay(index));
    host.appendChild(card);
  });

  if (state.selectedDay !== null) renderDayBreakdown(state.selectedDay);
}

function selectDay(index) {
  state.selectedDay = state.selectedDay === index ? null : index;
  renderForecast();
  const panel = $('#daybreak');
  if (state.selectedDay === null) { panel.hidden = true; return; }
  renderDayBreakdown(state.selectedDay);
}

function renderDayBreakdown(index) {
  const d = state.daily[index];
  if (!d) return;
  const panel = $('#daybreak');
  panel.hidden = false;
  $('#daybreak-title').textContent =
    `${fmt.dayName(d.dt, d.tz, true)}, ${fmt.dayDate(d.dt, d.tz)} — 3-hourly detail`;

  const slots = $('#daybreak-slots');
  slots.replaceChildren();
  for (const s of d.slots) {
    const node = el('div', { className: 'slot' });
    node.appendChild(el('span', { className: 'slot__h', textContent: fmt.clock(s.dt, d.tz) }));
    node.appendChild(icon(iconFor(s.weather[0].id, ((s.dt + d.tz) / 3600) % 24 >= 7 && ((s.dt + d.tz) / 3600) % 24 < 19)));
    node.appendChild(el('span', { className: 'slot__t', textContent: fmt.temp(s.main.temp) }));
    node.appendChild(el('span', { className: 'slot__h', textContent: Math.round((s.pop ?? 0) * 100) + '% rain' }));
    slots.appendChild(node);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 13 · CHARTS
 * ---------------------------------------------------------------------------
 * Plain Canvas 2D. Two details matter for quality:
 *   • back the canvas with devicePixelRatio so lines are crisp on retina;
 *   • read colours from the CSS custom properties so charts follow the theme.
 * ═══════════════════════════════════════════════════════════════════════════ */

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 1), h = Math.max(rect.height, 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function themeColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const SERIES_META = {
  temp: { label: 'Temperature', suffix: () => (state.units === 'imperial' ? '°F' : '°C'), decimals: 0 },
  pop:  { label: 'Rain chance', suffix: () => '%', decimals: 0 },
  wind: { label: 'Wind',        suffix: () => (state.units === 'imperial' ? ' mph' : ' km/h'), decimals: 0 }
};

function renderHourly() {
  const canvas = $('#hourly-chart');
  if (!canvas) return;

  const points = state.hourly;
  const { ctx, w, h } = setupCanvas(canvas);

  if (!points.length) {
    ctx.fillStyle = themeColor('--text-dim', '#6b7899');
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Hourly data unavailable', w / 2, h / 2);
    return;
  }

  const key = state.hourlySeries;
  const meta = SERIES_META[key];
  const values = points.map((p) => p[key]);

  const padL = 26, padR = 26, padT = 34, padB = 40;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  // Pad the domain so the line never touches the frame; rain chance is always
  // drawn against a fixed 0-100 scale so small differences stay meaningful.
  let lo = Math.min(...values), hi = Math.max(...values);
  if (key === 'pop') { lo = 0; hi = Math.max(100, hi); }
  else { const pad = Math.max((hi - lo) * 0.25, 1); lo -= pad; hi += pad; }
  const span = hi - lo || 1;

  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - lo) / span) * plotH;

  const brand = themeColor('--c-brand-400', '#47a8ff');
  const dim   = themeColor('--text-dim', '#6b7899');
  const mut   = themeColor('--text-mut', '#9aa8c7');

  // Horizontal guide lines
  ctx.strokeStyle = themeColor('--border', 'rgba(255,255,255,.1)');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i += 1) {
    const gy = Math.round(padT + (plotH / 3) * i) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
  }

  // Filled area under the curve
  const gradient = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  gradient.addColorStop(0, hexToRgba(brand, 0.34));
  gradient.addColorStop(1, hexToRgba(brand, 0));
  ctx.beginPath();
  ctx.moveTo(x(0), padT + plotH);
  points.forEach((p, i) => smoothLineTo(ctx, points, i, x, y, key, false));
  ctx.lineTo(x(points.length - 1), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // The curve itself
  ctx.beginPath();
  points.forEach((p, i) => smoothLineTo(ctx, points, i, x, y, key, i === 0));
  ctx.strokeStyle = brand;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Points, values and hour labels
  ctx.textAlign = 'center';
  points.forEach((p, i) => {
    const px = x(i), py = y(p[key]);

    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = themeColor('--bg-base', '#070b17');
    ctx.fill();
    ctx.strokeStyle = brand;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = mut;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(round(p[key], meta.decimals) + meta.suffix(), px, py - 12);

    ctx.fillStyle = dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(fmt.clock(p.dt, p.tz), px, h - 20);
  });

  // Weather icons cannot be drawn from a <use> sprite onto a canvas without an
  // image round-trip, so the accessible text summary carries that information.
  $('#hourly-table-summary').textContent = points
    .map((p) => `${fmt.clock(p.dt, p.tz)}: ${round(p[key], meta.decimals)}${meta.suffix()}`)
    .join(', ');
}

/** Catmull-Rom-ish smoothing: draws a soft curve through every data point. */
function smoothLineTo(ctx, pts, i, x, y, key, moveFirst = true) {
  const cur = { x: x(i), y: y(pts[i][key]) };
  if (i === 0) { if (moveFirst) ctx.moveTo(cur.x, cur.y); else ctx.lineTo(cur.x, cur.y); return; }
  const prev = { x: x(i - 1), y: y(pts[i - 1][key]) };
  const cx = (prev.x + cur.x) / 2;
  ctx.bezierCurveTo(cx, prev.y, cx, cur.y, cur.x, cur.y);
}

/** Accepts #rgb, #rrggbb or an rgb()/rgba() string and applies an alpha. */
function hexToRgba(color, alpha) {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4
      ? c.slice(1).split('').map((ch) => ch + ch).join('')
      : c.slice(1, 7);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const nums = c.match(/[\d.]+/g);
  return nums ? `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, ${alpha})` : `rgba(71,168,255,${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 14 · SAVED PLACES
 * ═══════════════════════════════════════════════════════════════════════════ */

const placeId = (p) => `${round(p.lat, 3)},${round(p.lon, 3)}`;
const isFavourite = (p) => p && state.favourites.some((f) => placeId(f) === placeId(p));

async function toggleFavourite() {
  const p = state.place;
  if (!p) return;

  if (isFavourite(p)) {
    state.favourites = state.favourites.filter((f) => placeId(f) !== placeId(p));
    toast(`Removed ${p.name} from saved places.`);
  } else {
    if (state.favourites.length >= 12) { toast('You can save up to 12 places.', 'warn'); return; }
    state.favourites.push({ name: p.name, state: p.state || '', country: p.country || '', lat: p.lat, lon: p.lon });
    toast(`Saved ${p.name}.`, 'success');
  }

  await persistFavourites();
  renderPlaceHeader();
  renderSavedList();
}

async function persistFavourites() {
  const uid = Auth.user?.uid || 'guest';
  // Always write locally first — instant, and it keeps working offline.
  await LocalStore.setFavourites(uid, state.favourites).catch(() => {
    safeLocal.set('cuacamy.favs.' + uid, JSON.stringify(state.favourites));
  });
  // Mirror to the cloud when signed in, without blocking the UI on it.
  if (Auth.user && Auth.store !== LocalStore) {
    Auth.store.setFavourites(Auth.user.uid, state.favourites)
      .catch((err) => Telemetry.record('sync', { lvl: 'warn', msg: 'Cloud sync failed: ' + err.message }));
  }
}

async function loadFavourites() {
  const uid = Auth.user?.uid || 'guest';
  let list = [];
  try { list = await Auth.store.getFavourites(uid); } catch { /* fall through */ }
  if (!list?.length) {
    try { list = await LocalStore.getFavourites(uid); } catch { /* fall through */ }
  }
  if (!list?.length) list = safeLocal.json('cuacamy.favs.' + uid, []);
  state.favourites = Array.isArray(list) ? list : [];
  renderSavedList();
  renderPlaceHeader();
}

function renderSavedList() {
  const host = $('#saved-list');
  const empty = $('#saved-empty');
  host.replaceChildren();

  $('#saved-sync').textContent = Auth.user
    ? (Auth.store === LocalStore ? 'Signed in · stored on this device' : 'Signed in · synced to your account')
    : 'Stored on this device';

  if (!state.favourites.length) { empty.hidden = false; return; }
  empty.hidden = true;

  for (const f of state.favourites) {
    const row = el('div', { className: 'saved-item', attrs: { role: 'button', tabindex: '0' } });
    row.appendChild(icon('wx-partly-day', 'saved-item__icon'));

    row.appendChild(el('div', {}, [
      el('div', { className: 'saved-item__name', textContent: f.name }),
      el('div', { className: 'saved-item__sub', textContent: [f.state, f.country].filter(Boolean).join(', ') })
    ]));

    const temp = el('div', { className: 'saved-item__temp', textContent: '—' });
    row.appendChild(temp);

    const del = el('button', {
      className: 'saved-item__del', type: 'button',
      attrs: { 'aria-label': `Remove ${f.name} from saved places` }
    });
    del.appendChild(icon('i-trash'));
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.favourites = state.favourites.filter((x) => placeId(x) !== placeId(f));
      await persistFavourites();
      renderSavedList();
      renderPlaceHeader();
    });
    row.appendChild(del);

    const open = () => loadPlace({ ...f });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    host.appendChild(row);

    // Fill in each saved card's temperature lazily so the list paints at once.
    Api.current(f.lat, f.lon, state.units)
      .then((res) => {
        temp.textContent = fmt.temp(res.data.main.temp);
        const day = isDaytime(res.data.dt, res.data.sys?.sunrise, res.data.sys?.sunset);
        row.querySelector('.saved-item__icon use')
           .setAttribute('href', '#' + iconFor(res.data.weather[0].id, day));
      })
      .catch(() => { temp.textContent = '—'; });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 15 · EXPLORE MALAYSIA
 * ═══════════════════════════════════════════════════════════════════════════ */

let exploreState = { stateCode: 'ALL', query: '' };

function renderStateFilter() {
  const host = $('#state-filter');
  host.replaceChildren();

  const counts = MY_PLACES.reduce((acc, p) => {
    acc[p.stateCode] = (acc[p.stateCode] || 0) + 1;
    return acc;
  }, {});

  const makeChip = (code, label, n) => {
    const chip = el('button', {
      className: 'state-chip' + (exploreState.stateCode === code ? ' is-active' : ''),
      type: 'button',
      attrs: { 'aria-pressed': String(exploreState.stateCode === code) }
    }, [label]);
    chip.appendChild(el('span', { className: 'state-chip__n', textContent: String(n) }));
    chip.addEventListener('click', () => {
      exploreState.stateCode = code;
      renderStateFilter();
      renderPlacesList();
    });
    return chip;
  };

  host.appendChild(makeChip('ALL', 'All Malaysia', MY_PLACES.length));
  for (const [code, name] of Object.entries(MY_STATES)) {
    host.appendChild(makeChip(code, name, counts[code] || 0));
  }
}

function renderPlacesList() {
  const host = $('#places-list');
  host.replaceChildren();

  const q = exploreState.query.trim().toLowerCase();
  const rows = MY_PLACES
    .filter((p) => exploreState.stateCode === 'ALL' || p.stateCode === exploreState.stateCode)
    .filter((p) => !q || p._key.includes(q))
    .sort((a, b) => (b.capital - a.capital) || a.name.localeCompare(b.name));

  $('#explore-count').textContent = String(MY_PLACES.length);

  if (!rows.length) {
    host.appendChild(el('p', { className: 'empty', textContent: 'No places match that filter.' }));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const p of rows) {
    const card = el('button', { className: 'place-card', type: 'button' });
    card.appendChild(el('span', { className: 'place-card__name', textContent: p.name }));
    card.appendChild(el('span', { className: 'place-card__state', textContent: p.state }));
    card.appendChild(el('span', { className: 'place-card__coords', textContent: fmt.coords(p.lat, p.lon) }));
    if (p.capital) card.appendChild(el('span', { className: 'place-card__cap', textContent: 'State capital' }));
    card.addEventListener('click', () => {
      loadPlace({ name: p.name, state: p.state, country: 'MY', lat: p.lat, lon: p.lon });
      setView('dashboard');
      window.scrollTo({ top: 0, behavior: state.reduceMotion ? 'auto' : 'smooth' });
    });
    frag.appendChild(card);
  }
  host.appendChild(frag);
}

/**
 * Live comparison of all 16 state capitals.
 *
 * Requests are issued in small concurrent batches rather than all at once:
 * 16 simultaneous calls can trip OpenWeatherMap's per-minute rate limit and
 * would queue behind the browser's per-host connection cap anyway.
 */
async function renderCapitalComparison() {
  const card = $('#compare-card');
  const body = $('#compare-body');
  const status = $('#compare-status');
  card.hidden = false;
  body.replaceChildren();
  status.textContent = `Fetching ${MY_CAPITALS.length} capitals…`;
  card.scrollIntoView({ behavior: state.reduceMotion ? 'auto' : 'smooth', block: 'nearest' });

  const started = performance.now();
  const results = [];
  const BATCH = 4;

  for (let i = 0; i < MY_CAPITALS.length; i += BATCH) {
    const batch = MY_CAPITALS.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map((p) => Api.current(p.lat, p.lon, state.units).then((r) => ({ place: p, data: r.data })))
    );
    for (const s of settled) if (s.status === 'fulfilled') results.push(s.value);
    status.textContent = `Fetched ${results.length} of ${MY_CAPITALS.length}…`;
  }

  results.sort((a, b) => b.data.main.temp - a.data.main.temp);

  for (const { place, data } of results) {
    const tr = el('tr');
    tr.appendChild(el('th', { attrs: { scope: 'row' }, textContent: place.name }));
    tr.appendChild(el('td', { textContent: place.state }));
    tr.appendChild(el('td', { className: 't-temp', textContent: fmt.temp(data.main.temp) }));
    tr.appendChild(el('td', { textContent: fmt.temp(data.main.feels_like) }));
    tr.appendChild(el('td', { textContent: data.main.humidity + '%' }));
    tr.appendChild(el('td', { textContent: fmt.wind(data.wind?.speed) }));

    const cond = el('td');
    const day = isDaytime(data.dt, data.sys?.sunrise, data.sys?.sunset);
    cond.appendChild(icon(iconFor(data.weather[0].id, day), 't-icon'));
    cond.appendChild(document.createTextNode(' ' + data.weather[0].description));
    tr.appendChild(cond);

    const nav = el('td');
    const wrap = el('span', { className: 't-nav' });
    const waze = el('a', {
      href: `https://www.waze.com/ul?ll=${place.lat}%2C${place.lon}&navigate=yes`,
      target: '_blank', rel: 'noopener noreferrer',
      attrs: { 'aria-label': `Navigate to ${place.name} with Waze`, title: 'Waze' }
    });
    waze.appendChild(icon('i-nav'));
    const gmap = el('a', {
      href: `https://www.google.com/maps/search/?api=1&query=${place.lat}%2C${place.lon}`,
      target: '_blank', rel: 'noopener noreferrer',
      attrs: { 'aria-label': `Open ${place.name} in Google Maps`, title: 'Google Maps' }
    });
    gmap.appendChild(icon('i-pin'));
    wrap.appendChild(waze); wrap.appendChild(gmap);
    nav.appendChild(wrap);
    tr.appendChild(nav);

    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      loadPlace({ name: place.name, state: place.state, country: 'MY', lat: place.lat, lon: place.lon });
      setView('dashboard');
    });
    body.appendChild(tr);
  }

  const hottest = results[0];
  status.textContent = results.length
    ? `${results.length} capitals in ${fmt.ms(performance.now() - started)} · hottest right now: ${hottest.place.name} at ${fmt.temp(hottest.data.main.temp, true)}`
    : 'Could not load capital data.';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 16 · APP DIAGNOSTICS
 * ---------------------------------------------------------------------------
 * Core Web Vitals and API timings used to be the Analytics tab. They measure
 * the site, not the weather, so they now live in a collapsed panel at the foot
 * of the analysis view — useful when something feels slow, and out of the way
 * the rest of the time. The tab itself is meteorology (sections 31-33).
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
 * 17 · SEARCH COMBOBOX
 * ---------------------------------------------------------------------------
 * Malaysian places resolve from the bundled gazetteer with no network call at
 * all. The geocoding API is queried in parallel for everywhere else, and its
 * results are appended under a separate heading once they arrive.
 * ═══════════════════════════════════════════════════════════════════════════ */

const Search = {
  results: [],
  activeIndex: -1,
  open: false,
  lastQuery: '',

  /** Rank local matches: exact > prefix > word-prefix > substring; capitals win ties. */
  local(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const p of MY_PLACES) {
      const name = p.name.toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.split(' ').some((w) => w.startsWith(q))) score = 60;
      else if (p._key.includes(q)) score = 35;
      if (!score) continue;
      if (p.capital) score += 6;
      scored.push({ ...p, score, source: 'local' });
    }
    return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 8);
  },

  async run(query) {
    this.lastQuery = query;
    const locals = this.local(query);
    this.render(locals, []);

    if (query.trim().length < 3) return;

    $('#search-spinner').hidden = false;
    try {
      const remote = await Api.geocode(query.trim(), 5);
      // A slower earlier request must never overwrite a newer query's results.
      if (this.lastQuery !== query) return;
      const seen = new Set(locals.map((l) => placeId(l)));
      this.render(locals, remote.filter((r) => !seen.has(placeId(r))));
    } catch (err) {
      Telemetry.record('search', { lvl: 'warn', msg: 'Geocoding failed: ' + err.message });
    } finally {
      if (this.lastQuery === query) $('#search-spinner').hidden = true;
    }
  },

  render(locals, remote) {
    const host = $('#search-results');
    host.replaceChildren();
    this.results = [];
    this.activeIndex = -1;

    const addGroup = (label) => host.appendChild(el('li', {
      className: 'search__group', textContent: label, attrs: { role: 'presentation' }
    }));

    const addItem = (p, sourceLabel) => {
      const index = this.results.length;
      this.results.push(p);
      const li = el('li', {
        className: 'result', id: 'search-opt-' + index,
        attrs: { role: 'option', 'aria-selected': 'false' }
      });
      li.appendChild(icon('i-pin', 'result__flagicon'));
      li.appendChild(el('div', {}, [
        el('div', { className: 'result__name', textContent: p.name }),
        el('div', {
          className: 'result__sub',
          textContent: [p.state, p.country === 'MY' ? 'Malaysia' : p.country].filter(Boolean).join(', ')
        })
      ]));
      li.appendChild(el('span', {
        className: 'result__badge', textContent: sourceLabel,
        dataset: { src: p.source === 'local' ? 'local' : 'owm' }
      }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); this.choose(index); });
      li.addEventListener('mouseenter', () => this.setActive(index));
      host.appendChild(li);
    };

    if (locals.length) {
      addGroup('Malaysia · offline gazetteer');
      locals.forEach((p) => addItem(p, 'Built-in'));
    }
    if (remote.length) {
      addGroup('Worldwide · OpenWeatherMap');
      remote.forEach((p) => addItem(p, 'Geocoded'));
    }
    if (!locals.length && !remote.length) {
      host.appendChild(el('li', {
        className: 'search__group',
        textContent: 'No matching places found.',
        attrs: { role: 'presentation' }
      }));
    }

    this.show(true);
  },

  show(flag) {
    this.open = flag;
    $('#search-results').hidden = !flag;
    $('#search-input').setAttribute('aria-expanded', String(flag));
    if (!flag) {
      $('#search-input').removeAttribute('aria-activedescendant');
      this.activeIndex = -1;
    }
  },

  setActive(index) {
    const nodes = $$('.result', $('#search-results'));
    nodes.forEach((n, i) => {
      const on = i === index;
      n.classList.toggle('is-active', on);
      n.setAttribute('aria-selected', String(on));
    });
    this.activeIndex = index;
    if (nodes[index]) {
      $('#search-input').setAttribute('aria-activedescendant', nodes[index].id);
      nodes[index].scrollIntoView({ block: 'nearest' });
    }
  },

  move(delta) {
    if (!this.results.length) return;
    const next = (this.activeIndex + delta + this.results.length) % this.results.length;
    this.setActive(next);
  },

  choose(index) {
    const p = this.results[index >= 0 ? index : 0];
    if (!p) return;
    this.show(false);
    $('#search-input').value = p.name;
    $('#search-clear').hidden = false;
    loadPlace({ name: p.name, state: p.state || '', country: p.country || '', lat: p.lat, lon: p.lon });
    Telemetry.record('search', { lvl: 'info', msg: `Selected ${p.name} (${p.source === 'local' ? 'gazetteer' : 'geocoder'})` });
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 18 · GEOLOCATION & SHARING
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The Geolocation API is promise-free, so it gets wrapped. `enableHighAccuracy`
 * asks for GPS rather than coarse network positioning; `maximumAge` lets the
 * browser hand back a recent fix instead of powering up the radio again.
 */
function getPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser does not support location detection.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 12000, maximumAge: 300000, ...options
    });
  });
}

async function detectLocation() {
  const btn = $('#btn-geo');
  btn.classList.add('is-busy');
  setStatus('Detecting your location…');
  try {
    const pos = await getPosition();
    const { latitude, longitude } = pos.coords;
    const place = await Api.reverse(latitude, longitude);
    await loadPlace({ ...place, lat: latitude, lon: longitude });
    toast(`Located you near ${place.name}.`, 'success');
    Telemetry.record('geo', { lvl: 'info', msg: `Located at ${fmt.coords(latitude, longitude)} (±${Math.round(pos.coords.accuracy)} m)` });
  } catch (err) {
    const message = err.code === 1
      ? 'Location permission was denied. You can still search for any city by name.'
      : err.code === 3 ? 'Location lookup timed out. Try again outdoors or search by name.'
      : err.message || 'Could not determine your location.';
    toast(message, 'error', 6000);
    Telemetry.record('geo', { lvl: 'warn', msg: message });
  } finally {
    btn.classList.remove('is-busy');
    setStatus('Ready');
  }
}

/** Plain-text weather briefing, used for both email and clipboard. */
function buildReport() {
  const p = state.place, c = state.current;
  if (!p || !c) return { subject: 'CuacaMY report', body: '' };

  const tz = c.timezone ?? 0;
  const lines = [
    `Weather report — ${p.name}${p.state ? ', ' + p.state : ''}`,
    `Generated ${new Date().toLocaleString()} via CuacaMY`,
    '',
    `Now: ${fmt.temp(c.main.temp, true)}, ${c.weather[0].description}`,
    `Feels like: ${fmt.temp(c.main.feels_like, true)}`,
    `Humidity: ${c.main.humidity}%   Wind: ${fmt.wind(c.wind?.speed)} ${fmt.bearing(c.wind?.deg)}`,
    `Pressure: ${c.main.pressure} hPa   Visibility: ${round((c.visibility ?? 0) / 1000, 1)} km`,
    c.sys?.sunrise ? `Sunrise ${fmt.clock(c.sys.sunrise, tz)} · Sunset ${fmt.clock(c.sys.sunset, tz)}` : '',
    ''
  ];

  if (state.air?.list?.[0]) {
    const aqi = state.air.list[0].main.aqi;
    lines.push(`Air quality: ${aqi}/5 — ${(AQI_SCALE[aqi] || {}).label || 'Unknown'}`, '');
  }

  if (state.daily.length) {
    lines.push('5-day outlook');
    for (const d of state.daily) {
      lines.push(`  ${fmt.dayName(d.dt, d.tz)} ${fmt.dayDate(d.dt, d.tz)}  ` +
                 `${fmt.temp(d.max)} / ${fmt.temp(d.min)}  ${d.description}  ` +
                 `${Math.round(d.pop * 100)}% rain`);
    }
    lines.push('');
  }

  lines.push(`Navigate with Waze: https://www.waze.com/ul?ll=${p.lat},${p.lon}&navigate=yes`);
  lines.push(`Open in Google Maps: https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`);

  return {
    subject: `Weather in ${p.name} — ${fmt.temp(c.main.temp, true)}, ${c.weather[0].description}`,
    body: lines.filter((l) => l !== null).join('\n')
  };
}

/**
 * Email the report.
 *
 * Signed in through Google, the Gmail compose URL opens a prefilled draft in
 * the user's own mailbox — no server, no API key, no OAuth scope needed, and
 * nothing leaves the browser until the user presses Send. Otherwise we fall
 * back to `mailto:`, which hands off to whatever mail client they do use.
 */
function emailReport() {
  const { subject, body } = buildReport();
  if (!body) { toast('Load a location first.', 'warn'); return; }

  const useGmail = Auth.user?.email?.endsWith('@gmail.com') || Auth.mode === 'firebase';
  const to = Auth.user?.email || '';
  const url = useGmail
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  window.open(url, '_blank', 'noopener');

  navigator.clipboard?.writeText(body)
    .then(() => toast('Report opened in your mail client and copied to the clipboard.', 'success'))
    .catch(() => toast('Report opened in your mail client.', 'success'));

  Telemetry.record('share', { lvl: 'info', msg: `Emailed report for ${state.place?.name}` });
}

function downloadJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking on the next tick keeps the object URL alive long enough to download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 25 · MONSOON & SEASON
 * ---------------------------------------------------------------------------
 * Malaysia has no four-season year. Its climate is organised around two
 * monsoons separated by two inter-monsoon transitions, and which one is
 * running is the single best predictor of whether a given state is about to
 * flood. This is a calendar fact, not a forecast, so it is computed locally
 * with no network call.
 *
 * Northeast monsoon   Nov - Mar   the main rainy season; the east coast of the
 *                                 peninsula, western Sarawak and north-east
 *                                 Sabah take the heaviest, most persistent rain
 * First inter-monsoon Apr - May   light winds, intense convective afternoon
 *                                 thunderstorms and squall lines
 * Southwest monsoon   Jun - Sep   the driest spell for most of the country;
 *                                 the haze season, when smoke from regional
 *                                 land clearing is carried in
 * Second inter-monsoon Oct        thunderstorms return ahead of the northeast
 *                                 monsoon's onset
 * ═══════════════════════════════════════════════════════════════════════════ */

/** States that bear the brunt of each phase. */
const MONSOON = {
  northeast: {
    name: 'Northeast monsoon',
    malay: 'Monsun Timur Laut',
    window: 'November – March',
    summary: 'Malaysia’s main rainy season. Persistent heavy rain arrives on winds off the South China Sea, and monsoon surges can produce several days of continuous rainfall.',
    watch: ['KTN', 'TRG', 'PHG', 'JHR', 'SWK', 'SBH'],
    risks: ['Seasonal river flooding on the east coast', 'Monsoon surges lasting several days',
            'Rough seas and disrupted ferry services', 'Landslides on saturated slopes']
  },
  interNorth: {
    name: 'First inter-monsoon',
    malay: 'Peralihan Monsun',
    window: 'April – May',
    summary: 'Winds are light and variable. Heat builds through the day and releases as sharp afternoon and evening thunderstorms, often with damaging gusts.',
    watch: ['KUL', 'SGR', 'PRK', 'PNG', 'NSN', 'MLK'],
    risks: ['Intense afternoon thunderstorms', 'Flash flooding in urban drainage',
            'Squall lines with sudden strong winds', 'Lightning risk for outdoor work']
  },
  southwest: {
    name: 'Southwest monsoon',
    malay: 'Monsun Barat Daya',
    window: 'June – September',
    summary: 'The driest stretch for most of the country. Sumatra squalls sweep the west coast in the early morning, and this is the season when regional haze is most likely.',
    watch: ['PNG', 'PRK', 'KDH', 'SGR', 'MLK', 'JHR'],
    risks: ['Transboundary haze and poor air quality', 'Sumatra squalls before dawn on the west coast',
            'Dry spells and elevated fire risk', 'Water supply stress in a prolonged dry period']
  },
  interSouth: {
    name: 'Second inter-monsoon',
    malay: 'Peralihan Monsun',
    window: 'October – early November',
    summary: 'The transition into the northeast monsoon. Thunderstorm activity picks up again nationwide as the wind reverses.',
    watch: ['KUL', 'SGR', 'PHG', 'KTN', 'TRG', 'SWK'],
    risks: ['Frequent afternoon thunderstorms', 'Early-season flash flooding',
            'Rapidly changing conditions day to day']
  }
};

/** Which monsoon phase a date falls in. */
function monsoonPhase(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m >= 11 || m <= 3) return { key: 'northeast', ...MONSOON.northeast };
  if (m === 4 || m === 5) return { key: 'interNorth', ...MONSOON.interNorth };
  if (m >= 6 && m <= 9) return { key: 'southwest', ...MONSOON.southwest };
  return { key: 'interSouth', ...MONSOON.interSouth };
}

/** Is the current place in a state this monsoon phase hits hardest? */
function monsoonAffectsPlace(phase, place) {
  if (!place || place.country !== 'MY') return false;
  const code = Object.keys(MY_STATES).find((c) => MY_STATES[c] === place.state);
  return code ? phase.watch.includes(code) : false;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 26 · HAZARD ENGINE
 * ---------------------------------------------------------------------------
 * Turns raw numbers into ranked, actionable alerts. Every threshold below is
 * sourced rather than invented, and each alert carries the reading that
 * triggered it so a reader can check the reasoning:
 *
 *   Rainfall   MetMalaysia's continuous-rain warning bands — Waspada above
 *              60 mm/24 h, Buruk above 150 mm/24 h, Bahaya above 250 mm/24 h.
 *   Storms     MetMalaysia issues a thunderstorm warning at 20 mm/hour.
 *   Heat       MetMalaysia's heatwave levels on daily maximum temperature:
 *              35-37 °C, 37-40 °C, and above 40 °C.
 *   Air        The Malaysian DOE Air Pollutant Index bands (see section 06B).
 *   Flood      GloFAS river discharge against its own 92-day distribution.
 *   Quakes     USGS magnitude, distance, tsunami flag and PAGER alert level.
 *
 * Severity 1 information · 2 advisory · 3 warning · 4 danger.
 * ═══════════════════════════════════════════════════════════════════════════ */

const SEVERITY_LABEL = { 1: 'Information', 2: 'Advisory', 3: 'Warning', 4: 'Danger' };
const SEVERITY_TONE  = { 1: 'info', 2: 'ok', 3: 'warn', 4: 'severe' };

const Hazards = {
  /** Build the full alert set for the current place. Never throws. */
  async assess(place) {
    const alerts = [];
    try { alerts.push(...this.fromRainfall()); }  catch (e) { this.oops('rainfall', e); }
    try { alerts.push(...this.fromStorms()); }    catch (e) { this.oops('storms', e); }
    try { alerts.push(...this.fromWind()); }      catch (e) { this.oops('wind', e); }
    try { alerts.push(...this.fromHeat()); }      catch (e) { this.oops('heat', e); }
    try { alerts.push(...this.fromUV()); }        catch (e) { this.oops('uv', e); }
    try { alerts.push(...this.fromAir()); }       catch (e) { this.oops('air', e); }

    // The two network-backed sources run together and never block each other.
    const [flood, quakes] = await Promise.allSettled([
      this.fromFlood(place),
      this.fromQuakes(place)
    ]);
    if (flood.status === 'fulfilled') alerts.push(...flood.value);
    if (quakes.status === 'fulfilled') alerts.push(...quakes.value);

    alerts.push(...this.fromMonsoon(place));

    // Most severe first, then soonest.
    alerts.sort((a, b) => b.severity - a.severity || (a.whenTs || 0) - (b.whenTs || 0));
    return alerts;
  },

  oops(source, err) {
    Telemetry.record('hazard', { lvl: 'warn', msg: `${source} check failed: ${err.message}` });
  },

  alert(o) {
    return {
      id: o.id, kind: o.kind, severity: o.severity,
      title: o.title, detail: o.detail, advice: o.advice,
      when: o.when || 'Now', whenTs: o.whenTs || Date.now(),
      source: o.source, link: o.link || null, reading: o.reading || ''
    };
  },

  /** Daily rainfall totals against MetMalaysia's continuous-rain bands. */
  fromRainfall() {
    const out = [];
    for (const d of state.daily.slice(0, 5)) {
      const mm = d.precipMm;
      if (mm === null || mm === undefined) continue;

      let severity = 0, band = '';
      if (mm >= 250)      { severity = 4; band = 'Bahaya (danger)'; }
      else if (mm >= 150) { severity = 3; band = 'Buruk (bad)'; }
      else if (mm >= 60)  { severity = 2; band = 'Waspada (alert)'; }
      if (!severity) continue;

      const day = fmt.dayName(d.dt, d.tz, true);
      out.push(this.alert({
        id: `rain:${d.day}`,
        kind: 'rain',
        severity,
        title: `Heavy rain expected — ${band}`,
        detail: `${Math.round(mm)} mm of rain is forecast for ${day}, ${fmt.dayDate(d.dt, d.tz)}. ` +
                `MetMalaysia issues a continuous-rain warning at this level.`,
        advice: severity >= 4
          ? 'Extreme flood risk. Move vehicles and valuables to higher ground now, keep documents and medication in a grab bag, and follow evacuation instructions.'
          : severity === 3
            ? 'Significant flood risk. Avoid low-lying roads and river crossings, and prepare to move valuables up a floor.'
            : 'Localised flash flooding is possible. Allow extra travel time and avoid parking beside drains or rivers.',
        when: day,
        whenTs: d.dt * 1000,
        reading: `${Math.round(mm)} mm / 24 h`,
        source: 'Forecast rainfall vs MetMalaysia warning bands'
      }));
    }
    return out;
  },

  /** Thunderstorms and intense short-duration rain in the next 12 hours. */
  fromStorms() {
    const out = [];
    const soon = state.hourly.filter((h) => h.dt * 1000 < Date.now() + 12 * 3600 * 1000);

    const storm = soon.find((h) => Math.floor(h.id / 100) === 2);
    if (storm) {
      out.push(this.alert({
        id: `storm:${storm.dt}`,
        kind: 'storm',
        severity: 2,
        title: 'Thunderstorms forecast',
        detail: `Thunderstorms are expected around ${fmt.clock(storm.dt, storm.tz)}. ` +
                'Malaysian storms build fast and bring lightning, sudden gusts and brief intense rain.',
        advice: 'Finish outdoor work early. If you hear thunder, go indoors — a substantial building or a hard-topped vehicle, not a shelter or a tree.',
        when: fmt.clock(storm.dt, storm.tz),
        whenTs: storm.dt * 1000,
        reading: 'Thunderstorm in the hourly model',
        source: 'Hourly weather codes'
      }));
    }

    const intense = soon.find((h) => (h.rainMm ?? 0) >= 20);
    if (intense) {
      out.push(this.alert({
        id: `downpour:${intense.dt}`,
        kind: 'rain',
        severity: 3,
        title: 'Intense downpour expected',
        detail: `About ${Math.round(intense.rainMm)} mm of rain is forecast within a single hour around ` +
                `${fmt.clock(intense.dt, intense.tz)}. MetMalaysia's thunderstorm warning threshold is 20 mm/hour.`,
        advice: 'Urban drains overwhelm quickly at this rate. Avoid underpasses and basement car parks, and do not drive through moving water.',
        when: fmt.clock(intense.dt, intense.tz),
        whenTs: intense.dt * 1000,
        reading: `${Math.round(intense.rainMm)} mm / h`,
        source: 'Hourly precipitation'
      }));
    }
    return out;
  },

  fromWind() {
    const out = [];
    for (const d of state.daily.slice(0, 3)) {
      const gust = d.gustKmh;
      if (!gust) continue;
      let severity = 0;
      if (gust >= 120)     severity = 4;
      else if (gust >= 90) severity = 3;
      else if (gust >= 60) severity = 2;
      if (!severity) continue;

      out.push(this.alert({
        id: `wind:${d.day}`,
        kind: 'wind',
        severity,
        title: 'Damaging wind gusts possible',
        detail: `Gusts to ${Math.round(gust)} km/h are forecast for ${fmt.dayName(d.dt, d.tz, true)}.`,
        advice: 'Secure loose items, awnings and scaffolding. Take care under trees and near hoardings, and expect sea and river crossings to be rough.',
        when: fmt.dayName(d.dt, d.tz),
        whenTs: d.dt * 1000,
        reading: `${Math.round(gust)} km/h gusts`,
        source: 'Forecast wind gusts'
      }));
      break;      // one wind alert is enough
    }
    return out;
  },

  /** MetMalaysia heatwave levels, on daily maximum temperature in °C. */
  fromHeat() {
    const out = [];
    const toC = (v) => (state.units === 'imperial' ? (v - 32) * 5 / 9 : v);
    for (const d of state.daily.slice(0, 3)) {
      const maxC = toC(d.max);
      let severity = 0, level = '';
      if (maxC >= 40)      { severity = 4; level = 'Level 3'; }
      else if (maxC >= 37) { severity = 3; level = 'Level 2'; }
      else if (maxC >= 35) { severity = 2; level = 'Level 1'; }
      if (!severity) continue;

      out.push(this.alert({
        id: `heat:${d.day}`,
        kind: 'heat',
        severity,
        title: `Heat stress — ${level} conditions`,
        detail: `A maximum of ${fmt.temp(d.max, true)} is forecast for ${fmt.dayName(d.dt, d.tz, true)}. ` +
                'Malaysia’s humidity means the body sheds heat far less efficiently than the air temperature suggests.',
        advice: severity >= 3
          ? 'Avoid outdoor exertion between 11am and 4pm. Drink water before you feel thirsty, and check on elderly neighbours and anyone working outdoors.'
          : 'Keep water with you, take shade breaks, and move strenuous activity to early morning or evening.',
        when: fmt.dayName(d.dt, d.tz),
        whenTs: d.dt * 1000,
        reading: `${fmt.temp(d.max, true)} maximum`,
        source: 'Forecast maximum vs MetMalaysia heatwave levels'
      }));
      break;
    }
    return out;
  },

  fromUV() {
    const uv = state.daily[0]?.uvMax;
    if (!uv || uv < 8) return [];
    return [this.alert({
      id: `uv:${state.daily[0].day}`,
      kind: 'uv',
      severity: uv >= 11 ? 2 : 1,
      title: uv >= 11 ? 'Extreme UV today' : 'Very high UV today',
      detail: `The UV index peaks near ${Math.round(uv)} today. Malaysia sits close to the equator, so ` +
              'midday sun is intense all year, cloud cover included.',
      advice: uv >= 11
        ? 'Unprotected skin can burn in under 15 minutes. Stay in shade around midday, and use a hat, sunglasses and SPF 50+.'
        : 'Use SPF 30+ and seek shade between 11am and 3pm.',
      reading: `UV index ${Math.round(uv)}`,
      source: 'Forecast UV index'
    })];
  },

  fromAir() {
    const idx = state.airIndex;
    if (!idx || idx.value <= 100) return [];
    const severity = idx.value > 300 ? 4 : idx.value > 200 ? 3 : 2;
    return [this.alert({
      id: `air:${Math.round(idx.value / 10)}`,
      kind: 'haze',
      severity,
      title: `Air quality ${idx.label.toLowerCase()} — API ${idx.value}`,
      detail: `${idx.note} The index is driven by ${idx.driver}.`,
      advice: severity >= 3
        ? 'Stay indoors with windows closed, run an air purifier if you have one, and wear an N95 outdoors — a surgical or cloth mask does not filter smoke particles.'
        : 'People with asthma or heart conditions should limit outdoor exertion and keep reliever medication to hand.',
      reading: `API ${idx.value} (${idx.driver})`,
      source: 'Malaysian DOE index computed from modelled PM2.5 and PM10'
    })];
  },

  /**
   * GloFAS river discharge. An absolute figure means little without local
   * context, so today's value is judged against its own 92-day distribution
   * for this reach: a river running well above its own median is the signal.
   */
  async fromFlood(place) {
    if (!place) return [];
    const res = await OpenMeteo.flood(place.lat, place.lon);
    const d = res.data?.daily;
    if (!d?.river_discharge?.length) return [];

    const series = d.river_discharge.filter((v) => typeof v === 'number');
    if (!series.length) return [];

    const today = series[0];
    const median = percentile(series, 0.5) || 0;
    const p90 = percentile(series, 0.9) || 0;
    const peak = Math.max(...series.slice(0, 10));
    const peakIndex = series.slice(0, 10).indexOf(peak);

    state.flood = { today, median, p90, peak, peakIndex, series, dates: d.time };

    // Tiny headwater reaches produce large ratios from noise, so an absolute
    // floor is required before any of this is reported as a hazard.
    if (peak < 5 || !median) return [];

    const ratio = peak / median;
    let severity = 0;
    if (ratio >= 4 && peak >= p90)      severity = 3;
    else if (ratio >= 2.5)              severity = 2;
    else if (ratio >= 1.8)              severity = 1;
    if (!severity) return [];

    const when = d.time?.[peakIndex];
    return [this.alert({
      id: `flood:${when}`,
      kind: 'flood',
      severity,
      title: 'River levels rising nearby',
      detail: `The modelled river discharge near this location peaks at ${round(peak, 1)} m³/s ` +
              `${peakIndex === 0 ? 'today' : `in ${peakIndex} day${peakIndex === 1 ? '' : 's'}`}, ` +
              `about ${round(ratio, 1)}× its 90-day median of ${round(median, 1)} m³/s.`,
      advice: severity >= 3
        ? 'Treat this as an early warning, not a forecast of your street. Check JPS InfoBanjir for gauge readings on your river, and move valuables up a floor if you are in a known flood area.'
        : 'Worth watching if you live near a river. Compare against JPS InfoBanjir, which reports actual gauge levels.',
      when: when || 'Next 10 days',
      whenTs: when ? Date.parse(when) : Date.now(),
      reading: `${round(peak, 1)} m³/s vs ${round(median, 1)} median`,
      link: 'https://publicinfobanjir.water.gov.my/',
      source: 'Copernicus GloFAS via Open-Meteo'
    })];
  },

  /**
   * Earthquakes near the location in the last week.
   *
   * Peninsular Malaysia is seismically quiet, but Sabah is not — the 2015
   * Ranau earthquake killed 18 people — and the Sumatran subduction zone to
   * the west is capable of tsunamigenic events that reach Malaysian coasts.
   */
  async fromQuakes(place) {
    if (!place) return [];
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?' + new URLSearchParams({
      format: 'geojson',
      latitude: round(place.lat, 3),
      longitude: round(place.lon, 3),
      maxradiuskm: 2000,
      starttime: since,
      minmagnitude: 4.5,
      orderby: 'time',
      limit: 40
    });

    const { data } = await request(url, {
      ttl: 15 * 60 * 1000, label: 'usgs',
      cacheKey: `eq:${round(place.lat, 1)}:${round(place.lon, 1)}`
    });

    const features = (data.features || []).map((f) => {
      const [lon, lat, depth] = f.geometry.coordinates;
      return {
        id: f.id,
        mag: f.properties.mag,
        place: f.properties.place,
        time: f.properties.time,
        url: f.properties.url,
        tsunami: f.properties.tsunami === 1,
        alert: f.properties.alert,
        sig: f.properties.sig,
        depth,
        lat, lon,
        distanceKm: haversine({ lat: place.lat, lon: place.lon }, { lat, lon })
      };
    }).sort((a, b) => a.distanceKm - b.distanceKm);

    state.quakes = features;

    const out = [];
    for (const q of features) {
      // Ground motion falls off with distance; these pairings approximate
      // where a quake of a given size is actually felt.
      const notable =
        (q.mag >= 5.0 && q.distanceKm <= 300) ||
        (q.mag >= 6.0 && q.distanceKm <= 800) ||
        (q.mag >= 7.0) ||
        q.tsunami ||
        ['orange', 'red'].includes(q.alert);
      if (!notable) continue;

      let severity = 2;
      if (q.mag >= 7 || q.tsunami || q.alert === 'red') severity = 4;
      else if (q.mag >= 6 || q.alert === 'orange') severity = 3;

      out.push(this.alert({
        id: `quake:${q.id}`,
        kind: 'quake',
        severity,
        title: q.tsunami
          ? `Magnitude ${q.mag} earthquake — tsunami evaluation issued`
          : `Magnitude ${q.mag} earthquake ${Math.round(q.distanceKm)} km away`,
        detail: `${q.place}. Depth ${Math.round(q.depth)} km, ` +
                `${Math.round(q.distanceKm)} km from ${place.name}, ${fmt.relative(q.time)}.`,
        advice: q.tsunami
          ? 'USGS has flagged this event for tsunami evaluation. If you are on the coast, move inland and to higher ground and follow MetMalaysia’s tsunami bulletins rather than waiting for visible signs.'
          : severity >= 3
            ? 'Expect aftershocks. Check for structural cracks before re-entering older buildings, and keep heavy objects off high shelves.'
            : 'No action needed for most people at this distance. Listed for awareness.',
        when: fmt.relative(q.time),
        whenTs: q.time,
        reading: `M${q.mag} · ${Math.round(q.distanceKm)} km · ${Math.round(q.depth)} km deep`,
        link: q.url,
        source: 'USGS Earthquake Hazards Program'
      }));
      if (out.length >= 4) break;
    }
    return out;
  },

  /** Seasonal context — always shown, lowest priority. */
  fromMonsoon(place) {
    const phase = monsoonPhase();
    const affects = monsoonAffectsPlace(phase, place);
    return [this.alert({
      id: `monsoon:${phase.key}`,
      kind: 'season',
      severity: 1,
      title: `${phase.name} (${phase.window})`,
      detail: phase.summary + (affects
        ? ` ${place.state} is among the areas this phase affects most.`
        : ''),
      advice: phase.risks.join(' · '),
      when: 'This season',
      whenTs: Date.now() + 9e12,   // sorts last within its severity
      reading: phase.malay,
      source: 'Malaysian monsoon calendar'
    })];
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 27 · ALERTING
 * ---------------------------------------------------------------------------
 * Desktop notifications plus an audible alarm, both fired only for alerts at
 * or above the severity the user chose, and only once per alert.
 *
 * An honest limit: a static site has no server, so it cannot send Web Push.
 * Alerts therefore fire while a tab is open — which the service worker keeps
 * cheap — and the Settings dialog says so rather than implying otherwise.
 * ═══════════════════════════════════════════════════════════════════════════ */

const Alerting = {
  audio: null,

  /** Permission must be requested from a user gesture, never on load. */
  async requestPermission() {
    if (!('Notification' in window)) {
      toast('This browser does not support notifications.', 'warn');
      return false;
    }
    if (Notification.permission === 'denied') {
      toast('Notifications are blocked for this site. Re-enable them in your browser’s site settings.', 'warn', 7000);
      return false;
    }
    const result = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    state.notifications = result === 'granted';
    saveSettings();
    if (state.notifications) toast('Hazard notifications are on.', 'success');
    return state.notifications;
  },

  /**
   * Two-tone alarm synthesised with WebAudio, so there is no audio file to
   * download and it works offline. The context is created lazily because
   * browsers refuse to start one before a user gesture.
   */
  sound(severity) {
    if (!state.alertSound) return;
    try {
      this.audio = this.audio || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audio;
      if (ctx.state === 'suspended') ctx.resume();

      const beeps = severity >= 4 ? 4 : severity >= 3 ? 2 : 1;
      for (let i = 0; i < beeps; i += 1) {
        const t = ctx.currentTime + i * 0.42;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(severity >= 4 ? 880 : 660, t);
        osc.frequency.setValueAtTime(severity >= 4 ? 660 : 520, t + 0.18);
        // A short ramp instead of a hard stop avoids an audible click.
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
      }
    } catch { /* audio is a nicety, never a failure */ }
  },

  /** Fire for anything new at or above the chosen severity. */
  dispatch(alerts) {
    if (!state.alertsEnabled) return;
    const fresh = alerts.filter((a) =>
      a.severity >= state.alertMinSeverity && !state.seenHazards.has(a.id));
    if (!fresh.length) return;

    for (const a of fresh) state.seenHazards.add(a.id);
    const worst = fresh.reduce((m, a) => (a.severity > m.severity ? a : m), fresh[0]);

    this.sound(worst.severity);
    toast(`${SEVERITY_LABEL[worst.severity]}: ${worst.title}`,
          worst.severity >= 3 ? 'error' : 'warn', 9000);

    if (state.notifications && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`${SEVERITY_LABEL[worst.severity]} · ${state.place?.name ?? 'CuacaMY'}`, {
          body: `${worst.title}\n${worst.detail}`,
          icon: './assets/icon-192.png',
          badge: './assets/icon-192.png',
          tag: worst.id,                    // replaces rather than stacks
          requireInteraction: worst.severity >= 4
        });
        n.onclick = () => { window.focus(); setView('alerts'); n.close(); };
      } catch (err) {
        Telemetry.record('alert', { lvl: 'warn', msg: 'Notification failed: ' + err.message });
      }
    }

    Telemetry.record('alert', {
      lvl: worst.severity >= 3 ? 'error' : 'warn',
      msg: `${fresh.length} new alert(s); worst: ${worst.title}`
    });
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 28 · CLIMATE NORMALS
 * ---------------------------------------------------------------------------
 * "Is this month unusual?" is only answerable against a baseline. Rather than
 * asserting an El Niño signal, this downloads the 1991-2020 daily reanalysis
 * for the exact location, computes the thirty-year mean for each calendar
 * month, and compares the current month against it. The anomaly is therefore
 * measured, and the user can see the arithmetic.
 *
 * It is opt-in: thirty years of daily rows is a few hundred kilobytes, which
 * should never be spent without the user asking. The result is cached in
 * IndexedDB for a year.
 * ═══════════════════════════════════════════════════════════════════════════ */

const Climate = {
  BASE_START: '1991-01-01',
  BASE_END: '2020-12-31',

  cacheKey: (lat, lon) => `climate:${round(lat, 1)}:${round(lon, 1)}`,

  async load(place, { force = false } = {}) {
    const key = this.cacheKey(place.lat, place.lon);
    if (!force) {
      try {
        const hit = await IDB.get('kv', key);
        if (hit && Date.now() - hit.at < 365 * 86400000) return hit.value;
      } catch { /* fall through to the network */ }
    }

    const normals = await this.compute(place);
    try { await IDB.put('kv', { key, value: normals, at: Date.now() }); } catch { /* not fatal */ }
    return normals;
  },

  async compute(place) {
    const started = performance.now();
    const raw = await OpenMeteo.archive(place.lat, place.lon, this.BASE_START, this.BASE_END);
    const times = raw.daily?.time || [];
    const temps = raw.daily?.temperature_2m_mean || [];
    const rain  = raw.daily?.precipitation_sum || [];

    // Accumulate per calendar month, and per month-and-year so monthly rainfall
    // totals can be averaged across the thirty years rather than summed.
    const monthTemp = Array.from({ length: 12 }, () => []);
    const monthYearRain = new Map();

    for (let i = 0; i < times.length; i += 1) {
      const m = Number(times[i].slice(5, 7)) - 1;
      const y = times[i].slice(0, 4);
      if (typeof temps[i] === 'number') monthTemp[m].push(temps[i]);
      if (typeof rain[i] === 'number') {
        const k = `${m}:${y}`;
        monthYearRain.set(k, (monthYearRain.get(k) || 0) + rain[i]);
      }
    }

    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

    const months = [];
    for (let m = 0; m < 12; m += 1) {
      const yearTotals = [...monthYearRain.entries()]
        .filter(([k]) => Number(k.split(':')[0]) === m)
        .map(([, v]) => v);
      months.push({
        month: m,
        meanTempC: avg(monthTemp[m]),
        meanRainMm: avg(yearTotals),
        years: yearTotals.length
      });
    }

    Telemetry.record('climate', {
      lvl: 'perf',
      msg: `Computed 1991-2020 normals from ${times.length} days in ${fmt.ms(performance.now() - started)}`
    });

    return {
      place: { name: place.name, lat: place.lat, lon: place.lon },
      baseline: '1991–2020',
      days: times.length,
      months,
      computedAt: Date.now()
    };
  },

  /** Compare the current month so far against the normal for that month. */
  async anomaly(place) {
    const normals = await this.load(place);
    const now = new Date();
    const m = now.getMonth();
    const normal = normals.months[m];

    // Month-to-date observations come from the same reanalysis, so the
    // comparison is like for like rather than mixing model sources.
    const start = `${now.getFullYear()}-${String(m + 1).padStart(2, '0')}-01`;
    // ERA5 runs behind real time; ask only for days it will actually have.
    const end = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
    let observed = null;

    if (end >= start) {
      try {
        const raw = await OpenMeteo.archive(place.lat, place.lon, start, end);
        const t = (raw.daily?.temperature_2m_mean || []).filter((v) => typeof v === 'number');
        const r = (raw.daily?.precipitation_sum || []).filter((v) => typeof v === 'number');
        if (t.length) {
          observed = {
            meanTempC: t.reduce((a, b) => a + b, 0) / t.length,
            rainMm: r.reduce((a, b) => a + b, 0),
            days: t.length
          };
        }
      } catch { /* the normal alone is still worth showing */ }
    }

    const monthName = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'][m];

    // Rainfall is scaled to the elapsed portion of the month, otherwise a
    // comparison made on the 3rd would always look catastrophically dry.
    const share = observed ? observed.days / new Date(now.getFullYear(), m + 1, 0).getDate() : 0;
    const expectedRain = normal.meanRainMm !== null ? normal.meanRainMm * share : null;

    return {
      normals, normal, observed, monthName,
      tempAnomaly: observed && normal.meanTempC !== null
        ? observed.meanTempC - normal.meanTempC : null,
      rainRatio: observed && expectedRain ? observed.rainMm / expectedRain : null,
      expectedRain
    };
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 29 · ANALYTICAL ASSISTANT
 * ---------------------------------------------------------------------------
 * A deliberate design choice: this reasons over the data already loaded rather
 * than calling a language model.
 *
 * A static site cannot hide an API key, so shipping an LLM integration would
 * mean either exposing a key to every visitor or asking each visitor to paste
 * their own — a real security weakness in a project whose whole claim is that
 * it has none. A deterministic engine instead is auditable, instant, free,
 * works offline, and cannot hallucinate a rainfall figure.
 *
 * It matches intent from the question, computes an answer from state, and
 * shows the readings it used so the reasoning can be checked.
 * ═══════════════════════════════════════════════════════════════════════════ */

const Assistant = {
  history: [],

  suggestions: [
    'Will it rain today?',
    'When is the best time to go out?',
    'Is it safe outside right now?',
    'What should I bring today?',
    'How does this week look?',
    'Why is it so humid?'
  ],

  /** Route a question to a handler. First match wins, so order matters. */
  intents: [
    { name: 'rain',     test: /\b(rain|hujan|wet|umbrella|payung|downpour|storm|ribut|thunder)\b/i },
    { name: 'timing',   test: /\b(best time|when should|good time|go out|outdoor|jog|run|exercise|cycle|walk)\b/i },
    { name: 'safety',   test: /\b(safe|safety|danger|risk|warning|alert|flood|banjir|earthquake|gempa|hazard)\b/i },
    { name: 'bring',    test: /\b(bring|wear|pack|clothes|jacket|what should i)\b/i },
    { name: 'week',     test: /\b(week|5.?day|five.?day|forecast|coming days|tomorrow|esok)\b/i },
    { name: 'humidity', test: /\b(humid|humidity|sticky|lembap|muggy|dew)\b/i },
    { name: 'air',      test: /\b(air|haze|jerebu|pollution|aqi|api|pm2|mask|breath)\b/i },
    { name: 'compare',  test: /\b(compare|versus|vs\.?|cooler than|hotter than|better than)\b/i },
    { name: 'season',   test: /\b(season|monsoon|monsun|el ni|la ni|enso|climate|normal|average)\b/i },
    { name: 'sun',      test: /\b(sun|sunrise|sunset|uv|burn|matahari)\b/i },
    { name: 'now',      test: /\b(now|current|right now|temperature|how hot|how cold|weather)\b/i }
  ],

  ask(question) {
    const q = (question || '').trim();
    if (!q) return null;

    const intent = this.intents.find((i) => i.test.test(q))?.name || 'now';
    const answer = this.answer(intent, q);
    const entry = { q, intent, ...answer, at: Date.now() };
    this.history.push(entry);
    Telemetry.record('assistant', { lvl: 'info', msg: `"${q.slice(0, 48)}" -> ${intent}` });
    return entry;
  },

  answer(intent, q) {
    if (!state.current) {
      return { text: 'I do not have any weather loaded yet. Search for a place, or use the locate button, and ask me again.', facts: [] };
    }
    const fn = this[`_${intent}`] || this._now;
    try { return fn.call(this, q); }
    catch (err) {
      return { text: 'I could not work that one out from the data I have loaded.', facts: [`Error: ${err.message}`] };
    }
  },

  /* ── Handlers. Each returns { text, facts[] }. ──────────────────────────── */

  _now() {
    const c = state.current;
    const dewC = dewPointC(this.tempC(c.main.temp), c.main.humidity);
    return {
      text: `Right now in ${state.place.name} it is ${fmt.temp(c.main.temp, true)} with ${c.weather[0].description}, ` +
            `feeling like ${fmt.temp(c.main.feels_like, true)}. Humidity is ${c.main.humidity}% and the wind is ${fmt.wind(c.wind?.speed)} from the ${fmt.bearing(c.wind?.deg).split(' ')[0]}. ` +
            comfortLabel(dewC).toLowerCase().replace(/^./, (m) => m.toUpperCase()) + '.',
      facts: [`Observed ${fmt.relative(c.dt * 1000)}`,
              `Dew point ${fmt.temp(state.units === 'imperial' ? dewC * 9 / 5 + 32 : dewC)}`,
              `Source: ${state.providerUsed === 'open-meteo' ? 'Open-Meteo' : 'OpenWeatherMap'}`]
    };
  },

  _rain() {
    const next12 = state.hourly.filter((h) => h.dt * 1000 < Date.now() + 12 * 3600 * 1000);
    const wettest = next12.reduce((m, h) => (h.pop > (m?.pop ?? -1) ? h : m), null);
    const today = state.daily[0];

    if (!wettest) return { text: 'I do not have an hourly series loaded for this place.', facts: [] };

    const chance = Math.round(wettest.pop);
    const verdict = chance >= 70 ? 'Yes — rain is likely'
                  : chance >= 40 ? 'Quite possibly'
                  : chance >= 20 ? 'Probably not, but it is not out of the question'
                  : 'Unlikely';

    const dry = next12.filter((h) => h.pop < 25);
    return {
      text: `${verdict}. The wettest point in the next 12 hours is around ${fmt.clock(wettest.dt, wettest.tz)} ` +
            `at a ${chance}% chance, and ${Math.round(today?.precipMm ?? 0)} mm is forecast across the whole day. ` +
            (dry.length
              ? `The driest stretch looks like ${fmt.clock(dry[0].dt, dry[0].tz)}.`
              : 'There is no clearly dry window in that period.'),
      facts: [`Peak probability ${chance}% at ${fmt.clock(wettest.dt, wettest.tz)}`,
              `Daily total ${Math.round(today?.precipMm ?? 0)} mm`,
              today?.precipMm >= 60 ? 'Above MetMalaysia’s 60 mm alert threshold' : 'Below MetMalaysia’s 60 mm alert threshold']
    };
  },

  _timing() {
    const next = state.hourly.filter((h) => h.dt * 1000 > Date.now() - 3600000).slice(0, 8);
    if (!next.length) return { text: 'I need an hourly forecast to answer that.', facts: [] };

    // Lower is better: rain, heat and UV all penalised.
    const scored = next.map((h) => {
      const tC = this.tempC(h.temp);
      const heat = Math.max(0, tC - 30) * 3;
      const cold = Math.max(0, 20 - tC) * 2;
      return { h, score: h.pop * 1.4 + heat + cold + Math.max(0, (h.uvi ?? 0) - 7) * 4 };
    }).sort((a, b) => a.score - b.score);

    const best = scored[0].h;
    const worst = scored[scored.length - 1].h;
    return {
      text: `The best window in the next 24 hours looks like ${fmt.clock(best.dt, best.tz)} — ` +
            `${fmt.temp(best.temp, true)}, ${Math.round(best.pop)}% chance of rain. ` +
            `Avoid around ${fmt.clock(worst.dt, worst.tz)}, which is the least comfortable slot ` +
            `at ${fmt.temp(worst.temp, true)} and ${Math.round(worst.pop)}% rain.`,
      facts: ['Scored on rain probability, heat, cold and UV',
              `Best ${fmt.clock(best.dt, best.tz)} · worst ${fmt.clock(worst.dt, worst.tz)}`]
    };
  },

  _safety() {
    const list = state.hazards.filter((a) => a.severity >= 2);
    if (!list.length) {
      return {
        text: `Nothing is flagged for ${state.place.name} right now. No rainfall, wind, heat, air-quality or seismic threshold is currently exceeded.`,
        facts: [`${state.hazards.length} item(s) checked`, 'Rain, storms, wind, heat, UV, air quality, river discharge, earthquakes']
      };
    }
    const worst = list[0];
    return {
      text: `${list.length} thing${list.length === 1 ? '' : 's'} worth knowing. The most serious is a ` +
            `${SEVERITY_LABEL[worst.severity].toLowerCase()}: ${worst.title}. ${worst.detail} ${worst.advice}`,
      facts: list.slice(0, 4).map((a) => `${SEVERITY_LABEL[a.severity]}: ${a.title} (${a.reading})`)
    };
  },

  _bring() {
    const c = state.current;
    const today = state.daily[0];
    const items = [];
    if ((today?.pop ?? 0) > 0.3 || (today?.precipMm ?? 0) > 5) items.push('an umbrella or a light rain jacket');
    if ((today?.uvMax ?? 0) >= 8) items.push('sunscreen and a hat');
    if (this.tempC(c.main.temp) >= 31) items.push('more water than you think you need');
    if (state.airIndex && state.airIndex.value > 100) items.push('an N95 mask for the haze');
    if (this.tempC(today?.min ?? 25) <= 20) items.push('a layer for the evening');
    if (!items.length) items.push('nothing special — it is a straightforward day');

    return {
      text: `For ${state.place.name} today: ${items.join(', ')}. ` +
            `Expect a high of ${fmt.temp(today?.max, true)} and a low of ${fmt.temp(today?.min, true)}.`,
      facts: [`Rain chance ${Math.round((today?.pop ?? 0) * 100)}%`,
              `UV peak ${Math.round(today?.uvMax ?? 0)}`,
              state.airIndex ? `Air Pollutant Index ${state.airIndex.value}` : 'Air quality unavailable']
    };
  },

  _week() {
    if (!state.daily.length) return { text: 'No forecast is loaded yet.', facts: [] };
    const wettest = state.daily.reduce((m, d) => ((d.precipMm ?? 0) > (m.precipMm ?? 0) ? d : m));
    const hottest = state.daily.reduce((m, d) => (d.max > m.max ? d : m));
    const totalRain = state.daily.reduce((a, d) => a + (d.precipMm ?? 0), 0);

    return {
      text: `Over the next ${state.daily.length} days in ${state.place.name}, expect around ${Math.round(totalRain)} mm of rain in total. ` +
            `${fmt.dayName(wettest.dt, wettest.tz, true)} looks wettest at ${Math.round(wettest.precipMm ?? 0)} mm, and ` +
            `${fmt.dayName(hottest.dt, hottest.tz, true)} the hottest at ${fmt.temp(hottest.max, true)}.`,
      facts: state.daily.map((d) =>
        `${fmt.dayName(d.dt, d.tz)} ${fmt.temp(d.max)}/${fmt.temp(d.min)} · ${Math.round(d.precipMm ?? 0)} mm · ${Math.round(d.pop * 100)}% rain`)
    };
  },

  _humidity() {
    const c = state.current;
    const dewC = dewPointC(this.tempC(c.main.temp), c.main.humidity);
    return {
      text: `Humidity is ${c.main.humidity}%, and the dew point — the number that actually governs how sticky air feels — ` +
            `is ${fmt.temp(state.units === 'imperial' ? dewC * 9 / 5 + 32 : dewC, true)}. ${comfortLabel(dewC)}. ` +
            'Above about 24 °C dew point, sweat stops evaporating efficiently, which is why ' +
            `${fmt.temp(c.main.temp)} in Malaysia is harder work than the same reading in a dry climate.`,
      facts: [`Relative humidity ${c.main.humidity}%`,
              `Dew point ${fmt.temp(state.units === 'imperial' ? dewC * 9 / 5 + 32 : dewC, true)}`,
              `Feels like ${fmt.temp(c.main.feels_like, true)} vs actual ${fmt.temp(c.main.temp, true)}`]
    };
  },

  _air() {
    const idx = state.airIndex;
    if (!idx) return { text: 'Air quality data has not loaded for this place.', facts: [] };
    return {
      text: `The Air Pollutant Index here is about ${idx.value} — ${idx.label.toLowerCase()}, driven by ${idx.driver}. ${idx.note}`,
      facts: [`API ${idx.value} (${idx.label})`,
              `Driven by ${idx.driver}`,
              'Modelled estimate, not a DOE station reading']
    };
  },

  _compare() {
    if (!state.favourites.length) {
      return {
        text: 'Save a couple of places first and I can compare them. There is also a live comparison of all 16 state capitals under Explore Malaysia.',
        facts: []
      };
    }
    return {
      text: `You have ${state.favourites.length} saved place${state.favourites.length === 1 ? '' : 's'}: ` +
            `${state.favourites.map((f) => f.name).join(', ')}. Their current temperatures are on the dashboard, ` +
            'and Explore Malaysia compares every state capital side by side.',
      facts: state.favourites.map((f) => `${f.name}${f.state ? ', ' + f.state : ''}`)
    };
  },

  _season() {
    const phase = monsoonPhase();
    const affects = monsoonAffectsPlace(phase, state.place);
    return {
      text: `Malaysia is in the ${phase.name.toLowerCase()} (${phase.window}). ${phase.summary} ` +
            (affects ? `${state.place.state} is one of the areas this phase affects most.`
                     : `${state.place.state || state.place.name} is not among the areas it hits hardest.`),
      facts: phase.risks
    };
  },

  _sun() {
    const c = state.current;
    const tz = c.timezone ?? 0;
    const uv = state.daily[0]?.uvMax;
    return {
      text: `Sunrise is at ${fmt.clock(c.sys.sunrise, tz)} and sunset at ${fmt.clock(c.sys.sunset, tz)}, ` +
            `giving about ${round((c.sys.sunset - c.sys.sunrise) / 3600, 1)} hours of daylight. ` +
            (uv ? `UV peaks near ${Math.round(uv)} today${uv >= 8 ? ', which is high enough to burn unprotected skin quickly' : ''}.` : ''),
      facts: [`Sunrise ${fmt.clock(c.sys.sunrise, tz)}`, `Sunset ${fmt.clock(c.sys.sunset, tz)}`,
              uv ? `Peak UV ${Math.round(uv)}` : 'UV unavailable']
    };
  },

  tempC(v) { return state.units === 'imperial' ? (v - 32) * 5 / 9 : v; },

  /** A short standing summary, shown before anything is asked. */
  briefing() {
    if (!state.current || !state.daily.length) return null;
    const c = state.current;
    const today = state.daily[0];
    const worst = state.hazards.find((a) => a.severity >= 2);
    const phase = monsoonPhase();

    return `${state.place.name} is ${fmt.temp(c.main.temp, true)} with ${c.weather[0].description}. ` +
           `Today runs ${fmt.temp(today.min)} to ${fmt.temp(today.max)} with ${Math.round(today.pop * 100)}% rain chance ` +
           `and about ${Math.round(today.precipMm ?? 0)} mm expected. ` +
           (worst ? `${SEVERITY_LABEL[worst.severity]}: ${worst.title}. ` : 'Nothing is currently flagged. ') +
           `We are in the ${phase.name.toLowerCase()}.`;
  }
};


/* ═══════════════════════════════════════════════════════════════════════════
 * 30 · RENDERING — ALERTS, CLIMATE, ASSISTANT
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Malaysian Air Pollutant Index from whichever pollutant data we have. */
function computeAirIndex() {
  const air = state.air;
  if (!air) return null;
  // 24-hour means are what the index is defined on; the current reading is
  // used only when the provider gives no hourly history.
  const pm25 = air.pm25_24h ?? air.list?.[0]?.components?.pm2_5 ?? null;
  const pm10 = air.pm10_24h ?? air.list?.[0]?.components?.pm10 ?? null;
  return malaysianAPI(pm25, pm10);
}

/** Run the hazard sweep and repaint everything that depends on it. */
async function runHazards() {
  if (!state.place) return;
  const strip = $('#hazard-strip');
  strip.dataset.state = 'loading';
  strip.dataset.tone = 'info';
  strip.replaceChildren(
    icon('i-shield', 'hazard-strip__icon'),
    el('div', {}, [
      el('strong', { textContent: 'Checking for hazards…' }),
      el('span', { textContent: 'Rainfall, storms, wind, heat, UV, air quality, river levels and earthquakes.' })
    ])
  );

  try {
    state.hazards = await Hazards.assess(state.place);
  } catch (err) {
    state.hazards = [];
    Telemetry.record('hazard', { lvl: 'error', msg: 'Hazard sweep failed: ' + err.message });
  }

  strip.dataset.state = 'ready';
  renderHazardStrip();
  renderAlertsView();
  renderAssistant();
  Alerting.dispatch(state.hazards);
}

/** The compact banner on the dashboard: worst alert, or an all-clear. */
function renderHazardStrip() {
  const strip = $('#hazard-strip');
  strip.replaceChildren();

  const actionable = state.hazards.filter((a) => a.severity >= 2);
  const count = $('#tab-alerts-count');

  if (count) {
    count.textContent = actionable.length ? String(actionable.length) : '';
    count.hidden = actionable.length === 0;
    count.dataset.tone = actionable.some((a) => a.severity >= 4) ? 'severe'
                       : actionable.some((a) => a.severity >= 3) ? 'warn' : 'ok';
  }

  if (!actionable.length) {
    strip.dataset.tone = 'clear';
    strip.appendChild(icon('i-shield', 'hazard-strip__icon'));
    strip.appendChild(el('div', {}, [
      el('strong', { textContent: 'No active alerts' }),
      el('span', { textContent: `Rain, storms, wind, heat, UV, air quality, river levels and earthquakes all checked for ${state.place.name}.` })
    ]));
    return;
  }

  const worst = actionable[0];
  strip.dataset.tone = SEVERITY_TONE[worst.severity];
  strip.appendChild(icon(hazardIcon(worst.kind), 'hazard-strip__icon'));
  strip.appendChild(el('div', {}, [
    el('strong', { textContent: `${SEVERITY_LABEL[worst.severity]} · ${worst.title}` }),
    el('span', { textContent: worst.detail })
  ]));

  const more = el('button', { className: 'hazard-strip__cta', type: 'button' },
    [actionable.length > 1 ? `See all ${actionable.length}` : 'Details']);
  more.addEventListener('click', () => setView('alerts'));
  strip.appendChild(more);
}

const HAZARD_ICONS = {
  rain: 'wx-rain', storm: 'wx-thunder', wind: 'i-wind', heat: 'i-sun-ui',
  uv: 'i-sun-ui', haze: 'i-leaf', flood: 'i-drop', quake: 'i-quake', season: 'i-calendar'
};
const hazardIcon = (kind) => HAZARD_ICONS[kind] || 'i-shield';

function renderAlertsView() {
  const host = $('#alerts-list');
  host.replaceChildren();

  const summary = $('#alerts-summary');
  const actionable = state.hazards.filter((a) => a.severity >= 2);
  summary.textContent = state.hazards.length
    ? (actionable.length
        ? `${actionable.length} active alert${actionable.length === 1 ? '' : 's'} for ${state.place.name}. Checked: rainfall, storms, wind, heat, UV, air quality, river discharge and seismic activity.`
        : `Nothing active for ${state.place.name}. Rainfall, storms, wind, heat, UV, air quality, river discharge and seismic activity were all checked and none crossed a warning threshold.`)
    : 'Running checks…';

  if (!state.hazards.length) {
    host.appendChild(el('p', { className: 'empty', textContent: 'No hazard data yet.' }));
  }

  for (const a of state.hazards) {
    const card = el('article', { className: 'alert', dataset: { tone: SEVERITY_TONE[a.severity] } });

    const head = el('div', { className: 'alert__head' });
    head.appendChild(icon(hazardIcon(a.kind), 'alert__icon'));
    head.appendChild(el('div', { className: 'alert__titles' }, [
      el('span', { className: 'alert__sev', textContent: SEVERITY_LABEL[a.severity] }),
      el('h3', { className: 'alert__title', textContent: a.title })
    ]));
    head.appendChild(el('span', { className: 'alert__when', textContent: a.when }));
    card.appendChild(head);

    card.appendChild(el('p', { className: 'alert__detail', textContent: a.detail }));
    card.appendChild(el('p', { className: 'alert__advice' }, [
      el('strong', { textContent: 'What to do: ' }),
      document.createTextNode(a.advice)
    ]));

    const foot = el('div', { className: 'alert__foot' });
    if (a.reading) foot.appendChild(el('code', { textContent: a.reading }));
    foot.appendChild(el('span', { className: 'alert__source', textContent: a.source }));
    if (a.link) {
      foot.appendChild(el('a', {
        href: a.link, target: '_blank', rel: 'noopener noreferrer',
        className: 'alert__link', textContent: 'Official source ↗'
      }));
    }
    card.appendChild(foot);
    host.appendChild(card);
  }

  renderQuakeList();
  renderFloodPanel();
  renderMonsoonPanel();
}

function renderQuakeList() {
  const host = $('#quake-list');
  const empty = $('#quake-empty');
  host.replaceChildren();

  if (!state.quakes.length) { empty.hidden = false; return; }
  empty.hidden = true;

  for (const q of state.quakes.slice(0, 8)) {
    const row = el('a', {
      className: 'quake', href: q.url, target: '_blank', rel: 'noopener noreferrer'
    });
    const magTone = q.mag >= 7 ? 'severe' : q.mag >= 6 ? 'warn' : q.mag >= 5 ? 'ok' : 'info';
    row.appendChild(el('span', { className: 'quake__mag', dataset: { tone: magTone },
                                 textContent: q.mag?.toFixed(1) ?? '—' }));
    row.appendChild(el('div', {}, [
      el('div', { className: 'quake__place', textContent: q.place || 'Unknown location' }),
      el('div', { className: 'quake__meta',
                  textContent: `${Math.round(q.distanceKm)} km away · ${Math.round(q.depth)} km deep · ${fmt.relative(q.time)}` })
    ]));
    if (q.tsunami) row.appendChild(el('span', { className: 'quake__flag', textContent: 'Tsunami' }));
    host.appendChild(row);
  }
}

function renderFloodPanel() {
  const wrap = $('#flood-panel');
  const f = state.flood;
  if (!f) { wrap.hidden = true; return; }
  wrap.hidden = false;

  $('#flood-now').textContent = `${round(f.today, 2)} m³/s`;
  $('#flood-median').textContent = `${round(f.median, 2)} m³/s`;
  $('#flood-peak').textContent = `${round(f.peak, 2)} m³/s`;

  const ratio = f.median ? f.peak / f.median : 0;
  const label = ratio >= 4 ? 'Well above normal' : ratio >= 2.5 ? 'Above normal'
              : ratio >= 1.5 ? 'Slightly elevated' : 'Within normal range';
  $('#flood-verdict').textContent = label;
  $('#flood-verdict').dataset.tone = ratio >= 4 ? 'warn' : ratio >= 2.5 ? 'ok' : 'info';

  renderFloodChart();
}

function renderFloodChart() {
  const canvas = $('#flood-chart');
  if (!canvas || !state.flood || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const series = state.flood.series.slice(0, 30);
  if (!series.length) return;

  const max = Math.max(...series) * 1.15 || 1;
  const barW = (w - 8) / series.length;
  const median = state.flood.median;

  series.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * (h - 26));
    const x = 4 + i * barW;
    ctx.fillStyle = v > median * 2.5 ? themeColor('--c-bad', '#f87171')
                  : v > median * 1.5 ? themeColor('--c-warn', '#fbbf24')
                  : themeColor('--c-brand-400', '#47a8ff');
    roundRect(ctx, x, h - 20 - bh, Math.max(2, barW - 2), bh, 2);
    ctx.fill();
  });

  // Median reference line, so "above normal" is visible rather than asserted.
  const my = h - 20 - (median / max) * (h - 26);
  ctx.strokeStyle = themeColor('--text-dim', '#6b7899');
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(4, my); ctx.lineTo(w - 4, my); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = themeColor('--text-dim', '#6b7899');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('90-day median', 6, my - 4);
  ctx.fillText('next 30 days →', 6, h - 5);
}

function renderMonsoonPanel() {
  const phase = monsoonPhase();
  const affects = monsoonAffectsPlace(phase, state.place);

  $('#monsoon-name').textContent = phase.name;
  $('#monsoon-malay').textContent = phase.malay;
  $('#monsoon-window').textContent = phase.window;
  $('#monsoon-summary').textContent = phase.summary;

  const badge = $('#monsoon-affects');
  badge.hidden = !affects;
  if (affects) badge.textContent = `${state.place.state} is in the main impact zone`;

  const risks = $('#monsoon-risks');
  risks.replaceChildren();
  for (const r of phase.risks) risks.appendChild(el('li', { textContent: r }));

  const bar = $('#monsoon-bar');
  bar.replaceChildren();
  const order = [
    { key: 'northeast', label: 'NE monsoon', months: 'Nov–Mar' },
    { key: 'interNorth', label: 'Inter-monsoon', months: 'Apr–May' },
    { key: 'southwest', label: 'SW monsoon', months: 'Jun–Sep' },
    { key: 'interSouth', label: 'Inter-monsoon', months: 'Oct' }
  ];
  for (const seg of order) {
    bar.appendChild(el('div', {
      className: 'monsoon-seg' + (seg.key === phase.key ? ' is-active' : '')
    }, [
      el('strong', { textContent: seg.label }),
      el('span', { textContent: seg.months })
    ]));
  }
}

/* ── Climate ──────────────────────────────────────────────────────────────── */

async function renderClimate({ force = false } = {}) {
  const status = $('#climate-status');
  const body = $('#climate-body');
  if (!state.place) return;

  status.textContent = 'Downloading 30 years of daily reanalysis for this exact location…';
  status.hidden = false;
  $('#btn-climate').disabled = true;

  try {
    const a = await Climate.anomaly(state.place, { force });
    state.climate = a;
    status.hidden = true;
    body.hidden = false;

    $('#climate-place').textContent = `${state.place.name} · baseline ${a.normals.baseline} (${a.normals.days.toLocaleString()} days)`;
    $('#climate-month').textContent = a.monthName;
    $('#climate-normal-temp').textContent = a.normal.meanTempC !== null ? `${round(a.normal.meanTempC, 1)} °C` : '—';
    $('#climate-normal-rain').textContent = a.normal.meanRainMm !== null ? `${Math.round(a.normal.meanRainMm)} mm` : '—';

    if (a.observed) {
      $('#climate-actual-temp').textContent = `${round(a.observed.meanTempC, 1)} °C`;
      $('#climate-actual-rain').textContent = `${Math.round(a.observed.rainMm)} mm`;

      const t = a.tempAnomaly;
      const tNode = $('#climate-temp-anom');
      tNode.textContent = t === null ? '—'
        : `${t >= 0 ? '+' : ''}${round(t, 1)} °C vs normal`;
      tNode.dataset.tone = t === null ? 'info' : t > 1 ? 'warn' : t < -1 ? 'ok' : 'info';

      const r = a.rainRatio;
      const rNode = $('#climate-rain-anom');
      rNode.textContent = r === null ? '—'
        : r >= 1.3 ? `${Math.round((r - 1) * 100)}% wetter than normal so far`
        : r <= 0.7 ? `${Math.round((1 - r) * 100)}% drier than normal so far`
        : 'Close to normal so far';
      rNode.dataset.tone = r === null ? 'info' : (r >= 1.5 || r <= 0.5) ? 'warn' : 'info';

      $('#climate-note').textContent =
        `Month-to-date covers ${a.observed.days} day${a.observed.days === 1 ? '' : 's'}, so rainfall is compared against ` +
        `the same fraction of the monthly normal (${Math.round(a.expectedRain)} mm expected by now). ` +
        'A warm, dry anomaly in Malaysia is the local fingerprint of El Niño; a cool, wet one, of La Niña. ' +
        'This is measured from reanalysis for your coordinates, not read from an ENSO bulletin.';
    } else {
      $('#climate-note').textContent = 'The current month has no finalised reanalysis days yet — check back in a few days.';
    }

    renderClimateChart(a.normals);
  } catch (err) {
    status.textContent = `Could not compute the climate normal: ${err.message}`;
    Telemetry.record('climate', { lvl: 'error', msg: err.message });
  } finally {
    $('#btn-climate').disabled = false;
  }
}

function renderClimateChart(normals) {
  const canvas = $('#climate-chart');
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);

  const rain = normals.months.map((m) => m.meanRainMm ?? 0);
  const temp = normals.months.map((m) => m.meanTempC ?? 0);
  const maxRain = Math.max(...rain) * 1.2 || 1;
  const minT = Math.min(...temp) - 1, maxT = Math.max(...temp) + 1;

  const padB = 26, padT = 14;
  const plotH = h - padB - padT;
  const barW = (w - 8) / 12;
  const labels = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  const nowMonth = new Date().getMonth();

  rain.forEach((v, i) => {
    const bh = (v / maxRain) * plotH;
    const x = 4 + i * barW;
    ctx.fillStyle = i === nowMonth
      ? themeColor('--c-brand-400', '#47a8ff')
      : hexToRgba(themeColor('--c-brand-500', '#1e86f0'), 0.35);
    roundRect(ctx, x + 2, padT + plotH - bh, barW - 6, bh, 3);
    ctx.fill();
  });

  ctx.beginPath();
  temp.forEach((v, i) => {
    const x = 4 + i * barW + barW / 2;
    const y = padT + plotH - ((v - minT) / (maxT - minT)) * plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = themeColor('--c-accent-500', '#ff9f1c');
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.fillStyle = themeColor('--text-dim', '#6b7899');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((l, i) => ctx.fillText(l, 4 + i * barW + barW / 2, h - 9));
  ctx.textAlign = 'left';
  ctx.fillText(`bars: mean monthly rain (peak ${Math.round(Math.max(...rain))} mm) · line: mean temperature`, 6, 11);
}

/* ── Assistant ────────────────────────────────────────────────────────────── */

function renderAssistant() {
  const brief = Assistant.briefing();
  const node = $('#assistant-briefing');
  if (node) node.textContent = brief || 'Load a location to get a briefing.';

  const chips = $('#assistant-chips');
  if (chips && !chips.childElementCount) {
    for (const q of Assistant.suggestions) {
      const chip = el('button', { className: 'ask-chip', type: 'button', textContent: q });
      chip.addEventListener('click', () => { $('#assistant-input').value = q; askAssistant(); });
      chips.appendChild(chip);
    }
  }
}

function askAssistant() {
  const input = $('#assistant-input');
  const q = input.value.trim();
  if (!q) return;

  const entry = Assistant.ask(q);
  if (!entry) return;

  const log = $('#assistant-log');
  log.appendChild(el('div', { className: 'ask ask--q' }, [
    el('span', { className: 'ask__who', textContent: 'You' }),
    el('p', { textContent: entry.q })
  ]));

  const answer = el('div', { className: 'ask ask--a' });
  answer.appendChild(el('span', { className: 'ask__who', textContent: 'CuacaMY' }));
  answer.appendChild(el('p', { textContent: entry.text }));
  if (entry.facts?.length) {
    const facts = el('ul', { className: 'ask__facts' });
    for (const f of entry.facts) facts.appendChild(el('li', { textContent: f }));
    answer.appendChild(facts);
  }
  log.appendChild(answer);

  input.value = '';
  log.scrollTop = log.scrollHeight;
  $('#assistant-empty').hidden = true;
}


/* ═══════════════════════════════════════════════════════════════════════════
 * 31 · WEATHER ANALYSIS
 * ---------------------------------------------------------------------------
 * The meteorology, separated from the drawing. Everything here is arithmetic
 * over one hourly record set — no network, no DOM — so each figure can be
 * checked against the raw series it came from.
 *
 * The record set spans 7 days behind and 7 days ahead, giving 336 hourly
 * observations. That is enough for a diurnal cycle to emerge from the noise
 * and for spell-length and correlation statistics to mean something; a single
 * forecast day is not.
 * ═══════════════════════════════════════════════════════════════════════════ */

const WxData = {
  cache: new Map(),

  /** Fetch and shape the analysis record set for a place. */
  async load(place, units) {
    const key = `${round(place.lat, 2)}:${round(place.lon, 2)}:${units}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.value;

    const url = OpenMeteo.url(OM.forecast, {
      latitude: round(place.lat, 4),
      longitude: round(place.lon, 4),
      hourly: 'temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,' +
              'precipitation,precipitation_probability,weather_code,pressure_msl,cloud_cover,' +
              'visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day,' +
              'shortwave_radiation',
      daily: 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,' +
             'precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,' +
             'wind_direction_10m_dominant,uv_index_max,shortwave_radiation_sum,sunrise,sunset',
      timezone: 'auto',
      past_days: 7,
      forecast_days: 7,
      ...OpenMeteo.units(units)
    });

    const { data } = await fetchJSON(url, { label: 'analysis', timeout: 20000 });
    const shaped = this.shape(data, units);
    this.cache.set(key, { value: shaped, at: Date.now() });
    return shaped;
  },

  /** Flatten the parallel arrays into records and attach derived fields. */
  shape(raw, units) {
    const tz = raw.utc_offset_seconds ?? 0;
    const h = raw.hourly || {};
    const d = raw.daily || {};
    const nowSec = Math.floor(Date.now() / 1000);
    const toC = (v) => (units === 'imperial' ? (v - 32) * 5 / 9 : v);
    const kmh = (v) => (units === 'imperial' ? v * 1.609344 : v * 3.6);

    const hours = (h.time || []).map((t, i) => {
      const dt = omTime(t, tz);
      const tempC = toC(h.temperature_2m?.[i]);
      const rh = h.relative_humidity_2m?.[i];
      return {
        dt, tz,
        localHour: new Date((dt + tz) * 1000).getUTCHours(),
        localDay: Math.floor((dt + tz) / 86400),
        past: dt <= nowSec,
        temp: h.temperature_2m?.[i],
        tempC,
        feels: h.apparent_temperature?.[i],
        dew: h.dew_point_2m?.[i],
        rh,
        precip: h.precipitation?.[i] ?? 0,
        pop: h.precipitation_probability?.[i] ?? 0,
        code: h.weather_code?.[i],
        pressure: h.pressure_msl?.[i],
        cloud: h.cloud_cover?.[i],
        visibility: h.visibility?.[i],
        windKmh: kmh(h.wind_speed_10m?.[i] ?? 0),
        gustKmh: kmh(h.wind_gusts_10m?.[i] ?? 0),
        windDir: h.wind_direction_10m?.[i],
        uv: h.uv_index?.[i],
        isDay: h.is_day?.[i] === 1,
        radiation: h.shortwave_radiation?.[i],
        heatIndexC: heatIndexC(tempC, rh),
        wbgtC: wbgtEstimateC(tempC, rh, h.shortwave_radiation?.[i], h.wind_speed_10m?.[i])
      };
    }).filter((r) => typeof r.temp === 'number');

    const days = (d.time || []).map((t, i) => ({
      date: t,
      dt: omTime(t + 'T12:00', tz),
      max: d.temperature_2m_max?.[i],
      min: d.temperature_2m_min?.[i],
      mean: d.temperature_2m_mean?.[i],
      precip: d.precipitation_sum?.[i] ?? 0,
      precipHours: d.precipitation_hours?.[i] ?? 0,
      windMax: kmh(d.wind_speed_10m_max?.[i] ?? 0),
      gustMax: kmh(d.wind_gusts_10m_max?.[i] ?? 0),
      windDir: d.wind_direction_10m_dominant?.[i],
      uvMax: d.uv_index_max?.[i],
      radiation: d.shortwave_radiation_sum?.[i],
      past: omTime(t + 'T12:00', tz) <= nowSec
    }));

    return { hours, days, tz, units, generatedAt: Date.now() };
  }
};

/* ── Meteorological formulae ──────────────────────────────────────────────── */

/**
 * NOAA/Rothfusz heat index, in °C.
 *
 * The regression is defined in Fahrenheit, so the conversion happens inside.
 * Below 80 °F it is not valid and Steadman's simpler form is used instead —
 * without that guard the polynomial reports absurd values on a mild morning.
 */
function heatIndexC(tempC, rh) {
  if (typeof tempC !== 'number' || typeof rh !== 'number') return null;
  const T = tempC * 9 / 5 + 32;
  const R = clamp(rh, 0, 100);

  let hi = 0.5 * (T + 61 + ((T - 68) * 1.2) + (R * 0.094));
  if ((hi + T) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * T + 10.14333127 * R
       - 0.22475541 * T * R - 0.00683783 * T * T
       - 0.05481717 * R * R + 0.00122874 * T * T * R
       + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    // The two documented corrections at the extremes of the valid range.
    if (R < 13 && T >= 80 && T <= 112) hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (R > 85 && T >= 80 && T <= 87) hi += ((R - 85) / 10) * ((87 - T) / 5);
  }
  return (hi - 32) * 5 / 9;
}

/**
 * Wet Bulb Globe Temperature, estimated.
 *
 * WBGT is the standard for occupational heat stress and matters far more than
 * air temperature in a humid climate — Malaysian outdoor work is governed by
 * it. A true reading needs a black-globe thermometer, so this uses the
 * Australian BoM approximation for the shaded natural wet bulb, nudged for
 * solar load and wind. It is an estimate and the UI says so.
 */
function wbgtEstimateC(tempC, rh, radiation, windMs) {
  if (typeof tempC !== 'number' || typeof rh !== 'number') return null;
  // Vapour pressure (hPa) from temperature and relative humidity.
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  let wbgt = 0.567 * tempC + 0.393 * e + 3.94;
  // Direct sun raises the globe temperature; wind ventilates it.
  if (typeof radiation === 'number' && radiation > 0) {
    wbgt += Math.min(3, (radiation / 1000) * 3);
    if (typeof windMs === 'number') wbgt -= Math.min(1.5, windMs * 0.25);
  }
  return wbgt;
}

/** Descriptive statistics for one numeric series. */
function describe(values) {
  const v = values.filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  return {
    n: v.length,
    mean,
    median: percentile(v, 0.5),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    sd: Math.sqrt(variance),
    p10: percentile(v, 0.1),
    p90: percentile(v, 0.9),
    range: sorted[sorted.length - 1] - sorted[0]
  };
}

/** Least-squares slope of y against index, returned per day. */
function trendPerDay(values, hoursPerStep = 1) {
  const pts = values.map((y, i) => [i, y]).filter(([, y]) => typeof y === 'number');
  if (pts.length < 4) return null;
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slopePerStep = (n * sxy - sx * sy) / denom;
  return slopePerStep * (24 / hoursPerStep);
}

/** Pearson correlation between two aligned series. */
function correlation(a, b) {
  const pairs = a.map((x, i) => [x, b[i]])
    .filter(([x, y]) => typeof x === 'number' && typeof y === 'number');
  if (pairs.length < 6) return null;
  const n = pairs.length;
  const ma = pairs.reduce((s, [x]) => s + x, 0) / n;
  const mb = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (const [x, y] of pairs) {
    num += (x - ma) * (y - mb);
    da += (x - ma) ** 2;
    db += (y - mb) ** 2;
  }
  const den = Math.sqrt(da * db);
  return den ? num / den : null;
}

/** Mean of a variable bucketed by hour of local day. */
function diurnal(hours, field) {
  const buckets = Array.from({ length: 24 }, () => []);
  for (const r of hours) {
    const v = r[field];
    if (typeof v === 'number') buckets[r.localHour].push(v);
  }
  return buckets.map((b, hour) => ({
    hour,
    mean: b.length ? b.reduce((a, x) => a + x, 0) / b.length : null,
    n: b.length
  }));
}

/**
 * Wind rose: 16 compass sectors × four Beaufort-ish speed bins.
 * Returns counts as a fraction of all observations, so sectors are comparable
 * regardless of how many hours are in the record set.
 */
const ROSE_BINS = [
  { label: '< 5 km/h', max: 5 },
  { label: '5–15', max: 15 },
  { label: '15–25', max: 25 },
  { label: '25+', max: Infinity }
];

function windRose(hours) {
  const sectors = Array.from({ length: 16 }, () => ROSE_BINS.map(() => 0));
  let calm = 0, total = 0;

  for (const r of hours) {
    if (typeof r.windDir !== 'number' || typeof r.windKmh !== 'number') continue;
    total += 1;
    if (r.windKmh < 1) { calm += 1; continue; }
    const sector = Math.round(r.windDir / 22.5) % 16;
    const bin = ROSE_BINS.findIndex((b) => r.windKmh < b.max);
    sectors[sector][bin === -1 ? ROSE_BINS.length - 1 : bin] += 1;
  }

  const max = Math.max(...sectors.map((s) => s.reduce((a, b) => a + b, 0)), 1);
  const dominant = sectors
    .map((s, i) => ({ i, n: s.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.n - a.n)[0];

  return {
    sectors, total, calm, max,
    calmPct: total ? (calm / total) * 100 : 0,
    dominantSector: dominant?.i ?? 0,
    dominantPct: total ? (dominant.n / total) * 100 : 0
  };
}

const COMPASS_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

/** Longest run of consecutive days satisfying a predicate. */
function longestRun(items, predicate) {
  let best = 0, run = 0;
  for (const item of items) {
    if (predicate(item)) { run += 1; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

/**
 * Three-hour pressure tendency, the classic short-range storm signal.
 * A fall of 3 hPa or more in three hours is the traditional threshold.
 */
function pressureTendency(hours) {
  const withP = hours.filter((r) => typeof r.pressure === 'number');
  if (withP.length < 4) return null;
  const nowIndex = withP.findIndex((r) => !r.past);
  const i = nowIndex > 3 ? nowIndex : withP.length - 1;
  const change = withP[i].pressure - withP[Math.max(0, i - 3)].pressure;
  return {
    change,
    label: change <= -3 ? 'Falling rapidly' : change <= -1 ? 'Falling'
         : change >= 3 ? 'Rising rapidly' : change >= 1 ? 'Rising' : 'Steady',
    meaning: change <= -3
      ? 'A fall of 3 hPa or more in three hours is the classic signal of an approaching storm or squall line.'
      : change <= -1 ? 'Slowly falling pressure often precedes cloud and showers.'
      : change >= 3 ? 'Rapidly rising pressure usually follows a system clearing through.'
      : change >= 1 ? 'Rising pressure generally means settling, drier conditions.'
      : 'Pressure is steady, so no rapid change of air mass is indicated.'
  };
}

/** Hours spent in each heat-stress band, on the WBGT scale. */
const HEAT_BANDS = [
  { max: 25,       label: 'Low',       tone: 'ok',     advice: 'Normal activity.' },
  { max: 28,       label: 'Moderate',  tone: 'info',   advice: 'Take breaks and drink regularly during sustained effort.' },
  { max: 30,       label: 'High',      tone: 'warn',   advice: 'Limit strenuous outdoor work; rest 15 minutes each hour.' },
  { max: 32,       label: 'Very high', tone: 'bad',    advice: 'Curtail heavy work; rest 30 minutes each hour, in shade.' },
  { max: Infinity, label: 'Extreme',   tone: 'severe', advice: 'Suspend strenuous outdoor work.' }
];

function heatStressProfile(hours) {
  const counts = HEAT_BANDS.map(() => 0);
  let daylightPeak = null;
  for (const r of hours) {
    if (typeof r.wbgtC !== 'number') continue;
    const i = HEAT_BANDS.findIndex((b) => r.wbgtC < b.max);
    counts[i === -1 ? HEAT_BANDS.length - 1 : i] += 1;
    if (r.isDay && (!daylightPeak || r.wbgtC > daylightPeak.wbgtC)) daylightPeak = r;
  }
  return { counts, daylightPeak, total: counts.reduce((a, b) => a + b, 0) };
}

/** Rainfall structure: totals, intensity, and how the wet hours cluster. */
function rainfallProfile(data) {
  const wetHours = data.hours.filter((r) => r.precip > 0.1);
  const intensities = wetHours.map((r) => r.precip);
  const total = data.hours.reduce((a, r) => a + (r.precip || 0), 0);
  const dryDays = data.days.filter((d) => d.precip < 1).length;

  return {
    total,
    wetHours: wetHours.length,
    totalHours: data.hours.length,
    wetFraction: data.hours.length ? wetHours.length / data.hours.length : 0,
    peakHourly: intensities.length ? Math.max(...intensities) : 0,
    meanIntensity: intensities.length ? intensities.reduce((a, b) => a + b, 0) / intensities.length : 0,
    dryDays,
    longestDrySpell: longestRun(data.days, (d) => d.precip < 1),
    longestWetSpell: longestRun(data.days, (d) => d.precip >= 1),
    wettestDay: data.days.reduce((m, d) => (d.precip > (m?.precip ?? -1) ? d : m), null),
    // When during the day does rain actually fall? The answer is the single
    // most useful planning fact in a tropical climate.
    byHour: diurnal(data.hours, 'precip')
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 32 · ANALYSIS CHARTS
 * ---------------------------------------------------------------------------
 * Canvas, no library. Three rules govern everything below:
 *
 *   One axis per chart. Two measures on different scales get two charts, never
 *   a second y-axis — a dual axis lets the author choose where the lines cross
 *   and so implies a relationship that may not exist.
 *
 *   Categorical colour comes from a fixed, validated order. The three series
 *   hues were checked for colour-vision separation and contrast against both
 *   surfaces; they are never cycled or reassigned by rank.
 *
 *   Identity is never colour alone. Every multi-series chart carries a legend
 *   and direct labels, and every figure has a table view beneath it.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Validated categorical slots, read from CSS so the palette has one home and
 * follows the theme automatically. Index is identity — slot 1 is always the
 * primary measure — and hues are never cycled for a series beyond the third.
 */
function vizSeries(i) {
  return themeColor(`--viz-${(i % 3) + 1}`, ['#3987e5', '#d95926', '#199e70'][i % 3]);
}

/** Single-hue sequential ramp, light to dark, for magnitude. */
function vizRamp(t) {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const stops = dark
    ? ['#1b3b63', '#215c9c', '#2a78d6', '#3987e5', '#7cc6ff']
    : ['#cfe3fa', '#8fbdf0', '#4a92e0', '#2a78d6', '#17518f'];
  const i = clamp(Math.floor(t * (stops.length - 1)), 0, stops.length - 2);
  return stops[Math.min(stops.length - 1, i + (t > 0.999 ? 1 : 0))] || stops[i];
}

const vizInk = {
  primary: () => themeColor('--text', '#e8eeff'),
  secondary: () => themeColor('--text-mut', '#9aa8c7'),
  muted: () => themeColor('--text-dim', '#6b7899'),
  grid: () => themeColor('--border', 'rgba(255,255,255,.1)'),
  surface: () => themeColor('--bg-raise', '#0d1426')
};

/** Registry so charts can be redrawn on resize and theme change. */
const wxCharts = new Map();
function registerChart(id, draw) { wxCharts.set(id, draw); draw(); }
function redrawCharts() { for (const draw of wxCharts.values()) { try { draw(); } catch { /* noop */ } } }

/**
 * Attach a crosshair and tooltip to a time-series canvas.
 *
 * An HTML chart is interactive by default; a static plot of 336 points that
 * cannot be interrogated is a picture, not an instrument.
 */
function attachHover(canvas, getPoints, formatRow) {
  const wrap = canvas.parentElement;
  let tip = wrap.querySelector('.viz-tip');
  if (!tip) {
    tip = el('div', { className: 'viz-tip' });
    tip.hidden = true;
    wrap.appendChild(tip);
  }

  const onMove = (e) => {
    const pts = getPoints();
    if (!pts?.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Nearest point by x, so the hit target is the whole column, not the mark.
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const d = Math.abs(pts[i].x - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    const p = pts[best];
    tip.replaceChildren(...formatRow(p.datum, best));
    tip.hidden = false;
    const w = tip.offsetWidth || 160;
    tip.style.setProperty('left', `${clamp(p.x - w / 2, 4, rect.width - w - 4)}px`);
    tip.style.setProperty('top', '8px');
    canvas.dataset.hoverIndex = String(best);
    const draw = wxCharts.get(canvas.id);
    if (draw) draw();
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', () => {
    tip.hidden = true;
    delete canvas.dataset.hoverIndex;
    const draw = wxCharts.get(canvas.id);
    if (draw) draw();
  });
}

/** Shared frame: padding, scales, recessive grid, axis labels. */
function plotFrame(ctx, w, h, { lo, hi, padL = 46, padR = 16, padT = 18, padB = 30, ticks = 4, format = (v) => Math.round(v) }) {
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const span = (hi - lo) || 1;
  const y = (v) => padT + plotH - ((v - lo) / span) * plotH;

  ctx.strokeStyle = vizInk.grid();
  ctx.fillStyle = vizInk.muted();
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= ticks; i += 1) {
    const v = lo + (span / ticks) * i;
    const gy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    ctx.fillText(format(v), padL - 8, gy);
  }
  return { padL, padR, padT, padB, plotW, plotH, y };
}

/* ── Multi-series time series ─────────────────────────────────────────────── */

function drawTimeSeries(canvasId, { rows, series, unit, format = (v) => Math.round(v) }) {
  const canvas = $('#' + canvasId);
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);
  if (!rows.length) return;

  const all = series.flatMap((s) => rows.map((r) => r[s.field])).filter((v) => typeof v === 'number');
  if (!all.length) return;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;

  const F = plotFrame(ctx, w, h, { lo, hi, format });
  const x = (i) => F.padL + (rows.length === 1 ? F.plotW / 2 : (i / (rows.length - 1)) * F.plotW);

  // Night shading, so the diurnal rhythm is legible without reading the axis.
  ctx.fillStyle = hexToRgba(vizInk.muted(), 0.10);
  let runStart = null;
  rows.forEach((r, i) => {
    if (!r.isDay && runStart === null) runStart = i;
    if ((r.isDay || i === rows.length - 1) && runStart !== null) {
      ctx.fillRect(x(runStart), F.padT, Math.max(1, x(i) - x(runStart)), F.plotH);
      runStart = null;
    }
  });

  // "Now" divider between observed and forecast.
  const nowIndex = rows.findIndex((r) => !r.past);
  if (nowIndex > 0) {
    ctx.strokeStyle = vizInk.secondary();
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x(nowIndex)) + 0.5, F.padT);
    ctx.lineTo(Math.round(x(nowIndex)) + 0.5, F.padT + F.plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = vizInk.muted();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('forecast →', x(nowIndex) + 5, F.padT + 8);
    ctx.textAlign = 'right';
    ctx.fillText('← observed', x(nowIndex) - 5, F.padT + 8);
  }

  series.forEach((s, si) => {
    ctx.beginPath();
    let started = false;
    rows.forEach((r, i) => {
      const v = r[s.field];
      if (typeof v !== 'number') return;
      const px = x(i), py = F.y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = vizSeries(si);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Direct label at the series end — identity without reading the legend.
    const last = [...rows].reverse().find((r) => typeof r[s.field] === 'number');
    if (last) {
      ctx.fillStyle = vizSeries(si);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(s.label, w - F.padR - 2, F.y(last[s.field]) - 7);
    }
  });

  // Hover crosshair
  const hoverIndex = canvas.dataset.hoverIndex ? Number(canvas.dataset.hoverIndex) : null;
  if (hoverIndex !== null && rows[hoverIndex]) {
    const hx = Math.round(x(hoverIndex)) + 0.5;
    ctx.strokeStyle = vizInk.secondary();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, F.padT); ctx.lineTo(hx, F.padT + F.plotH); ctx.stroke();
    series.forEach((s, si) => {
      const v = rows[hoverIndex][s.field];
      if (typeof v !== 'number') return;
      ctx.beginPath();
      ctx.arc(hx, F.y(v), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = vizSeries(si);
      ctx.fill();
      // A surface ring keeps overlapping marks distinguishable.
      ctx.strokeStyle = vizInk.surface();
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  // Day boundaries along the x axis
  ctx.fillStyle = vizInk.muted();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastDay = null;
  rows.forEach((r, i) => {
    if (r.localDay === lastDay) return;
    lastDay = r.localDay;
    if (i === 0) return;
    ctx.fillText(dayTick(r), x(i), h - 18);
  });

  ctx.textAlign = 'left';
  ctx.fillStyle = vizInk.muted();
  ctx.fillText(unit, F.padL, 2);

  attachHover(canvas,
    () => rows.map((r, i) => ({ x: x(i), datum: r })),
    (r) => [
      el('strong', { textContent: `${dayTick(r)} ${fmt.clock(r.dt, r.tz)}` }),
      ...series.map((s, si) => {
        const row = el('span', { className: 'viz-tip__row' });
        const dot = el('i', { className: 'viz-tip__dot' });
        dot.style.setProperty('background', vizSeries(si));
        row.appendChild(dot);
        row.appendChild(document.createTextNode(
          `${s.label}: ${typeof r[s.field] === 'number' ? format(r[s.field]) + unit : '—'}`));
        return row;
      })
    ]);
}

/** Short day tick for a record, e.g. "Wed 27". */
const dayTick = (r) => `${fmt.dayName(r.dt, r.tz)} ${fmt.dayDate(r.dt, r.tz).split(' ')[0]}`;

/* ── Single-series bars ───────────────────────────────────────────────────── */

function drawBars(canvasId, { items, valueOf, labelOf, unit, colorOf, format = (v) => round(v, 1) }) {
  const canvas = $('#' + canvasId);
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);
  if (!items.length) return;

  const values = items.map(valueOf);
  const hi = Math.max(...values, 0.001) * 1.15;
  const F = plotFrame(ctx, w, h, { lo: 0, hi, ticks: 3, format });
  const slot = F.plotW / items.length;
  // A 2px gap between adjacent fills keeps them from reading as one mass.
  const barW = Math.max(2, slot - 2);

  items.forEach((item, i) => {
    const v = valueOf(item);
    const bx = F.padL + i * slot + 1;
    const by = F.y(v);
    const bh = Math.max(v > 0 ? 2 : 0, F.padT + F.plotH - by);
    if (!bh) return;
    ctx.fillStyle = colorOf ? colorOf(item, i) : vizSeries(0);
    // 4px rounded ends, anchored to the baseline.
    roundedTopRect(ctx, bx, by, barW, bh, Math.min(4, barW / 2));
    ctx.fill();
  });

  ctx.fillStyle = vizInk.muted();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const step = Math.ceil(items.length / 12);
  items.forEach((item, i) => {
    if (i % step) return;
    ctx.fillText(labelOf(item, i), F.padL + i * slot + slot / 2, h - 18);
  });
  ctx.textAlign = 'left';
  ctx.fillText(unit, F.padL, 2);

  attachHover(canvas,
    () => items.map((item, i) => ({ x: F.padL + i * slot + slot / 2, datum: item })),
    (item, i) => [
      el('strong', { textContent: labelOf(item, i) }),
      el('span', { className: 'viz-tip__row', textContent: `${format(valueOf(item))}${unit}` })
    ]);
}

function roundedTopRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/* ── Wind rose ────────────────────────────────────────────────────────────── */

/**
 * Sixteen sectors, four speed bins, drawn as stacked polar segments. Speed is
 * a magnitude, so the bins step along one hue from light to dark rather than
 * taking four unrelated colours.
 */
function drawWindRose(canvasId, rose) {
  const canvas = $('#' + canvasId);
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);
  if (!rose.total) return;

  const cx = w / 2, cy = h / 2 + 6;
  const radius = Math.min(w, h) / 2 - 26;

  // Range rings, recessive.
  ctx.strokeStyle = vizInk.grid();
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, (radius / 3) * i, 0, Math.PI * 2);
    ctx.stroke();
  }

  const sectorAngle = (Math.PI * 2) / 16;
  rose.sectors.forEach((bins, s) => {
    // −90° puts north at the top; half a sector centres the wedge on the bearing.
    const start = s * sectorAngle - Math.PI / 2 - sectorAngle / 2;
    const end = start + sectorAngle * 0.86;   // gap between adjacent wedges
    let inner = 0;
    bins.forEach((count, b) => {
      if (!count) return;
      const outer = inner + (count / rose.max) * radius;
      ctx.beginPath();
      ctx.arc(cx, cy, outer, start, end);
      ctx.arc(cx, cy, inner, end, start, true);
      ctx.closePath();
      ctx.fillStyle = vizRamp(b / (ROSE_BINS.length - 1));
      ctx.fill();
      inner = outer;
    });
  });

  ctx.fillStyle = vizInk.secondary();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ['N', 'E', 'S', 'W'].forEach((label, i) => {
    const a = (i * Math.PI) / 2 - Math.PI / 2;
    ctx.fillText(label, cx + Math.cos(a) * (radius + 14), cy + Math.sin(a) * (radius + 14));
  });
}

/* ── Diurnal profile ──────────────────────────────────────────────────────── */

function drawDiurnal(canvasId, buckets, { unit, format = (v) => round(v, 1), asBars = false }) {
  const canvas = $('#' + canvasId);
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const values = buckets.map((b) => b.mean).filter((v) => typeof v === 'number');
  if (!values.length) return;

  let lo = asBars ? 0 : Math.min(...values);
  let hi = Math.max(...values);
  if (!asBars) { const p = (hi - lo) * 0.15 || 1; lo -= p; hi += p; } else hi *= 1.15;

  const F = plotFrame(ctx, w, h, { lo, hi, ticks: 3, format });
  const slot = F.plotW / 24;

  if (asBars) {
    buckets.forEach((b, i) => {
      if (typeof b.mean !== 'number') return;
      const by = F.y(b.mean);
      const bh = Math.max(b.mean > 0 ? 2 : 0, F.padT + F.plotH - by);
      ctx.fillStyle = vizSeries(0);
      roundedTopRect(ctx, F.padL + i * slot + 1, by, Math.max(2, slot - 2), bh, 3);
      ctx.fill();
    });
  } else {
    ctx.beginPath();
    buckets.forEach((b, i) => {
      if (typeof b.mean !== 'number') return;
      const px = F.padL + i * slot + slot / 2;
      const py = F.y(b.mean);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.strokeStyle = vizSeries(0);
    ctx.lineWidth = 2;
    ctx.stroke();

    // Mark the extremes only — a number on every point is noise.
    const maxB = buckets.reduce((m, b) => (b.mean > (m?.mean ?? -Infinity) ? b : m), null);
    const minB = buckets.reduce((m, b) => (b.mean < (m?.mean ?? Infinity) ? b : m), null);
    for (const [b, tag] of [[maxB, 'peak'], [minB, 'low']]) {
      if (!b || typeof b.mean !== 'number') continue;
      const px = F.padL + b.hour * slot + slot / 2;
      ctx.beginPath(); ctx.arc(px, F.y(b.mean), 4, 0, Math.PI * 2);
      ctx.fillStyle = vizSeries(0); ctx.fill();
      ctx.strokeStyle = vizInk.surface(); ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = vizInk.secondary();
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${tag} ${format(b.mean)}${unit}`, px, F.y(b.mean) - 12);
    }
  }

  ctx.fillStyle = vizInk.muted();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let hr = 0; hr < 24; hr += 3) {
    ctx.fillText(String(hr).padStart(2, '0'), F.padL + hr * slot + slot / 2, h - 18);
  }
  ctx.textAlign = 'left';
  ctx.fillText(unit, F.padL, 2);

  attachHover(canvas,
    () => buckets.map((b, i) => ({ x: F.padL + i * slot + slot / 2, datum: b })),
    (b) => [
      el('strong', { textContent: `${String(b.hour).padStart(2, '0')}:00` }),
      el('span', { className: 'viz-tip__row',
                   textContent: typeof b.mean === 'number' ? `${format(b.mean)}${unit} (mean of ${b.n})` : 'no data' })
    ]);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 33 · WEATHER ANALYSIS VIEW
 * ---------------------------------------------------------------------------
 * Every figure is followed by the numbers behind it, so the page is readable
 * without interpreting a colour, and by a screen reader.
 * ═══════════════════════════════════════════════════════════════════════════ */

let wxState = null;

async function renderAnalysis({ force = false } = {}) {
  if (!state.place) return;
  const status = $('#wx-status');
  const body = $('#wx-body');

  if (wxState && !force && wxState.placeKey === placeId(state.place) && wxState.units === state.units) {
    body.hidden = false;
    redrawCharts();
    return;
  }

  status.hidden = false;
  status.textContent = `Analysing 14 days of hourly observations for ${state.place.name}…`;
  body.hidden = true;

  try {
    const data = await WxData.load(state.place, state.units);
    wxState = { ...data, placeKey: placeId(state.place), units: state.units };
    status.hidden = true;
    body.hidden = false;
    paintAnalysis(wxState);
  } catch (err) {
    status.textContent = `Could not load the analysis record set: ${err.message}`;
    Telemetry.record('analysis', { lvl: 'error', msg: err.message });
  }
}

function paintAnalysis(data) {
  const U = data.units === 'imperial' ? '°F' : '°C';
  const hours = data.hours;

  /* ── Header ──────────────────────────────────────────────────────────── */
  const first = hours[0], last = hours[hours.length - 1];
  $('#wx-scope').textContent =
    `${state.place.name} · ${hours.length} hourly observations · ` +
    `${fmt.dayDate(first.dt, data.tz)} to ${fmt.dayDate(last.dt, data.tz)} · ` +
    `${hours.filter((r) => r.past).length} observed, ${hours.filter((r) => !r.past).length} forecast`;

  /* ── Temperature ─────────────────────────────────────────────────────── */
  const tStats = describe(hours.map((r) => r.temp));
  const fStats = describe(hours.map((r) => r.feels));
  const dStats = describe(hours.map((r) => r.dew));
  const slope = trendPerDay(hours.map((r) => r.temp));

  registerChart('wx-temp', () => drawTimeSeries('wx-temp', {
    rows: hours,
    series: [
      { field: 'temp',  label: 'Air' },
      { field: 'feels', label: 'Feels like' },
      { field: 'dew',   label: 'Dew point' }
    ],
    unit: U
  }));

  statTable('#wx-temp-table',
    ['Series', 'Mean', 'Median', 'Min', 'Max', 'Std dev', 'P10', 'P90'],
    [['Air temperature', tStats], ['Apparent temperature', fStats], ['Dew point', dStats]]
      .filter(([, s]) => s)
      .map(([label, s]) => [label, ...[s.mean, s.median, s.min, s.max, s.sd, s.p10, s.p90]
        .map((v) => round(v, 1) + U)]));

  $('#wx-temp-insight').textContent = tStats
    ? `Air temperature averages ${round(tStats.mean, 1)}${U} across the period and spans ` +
      `${round(tStats.range, 1)} degrees, with a standard deviation of ${round(tStats.sd, 1)}. ` +
      (slope !== null
        ? `The least-squares trend over the fortnight is ${slope >= 0 ? '+' : ''}${round(slope, 2)}${U} per day, ` +
          `so the period is ${Math.abs(slope) < 0.05 ? 'essentially flat' : slope > 0 ? 'warming' : 'cooling'}. `
        : '') +
      (fStats && tStats
        ? `Apparent temperature runs ${round(fStats.mean - tStats.mean, 1)} degrees above the air reading on average — ` +
          'the humidity penalty, and the number that actually governs how the day feels.'
        : '')
    : 'No temperature data available.';

  /* ── Diurnal cycle ───────────────────────────────────────────────────── */
  const dTemp = diurnal(hours, 'temp');
  const dPop = diurnal(hours, 'pop');
  registerChart('wx-diurnal-temp', () => drawDiurnal('wx-diurnal-temp', dTemp, { unit: U }));
  registerChart('wx-diurnal-rain', () => drawDiurnal('wx-diurnal-rain', dPop, { unit: '%', asBars: true, format: (v) => Math.round(v) }));

  const hottest = dTemp.reduce((m, b) => (b.mean > (m?.mean ?? -Infinity) ? b : m), null);
  const coolest = dTemp.reduce((m, b) => (b.mean < (m?.mean ?? Infinity) ? b : m), null);
  const wettest = dPop.reduce((m, b) => (b.mean > (m?.mean ?? -Infinity) ? b : m), null);
  $('#wx-diurnal-insight').textContent =
    `Averaged over ${Math.round(hours.length / 24)} days, the warmest hour is ` +
    `${String(hottest.hour).padStart(2, '0')}:00 at ${round(hottest.mean, 1)}${U} and the coolest is ` +
    `${String(coolest.hour).padStart(2, '0')}:00 at ${round(coolest.mean, 1)}${U} — a mean diurnal range of ` +
    `${round(hottest.mean - coolest.mean, 1)} degrees. Rain is most likely around ` +
    `${String(wettest.hour).padStart(2, '0')}:00 at ${Math.round(wettest.mean)}%, ` +
    'which is the convective afternoon peak typical of the tropics.';

  /* ── Rainfall ────────────────────────────────────────────────────────── */
  const rain = rainfallProfile(data);
  registerChart('wx-rain-daily', () => drawBars('wx-rain-daily', {
    items: data.days,
    valueOf: (d) => d.precip,
    labelOf: (d) => fmt.dayName(d.dt, data.tz),
    unit: ' mm'
  }));

  let running = 0;
  const cumulative = data.days.map((d) => ({ ...d, cum: (running += d.precip) }));
  registerChart('wx-rain-cum', () => drawBars('wx-rain-cum', {
    items: cumulative,
    valueOf: (d) => d.cum,
    labelOf: (d) => fmt.dayName(d.dt, data.tz),
    unit: ' mm'
  }));

  statTable('#wx-rain-table',
    ['Measure', 'Value'],
    [
      ['Total over the period', `${round(rain.total, 1)} mm`],
      ['Hours with measurable rain', `${rain.wetHours} of ${rain.totalHours} (${Math.round(rain.wetFraction * 100)}%)`],
      ['Peak hourly intensity', `${round(rain.peakHourly, 1)} mm/h`],
      ['Mean intensity while raining', `${round(rain.meanIntensity, 1)} mm/h`],
      ['Dry days (under 1 mm)', `${rain.dryDays} of ${data.days.length}`],
      ['Longest dry spell', `${rain.longestDrySpell} day${rain.longestDrySpell === 1 ? '' : 's'}`],
      ['Longest wet spell', `${rain.longestWetSpell} day${rain.longestWetSpell === 1 ? '' : 's'}`],
      ['Wettest day', rain.wettestDay ? `${fmt.dayName(rain.wettestDay.dt, data.tz)} — ${round(rain.wettestDay.precip, 1)} mm` : '—']
    ]);

  $('#wx-rain-insight').textContent =
    `${round(rain.total, 1)} mm falls across the fortnight, but only ${Math.round(rain.wetFraction * 100)}% of hours ` +
    `are actually wet — rain here arrives in short, intense bursts rather than drizzle. Peak intensity reaches ` +
    `${round(rain.peakHourly, 1)} mm in a single hour` +
    (rain.peakHourly >= 20 ? ', at or above MetMalaysia’s 20 mm/hour thunderstorm-warning threshold.' : '.');

  /* ── Wind ────────────────────────────────────────────────────────────── */
  const rose = windRose(hours);
  registerChart('wx-rose', () => drawWindRose('wx-rose', rose));

  const legend = $('#wx-rose-legend');
  legend.replaceChildren();
  ROSE_BINS.forEach((b, i) => {
    const item = el('span', { className: 'viz-legend__item' });
    const sw = el('i', { className: 'viz-legend__swatch' });
    sw.style.setProperty('background', vizRamp(i / (ROSE_BINS.length - 1)));
    item.appendChild(sw);
    item.appendChild(document.createTextNode(b.label));
    legend.appendChild(item);
  });

  const wStats = describe(hours.map((r) => r.windKmh));
  const gStats = describe(hours.map((r) => r.gustKmh));
  statTable('#wx-wind-table',
    ['Measure', 'Value'],
    [
      ['Prevailing direction', `${COMPASS_16[rose.dominantSector]} (${Math.round(rose.dominantPct)}% of hours)`],
      ['Mean speed', `${round(wStats?.mean ?? 0, 1)} km/h`],
      ['Median speed', `${round(wStats?.median ?? 0, 1)} km/h`],
      ['90th percentile', `${round(wStats?.p90 ?? 0, 1)} km/h`],
      ['Peak gust', `${round(gStats?.max ?? 0, 1)} km/h`],
      ['Calm hours (under 1 km/h)', `${rose.calm} (${Math.round(rose.calmPct)}%)`]
    ]);

  $('#wx-wind-insight').textContent =
    `Wind comes from the ${COMPASS_16[rose.dominantSector]} in ${Math.round(rose.dominantPct)}% of hours, ` +
    `averaging ${round(wStats?.mean ?? 0, 1)} km/h with a peak gust of ${round(gStats?.max ?? 0, 1)} km/h. ` +
    'In Malaysia the prevailing direction is set by which monsoon is running, so a shift in this rose is a shift in season.';

  /* ── Pressure ────────────────────────────────────────────────────────── */
  const tend = pressureTendency(hours);
  registerChart('wx-pressure', () => drawTimeSeries('wx-pressure', {
    rows: hours,
    series: [{ field: 'pressure', label: 'MSL pressure' }],
    unit: ' hPa',
    format: (v) => Math.round(v)
  }));
  const pStats = describe(hours.map((r) => r.pressure));
  $('#wx-pressure-insight').textContent = tend
    ? `${tend.label} — ${round(tend.change, 1)} hPa over three hours. ${tend.meaning} ` +
      `Across the period pressure ranges ${round(pStats.min, 1)} to ${round(pStats.max, 1)} hPa ` +
      `(mean ${round(pStats.mean, 1)}).`
    : 'Not enough pressure data to compute a tendency.';

  /* ── Heat stress ─────────────────────────────────────────────────────── */
  const heat = heatStressProfile(hours);
  const heatRows = HEAT_BANDS.map((b, i) => ({ band: b, hours: heat.counts[i] }));
  registerChart('wx-heat', () => drawBars('wx-heat', {
    items: heatRows,
    valueOf: (r) => r.hours,
    labelOf: (r) => r.band.label,
    unit: ' h',
    format: (v) => Math.round(v),
    // Heat stress is a state, not a series, so it uses the reserved status
    // colours — and every bar is labelled, never colour alone.
    colorOf: (r) => themeColor(
      r.band.tone === 'ok' ? '--c-good' : r.band.tone === 'info' ? '--c-brand-400'
      : r.band.tone === 'warn' ? '--c-warn' : '--c-bad', '#888')
  }));

  statTable('#wx-heat-table',
    ['WBGT band', 'Hours', 'Share', 'Guidance'],
    heatRows.map((r) => [
      r.band.label,
      String(r.hours),
      heat.total ? `${Math.round((r.hours / heat.total) * 100)}%` : '—',
      r.band.advice
    ]));

  const hiStats = describe(hours.map((r) => r.heatIndexC));
  $('#wx-heat-insight').textContent =
    (heat.daylightPeak
      ? `Peak daytime heat stress reaches an estimated WBGT of ${round(heat.daylightPeak.wbgtC, 1)} °C at ` +
        `${fmt.clock(heat.daylightPeak.dt, data.tz)}. `
      : '') +
    (hiStats ? `The NOAA heat index peaks at ${round(hiStats.max, 1)} °C against an air maximum of ` +
               `${round(describe(hours.map((r) => r.tempC)).max, 1)} °C — humidity adds roughly ` +
               `${round(hiStats.max - describe(hours.map((r) => r.tempC)).max, 1)} degrees of felt heat. ` : '') +
    'WBGT is estimated from temperature, humidity, solar radiation and wind rather than measured with a black-globe thermometer.';

  /* ── Relationships ───────────────────────────────────────────────────── */
  const pairs = [
    ['Temperature ↔ relative humidity', correlation(hours.map((r) => r.temp), hours.map((r) => r.rh))],
    ['Temperature ↔ cloud cover', correlation(hours.map((r) => r.temp), hours.map((r) => r.cloud))],
    ['Cloud cover ↔ solar radiation', correlation(hours.map((r) => r.cloud), hours.map((r) => r.radiation))],
    ['Humidity ↔ rain probability', correlation(hours.map((r) => r.rh), hours.map((r) => r.pop))],
    ['Pressure ↔ rainfall', correlation(hours.map((r) => r.pressure), hours.map((r) => r.precip))],
    ['Wind speed ↔ gust strength', correlation(hours.map((r) => r.windKmh), hours.map((r) => r.gustKmh))]
  ].filter(([, r]) => r !== null);

  statTable('#wx-corr-table',
    ['Relationship', 'r', 'Strength', 'Direction'],
    pairs.map(([label, r]) => [
      label,
      round(r, 2).toFixed(2),
      Math.abs(r) >= 0.7 ? 'Strong' : Math.abs(r) >= 0.4 ? 'Moderate' : Math.abs(r) >= 0.2 ? 'Weak' : 'Negligible',
      r > 0 ? 'Rises together' : 'Moves opposite'
    ]));

  const strongest = pairs.reduce((m, p) => (Math.abs(p[1]) > Math.abs(m?.[1] ?? 0) ? p : m), null);
  $('#wx-corr-insight').textContent = strongest
    ? `The strongest relationship in this record set is ${strongest[0].toLowerCase()} at r = ${round(strongest[1], 2)}. ` +
      'Correlation across a fortnight of one location describes this period only; it is not a general law, and it is not causation.'
    : 'Not enough overlapping data to compute correlations.';

  /* ── Sun & cloud ─────────────────────────────────────────────────────── */
  const cloudStats = describe(hours.map((r) => r.cloud));
  const uvStats = describe(hours.filter((r) => r.isDay).map((r) => r.uv));
  const visStats = describe(hours.map((r) => r.visibility));
  const sunnyHours = hours.filter((r) => r.isDay && r.cloud < 30).length;
  const dayHours = hours.filter((r) => r.isDay).length;

  statTable('#wx-sky-table',
    ['Measure', 'Value'],
    [
      ['Mean cloud cover', `${Math.round(cloudStats?.mean ?? 0)}%`],
      ['Clear daylight hours (under 30% cloud)', `${sunnyHours} of ${dayHours} (${dayHours ? Math.round((sunnyHours / dayHours) * 100) : 0}%)`],
      ['Peak UV index', round(uvStats?.max ?? 0, 1)],
      ['Mean daytime UV', round(uvStats?.mean ?? 0, 1)],
      ['Mean visibility', `${round((visStats?.mean ?? 0) / 1000, 1)} km`],
      ['Lowest visibility', `${round((visStats?.min ?? 0) / 1000, 1)} km`]
    ]);

  $('#wx-sky-insight').textContent =
    `Cloud averages ${Math.round(cloudStats?.mean ?? 0)}% and only ${dayHours ? Math.round((sunnyHours / dayHours) * 100) : 0}% ` +
    `of daylight hours are genuinely clear. UV peaks at ${round(uvStats?.max ?? 0, 1)}` +
    ((uvStats?.max ?? 0) >= 11 ? ', which is the extreme band — unprotected skin burns in minutes.'
     : (uvStats?.max ?? 0) >= 8 ? ', which is the very-high band.' : '.') +
    (visStats && visStats.min < 5000
      ? ` Visibility drops to ${round(visStats.min / 1000, 1)} km at its worst, consistent with heavy rain or haze.`
      : '');
}

/** Build an accessible table — the table view every figure is paired with. */
function statTable(selector, headers, rows) {
  const host = $(selector);
  if (!host) return;
  host.replaceChildren();

  const table = el('table', { className: 'table table--stats' });
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h, i) => hr.appendChild(el('th', {
    textContent: h, attrs: { scope: 'col', ...(i > 0 ? { class: 'num' } : {}) }
  })));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, i) => {
      if (i === 0) tr.appendChild(el('th', { textContent: String(cell), attrs: { scope: 'row' } }));
      else tr.appendChild(el('td', { textContent: String(cell), className: 'num' }));
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

/** The old app-performance telemetry, kept but demoted to a diagnostics panel. */
function renderDiagnostics() {
  const v = Telemetry.vitals;
  const ms = Telemetry.latencies.map((l) => l.ms);
  const rows = [
    ['Largest Contentful Paint', v.lcp === null ? '—' : fmt.ms(v.lcp)],
    ['Cumulative Layout Shift', round(v.cls, 3).toFixed(3)],
    ['Interaction to Next Paint', v.inp === null ? '—' : fmt.ms(v.inp)],
    ['Time to First Byte', v.ttfb === null ? '—' : fmt.ms(v.ttfb)],
    ['API requests this session', String(Telemetry.counts.req)],
    ['Median API latency', fmt.ms(percentile(ms, 0.5))],
    ['95th percentile latency', fmt.ms(percentile(ms, 0.95))],
    ['Cache hits / misses', `${Telemetry.counts.hit} / ${Telemetry.counts.miss}`],
    ['Errors', String(Telemetry.counts.err)]
  ];
  statTable('#wx-diag-table', ['Metric', 'Value'], rows);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 19 · VIEWS
 * ═══════════════════════════════════════════════════════════════════════════ */

const VIEWS = ['dashboard', 'alerts', 'climate', 'explore', 'analytics'];

function setView(name) {
  if (!VIEWS.includes(name)) name = 'dashboard';
  activeView = name;

  for (const v of VIEWS) {
    const panel = $('#view-' + v);
    const tab = $('#tab-' + v);
    const on = v === name;
    panel.hidden = !on;
    panel.classList.toggle('is-active', on);
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
  }

  if (name === 'explore' && !$('#places-list').childElementCount) {
    renderStateFilter();
    renderPlacesList();
  }
  if (name === 'analytics') { renderAnalysis(); renderDiagnostics(); }
  if (name === 'dashboard') renderHourly();
  if (name === 'alerts') { renderAlertsView(); renderFloodChart(); }
  if (name === 'climate') {
    renderMonsoonPanel();
    if (state.climate) renderClimateChart(state.climate.normals);
  }

  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  Telemetry.record('nav', { lvl: 'info', msg: 'Opened ' + name });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 20 · AUTH UI
 * ═══════════════════════════════════════════════════════════════════════════ */

let authMode = 'signin';   // 'signin' | 'signup'

function renderAuthUI() {
  const user = Auth.user;
  const label = $('#account-label');
  const avatar = $('#account-avatar');

  if (user) {
    label.textContent = user.name || 'Account';
    avatar.replaceChildren(document.createTextNode((user.name || user.email || '?').charAt(0).toUpperCase()));
  } else {
    label.textContent = 'Sign in';
    avatar.replaceChildren(icon('i-user'));
  }

  $('#auth-signed-out').hidden = Boolean(user);
  $('#auth-signed-in').hidden = !user;

  if (user) {
    $('#profile-name').textContent = user.name || '—';
    $('#profile-email').textContent = user.email || '—';
    $('#profile-since').textContent = user.createdAt
      ? 'Member since ' + new Date(user.createdAt).toLocaleDateString() : '';
    $('#profile-avatar').replaceChildren(document.createTextNode((user.name || '?').charAt(0).toUpperCase()));
    $('#profile-favs').textContent = String(state.favourites.length);
    $('#profile-searches').textContent = String(Object.values(Telemetry.places).reduce((a, b) => a + b, 0));
    $('#profile-backend').textContent = Auth.store.kind;
  }

  $('#auth-mode-note').textContent = Auth.mode === 'firebase'
    ? 'Signed in through Firebase Authentication. Your saved places sync to Cloud Firestore.'
    : 'Running in local account mode: your credentials are hashed with PBKDF2-SHA256 and stored only in this browser. Google sign-in needs an identity provider — add a Firebase config in Settings to switch it on.';

  // Never disabled: a dead button teaches nothing. When Firebase is absent it
  // says so and offers the one action that fixes it.
  const gbtn = $('#btn-google');
  gbtn.disabled = false;
  gbtn.dataset.ready = String(Auth.mode === 'firebase');
  $('#btn-google-label').textContent = Auth.mode === 'firebase'
    ? 'Continue with Google'
    : 'Set up Google sign-in';
}

function setAuthMode(mode) {
  authMode = mode;
  $('#auth-title').textContent = mode === 'signup' ? 'Create your CuacaMY account' : 'Sign in to CuacaMY';
  $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('#auth-switch').textContent = mode === 'signup' ? 'I already have an account' : 'Create an account';
  $('#auth-password').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  $('#auth-strength').hidden = mode !== 'signup';
  $('#auth-msg').textContent = '';
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const msg = $('#auth-msg');
  const submit = $('#auth-submit');

  $('#auth-email-err').textContent = '';
  $('#auth-password-err').textContent = '';
  msg.textContent = '';

  let valid = true;
  if (!isValidEmail(email)) {
    $('#auth-email-err').textContent = 'Enter a valid email address.';
    $('#auth-email').setAttribute('aria-invalid', 'true');
    valid = false;
  } else {
    $('#auth-email').removeAttribute('aria-invalid');
  }
  if (password.length < 8) {
    $('#auth-password-err').textContent = 'Passwords must be at least 8 characters.';
    valid = false;
  }
  if (authMode === 'signup' && passwordScore(password).score < 2) {
    $('#auth-password-err').textContent = 'Choose a stronger password — mix letters, numbers and symbols.';
    valid = false;
  }
  if (!valid) return;

  submit.disabled = true;
  submit.textContent = authMode === 'signup' ? 'Creating…' : 'Signing in…';

  try {
    if (authMode === 'signup') await Auth.signUp(email, password);
    else await Auth.signIn(email, password);

    msg.dataset.type = 'success';
    msg.textContent = authMode === 'signup' ? 'Account created. Welcome aboard.' : 'Signed in.';
    $('#auth-form').reset();
    setTimeout(() => $('#auth-dialog').close(), 700);
    toast(authMode === 'signup' ? 'Account created.' : 'Welcome back.', 'success');
  } catch (err) {
    msg.dataset.type = 'error';
    msg.textContent = friendlyAuthError(err);
    Telemetry.record('auth', { lvl: 'error', msg: err.message });
  } finally {
    submit.disabled = false;
    // Restore the label only — calling setAuthMode() here would clear the
    // success or error message we just wrote.
    submit.textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  }
}

/** Firebase error codes are machine-readable, not human-readable. */
function friendlyAuthError(err) {
  const code = err?.code || '';
  const map = {
    'auth/email-already-in-use': 'An account already exists for that email address.',
    'auth/invalid-email': 'That email address is not valid.',
    'auth/weak-password': 'That password is too weak — use at least 8 characters.',
    'auth/user-not-found': 'No account matches that email address.',
    'auth/wrong-password': 'That password is incorrect.',
    'auth/invalid-credential': 'That email and password combination does not match an account.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/popup-closed-by-user': 'The Google sign-in window was closed before finishing.',
    'auth/network-request-failed': 'Network error — check your connection and try again.'
  };
  return map[code] || err?.message || 'Something went wrong. Please try again.';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 21 · SETTINGS DIALOG
 * ═══════════════════════════════════════════════════════════════════════════ */

function openSettings() {
  $('#set-apikey').value = safeLocal.get(LS.apiKey, '');
  const fb = safeLocal.json(LS.firebase, null);
  $('#set-firebase').value = fb ? JSON.stringify(fb, null, 2) : '';
  $('#set-firebase-err').textContent = '';
  $('#set-units').value = state.units;
  $('#set-home').value = state.home;
  $('#set-analytics').checked = state.analytics !== false;
  $('#set-motion').checked = Boolean(state.reduceMotion);
  $('#set-provider').value = state.provider;
  $('#set-alerts').checked = state.alertsEnabled !== false;
  $('#set-alert-sound').checked = state.alertSound !== false;
  $('#set-severity').value = String(state.alertMinSeverity);
  $('#settings-dialog').showModal();
}

async function saveSettingsFromDialog() {
  const key = $('#set-apikey').value.trim();
  const hadKey = hasKey();
  const providerChanged = state.provider !== $('#set-provider').value;

  // Validate the Firebase config before storing it, so a typo surfaces here
  // rather than as a broken sign-in button later.
  const fbRaw = $('#set-firebase').value.trim();
  const hadFirebase = Boolean(Auth.config());
  if (fbRaw) {
    let parsed;
    try {
      // Accept the object literal Firebase shows in its console as well as JSON.
      parsed = JSON.parse(fbRaw.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
                               .replace(/'/g, '"').replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      $('#set-firebase-err').textContent = 'That is not valid JSON. Copy the whole config object from the Firebase console.';
      return;
    }
    if (!parsed.apiKey || !parsed.authDomain || !parsed.projectId) {
      $('#set-firebase-err').textContent = 'The config needs at least apiKey, authDomain and projectId.';
      return;
    }
    safeLocal.set(LS.firebase, JSON.stringify(parsed));
  } else {
    safeLocal.del(LS.firebase);
  }
  const firebaseChanged = Boolean(fbRaw) !== hadFirebase;

  if (key) safeLocal.set(LS.apiKey, key); else safeLocal.del(LS.apiKey);

  state.units = $('#set-units').value;
  state.home = $('#set-home').value;
  state.analytics = $('#set-analytics').checked;
  state.reduceMotion = $('#set-motion').checked;
  state.provider = $('#set-provider').value;
  state.alertsEnabled = $('#set-alerts').checked;
  state.alertSound = $('#set-alert-sound').checked;
  state.alertMinSeverity = Number($('#set-severity').value);
  Telemetry.enabled = state.analytics;

  saveSettings();
  applyUnits();
  applyMotion();
  $('#settings-dialog').close();
  toast('Settings saved.', 'success');

  if (firebaseChanged) {
    // Firebase initialises once at boot, so switching it on or off needs a
    // reload rather than a live re-init of a half-built auth graph.
    toast('Reloading to apply the sign-in change…', 'info');
    setTimeout(() => location.reload(), 900);
    return;
  }

  if ((key && !hadKey) || providerChanged) {
    CachePolicy.clear();   // responses from the previous provider must not linger
    $('#banner-setup').hidden = true;
  }
  if (state.place) await loadPlace(state.place);
}

async function resetEverything() {
  if (!window.confirm('This clears saved places, cached weather, local accounts, analytics and settings on this device. Continue?')) return;
  CachePolicy.clear();
  Telemetry.reset();
  [LS.settings, LS.apiKey, LS.session, LS.analytics, LS.lastPlace].forEach((k) => safeLocal.del(k));
  try {
    await Promise.all([IDB.clear('users'), IDB.clear('kv'), IDB.clear('places')]);
  } catch { /* IndexedDB may be unavailable; the localStorage wipe still happened */ }
  toast('Local data cleared. Reloading…', 'success');
  setTimeout(() => location.reload(), 900);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 22 · EVENT WIRING
 * ═══════════════════════════════════════════════════════════════════════════ */

function wireEvents() {
  /* ── Search ─────────────────────────────────────────────────────────── */
  const input = $('#search-input');
  const runSearch = debounce((q) => Search.run(q), 260);

  input.addEventListener('input', () => {
    const q = input.value;
    $('#search-clear').hidden = q.length === 0;
    if (!q.trim()) { Search.show(false); $('#search-spinner').hidden = true; return; }
    runSearch(q);
  });

  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (!Search.open && input.value) Search.run(input.value); else Search.move(1); break;
      case 'ArrowUp':   e.preventDefault(); Search.move(-1); break;
      case 'Enter':     if (Search.open) { e.preventDefault(); Search.choose(Search.activeIndex); } break;
      case 'Escape':    Search.show(false); input.blur(); break;
      default: break;
    }
  });

  input.addEventListener('focus', () => { if (input.value.trim()) Search.run(input.value); });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) Search.show(false);
  });

  $('#search-clear').addEventListener('click', () => {
    input.value = '';
    $('#search-clear').hidden = true;
    Search.show(false);
    input.focus();
  });

  /* ── Top bar ────────────────────────────────────────────────────────── */
  $('#btn-geo').addEventListener('click', detectLocation);

  $('#btn-units').addEventListener('click', async () => {
    state.units = state.units === 'metric' ? 'imperial' : 'metric';
    saveSettings();
    applyUnits();
    if (state.place) await loadPlace(state.place, { silent: true });
  });

  $('#btn-theme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    saveSettings();
    applyTheme();
    // Charts bake theme colours into pixels, so they must be repainted.
    renderHourly();
    if (activeView === 'analytics') { redrawCharts(); renderDiagnostics(); }
    if (activeView === 'alerts') renderFloodChart();
    if (activeView === 'climate' && state.climate) renderClimateChart(state.climate.normals);
  });

  $('#btn-account').addEventListener('click', () => {
    renderAuthUI();
    if (!Auth.user) setAuthMode('signin');
    $('#auth-dialog').showModal();
  });

  /* ── Tabs ───────────────────────────────────────────────────────────── */
  VIEWS.forEach((v) => $('#tab-' + v).addEventListener('click', () => setView(v)));

  $('.tabs__inner').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = VIEWS.indexOf(activeView);
    const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
    setView(next);
    $('#tab-' + next).focus();
  });

  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

  /* ── Dashboard ──────────────────────────────────────────────────────── */
  $('#btn-fav').addEventListener('click', toggleFavourite);
  $('#btn-email').addEventListener('click', emailReport);
  $('#error-retry').addEventListener('click', () => state.place && loadPlace(state.place));
  $('#daybreak-close').addEventListener('click', () => selectDay(state.selectedDay));

  $('#btn-refresh').addEventListener('click', async () => {
    if (!state.place) return;
    const btn = $('#btn-refresh');
    btn.classList.add('is-busy');
    CachePolicy.clear();
    await loadPlace(state.place);
    btn.classList.remove('is-busy');
    toast('Refreshed.', 'success', 2200);
  });

  $$('.seg__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.seg__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      state.hourlySeries = btn.dataset.series;
      renderHourly();
    });
  });

  /* ── Explore ────────────────────────────────────────────────────────── */
  $('#explore-search').addEventListener('input', debounce((e) => {
    exploreState.query = e.target.value;
    renderPlacesList();
  }, 160));

  $('#btn-compare').addEventListener('click', renderCapitalComparison);
  $('#compare-close').addEventListener('click', () => { $('#compare-card').hidden = true; });

  /* ── Alerts, climate and the assistant ──────────────────────────────── */
  $('#btn-notify').addEventListener('click', async () => {
    const granted = await Alerting.requestPermission();
    $('#btn-notify').textContent = granted ? 'Notifications on' : 'Enable notifications';
    $('#btn-notify').disabled = granted;
  });

  $('#btn-test-alarm').addEventListener('click', () => {
    Alerting.sound(3);
    toast('That is the alarm you will hear for a warning.', 'info');
  });

  $('#btn-climate').addEventListener('click', () => renderClimate());

  $('#assistant-form').addEventListener('submit', (e) => { e.preventDefault(); askAssistant(); });

  /* ── Analytics ──────────────────────────────────────────────────────── */
  $('#btn-export').addEventListener('click', () => {
    downloadJSON(`cuacamy-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, Telemetry.snapshot());
    toast('Diagnostics exported.', 'success');
  });

  $('#btn-clear-analytics').addEventListener('click', () => {
    Telemetry.reset();
    renderDiagnostics();
    toast('Diagnostics cleared.');
  });

  $('#btn-reanalyse').addEventListener('click', () => renderAnalysis({ force: true }));

  /* ── Auth dialog ────────────────────────────────────────────────────── */
  $('#auth-form').addEventListener('submit', handleAuthSubmit);
  $('#auth-switch').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));

  $('#auth-password').addEventListener('input', (e) => {
    if (authMode !== 'signup') return;
    const { score, label } = passwordScore(e.target.value);
    const bar = $('#auth-strength-bar');
    bar.style.setProperty('width', (score / 4) * 100 + '%');
    bar.style.setProperty('background',
      score >= 3 ? 'var(--c-good)' : score === 2 ? 'var(--c-warn)' : 'var(--c-bad)');
    $('#auth-strength-text').textContent = label;
  });

  $('#btn-google').addEventListener('click', async () => {
    try {
      await Auth.signInWithGoogle();
      $('#auth-dialog').close();
      toast('Signed in with Google.', 'success');
    } catch (err) {
      if (err.message === 'NEEDS_FIREBASE') {
        $('#auth-dialog').close();
        openSettings();
        $('#set-firebase').focus();
        toast('Paste a Firebase config here to turn on Google sign-in.', 'info', 7000);
        return;
      }
      $('#auth-msg').dataset.type = 'error';
      $('#auth-msg').textContent = friendlyAuthError(err);
    }
  });

  $('#btn-signout').addEventListener('click', async () => {
    await Auth.signOut();
    $('#auth-dialog').close();
    toast('Signed out.');
  });

  $('#btn-export-account').addEventListener('click', () => {
    downloadJSON('cuacamy-my-data.json', {
      exportedAt: new Date().toISOString(),
      account: Auth.user ? { uid: Auth.user.uid, email: Auth.user.email, name: Auth.user.name } : null,
      settings: { units: state.units, theme: state.theme, home: state.home },
      favourites: state.favourites,
      analytics: Telemetry.snapshot()
    });
    toast('Your data has been downloaded.', 'success');
  });

  /* ── Settings ───────────────────────────────────────────────────────── */
  $('#banner-setup-cta').addEventListener('click', openSettings);

  $('#banner-geo-yes').addEventListener('click', async () => {
    $('#banner-geo').hidden = true;
    await detectLocation();
  });
  $('#banner-geo-no').addEventListener('click', () => {
    $('#banner-geo').hidden = true;
    safeLocal.set('cuacamy.geo.dismissed', '1');
  });
  $('#btn-save-settings').addEventListener('click', saveSettingsFromDialog);
  $('#btn-reset').addEventListener('click', resetEverything);

  /* ── Global shortcuts ───────────────────────────────────────────────── */
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && !typing) {
      e.preventDefault();
      input.focus();
      input.select();
    }
    if (e.key === ',' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openSettings(); }
  });

  /* ── Connectivity ───────────────────────────────────────────────────── */
  const setOnline = () => {
    $('#banner-offline').hidden = navigator.onLine;
    if (navigator.onLine && state.place) loadPlace(state.place, { silent: true });
  };
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);

  /* ── Resize: canvases are pixel-backed and must be redrawn ──────────── */
  window.addEventListener('resize', rafThrottle(() => {
    renderHourly();
    if (activeView === 'analytics') redrawCharts();
    if (activeView === 'alerts') renderFloodChart();
    if (activeView === 'climate' && state.climate) renderClimateChart(state.climate.normals);
  }));

  /* ── Keep relative timestamps honest without a full re-render ───────── */
  setInterval(() => {
    if (state.current) {
      $('#cur-updated').textContent = fmt.relative(state.current.dt * 1000);
      $('#place-time').textContent = 'Local time ' + fmt.clock(Math.floor(Date.now() / 1000), state.current.timezone ?? 0);
    }
  }, 30000);

  /* ── Refresh when the tab comes back to the foreground after 10 min ─── */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.current) return;
    if (Date.now() - state.current.dt * 1000 > TTL.weather) loadPlace(state.place, { silent: true });
  });

  Auth.onChange(async () => {
    renderAuthUI();
    await loadFavourites();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 23 · SERVICE WORKER
 * ---------------------------------------------------------------------------
 * Registration is deliberately non-blocking and failure-tolerant: service
 * workers require a secure context, so this is a no-op on plain http://.
 * ═══════════════════════════════════════════════════════════════════════════ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => Telemetry.record('sw', { lvl: 'info', msg: 'Service worker active (scope ' + reg.scope + ')' }))
      .catch((err) => Telemetry.record('sw', { lvl: 'warn', msg: 'Service worker registration failed: ' + err.message }));
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 24 · BOOT
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Which place should the dashboard open on? */
async function resolveStartPlace() {
  if (state.home === 'geo') {
    // Only auto-locate when permission is already granted. Firing the
    // permission prompt on page load, before the visitor knows what the site
    // is, gets denied — and a denial is sticky. Otherwise a dismissable
    // prompt appears once the dashboard is on screen.
    let canAsk = false;
    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' });
      canAsk = status?.state === 'granted';
      if (status?.state === 'prompt') showLocationInvite();
    } catch {
      canAsk = false;
      showLocationInvite();
    }

    if (canAsk) {
      try {
        const pos = await getPosition({ timeout: 8000 });
        const place = await Api.reverse(pos.coords.latitude, pos.coords.longitude);
        return { ...place, lat: pos.coords.latitude, lon: pos.coords.longitude };
      } catch { /* fall through to the saved place */ }
    }
  }
  if (state.home === 'kl') return { ...CONFIG.defaultCity };

  const last = safeLocal.json(LS.lastPlace, null);
  if (last && Number.isFinite(last.lat) && Number.isFinite(last.lon)) return last;
  return { ...CONFIG.defaultCity };
}

/** A dismissable invitation, shown instead of an unprompted permission dialog. */
function showLocationInvite() {
  if (safeLocal.get('cuacamy.geo.dismissed') === '1') return;
  const banner = $('#banner-geo');
  if (banner) banner.hidden = false;
}

async function boot() {
  const t0 = performance.now();

  // Optional local overrides. A missing config.js is normal, not an error.
  try {
    const mod = await import('./config.js');
    Object.assign(CONFIG, mod.default || mod.config || {});
  } catch {
    if (window.CUACAMY_CONFIG) Object.assign(CONFIG, window.CUACAMY_CONFIG);
  }

  loadSettings();
  Telemetry.restore();
  observeVitals();
  applyTheme();
  applyMotion();
  applyUnits();
  wireEvents();
  registerServiceWorker();

  $('#foot-version').textContent = 'v' + VERSION;
  $('#banner-offline').hidden = navigator.onLine;
  $('#banner-setup').hidden = true;
  setAuthMode('signin');

  if ('Notification' in window && Notification.permission === 'granted') {
    state.notifications = true;
    const btn = $('#btn-notify');
    if (btn) { btn.textContent = 'Notifications on'; btn.disabled = true; }
  }

  await Auth.init();
  renderAuthUI();
  await loadFavourites();

  setView(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard');

  const place = await resolveStartPlace();
  await loadPlace(place);

  Telemetry.record('boot', { lvl: 'perf', msg: `Application ready in ${fmt.ms(performance.now() - t0)}` });
}

boot().catch((err) => {
  console.error('[CuacaMY] Fatal startup error', err);
  showError(err);
});
