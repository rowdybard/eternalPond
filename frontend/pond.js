// ===== CONFIG =====
const WS_URL = 'wss://ws.eternalpond.com/ws';
const MAX_CREATURES = 80;
const MAX_RIPPLES = 120;
const MAX_LILIES = 40;
const MAX_WAVES = 30;
const MAX_FOAM = 300;
const MAX_BIRDS = 12;
const WAVE_COOLDOWN = 1500;
const WAVE_COOLUP = 500;
const LILY_PLACE_COOLDOWN = 2000;
const OFFSCREEN_MARGIN = 80;

// ===== CANVAS SETUP =====
const canvas = document.getElementById('pond');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ===== UTILITY =====
function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rgbaFromHex(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function isOffScreen(x, y, margin) {
  margin = margin || OFFSCREEN_MARGIN;
  return x < -margin || x > W + margin || y < -margin || y > H + margin;
}

// ===== ENTITY: WAVE =====
class Wave {
  constructor(x, y, opts = {}) {
    this.x = x;
    this.y = y;
    this.radius = opts.startRadius || 5;
    this.maxRadius = opts.maxRadius || (180 + Math.random() * 80);
    this.speed = opts.speed || 3.5;
    this.life = 1;
    this.force = opts.force || 20;
    this.splashAngle = opts.splashAngle !== undefined ? opts.splashAngle : Math.random() * Math.PI * 2;
    this.splashSpread = opts.splashSpread || (Math.PI * 0.4);
    this.foamSpawned = false;
    this.id = Math.random();
    this.damagedLilies = new Set();
    this.foamAccum = 0;
  }

  update(dt) {
    this.radius += this.speed * dt;
    this.life = 1 - (this.radius / this.maxRadius);
    const waveStrength = this.life * this.life; // quadratic falloff

    // apply force to creatures
    for (const c of creatures) {
      const d = dist(this.x, this.y, c.x, c.y);
      if (d > this.radius - 50 && d < this.radius + 50) {
        const angle = Math.atan2(c.y - this.y, c.x - this.x);
        const inSplash = Math.abs(((angle - this.splashAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < this.splashSpread;
        const power = this.force * waveStrength * (inSplash ? 2.5 : 1.0);
        c.vx = (c.vx || 0) + Math.cos(angle) * power * 0.15;
        c.vy = (c.vy || 0) + Math.sin(angle) * power * 0.15;
      }
    }

    // damage lily pads — only once per lily per wave, and only at peak strength
    for (let i = lilies.length - 1; i >= 0; i--) {
      const l = lilies[i];
      if (this.damagedLilies.has(l)) continue;
      const d = dist(this.x, this.y, l.x, l.y);
      if (d < this.radius + 10 && d > this.radius - 20 && this.life > 0.3) {
        l.life -= 0.15; // single hit, not per-frame
        this.damagedLilies.add(l);
      }
    }

    // foam generation — continuous at crest, proportional to wave energy
    this.foamAccum += dt;
    if (this.foamAccum > 0.5) {
      this.foamAccum = 0;
      const foamCount = Math.floor(3 * waveStrength) + 1;
      for (let i = 0; i < foamCount; i++) {
        const a = this.splashAngle + (Math.random() - 0.5) * this.splashSpread * 2.5;
        const fx = this.x + Math.cos(a) * this.radius;
        const fy = this.y + Math.sin(a) * this.radius;
        foamParticles.push(new FoamParticle(fx, fy, a, waveStrength));
      }
      // also spawn foam around full ring (lighter)
      if (waveStrength > 0.3) {
        const a2 = Math.random() * Math.PI * 2;
        const fx2 = this.x + Math.cos(a2) * this.radius;
        const fy2 = this.y + Math.sin(a2) * this.radius;
        foamParticles.push(new FoamParticle(fx2, fy2, a2, waveStrength * 0.3));
      }
    }

    return this.life > 0;
  }

  draw(ctx) {
    const r = Math.max(0.1, this.radius);
    const alpha = this.life;
    const strength = alpha * alpha;

    // === DEPTH SHADOW (dark band just inside wave — trough) ===
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.x, this.y, Math.max(0.1, r - 8), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(5, 15, 35, ${strength * 0.25})`;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();

    // === WAVE BODY (gradient ring — light at crest, dark at base) ===
    // Draw the wave as a thick ring with radial gradient for 3D height illusion
    const innerR = Math.max(0.1, r - 6);
    const outerR = r + 6;
    const ringGrad = ctx.createRadialGradient(this.x, this.y, innerR, this.x, this.y, outerR);
    ringGrad.addColorStop(0, `rgba(20, 60, 110, ${strength * 0.15})`);
    ringGrad.addColorStop(0.4, `rgba(60, 140, 200, ${strength * 0.35})`);
    ringGrad.addColorStop(0.7, `rgba(120, 200, 250, ${strength * 0.5})`);
    ringGrad.addColorStop(1, `rgba(180, 230, 255, ${strength * 0.2})`);
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.stroke();

    // === CREST HIGHLIGHT (bright refraction at top of wave) ===
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, this.splashAngle - this.splashSpread, this.splashAngle + this.splashSpread);
    ctx.strokeStyle = `rgba(200, 240, 255, ${strength * 0.7})`;
    ctx.lineWidth = 5;
    ctx.stroke();
    // specular glint
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, this.splashAngle - this.splashSpread * 0.4, this.splashAngle + this.splashSpread * 0.4);
    ctx.strokeStyle = `rgba(255, 255, 255, ${strength * 0.5})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // === TRAILING RINGS (depth perspective — inner rings fading) ===
    for (let i = 1; i <= 3; i++) {
      const tr = r - i * 10;
      if (tr < 5) break;
      const ta = strength * 0.08 / i;
      ctx.strokeStyle = `rgba(100, 170, 220, ${ta})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
    ctx.arc(this.x, this.y, tr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // === OUTER DISPERSION (faint outer ring — wave spreading) ===
    ctx.strokeStyle = `rgba(80, 150, 210, ${strength * 0.08})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r + 8, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ===== ENTITY: FOAM PARTICLE =====
class FoamParticle {
  constructor(x, y, angle, energy) {
    this.x = x;
    this.y = y;
    const e = energy || 1;
    const speed = (0.8 + Math.random() * 2.5) * e;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.size = 1.5 + Math.random() * 4 * e;
    this.life = 1;
    this.decay = 0.01 + Math.random() * 0.012;
    this.settling = 0; // gravity-like settling over time
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= 0.94;
    this.vy *= 0.94;
    this.settling += 0.02 * dt;
    this.vy += this.settling * 0.1; // slight downward drift
    this.life -= this.decay * dt;
    return this.life > 0;
  }

  draw(ctx) {
    const r = Math.max(0.1, this.size * this.life);
    const a = this.life;
    // foam bubble with inner highlight
    ctx.fillStyle = `rgba(220, 240, 255, ${a * 0.5})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.fill();
    // specular dot
    if (r > 1.5) {
      ctx.fillStyle = `rgba(255, 255, 255, ${a * 0.7})`;
      ctx.beginPath();
      ctx.arc(this.x - r * 0.25, this.y - r * 0.25, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ===== ENTITY: RIPPLE (ambient) =====
class Ripple {
  constructor(x, y, opts = {}) {
    this.x = x;
    this.y = y;
    this.radius = opts.startRadius || 0;
    this.maxRadius = opts.maxRadius || (60 + Math.random() * 40);
    this.speed = opts.speed || 1.2;
    this.life = 1;
    this.lineWidth = opts.lineWidth || 2;
  }

  update() {
    this.radius += this.speed;
    this.life = 1 - (this.radius / this.maxRadius);
    return this.life > 0;
  }

  draw(ctx) {
    const r = Math.max(0.1, this.radius);
    ctx.strokeStyle = `rgba(180, 220, 255, ${this.life * 0.2})`;
    ctx.lineWidth = this.lineWidth;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ===== FISH TIERS =====
const FISH_TIERS = [
  { name: 'small',   sizeMin: 8,  sizeMax: 14, speed: 0.8, color: ['#f9b208', '#e94560', '#00f5d4', '#ff6b6b'], eatCount: 0, eatRange: 0 },
  { name: 'medium',  sizeMin: 16, sizeMax: 24, speed: 0.7, color: ['#f9b208', '#e94560', '#4ecdc4'], eatCount: 2, eatRange: 80 },
  { name: 'large',   sizeMin: 26, sizeMax: 36, speed: 0.6, color: ['#e94560', '#9b5de5'], eatCount: 4, eatRange: 120 },
  { name: 'legendary', sizeMin: 40, sizeMax: 55, speed: 0.5, color: ['#9b5de5', '#ffe66d'], eatCount: 6, eatRange: 160 },
];

function rollFishTier() {
  const r = Math.random();
  if (r < 0.65) return 0;
  if (r < 0.88) return 1;
  if (r < 0.98) return 2;
  return 3;
}

// ===== ENTITY: FISH =====
class Fish {
  constructor(x, y, tier) {
    this.type = 'fish';
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.tier = tier !== undefined ? tier : rollFishTier();
    const t = FISH_TIERS[this.tier];
    this.size = t.sizeMin + Math.random() * (t.sizeMax - t.sizeMin);
    this.baseSpeed = t.speed * (0.8 + Math.random() * 0.4);
    this.speed = this.baseSpeed;
    this.color = t.color[Math.floor(Math.random() * t.color.length)];
    this.turnTimer = 0;
    this.turnRate = 0;
    this.tailPhase = Math.random() * Math.PI * 2;
    this.life = 1;
    this.decay = 0.000015 + Math.random() * 0.00002;
    this.trail = [];
    this.eaten = 0;
    this.eatTarget = null;
    this.eatCooldown = 0;
    this.growthScale = 1;
  }

  update(dt) {
    this.tailPhase += 0.15;
    this.turnTimer -= dt;
    this.eatCooldown -= dt;

    // eating AI
    const tierData = FISH_TIERS[this.tier];
    if (tierData.eatCount > 0 && this.eaten < tierData.eatCount && this.eatCooldown <= 0) {
      if (!this.eatTarget || !creatures.includes(this.eatTarget)) {
        // find nearest smaller fish or dragonfly
        let nearest = null;
        let nearestDist = tierData.eatRange;
        for (const c of creatures) {
          if (c === this) continue;
          if (c.type === 'fish' && c.tier < this.tier) {
            const d = dist(this.x, this.y, c.x, c.y);
            if (d < nearestDist) { nearest = c; nearestDist = d; }
          } else if (c.type === 'dragonfly' && this.tier >= 1) {
            const d = dist(this.x, this.y, c.x, c.y);
            if (d < nearestDist) { nearest = c; nearestDist = d; }
          }
        }
        this.eatTarget = nearest;
      }

      if (this.eatTarget) {
        const d = dist(this.x, this.y, this.eatTarget.x, this.eatTarget.y);
        if (d < this.size * 0.8) {
          // eat!
          this.eatTarget.life = 0;
          this.eaten++;
          this.growthScale = Math.min(this.growthScale + 0.15, 2.5);
          this.eatTarget = null;
          this.eatCooldown = 60;
          // ripple at eat location
          ripples.push(new Ripple(this.x, this.y, { maxRadius: 30 }));
          // large/legendary can eat lily pads too
          if (this.tier >= 2) {
            for (let i = lilies.length - 1; i >= 0; i--) {
              if (dist(this.x, this.y, lilies[i].x, lilies[i].y) < this.size) {
                lilies[i].life -= 0.3;
              }
            }
          }
        } else {
          // steer toward target
          const targetAngle = Math.atan2(this.eatTarget.y - this.y, this.eatTarget.x - this.x);
          let diff = ((targetAngle - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          this.angle += clamp(diff, -0.06, 0.06);
          this.speed = this.baseSpeed * 1.8;
        }
      } else {
        this.speed = this.baseSpeed;
      }
    } else {
      this.speed = this.baseSpeed;
    }

    if (this.turnTimer <= 0) {
      this.turnRate = (Math.random() - 0.5) * 0.04;
      this.turnTimer = 30 + Math.random() * 80;
    }
    this.angle += this.turnRate;

    // avoid edges (but waves can push past)
    const margin = 60;
    if (this.x < margin && this.vx > -0.5) this.angle += 0.03;
    if (this.x > W - margin && this.vx < 0.5) this.angle -= 0.03;
    if (this.y < margin && this.vy > -0.5) this.angle += 0.03;
    if (this.y > H - margin && this.vy < 0.5) this.angle -= 0.03;

    this.x += Math.cos(this.angle) * this.speed + this.vx;
    this.y += Math.sin(this.angle) * this.speed + this.vy;
    this.vx *= 0.96;
    this.vy *= 0.96;

    // trail
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 12) this.trail.shift();

    this.life -= this.decay;

    // off-screen death
    if (isOffScreen(this.x, this.y)) return false;

    return this.life > 0;
  }

  draw(ctx) {
    const sz = this.size * this.growthScale;

    // trail
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const a = (i / this.trail.length) * 0.12 * this.life;
      ctx.fillStyle = rgbaFromHex(this.color, a);
      ctx.beginPath();
      ctx.arc(t.x, t.y, sz * 0.25 * (i / this.trail.length), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.globalAlpha = this.life;

    // tail
    const tailWag = Math.sin(this.tailPhase) * 0.4;
    ctx.fillStyle = rgbaFromHex(this.color, 0.7);
    ctx.beginPath();
    ctx.moveTo(-sz * 0.8, 0);
    ctx.lineTo(-sz * 1.6, sz * 0.5 + tailWag * sz);
    ctx.lineTo(-sz * 1.6, -sz * 0.5 + tailWag * sz);
    ctx.closePath();
    ctx.fill();

    // body
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, sz, sz * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // tier markings
    if (this.tier >= 2) {
      ctx.fillStyle = rgbaFromHex(this.color, 0.5);
      ctx.beginPath();
      ctx.ellipse(-sz * 0.2, 0, sz * 0.6, sz * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.tier >= 3) {
      // legendary glow
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 15;
      ctx.fillStyle = rgbaFromHex(this.color, 0.3);
      ctx.beginPath();
      ctx.ellipse(0, 0, sz, sz * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // eye
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(sz * 0.5, -sz * 0.15, sz * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    ctx.arc(sz * 0.55, -sz * 0.15, sz * 0.06, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ===== ENTITY: FROG =====
class Frog {
  constructor(x, y) {
    this.type = 'frog';
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.size = 14 + Math.random() * 6;
    this.growthScale = 1;
    this.state = 'sitting';
    this.timer = 60 + Math.random() * 120;
    this.hopFrom = { x, y };
    this.hopTo = { x, y };
    this.hopProgress = 0;
    this.life = 1;
    this.decay = 0.000012;
    this.blinkTimer = Math.random() * 200;
    this.tongueState = 'idle'; // idle, extending, attached, retracting
    this.tongueTarget = null;
    this.tongueProgress = 0; // 0-1 for extending, 1-0 for retracting
    this.tongueLockX = 0; // where tongue tip is
    this.tongueLockY = 0;
    this.tongueOriginX = 0;
    this.tongueOriginY = 0;
    this.eatCooldown = 0;
    this.onLily = null;
  }

  update(dt) {
    this.timer -= dt;
    this.blinkTimer -= dt;
    this.eatCooldown -= dt;

    // try to eat dragonfly — scan for prey
    if (this.state === 'sitting' && this.eatCooldown <= 0 && this.tongueState === 'idle') {
      if (Math.random() < 0.015) {
        let nearest = null;
        let nearestDist = 150 * this.growthScale;
        for (const c of creatures) {
          if (c.type === 'dragonfly') {
            const d = dist(this.x, this.y, c.x, c.y);
            if (d < nearestDist) { nearest = c; nearestDist = d; }
          }
        }
        if (nearest) {
          this.tongueTarget = nearest;
          this.tongueState = 'extending';
          this.tongueProgress = 0;
          this.tongueOriginX = this.x;
          this.tongueOriginY = this.y - this.size * 0.2 * this.growthScale;
          this.tongueLockX = nearest.x;
          this.tongueLockY = nearest.y;
        }
      }
    }

    // tongue state machine
    if (this.tongueState === 'extending') {
      this.tongueProgress += 0.15 * dt;
      // update tongue tip position — interpolate from frog mouth to fly
      if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
        this.tongueLockX = this.tongueTarget.x;
        this.tongueLockY = this.tongueTarget.y;
      }
      if (this.tongueProgress >= 1) {
        // tongue reached the fly — attach!
        if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
          this.tongueState = 'retracting';
          this.tongueProgress = 1;
          // freeze the fly
          this.tongueTarget.tongueGrabbed = true;
        } else {
          // fly died/gone — miss
          this.tongueState = 'retracting';
          this.tongueProgress = 1;
        }
      }
    } else if (this.tongueState === 'retracting') {
      this.tongueProgress -= 0.08 * dt;
      // drag the fly with the tongue tip
      if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
        const tipX = this.tongueOriginX + (this.tongueLockX - this.tongueOriginX) * this.tongueProgress;
        const tipY = this.tongueOriginY + (this.tongueLockY - this.tongueOriginY) * this.tongueProgress;
        this.tongueTarget.x = tipX;
        this.tongueTarget.y = tipY;
        this.tongueTarget.vx = 0;
        this.tongueTarget.vy = 0;
      }
      if (this.tongueProgress <= 0) {
        // tongue fully retracted — consume if fly is still there
        if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
          this.tongueTarget.life = 0;
          this.growthScale = Math.min(this.growthScale + 0.3, 3);
          ripples.push(new Ripple(this.x, this.y, { maxRadius: 25 }));
        }
        this.tongueState = 'idle';
        this.tongueTarget = null;
        this.tongueProgress = 0;
        this.eatCooldown = 100;
      }
    }

    // check lily pad proximity for sitting
    if (this.state === 'sitting' && !this.onLily) {
      for (const l of lilies) {
        if (l.life > 0.5 && dist(this.x, this.y, l.x, l.y) < l.size * 0.8) {
          this.onLily = l;
          this.x = l.x;
          this.y = l.y;
          break;
        }
      }
    }
    if (this.onLily && this.onLily.life <= 0.3) this.onLily = null;

    if (this.state === 'sitting' && this.timer <= 0 && this.tongueState === 'idle') {
      const distHop = 80 + Math.random() * 120;
      const ang = Math.random() * Math.PI * 2;
      this.hopFrom = { x: this.x, y: this.y };
      this.hopTo = {
        x: clamp(this.x + Math.cos(ang) * distHop, 40, W - 40),
        y: clamp(this.y + Math.sin(ang) * distHop, 40, H - 40)
      };
      this.state = 'hopping';
      this.hopProgress = 0;
      this.onLily = null;
      ripples.push(new Ripple(this.x, this.y, { maxRadius: 50 }));
    }

    if (this.state === 'hopping') {
      this.hopProgress += 0.04;
      const t = this.hopProgress;
      this.x = this.hopFrom.x + (this.hopTo.x - this.hopFrom.x) * t;
      this.y = this.hopFrom.y + (this.hopTo.y - this.hopFrom.y) * t;
      if (this.hopProgress >= 1) {
        this.x = this.hopTo.x;
        this.y = this.hopTo.y;
        this.state = 'sitting';
        this.timer = 80 + Math.random() * 200;
        ripples.push(new Ripple(this.x, this.y, { maxRadius: 45 }));
      }
    }

    // wave push
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= 0.95;
    this.vy *= 0.95;

    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  draw(ctx) {
    const sz = this.size * this.growthScale;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.globalAlpha = this.life;

    const hopY = this.state === 'hopping' ? -Math.sin(this.hopProgress * Math.PI) * 30 : 0;
    ctx.translate(0, hopY);

    // legs (visible when hopping)
    if (this.state === 'hopping') {
      const legSpread = Math.sin(this.hopProgress * Math.PI) * sz * 0.8;
      ctx.strokeStyle = '#3a6c2a';
      ctx.lineWidth = sz * 0.15;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-sz * 0.3, sz * 0.3);
      ctx.lineTo(-sz * 0.8 - legSpread * 0.3, sz * 0.9);
      ctx.moveTo(sz * 0.3, sz * 0.3);
      ctx.lineTo(sz * 0.8 + legSpread * 0.3, sz * 0.9);
      ctx.stroke();
    } else {
      // tucked legs
      ctx.fillStyle = '#3a6c2a';
      ctx.beginPath();
      ctx.ellipse(-sz * 0.6, sz * 0.4, sz * 0.25, sz * 0.15, 0.3, 0, Math.PI * 2);
      ctx.ellipse(sz * 0.6, sz * 0.4, sz * 0.25, sz * 0.15, -0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // body
    ctx.fillStyle = '#4a7c3a';
    ctx.beginPath();
    ctx.ellipse(0, 0, sz, sz * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();

    // back stripe
    ctx.fillStyle = '#5a8c4a';
    ctx.beginPath();
    ctx.ellipse(0, -sz * 0.2, sz * 0.7, sz * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // tongue
    if (this.tongueState !== 'idle') {
      const tipX = (this.tongueLockX - this.x);
      const tipY = (this.tongueLockY - this.y) - hopY;
      const startX = 0;
      const startY = -sz * 0.2;
      const tx = startX + (tipX - startX) * this.tongueProgress;
      const ty = startY + (tipY - startY) * this.tongueProgress;

      // tongue shaft (slightly curved for organic look)
      ctx.strokeStyle = 'rgba(255, 90, 110, 0.85)';
      ctx.lineWidth = sz * 0.1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // tongue tip (sticky ball)
      ctx.fillStyle = 'rgba(255, 70, 90, 0.95)';
      ctx.beginPath();
      ctx.arc(tx, ty, sz * 0.12, 0, Math.PI * 2);
      ctx.fill();
      // highlight on tip
      ctx.fillStyle = 'rgba(255, 180, 190, 0.6)';
      ctx.beginPath();
      ctx.arc(tx - sz * 0.04, ty - sz * 0.04, sz * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }

    // eyes
    const blinking = this.blinkTimer < 8 && this.blinkTimer > 0;
    ctx.fillStyle = '#4a7c3a';
    ctx.beginPath();
    ctx.arc(-sz * 0.4, -sz * 0.5, sz * 0.3, 0, Math.PI * 2);
    ctx.arc(sz * 0.4, -sz * 0.5, sz * 0.3, 0, Math.PI * 2);
    ctx.fill();

    if (!blinking) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(-sz * 0.4, -sz * 0.55, sz * 0.18, 0, Math.PI * 2);
      ctx.arc(sz * 0.4, -sz * 0.55, sz * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.beginPath();
      ctx.arc(-sz * 0.4, -sz * 0.55, sz * 0.08, 0, Math.PI * 2);
      ctx.arc(sz * 0.4, -sz * 0.55, sz * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.blinkTimer < 0) this.blinkTimer = 100 + Math.random() * 300;

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ===== ENTITY: DRAGONFLY (FLY) =====
class Dragonfly {
  constructor(x, y) {
    this.type = 'dragonfly';
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.size = 10 + Math.random() * 4;
    this.state = 'darting';
    this.timer = 20 + Math.random() * 40;
    this.wingPhase = 0;
    this.life = 1;
    this.decay = 0.00002;
    this.color = ['#00f5d4', '#9b5de5', '#ffe66d'][Math.floor(Math.random() * 3)];
  }

  update(dt) {
    this.wingPhase += 0.6;

    // if grabbed by frog tongue, don't move — frog controls position
    if (this.tongueGrabbed) {
      this.wingPhase += 0.6; // faster wing buzz (panic)
      this.life -= 0.001 * dt;
      if (isOffScreen(this.x, this.y)) return false;
      return this.life > 0;
    }

    this.timer -= dt;

    if (this.state === 'darting') {
      this.speed = 4;
      if (this.timer <= 0) {
        this.state = 'pausing';
        this.timer = 20 + Math.random() * 40;
        this.speed = 0;
      }
    } else {
      this.speed *= 0.8;
      if (this.timer <= 0) {
        this.state = 'darting';
        this.timer = 30 + Math.random() * 50;
        this.angle = Math.random() * Math.PI * 2;
      }
    }

    this.x += Math.cos(this.angle) * this.speed + this.vx;
    this.y += Math.sin(this.angle) * this.speed + this.vy;
    this.vx *= 0.95;
    this.vy *= 0.95;

    // bounce off edges
    const margin = 30;
    if (this.x < margin) { this.x = margin; this.angle = Math.PI - this.angle; }
    if (this.x > W - margin) { this.x = W - margin; this.angle = Math.PI - this.angle; }
    if (this.y < margin) { this.y = margin; this.angle = -this.angle; }
    if (this.y > H - margin) { this.y = H - margin; this.angle = -this.angle; }

    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.globalAlpha = this.life;

    // wings
    const wingY = Math.sin(this.wingPhase) * 4;
    ctx.fillStyle = 'rgba(200, 230, 255, 0.35)';
    ctx.beginPath();
    ctx.ellipse(0, -this.size * 0.6 + wingY * 0.3, this.size * 0.9, this.size * 0.25, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, this.size * 0.6 - wingY * 0.3, this.size * 0.9, this.size * 0.25, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // body
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, this.size, this.size * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    // head
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.size * 0.8, 0, this.size * 0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ===== ENTITY: LILY PAD =====
class LilyPad {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.size = 0;
    this.maxSize = 20 + Math.random() * 25;
    this.growth = 0.3;
    this.rotation = Math.random() * Math.PI * 2;
    this.life = 1;
    this.decay = 0.000008;
    this.flower = Math.random() > 0.6;
    this.placedAt = Date.now();
    this.sinking = false;
  }

  update() {
    if (this.sinking) {
      this.life -= 0.04;
      return this.life > 0;
    }
    if (this.size < this.maxSize) this.size += this.growth;
    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    ctx.globalAlpha = this.life;

    const s = Math.max(0.1, this.size);

    // pad
    ctx.fillStyle = '#2d6a4f';
    ctx.beginPath();
    ctx.arc(0, 0, s, 0.3, Math.PI * 2 - 0.3);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();

    // highlight
    ctx.fillStyle = '#40916c';
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.7, 0.3, Math.PI * 2 - 0.3);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();

    // flower
    if (this.flower && this.size > this.maxSize * 0.8) {
      ctx.fillStyle = 'rgba(255, 200, 220, 0.85)';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3, s * 0.2, s * 0.1, a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255, 230, 180, 0.9)';
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ===== ENTITY: BIRD =====
class Bird {
  constructor(targetFrog) {
    this.target = targetFrog;
    // pick entry edge perpendicular to target position
    const side = Math.random() < 0.5 ? 'left' : 'right';
    this.x = side === 'left' ? -60 : W + 60;
    this.y = -40 + Math.random() * H * 0.3;
    this.vx = 0;
    this.vy = 0;
    this.state = 'diving'; // diving, grabbing, escaping
    this.wingPhase = Math.random() * Math.PI * 2;
    this.size = 18 + Math.random() * 8;
    this.angle = 0;
    this.grabbedFrog = false;
    this.life = 1;
    this.exitTimer = 0;
    this.color = ['#2a2a2a', '#3a2a1a', '#1a1a2a'][Math.floor(Math.random() * 3)];
  }

  update(dt) {
    this.wingPhase += 0.4 * dt;

    if (this.state === 'diving') {
      // steer toward target frog
      if (this.target && creatures.includes(this.target) && this.target.life > 0) {
        const dx = this.target.x - this.x;
        const dy = this.target.y - this.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const speed = 6;
        this.vx = (dx / d) * speed;
        this.vy = (dy / d) * speed;
        this.angle = Math.atan2(this.vy, this.vx);

        if (d < this.size * 0.8) {
          // grab the frog!
          this.state = 'escaping';
          this.grabbedFrog = true;
          this.target.life = 0;
          this.exitTimer = 0;
          ripples.push(new Ripple(this.target.x, this.target.y, { maxRadius: 60 }));
        }
      } else {
        // target gone — fly across and leave
        this.state = 'escaping';
        this.exitTimer = 0;
      }
    } else if (this.state === 'escaping') {
      // fly upward and away
      this.exitTimer += dt;
      const escapeAngle = -Math.PI / 4 - Math.random() * 0.3; // up and to the left/right
      const dir = this.x < W / 2 ? -1 : 1;
      this.vx = dir * 5 + Math.cos(escapeAngle) * 2;
      this.vy = -4 - this.exitTimer * 0.1;
      this.angle = Math.atan2(this.vy, this.vx);
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // remove when well off-screen
    if (this.state === 'escaping' && (this.y < -100 || this.x < -120 || this.x > W + 120)) {
      return false;
    }
    return true;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.globalAlpha = this.life;

    const sz = this.size;
    const wingY = Math.sin(this.wingPhase) * sz * 0.6;

    // shadow on water below (depth illusion)
    if (this.state === 'diving' && this.y < H - 20) {
      ctx.save();
      ctx.rotate(-this.angle);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.beginPath();
      ctx.ellipse(0, 30, sz * 0.8, sz * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // tail
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(-sz * 0.6, 0);
    ctx.lineTo(-sz * 1.2, sz * 0.15);
    ctx.lineTo(-sz * 1.2, -sz * 0.15);
    ctx.closePath();
    ctx.fill();

    // wings (animated flapping)
    ctx.fillStyle = this.color;
    // left wing
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-sz * 0.3, -sz * 0.8 + wingY, -sz * 0.1, -sz * 0.4 + wingY * 0.5);
    ctx.quadraticCurveTo(sz * 0.2, -sz * 0.2, 0, 0);
    ctx.fill();
    // right wing
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-sz * 0.3, sz * 0.8 - wingY, -sz * 0.1, sz * 0.4 - wingY * 0.5);
    ctx.quadraticCurveTo(sz * 0.2, sz * 0.2, 0, 0);
    ctx.fill();

    // body
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, sz * 0.6, sz * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();

    // head
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(sz * 0.5, 0, sz * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // beak
    ctx.fillStyle = '#e8a020';
    ctx.beginPath();
    ctx.moveTo(sz * 0.65, 0);
    ctx.lineTo(sz * 0.85, sz * 0.04);
    ctx.lineTo(sz * 0.65, sz * 0.08);
    ctx.closePath();
    ctx.fill();

    // eye
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(sz * 0.55, -sz * 0.05, sz * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    ctx.arc(sz * 0.57, -sz * 0.05, sz * 0.03, 0, Math.PI * 2);
    ctx.fill();

    // talons if grabbing
    if (this.grabbedFrog) {
      ctx.strokeStyle = '#e8a020';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-sz * 0.1, sz * 0.2);
      ctx.lineTo(-sz * 0.1, sz * 0.5);
      ctx.moveTo(sz * 0.1, sz * 0.2);
      ctx.lineTo(sz * 0.1, sz * 0.5);
      ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ===== ENTITY MANAGERS =====
let waves = [];
let ripples = [];
let foamParticles = [];
let creatures = [];
let lilies = [];
let birds = [];

function addWave(x, y, opts) {
  if (waves.length >= MAX_WAVES) waves.shift();
  waves.push(new Wave(x, y, opts));
  ripples.push(new Ripple(x, y, { maxRadius: 40 }));
}

function addRipple(x, y, opts) {
  if (ripples.length >= MAX_RIPPLES) ripples.shift();
  ripples.push(new Ripple(x, y, opts));
}

function addCreature(type, x, y, extra) {
  if (creatures.length >= MAX_CREATURES) creatures.shift();
  let c;
  switch (type) {
    case 'fish': c = new Fish(x, y, extra && extra.tier); break;
    case 'frog': c = new Frog(x, y); break;
    case 'dragonfly': c = new Dragonfly(x, y); break;
    default: return;
  }
  creatures.push(c);
  ripples.push(new Ripple(x, y, { maxRadius: 50 }));
}

let lastLilyPlace = { x: -999, y: -999, time: 0 };

function addLily(x, y) {
  const now = Date.now();
  // check placement cooldown
  if (dist(x, y, lastLilyPlace.x, lastLilyPlace.y) < 40 && now - lastLilyPlace.time < LILY_PLACE_COOLDOWN) {
    return false;
  }
  // replace overlapping lily pads
  for (const l of lilies) {
    if (l.life > 0.3 && !l.sinking && dist(x, y, l.x, l.y) < l.size) {
      l.sinking = true;
    }
  }
  if (lilies.length >= MAX_LILIES) {
    // sink oldest
    lilies[0].sinking = true;
  }
  lilies.push(new LilyPad(x, y));
  ripples.push(new Ripple(x, y, { maxRadius: 35 }));
  lastLilyPlace = { x, y, time: now };
  return true;
}

// ===== WATER RENDERER =====
let causticTime = 0;
let surfaceNoise = [];

// pre-generate surface noise points
for (let i = 0; i < 80; i++) {
  surfaceNoise.push({
    x: Math.random(),
    y: Math.random(),
    phase: Math.random() * Math.PI * 2,
    speed: 0.3 + Math.random() * 1.2,
    size: 0.8 + Math.random() * 2.5,
    brightness: 0.5 + Math.random() * 0.5
  });
}

// pre-generate caustic grid points for interference pattern
let causticGrid = [];
const CAUSTIC_GRID_SIZE = 28;
for (let i = 0; i < CAUSTIC_GRID_SIZE; i++) {
  for (let j = 0; j < CAUSTIC_GRID_SIZE; j++) {
    causticGrid.push({
      gx: i / CAUSTIC_GRID_SIZE,
      gy: j / CAUSTIC_GRID_SIZE,
      phase: Math.random() * Math.PI * 2,
      freq: 0.8 + Math.random() * 0.6
    });
  }
}

function drawWater() {
  causticTime += 0.004;

  // === BASE: vertical depth gradient (shallower at top, deeper at bottom) ===
  const depthGrad = ctx.createLinearGradient(0, 0, 0, H);
  depthGrad.addColorStop(0, '#0e3055');
  depthGrad.addColorStop(0.3, '#0a2342');
  depthGrad.addColorStop(0.6, '#081c36');
  depthGrad.addColorStop(1, '#04101f');
  ctx.fillStyle = depthGrad;
  ctx.fillRect(0, 0, W, H);

  // === SUBSURFACE GLOW (light penetrating from above) ===
  const subGrad = ctx.createRadialGradient(W * 0.5, -H * 0.2, 0, W * 0.5, H * 0.3, Math.max(W, H) * 0.6);
  subGrad.addColorStop(0, 'rgba(40, 100, 160, 0.12)');
  subGrad.addColorStop(0.5, 'rgba(20, 60, 110, 0.06)');
  subGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = subGrad;
  ctx.fillRect(0, 0, W, H);

  // === CAUSTIC INTERFERENCE PATTERN (overlapping sine waves create light patterns) ===
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const cellW = W / CAUSTIC_GRID_SIZE;
  const cellH = H / CAUSTIC_GRID_SIZE;
  for (const c of causticGrid) {
    const wave1 = Math.sin(causticTime * c.freq + c.phase);
    const wave2 = Math.sin(causticTime * c.freq * 1.3 + c.phase * 2);
    const interference = (wave1 + wave2) * 0.5;
    const intensity = Math.max(0, interference) * 0.06;
    if (intensity < 0.005) continue;
    const cx = c.gx * W + Math.sin(causticTime * 0.5 + c.phase) * cellW * 0.3;
    const cy = c.gy * H + Math.cos(causticTime * 0.4 + c.phase) * cellH * 0.3;
    const r = Math.max(0.1, cellW * 0.8);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(90, 170, 230, ${intensity})`);
    g.addColorStop(1, 'rgba(90, 170, 230, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();

  // === SURFACE RIPPLE TEXTURE (fine moving highlights on water surface) ===
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const n of surfaceNoise) {
    const nx = (n.x + Math.sin(causticTime * n.speed + n.phase) * 0.015) * W;
    const ny = (n.y + Math.cos(causticTime * n.speed * 0.7 + n.phase) * 0.015) * H;
    const a = (0.03 + Math.sin(causticTime * 2.5 + n.phase) * 0.025) * n.brightness;
    if (a <= 0) continue;
    ctx.fillStyle = `rgba(160, 210, 245, ${a})`;
    ctx.beginPath();
    ctx.arc(nx, ny, n.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // === SPECULAR SHIMMER (bright moving highlights — sunlight on water) ===
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 5; i++) {
    const offset = i * 1.3;
    const sx = W * (0.2 + 0.6 * (0.5 + Math.sin(causticTime * 0.3 + offset) * 0.5));
    const sy = H * (0.15 + 0.3 * (0.5 + Math.cos(causticTime * 0.25 + offset * 1.5) * 0.5));
    const sr = Math.max(0.1, 60 + Math.sin(causticTime * 1.5 + i) * 30);
    const sa = 0.04 + Math.sin(causticTime * 2 + offset) * 0.02;
    if (sa <= 0) continue;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    g.addColorStop(0, `rgba(200, 230, 255, ${sa})`);
    g.addColorStop(0.5, `rgba(150, 200, 240, ${sa * 0.3})`);
    g.addColorStop(1, 'rgba(150, 200, 240, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
  }
  ctx.restore();

  // === WAVE POOL TINT ===
  if (wavePoolActive) {
    ctx.fillStyle = 'rgba(60, 15, 15, 0.1)';
    ctx.fillRect(0, 0, W, H);
  }

  // === DEPTH VIGNETTE (darker edges = deeper water perception) ===
  const vg = ctx.createRadialGradient(W / 2, H * 0.4, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.7, 'rgba(0,0,0,0.15)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

// ===== WAVE COOLDOWN SYSTEM =====
let waveReady = true;
let waveCooldownStart = 0;
const cooldownBar = document.getElementById('cooldown-bar');
const cooldownFill = document.getElementById('cooldown-fill');

function updateCooldown() {
  if (waveReady) {
    cooldownBar.classList.remove('visible');
    cooldownFill.classList.add('ready');
    cooldownFill.style.width = '100%';
    return;
  }
  const elapsed = Date.now() - waveCooldownStart;
  const total = WAVE_COOLDOWN + WAVE_COOLUP;
  const pct = Math.min(elapsed / total, 1);
  cooldownBar.classList.add('visible');
  cooldownFill.classList.remove('ready');
  cooldownFill.style.width = (pct * 100) + '%';
  if (pct >= 1) {
    waveReady = true;
    cooldownBar.classList.remove('visible');
    cooldownFill.classList.add('ready');
  }
}

function triggerWaveCooldown() {
  waveReady = false;
  waveCooldownStart = Date.now();
}

// ===== INPUT HANDLING =====
let currentTool = 'wave';
let isDragging = false;
let lastDragX = 0, lastDragY = 0;

function getPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return { x: t.clientX - rect.left, y: t.clientY - rect.top };
}

let hasInteracted = false;
function handlePointerDown(e) {
  e.preventDefault();
  const p = getPointerPos(e);
  isDragging = true;
  lastDragX = p.x;
  lastDragY = p.y;
  doAction(p.x, p.y);
  if (!hasInteracted) {
    hasInteracted = true;
    const hint = document.getElementById('hint');
    if (hint) hint.style.opacity = '0';
  }
}

function handlePointerMove(e) {
  if (!isDragging) return;
  e.preventDefault();
  const p = getPointerPos(e);
  lastDragX = p.x;
  lastDragY = p.y;
}

function handlePointerUp(e) {
  isDragging = false;
}

function doAction(x, y) {
  switch (currentTool) {
    case 'wave':
      if (waveReady) {
        const splashAngle = Math.random() * Math.PI * 2;
        addWave(x, y, { splashAngle });
        triggerWaveCooldown();
        sendAction({ type: 'wave', x: normX(x), y: normY(y), splashAngle });
      }
      break;
    case 'fish':
      addCreature('fish', x, y);
      sendAction({ type: 'creature', creatureType: 'fish', x: normX(x), y: normY(y) });
      break;
    case 'frog':
      addCreature('frog', x, y);
      sendAction({ type: 'creature', creatureType: 'frog', x: normX(x), y: normY(y) });
      break;
    case 'dragonfly':
      addCreature('dragonfly', x, y);
      sendAction({ type: 'creature', creatureType: 'dragonfly', x: normX(x), y: normY(y) });
      break;
    case 'lily':
      if (addLily(x, y)) {
        sendAction({ type: 'lily', x: normX(x), y: normY(y) });
      }
      break;
  }
}

canvas.addEventListener('mousedown', handlePointerDown);
canvas.addEventListener('mousemove', handlePointerMove);
canvas.addEventListener('mouseup', handlePointerUp);
canvas.addEventListener('mouseleave', handlePointerUp);
canvas.addEventListener('touchstart', handlePointerDown, { passive: false });
canvas.addEventListener('touchmove', handlePointerMove, { passive: false });
canvas.addEventListener('touchend', handlePointerUp);

function normX(x) { return x / W; }
function normY(y) { return y / H; }
function denormX(x) { return x * W; }
function denormY(y) { return y * H; }

// ===== TOOLBAR =====
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTool = btn.dataset.tool;
    updateToolButtons();
  });
});

function updateToolButtons() {
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === currentTool);
  });
}
updateToolButtons();

// ===== EVENT SYSTEM =====
const eventBanner = document.getElementById('event-banner');
let currentEvent = null;
let eventTimer = 0;
let nextEventTime = Date.now() + 30000 + Math.random() * 30000;

const EVENT_TYPES = [
  { id: 'catch_flies', text: 'A swarm of flies appears!', spawn: () => {
    for (let i = 0; i < 8; i++) addCreature('dragonfly', Math.random() * W, Math.random() * H);
  }},
  { id: 'big_fish', text: 'A legendary fish surfaces...', spawn: () => {
    addCreature('fish', Math.random() * W, Math.random() * H, { tier: 3 });
  }},
  { id: 'frog_party', text: 'Frogs are gathering!', spawn: () => {
    for (let i = 0; i < 4; i++) addCreature('frog', Math.random() * W, Math.random() * H);
  }},
  { id: 'lily_bloom', text: 'Lily pads are blooming!', spawn: () => {
    for (let i = 0; i < 5; i++) addLily(Math.random() * W, Math.random() * H);
  }},
  { id: 'bird_strike', text: 'BIRDS INCOMING — frogs beware!', spawn: () => {
    spawnBirdBarrage();
  }},
];

function updateEvents() {
  if (currentEvent) {
    eventTimer -= 1;
    if (eventTimer <= 0) {
      // event ends
      currentEvent = null;
      eventBanner.classList.remove('visible');
      nextEventTime = Date.now() + 30000 + Math.random() * 30000;
    } else {
      // update banner text with timer
      const seconds = Math.ceil(eventTimer / 60);
      eventBanner.innerHTML = `${currentEvent.text} <span class="event-timer">${seconds}s</span>`;
    }
  } else if (Date.now() > nextEventTime) {
    // start new event
    const evt = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
    currentEvent = evt;
    eventTimer = 600; // ~10 seconds at 60fps
    evt.spawn();
    eventBanner.innerHTML = `${evt.text} <span class="event-timer">10s</span>`;
    eventBanner.classList.add('visible');
    sendAction({ type: 'event', eventId: evt.id });
  }
}

// ===== BIRD BARRAGE SYSTEM =====
function spawnBirdBarrage() {
  // find all frogs
  const frogs = creatures.filter(c => c.type === 'frog' && c.life > 0.3);
  if (frogs.length === 0) return;

  // shuffle frogs so we don't always target the same ones
  const shuffled = frogs.sort(() => Math.random() - 0.5);
  const birdCount = Math.min(frogs.length, 2 + Math.floor(Math.random() * 4)); // 2-5 birds
  for (let i = 0; i < birdCount; i++) {
    if (birds.length >= MAX_BIRDS) break;
    // stagger entry slightly
    setTimeout(() => {
      if (birds.length < MAX_BIRDS) {
        birds.push(new Bird(shuffled[i]));
      }
    }, i * 200);
  }
}

function maybeSpawnRandomBirds() {
  // random bird strike: ~0.5% chance per second when there are frogs
  // triggered outside the event system for spontaneity
  const frogs = creatures.filter(c => c.type === 'frog' && c.life > 0.3);
  if (frogs.length < 2) return; // need at least 2 frogs to warrant a strike
  if (Math.random() < 0.008) {
    spawnBirdBarrage();
    sendAction({ type: 'birds' });
  }
}

// ===== RED BUTTON + WAVE POOL =====
let redButtonEl = null;
let wavePoolActive = false;
let wavePoolTimer = 0;
const wavePoolBanner = document.getElementById('wave-pool-banner');

function updateRedButton() {
  // 0.01% chance per second ≈ 0.000167 per frame at 60fps
  if (!redButtonEl && !wavePoolActive && Math.random() < 0.000167) {
    spawnRedButton();
  }

  // wave pool active
  if (wavePoolActive) {
    wavePoolTimer -= 1;
    // auto-spawn waves from edges
    if (Math.random() < 0.15) {
      const edge = Math.floor(Math.random() * 4);
      let wx, wy, angle;
      switch (edge) {
        case 0: wx = 0; wy = Math.random() * H; angle = 0; break;
        case 1: wx = W; wy = Math.random() * H; angle = Math.PI; break;
        case 2: wx = Math.random() * W; wy = 0; angle = Math.PI / 2; break;
        case 3: wx = Math.random() * W; wy = H; angle = -Math.PI / 2; break;
      }
      addWave(wx, wy, { splashAngle: angle, maxRadius: 300, force: 12, speed: 4 });
    }
    if (wavePoolTimer <= 0) {
      wavePoolActive = false;
      wavePoolBanner.classList.remove('visible');
    }
  }
}

function spawnRedButton() {
  redButtonEl = document.createElement('div');
  redButtonEl.id = 'red-button';
  const margin = 80;
  redButtonEl.style.left = (margin + Math.random() * (W - margin * 2 - 48)) + 'px';
  redButtonEl.style.top = (margin + Math.random() * (H - margin * 2 - 48)) + 'px';
  redButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    activateWavePool();
    if (redButtonEl) { redButtonEl.remove(); redButtonEl = null; }
    sendAction({ type: 'wavepool' });
  });
  document.body.appendChild(redButtonEl);

  // auto-remove after 15 seconds if not clicked
  setTimeout(() => {
    if (redButtonEl) { redButtonEl.remove(); redButtonEl = null; }
  }, 15000);
}

function activateWavePool() {
  wavePoolActive = true;
  wavePoolTimer = 600; // 10 seconds at 60fps
  wavePoolBanner.classList.add('visible');
}

// ===== WEBSOCKET CLIENT =====
let ws = null;
let wsConnected = false;
let reconnectTimer = null;
const onlineCountEl = document.getElementById('online-count');

function connectWS() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    onlineCountEl.textContent = 'connected';
    console.log('[POND] WebSocket connected to', WS_URL);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log('[POND] Received:', msg.type, msg.action ? msg.action.type : '');
      handleMessage(msg);
    } catch (e) {
      console.error('[POND] Parse error:', e);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    onlineCountEl.textContent = 'offline — solo mode';
    console.log('[POND] WebSocket closed, reconnecting...');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[POND] WebSocket error:', err);
    if (ws) ws.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 3000);
}

