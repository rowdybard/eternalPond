# Eternal Pond

A persistent multiplayer orbital terrarium: one canonical ecology, anonymous returning souls, mortal fish lives, and a synchronized sky.

The remaster preserves Fable's authored Three.js pond in `frontend/pond3d.js`. The protocol-3 runtime in `frontend/pond-runtime-v2.js` connects that scene to the canonical Worker in `v2/worker/`; the discarded standalone `v2/web` remake is no longer part of the project. The old `backend/` remains historical V1 code.

## The experience

Eternal Pond opens as a quiet orbital overview, not a game lobby. At ordinary idle the water is intentionally sparse: most of the canonical wild population remains below the surface and only zero to three wild fish are normally visible. The first touch makes an immediate ripple and incarnates the visitor as a mortal soul fish at a server-validated position. It does not force the camera into follow mode.

Each browser receives a stable anonymous soul credential, generated poetic name, and visual tint. Tap the owned fish, press `C`, or use the camera control to move between the world-stable Ride camera and the orbital Overview. A returning visitor whose fish is still alive resumes in Ride; a visitor whose life ended while away receives that life record once and returns as a free soul.

Mortal lives last a randomized two to seven days unless predation ends one earlier. Newborn fish have a ten-minute refuge. On death, the camera rises, the completed life joins the dome's memory field, and the next water touch begins reincarnation. The world and its lives are canonical server state: closing a browser does not create a private copy or pause the ecology.

After birth, press and hold the pond to offer either Food or Seed. One offering can be accepted every five minutes:

- **Food** creates a 60-second attractor and may bring up to six existing wild fish to the surface.
- **Seed** creates a canonical lily. Visitor lilies grow for one 60-minute orbit, live for 72 hours, and visibly return during their final hour.

Rapid tapping is welcome. Every tap appears locally without waiting for the server, while compact 100 ms batches synchronize a bounded combined wave field for everyone else. Waves can scatter fish, rock lilies, turn frogs, or startle birds, but they never damage wildlife or shorten a life.

## The nature loop

- **Wild fish:** 48 exist canonically, with only 0-3 normally surfaced. Food and events reveal existing fish rather than spawning client-only crowds. Losses recover over 30-90 minutes.
- **Frogs:** 2 persistent frogs swim, float, rest on lilies, hop along shore, and roam the forest or facility ground. They visibly track and catch synchronized flying insects with their tongues. Every catch adds `0.3` to scale up to `3x`; growth and feeding count persist until that frog is eaten. A missing frog returns after roughly ten minutes.
- **Birds:** 6 persistent birds rotate through circling, shoreline foraging, and real tree or land perches with physical transition flights. Synchronized hunts occur every 12-18 minutes. Birds primarily take wild fish, may take at most one frog per six hours while always leaving one alive, and never target soul fish.
- **Soul predation:** a connected adult mortal soul can very rarely be threatened by a wild fish, at most once per 24 hours across the whole world. The eight-second warning is canceled if the target leaves, and the poetic life record does not expose the cause.
- **Lilies:** 5 opaque baseline pads are permanent. Visitor-grown lilies are canonical and deterministic, with a maximum of 24 active lilies; at capacity the oldest visitor lily returns while baseline pads remain.
- **Small events:** every 45-75 seconds the authority schedules a fish glint, frog call/hop/feed, bird transition, dragonfly pass, reed gust, lily movement, or water disturbance. Event creatures do not accumulate.
- **Legendary wildlife:** Fable's penguins remain rare, wild-only visitors. At most one can exist at once, and their emissive renderer is warmed and light-free to avoid the former spawn hitch.
- **Orbit:** the Sun, Earth, and Moon share a globally synchronized 60-minute cycle that drives lighting, water color, wildlife activity, ambient sound, and rare alignments.

This is an ecology, not a progression system. Wildlife eats, recovers, grows, rests, and responds whether or not one visitor sees every event. The presentation stays quiet: world motion, water, light, and sound communicate most activity instead of banners, streaks, achievements, or counters.

## Canonical architecture

