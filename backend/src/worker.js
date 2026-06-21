export class PondRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.creatures = [];
    this.lilies = [];
    this.lastPrune = Date.now();
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(ws) {
    ws.accept();
    this.sessions.add(ws);

    // send current state snapshot
    ws.send(JSON.stringify({
      type: 'snapshot',
      state: {
        creatures: this.creatures.slice(-30),
        lilies: this.lilies.slice(-20),
      }
    }));

    // send presence count
    this.broadcastPresence();

    ws.addEventListener('message', (event) => {
      try {
        const action = JSON.parse(event.data);
        this.handleAction(action, ws);
      } catch (e) {}
    });

    ws.addEventListener('close', () => {
      this.sessions.delete(ws);
      this.broadcastPresence();
    });

    ws.addEventListener('error', () => {
      this.sessions.delete(ws);
      this.broadcastPresence();
    });
  }

  handleAction(action, senderWs) {
    // store action in state
    switch (action.type) {
      case 'wave':
        // waves are transient — broadcast only, no need to store
        break;
      case 'creature':
        this.creatures.push({ type: action.creatureType, x: action.x, y: action.y, tier: action.tier, ts: Date.now() });
        if (this.creatures.length > 100) this.creatures = this.creatures.slice(-100);
        break;
      case 'lily':
        this.lilies.push({ x: action.x, y: action.y, ts: Date.now() });
        if (this.lilies.length > 60) this.lilies = this.lilies.slice(-60);
        break;
      case 'event':
      case 'wavepool':
      case 'birds':
        // broadcast only — no persistent state needed
        break;
    }

    // broadcast to all other sessions
    const msg = JSON.stringify({ type: 'action', action });
    for (const ws of this.sessions) {
      if (ws !== senderWs) {
        try { ws.send(msg); } catch (e) {}
      }
    }

    // periodic prune
    if (Date.now() - this.lastPrune > 30000) {
      this.prune();
    }
  }

  prune() {
    this.lastPrune = Date.now();
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    this.creatures = this.creatures.filter(c => now - c.ts < maxAge * 4);
    this.lilies = this.lilies.filter(l => now - l.ts < maxAge * 6);
  }

  broadcastPresence() {
    const count = this.sessions.size;
    const msg = JSON.stringify({ type: 'presence', count });
    for (const ws of this.sessions) {
      try { ws.send(msg); } catch (e) {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const id = env.POND.idFromName('global-pond');
      const obj = env.POND.get(id);
      return obj.fetch(request);
    }

    return new Response('POND is alive', { status: 200 });
  }
};