function sendAction(action) {
  if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
    console.log('[POND] Sending action:', action.type);
    ws.send(JSON.stringify(action));
  } else {
    console.log('[POND] Cannot send — WS not connected');
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      applySnapshot(msg.state);
      break;
    case 'action':
      applyRemoteAction(msg.action);
      break;
    case 'presence':
      onlineCountEl.textContent = `${msg.count} ${msg.count === 1 ? 'person' : 'people'} in the pond`;
      break;
  }
}

function applySnapshot(state) {
  if (state.creatures) {
    state.creatures.forEach(c => {
      addCreature(c.type, denormX(c.x), denormY(c.y), c.tier !== undefined ? { tier: c.tier } : undefined);
    });
  }
  if (state.lilies) {
    state.lilies.forEach(l => {
      addLily(denormX(l.x), denormY(l.y));
    });
  }
}

function applyRemoteAction(action) {
  const x = action.x !== undefined ? denormX(action.x) : 0;
  const y = action.y !== undefined ? denormY(action.y) : 0;
  switch (action.type) {
    case 'wave':
      addWave(x, y, { splashAngle: action.splashAngle });
      break;
    case 'creature':
      addCreature(action.creatureType, x, y);
      break;
    case 'lily':
      addLily(x, y);
      break;
    case 'event':
      const evt = EVENT_TYPES.find(e => e.id === action.eventId);
      if (evt) {
        currentEvent = evt;
        eventTimer = 600;
        evt.spawn();
        eventBanner.innerHTML = `${evt.text} <span class="event-timer">10s</span>`;
        eventBanner.classList.add('visible');
      }
      break;
    case 'wavepool':
      activateWavePool();
      break;
    case 'birds':
      spawnBirdBarrage();
      break;
  }
}

