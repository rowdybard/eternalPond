# Pond Overhaul — Progress Tracker

## Plan
File: `C:\Users\maxpu\.windsurf\plans\pond-overhaul-4ac4df.md`

## Project Structure
- `c:\cursor stuff\u5edthfcv\frontend\index.html` — UI (DONE: updated to wave tool, removed ink swatches, added cooldown bar + event banner)
- `c:\cursor stuff\u5edthfcv\frontend\style.css` — Styling (PARTIAL: needs cooldown bar, event banner, red button styles; needs ink swatch CSS removed)
- `c:\cursor stuff\u5edthfcv\frontend\pond.js` — Game engine (NOT STARTED: needs full rewrite per plan)
- `c:\cursor stuff\u5edthfcv\backend\src\worker.js` — Cloudflare Worker (needs wave/eat/event sync additions)
- `c:\cursor stuff\u5edthfcv\backend\wrangler.toml` — Config (done, no changes needed)

## Overhaul Tasks (from plan)

### 1. Wave System — DONE

### 2. Water Overhaul — DONE

### 3. Creature Food Chain — DONE

### 4. Lily Pad Rules — DONE

### 5. Entity Off-Screen Death — DONE

### 6. Random Events — DONE

### 7. Red Button + Wave Pool — DONE

### 8. Backend Sync — DONE

### 9. Polish — REMAINING

## CSS Changes Needed
- Remove `.color-swatch` styles (lines 54-71)
- Remove `.tool-group + .tool-group` border (no longer needed, single group)
- Remove `.color-swatch` from mobile media query
- Add `#cooldown-bar` / `#cooldown-fill` styles (thin bar above toolbar, fills up as cooldown recovers)
- Add `#event-banner` styles (top center banner, slides in/out)
- Add `#red-button` styles (pulsing red circle, positioned absolutely)

## JS Rewrite Needed
Full rewrite of `pond.js`. Key changes from current version:
- Remove InkParticle class entirely
- Remove ink-related config, entity managers, input handling
- Add WaveEntity class with force/foam/crest
- Overhaul drawWater() with multi-layer rendering
- Rework Fish class: add tier system, eating AI, growth
- Rework Frog class: add legs, tongue, lily pad sitting, growth from eating
- Rework Dragonfly class: rename to fly conceptually, prey behavior
- Add lily pad placement cooldown + replacement logic
- Add off-screen death to all entity update() methods
- Add event system + banner
- Add red button + wave pool mode
- Update WebSocket sync for waves/eats/events
- Update toolbar handling (no color swatches, wave is default tool)
- Update cooldown UI in main loop

## Current State of Files
- `index.html`: DONE — wave tool, cooldown bar, event banner, wave pool banner
- `style.css`: DONE — all new styles added, ink swatch styles removed
- `pond.js`: DONE — full rewrite with all systems
- `backend/src/worker.js`: DONE — updated for wave/event/wavepool sync, ink removed

## Next Steps
1. Visual testing in browser (in progress)
2. Balance tuning if needed
3. Deploy backend to Cloudflare
4. Package frontend for itch.io
