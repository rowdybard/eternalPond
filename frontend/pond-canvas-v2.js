(function () {
  'use strict';

  const TAU = Math.PI * 2;

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
      point.y += Math.sin(elapsed * 2 + state.id.length) * 0.6;
      this.drawFish(context, point, entity.heading, size, colorCss(state.tint));
      if (state.label) {
        context.font = '11px system-ui, sans-serif';
        context.textAlign = 'center';
        context.fillStyle = 'rgba(245,247,239,0.88)';
        context.fillText(state.label, point.x, point.y - size * 1.5);
      }
    }

    drawFish(context, point, heading, size, color) {
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
      if (serverMessage.type === 'welcome') ui.setIdentity(serverMessage.identity);
      else if (serverMessage.type === 'snapshot') {
        pond.applySnapshot(serverMessage.snapshot);
        ui.setSnapshot(serverMessage.snapshot);
      } else if (serverMessage.type === 'delta') pond.applyDelta(serverMessage);
      else if (serverMessage.type === 'presence') ui.updatePresence(serverMessage.connectedSouls, serverMessage.capacity);
      else if (serverMessage.type === 'error') ui.showNotice(serverMessage.message || 'the shared water shifted out of reach');
    });

    canvas.addEventListener('pointerdown', () => {
      canvas.focus({ preventScroll: true });
      ui.awaken();
    });
    addEventListener('beforeunload', () => {
      client.dispose();
      pond.dispose();
    }, { once: true });
    setInterval(() => ui.updateLedgerClock(client.serverNow()), 60000);
    pond.start();
    client.connect();
    const loading = document.getElementById('loading-screen');
    if (loading) loading.classList.add('hidden');
    if (message) setTimeout(() => ui.showNotice(message), 500);
  }

  window.EternalPondCanvasV2 = { start: startCanvasPond };
}());
