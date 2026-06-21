# POND — everyone is here

A shared, persistent global pond where every visitor drops ink and creatures into the same body of water in real-time. Hosted on itch.io as an HTML5 game, backed by Cloudflare Workers + Durable Objects.

## Project Structure

```
frontend/    — itch.io HTML5 game (canvas + WebSocket client)
backend/     — Cloudflare Worker + Durable Object (real-time sync)
```

## Setup

### 1. Deploy the backend

```bash
cd backend
npm install
npx wrangler login
npx wrangler deploy
```

Note the deployed URL (e.g., `https://shared-pond.YOUR-SUBDOMAIN.workers.dev`).

### 2. Update the frontend WebSocket URL

Edit `frontend/pond.js` line 2:

```js
const WS_URL = 'wss://shared-pond.YOUR-SUBDOMAIN.workers.dev/ws';
```

### 3. Test locally

Serve the frontend with any static server:

```bash
cd frontend
npx serve .
```

Open `http://localhost:3000` — you should see the pond. If the backend is deployed, you'll connect automatically. If not, it runs in solo mode.

### 4. Deploy to itch.io

1. Zip the contents of `frontend/` (index.html, style.css, pond.js)
2. Go to itch.io → Create new project
3. Kind of project: **HTML**
4. Upload the zip file
5. Set pricing to **Free** (or pay-what-you-want)
6. Check "This file will be played in the browser"
7. Set viewport to 100% width/height
8. Tags: `cozy`, `sandbox`, `multiplayer`, `art-game`, `experimental`
9. Cover image: take a screenshot of the pond with ink + creatures

## Tech

- **Frontend:** Vanilla JS + HTML5 Canvas (no dependencies)
- **Backend:** Cloudflare Workers + Durable Objects (WebSocket real-time sync)
- **Cost:** Cloudflare free tier (100k WS connections/day)
