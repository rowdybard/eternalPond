# Eternal Pond - Canonical World and Rendering Guide

This is the active guide for the canonical remaster. It preserves Fable's authored low-poly orbital pond and layers synchronized nature, soul persistence, and sparse multiplayer state into that scene. Fable's original implementation guide remains intact under **Historical Reference** below.

## 1. Runtime map

```text
frontend/index.html                Authored page shell and minimal controls
frontend/pond3d.js                 Fable scene, water, dome, assets, procedural models
frontend/pond-runtime-v2.js        Protocol-3 scene adapter, interpolation, nature, camera
frontend/pond-client-v2.js         Identity, reconnect, clock sync, ripple batching
frontend/pond-ui.js                Wordmark, presence, camera control, hidden ledger
frontend/pond-canvas-v2.js         Live protocol-3 spectator fallback
frontend/pond-boot.js              WebGL startup and explicit fallback selection
v2/shared/src/index.ts             Protocol 3 and shared deterministic helpers
v2/worker/src/core.ts              Canonical ecology and SQLite persistence
v2/worker/src/gateway.ts           16 hibernating WebSocket fan-out shards
v2/worker/src/simulation.ts        Movement, lifespans, predation, fast-forward
v2/worker/src/queue.ts             Returning-life priority and FIFO birth queue
```

`PondCoreV2`, `PondGatewayV2`, and the `-v2.js` filenames retain their names for Durable Object and asset compatibility. They now implement protocol 3. The standalone `v2/web` remake was discarded after its useful systems were transplanted into the authored frontend.

## 2. Authority and timing

- The core is the sole ecology authority. Clients interpolate motions and render nature events; they do not invent wildlife or decide life transitions.
- Foreground simulation runs at 10 Hz and publishes compact `upserts`, `motions`, `hiddenIds`, and true `removedIds` at 5 Hz.
- Critical transitions persist immediately; active simulation checkpoints every 15 seconds.
- The 60-minute orbit derives from server time and influences celestials, light, water, fireflies, activity, and audio.
- Disconnected fish remain canonical but compact into background cohort metadata. Cohort counts are never expanded into rendered fish.

## 3. Sparse ecology

- The world seeds 48 wild fish, 6 birds, 2 frogs, and 5 permanent baseline lilies.
- Ordinary idle exposes only 0-3 existing wild fish. Food may surface up to 6 for 60 seconds.
- Birds rotate through real circling, shoreline-foraging, and code-owned perch roles. A synchronized hunt occurs every 12-18 minutes.
- Frogs move among water, lilies, shore, forest, and facility ground. A synchronized catch grows a frog by `0.3` to a `3x` cap and drives its mouth, tongue, bite, chew, blink, and body pulse.
- Visitor lilies are canonical, deterministic, opaque, water-height anchored, and limited to 24 active pads. Baseline pads are never replaced.
- One hitch-safe legendary penguin may appear under rare synchronized conditions. It uses cached geometry, emissive materials, and an additive halo, never a light.

## 4. Interaction and cameras

- The first water contact renders a local ripple immediately and requests incarnation at a server-sampled point. Birth remains in the overview.
- Later taps always render locally. Points collect for 100 ms into `rippleBatch` messages of at most 12 points and at most 10 batches per second.
- Holds after birth open Food and Seed. The nine-pixel drag cancellation threshold protects camera movement.
- Tap the owned fish, press `C`, or use the camera icon to toggle Ride and Overview.
- Ride follows world position with a spring and manual world bearing without inheriting fish heading. Returning living souls resume in Ride.
- Canvas fallback users share presence, orbit, entities, memories, and ripples as spectators but cannot incarnate or offer.

## 5. Rendering invariants

- `pond3d.js` owns the authored water and environment. The canonical runtime feeds server time and bounded disturbances into it rather than replacing its visual language.
- Every local tap gets a pooled visible ring: 96 desktop, 48 mobile. Only the strongest bounded disturbances reach the shader and rapid sounds blend.
- Lilies keep opaque materials and depth writing at every lifecycle stage. Aging uses color, scale, flower closure, and sinking, never alpha.
- CPU water-height sampling keeps pads and frogs aligned with the displaced surface.
- Fish labels stay permanent for the visitor, visible nearby, and condense into school counts when distant overlaps become unreadable.
- Never add per-creature lights. Changing the active Three.js light shape can trigger broad shader recompilation.

## 6. Capacity and protocol

