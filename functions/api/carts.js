/**
 * functions/api/carts.js — Cloudflare Pages Function
 *
 * Proxy between the browser and Google Places API (New).
 * The API key never leaves this server — the browser never sees it.
 *
 * Called by the app as:  GET /api/carts?ll=40.75,-73.98&radius=8000
 */

export async function onRequestGet({ request, env }) {
  const url    = new URL(request.url);
  const ll     = url.searchParams.get('ll');
  const radius = url.searchParams.get('radius') || '8000';

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!ll) {
    return json({ error: 'Missing required parameter: ll' }, 400);
  }
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(ll)) {
    return json({ error: 'Invalid ll — expected "lat,lng"' }, 400);
  }

  const [lat, lng] = ll.split(',').map(Number);

  // ── Call Google Places Text Search (New) ─────────────────────────────────
  const body = {
    textQuery: 'halal food',
    locationBias: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: parseFloat(radius),
      },
    },
    maxResultCount: 20,
  };

  try {
    const upstream = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-Goog-Api-Key':   env.GOOGLE_PLACES_KEY,
          // Only request fields we use — keeps billing at minimum tier
          'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress',
        },
        body: JSON.stringify(body),
      }
    );

    if (upstream.status === 403) {
      console.error('[carts] Google Places: key invalid or quota exceeded');
      return json({ error: 'Upstream auth error' }, 502);
    }
    if (!upstream.ok) {
      return json({ error: `Upstream error ${upstream.status}` }, 502);
    }

    const data = await upstream.json();

    // Normalise to the shape app.js already expects
    const results = (data.places || []).map(p => ({
      fsq_id:   p.id,
      name:     p.displayName?.text || 'Halal Cart',
      geocodes: {
        main: {
          latitude:  p.location?.latitude,
          longitude: p.location?.longitude,
        },
      },
      location: { address: p.formattedAddress || '' },
    }));

    return new Response(JSON.stringify({ results }), {
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 's-maxage=21600, stale-while-revalidate=3600',
      },
    });

  } catch (err) {
    console.error('[carts] fetch failed:', err.message);
    return json({ error: 'Failed to reach Google Places' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
