# Eternal Pond — Progress Tracker

## Project Structure
- `frontend/index.html` — UI layout (canvas, toolbar, cooldown bar, event banner, feed, user panel, respawn banner, status bar)
- `frontend/style.css` — All styling (glassmorphism, animations, responsive/mobile)
- `frontend/pond.js` — Game engine (~2510 lines): entities, rendering, input, networking, main loop
- `backend/src/worker.js` — Cloudflare Worker + Durable Object (`PondRoom`)
- `backend/wrangler.toml` — Cloudflare config
- `designdoc.md` — Full design document

## Completed Work

### Core Systems (DONE)
- Wave system with force, foam, crest rendering
- Water overhaul: depth gradient, subsurface glow, god rays, caustics, surface noise, specular shimmer, vignette, fog
- Creature food chain: fish eat dragonflies, large fish eat lily pads, frogs eat dragonflies via tongue
- Lily pad rules: growth, replacement, sinking, flower chance
- Entity off-screen death for all entities
- Random events: feeding frenzy, big fish, frog party, lily bloom, bird strike
- Red button + wave pool mode
- Backend WebSocket sync for waves, creatures, lilies, events, wave pool, birds

### AAA Graphics Pass (DONE)
- `drawWater`: Richer depth gradient, animated god rays, denser caustics, surface parallax, specular shimmer, fog/mist
- `Fish.draw`: Body gradient, soft shadow, forked tail, dorsal/pectoral fins, specular stripe, gill line, layered eye, legendary glow
- `Frog.draw`: Body gradient, wet sheen, back spots, webbed feet, bulbous eyes with highlights
- `Dragonfly.draw`: Iridescent wings (gradient, shimmer, veins), segmented body, compound eyes, soft shadow, motion trail
- `LilyPad.draw`: Radial gradient pad, vein detail, water reflection, flower with glow and pollen
- `Wave.draw`: Multi-ring depth, triple-layer crest, trailing rings, outer dispersion
- `FoamParticle.draw`: Larger bubbles, soft glow, core, specular dot
- `Ripple.draw`: Dual ring with soft glow
- `Bird.draw`: Body gradient, feather lines, talons, shadow, eye highlight

### Animated Water + Trails (DONE)
- 24x16 water displacement grid with spring physics and ambient undulation (desktop only)
- Clicks disturb water grid (120px radius, strength 8)
- Waves disturb water grid as they expand (60px radius)
- Fish disturb water grid as they move (30px radius, scaled by growth)
- Bird grabs disturb water grid (80px radius)
- TrailParticle system: fish and dragonflies emit dispersing particles that drift, spread, and fade
- Water grid rendered as subtle grid lines + bright intersection dots

### Frog Lily Pad Relaxation (DONE)
- Frogs that hop and land on a lily pad enter `relaxing` state
- 5-8 second duration (vs 1-3s normal sitting)
- Breathing animation: scale bob ±3%, vertical bob ±2px
- Contented squinted eyes (curved arcs instead of open eyes)
- No hunting while relaxing
- Occasional tiny contentment ripples

### Bird System Overhaul (DONE)
- 3x bird count: 6-15 per barrage (was 2-5), MAX_BIRDS 36 (was 12)
- Slower: dive speed 3.5 (was 6), swoop speed 2.5
- Swoop animation: scale 1.0 → 0.4 → 1.0 to simulate dropping to grab
- Birds target fish too (not just frogs), never player fish
- Better grab success rate
- Birds disturb water grid on grab

### Backend Hardening (DONE)
- Per-user rate limiting: max 10 actions/second
- Message size guard: max 1KB per WebSocket message
- Full state snapshot: sends all creatures + lilies (not truncated)

### Player Fish System (DONE)
- Player fish spawns on connect with random tier
- Cyan color, name tag, no decay
- Behaves as AI fish (no control)
- Death detection: bird grab or off-screen
- Respawn: next fish spawn becomes player (random tier, can't claim legendaries)
- Removed click-to-claim respawn and `possess` action
- Removed crown triangle indicator

### Mobile Performance (DONE)
- Quality scaling: mobile detection via UA + screen width
- Reduced caustic grid (16x16), god rays (0), specular (3), surface noise (30)
- Water displacement grid disabled on mobile
- Foam/trail/bird caps reduced
- DPR capped at 1.5
- Main loop wrapped in try/catch

### UI Fixes (DONE)
- Feed and user panel clicks no longer trigger canvas actions
- `handlePointerDown` checks `e.target !== canvas`
- stopPropagation on feed/user panel mousedown/touchstart

### Visual Fixes (DONE)
- Creatures stay fully opaque until life < 0.3, then fade out (no more random partial transparency)
- Event timers use real-time instead of frame counting

## Deployment
- Frontend: `npx wrangler pages deploy frontend --project-name=shared-pond --commit-dirty=true`
- Backend: `npx wrangler deploy` (from `backend/`)
- Frontend URL: `https://<hash>.shared-pond.pages.dev`
- Backend URL: `https://shared-pond.maxpug17.workers.dev`
- WebSocket: `wss://ws.eternalpond.com/ws`

## Known State
- All systems functional and deployed
- Mobile performance optimized
- No known bugs
