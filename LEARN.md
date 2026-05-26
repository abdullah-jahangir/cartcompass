# How CartCompass Works — A Learning Guide

This document explains every architectural decision in the app, written so you
understand *why* each piece exists, not just what it does.

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [The Compass Math](#2-the-compass-math)
3. [How We Find the Nearest Cart](#3-how-we-find-the-nearest-cart)
4. [Why We Needed a Proxy](#4-why-we-needed-a-proxy)
5. [What Is a Serverless Function?](#5-what-is-a-serverless-function)
6. [Cloudflare Pages Functions — How They Work](#6-cloudflare-pages-functions--how-they-work)
7. [Environment Variables — The Safe Way to Store Secrets](#7-environment-variables--the-safe-way-to-store-secrets)
8. [The Full Request Flow](#8-the-full-request-flow)
9. [Caching — Why We Cache and How](#9-caching--why-we-cache-and-how)
10. [PWA — Making It Installable on iPhone](#10-pwa--making-it-installable-on-iphone)
11. [Local Development Setup](#11-local-development-setup)
12. [Deploying to Cloudflare Pages](#12-deploying-to-cloudflare-pages)

---

## 1. The Big Picture

```
┌─────────────────────────────────────────────────────────────────┐
│                         iPhone                                  │
│                                                                 │
│  GPS sensor  →  your lat/lng                                    │
│  Gyroscope   →  which way phone is pointing (compass heading)   │
│                        │                                        │
│                        ▼                                        │
│         GET /api/carts?ll=40.75,-73.98                          │
└───────────────────────────────────────────────────────────────┬─┘
                                                                │
                                                                ▼
                              ┌─────────────────────────────────────┐
                              │   Cloudflare Edge (your function)   │
                              │                                     │
                              │   adds Authorization header         │
                              │   using secret env variable         │
                              └─────────────────────┬───────────────┘
                                                    │
                                                    ▼
                                         Foursquare Places API
                                         returns list of halal
                                         food places nearby
                                                    │
                                    (response flows back up)
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                         iPhone                                  │
│                                                                 │
│  [ nearest cart found ]                                         │
│                                                                 │
│  bearing = direction from you to cart (0–360°, 0 = North)       │
│  arrow rotation = bearing − compass heading                     │
│                                                                 │
│  → needle points at the cart                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. The Compass Math

This is the core of the app. Two numbers go in, one rotation comes out.

### Bearing (direction from you to the cart)

"Bearing" is a navigation term — it's the angle from North to the direction
you'd need to walk to reach a destination, measured clockwise.

- 0°   = cart is due North of you
- 90°  = cart is due East
- 180° = cart is due South
- 270° = cart is due West

We calculate it using the **Haversine formula** — a piece of spherical geometry
that accounts for the Earth's curvature:

```js
function bearing(lat1, lng1, lat2, lng2) {
  const Δλ = rad(lng2 - lng1);
  const y  = Math.sin(Δλ) * Math.cos(rad(lat2));
  const x  = Math.cos(rad(lat1)) * Math.sin(rad(lat2))
            - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
```

The `atan2` function converts the x/y components of the direction vector into
an angle. The `+ 360) % 360` normalises it to the 0–360 range.

### Device heading

The iPhone's gyroscope + magnetometer give us `webkitCompassHeading`:
- 0°   = top of phone is pointing North
- 90°  = top of phone is pointing East
- etc.

### Combining them

```
arrow rotation = bearing − device heading
```

Example:
- Cart is at bearing 90° (East of you)
- Phone top is pointing 90° (East)
- Arrow rotation = 90 − 90 = 0° → points straight up → "keep going straight"

Another example:
- Cart is at bearing 90° (East)
- Phone top is pointing 0° (North)
- Arrow rotation = 90 − 0 = 90° → points right → "turn right"

### The 0°/360° wrap problem

If the cart is at 5° and you turn so your heading is 355°, the naive calculation
gives 5 − 355 = −350°, making the needle spin almost all the way around the
wrong way instead of just 10°.

The fix is to always take the **shortest path**:

```js
const delta = ((targetAngle - displayedAngle % 360 + 540) % 360) - 180;
```

This compresses any angle difference into the range −180 to +180, so the needle
always rotates less than half a turn.

### Smooth animation

Instead of snapping the needle instantly (which would look jittery on noisy
sensor data), we **lerp** (linearly interpolate) toward the target:

```js
function lerpNeedle(target) {
  const diff = target - displayedAngle;
  displayedAngle += diff * 0.18;   // move 18% of remaining gap each frame
  el.needleWrap.style.transform = `rotate(${displayedAngle}deg)`;
  requestAnimationFrame(() => lerpNeedle(target));
}
```

At 60fps this produces a smooth, weighted animation. The needle accelerates
toward the target and decelerates as it approaches.

---

## 3. How We Find the Nearest Cart

We do a plain **linear scan** — loop through every cart, compute distance,
keep the smallest:

```js
let best = null, bestDist = Infinity;

for (const cart of S.carts) {
  const d = haversine(S.lat, S.lng, cart.lat, cart.lng);
  if (d < bestDist) { bestDist = d; best = cart; }
}
```

### Why not BFS (Breadth-First Search)?

BFS traverses edges in a **graph** — it's used for things like "shortest route
on a road network." We don't have a graph; we have a flat list of GPS points.
For a list, a linear scan is the right tool.

### Why not a k-d tree?

A k-d tree is a spatial data structure that finds the nearest point in
O(log n) instead of O(n). With ~50 carts returned by Foursquare, the linear
scan takes < 1ms — a k-d tree would actually be *slower* once you include
the time to build the index. It's worth considering if n grows to thousands.

### Distance formula: Haversine

```js
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in metres
  const φ1 = rad(lat1), φ2 = rad(lat2);
  const Δφ = rad(lat2 - lat1), Δλ = rad(lng2 - lng1);
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

This returns the **straight-line (as the crow flies)** distance in metres.
It's not the walking distance — that would require a routing API. For a compass
that's fine: we want to know which direction to face, not the exact route.

---

## 4. Why We Needed a Proxy

### The problem with browser-only API calls

When the app called Foursquare directly from the browser:

```
iPhone  ──── Authorization: MY_SECRET_KEY ────▶  Foursquare
```

The key had to travel to the browser. That means:

1. Anyone can open **DevTools → Network tab** and read it
2. Anyone can fetch `https://yoursite.com/js/config.js` and read it
3. They can use your key to make requests on your quota

Gitignoring `config.js` only stops the key from appearing in your GitHub
repo. It does nothing once the file is deployed.

### The solution: a proxy

A **proxy** sits between the browser and the third-party API. The browser
talks to the proxy (which you own), and the proxy talks to Foursquare with
the key added server-side.

```
iPhone  ──── GET /api/carts?ll=... ────▶  Your proxy (Cloudflare)
                  (no key here)                    │
                                      adds key from env variable
                                                   │
                                                   ▼
                                           Foursquare API
```

The key lives in Cloudflare's servers. It's never sent to the browser.
Someone with DevTools open sees:

```
GET /api/carts?ll=40.758,-73.985
```

No key. Nothing to steal.

---

## 5. What Is a Serverless Function?

Traditionally, if you needed server-side code, you'd rent a VM (virtual
machine), install Node.js/Python/whatever, keep it running 24/7, pay for it
whether you had traffic or not.

**Serverless functions** are a different model:

- You write a single function (one file)
- The cloud provider runs it **only when a request comes in**
- You pay per invocation (or get a free tier)
- No server to manage, no idle cost

For our proxy, the function runs for ~100ms per request (the time it takes
to call Foursquare), then stops. Cloudflare's free tier gives 100,000
invocations per day — plenty.

"Serverless" doesn't mean there's no server. It means *you* don't manage one.
Cloudflare does.

---

## 6. Cloudflare Pages Functions — How They Work

Cloudflare has two products relevant to us:

| Product | What it does |
|---|---|
| **Cloudflare Pages** | Hosts static files (HTML, CSS, JS, images) |
| **Pages Functions** | Runs server-side code alongside your Pages site |

Pages Functions are just files you put in a `functions/` folder. Cloudflare
auto-routes them based on the file path:

```
functions/api/carts.js  →  available at  /api/carts
functions/api/foo.js    →  available at  /api/foo
functions/hello.js      →  available at  /hello
```

No routing config. No framework. One file = one endpoint.

### The function file

```js
// functions/api/carts.js

export async function onRequestGet({ request, env }) {
  //                  ^^^^^^^^^^^^
  //                  Named handler — only fires on GET requests.
  //                  onRequestPost would handle POST, etc.

  const url = new URL(request.url);
  const ll  = url.searchParams.get('ll');  // read query params

  const upstream = await fetch('https://api.foursquare.com/...', {
    headers: { Authorization: env.FOURSQUARE_KEY }
    //                        ^^^
    //                        env is injected by Cloudflare — contains your secrets
  });

  return new Response(JSON.stringify(await upstream.json()), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### Cloudflare vs Vercel syntax

The key difference is *runtime*:

- **Vercel** runs Node.js — you get `req`, `res`, `process.env`
- **Cloudflare** runs V8 isolates (same engine as Chrome) — you get the web
  standard `Request`/`Response` objects and `env` for secrets

Cloudflare's approach is faster (no cold starts, runs in 300 locations
worldwide) and the `Request`/`Response` API is actually the web standard —
the same API you use in the browser with `fetch()`.

---

## 7. Environment Variables — The Safe Way to Store Secrets

An **environment variable** is a value that exists in the server's runtime
environment — not in your code, not in your repo.

### Locally

Cloudflare uses a file called `.dev.vars` (gitignored):

```
FOURSQUARE_KEY=your_key_here
```

When you run `npx wrangler pages dev .`, Wrangler reads this file and makes
`env.FOURSQUARE_KEY` available inside your function.

### In production (Cloudflare dashboard)

You set it once in the Cloudflare dashboard under:
**Pages → your project → Settings → Environment Variables**

Cloudflare encrypts it and injects it into your function at runtime. It
never appears in logs, never gets deployed in your code.

### Why this is safe

```
Your code (public on GitHub):
  Authorization: env.FOURSQUARE_KEY   ← references the variable, not the value

Cloudflare's servers (private):
  FOURSQUARE_KEY = "NS2K54GW..."      ← the actual value, stored encrypted
```

The value and the code are in two separate places. Leaking the code
(e.g. making the repo public) doesn't leak the key.

---

## 8. The Full Request Flow

Here's every step from "user taps Find Halal Carts" to "needle points at a cart":

```
1. User taps button
      │
2. app.js asks for iOS motion permission
   (DeviceOrientationEvent.requestPermission)
      │
3. app.js asks for GPS location
   (navigator.geolocation.getCurrentPosition)
      │
      ├── GPS returns lat/lng
      │
4. app.js calls fetchFoursquare(lat, lng)
      │
5. Browser sends:
   GET /api/carts?ll=40.758,-73.985&radius=8000
      │
6. Cloudflare routes to functions/api/carts.js
      │
7. Function reads env.FOURSQUARE_KEY (never sent to browser)
      │
8. Function calls Foursquare API with the key
      │
9. Foursquare returns JSON array of 50 nearby halal places
      │
10. Function adds Cache-Control header, returns JSON to browser
      │
11. app.js stores results in localStorage (6h cache)
      │
12. Linear scan finds nearest cart, calculates bearing
      │
13. DeviceOrientation events fire ~60/sec updating S.heading
      │
14. setInterval every 100ms: angle = bearing − S.heading
      │
15. rAF lerp animates needle toward angle
      │
16. User walks → GPS watchPosition fires → repeat from step 12
```

---

## 9. Caching — Why We Cache and How

We cache at two levels:

### Level 1: Cloudflare CDN (server-side)

```js
'Cache-Control': 's-maxage=21600, stale-while-revalidate=3600'
```

- `s-maxage=21600` — Cloudflare's edge stores the response for 6 hours
- For the same `?ll=...` query, Cloudflare returns the cached copy without
  hitting Foursquare at all
- `stale-while-revalidate=3600` — after 6h, serve the stale copy while
  fetching a fresh one in the background (no wait for the user)

### Level 2: localStorage (browser-side)

```js
localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: carts }));
```

- Cart data is saved in the browser's localStorage with a timestamp
- On next app open, if data is < 6 hours old, skip the network call entirely
- Works offline (if data was previously fetched)

### Why cache at all?

- Foursquare's free tier is 1,000 calls/day
- Halal carts don't move every hour
- Faster app start (no network round-trip)

---

## 10. PWA — Making It Installable on iPhone

A **Progressive Web App (PWA)** is a website that can be installed on the home
screen and behave like a native app. Three things make it work:

### 1. Web App Manifest (`manifest.json`)

Tells the browser the app's name, icons, and display mode:

```json
{
  "name": "CartCompass",
  "display": "standalone",    ← hides Safari's browser chrome
  "start_url": "./",
  "icons": [...]
}
```

### 2. Service Worker (`service-worker.js`)

A background script that intercepts network requests and serves from cache.
This is what makes the app work offline and load instantly.

```js
self.addEventListener('fetch', evt => {
  evt.respondWith(
    caches.match(evt.request).then(cached => cached ?? fetch(evt.request))
  );
});
```

### 3. iOS-specific meta tags (`index.html`)

Safari on iPhone predates the PWA standard and requires its own tags:

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="icons/icon-192.png">
```

### iOS compass permission quirk

iOS 13+ requires a **user gesture** (a tap) before you can request motion
sensor access:

```js
// This MUST be called inside a button click handler, not on page load
const result = await DeviceOrientationEvent.requestPermission();
```

That's why the app shows a "Find Halal Carts" splash button instead of
immediately starting — it's not just UX, it's required by iOS.

---

## 11. Local Development Setup

### Prerequisites

- Node.js 18+ installed
- A Cloudflare account (free): https://dash.cloudflare.com/sign-up

### Steps

```bash
# 1. Install Wrangler (Cloudflare's CLI)
npm install -g wrangler

# 2. Log in to Cloudflare
wrangler login

# 3. Make sure .dev.vars has your key
cat .dev.vars
# Should show: FOURSQUARE_KEY=your_key_here

# 4. Start local dev server
npx wrangler pages dev .
# → Static files served at http://localhost:8788
# → /api/carts function available at http://localhost:8788/api/carts
# → Wrangler reads .dev.vars and injects FOURSQUARE_KEY into your function
```

> **Note:** The compass needle won't move on desktop — `DeviceOrientationEvent`
> only fires on real mobile hardware. You can still test the UI, data fetching,
> and cart card by opening the URL on your phone (connected to the same WiFi).

---

## 12. Deploying to Cloudflare Pages

### First deploy

```bash
# 1. Push your code to GitHub
git add -A
git commit -m "your message"
git push origin main
```

```
2. Go to https://dash.cloudflare.com
3. Click "Pages" in the left sidebar
4. Click "Create a project" → "Connect to Git"
5. Select your cartcompass repository
6. Build settings:
     Framework preset: None
     Build command:    (leave empty)
     Output directory: (leave empty — root of repo)
7. Click "Save and Deploy"
```

### Add your API key (critical step)

```
1. After first deploy, go to your Pages project
2. Settings → Environment Variables
3. Click "Add variable"
4. Name:  FOURSQUARE_KEY
5. Value: your_foursquare_key_here
6. Select "Production" (and "Preview" if you want)
7. Click "Save"
8. Go to Deployments → click "Retry deployment"
   (the function needs to redeploy to pick up the new env var)
```

### After that

Every `git push` to `main` auto-deploys. Your live URL will be:
```
https://cartcompass.pages.dev
```
(or a custom domain if you set one up)

### Verify it's working

Open your deployed URL and check:
```
https://cartcompass.pages.dev/api/carts?ll=40.758,-73.985&radius=8000
```

You should get a JSON response with Foursquare results. If you see an error,
check the Cloudflare Pages dashboard → Functions → view logs.

---

## File Structure Reference

```
cartcompass/
│
├── index.html              ← App shell (3 screens: splash / loading / compass)
├── manifest.json           ← PWA config (icons, display: standalone)
├── service-worker.js       ← Offline caching for app shell
│
├── css/
│   └── style.css           ← Dark theme, iOS safe-area insets
│
├── js/
│   └── app.js              ← All client logic:
│                               permissions → GPS → fetch → bearing → needle
│
├── functions/
│   └── api/
│       └── carts.js        ← Cloudflare Pages Function (the proxy)
│                               URL: /api/carts
│
├── icons/
│   ├── icon.svg            ← Source icon
│   ├── icon-192.png        ← PWA home screen icon
│   └── icon-512.png        ← PWA splash icon
│
├── .dev.vars               ← Local dev secrets (gitignored)
├── .gitignore
├── generate-icons.js       ← Run once: node generate-icons.js
├── README.md               ← Quick-start guide
└── LEARN.md                ← This file
```