- Protocol 3 uses `/ws/v3` and `/api/v3/status`; `/v2` aliases remain during migration.
- Capacity is 128 embodied souls with FIFO spectator overflow and returning-life priority.
- The live local harness passed 100 simultaneous wavers with 1,000 ripple batches and 128 clients with 127 embodied plus one queued spectator alongside the real preview soul.
- Opaque tokens stay in local storage while only token hashes persist server-side. Generated names remove public free text.
- `lifeKind: mortal | memorial` and memorial ownership fields support Pond Keeper, currently dark-launched with purchase UI and checkout disabled by configuration.

## 7. Local verification

```powershell
npm install
npm run dev:v2:worker
npm run dev:web
npm run check:v2
npm run test:v2
npm run build:v2
$env:POND_LOAD_WAVES='1'; $env:POND_ALLOW_PERSISTENT_LOAD='1'; npm run load:v2 -- 100
```

- Web preview: `http://127.0.0.1:5173/`
- Worker status: `http://127.0.0.1:8787/api/v3/status`
- Canvas spectator: `http://127.0.0.1:5173/?renderer=canvas`
- Legendary benchmark: `http://127.0.0.1:5173/?benchmark=legendary`
- Bird and frog visual diagnostics: `?event=birds` and `?event=frogs`

The diagnostics are localhost-only and never mutate shared ecology. Do not run the live load harness against production; use an isolated preview Durable Object.

---

# Historical Reference: Fable's Original 3D Pond

