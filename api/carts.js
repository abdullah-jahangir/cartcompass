/**
 * api/carts.js — Vercel serverless function
 *
 * Acts as a proxy between the browser and Foursquare.
 * The API key never leaves this server — the browser never sees it.
 *
 * Called by the app as:  GET /api/carts?ll=40.75,-73.98&radius=8000
 * This function adds the Authorization header and forwards to Foursquare.
 */

module.exports = async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Pull params from the request query string
  const { ll, radius = '8000' } = req.query;

  if (!ll) {
    return res.status(400).json({ error: 'Missing required parameter: ll' });
  }

  // Validate ll looks like two numbers (basic sanity check)
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(ll)) {
    return res.status(400).json({ error: 'Invalid ll format. Expected: lat,lng' });
  }

  // Build the Foursquare URL
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
          // Key lives in Vercel environment variables — never sent to the browser
          Authorization: process.env.FOURSQUARE_KEY,
          Accept: 'application/json',
        },
      }
    );

    // Handle Foursquare-side errors cleanly
    if (upstream.status === 401) {
      console.error('[carts] Foursquare auth failed — check FOURSQUARE_KEY env var');
      return res.status(502).json({ error: 'Upstream auth error' });
    }
    if (upstream.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached — try again later' });
    }
    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream error ${upstream.status}` });
    }

    const data = await upstream.json();

    // Tell Vercel's CDN edge to cache this response for 6 hours.
    // Same location → same carts → no need to re-fetch every request.
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    return res.json(data);

  } catch (err) {
    console.error('[carts] fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to reach Foursquare' });
  }
};
