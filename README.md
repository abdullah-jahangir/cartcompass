# 🧭 CartCompass

A Progressive Web App (PWA) for iPhones that acts as a compass pointing to the **nearest halal food cart** near you. Starting with NYC, expanding to more cities later.

**100% free** — no paid APIs, no backend, deploys to GitHub Pages.

---

## How It Works

```
Your GPS location  →┐
                     ├──▶ Bearing calculation ──▶ Rotating compass needle
Halal cart lat/lng ─┘
                    +
Device compass heading ──▶ subtract from bearing ──▶ needle shows right direction
```

### Data Sources (both free, no API key)
| Source | Coverage | Notes |
|--------|----------|-------|
| [Overpass API (OpenStreetMap)](https://overpass-api.de) | Global | Halal-tagged food carts/restaurants |
| [NYC Open Data](https://opendata.cityofnewyork.us) | NYC only | Mobile Food Vendor Permits filtered by "HALAL" |

Cart data is cached in `localStorage` for 6 hours to minimise API calls.

---

## Quick Start (Local Dev)

```bash
# 1. Serve the project (any static server works)
npx serve .
# or
python3 -m http.server 8080

# 2. Open http://localhost:8080 in a browser
```

> **Note:** The compass (`DeviceOrientationEvent`) only works on a real iPhone over HTTPS.
> On desktop you'll still see the UI and cart data, but the needle won't rotate.

---

## Generate App Icons

```bash
npm install sharp
node generate-icons.js
# Outputs: icons/icon-192.png and icons/icon-512.png
```

---

## Deploy to GitHub Pages (free HTTPS)

1. Create a GitHub repo and push this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial CartCompass"
   git remote add origin https://github.com/<you>/cartcompass.git
   git push -u origin main
   ```

2. Go to **Settings → Pages** in your repo.  
   Set Source to **Deploy from a branch**, branch = `main`, folder = `/ (root)`.

3. Your app will be live at:  
   `https://<you>.github.io/cartcompass/`

4. On iPhone Safari: open the URL → tap the Share button → **Add to Home Screen**.

---

## Add to iPhone Home Screen

1. Open your deployed URL in **Safari** (not Chrome — Chrome blocks DeviceOrientation on iOS)
2. Tap the **Share** icon (box with arrow)
3. Tap **Add to Home Screen**
4. Tap **Add**
5. Open the app — tap **Find Halal Carts** — grant location + motion access

---

## Known Limitations

| Limitation | Status |
|---|---|
| Cart data is permit/crowd-sourced, not real-time GPS | By design — add disclaimer |
| iOS Safari requires user tap before requesting compass permission | Handled via splash button |
| Sparse OSM data in some neighbourhoods | NYC Open Data fills the gap for NYC |
| Android compass heading uses a different event field | Handled with fallback |

---

## Expanding to More Cities

To add another city's data, add a new `fetchXCity()` function in `js/app.js` following the same pattern as `fetchNYCOpenData()`, and call it inside `loadCarts()` when the user's coordinates fall within that city's bounding box. The Overpass API source already works globally without any changes.

---

## File Structure

```
cartcompass/
├── index.html          — App shell (3 screens: splash, loading, compass)
├── manifest.json       — PWA manifest (icons, theme, display: standalone)
├── service-worker.js   — Cache-first for app shell, offline support
├── css/
│   └── style.css       — Dark theme, iOS safe-area insets, compass ring
├── js/
│   └── app.js          — All logic: permissions, geo, data, bearing, needle
├── icons/
│   ├── icon.svg        — Source icon (compass on dark bg)
│   ├── icon-192.png    — PWA icon (generated)
│   └── icon-512.png    — PWA icon (generated)
├── generate-icons.js   — Script to create PNG icons from SVG
└── README.md
```

---

## Tech Stack

- **Vanilla HTML/CSS/JS** — no build step, no framework
- **PWA** — Web App Manifest + Service Worker
- **DeviceOrientationEvent** — built-in iPhone compass
- **navigator.geolocation** — built-in GPS
- **Overpass API** — free OpenStreetMap query API
- **NYC Open Data (Socrata)** — free city permit data
- **GitHub Pages** — free HTTPS hosting
