export class PondRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { id, name, counts }
    this.creatures = [];
    this.lilies = [];
    this.lastPrune = Date.now();
    this.userIdCounter = 0;
    this.fishLives = null; // cached count, loaded lazily
  }

  generateName() {
    const adjectives = ['Splashy', 'Bubbly', 'Wavy', 'Murky', 'Froggy', 'Fishy', 'Ripply', 'Mossy', 'Reedy', 'Misty', 'Glimmery', 'Pebble'];
    const nouns = ['Pondling', 'Tadpole', 'Minnow', 'Heron', 'Otter', 'Newt', 'Carp', 'Koi', 'Snail', 'Dragon', 'Turtle', 'Frog'];
    return adjectives[Math.floor(Math.random() * adjectives.length)] + ' ' + nouns[Math.floor(Math.random() * nouns.length)];
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Fish lives analytics endpoint
    if (url.pathname === '/api/fish-lives') {
      if (request.method === 'POST') {
        // increment global counter in DO storage
        if (this.fishLives === null) this.fishLives = parseInt(await this.state.storage.get('fishLives') || '0', 10);
        this.fishLives++;
        await this.state.storage.put('fishLives', this.fishLives);
        return new Response(JSON.stringify({ count: this.fishLives }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      // GET — return current count
      if (this.fishLives === null) this.fishLives = parseInt(await this.state.storage.get('fishLives') || '0', 10);
      return new Response(JSON.stringify({ count: this.fishLives }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

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
    const userId = ++this.userIdCounter;
    const userName = this.generateName();
    const user = { id: userId, name: userName, counts: { wave: 0, fish: 0, frog: 0, dragonfly: 0, lily: 0 }, lastActionTimes: [] };
    this.sessions.set(ws, user);

    // send current state snapshot + user list
    ws.send(JSON.stringify({
      type: 'snapshot',
      state: {
        creatures: this.creatures,
        lilies: this.lilies,
      },
      you: { id: userId, name: userName },
      users: this.getUserList(),
    }));

    // broadcast join to everyone
    this.broadcast({ type: 'join', user: { id: userId, name: userName } });
    this.broadcastPresence();

    ws.addEventListener('message', (event) => {
      try {
        if (event.data.length > 1024) return;
        const action = JSON.parse(event.data);
        this.handleAction(action, ws);
      } catch (e) {}
    });

    ws.addEventListener('close', () => {
      const u = this.sessions.get(ws);
      this.sessions.delete(ws);
      if (u) this.broadcast({ type: 'leave', id: u.id, name: u.name });
      this.broadcastPresence();
    });

    ws.addEventListener('error', () => {
      const u = this.sessions.get(ws);
      this.sessions.delete(ws);
      if (u) this.broadcast({ type: 'leave', id: u.id, name: u.name });
      this.broadcastPresence();
    });
  }

  getUserList() {
    return [...this.sessions.values()].map(u => ({ id: u.id, name: u.name, counts: u.counts }));
  }

  broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try { ws.send(str); } catch (e) {}
    }
  }

  handleAction(action, senderWs) {
    const user = this.sessions.get(senderWs);
    if (!user) return;

    // rate limit: max 10 actions per second per user
    const now = Date.now();
    user.lastActionTimes = user.lastActionTimes.filter(t => now - t < 1000);
    if (user.lastActionTimes.length >= 10) return;
    user.lastActionTimes.push(now);

    // track spawn counts
    if (user) {
      if (action.type === 'wave') user.counts.wave++;
      else if (action.type === 'creature' && action.creatureType) user.counts[action.creatureType] = (user.counts[action.creatureType] || 0) + 1;
      else if (action.type === 'lily') user.counts.lily++;
    }

    // store action in state
    switch (action.type) {
      case 'wave':
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
        break;
    }

    // attach actor info to action for broadcast
    const broadcastAction = { ...action, actorId: user ? user.id : null, actorName: user ? user.name : null };

    // broadcast to all other sessions
    const msg = JSON.stringify({ type: 'action', action: broadcastAction });
    for (const ws of this.sessions.keys()) {
      if (ws !== senderWs) {
        try { ws.send(msg); } catch (e) {}
      }
    }

    // broadcast updated user counts to everyone
    this.broadcast({ type: 'users', users: this.getUserList() });

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
    this.broadcast({ type: 'presence', count });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws' || url.pathname === '/api/fish-lives') {
      const id = env.POND.idFromName('global-pond');
      const obj = env.POND.get(id);
      return obj.fetch(request);
    }

    return new Response('POND is alive', { status: 200 });
  }
};
