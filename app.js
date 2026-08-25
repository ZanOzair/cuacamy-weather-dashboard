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

const VERSION = '1.0.0';

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
    if (activeView === 'analytics') scheduleAnalyticsRender();
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
      scheduleAnalyticsRender();
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* noop */ }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Shifts the user caused (by scrolling, clicking) are not penalised.
        if (!entry.hadRecentInput) Telemetry.vitals.cls += entry.value;
      }
      scheduleAnalyticsRender();
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* noop */ }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const d = entry.duration;
        if (Telemetry.vitals.inp === null || d > Telemetry.vitals.inp) Telemetry.vitals.inp = d;
      }
      scheduleAnalyticsRender();
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

const Api = {
  async current(lat, lon, units) {
    const key = `w:${round(lat,2)}:${round(lon,2)}:${units}`;
    if (!hasKey()) return demoRequest(key, TTL.weather, 'weather', () => Demo.current(lat, lon, units));
    const url = owmURL(OWM.weather, { lat: round(lat, 4), lon: round(lon, 4), units });
    return request(url, { ttl: TTL.weather, label: 'weather', cacheKey: key });
  },

  async forecast(lat, lon, units) {
    const key = `f:${round(lat,2)}:${round(lon,2)}:${units}`;
    if (!hasKey()) return demoRequest(key, TTL.forecast, 'forecast', () => Demo.forecast(lat, lon, units));
    const url = owmURL(OWM.forecast, { lat: round(lat, 4), lon: round(lon, 4), units });
    return request(url, { ttl: TTL.forecast, label: 'forecast', cacheKey: key });
  },

  async air(lat, lon) {
    const key = `a:${round(lat,2)}:${round(lon,2)}`;
    if (!hasKey()) return demoRequest(key, TTL.air, 'air', () => Demo.air(lat, lon));
    const url = owmURL(OWM.air, { lat: round(lat, 4), lon: round(lon, 4) });
    return request(url, { ttl: TTL.air, label: 'air', cacheKey: key });
  },

  /** Geocode a free-text query. Returns a normalised array of places. */
  async geocode(query, limit = 6) {
    if (!hasKey()) return [];
    const url = owmURL(OWM.geoDirect, { q: query, limit });
    const { data } = await request(url, { ttl: TTL.geo, label: 'geocode', cacheKey: `g:${query.toLowerCase()}:${limit}` });
    return (Array.isArray(data) ? data : []).map((r) => ({
      name: r.name,
      state: r.state || '',
      country: r.country,
      lat: r.lat,
      lon: r.lon,
      source: 'owm'
    }));
  },

  /** Coordinates → nearest named place, used after the browser locates you. */
  async reverse(lat, lon) {
    if (!hasKey()) return nearestLocalPlace(lat, lon);
    const url = owmURL(OWM.geoReverse, { lat: round(lat, 4), lon: round(lon, 4), limit: 1 });
    const { data } = await request(url, { ttl: TTL.geo, label: 'reverse', cacheKey: `r:${round(lat,3)}:${round(lon,3)}` });
    const r = Array.isArray(data) && data[0];
    if (!r) return nearestLocalPlace(lat, lon);
    return { name: r.name, state: r.state || '', country: r.country, lat, lon };
  }
};

