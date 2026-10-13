// Interactive OpenStreetMap pickers built on Leaflet (served from /vendor/leaflet, no CDN, no API key).
//
//   mountMapPicker(el, { lat, lng, label, onChange })   search box + click-to-place + draggable marker + typed coordinates
//   mountBranchesOverview(el, [{ name, latitude, longitude }])   all branches at once with numbered, distinct markers
//
// Address search goes through our own server (/api/geo/search): it identifies the application to the geocoding provider, throttles and
// caches. The search is debounced; when it is unavailable (not configured, rate limited, offline) the map still works by clicking it
// or by typing the coordinates.
import { api, publicConfig, $, esc, t, lang, isRtl } from './common.js';

let leafletReady;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletReady) {
    leafletReady = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
      document.head.append(css);
      const js = document.createElement('script');
      js.src = '/vendor/leaflet/leaflet.js';
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletReady = null; reject(new Error('map library failed to load')); };
      document.head.append(js);
    });
  }
  return leafletReady;
}

const DEFAULT_VIEW = { lat: 24.7136, lng: 46.6753, zoom: 5 }; // Saudi Arabia; the Foodies default market
const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const round = (n) => Math.round(n * 1e6) / 1e6;

// The tile provider's usage policy requires an identifying Referer: Leaflet's per-tile referrerPolicy guarantees it even if a page overrides the policy.
// When tiles cannot be loaded (blocked, offline, wrong URL) the broken-tile pattern is hidden and `onFail` / `onOk` tell the caller, which shows a
// localized message with a Retry button; coordinates stay editable meanwhile.
function tileLayer(L, cfg, { onFail = () => {}, onOk = () => {} } = {}) {
  const layer = L.tileLayer(cfg.map?.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: cfg.map?.attribution || '&copy; OpenStreetMap contributors', referrerPolicy: 'strict-origin-when-cross-origin', crossOrigin: false,
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', // a transparent pixel instead of the browser's broken-image icon
  });
  let ok = 0; let bad = 0; let reported = false;
  layer.on('tileload', (e) => { if (String(e.tile?.src).startsWith('data:')) return; /* the placeholder for a failed tile is not a success */ ok += 1; if (reported) { reported = false; onOk(); } });
  layer.on('tileerror', () => { bad += 1; if (!reported && ok === 0 && bad >= 3) { reported = true; onFail(); } });
  layer.resetCounters = () => { ok = 0; bad = 0; reported = false; };
  return layer;
}

// Keeps Leaflet's idea of the container size right whenever it changes (hidden section opened, dialog shown, window resized, RTL switch).
function watchSize(L, map, el) {
  if (typeof ResizeObserver === 'undefined') return () => {};
  let queued = false;
  const ro = new ResizeObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; if (el.isConnected) map.invalidateSize(); }); });
  ro.observe(el);
  return () => ro.disconnect();
}

const pin = (L, label, cls = '') => L.divIcon({
  className: 'map-pin-wrap', iconSize: [30, 38], iconAnchor: [15, 36],
  html: `<span class="map-pin ${cls}"><span>${esc(label)}</span></span>`,
});
// 15+ branches stay distinguishable: the hue is spread around the colour wheel by branch number
const hue = (i) => (i * 47) % 360;

