import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./pond-client-v2.js', import.meta.url), 'utf8');

function loadClient({ hostname, search, token, linkClaim, fetchImpl }) {
  const sockets = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = String(url);
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }

    send(message) {
      this.sent.push(message);
    }

    close() {}
  }

  const storage = new Map(token ? [['eternalpond.soul.v2', token]] : []);
  const window = {
    setTimeout: () => 1,
    PondBootstrap: linkClaim ? {
      hasLinkClaim: () => true,
      takeLinkClaim: () => linkClaim,
    } : null,
  };
  const context = {
    URL,
    URLSearchParams,
    Headers,
    WebSocket: FakeWebSocket,
    crypto: { randomUUID: () => 'fixed-connection-id' },
    Date,
    Math,
    performance: { now: () => 0 },
    location: {
      hostname,
      search,
      origin: hostname === 'eternalpond.com' ? 'https://eternalpond.com' : `http://${hostname}`,
    },
    fetch: fetchImpl,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window,
  };
  vm.runInNewContext(source, context, { filename: 'pond-client-v2.js' });
  return { Client: window.PondClientV2, sockets, storage, window };
}

test('a production page ignores pondWs and never puts the soul token in the URL', () => {
  const { Client, sockets } = loadClient({
    hostname: 'eternalpond.com',
    search: '?pondWs=wss%3A%2F%2Fevil.example%2Fcollect',
    token: 'permanent-soul-token',
  });
  new Client().connect();

  assert.equal(sockets.length, 1);
  const url = new URL(sockets[0].url);
  assert.equal(url.origin, 'wss://shared-pond.maxpug17.workers.dev');
  assert.equal(url.pathname, '/ws/v3');
  assert.equal(url.searchParams.get('connection'), 'fixed-connection-id');
  assert.equal(url.searchParams.has('token'), false);
});

test('localhost accepts pondWs without putting the soul token in the URL', () => {
  const { Client, sockets } = loadClient({
    hostname: '127.0.0.1',
    search: '?pondWs=ws%3A%2F%2Flocalhost%3A9999%2Fcustom%3Fdebug%3D1%26token%3Dstale',
    token: 'local-soul-token',
  });
  new Client().connect();

  const url = new URL(sockets[0].url);
  assert.equal(url.origin, 'ws://localhost:9999');
  assert.equal(url.pathname, '/custom');
  assert.equal(url.searchParams.get('debug'), '1');
  assert.equal(url.searchParams.get('connection'), 'fixed-connection-id');
  assert.equal(url.searchParams.has('token'), false);
});

test('the permanent token remains available only in the hello message', () => {
  const { Client, sockets } = loadClient({
    hostname: 'eternalpond.com',
    search: '',
    token: 'hello-only-token',
  });
  new Client().connect();
  sockets[0].dispatch('open');

  assert.equal(sockets[0].sent.length, 1);
  const hello = JSON.parse(sockets[0].sent[0]);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.token, 'hello-only-token');
  assert.equal(new URL(sockets[0].url).searchParams.has('token'), false);
});

test('relationship messages use the additive Protocol 3 envelopes', () => {
  const { Client, sockets } = loadClient({ hostname: 'eternalpond.com', search: '', token: 'existing-soul-token-12345' });
  const client = new Client();
  client.connect();
  sockets[0].dispatch('open');
  sockets[0].dispatch('message', { data: JSON.stringify({
    v: 3,
    type: 'welcome',
    requestId: 'welcome_test',
    serverTime: Date.now(),
    sessionId: 'session',
    identity: { id: 'soul', name: 'Quiet Thistle', tint: 0x79d1c2, completedLives: 1 },
    ownedEntityId: null,
    renderer: 'webgl',
  }) });

  client.setSharing(true);
  client.observePublicSoul('quiet-thistle');
  client.leavePublicRipple('quiet-thistle');
  client.setPondLetter({ email: 'pond@example.com', mortalLetters: true, keeperLetters: false });
  client.resendPondLetterConfirmation();
  client.unsubscribePondLetters();

  const messages = sockets[0].sent.slice(1).map((item) => JSON.parse(item));
  assert.deepEqual(messages.map((message) => message.type), [
    'setSharing',
    'observePublicSoul',
    'leavePublicRipple',
    'setPondLetter',
    'resendPondLetterConfirmation',
    'unsubscribePondLetters',
  ]);
  assert.equal(messages[0].enabled, true);
  assert.equal(messages[1].slug, 'quiet-thistle');
  assert.equal(messages[3].email, 'pond@example.com');
  assert.equal(messages.every((message) => !Object.hasOwn(message, 'token')), true);
});

