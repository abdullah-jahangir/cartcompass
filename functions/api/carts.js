/**
 * functions/api/carts.js — Cloudflare Pages Function
 *
 * Proxy between the browser and Google Places API (New).
 * The API key never leaves this server — the browser never sees it.
 *
 * Called by the app as:  GET /api/carts?ll=40.75,-73.98&radius=8000
 *
 * Google Places API (New) docs:
 * https://developers.google.com/maps/documentation/places/web-service/text-search
 */

module.exports = async function handler(req, res) {
  // ── Only allow GET ───────────────────────────────────────────────────────
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ll, radius = '8000' } = req.query;

  if (!ll) {
    return res.status(400).json({ error: 'Missing required parameter: ll' });
  }
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(ll)) {
    return res.status(400).json({ error: 'Invalid ll — expected "lat,lng"' });
  }

  const [lat, lng] = ll.split(',').map(Number);

  // ── Call Google Places Text Search (New) ─────────────────────────────────
  // Text Search lets us query "halal food" near a point.
  // It returns up to 20 results per request (max allowed).
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
          'Content-Type':    'application/json',
          // Key lives in Cloudflare env — never sent to the browser
          'X-Goog-Api-Key':  process.env.GOOGLE_PLACES_KEY,
          // Only request the fields we actually use (keeps cost at lowest tier)
          'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress',
        },
        body: JSON.stringify(body),
      }
    );

    if (upstream.status === 403) {
      console.error('[carts] Google Places: API key invalid or quota exceeded');
      return res.status(502).json({ error: 'Upstream auth error' });
    }
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      console.error('[carts] Google Places error:', err);
      return res.status(502).json({ error: `Upstream error ${upstream.status}` });
    }

    const data = await upstream.json();

    // Normalise Google's response shape to match what app.js already expects:
    // { results: [{ fsq_id, name, geocodes: { main: { latitude, longitude } }, location: { address } }] }
    const results = (data.places || []).map(p => ({
      fsq_id:   p.id,
      name:     p.displayName?.text || 'Halal Cart',
      geocodes: {
        main: {
          latitude:  p.location?.latitude,
          longitude: p.location?.longitude,
        },
      },
      location: {
        address: p.formattedAddress || '',
      },
    }));

    // Cache at Cloudflare's CDN for 6 hours — same location = same carts
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    return res.json({ results });

  } catch (err) {
    console.error('[carts] fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to reach Google Places' });
  }
};