export async function mountMapPicker(el, { lat = null, lng = null, label = '', pinLabel = '', onChange = () => {} } = {}) {
  const uid = `mp${Math.random().toString(36).slice(2, 8)}`;
  el.innerHTML = `<div class="map-picker">
    <div class="map-search" role="search">
      <label for="${uid}-q" class="sr-only">${esc(t('map.search'))}</label>
      <input id="${uid}-q" type="search" placeholder="${esc(t('map.searchPlaceholder'))}" autocomplete="off" maxlength="200">
      <button type="button" class="btn secondary sm" data-search>${esc(t('map.searchBtn'))}</button>
      <button type="button" class="btn secondary sm" data-locate>${esc(t('map.useMyLocation'))}</button>
    </div>
    <div class="map-status small muted" role="status" aria-live="polite"></div>
    <ul class="map-results" role="listbox" aria-label="${esc(t('map.results'))}" hidden></ul>
    <div class="map-frame"><div class="map-canvas" dir="ltr" role="application" aria-label="${esc(label || t('map.mapLabel'))}"></div>
      <div class="map-tilefail" role="alert" hidden><p>${esc(t('map.tilesFailedHelp'))}</p><button type="button" class="btn secondary sm" data-retry>${esc(t('map.retry'))}</button></div></div>
    <div class="row map-coords">
      <div class="field"><label for="${uid}-lat">${esc(t('map.latitude'))}</label><input id="${uid}-lat" inputmode="decimal" dir="ltr" autocomplete="off" data-lat></div>
      <div class="field"><label for="${uid}-lng">${esc(t('map.longitude'))}</label><input id="${uid}-lng" inputmode="decimal" dir="ltr" autocomplete="off" data-lng></div>
    </div>
    <p class="hint">${esc(t('map.hint'))}</p></div>`;
  const status = $('.map-status', el);
  const results = $('.map-results', el);
  const qInput = $(`#${uid}-q`, el);
  const latIn = $('[data-lat]', el);
  const lngIn = $('[data-lng]', el);
  const setStatus = (msg, err = false) => { status.textContent = msg || ''; status.classList.toggle('err-text', err); };

  let L; let cfg;
  try { [L, cfg] = await Promise.all([loadLeaflet(), publicConfig()]); } catch { setStatus(t('map.libFailed'), true); $('.map-canvas', el).hidden = true; return fallbackOnly(); }
  const hasPoint = valid(lat, lng);
  const map = L.map($('.map-canvas', el), { center: hasPoint ? [lat, lng] : [DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], zoom: hasPoint ? 16 : DEFAULT_VIEW.zoom, scrollWheelZoom: true });
  const canvas = $('.map-canvas', el);
  const tiles = tileLayer(L, cfg, {
    onFail: () => { setTiles(true); },
    onOk: () => { setTiles(false); },
  }).addTo(map);
  const stopWatch = watchSize(L, map, canvas);
  function setTiles(failed) { // never claims success: a failed map says so, and offers a retry
    $('.map-tilefail', el).hidden = !failed;
    if (failed) setStatus(t('map.tilesFailed'), true);
  }
  $('.map-tilefail [data-retry]', el).addEventListener('click', () => { setStatus(''); tiles.resetCounters(); tiles.redraw(); $('.map-tilefail', el).hidden = true; });
  if (cfg.map && cfg.map.addressSearch === false) { $('[data-search]', el).disabled = true; qInput.disabled = true; setStatus(t('map.searchOff')); }
  let marker = null;
  let revSeq = 0;
  const readout = () => { latIn.value = marker ? String(round(marker.getLatLng().lat)) : ''; lngIn.value = marker ? String(round(marker.getLatLng().lng)) : ''; };

  function place(la, ln, source, extra = {}) {
    if (!valid(la, ln)) return;
    la = round(la); ln = round(ln);
    if (!marker) {
      marker = L.marker([la, ln], { draggable: true, keyboard: true, icon: pin(L, pinLabel || '', 'active'), title: t('map.markerTitle') }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); place(p.lat, p.lng, 'drag'); });
    } else marker.setLatLng([la, ln]);
    readout();
    onChange({ latitude: la, longitude: ln, source, ...extra });
    if (source === 'click' || source === 'drag' || source === 'locate') reverse(la, ln);
  }
  async function reverse(la, ln) { // best effort: the address of the chosen point, never blocking
    const seq = ++revSeq;
    try {
      const { results: r } = await api(`/geo/reverse?lat=${la}&lon=${ln}&lang=${lang}`);
      if (seq !== revSeq || !r[0]) return;
      onChange({ latitude: la, longitude: ln, source: 'reverse', address: r[0].displayName, components: r[0].address });
    } catch { /* the coordinates are what matters; the address stays as typed */ }
  }
  if (hasPoint) place(lat, lng, 'init');

  map.on('click', (e) => place(e.latlng.lat, e.latlng.lng, 'click'));

  // typed coordinates keep the map and the marker in step (also the keyboard / screen-reader way to place a marker)
  const fromInputs = () => {
    const la = Number(latIn.value.replace(',', '.'));
    const ln = Number(lngIn.value.replace(',', '.'));
    if (latIn.value.trim() === '' || lngIn.value.trim() === '') return;
    if (!valid(la, ln)) { setStatus(t('map.badCoords'), true); return; }
    setStatus('');
    place(la, ln, 'input');
    map.setView([la, ln], Math.max(map.getZoom(), 15));
  };
  latIn.addEventListener('change', fromInputs);
  lngIn.addEventListener('change', fromInputs);

  // ---- address search: debounced, one request in flight (a newer search supersedes an older answer)
  let timer; let seq = 0;
  async function search(q) {
    q = q.trim();
    if (q.length < 3) { results.hidden = true; setStatus(q ? t('map.typeMore') : ''); return; }
    const mine = ++seq;
    setStatus(t('map.searching'));
    try {
      const { results: list } = await api(`/geo/search?q=${encodeURIComponent(q)}&lang=${lang}`);
      if (mine !== seq) return;
      if (!list.length) { results.hidden = true; setStatus(t('map.noResults')); return; }
      setStatus(t('map.pick'));
      results.innerHTML = list.map((r, i) => `<li role="option" tabindex="0" data-i="${i}">${esc(r.displayName)}</li>`).join('');
      results.hidden = false;
      results._list = list;
    } catch (e) {
      if (mine !== seq) return;
      results.hidden = true;
      const why = e.code === 'geocoder_disabled' ? t('map.searchOff') : e.status === 429 || e.details?.why === 'rate_limited' ? t('map.rateLimited') : e.status === 0 ? t('map.offline') : e.status === 401 ? t('map.signIn') : t('map.searchDown');
      setStatus(why, true);
    }
  }
  qInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(qInput.value), 700); });
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(qInput.value); } });
  $('[data-search]', el).addEventListener('click', () => { clearTimeout(timer); search(qInput.value); });
  const choose = (li) => {
    const r = results._list?.[Number(li.dataset.i)];
    if (!r) return;
    results.hidden = true;
    qInput.value = r.displayName;
    setStatus('');
    map.setView([r.latitude, r.longitude], 17);
    place(r.latitude, r.longitude, 'search', { address: r.displayName, components: r.address });
  };
  results.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(li); });
  results.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const li = e.target.closest('li[data-i]'); if (li) choose(li); } });

  // ---- "use my location": permission errors are explained, never silent
  $('[data-locate]', el).addEventListener('click', () => {
    if (!navigator.geolocation) { setStatus(t('map.locateUnsupported'), true); return; }
    setStatus(t('map.locating'));
    navigator.geolocation.getCurrentPosition(
      (pos) => { setStatus(''); map.setView([pos.coords.latitude, pos.coords.longitude], 17); place(pos.coords.latitude, pos.coords.longitude, 'locate'); },
      (err) => setStatus(err.code === 1 ? t('map.locateDenied') : t('map.locateFailed'), true),
      { enableHighAccuracy: true, timeout: 10000 });
  });
  // the map is removed (listeners, tiles, observers) when its container leaves the page, e.g. when the wizard re-renders another step
  const gone = new MutationObserver(() => { if (!el.isConnected || !el.contains(canvas)) { gone.disconnect(); stopWatch(); map.remove(); } });
  gone.observe(document.body, { childList: true, subtree: true });

  function fallbackOnly() { // the map library could not load: typed coordinates still work
    latIn.addEventListener('change', () => { const la = Number(latIn.value); const ln = Number(lngIn.value); if (valid(la, ln)) onChange({ latitude: round(la), longitude: round(ln), source: 'input' }); });
    lngIn.addEventListener('change', () => latIn.dispatchEvent(new Event('change')));
    if (valid(lat, lng)) { latIn.value = lat; lngIn.value = lng; }
    return { set() {}, get: () => ({ latitude: Number(latIn.value), longitude: Number(lngIn.value) }), refresh() {} };
  }
  void isRtl;
  return {
    set(la, ln) { if (valid(la, ln)) { place(la, ln, 'external'); map.setView([la, ln], 16); } },
    clear() { if (marker) { marker.remove(); marker = null; readout(); } },
    refresh() { map.invalidateSize(); },
    destroy() { gone.disconnect(); stopWatch(); map.remove(); },
  };
}

