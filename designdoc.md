# Eternal Pond — Design Document

## Overview
Eternal Pond is a shared, real-time idle pond environment where multiple users connect via WebSocket and interact with a living ecosystem. There is no win condition — it's a meditative, ambient experience where users spawn creatures, make waves, and watch life unfold.

## Architecture

### Frontend (`frontend/`)
- **`index.html`** — UI layout: canvas, toolbar, cooldown bar, event banner, feed, respawn banner, user panel, status bar
- **`style.css`** — All styling: glassmorphism UI, animations, responsive/mobile layout
- **`pond.js`** — Single-file game engine (~2500 lines): all entity classes, rendering, input, networking, main loop

### Backend (`backend/src/worker.js`)
- **Cloudflare Worker + Durable Object** (`PondRoom`) managing a single global pond
- WebSocket connections with session management
- State: creature list, lily list, user sessions with spawn counts
- Deployed to `https://shared-pond.maxpug17.workers.dev`
- Frontend deployed to Cloudflare Pages (`shared-pond.pages.dev`)
- WebSocket URL: `wss://ws.eternalpond.com/ws`

## Entities

### Fish
- **Tiers**: 0 (normal), 1 (large), 2 (large+), 3 (legendary with glow/shimmer)
- **Behavior**: AI-driven wandering with turn timers, edge avoidance, speed variation
- **Eating**: Fish eat dragonflies when close enough; large/legendary fish also eat lily pads
- **Growth**: Eating increases `growthScale` (up to 2.5x normal, 3x for legendary)
- **Player fish**: Cyan color (`#00f5d4`), no decay, name tag displayed above, behaves as AI fish
- **Visuals**: Body gradient, forked tail, dorsal/pectoral fins, specular stripe, gill line, layered eye, underwater shadow, dispersing trail particles
- **Transparency**: Fully opaque until life < 0.3, then fades out

### Frog
- **States**: `sitting`, `hopping`, `relaxing`, plus tongue state machine (`idle`, `extending`, `retracting`)
- **Lily pad relaxation**: When a frog hops and lands on a lily pad, enters `relaxing` state for 5-8 seconds with breathing animation (scale bob ±3%), contented squinted eyes, and occasional tiny contentment ripples
- **Tongue**: Extends toward dragonflies, grabs and retracts them for consumption
- **Growth**: Eating dragonflies increases `growthScale` (up to 3x)
- **Visuals**: Body gradient, wet sheen, back spots, webbed feet, bulbous eyes with highlights

### Dragonfly
- **States**: `hovering` (slow drift), `darting` (fast burst in random direction)
- **Prey**: Can be eaten by frogs (tongue) and fish
- **Visuals**: Iridescent wings with shimmer and veins, segmented body, compound eyes, soft shadow, motion trail

### LilyPad
- **Growth**: Starts small, grows to `maxSize` over time
- **Lifecycle**: Decays slowly; can be sunk by overlapping placement or large fish eating
- **Flowers**: 40% chance to have a flower with glow, double-layer petals, and pollen dots
- **Visuals**: Radial gradient pad, vein detail, water reflection shadow, specular sheen

### Bird
- **Targets**: Frogs and non-player fish (never player fish)
- **States**: `diving` (approach), `swooping` (scale down then up to simulate grabbing), `escaping` (fly away)
- **Swoop animation**: Bird scales from 1.0 → 0.4 → 1.0 to simulate dropping to water surface
- **Grab**: Succeeds if target within `size * 2` after swoop completes
- **Barrage**: 6-15 birds per event, staggered entry at 150ms intervals
- **Visuals**: Body gradient, feather lines on wings, talons when grabbing, shadow, eye highlight

### Wave
- **Mechanics**: Expanding ring with force that pushes creatures, damages lily pads
- **Foam**: Spawns foam particles at crest proportional to wave energy
- **Water grid disturbance**: Waves push the water displacement grid as they expand
- **Visuals**: Multi-ring depth gradient, triple-layer crest highlight, trailing rings, outer dispersion

### Water Displacement Grid
- **Desktop only** (disabled on mobile)
- 24x16 grid of points with spring physics
- Ambient undulation via per-point sine waves
- Disturbed by: clicks (120px radius), waves (60px radius), fish movement (30px radius), bird grabs (80px radius)
- Rendered as subtle grid lines + bright intersection dots at displaced points

### Trail Particles
- Global system (max 400 desktop / 150 mobile)
- Emitted by fish (tail position) and dragonflies (when darting)
- Each particle: random velocity, increasing spread, exponential decay
- Disperse gracefully into nothing

### Ripple
- Dual ring: soft outer glow + main ring
- Used for clicks, creature spawns, wave impacts, frog hops, bird grabs

