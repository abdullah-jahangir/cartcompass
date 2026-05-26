/**
 * functions/api/carts.js — Cloudflare Pages Function
 *
 * Because this file lives in functions/api/, Cloudflare automatically
 * serves it at the URL path /api/carts — no routing config needed.
 *
 * Flow:
 *   iPhone  →  GET /api/carts?ll=40.75,-73.98&radius=8000
 *                          ↓  (this file runs on Cloudflare's servers)
 *              Foursquare API  (key added here, never sent to the browser)
 *                          ↓
 *              JSON response back to iPhone
 *
 * The API key lives in env.FOURSQUARE_KEY, set in the Cloudflare dashboard.
 * It is never in the code, never in git, never visible in the browser.
 */

// Cloudflare Pages Functions export named handlers per HTTP method.
// onRequestGet = handle GET requests only.
export async function onRequestGet({ request, env }) {

  // Parse the incoming URL so we can read query parameters
  const url    = new URL(request.url);
  const ll     = url.searchParams.get('ll');
  const radius = url.searchParams.get('radius') || '8000';

  // ── Basic validation ───────────────────────────────────────────────────────

  if (!ll) {
    return json({ error: 'Missing required parameter: ll' }, 400);
  }

  // ll must look like two numbers: "40.758,-73.985"
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(ll)) {
    return json({ error: 'Invalid ll — expected "lat,lng"' }, 400);
  }

  // ── Build Foursquare request ───────────────────────────────────────────────

  const params = new URLSearchParams({
    ll,
    query:  'halal food',
    radius,
    limit:  '50',
    fields: 'fsq_id,name,geocodes,location',
  });

  try {
    const upstream = await fetch(
      `https://api.foursquare.com/v3/places/search?${params}`,
      {
        headers: {
          // env.FOURSQUARE_KEY is the secret stored in Cloudflare's dashboard.
          // It's injected here at runtime — the browser never sees it.
          Authorization: env.FOURSQUARE_KEY,
          Accept:        'application/json',
        },
      }
    );

    // ── Handle Foursquare errors ─────────────────────────────────────────────

    if (upstream.status === 401) {
      console.error('[carts] Auth failed — check FOURSQUARE_KEY in Cloudflare dashboard');
      return json({ error: 'Upstream auth error' }, 502);
    }
    if (upstream.status === 429) {
      return json({ error: 'Rate limit reached — try again shortly' }, 429);
    }
    if (!upstream.ok) {
      return json({ error: `Upstream error ${upstream.status}` }, 502);
    }

    const data = await upstream.json();

    // ── Return with cache headers ────────────────────────────────────────────
    // s-maxage=21600 tells Cloudflare's CDN to cache this response for 6 hours.
    // Requests for the same location within that window never hit Foursquare at all.
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 's-maxage=21600, stale-while-revalidate=3600',
      },
    });

  } catch (err) {
    console.error('[carts] fetch failed:', err.message);
    return json({ error: 'Failed to reach Foursquare' }, 500);
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
