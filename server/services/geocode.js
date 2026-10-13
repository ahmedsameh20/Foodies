// Address search ("geocoding") for the map pickers, through a Nominatim-compatible HTTP API.
//
// The browser never talks to the geocoder: requests go through this module so that
//   * the provider is configurable (GEOCODER_URL; set it empty to switch address search off - the map still works by clicking),
//   * the required identifying User-Agent is sent (the public OpenStreetMap service rejects anonymous clients),
//   * the public usage policy is respected: at most one upstream request per GEOCODER_MIN_INTERVAL_MS (default 1100 ms) per server
//     process, identical searches are answered from a small cache, and the client debounces typing,
//   * no API key or secret is ever exposed to the browser.
// The public nominatim.openstreetmap.org service forbids heavy / autocomplete use: for production traffic point GEOCODER_URL at a
// self-hosted Nominatim or a commercial Nominatim-compatible provider.
const config = require('../config');
const { HttpError } = require('../utils');

const cache = new Map(); // key -> { at, value }
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 500;
let chain = Promise.resolve();
let lastCall = 0;

const unavailable = (why) => new HttpError(503, 'geocoder_unavailable', 'Address search is unavailable right now. You can still click the map to place the marker.', { why });

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastCall + config.geocoder.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

const pick = (a = {}) => {
  const out = {};
  const map = {
    house_number: a.house_number, road: a.road, suburb: a.suburb || a.neighbourhood || a.quarter, city: a.city || a.town || a.village || a.municipality,
    state: a.state || a.region, postcode: a.postcode, country: a.country, country_code: a.country_code,
  };
  for (const [k, v] of Object.entries(map)) if (typeof v === 'string' && v) out[k] = v.slice(0, 200);
  return out;
};
const shape = (r) => ({ displayName: String(r.display_name || '').slice(0, 300), latitude: Number(r.lat), longitude: Number(r.lon), address: pick(r.address) });
const valid = (x) => Number.isFinite(x.latitude) && Number.isFinite(x.longitude) && Math.abs(x.latitude) <= 90 && Math.abs(x.longitude) <= 180;

async function call(path, params) {
  if (!config.geocoder.url) throw new HttpError(503, 'geocoder_disabled', 'Address search is not configured. Click the map to place the marker.');
  const url = new URL(path, `${config.geocoder.url.replace(/\/+$/, '')}/`);
  for (const [k, v] of Object.entries({ format: 'jsonv2', addressdetails: 1, ...params })) url.searchParams.set(k, String(v));
  if (config.geocoder.email) url.searchParams.set('email', config.geocoder.email);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': config.geocoder.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  } catch { throw unavailable('network'); }
  if (res.status === 429) throw new HttpError(503, 'geocoder_unavailable', 'Address search is busy. Please try again in a moment.', { why: 'rate_limited' });
  if (!res.ok) throw unavailable(`http_${res.status}`);
  try { return await res.json(); } catch { throw unavailable('bad_response'); }
}

function cached(key, make) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  return throttled(make).then((value) => {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

const search = (q, lang) => cached(`s|${lang}|${q.toLowerCase()}`, async () => {
  const rows = await call('search', { q, limit: 6, 'accept-language': lang, ...(config.geocoder.countryCodes ? { countrycodes: config.geocoder.countryCodes } : {}) });
  return (Array.isArray(rows) ? rows : []).map(shape).filter(valid);
});

const reverse = (lat, lon, lang) => cached(`r|${lang}|${lat.toFixed(5)}|${lon.toFixed(5)}`, async () => {
  const r = await call('reverse', { lat, lon, zoom: 18, 'accept-language': lang });
  return r && !r.error ? [shape({ ...r, lat: r.lat ?? lat, lon: r.lon ?? lon })].filter(valid) : [];
});

module.exports = { search, reverse };