// ===== MAIN LOOP =====
let lastTime = performance.now();
let frameCount = 0;

function loop(now) {
  const dt = Math.min((now - lastTime) / 16.67, 3);
  lastTime = now;
  frameCount++;

  drawWater();

  // lily pads (bottom layer)
  lilies = lilies.filter(l => {
    const alive = l.update();
    if (alive) l.draw(ctx);
    return alive;
  });

  // ripples (under waves)
  ripples = ripples.filter(r => {
    const alive = r.update();
    if (alive) r.draw(ctx);
    return alive;
  });

  // waves (middle layer)
  waves = waves.filter(w => {
    const alive = w.update(dt);
    if (alive) w.draw(ctx);
    return alive;
  });

  // foam particles
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  foamParticles = foamParticles.filter(f => {
    const alive = f.update(dt);
    if (alive) f.draw(ctx);
    return alive;
  });
  ctx.restore();

  // creatures (top layer)
  creatures = creatures.filter(c => {
    const alive = c.update(dt);
    if (alive) c.draw(ctx);
    return alive;
  });

  // birds (above everything — they fly over the pond)
  birds = birds.filter(b => {
    const alive = b.update(dt);
    if (alive) b.draw(ctx);
    return alive;
  });

  // system updates (every few frames to save perf)
  if (frameCount % 2 === 0) updateCooldown();
  if (frameCount % 4 === 0) updateEvents();
  if (frameCount % 4 === 0) updateRedButton();
  if (frameCount % 60 === 0) maybeSpawnRandomBirds();

  requestAnimationFrame(loop);
}

// ===== INIT =====
connectWS();

// seed initial life
setTimeout(() => {
  if (creatures.length === 0 && lilies.length === 0) {
    addLily(W * 0.25, H * 0.65);
    addLily(W * 0.72, H * 0.38);
    addLily(W * 0.5, H * 0.75);
    addCreature('fish', W * 0.5, H * 0.5);
    addCreature('fish', W * 0.4, H * 0.6);
    addCreature('fish', W * 0.65, H * 0.55);
    addCreature('fish', W * 0.3, H * 0.4, { tier: 1 });
    addCreature('dragonfly', W * 0.6, H * 0.3);
    addCreature('dragonfly', W * 0.7, H * 0.25);
    addCreature('frog', W * 0.3, H * 0.7);
  }
}, 1500);

requestAnimationFrame(loop);
