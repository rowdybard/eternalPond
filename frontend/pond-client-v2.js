(function () {
  'use strict';

  const PROTOCOL_VERSION = 3;
  const TOKEN_KEY = 'eternalpond.soul.v2';

  function requestId(prefix) {
    const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`)
      .replace(/[^a-zA-Z0-9_-]/g, '');
    return `${prefix || 'req'}_${id}`;
  }

  function socketUrl() {
    const override = new URLSearchParams(location.search).get('pondWs');
    if (override) return override;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'ws://127.0.0.1:8787/ws/v3';
    }
    return 'wss://shared-pond.maxpug17.workers.dev/ws/v3';
  }

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || undefined; }
    catch (error) { return undefined; }
  }

  function writeToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); }
    catch (error) { /* The current session can continue without persistence. */ }
  }

  class PondClientV2 {
    constructor(options) {
      const config = options || {};
      this.renderer = config.renderer || 'webgl';
      this.reducedMotion = !!config.reducedMotion;
      this.listeners = new Map();
      this.socket = null;
      this.reconnectTimer = null;
      this.reconnectAttempt = 0;
      this.clockOffsetMs = 0;
      this.connectionId = crypto.randomUUID ? crypto.randomUUID() : requestId('connection');
      this.disposed = false;
      this.welcomed = false;
      this.state = 'idle';
      this.outbox = [];
      this.identity = null;
      this.sessionId = null;
      this.ownedEntityId = null;
      this.ripplePoints = [];
      this.rippleTimer = null;
      this.lastRippleBatchAt = 0;
    }

    on(type, listener) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
      return () => listeners.delete(listener);
    }

    emit(type, value) {
      const listeners = this.listeners.get(type);
      if (!listeners) return;
      for (const listener of listeners) listener(value);
    }

    setState(state) {
      if (this.state === state) return;
      this.state = state;
      this.emit('state', state);
    }

    connect() {
      if (this.disposed || this.socket) return;
      this.setState('connecting');
      this.welcomed = false;
      const token = readToken();
      const url = new URL(socketUrl());
      url.searchParams.set('connection', this.connectionId);
      if (token) url.searchParams.set('token', token);

      let socket;
      try { socket = new WebSocket(url); }
      catch (error) { this.scheduleReconnect(); return; }
      this.socket = socket;

      socket.addEventListener('open', () => {
        if (socket !== this.socket) return;
        this.reconnectAttempt = 0;
        this.setState('open');
        this.sendRaw({
          v: PROTOCOL_VERSION,
          type: 'hello',
          requestId: requestId('hello'),
          token,
          renderer: this.renderer,
          reducedMotion: this.reducedMotion,
          clientTime: Date.now(),
        });
      });

      socket.addEventListener('message', (event) => {
        if (socket !== this.socket || typeof event.data !== 'string') return;
        let message;
        try { message = JSON.parse(event.data); }
        catch (error) { return; }
        if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== 'string') return;

        const serverTime = typeof message.serverTime === 'number'
          ? message.serverTime
          : message.snapshot && typeof message.snapshot.serverTime === 'number'
            ? message.snapshot.serverTime
            : null;
        if (serverTime !== null) this.clockOffsetMs = serverTime - Date.now();

        if (message.type === 'welcome') {
          this.identity = message.identity;
          this.sessionId = message.sessionId;
          this.ownedEntityId = message.ownedEntityId;
          this.welcomed = true;
          if (message.token) writeToken(message.token);
          this.flushOutbox();
        } else if (message.type === 'snapshot' && this.identity) {
          const owned = message.snapshot.entities.find((entity) =>
            entity.kind === 'soulFish' && entity.soulId === this.identity.id);
          this.ownedEntityId = owned ? owned.id : null;
        } else if (message.type === 'lifeEnded' && message.entityId === this.ownedEntityId) {
          this.ownedEntityId = null;
        }
        this.emit('message', message);
      });

      socket.addEventListener('close', () => {
        if (socket !== this.socket) return;
        this.socket = null;
        this.sessionId = null;
        this.welcomed = false;
        this.setState('closed');
        this.scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        if (socket === this.socket) socket.close();
      });
    }

    scheduleReconnect() {
      if (this.disposed || this.reconnectTimer !== null) return;
      const delay = Math.min(15000, 650 * Math.pow(2, this.reconnectAttempt)) + Math.random() * 350;
      this.reconnectAttempt++;
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connectionId = crypto.randomUUID ? crypto.randomUUID() : requestId('connection');
        this.connect();
      }, delay);
    }

    sendRaw(message) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      try { this.socket.send(JSON.stringify(message)); return true; }
      catch (error) { return false; }
    }

    send(message) {
      if (this.welcomed && this.sendRaw(message)) return true;
      this.outbox.push(message);
      if (this.outbox.length > 16) this.outbox.shift();
      return false;
    }

    flushOutbox() {
      const messages = this.outbox.splice(0);
      for (const message of messages) this.sendRaw(message);
    }

    incarnate(point) {
      return this.send({ v: PROTOCOL_VERSION, type: 'incarnate', requestId: requestId('birth'), point });
    }

    ripple(point) {
      this.ripplePoints.push(point);
      if (this.ripplePoints.length > 120) {
        const recent = this.ripplePoints.splice(-48);
        const cells = new Map();
        for (const queued of recent) {
          const key = `${Math.floor(queued.x * 12)}:${Math.floor(queued.z * 12)}`;
          cells.set(key, queued);
        }
        this.ripplePoints = [...cells.values()];
      }
      this.scheduleRippleFlush();
      return true;
    }

    scheduleRippleFlush() {
      if (this.rippleTimer !== null || this.disposed) return;
      const wait = Math.max(0, 100 - (performance.now() - this.lastRippleBatchAt));
      this.rippleTimer = window.setTimeout(() => {
        this.rippleTimer = null;
        this.flushRipples();
      }, wait);
    }

    flushRipples() {
      if (this.ripplePoints.length === 0) return;
      const points = this.ripplePoints.splice(0, 12);
      this.lastRippleBatchAt = performance.now();
      this.send({ v: PROTOCOL_VERSION, type: 'rippleBatch', requestId: requestId('ripples'), points });
      if (this.ripplePoints.length > 0) this.scheduleRippleFlush();
    }

    offer(point, offering) {
      return this.send({ v: PROTOCOL_VERSION, type: 'offer', requestId: requestId('offer'), point, offering });
    }

    focus(entityId) {
      return this.send({ v: PROTOCOL_VERSION, type: 'focus', requestId: requestId('focus'), entityId });
    }

    serverNow() {
      return Date.now() + this.clockOffsetMs;
    }

    dispose() {
      this.disposed = true;
      if (this.rippleTimer !== null) clearTimeout(this.rippleTimer);
      this.rippleTimer = null;
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (this.welcomed) {
        this.sendRaw({ v: PROTOCOL_VERSION, type: 'leave', requestId: requestId('leave') });
      }
      if (this.socket) this.socket.close(1000, 'leaving the pond');
      this.socket = null;
    }
  }

  window.PondClientV2 = PondClientV2;
  window.ETERNAL_POND_PROTOCOL = PROTOCOL_VERSION;
}());