### FoamParticle
- Spawned by waves at crest
- Bubbles with soft glow, core, specular dot
- Slight downward drift (settling)

## Water Rendering (`drawWater`)
1. **Depth gradient** — Vertical 6-stop gradient from light surface to dark depths
2. **Subsurface glow** — Radial gradient simulating light penetration from above
3. **God rays** — 6 volumetric light shafts (desktop only), animated position/angle/intensity
4. **Caustic interference** — 36x36 grid (16x16 mobile) of radial gradients with wave interference pattern
5. **Surface ripple texture** — 80 animated noise points (30 mobile)
6. **Specular shimmer** — 7 animated radial gradients (3 mobile) simulating sunlight
7. **Wave pool tint** — Red overlay when wave pool is active
8. **Depth vignette** — Radial gradient darkening edges
9. **Surface fog** — Subtle haze at top

## Performance / Quality Scaling
- **Mobile detection**: User agent regex + screen width < 768px
- **Mobile reductions**:
  - Caustic grid: 16x16 (vs 36x36)
  - God rays: 0 (vs 6)
  - Specular: 3 (vs 7)
  - Surface noise: 30 (vs 80)
  - Water grid: disabled
  - Foam: 120 (vs 300)
  - Birds: 18 (vs 36)
  - Trail particles: 150 (vs 400)
  - DPR cap: 1.5 (vs 2)
- **Error handling**: Main loop wrapped in try/catch to prevent silent crashes

## Player System
- **Spawn**: On WebSocket connect, a player fish spawns at center with random tier
- **Death**: Player fish can die from bird grabs or off-screen drift; respawn banner appears
- **Respawn**: Next fish the user spawns becomes their new player fish (random tier, can't claim legendaries)
- **No click-to-claim**: Removed — prevents cherry-picking existing fish
- **Visual distinction**: Cyan color, name tag above, no decay

## Event System
- **Timer**: Real-time based (not frame-counted), `EVENT_DURATION` seconds
- **Event types**:
  - `feeding_frenzy` — Spawns 6 dragonflies
  - `big_fish` — Spawns a legendary (tier 3) fish
  - `frog_party` — Spawns 4 frogs
  - `lily_bloom` — Spawns 5 lily pads
  - `bird_strike` — Spawns bird barrage (6-15 birds targeting frogs + fish)
- **Random bird strikes**: ~0.8% chance per second when ≥2 creatures exist
- **Banner**: Top-center, slides in with event text + countdown timer

## Red Button + Wave Pool
- **Red button**: 0.01% chance per second to appear as a pulsing red circle at random position
- **Auto-removes** after 15 seconds if not clicked
- **Wave pool**: Activated on click, lasts 10 seconds, auto-spawns waves from screen edges
- **Synced**: Broadcasts to all connected users

## Backend Systems
- **Session management**: WebSocket connections with auto-generated names (adjective + noun)
- **State sync**: Full creature + lily arrays sent in snapshot to new joiners
- **Action broadcast**: All user actions broadcast to other sessions with actor info
- **Rate limiting**: Max 10 actions/second per user (timestamp array filter)
- **Message size guard**: Max 1KB per WebSocket message
- **Pruning**: Every 30 seconds, removes creatures older than 20 min and lilies older than 30 min
- **Caps**: Creatures max 100, lilies max 60 (on backend)

## UI Elements
- **Toolbar**: 5 tools — wave, fish, frog, dragonfly, lily
- **Cooldown bar**: Thin bar above toolbar, fills as cooldown recovers
- **Feed**: Right-side activity log (max 20 items, auto-scroll)
- **User panel**: Modal showing all online users with spawn counts (click online count to open)
- **Status bar**: Bottom — online count, user name, hint text
- **Respawn banner**: Modal shown on player fish death
- **Event banner**: Top-center, shows current event + timer
- **Wave pool banner**: Shows when wave pool is active

## Input Handling
- **Canvas-only**: `handlePointerDown` checks `e.target !== canvas` to ignore UI clicks
- **Stop propagation**: Feed and user panel stop mousedown/touchstart from reaching canvas
- **Drag support**: Hold and drag to continuously create waves
- **Touch support**: Full touch event handling for mobile

## Deployment
- **Frontend**: `npx wrangler pages deploy frontend --project-name=shared-pond --commit-dirty=true`
- **Backend**: `npx wrangler deploy` (from `backend/` directory)
- **Frontend URL**: `https://<hash>.shared-pond.pages.dev`
- **Backend URL**: `https://shared-pond.maxpug17.workers.dev`
- **WebSocket**: `wss://ws.eternalpond.com/ws`