test('welcome stores a bounded credential vault without exposing tokens in summaries', () => {
  const { Client, sockets, storage } = loadClient({ hostname: 'eternalpond.com', search: '', token: 'existing-soul-token-12345' });
  const client = new Client();
  client.connect();
  sockets[0].dispatch('open');
  sockets[0].dispatch('message', { data: JSON.stringify({
    v: 3,
    type: 'welcome',
    requestId: 'welcome_vault',
    serverTime: Date.now(),
    sessionId: 'session',
    identity: { id: 'soul', name: 'Quiet Thistle', tint: 0x79d1c2, completedLives: 0 },
    ownedEntityId: null,
    renderer: 'webgl',
  }) });

  const stored = JSON.parse(storage.get('eternalpond.soul.credentials.v1'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].token, 'existing-soul-token-12345');
  assert.equal(stored[0].name, 'Quiet Thistle');
  assert.equal(Object.hasOwn(client.credentialSummaries()[0], 'token'), false);
});

test('purpose-scoped link claims stay out of URLs and can be redeemed once', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/inspect')) {
      return new Response(JSON.stringify({ valid: true, purpose: 'return_soul', name: 'Quiet Thistle' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (JSON.parse(options.body).currentToken) {
      return new Response(JSON.stringify({
        ok: false,
        purpose: 'return_soul',
        name: 'Quiet Thistle',
        message: 'switch_required',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, purpose: 'return_soul', token: 'returned-soul-token-12345' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { Client } = loadClient({
    hostname: 'eternalpond.com',
    search: '',
    token: 'existing-soul-token-12345',
    linkClaim: 'private-return-claim',
    fetchImpl,
  });
  const client = new Client();

  assert.equal((await client.inspectPendingLink()).valid, true);
  assert.equal((await client.redeemPendingLink()).message, 'switch_required');
  assert.equal((await client.redeemPendingLink({ allowSoulSwitch: true })).ok, true);
  assert.equal((await client.redeemPendingLink()).ok, false);
  assert.equal(requests.every((request) => !request.url.includes('private-return-claim')), true);
  assert.equal(JSON.parse(requests[0].options.body).claim, 'private-return-claim');
  assert.equal(JSON.parse(requests[1].options.body).currentToken, 'existing-soul-token-12345');
  assert.equal(Object.hasOwn(JSON.parse(requests[2].options.body), 'currentToken'), false);
  assert.equal(requests[0].options.credentials, 'omit');
});

test('Keeper owner requests authenticate in a header and never put the credential in the URL', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/example' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { Client } = loadClient({
    hostname: 'eternalpond.com',
    search: '',
    token: 'existing-soul-token-12345',
    fetchImpl,
  });
  const client = new Client();
  await client.createKeeperCheckout('month');

  assert.equal(requests[0].url, 'https://shared-pond.maxpug17.workers.dev/api/v3/keeper/checkout');
  assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer existing-soul-token-12345');
  assert.equal(requests[0].url.includes('existing-soul-token-12345'), false);
  assert.deepEqual(JSON.parse(requests[0].options.body), { interval: 'month' });
});

test('revoking the active browser key never exposes it in the URL and switches to a saved key', async () => {
  const requests = [];
  const activeToken = 'active-browser-token-12345';
  const savedToken = 'saved-browser-token-67890';
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ revoked: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { Client, sockets, storage } = loadClient({
    hostname: 'eternalpond.com',
    search: '',
    token: activeToken,
    fetchImpl,
  });
  storage.set('eternalpond.soul.credentials.v1', JSON.stringify([
    { id: 'active-key', token: activeToken, name: 'Quiet Thistle', tint: 0x79d1c2, lastUsedAt: 2 },
    { id: 'saved-key', token: savedToken, name: 'Gentle Rain', tint: 0x8db6d8, lastUsedAt: 1 },
  ]));
  const client = new Client();

  const result = await client.revokeCredential('active-key');

  assert.equal(result.revoked, true);
  assert.equal(result.wasActive, true);
  assert.equal(result.switchedToSavedCredential, true);
  assert.equal(requests[0].url, 'https://shared-pond.maxpug17.workers.dev/api/v3/credentials/revoke');
  assert.equal(requests[0].url.includes(activeToken), false);
  assert.equal(requests[0].options.headers.get('Authorization'), `Bearer ${activeToken}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), { token: activeToken });
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(storage.get('eternalpond.soul.v2'), savedToken);
  const remaining = JSON.parse(storage.get('eternalpond.soul.credentials.v1'));
  assert.deepEqual(remaining.map((entry) => entry.id), ['saved-key']);
  assert.equal(sockets.length, 1);
});