/** Closest bundled Malaysian place — the offline fallback for reverse geocoding. */
function nearestLocalPlace(lat, lon) {
  let best = null, bestD = Infinity;
  for (const p of MY_PLACES) {
    const d = haversine({ lat, lon }, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  return bestD < 60 ? { ...best } : { name: 'Selected location', state: '', country: '', lat, lon };
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
  async init() {
    if (CONFIG.firebase && CONFIG.firebase.apiKey) {
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
    const app = appMod.initializeApp(CONFIG.firebase);
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
      throw new Error('Google sign-in needs Firebase. Add your Firebase config to config.js to enable it.');
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
  home: 'last',
  analytics: true,
  reduceMotion: false
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
  source: 'live'      // 'live' | 'cache' | 'demo'
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
    analytics: state.analytics, reduceMotion: state.reduceMotion
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
  state.forecast = fc.status === 'fulfilled' ? fc.value.data : null;
  state.air = air.status === 'fulfilled' ? air.value.data : null;

  deriveSeries();
  renderAll();

  Telemetry.place(place.name);
  Telemetry.record('view', { lvl: 'info', msg: `${place.name} rendered in ${fmt.ms(performance.now() - started)}` });
  Telemetry.save();

  safeLocal.set(LS.lastPlace, JSON.stringify(place));
  setStatus('Ready');
  if (state.source === 'demo') $('#banner-setup').hidden = false;
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
      slots,
      tz
    });
  }

  state.daily = state.daily.slice(0, 5);

  const now = Math.floor(Date.now() / 1000);
  state.hourly = state.forecast.list
    .filter((s) => s.dt >= now - 5400)
    .slice(0, 9)
    .map((s) => ({
      dt: s.dt, tz,
      temp: s.main.temp,
      pop: (s.pop ?? 0) * 100,
      wind: state.units === 'imperial' ? s.wind.speed : s.wind.speed * 3.6,
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
  tag.textContent = state.source === 'demo' ? 'Demo data' : state.source === 'cache' ? 'Cached' : 'Live';
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

  const aqi = entry.main.aqi;
  const scale = AQI_SCALE[aqi] || AQI_SCALE[3];
  badge.dataset.level = String(aqi);
  $('#aqi-score').textContent = String(aqi);
  $('#aqi-label').textContent = scale.label;
  $('#aqi-note').textContent = scale.note;

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

function renderLatencyChart() {
  const canvas = $('#latency-chart');
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const data = Telemetry.latencies.slice(-40);

  if (!data.length) {
    ctx.fillStyle = themeColor('--text-dim', '#6b7899');
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No requests recorded yet', w / 2, h / 2);
    return;
  }

  const max = Math.max(...data.map((d) => d.ms), 100) * 1.15;
  const barW = Math.max(3, (w - 8) / data.length - 3);
  const good = themeColor('--c-good', '#34d399');
  const warn = themeColor('--c-warn', '#fbbf24');
  const bad  = themeColor('--c-bad',  '#f87171');

  data.forEach((d, i) => {
    const bh = Math.max(2, (d.ms / max) * (h - 22));
    const bx = 4 + i * ((w - 8) / data.length);
    ctx.fillStyle = !d.ok ? bad : d.ms < 400 ? good : d.ms < 1200 ? warn : bad;
    roundRect(ctx, bx, h - 18 - bh, barW, bh, 2);
    ctx.fill();
  });

  ctx.fillStyle = themeColor('--text-dim', '#6b7899');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('oldest', 4, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`newest · peak ${fmt.ms(Math.max(...data.map((d) => d.ms)))}`, w - 4, h - 4);
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

function renderCacheDonut() {
  const canvas = $('#cache-donut');
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const { hit, miss } = Telemetry.counts;
  const total = hit + miss;
  const ratio = total ? hit / total : 0;

  const cx = w / 2, cy = h / 2;
  const radius = Math.min(w, h) / 2 - 12;
  const thickness = Math.max(12, radius * 0.32);

  ctx.lineWidth = thickness;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = themeColor('--surface-3', 'rgba(255,255,255,.11)');
  ctx.stroke();

  if (ratio > 0) {
    const start = -Math.PI / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + Math.PI * 2 * ratio);
    ctx.strokeStyle = themeColor('--c-good', '#34d399');
    ctx.stroke();
  }

  $('#cache-pct').textContent = Math.round(ratio * 100) + '%';
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
 * 16 · ANALYTICS VIEW
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Web Vitals thresholds published by the Chrome team. */
const VITAL_BUDGETS = {
  lcp:  { good: 2500, ok: 4000 },
  cls:  { good: 0.1,  ok: 0.25 },
  inp:  { good: 200,  ok: 500 },
  ttfb: { good: 800,  ok: 1800 }
};

function gradeVital(key, value) {
  if (value === null || value === undefined) return '';
  const b = VITAL_BUDGETS[key];
  return value <= b.good ? 'good' : value <= b.ok ? 'ok' : 'poor';
}

let analyticsFrame = null;
function scheduleAnalyticsRender() {
  if (activeView !== 'analytics' || analyticsFrame) return;
  analyticsFrame = requestAnimationFrame(() => { analyticsFrame = null; renderAnalytics(); });
}

function renderAnalytics() {
  const v = Telemetry.vitals;

  const setVital = (id, value, text) => {
    $('#kpi-' + id).textContent = text;
    const grade = $('#kpi-' + id + '-g');
    const g = gradeVital(id, value);
    grade.textContent = g ? (g === 'good' ? 'Good' : g === 'ok' ? 'Needs work' : 'Poor') : 'Measuring…';
    if (g) grade.dataset.g = g; else delete grade.dataset.g;
  };

  setVital('lcp',  v.lcp,  v.lcp  === null ? '—' : fmt.ms(v.lcp));
  setVital('cls',  v.cls,  round(v.cls, 3).toFixed(3));
  setVital('inp',  v.inp,  v.inp  === null ? '—' : fmt.ms(v.inp));
  setVital('ttfb', v.ttfb, v.ttfb === null ? '—' : fmt.ms(v.ttfb));

  const ms = Telemetry.latencies.map((l) => l.ms);
  $('#st-req').textContent = String(Telemetry.counts.req);
  $('#st-p50').textContent = fmt.ms(percentile(ms, 0.5));
  $('#st-p95').textContent = fmt.ms(percentile(ms, 0.95));
  $('#st-max').textContent = ms.length ? fmt.ms(Math.max(...ms)) : '—';
  $('#st-err').textContent = String(Telemetry.counts.err);

  $('#st-hit').textContent = String(Telemetry.counts.hit);
  $('#st-miss').textContent = String(Telemetry.counts.miss);
  $('#st-saved').textContent = fmt.bytes(Telemetry.counts.bytesSaved);

  renderLatencyChart();
  renderCacheDonut();
  renderUsageBars();
  renderEventLog();
}

function renderUsageBars() {
  const host = $('#usage-bars');
  const empty = $('#usage-empty');
  host.replaceChildren();

  const rows = Object.entries(Telemetry.places).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!rows.length) { empty.hidden = false; return; }
  empty.hidden = true;

  const max = rows[0][1];
  for (const [name, n] of rows) {
    const row = el('div', { className: 'bar-row' });
    row.appendChild(el('span', { className: 'bar-row__name', textContent: name, title: name }));
    const track = el('span', { className: 'bar-row__track' });
    const fill = el('span', { className: 'bar-row__fill' });
    fill.style.setProperty('width', Math.round((n / max) * 100) + '%');
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', { className: 'bar-row__n', textContent: `${n}×` }));
    host.appendChild(row);
  }
}

function renderEventLog() {
  const host = $('#event-log');
  host.replaceChildren();
  const rows = Telemetry.log.slice(-60).reverse();

  if (!rows.length) {
    host.appendChild(el('p', { className: 'empty', textContent: 'No events recorded yet.' }));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const d = new Date(r.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const row = el('div', { className: 'log__row' }, [
      el('span', { className: 'log__t', textContent: time }),
      el('span', { className: 'log__k', textContent: r.kind, dataset: { lvl: r.lvl || 'info' } }),
      el('span', { className: 'log__m', textContent: r.msg || '' })
    ]);
    frag.appendChild(row);
  }
  host.appendChild(frag);
}

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

    if (query.trim().length < 3 || !hasKey()) return;

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
        textContent: hasKey() ? 'No matching places found.' : 'No Malaysian match. Add an API key to search worldwide.',
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
 * 19 · VIEWS
 * ═══════════════════════════════════════════════════════════════════════════ */

const VIEWS = ['dashboard', 'explore', 'analytics'];

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
  if (name === 'analytics') renderAnalytics();
  if (name === 'dashboard') renderHourly();

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
    : 'Running in local account mode: your credentials are hashed with PBKDF2-SHA256 and stored only in this browser. Add a Firebase config to config.js to enable Google sign-in and cross-device sync.';

  $('#btn-google').disabled = Auth.mode !== 'firebase';
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
  $('#set-units').value = state.units;
  $('#set-home').value = state.home;
  $('#set-analytics').checked = state.analytics !== false;
  $('#set-motion').checked = Boolean(state.reduceMotion);
  $('#settings-dialog').showModal();
}

async function saveSettingsFromDialog() {
  const key = $('#set-apikey').value.trim();
  const hadKey = hasKey();

  if (key) safeLocal.set(LS.apiKey, key); else safeLocal.del(LS.apiKey);

  state.units = $('#set-units').value;
  state.home = $('#set-home').value;
  state.analytics = $('#set-analytics').checked;
  state.reduceMotion = $('#set-motion').checked;
  Telemetry.enabled = state.analytics;

  saveSettings();
  applyUnits();
  applyMotion();
  $('#settings-dialog').close();
  toast('Settings saved.', 'success');

  if (key && !hadKey) {
    CachePolicy.clear();          // demo payloads must not linger once a key exists
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
    if (activeView === 'analytics') renderAnalytics();
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

  /* ── Analytics ──────────────────────────────────────────────────────── */
  $('#btn-export').addEventListener('click', () => {
    downloadJSON(`cuacamy-analytics-${new Date().toISOString().slice(0, 10)}.json`, Telemetry.snapshot());
    toast('Analytics exported.', 'success');
  });

  $('#btn-clear-analytics').addEventListener('click', () => {
    Telemetry.reset();
    renderAnalytics();
    toast('Analytics cleared.');
  });

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
    if (activeView === 'analytics') { renderLatencyChart(); renderCacheDonut(); }
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
    try {
      const pos = await getPosition({ timeout: 6000 });
      const place = await Api.reverse(pos.coords.latitude, pos.coords.longitude);
      return { ...place, lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch { /* fall through to the saved place */ }
  }
  if (state.home === 'kl') return { ...CONFIG.defaultCity };

  const last = safeLocal.json(LS.lastPlace, null);
  if (last && Number.isFinite(last.lat) && Number.isFinite(last.lon)) return last;
  return { ...CONFIG.defaultCity };
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
  $('#banner-setup').hidden = hasKey();
  setAuthMode('signin');

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
