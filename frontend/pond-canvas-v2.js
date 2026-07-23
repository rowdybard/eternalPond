(function () {
  'use strict';

  const TAU = Math.PI * 2;

  function publicSlugFromPath() {
    const match = location.pathname.match(/^\/s\/([^/]+)\/?$/);
    if (!match) return null;
    try {
      const slug = decodeURIComponent(match[1]).toLowerCase();
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 96 ? slug : null;
    } catch (error) {
      return null;
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mulberry(seed) {
    let value = seed >>> 0;
    return function random() {
      value += 0x6d2b79f5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function colorCss(value) {
    return `#${Number(value || 0x79d1c2).toString(16).padStart(6, '0')}`;
  }

  class CanvasPondV2 {
    constructor(canvas, reducedMotion) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d', { alpha: false });
      if (!this.context) throw new Error('Canvas 2D is unavailable');
      this.reducedMotion = reducedMotion;
      this.entities = new Map();
      this.cohorts = [];
      this.ripples = [];
      this.memories = 0;
      this.foundingRipples = 149;
      this.orbitEpoch = Date.now();
      this.orbitPeriod = 60 * 60 * 1000;
      this.serverNow = () => Date.now();
      this.startedAt = performance.now();
      this.frame = 0;
      this.resize = this.resize.bind(this);
      this.animate = this.animate.bind(this);
      this.resize();
      addEventListener('resize', this.resize);
    }

    setClock(clock) {
      this.serverNow = clock;
    }

    setReducedMotion(reduced) {
      this.reducedMotion = reduced;
    }

    applySnapshot(snapshot) {
      this.orbitEpoch = snapshot.orbit.epoch;
      this.orbitPeriod = snapshot.orbit.periodMs;
      this.memories = snapshot.memories.length;
      this.foundingRipples = snapshot.foundingRipples;
      this.cohorts = snapshot.backgroundCohorts || [];
      const incoming = new Set(snapshot.entities.map((entity) => entity.id));
      for (const id of this.entities.keys()) if (!incoming.has(id)) this.entities.delete(id);
      for (const entity of snapshot.entities) this.upsert(entity, true);
    }

    applyDelta(delta) {
      this.cohorts = delta.backgroundCohorts || this.cohorts;
      for (const id of delta.removedIds || []) this.entities.delete(id);
      for (const id of delta.hiddenIds || []) this.entities.delete(id);
      for (const entity of delta.upserts || []) this.upsert(entity, false);
      for (const motion of delta.motions || []) this.applyMotion(motion);
      for (const ritual of delta.rituals || []) this.addRitual(ritual);
    }

    upsert(state, immediate) {
      const current = this.entities.get(state.id);
      if (!current || immediate) {
        this.entities.set(state.id, {
          state,
          x: state.x,
          z: state.z,
          targetX: state.x,
          targetZ: state.z,
          heading: state.heading,
        });
        return;
      }
      current.state = state;
      current.targetX = state.x;
      current.targetZ = state.z;
      current.heading = state.heading;
    }

    applyMotion(motion) {
      const current = this.entities.get(motion.id);
      if (!current) return;
      current.targetX = motion.x;
      current.targetZ = motion.z;
      current.heading = motion.heading;
      current.state = Object.assign({}, current.state, motion, {
        state: motion.state || current.state.state || {},
      });
    }

    addRitual(ritual) {
      this.ripples.push({
        x: ritual.x,
        z: ritual.z,
        startedAt: performance.now(),
        strength: ritual.strength || 0.5,
      });
      if (this.ripples.length > 24) this.ripples.shift();
    }

    start() {
      if (this.frame) return;
      this.startedAt = performance.now();
      this.animate();
    }

    animate() {
      this.frame = requestAnimationFrame(this.animate);
      const smoothing = this.reducedMotion ? 1 : 0.1;
      for (const entity of this.entities.values()) {
        entity.x += (entity.targetX - entity.x) * smoothing;
        entity.z += (entity.targetZ - entity.z) * smoothing;
      }
      const now = performance.now();
      while (this.ripples[0] && now - this.ripples[0].startedAt > 4200) this.ripples.shift();
      this.draw(now);
    }

    bounds() {
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      const rx = Math.min(width * 0.43, height * 0.58);
      return { cx: width * 0.5, cy: height * 0.64, rx, ry: rx * 0.42 };
    }

    project(x, z) {
      const pond = this.bounds();
      return {
        x: pond.cx + (x - 0.5) * pond.rx * 1.82,
        y: pond.cy + (z - 0.5) * pond.ry * 1.82,
      };
    }

    pointAtClient(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      const pond = this.bounds();
      const ellipseX = (screenX - pond.cx) / pond.rx;
      const ellipseY = (screenY - pond.cy) / pond.ry;
      if (ellipseX * ellipseX + ellipseY * ellipseY > 1) return null;
      return {
        x: clamp(0.5 + (screenX - pond.cx) / (pond.rx * 1.82), 0.05, 0.95),
        z: clamp(0.5 + (screenY - pond.cy) / (pond.ry * 1.82), 0.05, 0.95),
      };
    }

    draw(now) {
      const context = this.context;
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      const elapsed = (now - this.startedAt) / 1000;
      const phase = (((this.serverNow() - this.orbitEpoch) % this.orbitPeriod) + this.orbitPeriod) % this.orbitPeriod / this.orbitPeriod;
      const daylight = clamp((Math.sin(phase * TAU) + 0.4) * 0.72, 0.08, 1);

      context.fillStyle = daylight > 0.45 ? '#304d53' : '#071018';
      context.fillRect(0, 0, width, height);
      this.drawStars(context, width, height, daylight);
      this.drawOrbit(context, width, height, phase);

      const pond = this.bounds();
      context.fillStyle = daylight > 0.35 ? '#55755c' : '#243f38';
      context.beginPath();
      context.ellipse(pond.cx, pond.cy, pond.rx * 1.32, pond.ry * 1.5, 0, 0, TAU);
      context.fill();
      context.strokeStyle = 'rgba(188,214,207,0.22)';
      context.lineWidth = 1;
      context.beginPath();
      context.ellipse(pond.cx, pond.cy - pond.ry * 1.12, pond.rx * 1.62, pond.ry * 3.55, 0, Math.PI * 1.05, Math.PI * 1.95);
      context.stroke();

      context.fillStyle = daylight > 0.35 ? '#287079' : '#163f4d';
      context.beginPath();
      context.ellipse(pond.cx, pond.cy, pond.rx, pond.ry, 0, 0, TAU);
      context.fill();
      context.strokeStyle = 'rgba(210,237,227,0.56)';
      context.lineWidth = 4;
      context.stroke();

      context.save();
      context.beginPath();
      context.ellipse(pond.cx, pond.cy, pond.rx, pond.ry, 0, 0, TAU);
      context.clip();
      context.strokeStyle = 'rgba(175,235,216,0.12)';
      context.lineWidth = 1;
      for (let index = 0; index < 9; index++) {
        const waveY = pond.cy - pond.ry + index * pond.ry * 0.23;
        context.beginPath();
        for (let x = pond.cx - pond.rx; x <= pond.cx + pond.rx; x += 8) {
          const y = waveY + Math.sin(x * 0.025 + elapsed * 0.7 + index) * 4;
          if (x === pond.cx - pond.rx) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      context.restore();

      for (const entity of this.entities.values()) this.drawEntity(context, entity, elapsed);
      this.drawRipples(context, now);
    }

    drawStars(context, width, height, daylight) {
      context.fillStyle = `rgba(226,235,232,${0.58 * (1 - daylight * 0.72)})`;
      const count = Math.min(210, 90 + this.foundingRipples);
      for (let index = 0; index < count; index++) {
        const x = (index * 83.71 % 1000) / 1000 * width;
        const y = (index * 47.17 % 510) / 510 * height * 0.72;
        const size = index < this.memories ? 1.8 : 0.75;
        context.fillRect(x, y, size, size);
      }
    }

    drawOrbit(context, width, height, phase) {
      const angle = phase * TAU;
      const sunX = width * 0.5 + Math.cos(angle) * width * 0.38;
      const sunY = height * 0.28 - Math.sin(angle) * height * 0.22;
      context.fillStyle = '#ebc66f';
      context.beginPath();
      context.arc(sunX, sunY, Math.max(6, width * 0.008), 0, TAU);
      context.fill();
      const earthX = width * 0.34 + Math.cos(angle * 0.28) * width * 0.08;
      const earthY = height * 0.22 + Math.sin(angle * 0.21) * height * 0.05;
      context.fillStyle = '#4b87a2';
      context.beginPath();
      context.arc(earthX, earthY, Math.max(8, width * 0.012), 0, TAU);
      context.fill();
      context.fillStyle = '#b4b2a8';
      context.beginPath();
      context.arc(earthX + Math.cos(angle * 5.2) * 19, earthY + Math.sin(angle * 5.2) * 9, 3, 0, TAU);
      context.fill();
    }

    drawEntity(context, entity, elapsed) {
      const state = entity.state;
      const point = this.project(entity.x, entity.z);
      if (state.kind === 'lily') {
        context.fillStyle = '#6fa276';
        context.beginPath();
        context.ellipse(point.x, point.y, 5, 2.4, state.heading, 0, TAU);
        context.fill();
        return;
      }
      if (state.kind === 'bird') {
        context.fillStyle = '#30363b';
        context.beginPath();
        context.moveTo(point.x - 5, point.y);
        context.quadraticCurveTo(point.x, point.y - 4, point.x + 5, point.y);
        context.quadraticCurveTo(point.x, point.y - 1, point.x - 5, point.y);
        context.fill();
        return;
      }
      if (state.kind === 'frog') {
        const growth = state.state && state.state.growthScale || 1;
        context.fillStyle = '#4a7c3a';
        context.beginPath();
        context.ellipse(point.x, point.y, 5 * growth, 3.5 * growth, entity.heading, 0, TAU);
        context.fill();
        context.fillStyle = '#f4f3de';
        context.beginPath();
        context.arc(point.x + 2 * growth, point.y - 2 * growth, 0.9 * growth, 0, TAU);
        context.fill();
        return;
      }
      const size = state.kind === 'legendaryPenguin' ? 8 : 3.2 + state.size * 1.8;
      if (!this.reducedMotion) point.y += Math.sin(elapsed * 2 + state.id.length) * 0.6;
      this.drawFish(context, point, entity.heading, size, colorCss(state.tint), state.state && state.state.keeperAccent === true);
      if (state.label) {
        context.font = '11px system-ui, sans-serif';
        context.textAlign = 'center';
        context.fillStyle = 'rgba(245,247,239,0.88)';
        context.fillText(state.label, point.x, point.y - size * 1.5);
      }
    }

    drawFish(context, point, heading, size, color, keeperAccent) {
      context.save();
      context.translate(point.x, point.y);
      context.rotate(heading);
      context.fillStyle = color;
      context.beginPath();
      context.ellipse(0, 0, size * 1.5, size * 0.62, 0, 0, TAU);
      context.fill();
      context.beginPath();
      context.moveTo(-size * 1.15, 0);
      context.lineTo(-size * 2, -size * 0.72);
      context.lineTo(-size * 2, size * 0.72);
      context.closePath();
      context.fill();
      context.beginPath();
      context.moveTo(-size * 0.05, size * 0.25);
      context.lineTo(size * 0.62, size * 0.85);
      context.lineTo(size * 0.7, size * 0.12);
      context.closePath();
      context.fill();
      if (keeperAccent) {
        context.fillStyle = '#e8e3d2';
        context.beginPath();
        context.moveTo(-size * 0.12, -size * 0.34);
        context.lineTo(size * 0.18, -size * 0.92);
        context.lineTo(size * 0.5, -size * 0.28);
        context.closePath();
        context.fill();
      }
      context.fillStyle = '#f3eee0';
      context.beginPath();
      context.arc(size * 0.9, -size * 0.22, Math.max(0.65, size * 0.11), 0, TAU);
      context.fill();
      context.fillStyle = '#17383b';
      context.beginPath();
      context.arc(size * 0.96, -size * 0.22, Math.max(0.35, size * 0.05), 0, TAU);
      context.fill();
      context.restore();
    }

    drawRipples(context, now) {
      for (const ripple of this.ripples) {
        const age = (now - ripple.startedAt) / 1000;
        const point = this.project(ripple.x, ripple.z);
        context.strokeStyle = `rgba(207,239,229,${Math.max(0, 0.46 - age * 0.11)})`;
        context.lineWidth = 1.2;
        context.beginPath();
        context.ellipse(point.x, point.y, age * 22 * ripple.strength, age * 9 * ripple.strength, 0, 0, TAU);
        context.stroke();
      }
    }

    resize() {
      const ratio = Math.min(devicePixelRatio || 1, 1.75);
      this.canvas.width = Math.max(1, Math.floor(innerWidth * ratio));
      this.canvas.height = Math.max(1, Math.floor(innerHeight * ratio));
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    dispose() {
      cancelAnimationFrame(this.frame);
      removeEventListener('resize', this.resize);
    }
  }

  let active = false;

  function startCanvasPond(message) {
    if (active) return;
    active = true;
    const canvas = document.getElementById('pond-fallback');
    const webglCanvas = document.getElementById('pond3d');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Fallback canvas is missing');
    webglCanvas.hidden = true;
    canvas.hidden = false;

    let reducedMotion;
    try {
      const saved = localStorage.getItem('eternalpond.reduced-motion.v2');
      reducedMotion = saved === null ? matchMedia('(prefers-reduced-motion: reduce)').matches : saved === 'true';
    } catch (error) {
      reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    const ui = new window.PondUI({ reducedMotion });
    const pond = new CanvasPondV2(canvas, reducedMotion);
    const client = new window.PondClientV2({ renderer: 'canvas', reducedMotion });
    const publicSlug = publicSlugFromPath();
    let publicMemorialTracked = false;
    let memorialReturnPending = false;
    let incarnationBlocked = false;
    pond.setClock(() => client.serverNow());
    ui.setSoundEnabled(false);
    ui.showBirthCue(false);
    ui.onSoundToggle = () => ui.showNotice('this simpler view is quiet');
    ui.onReducedMotion = (next) => {
      pond.setReducedMotion(next);
      client.reducedMotion = next;
      try { localStorage.setItem('eternalpond.reduced-motion.v2', String(next)); }
      catch (error) { /* Keep the visit-local setting. */ }
    };

    client.on('state', (state) => ui.setConnection(state));
    client.on('message', (serverMessage) => {
      if (serverMessage.type === 'welcome') {
        ui.setWelcome(serverMessage);
        ui.setCredentials(client.credentialSummaries());
        incarnationBlocked = !!(serverMessage.currentLife && serverMessage.currentLife.status === 'resting');
        if (serverMessage.recentLifeRecord) {
          ui.showLifeEnded(serverMessage.recentLifeRecord.ageText, false, serverMessage.recentLifeRecord.completedAt);
          if (memorialReturnPending && !publicMemorialTracked && window.PondAnalytics) {
            publicMemorialTracked = true;
            window.PondAnalytics.track('memorial_open');
          }
        }
        memorialReturnPending = false;
        if (publicSlug) client.observePublicSoul(publicSlug);
      } else if (serverMessage.type === 'snapshot') {
        pond.applySnapshot(serverMessage.snapshot);
        ui.setSnapshot(serverMessage.snapshot);
        ui.setQueue(null);
        ui.showBirthCue(!client.ownedEntityId && !incarnationBlocked);
        if (client.ownedEntityId) ui.awaken();
      } else if (serverMessage.type === 'delta') pond.applyDelta(serverMessage);
      else if (serverMessage.type === 'presence') ui.updatePresence(serverMessage.connectedSouls, serverMessage.capacity);
      else if (serverMessage.type === 'queue') {
        ui.setQueue(serverMessage);
      }
      else if (serverMessage.type === 'lifeStarted') {
        incarnationBlocked = false;
        ui.setQueue(null);
        ui.showBirthCue(false);
        ui.showLifeStarted(serverMessage.life);
        if (window.PondAnalytics) {
          window.PondAnalytics.track('fish_birth');
          if (serverMessage.reincarnation) window.PondAnalytics.track('reincarnation');
        }
      } else if (serverMessage.type === 'lifeEnded') {
        incarnationBlocked = false;
        ui.showLifeEnded(serverMessage.ageText, true, serverMessage.completedAt, serverMessage.memory);
      } else if (serverMessage.type === 'sharingAck') {
        ui.setSharingBusy(false);
        if (serverMessage.accepted) ui.setSharing(serverMessage.sharing);
      } else if (serverMessage.type === 'publicSoulContext') {
        ui.setPublicSoul(serverMessage.soul);
        if (serverMessage.soul) {
          const point = serverMessage.soul.currentLife && serverMessage.soul.currentLife.presentation
            || serverMessage.soul.latestMemorial && serverMessage.soul.latestMemorial.rippleAnchor;
          if (point) pond.addRitual({ x: point.x, z: point.z, strength: 0.72 });
          if (serverMessage.soul.status !== 'alive' && !publicMemorialTracked && window.PondAnalytics) {
            publicMemorialTracked = true;
            window.PondAnalytics.track('memorial_open');
          }
        }
      } else if (serverMessage.type === 'pondLetterAck') {
        ui.setLetterBusy(false);
        if (serverMessage.accepted) ui.setLetterPreference(serverMessage.preference, { trackConfirmation: true });
        else ui.showNotice(serverMessage.reason === 'rate_limited'
          ? 'the pond needs a little time before sending again'
          : 'the Pond Letter could not be changed');
      } else if (serverMessage.type === 'keeperUpdated') {
        ui.setKeeperBusy(false);
        ui.setKeeper(serverMessage.keeper);
      } else if (serverMessage.type === 'ritualAck' && serverMessage.requestId && serverMessage.requestId.startsWith('public_ripple_')) {
        ui.setPublicRippleBusy(false);
        if (serverMessage.accepted) ui.showNotice('a ripple moves beside this soul');
      } else if (serverMessage.type === 'ritualAck' && !serverMessage.accepted && serverMessage.reason === 'keeper_resting') {
        incarnationBlocked = true;
        ui.showBirthCue(false);
        ui.showNotice('this eternal fish is resting beneath the dome');
      } else if (serverMessage.type === 'error') {
        ui.setSharingBusy(false);
        ui.setLetterBusy(false);
        ui.setKeeperBusy(false);
        ui.setPublicRippleBusy(false);
        ui.showNotice(serverMessage.message || 'the shared water shifted out of reach');
      }
    });

    ui.onSetSharing = (enabled) => {
      ui.setSharingBusy(true);
      client.setSharing(enabled);
    };
    ui.onShare = async (details) => {
      const share = window.PondShareCard || window.PondShare;
      if (!share) return ui.showNotice('this browser could not prepare a share');
      const result = await share.share(details);
      if (result.method === 'copy') ui.showNotice('the quiet link was copied');
      else if (result.method === 'unavailable') ui.showNotice('this browser could not share the page');
    };
    ui.onSetPondLetter = (preference) => {
      ui.setLetterBusy(true);
      client.setPondLetter(preference);
    };
    ui.onResendPondLetter = () => {
      ui.setLetterBusy(true);
      client.resendPondLetterConfirmation();
    };
    ui.onUnsubscribePondLetters = () => {
      ui.setLetterBusy(true);
      client.unsubscribePondLetters();
    };
    ui.onPublicRipple = (slug) => {
      ui.setPublicRippleBusy(true);
      client.leavePublicRipple(slug);
    };
    ui.onMemoryFocus = (memory) => {
      pond.addRitual({ x: memory.x, z: memory.z, strength: 0.82 });
      ui.closeLedger();
      ui.showNotice(`${memory.name} is held here`);
    };
    ui.onSwitchCredential = (credentialId) => {
      if (!client.switchCredential(credentialId)) return;
      ui.closeLedger();
      ui.showNotice('returning by another remembered path');
    };
    ui.onForgetCredential = async (credentialId) => {
      ui.setCredentialBusy(true);
      try {
        const result = await client.revokeCredential(credentialId);
        ui.setCredentials(client.credentialSummaries());
        if (result.wasActive) ui.closeLedger();
        ui.showNotice(result.wasActive
          ? result.switchedToSavedCredential
            ? 'that key is forgotten; another remembered path is opening'
            : 'that key is forgotten; a new soul is beginning in this browser'
          : 'that saved browser key is forgotten');
      } catch (error) {
        ui.showNotice('that browser key could not be forgotten');
      } finally {
        ui.setCredentialBusy(false);
      }
    };
    ui.onKeeperCheckout = async (interval) => {
      ui.setKeeperBusy(true);
      try {
        const result = await client.createKeeperCheckout(interval);
        const destination = new URL(result.url);
        if (destination.protocol !== 'https:') throw new Error('invalid_checkout_destination');
        location.assign(destination.href);
      } catch (error) {
        ui.setKeeperBusy(false);
        ui.showNotice(error && error.message === 'email_required'
          ? 'confirm a recovery address before keeping a fish'
          : 'the keeper path could not open');
      }
    };
    ui.onKeeperPortal = async () => {
      ui.setKeeperBusy(true);
      try {
        const result = await client.createKeeperPortal();
        const destination = new URL(result.url);
        if (destination.protocol !== 'https:') throw new Error('invalid_portal_destination');
        location.assign(destination.href);
      } catch (error) {
        ui.setKeeperBusy(false);
        ui.showNotice('the keeper account could not open');
      }
    };
    ui.onKeeperUpdate = async (patch) => {
      ui.setKeeperBusy(true);
      try {
        const result = await client.updateKeeper(patch);
        const keeper = result && (result.keeper || result);
        if (keeper && typeof keeper.configured === 'boolean') ui.setKeeper(keeper);
      } catch (error) {
        ui.showNotice('that keeper change could not be held');
      } finally {
        ui.setKeeperBusy(false);
      }
    };

    async function inspectSecureLink() {
      if (!client.pendingLinkClaim) return;
      try {
        const inspection = await client.inspectPendingLink();
        if (inspection.valid) ui.showSecureLink(inspection, !!client.currentToken());
        else ui.showNotice('this private pond path has faded');
      } catch (error) {
        ui.showNotice('the private pond path could not be read');
      }
    }

    ui.onSecureLinkAccept = async () => {
      ui.setSecureLinkBusy(true);
      try {
        const result = await client.redeemPendingLink({ allowSoulSwitch: ui.allowsSecureLinkSwitch() });
        if (!result.ok && result.message === 'switch_required') {
          ui.requireSecureLinkSwitch(result);
          return;
        }
        if (!result.ok) throw new Error(result.message || 'link_redeem_failed');
        memorialReturnPending = result.purpose === 'return_soul';
        if (result.purpose === 'confirm_email' && window.PondAnalytics) window.PondAnalytics.track('email_opt_in');
        if (result.token) client.adoptCredential(result.token, { name: result.name || '' });
        else if (result.purpose === 'confirm_email' || result.purpose === 'unsubscribe') client.refreshIdentity();
        if (result.slug) client.observePublicSoul(result.slug);
        ui.hideSecureLink();
        ui.showNotice(result.message || 'the remembered path has opened');
      } catch (error) {
        ui.showNotice('this private pond path could not be followed');
      } finally {
        ui.setSecureLinkBusy(false);
      }
    };

    let pointerStart = null;
    canvas.addEventListener('pointerdown', (event) => {
      canvas.focus({ preventScroll: true });
      ui.awaken();
      pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!pointerStart || pointerStart.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 10;
      pointerStart = null;
      if (moved) return;
      const point = pond.pointAtClient(event.clientX, event.clientY);
      if (!point) return;
      pond.addRitual({ x: point.x, z: point.z, strength: client.ownedEntityId ? 0.5 : 0.72 });
      if (client.ownedEntityId) client.ripple(point);
      else if (!incarnationBlocked) {
        client.incarnate(point);
        ui.showBirthCue(false);
      }
    });
    canvas.addEventListener('pointercancel', () => { pointerStart = null; });
    addEventListener('beforeunload', () => {
      client.dispose();
      pond.dispose();
    }, { once: true });
    setInterval(() => ui.updateLedgerClock(client.serverNow()), 60000);
    pond.start();
    client.connect();
    inspectSecureLink();
    const keeperReturn = new URLSearchParams(location.search).get('keeper');
    if (keeperReturn === 'return') ui.showNotice('the pond is waiting for the paid invoice');
    else if (keeperReturn === 'cancel') ui.showNotice('nothing changed; the fish remains as it was');
    if (keeperReturn) {
      const cleaned = new URL(location.href);
      cleaned.searchParams.delete('keeper');
      history.replaceState(history.state, '', cleaned.pathname + cleaned.search + cleaned.hash);
    }
    const loading = document.getElementById('loading-screen');
    if (loading) loading.classList.add('hidden');
    if (message) setTimeout(() => ui.showNotice(message), 500);
  }

  window.EternalPondCanvasV2 = { start: startCanvasPond };
}());
