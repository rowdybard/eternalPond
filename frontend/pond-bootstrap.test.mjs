import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('./pond-runtime-v2.js', import.meta.url), 'utf8');
const canvasSource = readFileSync(new URL('./pond-canvas-v2.js', import.meta.url), 'utf8');
const scriptStart = html.indexOf('(function bootstrapPondPrivacy');
const scriptEnd = html.indexOf('</script>', scriptStart);
const source = html.slice(scriptStart, scriptEnd);

function loadBootstrap(href) {
  const url = new URL(href);
  const replacements = [];
  const window = {
    location: {
      href: url.href,
      hostname: url.hostname,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
    history: {
      state: null,
      replaceState(_state, _title, next) { replacements.push(next); },
    },
  };
  window.window = window;
  vm.runInNewContext(source, { window, URL, URLSearchParams, Date, Object, Array }, { filename: 'index.html#privacy' });
  return { window, replacements };
}

test('the synchronous scrubber captures local overrides and removes every sensitive spelling before GA', () => {
  const { window, replacements } = loadBootstrap(
    'http://127.0.0.1:5173/s/quiet-thistle?pondWs=ws%3A%2F%2F127.0.0.1%3A9999%2Fws&pondApi=http%3A%2F%2F127.0.0.1%3A9999&SoulToken=secret&renderer=canvas#Pond=return-claim&TOKEN=hash-secret&Email=private%40example.com&kept=yes',
  );

  assert.equal(replacements.at(-1), '/s/quiet-thistle?renderer=canvas#kept=yes');
  assert.equal(window.PondBootstrap.devWebSocketOverride(), 'ws://127.0.0.1:9999/ws');
  assert.equal(window.PondBootstrap.devApiOverride(), 'http://127.0.0.1:9999');
  assert.equal(window.PondBootstrap.takeLinkClaim(), 'return-claim');
  assert.equal(window.PondBootstrap.hasLinkClaim(), false);
  assert.equal(window.PondAnalytics.pagePath, '/s/:slug');
  assert.equal(JSON.stringify(window.dataLayer).includes('secret'), false);
  assert.equal(JSON.stringify(window.dataLayer).includes('private@example.com'), false);
  assert.equal(JSON.stringify(window.dataLayer).includes('return-claim'), false);
  assert.equal(JSON.stringify(window.dataLayer).includes('quiet-thistle'), false);
});

test('production discards dev overrides and analytics accepts only the four relationship events', () => {
  const { window, replacements } = loadBootstrap(
    'https://eternalpond.com/?PondWs=wss%3A%2F%2Fevil.example%2Fcollect&PONDAPI=https%3A%2F%2Fevil.example&token=secret',
  );

  assert.equal(replacements.at(-1), '/');
  assert.equal(window.PondBootstrap.devWebSocketOverride(), null);
  assert.equal(window.PondBootstrap.devApiOverride(), null);
  assert.equal(window.PondAnalytics.track('identity_leak'), false);
  for (const eventName of ['fish_birth', 'email_opt_in', 'memorial_open', 'reincarnation']) {
    assert.equal(window.PondAnalytics.track(eventName), true);
  }
  const eventNames = window.dataLayer
    .map((entry) => Array.from(entry))
    .filter((entry) => entry[0] === 'event')
    .map((entry) => entry[1]);
  assert.deepEqual(Array.from(eventNames), ['fish_birth', 'email_opt_in', 'memorial_open', 'reincarnation']);
});

test('GA4 loads only after the synchronous privacy scrubber and uses the configured measurement ID', () => {
  const scrubberEnd = html.indexOf('</script>', scriptStart);
  const gaLoader = html.indexOf('https://www.googletagmanager.com/gtag/js?id=G-SX17SEMR76');

  assert.notEqual(gaLoader, -1);
  assert.ok(gaLoader > scrubberEnd);
  assert.match(source, /gtag\('config', 'G-SX17SEMR76'/);
});

test('public soul presentation uses an identifier-free local observer that cannot become interactive', () => {
  const observerStart = runtimeSource.indexOf('setPublicObserver(soul)');
  const observerEnd = runtimeSource.indexOf('\n    syncFish(', observerStart);
  assert.notEqual(observerStart, -1);
  assert.notEqual(observerEnd, -1);
  const observerSource = runtimeSource.slice(observerStart, observerEnd);

  assert.match(observerSource, /soulId:\s*null/);
  assert.match(observerSource, /lifeId:\s*null/);
  assert.match(observerSource, /observerOnly:\s*true/);
  assert.equal(observerSource.includes('soul.id'), false);
  assert.equal(observerSource.includes('soul.soulId'), false);
  assert.equal(observerSource.includes('currentLife.lifeId'), false);
  assert.match(runtimeSource, /observerOnly === true \? null : view\.state\.id/);
  assert.match(runtimeSource, /id === this\.publicObserverId \? null : id/);
  assert.match(runtimeSource, /state\.id !== this\.publicObserverId/);
  assert.match(runtimeSource, /motion\.id !== this\.publicObserverId/);
  assert.match(runtimeSource, /state === 'closed' \|\| state === 'connecting'/);
});

test('Canvas fallback recognizes an existing current life without foreground ownership', () => {
  assert.match(canvasSource, /hasCurrentLife = !!serverMessage\.currentLife/);
  assert.match(canvasSource, /showBirthCue\(!client\.ownedEntityId && !hasCurrentLife && !incarnationBlocked\)/);
  assert.match(canvasSource, /if \(client\.ownedEntityId \|\| hasCurrentLife\) client\.ripple\(point\)/);
});