export async function mountBranchesOverview(el, branches) {
  let L; let cfg;
  try { [L, cfg] = await Promise.all([loadLeaflet(), publicConfig()]); } catch { el.innerHTML = `<p class="muted">${esc(t('map.libFailed'))}</p>`; return; }
  el.innerHTML = '<div class="map-canvas overview" dir="ltr" role="img"></div>';
  const canvas = $('.map-canvas', el);
  canvas.setAttribute('aria-label', t('map.overviewLabel', { n: branches.length }));
  const map = L.map(canvas, { center: [DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], zoom: DEFAULT_VIEW.zoom });
  tileLayer(L, cfg, { onFail: () => { el.insertAdjacentHTML('beforeend', `<p class="small err-text" role="alert">${esc(t('map.tilesFailed'))}</p>`); } }).addTo(map);
  const stopWatch = watchSize(L, map, canvas);
  new MutationObserver(function () { if (!el.isConnected || !el.contains(canvas)) { this.disconnect(); stopWatch(); map.remove(); } }).observe(document.body, { childList: true, subtree: true });
  const pts = [];
  branches.forEach((b, i) => {
    if (!valid(b.latitude, b.longitude)) return;
    const icon = L.divIcon({
      className: 'map-pin-wrap', iconSize: [30, 38], iconAnchor: [15, 36],
      html: `<span class="map-pin" style="--pin:hsl(${hue(i)} 70% 42%)"><span>${i + 1}</span></span>`,
    });
    L.marker([b.latitude, b.longitude], { icon, title: `${i + 1}. ${b.name || ''}` }).addTo(map).bindTooltip(`${i + 1}. ${b.name || ''}`);
    pts.push([b.latitude, b.longitude]);
  });
  if (pts.length === 1) map.setView(pts[0], 14); else if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
}

export const pinColor = (i) => `hsl(${hue(i)} 70% 42%)`;