- Fable's low-poly pond, water, dome, celestials, penguins, and village remain the visual foundation.
- `PondCoreV2` is the SQLite Durable Object authority. Its class name is retained for storage migration compatibility; it speaks protocol 3.
- 16 `PondGatewayV2` shards use hibernating WebSockets and publish compact state at 5 Hz from a 10 Hz simulation.
- Stable opaque soul credentials, generated poetic names, two-to-seven-day mortal lives, and returning-life queue priority.
- 128 embodied souls plus spectator overflow, verified locally with 100 and 128 simultaneous rapid-wave clients.
- A sparse ecology: 48 canonical wild fish with only 0-3 surfaced at idle, 6 role-driven birds, 2 persistent frogs, and 5 permanent baseline lilies.
- A live Canvas 2D spectator fallback uses the same protocol without granting birth or offerings.

Pond Keeper support uses the existing memorial life kind, but acquisition is a dark launch: purchase UI is hidden and the checkout route returns `404` while `KEEPER_BILLING_ENABLED=false`. Existing activated records retain their canonical fish state and recovery path.

See `3dguide.md` for rendering and architecture details.

## Local preview

```bash
npm install
npm run dev:v2:worker
npm run dev:web
```

Open `http://127.0.0.1:5173/`. The local Worker runs at `http://127.0.0.1:8787/`. Add `?renderer=canvas` to force the spectator fallback.

## Verification

```bash
npm run check:v2
npm run test:v2
npm run build:v2
$env:POND_LOAD_WAVES='1'; $env:POND_ALLOW_PERSISTENT_LOAD='1'; npm run load:v2 -- 100
```

Local visual diagnostics are `?benchmark=legendary`, `?event=birds`, and `?event=frogs`. The event diagnostics never alter canonical shared state.

## Production release

The existing Cloudflare projects are the production targets: the `shared-pond` Worker provides protocol 3 through `shared-pond.maxpug17.workers.dev`, and the Git-connected `shared-pond` Pages project serves `eternalpond.com` from `frontend/`.

Deploy the Worker before publishing a frontend that depends on it:

```bash
npm run deploy
git push origin main
```

Pushing `main` automatically replaces the current Pages production deployment. No separate frontend project or backend custom domain is required.

---

## Historical V1 setup

### POND - everyone is here

A shared, persistent global pond where every visitor drops ink and creatures into the same body of water in real-time. Hosted on itch.io as an HTML5 game, backed by Cloudflare Workers + Durable Objects.

### Project Structure

```
frontend/    — itch.io HTML5 game (canvas + WebSocket client)
backend/     — Cloudflare Worker + Durable Object (real-time sync)
```

### Setup

#### 1. Deploy the backend

```bash
cd backend
npm install
npx wrangler login
npx wrangler deploy
```

Note the deployed URL (e.g., `https://shared-pond.YOUR-SUBDOMAIN.workers.dev`).

#### 2. Update the frontend WebSocket URL

Edit `frontend/pond.js` line 2:

```js
const WS_URL = 'wss://shared-pond.YOUR-SUBDOMAIN.workers.dev/ws';
```

#### 3. Test locally

Serve the frontend with any static server:

```bash
cd frontend
npx serve .
```

Open `http://localhost:3000` — you should see the pond. If the backend is deployed, you'll connect automatically. If not, it runs in solo mode.

#### 4. Deploy to itch.io

1. Zip the contents of `frontend/` (index.html, style.css, pond.js)
2. Go to itch.io → Create new project
3. Kind of project: **HTML**
4. Upload the zip file
5. Set pricing to **Free** (or pay-what-you-want)
6. Check "This file will be played in the browser"
7. Set viewport to 100% width/height
8. Tags: `cozy`, `sandbox`, `multiplayer`, `art-game`, `experimental`
9. Cover image: take a screenshot of the pond with ink + creatures

### Tech

- **Frontend:** Vanilla JS + HTML5 Canvas (no dependencies)
- **Backend:** Cloudflare Workers + Durable Objects (WebSocket real-time sync)
- **Cost:** Cloudflare free tier (100k WS connections/day)
