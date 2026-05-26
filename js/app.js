/**
 * CartCompass — app.js
 * Finds the nearest halal food cart and points a compass needle toward it.
 *
 * Data source: Foursquare Places API (free tier, 1,000 calls/day)
 * API key lives in js/config.js (gitignored).
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const CACHE_KEY    = 'cartcompass_carts_v4';   // bumped so old cache is ignored
const CACHE_TTL    = 6 * 60 * 60 * 1000;      // 6 hours
const FETCH_RADIUS = 8000;                     // metres to search
const NYC_BOUNDS   = { minLat: 40.4774, maxLat: 40.9176, minLng: -74.2591, maxLng: -73.7004 };

// ── State ────────────────────────────────────────────────────────────────────
const S = {
  lat: null,
  lng: null,
  heading: 0,          // device compass heading, degrees, 0 = North CW
  carts: [],
  nearest: null,
  bearingToCart: 0,
};

// ── DOM ──────────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = {
  splash:        $('splash'),
  loadingScreen: $('loading-screen'),
  compassScreen: $('compass-screen'),
  loadingMsg:    $('loading-msg'),
  needleWrap:    $('needle-wrap'),
  cartName:      $('cart-name'),
  cartDistance:  $('cart-distance'),
  cartAddress:   $('cart-address'),
  directionsLink:$('directions-link'),
  cityBadge:     $('city-badge'),
  errorBanner:   $('error-banner'),
  errorText:     $('error-text'),
  tickCanvas:    $('tick-canvas'),
};

// ── Screen management ────────────────────────────────────────────────────────
function showScreen(name) {
  [el.splash, el.loadingScreen, el.compassScreen].forEach(s =>
    s.classList.remove('active')
  );
  ({ splash: el.splash, loading: el.loadingScreen, compass: el.compassScreen }[name])
    .classList.add('active');
}

// ── Entry point ──────────────────────────────────────────────────────────────
$('start-btn').addEventListener('click', startApp);
$('refresh-btn').addEventListener('click', refreshCarts);
$('dismiss-error').addEventListener('click', () => el.errorBanner.classList.add('hidden'));

async function startApp() {
  showScreen('loading');
  setLoadingMsg('Requesting permissions…');

  try {
    // Step 1 — Device orientation permission (iOS 13+ requires user gesture)
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') {
        throw new Error('Motion permission denied. Allow motion in Settings → Safari → Motion & Orientation Access.');
      }
    }

    // Step 2 — Get location
    setLoadingMsg('Getting your location…');
    const pos = await getLocation();
    S.lat = pos.coords.latitude;
    S.lng = pos.coords.longitude;
    updateCityBadge(S.lat, S.lng);

    // Step 3 — Fetch carts
    setLoadingMsg('Finding halal carts nearby…');
    S.carts = await loadCarts(S.lat, S.lng);

    if (S.carts.length === 0) {
      throw new Error('No halal carts found in your area. Try refreshing or check your location.');
    }

    // Step 4 — Boot up sensors + show UI
    startGeolocationWatch();
    startCompass();
    drawTickMarks();
    updateNearest();
    showScreen('compass');

  } catch (err) {
    setLoadingMsg('⚠ ' + err.message);
    setTimeout(() => showScreen('splash'), 4000);
  }
}

// ── Loading helper ───────────────────────────────────────────────────────────
function setLoadingMsg(msg) { el.loadingMsg.textContent = msg; }

// ── Geolocation ──────────────────────────────────────────────────────────────
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported in this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, err => {
      const msgs = {
        1: 'Location access denied. Tap "Allow" when Safari asks, or enable it in Settings.',
        2: 'Could not determine your location. Check GPS signal.',
        3: 'Location request timed out. Please try again.',
      };
      reject(new Error(msgs[err.code] ?? 'Location error.'));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

function startGeolocationWatch() {
  navigator.geolocation.watchPosition(
    pos => {
      S.lat = pos.coords.latitude;
      S.lng = pos.coords.longitude;
      updateNearest();
    },
    err => console.warn('Location watch error:', err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

// ── Compass / Orientation ────────────────────────────────────────────────────
let usedAbsolute = false;

function startCompass() {
  // Prefer deviceorientationabsolute (true magnetic heading) when available
  window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('deviceorientation', onOrientationFallback, true);
}

function onOrientation(evt) {
  if (evt.webkitCompassHeading != null) {
    // iOS — webkitCompassHeading: 0 = North, increases clockwise ✓
    S.heading = evt.webkitCompassHeading;
    usedAbsolute = true;
  } else if (evt.absolute && evt.alpha != null) {
    // Android with absolute heading
    S.heading = (360 - evt.alpha + 360) % 360;
    usedAbsolute = true;
  }
}

function onOrientationFallback(evt) {
  if (usedAbsolute) return;   // already have absolute heading
  if (evt.webkitCompassHeading != null) {
    S.heading = evt.webkitCompassHeading;
  } else if (evt.alpha != null) {
    S.heading = (360 - evt.alpha + 360) % 360;
  }
}

// ── Needle animation (rAF-based lerp, handles 0/360 wrap gracefully) ─────────
let displayedAngle = 0;
let animFrameId    = null;

function setNeedleAngle(targetRaw) {
  // Normalise delta to the shortest path (-180 … +180)
  const delta = ((targetRaw - displayedAngle % 360 + 540) % 360) - 180;
  const fullTarget = displayedAngle + delta;

  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(() => lerpNeedle(fullTarget));
}

function lerpNeedle(target) {
  const diff = target - displayedAngle;
  if (Math.abs(diff) < 0.3) {
    displayedAngle = target;
    el.needleWrap.style.transform = `rotate(${displayedAngle}deg)`;
    animFrameId = null;
    return;
  }
  displayedAngle += diff * 0.18;
  el.needleWrap.style.transform = `rotate(${displayedAngle}deg)`;
  animFrameId = requestAnimationFrame(() => lerpNeedle(target));
}

// ── Data fetching ────────────────────────────────────────────────────────────
async function loadCarts(lat, lng) {
  // Return cache if still fresh
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (Date.now() - c.ts < CACHE_TTL && c.data.length > 0) {
        console.log('[CartCompass] Using cached data:', c.data.length, 'carts');
        return c.data;
      }
    }
  } catch (_) {}

  const carts = await fetchFoursquare(lat, lng);
  console.log('[CartCompass] Foursquare returned:', carts.length, 'carts');

  // Persist to cache
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: carts }));
  } catch (_) {}

  return carts;
}

async function fetchFoursquare(lat, lng) {
  // Hits our own Vercel proxy — key never touches the browser
  const params = new URLSearchParams({
    ll:     `${lat},${lng}`,
    radius: FETCH_RADIUS,
  });

  const res = await fetchWithTimeout(`/api/carts?${params}`, 15000);

  if (res.status === 429) throw new Error('Too many requests — try again in a moment.');
  if (!res.ok)            throw new Error(`Server error ${res.status}`);

  const json = await res.json();
  return (json.results || [])
    .filter(p => p.geocodes?.main?.latitude != null)
    .map(p => ({
      id:      `fsq_${p.fsq_id}`,
      name:    p.name || 'Halal Cart',
      lat:     p.geocodes.main.latitude,
      lng:     p.geocodes.main.longitude,
      address: buildFSQAddress(p.location),
      source:  'foursquare',
    }));
}

function buildFSQAddress(loc) {
  if (!loc) return '';
  // Prefer street address; fall back to neighbourhood / city
  return loc.address
    || [loc.neighborhood, loc.locality].filter(Boolean).join(', ')
    || '';
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

function inNYC(lat, lng) {
  return lat >= NYC_BOUNDS.minLat && lat <= NYC_BOUNDS.maxLat &&
         lng >= NYC_BOUNDS.minLng && lng <= NYC_BOUNDS.maxLng;
}

// ── Geo math ─────────────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = rad(lat1), φ2 = rad(lat2);
  const Δφ = rad(lat2 - lat1), Δλ = rad(lng2 - lng1);
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lng1, lat2, lng2) {
  const Δλ = rad(lng2 - lng1);
  const y  = Math.sin(Δλ) * Math.cos(rad(lat2));
  const x  = Math.cos(rad(lat1)) * Math.sin(rad(lat2))
            - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function rad(d) { return d * Math.PI / 180; }
function deg(r) { return r * 180 / Math.PI; }

function formatDist(m) {
  const ft = Math.round(m * 3.28084);
  return ft < 5280 ? `${ft} ft` : `${(ft / 5280).toFixed(1)} mi`;
}

// ── UI updates ───────────────────────────────────────────────────────────────
function updateNearest() {
  if (!S.lat || S.carts.length === 0) return;

  let best = null, bestDist = Infinity;
  for (const c of S.carts) {
    const d = haversine(S.lat, S.lng, c.lat, c.lng);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  if (!best) return;

  S.nearest      = best;
  S.bearingToCart = bearing(S.lat, S.lng, best.lat, best.lng);

  el.cartName.textContent     = best.name;
  el.cartDistance.textContent = formatDist(bestDist);
  el.cartAddress.textContent  = best.address || '';

  const mapsUrl = `https://maps.apple.com/?daddr=${best.lat},${best.lng}&dirflg=w`;
  el.directionsLink.href = mapsUrl;
  el.directionsLink.classList.remove('hidden');

  refreshNeedle();
}

function refreshNeedle() {
  if (!S.nearest) return;
  const angle = S.bearingToCart - S.heading;
  setNeedleAngle(angle);
}

// Poll needle every 100 ms so it stays live as heading changes
setInterval(refreshNeedle, 100);

// ── City badge ───────────────────────────────────────────────────────────────
function updateCityBadge(lat, lng) {
  el.cityBadge.textContent = inNYC(lat, lng) ? 'NYC' : 'Near You';
}

// ── Refresh ──────────────────────────────────────────────────────────────────
async function refreshCarts() {
  try {
    localStorage.removeItem(CACHE_KEY);
    showScreen('loading');
    setLoadingMsg('Refreshing cart data…');
    S.carts = await loadCarts(S.lat, S.lng);
    updateNearest();
    showScreen('compass');
  } catch (e) {
    showError('Refresh failed: ' + e.message);
    showScreen('compass');
  }
}

// ── Error display ────────────────────────────────────────────────────────────
function showError(msg) {
  el.errorText.textContent = msg;
  el.errorBanner.classList.remove('hidden');
}

// ── Tick marks on compass ring ───────────────────────────────────────────────
function drawTickMarks() {
  const canvas = el.tickCanvas;
  const size   = canvas.offsetWidth;
  canvas.width  = size * devicePixelRatio;
  canvas.height = size * devicePixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const cx = size / 2, cy = size / 2, r = size / 2;

  for (let i = 0; i < 360; i += 5) {
    const big = i % 45 === 0;
    const med = i % 15 === 0 && !big;
    if (!big && !med && i % 5 !== 0) continue;

    const angle = (i - 90) * Math.PI / 180;
    const inner = r - (big ? 14 : med ? 10 : 6);
    const outer = r - 3;

    ctx.beginPath();
    ctx.moveTo(cx + inner * Math.cos(angle), cy + inner * Math.sin(angle));
    ctx.lineTo(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle));
    ctx.strokeStyle = big ? '#555' : med ? '#3a3a3a' : '#282828';
    ctx.lineWidth   = big ? 2 : 1;
    ctx.stroke();
  }
}

// ── Service worker registration ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('service-worker.js')
      .then(() => console.log('[CartCompass] Service worker registered'))
      .catch(e => console.warn('[CartCompass] SW registration failed:', e));
  });
}
