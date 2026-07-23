(function () {
  'use strict';

  const PROTOCOL_VERSION = 3;
  const TOKEN_KEY = 'eternalpond.soul.v2';
  const CREDENTIAL_VAULT_KEY = 'eternalpond.soul.credentials.v1';
  const MAX_SAVED_CREDENTIALS = 5;
  const PRODUCTION_API_ORIGIN = 'https://shared-pond.maxpug17.workers.dev';

  function requestId(prefix) {
    const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`)
      .replace(/[^a-zA-Z0-9_-]/g, '');
    return `${prefix || 'req'}_${id}`;
  }

  function socketUrl() {
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const bootstrapOverride = window.PondBootstrap && typeof window.PondBootstrap.devWebSocketOverride === 'function'
      ? window.PondBootstrap.devWebSocketOverride()
      : null;
    const override = isLocalhost ? bootstrapOverride || new URLSearchParams(location.search).get('pondWs') : null;
    if (override) return override;
    if (isLocalhost) {
      return 'ws://127.0.0.1:8787/ws/v3';
    }
    return 'wss://shared-pond.maxpug17.workers.dev/ws/v3';
  }

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || undefined; }
    catch (error) { return undefined; }
  }

  function readCredentialVault() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CREDENTIAL_VAULT_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry) => entry && typeof entry.id === 'string'
        && typeof entry.token === 'string' && entry.token.length >= 20 && entry.token.length <= 256)
        .slice(0, MAX_SAVED_CREDENTIALS);
    } catch (error) {
      return [];
    }
  }

  function writeCredentialVault(entries) {
    try { localStorage.setItem(CREDENTIAL_VAULT_KEY, JSON.stringify(entries.slice(0, MAX_SAVED_CREDENTIALS))); }
    catch (error) { /* The active credential remains in the compatibility key. */ }
  }

  function writeToken(token, identity) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      const vault = readCredentialVault();
      let entry = vault.find((item) => item.token === token);
      if (!entry) {
        entry = {
          id: crypto.randomUUID ? crypto.randomUUID() : requestId('soul'),
          token,
          name: '',
          tint: null,
          lastUsedAt: Date.now(),
        };
        vault.push(entry);
      }
      entry.name = identity && typeof identity.name === 'string' ? identity.name.slice(0, 100) : entry.name;
      entry.tint = identity && Number.isFinite(identity.tint) ? identity.tint : entry.tint;
      entry.lastUsedAt = Date.now();
      vault.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
      writeCredentialVault(vault);
    }
    catch (error) { /* The current session can continue without persistence. */ }
  }

  function credentialSummaries() {
    const active = readToken();
    return readCredentialVault().map((entry) => ({
      id: entry.id,
      name: entry.name || 'an unnamed soul',
      tint: Number.isFinite(entry.tint) ? entry.tint : null,
      lastUsedAt: entry.lastUsedAt,
      active: entry.token === active,
    }));
  }

  function apiOrigin() {
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (local) {
      const bootstrapOverride = window.PondBootstrap && typeof window.PondBootstrap.devApiOverride === 'function'
        ? window.PondBootstrap.devApiOverride()
        : null;
      const override = bootstrapOverride || new URLSearchParams(location.search).get('pondApi');
      if (override) {
        try {
          const parsed = new URL(override);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
        } catch (error) { /* Use the standard local Worker. */ }
      }
      return 'http://127.0.0.1:8787';
    }
    return PRODUCTION_API_ORIGIN;
  }

  async function readJsonResponse(response) {
    let body = null;
    try { body = await response.json(); }
    catch (error) { body = null; }
    if (!response.ok) {
      const failure = new Error(body && (body.message || body.error) || `pond_request_${response.status}`);
      failure.status = response.status;
      failure.body = body;
      throw failure;
    }
    return body || {};
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
      this.pendingLinkClaim = window.PondBootstrap && window.PondBootstrap.hasLinkClaim()
        ? window.PondBootstrap.takeLinkClaim()
        : null;
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
      url.searchParams.delete('token');
      url.searchParams.set('connection', this.connectionId);

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
          if (message.token) writeToken(message.token, message.identity);
          else if (token) writeToken(token, message.identity);
          this.flushOutbox();
        } else if (message.type === 'lifeStarted') {
          if (message.life && typeof message.life.entityId === 'string') this.ownedEntityId = message.life.entityId;
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

    setSharing(enabled) {
      return this.send({
        v: PROTOCOL_VERSION,
        type: 'setSharing',
        requestId: requestId('sharing'),
        enabled: !!enabled,
      });
    }

    observePublicSoul(slug) {
      const normalized = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 96) return false;
      return this.send({
        v: PROTOCOL_VERSION,
        type: 'observePublicSoul',
        requestId: requestId('observe'),
        slug: normalized,
      });
    }

    leavePublicRipple(slug) {
      const normalized = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 96) return false;
      return this.send({
        v: PROTOCOL_VERSION,
        type: 'leavePublicRipple',
        requestId: requestId('public_ripple'),
        slug: normalized,
      });
    }

    setPondLetter(preference) {
      const input = preference || {};
      const message = {
        v: PROTOCOL_VERSION,
        type: 'setPondLetter',
        requestId: requestId('letter'),
      };
      if (typeof input.email === 'string') message.email = input.email.trim().slice(0, 254);
      if (typeof input.mortalLetters === 'boolean') message.mortalLetters = input.mortalLetters;
      if (typeof input.keeperLetters === 'boolean') message.keeperLetters = input.keeperLetters;
      return this.send(message);
    }

    resendPondLetterConfirmation() {
      return this.send({
        v: PROTOCOL_VERSION,
        type: 'resendPondLetterConfirmation',
        requestId: requestId('letter_resend'),
      });
    }

    unsubscribePondLetters() {
      return this.send({
        v: PROTOCOL_VERSION,
        type: 'unsubscribePondLetters',
        requestId: requestId('letter_stop'),
      });
    }

    focus(entityId) {
      return this.send({ v: PROTOCOL_VERSION, type: 'focus', requestId: requestId('focus'), entityId });
    }

    currentToken() {
      return readToken();
    }

    credentialSummaries() {
      return credentialSummaries();
    }

    adoptCredential(token, identity) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 256) return false;
      const current = readToken();
      if (current && current !== token) writeToken(current, this.identity);
      writeToken(token, identity);
      return this.refreshIdentity('returning to a remembered soul');
    }

    refreshIdentity(closeReason) {
      if (this.disposed) return false;
      const previousSocket = this.socket;
      this.socket = null;
      this.welcomed = false;
      this.identity = null;
      this.sessionId = null;
      this.ownedEntityId = null;
      this.outbox.length = 0;
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (previousSocket) previousSocket.close(1000, closeReason || 'refreshing the remembered soul');
      this.connectionId = crypto.randomUUID ? crypto.randomUUID() : requestId('connection');
      this.connect();
      return true;
    }

    switchCredential(id) {
      if (typeof id !== 'string') return false;
      const entry = readCredentialVault().find((candidate) => candidate.id === id);
      if (!entry || entry.token === readToken()) return false;
      return this.adoptCredential(entry.token, { name: entry.name, tint: entry.tint });
    }

    async revokeCredential(id) {
      if (typeof id !== 'string') throw new Error('invalid_credential');
      const vault = readCredentialVault();
      const entry = vault.find((candidate) => candidate.id === id);
      if (!entry) throw new Error('credential_not_found');
      const headers = new Headers({
        'Authorization': `Bearer ${entry.token}`,
        'Content-Type': 'application/json',
      });
      const response = await fetch(new URL('/api/v3/credentials/revoke', `${apiOrigin()}/`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: entry.token }),
        credentials: 'omit',
        redirect: 'error',
      });
      const result = await readJsonResponse(response);
      if (result.revoked !== true) throw new Error('credential_not_revoked');

      const wasActive = entry.token === readToken();
      const remaining = vault.filter((candidate) => candidate.id !== id);
      writeCredentialVault(remaining);
      let switchedToSavedCredential = false;
      if (wasActive) {
        const replacement = remaining[0];
        if (replacement) {
          writeToken(replacement.token, { name: replacement.name, tint: replacement.tint });
          switchedToSavedCredential = readToken() === replacement.token;
        }
        if (!switchedToSavedCredential) {
          try { localStorage.removeItem(TOKEN_KEY); }
          catch (error) {
            try { localStorage.setItem(TOKEN_KEY, ''); }
            catch (storageError) { /* The revoked key remains unusable server-side. */ }
          }
        }
        this.refreshIdentity('forgetting a browser credential');
      }
      return { revoked: true, wasActive, switchedToSavedCredential };
    }

    async requestApi(path, options) {
      const config = options || {};
      const headers = new Headers(config.headers || {});
      if (config.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      if (config.owner) {
        const token = readToken();
        if (!token) throw new Error('pond_owner_credential_missing');
        headers.set('Authorization', `Bearer ${token}`);
      }
      const response = await fetch(new URL(path, `${apiOrigin()}/`), {
        method: config.method || 'GET',
        headers,
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
        credentials: 'omit',
      });
      return readJsonResponse(response);
    }

    async inspectPendingLink() {
      if (!this.pendingLinkClaim) return { valid: false };
      return this.requestApi('/api/v3/links/inspect', {
        method: 'POST',
        body: { claim: this.pendingLinkClaim },
      });
    }

    async redeemPendingLink(options) {
      if (!this.pendingLinkClaim) return { ok: false, message: 'This pond link has already been used here.' };
      const claim = this.pendingLinkClaim;
      const body = { claim };
      const token = readToken();
      if (token && !(options && options.allowSoulSwitch)) body.currentToken = token;
      const result = await this.requestApi('/api/v3/links/redeem', { method: 'POST', body });
      if (result && result.ok) this.pendingLinkClaim = null;
      return result;
    }

    getKeeper() {
      return this.requestApi('/api/v3/keeper', { owner: true });
    }

    createKeeperCheckout(interval) {
      if (interval !== 'month' && interval !== 'year') return Promise.reject(new Error('invalid_keeper_interval'));
      return this.requestApi('/api/v3/keeper/checkout', {
        method: 'POST',
        owner: true,
        body: { interval },
      });
    }

    createKeeperPortal() {
      return this.requestApi('/api/v3/keeper/portal', { method: 'POST', owner: true, body: {} });
    }

    updateKeeper(patch) {
      const input = patch || {};
      const body = {};
      if (typeof input.dedication === 'string') {
        body.dedication = [...input.dedication.replace(/\s+/gu, ' ').trim()].slice(0, 160).join('');
      }
      if (typeof input.weeklyLetters === 'boolean') body.weeklyLetters = input.weeklyLetters;
      return this.requestApi('/api/v3/keeper', { method: 'PATCH', owner: true, body });
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