> A complete orientation for an AI agent (or human) tasked with understanding, modifying, or extending the **Eternal Pond** 3D experience. Read this top‑to‑bottom once before touching code. The single most important section is **[The Three Coordinate Spaces](#1-the-three-coordinate-spaces-read-this-first)** — almost every bug comes from confusing them.

---

## 0. What this project is

A shared, real‑time, ambient "pond in a space terrarium." Visitors connect over WebSocket and drop fish, frogs, dragonflies, lily pads, plankton, and waves into **one global pond**. There is no win state — it's meditative. Creatures have autonomous AI (wandering, eating, growth, death), random events stir the pond, and everything is rendered in Three.js inside a glowing energy dome floating in deep space.

- **Live frontend:** Cloudflare Pages → `https://shared-pond.pages.dev`
- **Live backend:** Cloudflare Worker + Durable Object → `https://shared-pond.maxpug17.workers.dev`
- **WebSocket:** `wss://shared-pond.maxpug17.workers.dev/ws` (primary), `wss://ws.eternalpond.com/ws` (fallback)

The canonical scene is the **root** (`/`). The 3D engine is a **single file**: `frontend/pond3d.js` (~3,300 lines). It loads Three.js **r128** from a CDN. All game AI is ported from an earlier 2D Canvas version (`pond.js`, now retired) and shares the exact same network protocol, so 2D and 3D clients could coexist in the same pond.

---

## Repo layout

```
frontend/
  index.html      Loads three r128 + OrbitControls + GLTFLoader (CDN), then pond3d.js.
                  Holds all UI DOM: loading screen, toolbar, banners, toast container,
                  respawn modal, user panel, status bar, #pond3d canvas.
  pond3d.js       THE 3D ENGINE. Single file. ~3,300 lines. Everything below lives here.
  style.css       Glassmorphism UI styling, animations, mobile layout.
  assets/         GLB models: fish, frog, dragonfly, lily, rocks, reeds, trees, bushes,
                  scifi building, sun/earth/moon, penguin (legendary fish).
backend/
  src/worker.js   Cloudflare Worker + Durable Object `PondRoom` (single global instance).
  wrangler.toml   Worker + DO binding config.
README.md         (describes the older 2D pond — historical)
designdoc.md      Full design doc (2D-era + planned-3D notes — historical but useful)
progress.md       Running changelog
3dguide.md        ← this file
pondprompt.md     5 ordered prompts to recreate this project from scratch
```

> **Note:** `README.md` / `designdoc.md` / `progress.md` predate the 3D rewrite and describe `pond.js` (2D Canvas). They are accurate about *game design and the network protocol* but **not** about the 3D rendering. When they disagree with `pond3d.js`, the code wins.

---

## 1. The three coordinate spaces (READ THIS FIRST)

Everything in the engine moves between **three** coordinate systems. Mixing them is the #1 source of bugs.

| Space | Range | Used for | Convert with |
|---|---|---|---|
| **Game space** | `0..1000` in x and y (`W = H = 1000`) | ALL AI, physics, eating, spawning, off‑screen tests | — (native) |
| **World space** | Three.js meters, centered on origin | Mesh positions, camera, lights | `toWorldX(x)`, `toWorldZ(y)` |
| **Network space** | `0..1` normalized | Everything sent over the wire | `normX/normY` out, `denormX/denormY` in |

```js
const W = 1000, H = 1000;
const SCALE = 0.12;                 // world units per game unit
function toWorldX(x){ return (x - W/2) * SCALE; }  // game x -> world x
function toWorldZ(y){ return (y - H/2) * SCALE; }  // game y -> world z (note: y maps to Z)
function normX(x){ return x / W; }  function denormX(x){ return x * W; }
```

**Rules that must never be broken:**
1. **AI thinks in game space.** A creature's `this.x, this.y` are always `0..1000`. Velocity, turn logic, eat ranges (80–160), edge margins (~60) — all game units. Never store world coordinates on an entity.
2. **`sync3D()` is the only place game→world happens.** Each entity's `update(dt)` mutates `this.x/this.y` in game space; `sync3D()` then pushes `mesh.position.set(toWorldX(this.x), height, toWorldZ(this.y))`.
3. **The wire is always normalized.** When you `sendAction`, convert with `normX/normY`. When you receive in `applyRemoteAction`, convert back with `denormX/denormY`. This is what lets every client (any screen size, 2D or 3D) agree on positions.
4. **Game `y` becomes world `z`.** The pond is a horizontal plane; world `y` is *up*. So game (x, y) → world (x, z), and height is computed separately (water at y=0, terrain via `terrainHeight`).

---

## 2. Terrain & the pond bowl

The pond is **one continuous bowl**, not a flat disc with walls. A single function defines the height profile as a function of radius `r` (game-space distance from center):

```
terrainHeight(r):
  r <= R_PLAY (90)        -> deep, gently dished basin   (-12 .. -9.5)
  r <= R_SHORE (~100)     -> smoothstep shore wall rising (-9.5 .. 0)
  beyond                  -> forest-floor plateau rising  (0 .. +7.5)
```

Key constants:
- `POND_DEPTH = 12` (basin depth below water), `BANK_RISE = 7.5` (land height above water).
- `R_WATER = HALF * 2.19 ≈ 131` — the water disc radius (in world units; it tucks *under* the rising bank so the shoreline is simply where terrain crosses y=0).
- The water surface mesh sits at **y = 0**. There is no separate flat floor — the water genuinely fills a hole in the terrain.

Terrain is built as `RingGeometry` discs with per‑vertex Y displacement + vertex colors (deep teal → wet sand → moss → dirt). Noise amplitude scales with radius (calm underwater, lumpy on land). See `buildTerrain` inside the `ENVIRONMENT` section.

---

## 3. Boot sequence

```js
// bottom of pond3d.js
Promise.all(Object.entries(ASSETS).map(([k,v]) => loadAsset(k, v))).then(init);
```

1. **Load all GLBs** (`loadAsset` never rejects — on failure it resolves `null`, and the entity falls back to a procedural mesh). This means a missing/blocked asset degrades gracefully instead of breaking the scene.
2. **`init()`** then:
   - `buildEnvironment()` — terrain, water, sky, dome, trees, mushrooms, fireflies, celestials, buildings, platform.
   - `fetchFishLives()` — GET the global "fish lives lived" analytics counter.
   - Retention setup: `checkStreak()`, `loadStats()`, `renderUserPanel()`, `checkAchievements()`, `startSessionTimer()`.
   - `connectWS()` — open the WebSocket.
   - `setTimeout(seedInitialLife, 1500)` — if the socket is slow/offline, seed a lively local pond so it's never empty.
   - `animate()` — start the main loop.
   - Hide the loading screen after 700 ms.

---

## 4. Core architecture: the entity contract

All living things are ES6 classes with an **identical three‑method contract**. Learn this once and every entity makes sense.

```js
class Thing3D {
  constructor(x, y, ...) { /* game-space state + build/clone mesh + scene.add(mesh) */ }
  update(dt) { /* mutate game-space state; return TRUE if still alive, FALSE if it should die */ }
  sync3D(dt) { /* push game state -> three mesh: position, rotation, scale, opacity, animation */ }
  destroy() { /* scene.remove(...) + dispose geometry/material */ }
}
```

The classes: `Wave3D`, `Ripple3D`, `Plankton3D`, `Fish3D`, `Frog3D`, `Dragonfly3D`, `LilyPad3D`, `Bird3D`.

**Manager arrays** (module-level): `waves, ripples, creatures, lilies, plankton, birds`. (`creatures` holds fish + frogs + dragonflies together.)

**The main loop drives them with one uniform pattern** (`animate()`):
```js
creatures = creatures.filter(c => { const a = c.update(dt); if (a) c.sync3D(dt); else c.destroy(); return a; });
```
So: `update` returns alive‑bool, survivors get `sync3D`, the dead get `destroy`. The same line repeats for every array. **If you add an entity type, follow this exact pattern.**

`dt` is a frame-time multiplier normalized to 60fps: `dt = min((now - lastTime)/16.67, 3)`. Multiply per-frame movement by `dt` so motion is frame‑rate independent (capped at 3 to survive tab stalls).

### Add/spawn helpers
`addWave`, `addCreature(type, x, y, opts, silent)`, `addLily(x, y, silent)`, `addPlanktonPack(x, y, silent)`. The `silent` flag skips spawn ripples (used when replaying a server snapshot so a flood of creatures doesn't spawn a flood of ripples).

---

## 5. Asset system (GLB with procedural fallback)

```js
const ASSETS = { fish:'assets/fish.glb', frog:'assets/frog.glb', dragonfly:'assets/dragonfly.glb', ... };
```
- `loadAsset(name, url)` → caches the parsed `gltf` in `assetCache[name]`; resolves `null` on any error (never throws).
- `instantiateGLB(name)` → clones the cached scene (`SkeletonUtils.clone` for skinned/animated meshes, else `scene.clone(true)`), normalizes its largest dimension to **2.4 units**, returns `{ root, mixer }` (an `AnimationMixer` if the GLB had clips).
- **Procedural fallbacks** (`buildFish`, `buildFrog`, `buildDragonfly`, `buildLily`, `buildBird`) build high‑quality low‑poly meshes from primitives + `MeshStandardMaterial` (via the `stdMat` helper). They store their materials in `mesh.userData.materials` so things like player‑fish tinting and death‑fade can recolor/fade them.
- `unitWrap(built)` normalizes ANY mesh (GLB or procedural) so its largest dimension = 1, wraps it in a `Group`, then the entity scales that group by `size * SCALE * VISUAL`. `VISUAL = 2.4` is a global readability multiplier so creatures aren't microscopic.
- `geo(key, makeFn)` memoizes shared geometries; `makeBlobShadow(r)` is the soft contact shadow used under creatures.

**Scale chain to remember:** game `size` (8–55) × `SCALE` (0.12) × `VISUAL` (2.4), applied to a unit‑normalized model.

---

## 6. Entities in detail

### Fish (`Fish3D`)
- **Tiers** via `FISH_TIERS` (0 small → 3 legendary). Tier sets size range, base speed, color palette, and what it eats (`plankton` / `fish` / `lily`) + eat range. `rollFishTier()` weights the roll (legendaries are rare).
- **AI:** wander with `turnTimer`/`turnRate`, edge avoidance near game-space borders, speed variation, gentle vertical `bob`. Eating: find target within `eatRange`, close in, consume, bump `growthScale` (capped ~2.5×, 3× legendary). Slow `decay` reduces `life`; off‑screen for too long kills it.
- **Player fish:** `setPlayer(name)` tints it cyan `#00f5d4`, sets `decay = 0` (immortal by decay), grants ~90 s spawn invulnerability (`invuln` frames), and attaches a floating name sprite. Player fish are never targeted by birds.
- **Legendary (tier 3)** uses the `penguin.glb` if present (an easter egg), else a procedural glowing fish.
- `sync3D` sets position with bob, yaw from `this.angle` (`mesh.rotation.y = -angle`), scale from size×growth, tail‑wag animation (mixer or manual), and opacity fade when `life < 0.3`.

### Frog (`Frog3D`)
- State machine: `sitting`, `hopping`, `relaxing` + a tongue sub‑machine (`idle`/`extending`/`retracting`). Hops toward lily pads; landing on one triggers a 5–8 s `relaxing` state (breathing scale bob, squinted eyes, occasional contentment ripples). Tongue shoots at dragonflies to eat them; eating grows the frog.

### Dragonfly (`Dragonfly3D`)
- States `hovering` (slow drift) / `darting` (fast random burst). Prey for frogs (tongue) and fish. Iridescent procedural wings on pivots, or GLB.

### Lily pad (`LilyPad3D`)
- Grows from small → `maxSize`; decays slowly; can be sunk by overlap or eaten by large fish. ~40% spawn with a glowing flower. `addLily` returns `false` if placement is blocked (used so a failed placement doesn't count a stat / send an action).

### Bird (`Bird3D`)
- Targets frogs + non‑player fish. States `diving` → `swooping` (scale 1→0.4→1 to mime dropping to the surface) → `escaping`. Grabs if target within `size*2` after the swoop. Spawned in **barrages** (`spawnBirdBarrage`) of 6–15 with staggered entry.

### Plankton (`Plankton3D`)
- Tiny glowing drifting food for tier‑0 fish. `addPlanktonPack` drops 12–20. `topUpPlankton()` keeps a client‑local baseline near the center so small fish always have something to eat — **this is cosmetic and NOT broadcast** (avoids multiplayer count desync).

### Wave (`Wave3D`) & Ripple (`Ripple3D`)
- Waves are expanding force rings that push creatures and damage lilies, and they call `disturbWater` to ripple the surface. Ripples are pure cosmetic expanding rings (clicks, spawns, hops, grabs).

---

## 7. Rendering systems

### Water surface (`// ===== WATER SURFACE =====`)
- A `RingGeometry` disc with a custom **`ShaderMaterial`** (`waterUniforms`).
- **Vertex shader:** ambient sine undulation (multiple octaves) + an **interactive ripple ring buffer** (`uRipples`, an array of `MAX_WATER_RIPPLES` `Vector4(wx, wz, t0, strength)`). Ripples expand over time and fade. Normals via finite differences for lighting.
- **Fragment shader:** Fresnel rim, sun specular, crest foam, depth tint, shore alpha fade, manual fog, and a red tint when the wave pool is active.
- `depthWrite: false` so underwater creatures remain visible through the surface.
- **`disturbWater(x, y, strength, radius)`** pushes a ripple into the ring buffer (game coords → world). It **early‑returns for weak disturbances** (`strength < 1.5`) so frequent per‑fish movement doesn't thrash the buffer — only clicks, waves, eats, and splashes register.

### Space sky (`// ===== SPACE SKYBOX =====`)
- A huge `SphereGeometry(3000)` rendered `BackSide` with a procedural `ShaderMaterial` (stars + nebula + sun glow, animated by `uTime`). Stored at `window.__skyShader`. `fog: false` so it never gets fogged.

### Environment (`// ===== ENVIRONMENT =====` → `buildEnvironment()`)
Builds (scaling down on mobile): terrain bowl, 4 tree varieties with glowing canopies + point lights, luminescent mushrooms, ferns, cattails/reeds, rocks, **fireflies** (a `Points` cloud, `fireflyState`), **celestials** (`buildCelestials` — GLB sun/earth/moon orbiting outside the dome, `window.__celestials`), **sci‑fi buildings** (L‑shaped clusters far outside the dome), the **energy dome** (`buildDome`, `window.__dome` — transparent pulsing geodesic shell), and an observation platform. Grass/posts/pillars use **`InstancedMesh`** for cheap repetition.

### Lighting, fog, tone mapping (`// ===== THREE.JS CORE =====` / `// ===== LIGHTING =====`)
- `renderer.outputEncoding = sRGBEncoding`; `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 1.2` (filmic rolloff for the bright celestials; raw `ShaderMaterial`s like water/sky are **not** tone‑mapped, only lit `MeshStandard` surfaces are).
- `scene.fog = FogExp2(0x0a0a18, 0.0016)`.
- Lights: a warm directional `sun`, a `HemisphereLight`, a low `AmbientLight`, and a cool `rim` back‑light for separation.

---

## 8. Camera

Built on Three r128 `OrbitControls`. Configured (`// ===== ORBIT CONTROLS =====`):
- `enableDamping`, clamped `minDistance/maxDistance`, polar angle clamped to `0.18..1.46` (never underwater, never straight down), `autoRotate` (resumes after 6 s idle via `lastInteract`/`bumpInteract`).
- **Panning = built‑in ground pan.** `controls.screenSpacePanning = false` makes the built‑in pan slide along the **ground plane** (pixel delta → world units via camera‑target distance + FOV, along the camera's ground‑projected right/forward). This serves both desktop **right‑drag** and **two‑finger touch** through one stable path.
- **Target & dome clamps** (`controls` `'change'` handler): the orbit target is locked to y=0 and clamped to a horizontal disc (`PAN_RADIUS`); the camera is kept inside a dome sphere (`DOME_R`). When the camera exits the dome it is pulled **back along the camera→target line** (solve `|target + t·dir|² = R²`), which shortens the zoom distance while **preserving the view direction** — so it never yanks sideways. When the target hits the disc edge, the camera is moved by the same delta so it feels like a clean wall.
- **Ride‑along camera** (`// ===== RIDE-ALONG CAMERA =====`): press **C** to follow your player fish (`updateFollowCamera` lerps a chase position/look behind the fish); press C again for orbit. In follow mode `controls.update()` is skipped.

> ⚠️ **r128 OrbitControls gotcha:** this is the `examples/js` UMD build where `pan`, `panLeft`, `panUp` are **private closures** inside the constructor. The internal handlers call the local `pan()`, never `controls.pan`. **You cannot override `controls.pan`** — it will be silently ignored. Use the public properties (`screenSpacePanning`, `enablePan`, `mouseButtons`, `touches`) instead. (An earlier version tried a Y=0 plane‑raycast pan, which flung the camera at shallow angles because grazing rays hit the plane thousands of units away — that's why we use the built‑in ground pan now.)

---

## 9. Input

`// ===== INPUT =====`. A single raycaster maps taps to game coordinates:
```js
screenToGame(clientX, clientY): NDC -> raycaster -> intersect waterPlane(y=0) -> { x, y } in game space (clamped 0..1000)
```
**Tap vs. drag discrimination:** on `pointerdown` record position/time; on `pointermove` set `pMoved` if the pointer travels >8 px; on `pointerup`, if `pMoved` or the press lasted >450 ms it was a **camera drag** and no action fires. Otherwise it's a **tap** → `disturbWater(...)` + `doAction(x, y)`.

`doAction` switches on `currentTool` (`wave`/`fish`/`frog`/`dragonfly`/`lily`/`plankton`): it spawns locally, increments a retention stat, and `sendAction(...)` to the network (waves also respect a cooldown). The toolbar buttons set `currentTool`.

---

## 10. Networking

### Client (`// ===== WEBSOCKET CLIENT =====`)
- `connectWS()` opens `WS_URL`, with an 8 s connect timeout. On `close` **without** ever opening, it flips `useFallbackURL` and reconnects; `scheduleReconnect()` backs off (2.5 s desktop / 4 s mobile, max 10 attempts → "solo mode"). All console logging is intentionally removed (it froze mobile).
- `handleMessage(msg)` dispatches by `msg.type`:
  - `snapshot` → `applySnapshot` (replays last 20 creatures + 15 lilies, `silent`), sets `myUserId/Name`, spawns the player fish, renders the user list.
  - `action` → `applyRemoteAction` (re‑spawn the remote action locally) + a toast.
  - `presence` → online count. `join`/`leave` → toasts. `users` → user‑list render.
- `sendAction(action)` only sends if the socket is open. `applyRemoteAction` mirrors `doAction` but from `denorm`'d coordinates and **without** re‑broadcasting (no echo loops).

### Backend (`backend/src/worker.js`)
- A **single Durable Object** `PondRoom` keyed `idFromName('global-pond')` is the entire world. The default Worker `fetch` routes `/ws` and `/api/fish-lives` to it.
- `handleSession(ws)`: `accept()`, assign an id + generated name (`adjective + noun`), send a `snapshot` (current `creatures` + `lilies` + `you` + `users`), broadcast `join` + presence. Listens for messages.
- `handleAction`: **rate limit 10 actions/sec/user** (timestamp filter), **1 KB message cap** (checked on receive), track per‑user spawn `counts`, store `creature`/`lily` in DO memory (capped 100 / 60), then **broadcast the action to everyone else** with `actorId/actorName` attached, and broadcast updated `users`. Ephemeral actions (`wave`, `plankton`, `event`, `wavepool`, `birds`) are relayed but not stored.
- `prune()` every 30 s drops old creatures/lilies. `fishLives` is a persisted counter in DO storage (`/api/fish-lives` GET/POST, CORS‑open).

**Protocol summary (JSON over WS):**
| Direction | `type` | Payload |
|---|---|---|
| C→S | `wave` | `x,y` (norm), `splashAngle` |
| C→S | `creature` | `creatureType`, `x,y`, `tier?` |
| C→S | `lily` / `plankton` | `x,y` |
| C→S | `event` / `wavepool` / `birds` | event id etc. |
| S→C | `snapshot` | `state{creatures,lilies}`, `you{id,name}`, `users[]` |
| S→C | `action` | the original action + `actorId/actorName` |
| S→C | `presence` | `count` |
| S→C | `join`/`leave` | `user`/`id,name` |
| S→C | `users` | `users[]` with `counts` |

---

## 11. Game systems & UX

- **Events** (`// ===== EVENT SYSTEM =====`): `EVENT_TYPES` = `feeding_frenzy`, `big_fish`, `frog_party`, `lily_bloom`, `bird_strike`. Each has a `spawn()`. A banner shows the event + a real‑time countdown (`EVENT_DURATION`). Events are network‑synced (a host triggers, everyone replays via `applyRemoteAction`). Random bird strikes fire at ~0.8%/sec when ≥2 creatures exist.
- **Red button + wave pool** (`// ===== RED BUTTON + WAVE POOL =====`): a ~0.0167%/frame chance spawns a pulsing red DOM button; clicking it activates a 10 s "wave pool" that auto‑spawns edge waves and tints the water red. Synced to all users.
- **Toasts** (`// ===== TOASTS =====`): replace the old 2D feed. `addToast(name, text, type)`, max 5, slide‑in, auto‑fade after 4.2 s. Driven by `join`/`leave`/`action` messages via `describeAction`.
- **Cooldown** (`// ===== WAVE COOLDOWN =====`): waves have a cooldown bar (`WAVE_COOLDOWN + WAVE_COOLUP`).
- **Retention** (`// ===== RETENTION =====`): `localStorage` lifetime stats (`totalWaves`, `totalFish`, …), a **daily streak** (`checkStreak`), a **session timer**, and `ACHIEVEMENTS[]` (id/name/icon/`check(stats)`), surfaced in the user panel.
- **Fish‑lives counter** (`// ===== FISH LIVES COUNTER =====`): analytics — POST once per "life" to `/api/fish-lives`, GET the global total for the status bar.
- **User panel** (`// ===== USER / PROFILE PANEL =====`): modal listing online users + their spawn counts, plus your streak/stats/achievements.

---

## 12. Main loop (`animate()`)

Order each frame (all wrapped in `try/catch` that **silently** swallows errors — this kept mobile from freezing on a stray exception):
1. Compute `dt`, advance `waterUniforms.uTime`.
2. Animate sky shader, dome pulse, celestial orbits.
3. Animate billboard grass — **throttled to every 3rd frame**.
4. Filter+sync the entity arrays (lilies, ripples, plankton, creatures, birds, waves).
5. Player‑death check (→ respawn banner).
6. Throttled subsystems: `updateCooldown` (every 2), `updateEvents`/`updateRedButton` (every 4), `maybeSpawnRandomBirds` (every 60), `topUpPlankton` (every 45).
7. `updateFireflies` — **throttled to every 2nd frame** (slow drift; halves buffer rewrite + GPU upload).
8. Camera: follow mode → `updateFollowCamera`; else resume auto‑rotate if idle and `controls.update()`.
9. `renderer.render(scene, camera)`.

**Performance posture:** scratch vectors are reused (`_cam*`, `_dome*`, `_fwd`) — no per‑frame `new THREE.Vector3()` in hot paths. Pixel ratio capped (1.5 desktop / 1.0 mobile). No shadow maps. Mobile (`IS_MOBILE`/`LOW_QUALITY`) reduces caps, ripple‑buffer size, bird count, and antialiasing.

---

## 13. Invariants & conventions (don't violate these)

1. **AI in game space, render in world space, network in normalized space.** Convert only at the boundaries (`sync3D`, `sendAction`, `applyRemoteAction`).
2. **Every entity implements `update(dt)→bool`, `sync3D()`, `destroy()`** and is driven by the `filter` pattern in `animate()`.
3. **`update(dt)` must multiply motion by `dt`.** Never assume 60fps.
4. **Local action vs. remote action:** `doAction` spawns locally **and** `sendAction`s. `applyRemoteAction` spawns locally **without** re‑sending. Don't make remote actions re‑broadcast.
5. **`silent` on snapshot replays.** Bulk spawns from a snapshot must pass `silent=true` to skip ripples/toasts.
6. **`disturbWater` is for notable events only** (`strength ≥ 1.5`). Don't call it per‑fish per‑frame.
7. **`depthWrite:false` on the water** is load‑bearing for seeing underwater creatures. Don't "fix" it.
8. **Graceful asset degradation:** anything that might use a GLB must have a procedural fallback and must not assume `assetCache[name]` exists.
9. **Keep the main loop's `try/catch`.** If you need to debug, add temporary logging inside it; don't remove it.
10. **Don't try to override `controls.pan`** (see the r128 gotcha). Use public OrbitControls properties.

---

## 14. Common footguns

- **"My new creature doesn't move/disappear correctly."** You forgot to add it to a manager array + the `filter` line in `animate()`, or `update` doesn't return a boolean.
- **"Positions are off / teleporting on multiplayer."** You sent world or game coords over the wire instead of `normX/normY`, or forgot to `denorm` on receive.
- **"Creature is invisible or huge."** You didn't `unitWrap` it, or applied `SCALE`/`VISUAL` twice.
- **"Camera flings when I pan."** Don't reintroduce plane‑raycast panning; keep `screenSpacePanning = false`.
- **"Tone mapping washed out the water/sky."** Those are raw `ShaderMaterial`s and aren't tone‑mapped; if you change tone mapping, only lit `MeshStandard` surfaces shift. Revert `toneMapping`/`toneMappingExposure` to taste.
- **"Nothing renders but no error in console."** The main loop swallows exceptions. Temporarily `console.log(e)` in the `catch`.
- **"Mobile is choppy."** Check you respected `LOW_QUALITY` caps and didn't add per‑frame allocations or an un‑throttled buffer update.

---

## 15. Recipes

### Add a new creature type
1. Write `class Whatever3D` with `constructor(x,y)`, `update(dt)`, `sync3D()`, `destroy()` (copy an existing class as a template; keep all state in game space).
2. Provide a procedural `buildWhatever()` and optionally a GLB entry in `ASSETS` + `instantiateGLB('whatever')` with fallback.
3. Add a manager array (or reuse `creatures`) and the `filter` line in `animate()`.
4. Extend `addCreature` (or add `addWhatever`) and the `doAction`/toolbar tool if it's user‑spawnable.
5. Wire the network: a `creatureType` in `doAction`'s `sendAction`, and a case in `applyRemoteAction`. (The backend already relays arbitrary `creature` actions.)

### Add a new tool
1. Add a `<button class="tool-btn" data-tool="x">` in `index.html`.
2. Add a `case 'x'` to `doAction` (+ `incrementStat` + `sendAction`).
3. Add a `case 'x'` to `applyRemoteAction`.

### Add an event
1. Push to `EVENT_TYPES` with `{ id, name, spawn() }`.
2. It auto‑works with the banner + `applyRemoteAction`'s `event` case (which looks up by `eventId`).

---

## 16. Deployment & verification

**Frontend (Cloudflare Pages):**
```bash
npx wrangler pages deploy frontend --project-name=shared-pond --commit-dirty=true
# from repo root
```
**Backend (Worker + DO):**
```bash
cd backend && npx wrangler deploy
```

**Local dev:** any static server over `frontend/` works because the WebSocket points at production:
```bash
python -m http.server 8123 --directory frontend   # then open http://localhost:8123
```

**Verify:**
- `node --check frontend/pond3d.js` — fast syntax gate after edits.
- Load `/`, confirm the scene reveals, creatures move, water ripples on tap, WS shows "N souls in the pond."
- Camera: orbit, right‑drag pan, scroll zoom, two‑finger touch pan — all smooth at every angle, none escape the dome.
- ⚠️ **Cloudflare Pages SPA fallback:** unknown routes (e.g. `/3d`, `/anything`) serve the root `index.html` with **200**, not 404. That's expected platform behavior. To force 404/redirect, add a `frontend/_redirects` file.

---

## 17. Key constants cheat‑sheet

| Const | Value | Meaning |
|---|---|---|
| `W`, `H` | 1000 | game-space dimensions |
| `SCALE` | 0.12 | world units per game unit |
| `VISUAL` | 2.4 | creature readability multiplier |
| `R_WATER` | ~131 | water disc radius (world) |
| `POND_DEPTH` / `BANK_RISE` | 12 / 7.5 | basin depth / land height |
| `R_PLAY` / `R_SHORE` | 90 / ~100 | flat basin / shoreline radius (game) |
| `MAX_CREATURES` | 80 | client creature cap |
| `MAX_WATER_RIPPLES` | 14 / 6 (mobile) | shader ripple buffer size |
| `MAX_BIRDS` | 36 / 18 (mobile) | bird cap |
| `WAVE_COOLDOWN`/`COOLUP` | 1500 / 500 ms | wave cooldown |
| `MAX_TOASTS` | 5 | on-screen toasts |
| backend caps | 100 creatures / 60 lilies | DO memory caps |
| backend rate limit | 10 actions/sec/user | anti-spam |

---

*Generated as an onboarding reference for `frontend/pond3d.js`. When in doubt, the code is the source of truth — section headers (`// ===== … =====`) make it easy to jump around.*
