/* ===================================================================
   eternal pond — 3D engine (pond3d.js)
   Three.js r128. All game logic ported from the 2D pond.js:
   AI, eating, events, WebSocket protocol, player fish, red button,
   wave pool. Canvas-2D rendering is replaced by Three.js meshes.
   GLB models are loaded if present in ../assets/, otherwise the
   engine falls back to high-quality procedural meshes.
=================================================================== */

// ===== CONFIG =====
const WS_URL = 'wss://shared-pond.maxpug17.workers.dev/ws';
const WS_URL_FALLBACK = 'wss://ws.eternalpond.com/ws';

const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
const LOW_QUALITY = IS_MOBILE;

// Entity caps — identical tuning to the 2D pond
const MAX_CREATURES = 80;
const MAX_RIPPLES = 120;
const MAX_LILIES = 40;
const MAX_WAVES = 30;
const MAX_BIRDS = LOW_QUALITY ? 18 : 36;
const WAVE_COOLDOWN = 1500;
const WAVE_COOLUP = 500;
const LILY_PLACE_COOLDOWN = 2000;
const OFFSCREEN_MARGIN = 80;

// ===== LOGICAL GAME SPACE =====
// All AI runs in this fixed 2D space (matches pond.js tuning: edge
// margins of ~60, eat ranges 80-160, fish sizes 8-55). Rendering maps
// game space -> 3D world by SCALE. Network coords are normalised to
// [0,1] so 2D and 3D clients share the exact same pond.
const W = 1000;
const H = 1000;
const SCALE = 0.12;            // world units per game unit
const POND_WORLD = W * SCALE;  // 120 world units across
const HALF = POND_WORLD / 2;   // 60
const R_WATER = HALF * 2.19;   // ~131 — pond water disc radius (tucks under the bank)

// ===== TERRAIN PROFILE =====
// One continuous bowl: a deep ~flat play basin, a smooth shore that rises
// through the waterline (y=0), then a forest-floor plateau. The water disc
// sits at y=0, so the shoreline is simply where the terrain crosses 0 and
// the water rim tucks under the rising land — a seamless, graceful shore.
const POND_DEPTH = 12;                 // bowl depth at the centre (below water)
const BANK_RISE = 7.5;                 // forest-floor plateau height above water
const R_PLAY = 90;                     // deep, ~flat zone (covers fish corner r≈85)
const R_SHORE = R_WATER * 0.95;        // ~100 — terrain meets the waterline here
function terrainHeight(r) {
  if (r <= R_PLAY) {
    const t = r / R_PLAY;
    return -POND_DEPTH + t * t * 2.5;            // gentle dished bottom (-12 .. -9.5)
  }
  if (r <= R_SHORE) {
    const t = (r - R_PLAY) / (R_SHORE - R_PLAY); // 0..1
    const s = t * t * (3 - 2 * t);               // smoothstep
    return (-POND_DEPTH + 2.5) * (1 - s);        // -9.5 .. 0 (shore wall)
  }
  const t = clamp((r - R_SHORE) / (R_WATER * 1.25), 0, 1);
  return BANK_RISE * (t * t * (3 - 2 * t));       // 0 .. +7.5 (land rising out)
}

// Interactive water ripple buffer size (fed to the water shader)
const MAX_WATER_RIPPLES = LOW_QUALITY ? 6 : 14;

// ===== UTILITY =====
function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isOffScreen(x, y, margin) {
  margin = margin || OFFSCREEN_MARGIN;
  return x < -margin || x > W + margin || y < -margin || y > H + margin;
}
function normX(x) { return x / W; }
function normY(y) { return y / H; }
function denormX(x) { return x * W; }
function denormY(y) { return y * H; }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

// game (x,y) + world height -> THREE world position
function toWorldX(x) { return (x - W / 2) * SCALE; }
function toWorldZ(y) { return (y - H / 2) * SCALE; }

// ===== THREE.JS CORE =====
const canvas = document.getElementById('pond3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW_QUALITY, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW_QUALITY ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
const FOG_COLOR = 0x0a0a18;
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0018);
scene.background = new THREE.Color(0x050510);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6000);
camera.position.set(0, 96, 142);
camera.lookAt(0, 0, 0);

// ===== ORBIT CONTROLS =====
// Camera is locked to a circular perimeter around the pond — it can orbit,
// zoom (clamped), and pan freely but the target is constrained to a disc
// so you can never lose the pond.
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = true;
controls.panSpeed = 0.8;
controls.minDistance = 40;
controls.maxDistance = 320;
controls.minPolarAngle = 0.18;
controls.maxPolarAngle = 1.46; // stop just above the horizon — never go underwater
controls.autoRotate = true;
controls.autoRotateSpeed = 0.28;
controls.rotateSpeed = 0.65;
if (controls.touches) controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

// Constrain pan target to a flat circular disc inside the dome — no vertical pan,
// and keep the camera position inside the dome sphere.
const PAN_RADIUS = R_WATER * 1.2;
const DOME_R = R_WATER * 2.4;
const _panV = new THREE.Vector3();
controls.addEventListener('change', () => {
  // lock target Y to 0 — no vertical panning
  controls.target.y = 0;
  // clamp target to horizontal disc
  const d = Math.hypot(controls.target.x, controls.target.z);
  if (d > PAN_RADIUS) {
    const ang = Math.atan2(controls.target.z, controls.target.x);
    controls.target.x = Math.cos(ang) * PAN_RADIUS;
    controls.target.z = Math.sin(ang) * PAN_RADIUS;
  }
  // clamp camera position inside the dome sphere
  const camD = Math.hypot(camera.position.x, camera.position.y, camera.position.z);
  if (camD > DOME_R * 0.92) {
    const s = DOME_R * 0.92 / camD;
    camera.position.x *= s;
    camera.position.y *= s;
    camera.position.z *= s;
  }
});

// Auto-rotate resumes only after a period of no interaction.
// NOTE: only bump on genuine user input — NOT on 'change', which fires
// every frame while auto-rotate drives the camera.
let lastInteract = performance.now();
function bumpInteract() { lastInteract = performance.now(); controls.autoRotate = false; }
controls.addEventListener('start', bumpInteract);
canvas.addEventListener('pointerdown', bumpInteract);
canvas.addEventListener('wheel', bumpInteract, { passive: true });

// ===== LIGHTING ===== (tuned for space dome interior)
const sun = new THREE.DirectionalLight(0xfff1d6, 1.1);
sun.position.set(58, 130, 46);
scene.add(sun);
const sunDir = new THREE.Vector3().copy(sun.position).normalize();

const hemi = new THREE.HemisphereLight(0x88aaff, 0x1a2a3a, 0.55);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x1a3050, 0.5);
scene.add(ambient);

// faint rim/back light for separation
const rim = new THREE.DirectionalLight(0x4fd9ff, 0.4);
rim.position.set(-70, 40, -90);
scene.add(rim);

// ===== SPACE SKYBOX =====
// Deep space with stars, nebula clouds, and a distant planet.
// Procedurally generated in the fragment shader — no textures needed.
(function buildSpaceSky() {
  const skyGeo = new THREE.SphereGeometry(3000, 48, 32);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform float uTime;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                       mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                       mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 dir = normalize(vDir);
        vec3 col = vec3(0.02, 0.02, 0.05);
        // nebula clouds
        float n1 = fbm(dir * 3.0 + vec3(uTime * 0.005, 0.0, 0.0));
        float n2 = fbm(dir * 5.0 + vec3(0.0, uTime * 0.003, 0.0));
        col += vec3(0.15, 0.05, 0.35) * smoothstep(0.45, 0.75, n1) * 0.6;
        col += vec3(0.05, 0.12, 0.30) * smoothstep(0.5, 0.8, n2) * 0.5;
        // distant planet
        vec3 planetPos = normalize(vec3(0.6, 0.3, -0.8));
        float pd = dot(dir, planetPos);
        if (pd > 0.92) {
          float pp = (pd - 0.92) / 0.08;
          vec3 pcol = mix(vec3(0.3, 0.15, 0.1), vec3(0.5, 0.3, 0.15), pp);
          pcol += vec3(0.2, 0.1, 0.05) * smoothstep(0.5, 1.0, pp);
          col = mix(col, pcol, smoothstep(0.0, 0.3, pp) * (1.0 - smoothstep(0.7, 1.0, pp) * 0.5));
        }
        // star field — multi-layer
        for (int layer = 0; layer < 3; layer++) {
          float scale = 80.0 + float(layer) * 60.0;
          vec3 sp = dir * scale;
          vec3 si = floor(sp);
          float h = hash(si);
          if (h > 0.985) {
            vec3 sf = fract(sp);
            float d = length(sf - 0.5);
            float bright = (1.0 - smoothstep(0.0, 0.15, d)) * (h - 0.985) / 0.015;
            float tw = 0.7 + 0.3 * sin(uTime * 2.0 + h * 100.0);
            vec3 starCol = mix(vec3(1.0, 0.95, 0.8), vec3(0.7, 0.8, 1.0), h);
            col += starCol * bright * tw;
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);
  window.__skyShader = skyMat;
})();

// ===== WATER SURFACE =====
// Ambient sine undulation + a ring buffer of interactive ripples that
// expand from clicks, waves, and creature movement (disturbWater()).
const waterRipples = [];           // { wx, wz, t0, strength }
let waterRippleHead = 0;
const waterUniforms = {
  uTime: { value: 0 },
  uShoreR: { value: R_SHORE },
  uRipples: { value: Array.from({ length: MAX_WATER_RIPPLES }, () => new THREE.Vector4(0, 0, -999, 0)) },
  uSunDir: { value: sunDir.clone() },
  uDeep: { value: new THREE.Color(0x0d4258) },
  uShallow: { value: new THREE.Color(0x2a9fb6) },
  uFoam: { value: new THREE.Color(0xcdf2ff) },
  uFog: { value: new THREE.Color(FOG_COLOR) },
  uFogDensity: { value: scene.fog.density },
  uWavePool: { value: 0 },
};

// Circular pond disc (RingGeometry gives plenty of radial rings for the
// vertex-displaced ripples, and a circular edge melts into the forest fog
// instead of showing a hard square boundary).
const waterGeo = new THREE.RingGeometry(0.4, R_WATER, LOW_QUALITY ? 72 : 140, LOW_QUALITY ? 26 : 60);
waterGeo.rotateX(-Math.PI / 2);

const waterMat = new THREE.ShaderMaterial({
  uniforms: waterUniforms,
  transparent: true,
  fog: false,
  toneMapped: false,
  defines: { MAX_RIPPLES: MAX_WATER_RIPPLES },
  vertexShader: `
    uniform float uTime;
    uniform float uShoreR;
    uniform vec4 uRipples[MAX_RIPPLES];
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vCrest;

    float ambient(vec2 p, float t) {
      float h = 0.0;
      h += sin(p.x * 0.060 + t * 1.10) * 0.34;
      h += sin(p.y * 0.052 - t * 0.92) * 0.34;
      h += sin((p.x + p.y) * 0.044 + t * 0.70) * 0.20;
      h += cos(p.x * 0.115 - p.y * 0.093 + t * 1.45) * 0.12;
      return h;
    }
    float ripples(vec2 p, float t) {
      float h = 0.0;
      for (int i = 0; i < MAX_RIPPLES; i++) {
        vec4 r = uRipples[i];
        if (r.w <= 0.001) continue;
        float age = t - r.z;
        if (age < 0.0 || age > 4.5) continue;
        float d = distance(p, r.xy);
        float radius = age * 26.0;
        float band = d - radius;
        float env = exp(-age * 0.9) * exp(-abs(band) * 0.22) * exp(-d * 0.012);
        h += sin(band * 0.9) * env * r.w * 2.6;
      }
      return h;
    }
    float elevation(vec2 p, float t) {
      // flatten the surface toward the shore so waves never poke through the bank
      float edge = 1.0 - smoothstep(uShoreR - 18.0, uShoreR, length(p));
      return (ambient(p, t) + ripples(p, t)) * edge;
    }

    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec2 p = wp.xz;
      float e = elevation(p, uTime);
      wp.y += e;
      // normal via finite differences
      float d = 1.6;
      float ex = elevation(p + vec2(d, 0.0), uTime) - elevation(p - vec2(d, 0.0), uTime);
      float ez = elevation(p + vec2(0.0, d), uTime) - elevation(p - vec2(0.0, d), uTime);
      vNormal = normalize(vec3(-ex, 2.0 * d, -ez));
      vWorld = wp.xyz;
      vCrest = clamp(e * 0.5 + 0.5, 0.0, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    precision highp float;
    uniform vec3 uSunDir; uniform vec3 uDeep; uniform vec3 uShallow;
    uniform vec3 uFoam; uniform vec3 uFog; uniform float uFogDensity;
    uniform float uWavePool; uniform float uShoreR;
    varying vec3 vWorld; varying vec3 vNormal; varying float vCrest;

    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);

      vec3 base = mix(uDeep, uShallow, clamp(vCrest * 0.9 + fres * 0.5, 0.0, 1.0));
      // sun specular
      vec3 Hh = normalize(uSunDir + V);
      float spec = pow(max(dot(N, Hh), 0.0), 90.0);
      // diffuse sky tint
      float diff = max(dot(N, vec3(0.0, 1.0, 0.0)), 0.0);
      vec3 col = base + uShallow * diff * 0.18;
      col += vec3(1.0, 0.97, 0.9) * spec * 1.4;
      col += uFoam * smoothstep(0.78, 1.0, vCrest) * 0.5;     // crest foam
      col = mix(col, vec3(0.45, 0.06, 0.06), uWavePool * 0.28); // wave-pool tint

      // distance fog (manual, since this material has fog disabled)
      float dcam = length(cameraPosition - vWorld);
      float fog = 1.0 - exp(-uFogDensity * uFogDensity * dcam * dcam);
      col = mix(col, uFog, clamp(fog, 0.0, 1.0));

      // clearer water near the surface so the fish below read clearly;
      // and fade transparency to zero at the shore so the waterline melts
      // into the wet-sand band instead of forming a hard edge.
      float shore = smoothstep(uShoreR, uShoreR - 24.0, length(vWorld.xz));
      float alpha = clamp(0.44 + fres * 0.34, 0.0, 0.9) * shore;
      gl_FragColor = vec4(col, alpha);
    }
  `,
});
const water = new THREE.Mesh(waterGeo, waterMat);
water.position.y = 0;
water.renderOrder = 2;
scene.add(water);

// push an interactive ripple into the shader ring buffer (game coords).
// Only notable disturbances (clicks, waves, eats, bird splashes) register a
// ring — per-fish movement is too frequent and would flicker the buffer.
function disturbWater(x, y, strength, radius) {
  if ((strength || 1) < 1.5) return;
  const wx = toWorldX(x), wz = toWorldZ(y);
  const s = clamp((strength || 1) * 0.1, 0.18, 1.4);
  const slot = waterRippleHead % MAX_WATER_RIPPLES;
  waterRippleHead++;
  const v = waterUniforms.uRipples.value[slot];
  v.set(wx, wz, waterUniforms.uTime.value, s);
}

// NOTE: the pond basin + banks are now one continuous terrain bowl built
// in buildEnvironment() (see buildTerrain), so there is no separate flat
// floor — the water genuinely sits in a hole that flows up onto land.

// ===== RESIZE =====
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ===================================================================
// ASSET SYSTEM — load GLB if available, else procedural fallback
// ===================================================================
const ASSETS = {
  fish: '../assets/fish.glb',
  frog: '../assets/frog.glb',
  dragonfly: '../assets/dragonfly.glb',
  lily: '../assets/lily.glb',
  bird: '../assets/bird.glb',
  rocks: '../assets/rocks.glb',
  reeds: '../assets/reeds.glb',
  tree_pine: '../assets/tree_pine.glb',
  tree_birch: '../assets/tree_birch.glb',
  tree_maple: '../assets/tree_maple.glb',
  tree_oak: '../assets/tree_oak.glb',
  tree_autumn: '../assets/tree_autumn.glb',
  grass: '../assets/grass.glb',
  grass_tall: '../assets/grass_tall.glb',
  bush: '../assets/bush.glb',
  bush_flowers: '../assets/bush_flowers.glb',
  flowers: '../assets/flowers.glb',
  bushes: '../assets/bushes.glb',
  flower_bushes: '../assets/flower_bushes.glb',
};
const assetCache = {};
const gltfLoader = (typeof THREE.GLTFLoader === 'function') ? new THREE.GLTFLoader() : null;

function loadAsset(name, url) {
  return new Promise((resolve) => {
    if (!gltfLoader) { resolve(null); return; }
    gltfLoader.load(url, (gltf) => { assetCache[name] = gltf; resolve(gltf); },
      undefined, () => resolve(null)); // missing/failed -> procedural fallback
  });
}

// Clone a cached GLB, normalise to ~2.4 units, return { root, mixer }
function instantiateGLB(name) {
  const gltf = assetCache[name];
  if (!gltf) return null;
  const root = (THREE.SkeletonUtils && gltf.animations.length)
    ? THREE.SkeletonUtils.clone(gltf.scene) : gltf.scene.clone(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3(); box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const k = 2.4 / maxDim;
  const wrap = new THREE.Group();
  root.scale.setScalar(k);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(k);
  root.position.sub(center);
  wrap.add(root);
  let mixer = null;
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(gltf.animations[0]).play();
  }
  return { root: wrap, mixer };
}

// shared low-poly geometries (created lazily)
const GEO = {};
function geo(key, make) { return GEO[key] || (GEO[key] = make()); }

function stdMat(color, opts = {}) {
  return new THREE.MeshStandardMaterial(Object.assign({
    color, roughness: 0.6, metalness: 0.05,
  }, opts));
}

function makeBlobShadow(radius) {
  const m = new THREE.Mesh(
    geo('blob', () => new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
  );
  m.scale.setScalar(radius);
  return m;
}

// ---------- PROCEDURAL FISH ----------
function buildFish(color, tier) {
  const g = new THREE.Group();
  const col = new THREE.Color(color);
  const bodyMat = stdMat(col.getHex(), { roughness: 0.4, metalness: 0.08, emissive: col.clone().multiplyScalar(0.12).getHex() });

  const body = new THREE.Mesh(geo('fishBody', () => new THREE.SphereGeometry(1, 18, 14)), bodyMat);
  body.scale.set(1.3, 0.6, 0.42);
  g.add(body);

  // belly highlight
  const belly = new THREE.Mesh(geo('fishBody', () => new THREE.SphereGeometry(1, 18, 14)),
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, roughness: 0.5 }));
  belly.scale.set(1.18, 0.42, 0.36); belly.position.y = -0.16; g.add(belly);

  // tail (wags)
  const tailPivot = new THREE.Group(); tailPivot.position.x = -1.15;
  const tail = new THREE.Mesh(geo('fishTail', () => new THREE.ConeGeometry(0.62, 1.05, 4)), bodyMat.clone());
  tail.material.opacity = 0.92; tail.material.transparent = true;
  tail.rotation.z = Math.PI / 2; tail.scale.set(1, 1, 0.28); tail.position.x = -0.5;
  tailPivot.add(tail); g.add(tailPivot);

  // dorsal fin
  const dorsal = new THREE.Mesh(geo('fishDorsal', () => new THREE.ConeGeometry(0.34, 0.8, 3)), bodyMat.clone());
  dorsal.position.set(-0.1, 0.5, 0); dorsal.scale.set(1, 1, 0.18); g.add(dorsal);

  // eyes
  const eyeW = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const eyeB = new THREE.MeshStandardMaterial({ color: 0x05080c, roughness: 0.2 });
  for (const s of [-1, 1]) {
    const ew = new THREE.Mesh(geo('fishEyeW', () => new THREE.SphereGeometry(0.16, 10, 8)), eyeW);
    ew.position.set(0.78, 0.12, s * 0.28); g.add(ew);
    const eb = new THREE.Mesh(geo('fishEyeB', () => new THREE.SphereGeometry(0.09, 8, 6)), eyeB);
    eb.position.set(0.88, 0.12, s * 0.30); g.add(eb);
  }

  let glow = null;
  if (tier >= 3) {
    glow = new THREE.PointLight(col.getHex(), 0.9, 14, 2);
    g.add(glow);
    bodyMat.emissive = col.clone().multiplyScalar(0.5);
  }

  g.userData = { tail: tailPivot, body, materials: [bodyMat, tail.material, dorsal.material], glow };
  return g;
}

// ---------- PROCEDURAL FROG ----------
function buildFrog() {
  const g = new THREE.Group();
  const skin = stdMat(0x4a7c3a, { roughness: 0.55 });
  const darker = stdMat(0x2d5a1f, { roughness: 0.6 });

  const body = new THREE.Mesh(geo('frogBody', () => new THREE.SphereGeometry(1, 18, 14)), skin);
  body.scale.set(1.0, 0.78, 1.12); g.add(body);

  // back sheen
  const sheen = new THREE.Mesh(geo('frogBody', () => new THREE.SphereGeometry(1, 18, 14)),
    new THREE.MeshStandardMaterial({ color: 0x78b464, transparent: true, opacity: 0.25, roughness: 0.4 }));
  sheen.scale.set(0.82, 0.7, 0.95); sheen.position.y = 0.18; g.add(sheen);

  // eyes (bumps + balls)
  const eyeW = new THREE.MeshStandardMaterial({ color: 0xfdfdf0, roughness: 0.3 });
  const eyeB = new THREE.MeshStandardMaterial({ color: 0x0a0f06, roughness: 0.2 });
  for (const s of [-1, 1]) {
    const bump = new THREE.Mesh(geo('frogEyeBump', () => new THREE.SphereGeometry(0.34, 12, 10)), skin);
    bump.position.set(0.45, 0.62, s * 0.42); g.add(bump);
    const w = new THREE.Mesh(geo('frogEyeW', () => new THREE.SphereGeometry(0.2, 10, 8)), eyeW);
    w.position.set(0.6, 0.74, s * 0.44); g.add(w);
    const b = new THREE.Mesh(geo('frogEyeB', () => new THREE.SphereGeometry(0.1, 8, 6)), eyeB);
    b.position.set(0.72, 0.76, s * 0.46); g.add(b);
  }

  // legs (tucked)
  for (const s of [-1, 1]) {
    const thigh = new THREE.Mesh(geo('frogThigh', () => new THREE.SphereGeometry(0.3, 10, 8)), darker);
    thigh.scale.set(1.3, 0.7, 0.8); thigh.position.set(-0.5, -0.3, s * 0.7); g.add(thigh);
    const foot = new THREE.Mesh(geo('frogFoot', () => new THREE.SphereGeometry(0.18, 8, 6)), darker);
    foot.scale.set(1.6, 0.4, 1.1); foot.position.set(0.55, -0.55, s * 0.7); g.add(foot);
  }

  g.userData = { body, materials: [skin, darker, sheen.material] };
  return g;
}

// ---------- PROCEDURAL DRAGONFLY ----------
function buildDragonfly(color) {
  const g = new THREE.Group();
  const col = new THREE.Color(color);
  const bodyMat = stdMat(col.getHex(), { roughness: 0.35, metalness: 0.25, emissive: col.clone().multiplyScalar(0.18).getHex() });

  const abdomen = new THREE.Mesh(geo('dflyAbd', () => new THREE.CylinderGeometry(0.12, 0.05, 1.7, 8)), bodyMat);
  abdomen.rotation.z = Math.PI / 2; abdomen.position.x = -0.5; g.add(abdomen);
  const thorax = new THREE.Mesh(geo('dflyThorax', () => new THREE.SphereGeometry(0.26, 12, 10)), bodyMat);
  thorax.position.x = 0.25; g.add(thorax);
  const head = new THREE.Mesh(geo('dflyHead', () => new THREE.SphereGeometry(0.22, 12, 10)), bodyMat);
  head.position.x = 0.62; g.add(head);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0a0f0d, roughness: 0.2 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(geo('dflyEye', () => new THREE.SphereGeometry(0.08, 8, 6)), eyeMat);
    e.position.set(0.7, 0.04, s * 0.1); g.add(e);
  }

  // 4 iridescent wings on pivots
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0xcfeaff, transparent: true, opacity: 0.45, roughness: 0.1, metalness: 0.3,
    side: THREE.DoubleSide, emissive: 0x224455, emissiveIntensity: 0.3,
  });
  const wings = [];
  const wingGeo = geo('dflyWing', () => new THREE.CircleGeometry(0.62, 14).translate(0.62, 0, 0));
  const defs = [[0.35, 1], [0.35, -1], [0.0, 1], [0.0, -1]];
  for (const [px, side] of defs) {
    const pivot = new THREE.Group(); pivot.position.set(px, 0.08, side * 0.12);
    const wing = new THREE.Mesh(wingGeo, wingMat);
    wing.rotation.x = -Math.PI / 2; wing.scale.set(1, side * 1.5, 1);
    pivot.add(wing); g.add(pivot); wings.push({ pivot, side });
  }

  g.userData = { wings, materials: [bodyMat, wingMat] };
  return g;
}

// ---------- PROCEDURAL LILY PAD ----------
function buildLily(hasFlower) {
  const g = new THREE.Group();
  const padMat = stdMat(0x2d6a4f, { roughness: 0.7 });
  const pad = new THREE.Mesh(
    geo('lilyPad', () => new THREE.CircleGeometry(1, 40, 0.4, Math.PI * 2 - 0.8).rotateX(-Math.PI / 2)),
    padMat
  );
  pad.position.y = 0.02; g.add(pad);

  // raised rim
  const rim = new THREE.Mesh(
    geo('lilyRim', () => new THREE.TorusGeometry(0.96, 0.05, 8, 36, Math.PI * 2 - 0.8).rotateX(Math.PI / 2)),
    stdMat(0x1a4a35, { roughness: 0.7 })
  );
  rim.rotation.y = 0; rim.position.y = 0.04; g.add(rim);

  const flowerGroup = new THREE.Group();
  if (hasFlower) {
    const petalMat = stdMat(0xffc8dc, { roughness: 0.5, emissive: 0x4a1828 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const petal = new THREE.Mesh(geo('lilyPetal', () => new THREE.SphereGeometry(0.2, 8, 6)), petalMat);
      petal.scale.set(0.5, 0.28, 0.9);
      petal.position.set(Math.cos(a) * 0.28, 0.14, Math.sin(a) * 0.28);
      petal.lookAt(0, 0.5, 0);
      flowerGroup.add(petal);
    }
    const center = new THREE.Mesh(geo('lilyCenter', () => new THREE.SphereGeometry(0.12, 10, 8)),
      stdMat(0xffe6b4, { emissive: 0x6a5418 }));
    center.position.y = 0.16; flowerGroup.add(center);
  }
  flowerGroup.visible = false;
  g.add(flowerGroup);

  g.userData = { pad, flowerGroup, hasFlower, materials: [padMat, rim.material] };
  return g;
}

// ---------- PROCEDURAL BIRD ----------
function buildBird(color) {
  const g = new THREE.Group();
  const bodyMat = stdMat(new THREE.Color(color).getHex(), { roughness: 0.65 });
  const body = new THREE.Mesh(geo('birdBody', () => new THREE.SphereGeometry(0.6, 14, 12)), bodyMat);
  body.scale.set(1.3, 0.7, 0.7); g.add(body);
  const head = new THREE.Mesh(geo('birdHead', () => new THREE.SphereGeometry(0.32, 12, 10)), bodyMat);
  head.position.set(0.75, 0.1, 0); g.add(head);
  const beak = new THREE.Mesh(geo('birdBeak', () => new THREE.ConeGeometry(0.1, 0.34, 6)), stdMat(0xe0a020));
  beak.rotation.z = -Math.PI / 2; beak.position.set(1.05, 0.08, 0); g.add(beak);
  // tail
  const tail = new THREE.Mesh(geo('birdTail', () => new THREE.ConeGeometry(0.3, 0.7, 4)), bodyMat);
  tail.rotation.z = Math.PI / 2; tail.scale.set(1, 1, 0.25); tail.position.x = -0.95; g.add(tail);

  // wings (flap)
  const wingMat = stdMat(new THREE.Color(color).multiplyScalar(0.85).getHex(), { roughness: 0.7, side: THREE.DoubleSide });
  const wingGeo = geo('birdWing', () => new THREE.PlaneGeometry(1.5, 0.7).translate(0, 0.35, 0));
  const wings = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(0, 0.12, s * 0.18);
    const wing = new THREE.Mesh(wingGeo, wingMat);
    wing.rotation.x = Math.PI / 2; wing.rotation.z = 0;
    wing.scale.set(1, s, 1);
    pivot.add(wing); g.add(pivot); wings.push({ pivot, side: s });
  }
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x05080c, roughness: 0.2 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(geo('birdEye', () => new THREE.SphereGeometry(0.06, 8, 6)), eyeMat);
    e.position.set(0.92, 0.16, s * 0.14); g.add(e);
  }

  g.userData = { wings, body, materials: [bodyMat, wingMat] };
  return g;
}

// set opacity across a creature's materials (for death fade)
function setGroupOpacity(group, o) {
  const mats = group.userData && group.userData.materials;
  if (!mats) return;
  for (const m of mats) {
    m.transparent = o < 1;
    m.opacity = o;
  }
}

// Wrap a built model so its largest bounding dimension is exactly 1 unit.
// Entities then scale by (gameSize * SCALE * VISUAL) for predictable size.
function unitWrap(built) {
  const box = new THREE.Box3().setFromObject(built);
  const size = new THREE.Vector3(); box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  built.scale.multiplyScalar(1 / maxDim);
  const wrap = new THREE.Group();
  wrap.add(built);
  return wrap;
}

// floating name label for the player fish
function makeNameSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const cx = c.getContext('2d');
  cx.font = 'bold 34px Inter, system-ui, sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.shadowColor = 'rgba(0,0,0,0.65)'; cx.shadowBlur = 7;
  cx.fillStyle = 'rgba(0,245,212,0.96)';
  cx.fillText(text || '', 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(11, 2.75, 1);
  sp.renderOrder = 20;
  return sp;
}

// ===================================================================
// ENTITIES — AI ported verbatim from pond.js; rendering is Three.js
// ===================================================================
const VISUAL = 2.4; // global creature size multiplier (readability in 3D)

// ===== FISH TIERS =====
const FISH_TIERS = [
  { name: 'small',     sizeMin: 8,  sizeMax: 14, speed: 0.8, color: ['#f9b208', '#e94560', '#00f5d4', '#ff6b6b'], eatCount: 0, eatRange: 0 },
  { name: 'medium',    sizeMin: 16, sizeMax: 24, speed: 0.7, color: ['#f9b208', '#e94560', '#4ecdc4'], eatCount: 2, eatRange: 80 },
  { name: 'large',     sizeMin: 26, sizeMax: 36, speed: 0.6, color: ['#e94560', '#9b5de5'], eatCount: 4, eatRange: 120 },
  { name: 'legendary', sizeMin: 40, sizeMax: 55, speed: 0.5, color: ['#9b5de5', '#ffe66d'], eatCount: 6, eatRange: 160 },
];
function rollFishTier() {
  const r = Math.random();
  if (r < 0.65) return 0;
  if (r < 0.88) return 1;
  if (r < 0.98) return 2;
  return 3;
}

// ===== ENTITY MANAGER ARRAYS =====
let waves = [];
let ripples = [];
let creatures = [];
let lilies = [];
let birds = [];
const lotuses = []; // vestigial in 2D (always empty) — kept for AI parity
let myFish = null;
let isDead = false;

// ===== WAVE =====
class Wave3D {
  constructor(x, y, opts = {}) {
    this.x = x; this.y = y;
    this.radius = opts.startRadius || 5;
    this.maxRadius = opts.maxRadius || (180 + Math.random() * 80);
    this.speed = opts.speed || 3.5;
    this.life = 1;
    this.force = opts.force || 20;
    this.splashAngle = opts.splashAngle !== undefined ? opts.splashAngle : Math.random() * Math.PI * 2;
    this.splashSpread = opts.splashSpread || (Math.PI * 0.4);
    this.id = Math.random();
    this.damagedLilies = new Set();
    this.disturbAccum = 0;

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xbfeeff, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(
      geo('waveRing', () => new THREE.RingGeometry(0.86, 1.0, 56).rotateX(-Math.PI / 2)),
      ringMat
    );
    this.mesh.position.set(toWorldX(x), 0.25, toWorldZ(y));
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }

  update(dt) {
    this.radius += this.speed * dt;
    this.life = 1 - (this.radius / this.maxRadius);
    const waveStrength = this.life * this.life;

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

    for (let i = lilies.length - 1; i >= 0; i--) {
      const l = lilies[i];
      if (this.damagedLilies.has(l)) continue;
      const d = dist(this.x, this.y, l.x, l.y);
      if (d < this.radius + 10 && d > this.radius - 20 && this.life > 0.3) {
        l.life -= 0.15;
        this.damagedLilies.add(l);
      }
    }

    this.disturbAccum += dt;
    if (this.disturbAccum > 1.2) {
      this.disturbAccum = 0;
      disturbWater(this.x + Math.cos(this.splashAngle) * this.radius,
                   this.y + Math.sin(this.splashAngle) * this.radius, waveStrength * 4, 60);
    }
    return this.life > 0;
  }

  sync3D() {
    const r = Math.max(0.1, this.radius * SCALE);
    this.mesh.scale.set(r, 1, r);
    this.mesh.material.opacity = this.life * 0.7;
  }

  destroy() { scene.remove(this.mesh); this.mesh.material.dispose(); }
}

// ===== RIPPLE (ambient) =====
class Ripple3D {
  constructor(x, y, opts = {}) {
    this.x = x; this.y = y;
    this.radius = opts.startRadius || 0;
    this.maxRadius = opts.maxRadius || (60 + Math.random() * 40);
    this.speed = opts.speed || 1.2;
    this.life = 1;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xc8eeff, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(
      geo('rippleRing', () => new THREE.RingGeometry(0.9, 1.0, 40).rotateX(-Math.PI / 2)),
      mat
    );
    this.mesh.position.set(toWorldX(x), 0.18, toWorldZ(y));
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }
  update() {
    this.radius += this.speed;
    this.life = 1 - (this.radius / this.maxRadius);
    return this.life > 0;
  }
  sync3D() {
    const r = Math.max(0.1, this.radius * SCALE);
    this.mesh.scale.set(r, 1, r);
    this.mesh.material.opacity = this.life * 0.32;
  }
  destroy() { scene.remove(this.mesh); this.mesh.material.dispose(); }
}

// ===== FISH =====
class Fish3D {
  constructor(x, y, tier, isPlayer) {
    this.type = 'fish';
    this.x = x; this.y = y; this.vx = 0; this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.tier = tier !== undefined ? tier : rollFishTier();
    const t = FISH_TIERS[this.tier];
    this.size = t.sizeMin + Math.random() * (t.sizeMax - t.sizeMin);
    this.baseSpeed = t.speed * (0.8 + Math.random() * 0.4);
    this.speed = this.baseSpeed;
    this.color = t.color[Math.floor(Math.random() * t.color.length)];
    this.turnTimer = 0; this.turnRate = 0;
    this.tailPhase = Math.random() * Math.PI * 2;
    this.life = 1;
    this.decay = 0.000015 + Math.random() * 0.00002;
    this.eaten = 0; this.eatTarget = null; this.eatCooldown = 0;
    this.growthScale = 1;
    this.isPlayer = !!isPlayer;
    this.name = '';
    this.bob = Math.random() * Math.PI * 2;

    const glb = assetCache.fish ? instantiateGLB('fish') : null;
    this.model = glb ? glb.root : buildFish(this.color, this.tier);
    this.mixer = glb ? glb.mixer : null;
    this.mesh = unitWrap(this.model);
    this.mesh.rotation.y = -this.angle;
    scene.add(this.mesh);
    this.nameSprite = null;
  }

  setPlayer(name) {
    this.isPlayer = true; this.name = name; this.color = '#00f5d4'; this.decay = 0;
    // re-tint procedural model cyan
    if (this.model.userData && this.model.userData.materials) {
      const c = new THREE.Color('#00f5d4');
      for (const m of this.model.userData.materials) { if (m.color) m.color.copy(c); if (m.emissive) m.emissive.copy(c).multiplyScalar(0.25); }
    }
    if (!this.nameSprite) { this.nameSprite = makeNameSprite(name); scene.add(this.nameSprite); }
  }

  update(dt) {
    this.tailPhase += 0.15;
    this.bob += 0.04;
    this.turnTimer -= dt;
    this.eatCooldown -= dt;

    const tierData = FISH_TIERS[this.tier];
    if (tierData.eatCount > 0 && this.eaten < tierData.eatCount && this.eatCooldown <= 0) {
      if (!this.eatTarget || !creatures.includes(this.eatTarget)) {
        let nearest = null, nearestDist = tierData.eatRange;
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
          this.eatTarget.life = 0;
          this.eaten++;
          this.growthScale = Math.min(this.growthScale + 0.15, 2.5);
          this.eatTarget = null;
          this.eatCooldown = 60;
          ripples.push(new Ripple3D(this.x, this.y, { maxRadius: 30 }));
          if (this.tier >= 2) {
            for (let i = lilies.length - 1; i >= 0; i--) {
              if (dist(this.x, this.y, lilies[i].x, lilies[i].y) < this.size) lilies[i].life -= 0.3;
            }
          }
        } else {
          const targetAngle = Math.atan2(this.eatTarget.y - this.y, this.eatTarget.x - this.x);
          let diff = ((targetAngle - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          this.angle += clamp(diff, -0.06, 0.06);
          this.speed = this.baseSpeed * 1.8;
        }
      } else { this.speed = this.baseSpeed; }
    } else { this.speed = this.baseSpeed; }

    if (this.turnTimer <= 0) {
      this.turnRate = (Math.random() - 0.5) * 0.04;
      this.turnTimer = 30 + Math.random() * 80;
    }
    this.angle += this.turnRate;

    const margin = 60;
    if (this.x < margin && this.vx > -0.5) this.angle += 0.03;
    if (this.x > W - margin && this.vx < 0.5) this.angle -= 0.03;
    if (this.y < margin && this.vy > -0.5) this.angle += 0.03;
    if (this.y > H - margin && this.vy < 0.5) this.angle -= 0.03;

    this.x += Math.cos(this.angle) * this.speed + this.vx;
    this.y += Math.sin(this.angle) * this.speed + this.vy;
    this.vx *= 0.96; this.vy *= 0.96;

    if (Math.abs(this.vx) > 0.5 || Math.abs(this.vy) > 0.5 || this.speed > 0.3) {
      disturbWater(this.x, this.y, 0.3 * this.growthScale, 30 * this.growthScale);
    }

    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  sync3D(dt) {
    const depth = -(1.5 + this.tier * 1.25) + Math.sin(this.bob) * 0.35;
    this.mesh.position.set(toWorldX(this.x), depth, toWorldZ(this.y));
    this.mesh.rotation.y = -this.angle;
    this.mesh.rotation.z = Math.sin(this.tailPhase) * 0.08; // body roll
    const s = this.size * this.growthScale * SCALE * VISUAL;
    this.mesh.scale.setScalar(s);
    if (this.mixer) this.mixer.update(dt * 0.016);
    else if (this.model.userData.tail) this.model.userData.tail.rotation.y = Math.sin(this.tailPhase) * 0.5;
    if (this.model.userData.glow) this.model.userData.glow.intensity = 0.7 + Math.sin(this.tailPhase * 0.5) * 0.3;
    const fade = this.life < 0.3 ? this.life / 0.3 : 1;
    if (fade < 1) setGroupOpacity(this.model, fade);
    if (this.nameSprite) { this.nameSprite.position.set(toWorldX(this.x), 2.6, toWorldZ(this.y)); this.nameSprite.material.opacity = fade; }
  }

  destroy() {
    scene.remove(this.mesh);
    if (this.nameSprite) { scene.remove(this.nameSprite); this.nameSprite.material.map.dispose(); this.nameSprite.material.dispose(); }
  }
}

// ===== FROG =====
class Frog3D {
  constructor(x, y) {
    this.type = 'frog';
    this.x = x; this.y = y; this.vx = 0; this.vy = 0;
    this.size = 14 + Math.random() * 6;
    this.growthScale = 1;
    this.state = 'sitting';
    this.timer = 60 + Math.random() * 120;
    this.hopFrom = { x, y }; this.hopTo = { x, y };
    this.hopProgress = 0;
    this.life = 1; this.decay = 0.000012;
    this.blinkTimer = Math.random() * 200;
    this.tongueState = 'idle'; this.tongueTarget = null; this.tongueProgress = 0;
    this.tongueLockX = 0; this.tongueLockY = 0; this.tongueOriginX = 0; this.tongueOriginY = 0;
    this.eatCooldown = 0; this.onLily = null; this.relaxPhase = 0;
    this.faceAngle = Math.random() * Math.PI * 2;

    const glb = assetCache.frog ? instantiateGLB('frog') : null;
    this.model = glb ? glb.root : buildFrog();
    this.mixer = glb ? glb.mixer : null;
    this.mesh = unitWrap(this.model);
    scene.add(this.mesh);

    this.tongueTip = new THREE.Mesh(geo('tongueTip', () => new THREE.SphereGeometry(0.5, 8, 6)),
      new THREE.MeshStandardMaterial({ color: 0xff5a6e, emissive: 0x5a1018, roughness: 0.4 }));
    this.tongueTip.visible = false; scene.add(this.tongueTip);
    this.shadow = makeBlobShadow(1); scene.add(this.shadow);
  }

  update(dt) {
    this.timer -= dt; this.blinkTimer -= dt; this.eatCooldown -= dt;

    if (this.state === 'sitting' && this.eatCooldown <= 0 && this.tongueState === 'idle') {
      if (Math.random() < 0.015) {
        let nearest = null, nearestDist = 150 * this.growthScale;
        for (const c of creatures) {
          if (c.type === 'dragonfly') {
            const d = dist(this.x, this.y, c.x, c.y);
            if (d < nearestDist) { nearest = c; nearestDist = d; }
          }
        }
        if (nearest) {
          this.tongueTarget = nearest; this.tongueState = 'extending'; this.tongueProgress = 0;
          this.tongueOriginX = this.x; this.tongueOriginY = this.y - this.size * 0.2 * this.growthScale;
          this.tongueLockX = nearest.x; this.tongueLockY = nearest.y;
        }
      }
    }

    if (this.tongueState === 'extending') {
      this.tongueProgress += 0.15 * dt;
      if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
        this.tongueLockX = this.tongueTarget.x; this.tongueLockY = this.tongueTarget.y;
      }
      if (this.tongueProgress >= 1) {
        if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
          this.tongueState = 'retracting'; this.tongueProgress = 1; this.tongueTarget.tongueGrabbed = true;
        } else { this.tongueState = 'retracting'; this.tongueProgress = 1; }
      }
    } else if (this.tongueState === 'retracting') {
      this.tongueProgress -= 0.08 * dt;
      if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
        const tipX = this.tongueOriginX + (this.tongueLockX - this.tongueOriginX) * this.tongueProgress;
        const tipY = this.tongueOriginY + (this.tongueLockY - this.tongueOriginY) * this.tongueProgress;
        this.tongueTarget.x = tipX; this.tongueTarget.y = tipY;
        this.tongueTarget.vx = 0; this.tongueTarget.vy = 0;
      }
      if (this.tongueProgress <= 0) {
        if (this.tongueTarget && creatures.includes(this.tongueTarget)) {
          this.tongueTarget.life = 0;
          this.growthScale = Math.min(this.growthScale + 0.3, 3);
          ripples.push(new Ripple3D(this.x, this.y, { maxRadius: 25 }));
        }
        this.tongueState = 'idle'; this.tongueTarget = null; this.tongueProgress = 0; this.eatCooldown = 100;
      }
    }

    if (this.state === 'relaxing') {
      this.relaxPhase += 0.03 * dt;
      if (Math.random() < 0.003) ripples.push(new Ripple3D(this.x, this.y, { maxRadius: 20, speed: 0.6 }));
    }

    if (this.state === 'sitting' && !this.onLily) {
      for (const l of lilies) {
        if (l.life > 0.5 && dist(this.x, this.y, l.x, l.y) < l.size * 0.8) {
          this.onLily = l; this.x = l.x; this.y = l.y; break;
        }
      }
    }
    if (this.onLily && this.onLily.life <= 0.3) this.onLily = null;

    if ((this.state === 'sitting' || this.state === 'relaxing') && this.timer <= 0 && this.tongueState === 'idle') {
      const distHop = 80 + Math.random() * 120;
      const ang = Math.random() * Math.PI * 2;
      this.hopFrom = { x: this.x, y: this.y };
      this.hopTo = { x: clamp(this.x + Math.cos(ang) * distHop, 40, W - 40), y: clamp(this.y + Math.sin(ang) * distHop, 40, H - 40) };
      this.faceAngle = Math.atan2(this.hopTo.y - this.hopFrom.y, this.hopTo.x - this.hopFrom.x);
      this.state = 'hopping'; this.hopProgress = 0; this.onLily = null;
      ripples.push(new Ripple3D(this.x, this.y, { maxRadius: 50 }));
    }

    if (this.state === 'hopping') {
      this.hopProgress += 0.04;
      const t = this.hopProgress;
      this.x = this.hopFrom.x + (this.hopTo.x - this.hopFrom.x) * t;
      this.y = this.hopFrom.y + (this.hopTo.y - this.hopFrom.y) * t;
      if (this.hopProgress >= 1) {
        this.x = this.hopTo.x; this.y = this.hopTo.y;
        let landedOnLily = null;
        for (const l of lilies) {
          if (l.life > 0.5 && dist(this.x, this.y, l.x, l.y) < l.size * 0.8) { landedOnLily = l; this.x = l.x; this.y = l.y; break; }
        }
        if (landedOnLily) {
          this.state = 'relaxing'; this.onLily = landedOnLily; this.timer = 300 + Math.random() * 200; this.relaxPhase = 0;
          ripples.push(new Ripple3D(this.x, this.y, { maxRadius: 35 }));
        } else {
          this.state = 'sitting'; this.timer = 80 + Math.random() * 200;
          ripples.push(new Ripple3D(this.x, this.y, { maxRadius: 45 }));
        }
      }
    }

    this.x += this.vx; this.y += this.vy; this.vx *= 0.95; this.vy *= 0.95;
    if (this.blinkTimer < 0) this.blinkTimer = 100 + Math.random() * 300;

    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  sync3D() {
    const hopY = this.state === 'hopping' ? Math.sin(this.hopProgress * Math.PI) * 7 : 0;
    const relaxBob = this.state === 'relaxing' ? Math.sin(this.relaxPhase) * 0.3 : 0;
    const relaxScale = this.state === 'relaxing' ? 1 + Math.sin(this.relaxPhase) * 0.03 : 1;
    const baseY = 0.3 + (this.onLily ? 0.25 : 0);
    this.mesh.position.set(toWorldX(this.x), baseY + hopY + relaxBob, toWorldZ(this.y));
    this.mesh.rotation.y = -this.faceAngle;
    const s = this.size * this.growthScale * SCALE * VISUAL * 1.15 * relaxScale;
    this.mesh.scale.setScalar(s);

    // shadow shrinks while airborne
    this.shadow.position.set(toWorldX(this.x), 0.07, toWorldZ(this.y));
    const shScale = s * 1.2 * (1 - Math.min(hopY / 7, 0.7));
    this.shadow.scale.setScalar(Math.max(0.2, shScale));
    this.shadow.material.opacity = 0.22 * (1 - Math.min(hopY / 7, 0.8));

    // tongue tip
    if (this.tongueState !== 'idle') {
      const tipX = this.tongueOriginX + (this.tongueLockX - this.tongueOriginX) * this.tongueProgress;
      const tipY = this.tongueOriginY + (this.tongueLockY - this.tongueOriginY) * this.tongueProgress;
      this.tongueTip.visible = true;
      this.tongueTip.position.set(toWorldX(tipX), baseY + hopY + 0.4, toWorldZ(tipY));
      this.tongueTip.scale.setScalar(s * 0.18);
    } else { this.tongueTip.visible = false; }

    const fade = this.life < 0.3 ? this.life / 0.3 : 1;
    if (fade < 1) setGroupOpacity(this.model, fade);
    if (this.mixer) this.mixer.update(0.016);
  }

  destroy() { scene.remove(this.mesh); scene.remove(this.tongueTip); scene.remove(this.shadow); }
}

// ===== DRAGONFLY =====
class Dragonfly3D {
  constructor(x, y) {
    this.type = 'dragonfly';
    this.x = x; this.y = y; this.vx = 0; this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.size = 10 + Math.random() * 4;
    this.state = 'darting';
    this.timer = 20 + Math.random() * 40;
    this.wingPhase = 0;
    this.life = 1; this.decay = 0.00002;
    this.color = ['#00f5d4', '#9b5de5', '#ffe66d'][Math.floor(Math.random() * 3)];

    const glb = assetCache.dragonfly ? instantiateGLB('dragonfly') : null;
    this.model = glb ? glb.root : buildDragonfly(this.color);
    this.mixer = glb ? glb.mixer : null;
    this.mesh = unitWrap(this.model);
    scene.add(this.mesh);
  }

  update(dt) {
    this.wingPhase += 0.6;
    if (this.tongueGrabbed) {
      this.wingPhase += 0.6;
      this.life -= 0.001 * dt;
      if (isOffScreen(this.x, this.y)) return false;
      return this.life > 0;
    }
    this.timer -= dt;
    if (this.state === 'darting') {
      this.speed = 4;
      if (this.timer <= 0) { this.state = 'pausing'; this.timer = 20 + Math.random() * 40; this.speed = 0; }
    } else {
      this.speed *= 0.8;
      if (this.timer <= 0) { this.state = 'darting'; this.timer = 30 + Math.random() * 50; this.angle = Math.random() * Math.PI * 2; }
    }
    this.x += Math.cos(this.angle) * this.speed + this.vx;
    this.y += Math.sin(this.angle) * this.speed + this.vy;
    this.vx *= 0.95; this.vy *= 0.95;

    const margin = 30;
    if (this.x < margin) { this.x = margin; this.angle = Math.PI - this.angle; }
    if (this.x > W - margin) { this.x = W - margin; this.angle = Math.PI - this.angle; }
    if (this.y < margin) { this.y = margin; this.angle = -this.angle; }
    if (this.y > H - margin) { this.y = H - margin; this.angle = -this.angle; }

    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  sync3D() {
    const hover = this.tongueGrabbed ? 0.7 : 4.2 + Math.sin(this.wingPhase * 0.5) * 0.4;
    this.mesh.position.set(toWorldX(this.x), hover, toWorldZ(this.y));
    this.mesh.rotation.y = -this.angle;
    this.mesh.scale.setScalar(this.size * SCALE * VISUAL);
    if (this.mixer) this.mixer.update(0.016);
    else if (this.model.userData.wings) {
      const flap = Math.sin(this.wingPhase) * 0.7;
      for (const w of this.model.userData.wings) w.pivot.rotation.x = flap * w.side;
    }
    const fade = this.life < 0.3 ? this.life / 0.3 : 1;
    if (fade < 1) setGroupOpacity(this.model, fade);
  }

  destroy() { scene.remove(this.mesh); }
}

// ===== LILY PAD =====
class LilyPad3D {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.size = 0;
    this.maxSize = 20 + Math.random() * 25;
    this.growth = 0.3;
    this.rotation = Math.random() * Math.PI * 2;
    this.life = 1; this.decay = 0.000008;
    this.flower = Math.random() > 0.6;
    this.placedAt = Date.now();
    this.sinking = false;

    const glb = assetCache.lily ? instantiateGLB('lily') : null;
    this.model = glb ? glb.root : buildLily(this.flower);
    this.mixer = glb ? glb.mixer : null;
    this.mesh = unitWrap(this.model);
    this.mesh.rotation.y = this.rotation;
    scene.add(this.mesh);
  }

  update() {
    if (this.sinking) { this.life -= 0.04; return this.life > 0; }
    if (this.size < this.maxSize) this.size += this.growth;
    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  sync3D() {
    const sinkY = this.sinking ? -(1 - this.life) * 4 : 0;
    this.mesh.position.set(toWorldX(this.x), 0.12 + sinkY, toWorldZ(this.y));
    this.mesh.scale.setScalar(Math.max(0.001, this.size * SCALE * VISUAL));
    const fg = this.model.userData.flowerGroup;
    if (fg) fg.visible = this.model.userData.hasFlower && this.size > this.maxSize * 0.8;
    const fade = this.life < 0.3 ? this.life / 0.3 : 1;
    if (fade < 1) setGroupOpacity(this.model, fade);
    if (this.mixer) this.mixer.update(0.016);
  }

  destroy() { scene.remove(this.mesh); }
}

// ===== BIRD =====
class Bird3D {
  constructor(targetCreature) {
    this.type = 'bird';
    this.target = targetCreature;
    const side = Math.random() < 0.5 ? 'left' : 'right';
    this.x = side === 'left' ? -60 : W + 60;
    this.y = -40 + Math.random() * H * 0.3;
    this.vx = 0; this.vy = 0;
    this.state = 'diving';
    this.wingPhase = Math.random() * Math.PI * 2;
    this.size = 18 + Math.random() * 8;
    this.angle = 0;
    this.grabbedCreature = false;
    this.life = 1; this.exitTimer = 0;
    this.swoopScale = 1; this.swoopPhase = 0;
    this.color = ['#2a2a2a', '#3a2a1a', '#1a1a2a'][Math.floor(Math.random() * 3)];

    const glb = assetCache.bird ? instantiateGLB('bird') : null;
    this.model = glb ? glb.root : buildBird(this.color);
    this.mixer = glb ? glb.mixer : null;
    this.mesh = unitWrap(this.model);
    scene.add(this.mesh);
    this.shadow = makeBlobShadow(1); scene.add(this.shadow);
  }

  update(dt) {
    this.wingPhase += 0.4 * dt;
    if (this.state === 'diving') {
      if (this.target && creatures.includes(this.target) && this.target.life > 0) {
        const dx = this.target.x - this.x, dy = this.target.y - this.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const speed = 3.5;
        this.vx = (dx / d) * speed; this.vy = (dy / d) * speed;
        this.angle = Math.atan2(this.vy, this.vx);
        if (d < this.size * 3) { this.state = 'swooping'; this.swoopPhase = 0; }
      } else { this.state = 'escaping'; this.exitTimer = 0; }
    } else if (this.state === 'swooping') {
      this.swoopPhase += 0.08 * dt;
      if (this.swoopPhase < 0.5) this.swoopScale = 1 - this.swoopPhase * 0.6;
      else this.swoopScale = 0.4 + (this.swoopPhase - 0.5) * 1.2;
      if (this.target && creatures.includes(this.target) && this.target.life > 0) {
        const dx = this.target.x - this.x, dy = this.target.y - this.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const speed = 2.5;
        this.vx = (dx / d) * speed; this.vy = (dy / d) * speed;
        this.angle = Math.atan2(this.vy, this.vx);
        if (this.swoopPhase >= 1) {
          if (d < this.size * 2) {
            this.state = 'escaping'; this.grabbedCreature = true; this.target.life = 0; this.swoopScale = 1; this.exitTimer = 0;
            ripples.push(new Ripple3D(this.target.x, this.target.y, { maxRadius: 60 }));
            disturbWater(this.target.x, this.target.y, 6, 80);
          } else { this.state = 'escaping'; this.exitTimer = 0; this.swoopScale = 1; }
        }
      } else { this.state = 'escaping'; this.exitTimer = 0; this.swoopScale = 1; }
    } else if (this.state === 'escaping') {
      this.exitTimer += dt;
      const escapeAngle = -Math.PI / 4 - Math.random() * 0.3;
      const dir = this.x < W / 2 ? -1 : 1;
      this.vx = dir * 5 + Math.cos(escapeAngle) * 2;
      this.vy = -4 - this.exitTimer * 0.1;
      this.angle = Math.atan2(this.vy, this.vx);
    }
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (this.state === 'escaping' && (this.y < -100 || this.x < -120 || this.x > W + 120)) return false;
    return true;
  }

  sync3D() {
    let h;
    if (this.state === 'diving') h = 24;
    else if (this.state === 'swooping') h = 24 - Math.sin(Math.min(this.swoopPhase, 1) * Math.PI) * 21;
    else h = 24 + this.exitTimer * 0.6;
    this.mesh.position.set(toWorldX(this.x), h, toWorldZ(this.y));
    this.mesh.rotation.y = -this.angle;
    this.mesh.rotation.z = clamp((this.state === 'escaping' ? 0.4 : -0.25), -0.6, 0.6);
    this.mesh.scale.setScalar(this.size * SCALE * VISUAL * this.swoopScale);
    if (this.mixer) this.mixer.update(0.016);
    else if (this.model.userData.wings) {
      const flap = Math.sin(this.wingPhase) * 0.9;
      for (const w of this.model.userData.wings) w.pivot.rotation.z = flap * w.side;
    }
    // ground shadow tracks bird, fainter/larger when higher
    this.shadow.position.set(toWorldX(this.x), 0.08, toWorldZ(this.y));
    const sh = this.size * SCALE * VISUAL * (0.8 + h * 0.03);
    this.shadow.scale.setScalar(sh);
    this.shadow.material.opacity = clamp(0.26 - h * 0.006, 0.03, 0.26);
  }

  destroy() { scene.remove(this.mesh); scene.remove(this.shadow); }
}

// ===================================================================
// ENTITY MANAGERS
// ===================================================================
const respawnBanner = document.getElementById('respawn-banner');

function addWave(x, y, opts) {
  if (waves.length >= MAX_WAVES) waves.shift().destroy();
  waves.push(new Wave3D(x, y, opts));
  ripples.push(new Ripple3D(x, y, { maxRadius: 40 }));
  disturbWater(x, y, 7, 110);
}

function addRipple(x, y, opts) {
  if (ripples.length >= MAX_RIPPLES) ripples.shift().destroy();
  ripples.push(new Ripple3D(x, y, opts));
}

function addCreature(type, x, y, extra, silent) {
  if (creatures.length >= MAX_CREATURES) creatures.shift().destroy();
  let c;
  switch (type) {
    case 'fish': c = new Fish3D(x, y, extra && extra.tier); break;
    case 'frog': c = new Frog3D(x, y); break;
    case 'dragonfly': c = new Dragonfly3D(x, y); break;
    default: return;
  }
  creatures.push(c);
  if (!silent) ripples.push(new Ripple3D(x, y, { maxRadius: 50 }));

  // if the player is dead and a new fish spawns, adopt it as their fish
  if (isDead && type === 'fish') {
    c.setPlayer(myUserName);
    myFish = c; isDead = false;
    respawnBanner.classList.remove('visible');
    ripples.push(new Ripple3D(c.x, c.y, { maxRadius: 50 }));
  }
  return c;
}

let lastLilyPlace = { x: -999, y: -999, time: 0 };
function addLily(x, y, silent) {
  const now = Date.now();
  if (!silent) {
    if (dist(x, y, lastLilyPlace.x, lastLilyPlace.y) < 40 && now - lastLilyPlace.time < LILY_PLACE_COOLDOWN) return false;
  }
  for (const l of lilies) {
    if (l.life > 0.3 && !l.sinking && dist(x, y, l.x, l.y) < l.size) l.sinking = true;
  }
  if (lilies.length >= MAX_LILIES) lilies[0].sinking = true;
  lilies.push(new LilyPad3D(x, y));
  if (!silent) { ripples.push(new Ripple3D(x, y, { maxRadius: 35 })); lastLilyPlace = { x, y, time: now }; }
  return true;
}

// ===================================================================
// ENVIRONMENT — a secluded faerie-forest pond: sloped mossy banks,
// trees with glowing canopies, luminescent mushrooms, ferns, cattails,
// rocks and drifting fireflies. Scales down on mobile.
// ===================================================================
let fireflyState = null;

// Build the continuous bowl terrain: a high-detail basin+shore disc and a
// lower-detail outer forest-floor plateau, both following terrainHeight().
// Sharing the same angular segment count keeps the shoreline seam crack-free.
function buildTerrain(parent, HQ) {
  const G_OUT = R_WATER * 4.2;
  const deep = new THREE.Color(0x06181f), midB = new THREE.Color(0x123a44), shallow = new THREE.Color(0x2c6f72);
  const sandWet = new THREE.Color(0x4f8a8f), sandDamp = new THREE.Color(0x7ba39a); // blue watery sand
  const mossLit = new THREE.Color(0x40743f), mossDk = new THREE.Color(0x1d3a24), dirt = new THREE.Color(0x281f15);
  const theta = HQ ? 120 : 56;

  function colorFor(r, y, n) {
    // deep underwater: shallow teal grading down to dark deep
    if (y < -3.0) {
      const t = clamp((-y - 3.0) / (POND_DEPTH - 3.0), 0, 1);
      return shallow.clone().lerp(midB, clamp(t * 1.4, 0, 1)).lerp(deep, clamp((t - 0.5) * 1.6, 0, 1));
    }
    // broad shoreline beach straddling the waterline: shallow water -> wet
    // blue sand -> damp sand -> moss, all eased for a buttery-smooth blend
    // that reaches well up the outer bank.
    if (y < 3.8) {
      const t = clamp((y + 3.0) / 6.8, 0, 1);             // 0 (underwater) .. 1 (dry bank)
      const s = t * t * (3.0 - 2.0 * t);                  // smoothstep
      const wet = shallow.clone().lerp(sandWet, clamp(s * 1.9, 0, 1));
      const dry = wet.lerp(sandDamp, clamp((s - 0.35) / 0.4, 0, 1));
      return dry.lerp(mossLit, clamp((s - 0.74) / 0.26 + n * 0.1, 0, 1));
    }
    // forest floor: moss -> dirt outward
    const t = clamp((r - R_SHORE) / (R_WATER * 1.4), 0, 1);
    return mossLit.clone().lerp(mossDk, clamp(t * 1.3 + n * 0.18, 0, 1)).lerp(dirt, clamp((t - 0.5) * 0.9, 0, 1));
  }

  // noise amplitude as a continuous function of radius (calm underwater,
  // lumpy on land) so adjacent rings agree exactly at the shared seam.
  function noiseAmpAt(r) { return 0.2 + 0.95 * clamp((r - R_PLAY) / (R_WATER * 0.6), 0, 1); }

  function makeRing(inner, outer, phi) {
    const g = new THREE.RingGeometry(inner, outer, theta, phi);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const col = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const r = Math.hypot(x, z);
      const n = Math.sin(x * 0.21) * Math.cos(z * 0.19) * 0.5 + Math.sin((x + z) * 0.13) * 0.5;
      const y = terrainHeight(r) + n * noiseAmpAt(r);
      p.setY(i, y);
      const c = colorFor(r, y, n);
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true }));
  }

  parent.add(makeRing(0.4, R_SHORE, HQ ? 44 : 18));   // basin + shore
  parent.add(makeRing(R_SHORE, G_OUT, HQ ? 30 : 12));  // forest floor

  // soft caustic shimmer near the bowl bottom
  const caustic = new THREE.Mesh(
    new THREE.CircleGeometry(R_PLAY * 0.95, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x39a6b8, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  caustic.position.y = -POND_DEPTH + 0.6;
  parent.add(caustic);
}

// ===== TREE VARIATIONS =====
// Four distinct low-poly tree types for realistic forest variety.
// Each has a unique silhouette, trunk shape, and canopy structure.

// Type 1: Tall pine / conifer — narrow tapered trunk with stacked cone canopy
function makePineTree(scale, glow) {
  const g = new THREE.Group();
  const trunkH = (8 + Math.random() * 4) * scale;
  const trunk = new THREE.Mesh(
    geo('pineTrunk', () => new THREE.CylinderGeometry(0.32, 0.55, 1, 5)),
    stdMat(0x3d2a1e, { roughness: 1, flatShading: true })
  );
  trunk.scale.set(scale, trunkH, scale);
  trunk.position.y = trunkH / 2;
  g.add(trunk);

  const cols = glow ? [0x1a6b48, 0x1e7a52, 0x248a5e] : [0x1a5238, 0x1e6042, 0x226e4a];
  let topY = trunkH;
  const layers = 5;
  for (let k = 0; k < layers; k++) {
    const r = (2.8 - k * 0.42) * scale;
    const h = (2.6 - k * 0.15) * scale;
    const mat = stdMat(cols[k % cols.length], { roughness: 0.9, flatShading: true });
    if (glow) { mat.emissive = new THREE.Color(0x0a3d28); mat.emissiveIntensity = 0.6; }
    const cone = new THREE.Mesh(geo('pineCone', () => new THREE.ConeGeometry(1, 1, 7)), mat);
    cone.scale.set(r, h, r);
    cone.position.y = trunkH * 0.35 + k * h * 0.65;
    g.add(cone);
    topY = cone.position.y + h / 2;
  }
  g.userData.topY = topY;
  return g;
}

// Type 2: Oak / broadleaf — thick short trunk with large rounded canopy clusters
function makeOakTree(scale, glow) {
  const g = new THREE.Group();
  const trunkH = (5 + Math.random() * 2.5) * scale;
  const trunk = new THREE.Mesh(
    geo('oakTrunk', () => new THREE.CylinderGeometry(0.55, 0.95, 1, 6)),
    stdMat(0x4a3528, { roughness: 1, flatShading: true })
  );
  trunk.scale.set(scale, trunkH, scale);
  trunk.position.y = trunkH / 2;
  g.add(trunk);

  // branch stubs for character
  for (let b = 0; b < 2; b++) {
    const ba = Math.random() * Math.PI * 2;
    const branch = new THREE.Mesh(
      geo('oakBranch', () => new THREE.CylinderGeometry(0.18, 0.3, 1, 4)),
      stdMat(0x4a3528, { roughness: 1, flatShading: true })
    );
    const blen = (1.5 + Math.random() * 1.2) * scale;
    branch.scale.set(scale, blen, scale);
    branch.position.set(Math.cos(ba) * 0.5 * scale, trunkH * 0.7, Math.sin(ba) * 0.5 * scale);
    branch.rotation.z = Math.cos(ba) * 0.5;
    branch.rotation.x = Math.sin(ba) * 0.5;
    g.add(branch);
  }

  const cols = glow ? [0x2a8f63, 0x36a872, 0x2e9a5a] : [0x2a6b44, 0x246b44, 0x2e7d4f];
  let topY = trunkH;
  const clusters = 4 + Math.floor(Math.random() * 2);
  for (let k = 0; k < clusters; k++) {
    const r = (2.8 - k * 0.3) * scale;
    const mat = stdMat(cols[k % cols.length], { roughness: 0.85, flatShading: true });
    if (glow) { mat.emissive = new THREE.Color(0x0e4732); mat.emissiveIntensity = 0.7; }
    const can = new THREE.Mesh(geo('oakCanopy', () => new THREE.IcosahedronGeometry(1, 0)), mat);
    can.scale.set(r, r * 0.82, r);
    const ang = (k / clusters) * Math.PI * 2 + Math.random() * 0.5;
    const offR = k === 0 ? 0 : (1.2 + Math.random() * 0.8) * scale;
    can.position.set(Math.cos(ang) * offR, trunkH + k * 0.8 * scale + 0.5 * scale, Math.sin(ang) * offR);
    can.rotation.set(Math.random(), Math.random() * 6.28, Math.random());
    g.add(can);
    topY = Math.max(topY, can.position.y + r * 0.82);
  }
  g.userData.topY = topY;
  return g;
}

// Type 3: Birch / slender — thin tapering trunk with small sparse canopy
function makeBirchTree(scale, glow) {
  const g = new THREE.Group();
  const trunkH = (9 + Math.random() * 3) * scale;
  const trunk = new THREE.Mesh(
    geo('birchTrunk', () => new THREE.CylinderGeometry(0.22, 0.38, 1, 6)),
    stdMat(0xd4cfc0, { roughness: 0.9, flatShading: true })
  );
  trunk.scale.set(scale, trunkH, scale);
  trunk.position.y = trunkH / 2;
  g.add(trunk);

  // birch bark dark patches
  for (let p = 0; p < 3; p++) {
    const patch = new THREE.Mesh(
      geo('birchPatch', () => new THREE.CylinderGeometry(0.39, 0.39, 0.3, 6, 1, true)),
      stdMat(0x2a2520, { roughness: 1, flatShading: true })
    );
    patch.scale.set(scale, scale, scale);
    patch.position.y = trunkH * (0.2 + p * 0.25);
    patch.rotation.y = Math.random() * 6.28;
    g.add(patch);
  }

  const cols = glow ? [0x3a9a6a, 0x44b07a, 0x2e8a5a] : [0x3a7a54, 0x348a5e, 0x2e7d4f];
  let topY = trunkH;
  const clusters = 3;
  for (let k = 0; k < clusters; k++) {
    const r = (1.8 - k * 0.3) * scale;
    const mat = stdMat(cols[k % cols.length], { roughness: 0.8, flatShading: true });
    if (glow) { mat.emissive = new THREE.Color(0x0e4732); mat.emissiveIntensity = 0.6; }
    const can = new THREE.Mesh(geo('birchCanopy', () => new THREE.IcosahedronGeometry(1, 0)), mat);
    can.scale.set(r, r * 0.75, r);
    const ang = (k / clusters) * Math.PI * 2 + Math.random();
    const offR = (0.8 + Math.random() * 0.6) * scale;
    can.position.set(Math.cos(ang) * offR, trunkH - 0.5 * scale + k * 1.2 * scale, Math.sin(ang) * offR);
    can.rotation.set(Math.random(), Math.random() * 6.28, Math.random());
    g.add(can);
    topY = Math.max(topY, can.position.y + r * 0.75);
  }
  g.userData.topY = topY;
  return g;
}

// Type 4: Willow / drooping — curved trunk with cascading leaf curtains
function makeWillowTree(scale, glow) {
  const g = new THREE.Group();
  const trunkH = (6 + Math.random() * 2) * scale;
  const trunk = new THREE.Mesh(
    geo('willowTrunk', () => new THREE.CylinderGeometry(0.38, 0.65, 1, 5)),
    stdMat(0x5a4a38, { roughness: 1, flatShading: true })
  );
  trunk.scale.set(scale, trunkH, scale);
  trunk.position.y = trunkH / 2;
  // slight lean
  trunk.rotation.z = (Math.random() - 0.5) * 0.15;
  g.add(trunk);

  const cols = glow ? [0x2a8a5a, 0x34a06a, 0x247a4a] : [0x2a6a44, 0x246640, 0x1e5a3a];
  let topY = trunkH;

  // inner canopy cluster
  const innerMat = stdMat(cols[0], { roughness: 0.85, flatShading: true });
  if (glow) { innerMat.emissive = new THREE.Color(0x0e4732); innerMat.emissiveIntensity = 0.6; }
  const inner = new THREE.Mesh(geo('willowInner', () => new THREE.IcosahedronGeometry(1, 0)), innerMat);
  inner.scale.set(2.2 * scale, 1.6 * scale, 2.2 * scale);
  inner.position.y = trunkH + 0.5 * scale;
  inner.rotation.set(Math.random(), Math.random() * 6.28, Math.random());
  g.add(inner);
  topY = inner.position.y + 1.6 * scale;

  // drooping curtain strips — thin cones hanging from the canopy edge
  const curtainCount = 8;
  const curtainMat = stdMat(cols[1], { roughness: 0.85, flatShading: true, side: THREE.DoubleSide });
  if (glow) { curtainMat.emissive = new THREE.Color(0x0a3a26); curtainMat.emissiveIntensity = 0.5; }
  for (let c = 0; c < curtainCount; c++) {
    const ang = (c / curtainCount) * Math.PI * 2 + Math.random() * 0.3;
    const offR = (2.0 + Math.random() * 0.5) * scale;
    const dropLen = (3 + Math.random() * 2.5) * scale;
    const curtain = new THREE.Mesh(
      geo('willowCurtain', () => new THREE.ConeGeometry(0.5, 1, 4, 1, true)),
      curtainMat
    );
    curtain.scale.set(scale * 0.8, dropLen, scale * 0.8);
    curtain.position.set(Math.cos(ang) * offR, trunkH + 0.3 * scale - dropLen * 0.3, Math.sin(ang) * offR);
    // tilt outward slightly
    curtain.rotation.z = Math.cos(ang) * 0.12;
    curtain.rotation.x = Math.sin(ang) * 0.12;
    g.add(curtain);
  }
  g.userData.topY = topY;
  return g;
}

const TREE_GLB_KEYS = ['tree_pine', 'tree_birch', 'tree_maple', 'tree_oak', 'tree_autumn'];
const TREE_BUILDERS = [makePineTree, makeOakTree, makeBirchTree, makeWillowTree];
let treeTypeCounter = 0;

function makeTree(scale, glow) {
  // Cycle through GLB tree types evenly for consistent distribution
  const availableGLBs = TREE_GLB_KEYS.filter(k => assetCache[k]);
  if (availableGLBs.length > 0) {
    const key = availableGLBs[treeTypeCounter % availableGLBs.length];
    treeTypeCounter++;
    const glb = instantiateGLB(key);
    if (glb) {
      const tree = glb.root;
      tree.scale.multiplyScalar(scale * 20);
      tree.userData.topY = 48 * scale;
      if (glow) {
        tree.traverse(c => {
          if (c.isMesh && c.material) {
            if (c.material.emissive) { c.material.emissive = new THREE.Color(0x0e4732); c.material.emissiveIntensity = 0.6; }
          }
        });
      }
      return tree;
    }
  }
  const builder = TREE_BUILDERS[Math.floor(Math.random() * TREE_BUILDERS.length)];
  return builder(scale, glow);
}

function makeMushroom() {
  const g = new THREE.Group();
  const h = 0.7 + Math.random() * 0.9;
  const stem = new THREE.Mesh(
    geo('mushStem', () => new THREE.CylinderGeometry(0.12, 0.2, 1, 6)),
    stdMat(0xe9e2cf, { roughness: 0.9 })
  );
  stem.scale.y = h; stem.position.y = h / 2;
  g.add(stem);
  const capCol = [0x6be0ff, 0x8affd6, 0xc6a0ff][Math.floor(Math.random() * 3)];
  const capMat = new THREE.MeshStandardMaterial({ color: capCol, emissive: new THREE.Color(capCol), emissiveIntensity: 1.4, roughness: 0.45 });
  const cap = new THREE.Mesh(
    geo('mushCap', () => new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
    capMat
  );
  cap.position.y = h; cap.scale.set(1, 0.7, 1);
  g.add(cap);
  g.userData.capColor = capCol;
  return g;
}

function buildEnvironment() {
  const HQ = !LOW_QUALITY;
  const forest = new THREE.Group();

  // ---- continuous bowl terrain: pond basin -> shore -> forest floor ----
  buildTerrain(forest, HQ);

  // ---- trees — 36 trees, all 5 GLB types, 1-2 sizes each ----
  const treeCount = HQ ? 36 : 12;
  const glowTreeIdx = new Set();
  while (glowTreeIdx.size < (HQ ? 8 : 2)) glowTreeIdx.add(Math.floor(Math.random() * treeCount));
  const faerieLights = HQ ? 5 : 0;
  let lightsPlaced = 0;
  const lightCols = [0x46e6c0, 0xbb8cff, 0x8ce0ff, 0xffd27a];
  // Assign each tree a specific GLB type + one of 2 fixed sizes for consistency
  const treeTypes = TREE_GLB_KEYS;
  const treeScales = [1.0, 1.4]; // two sizes only
  for (let i = 0; i < treeCount; i++) {
    const a = (i / treeCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const r = R_WATER * (1.15 + Math.random() * 1.0);  // 150..262 — stays inside dome (314)
    const scale = treeScales[Math.floor(Math.random() * treeScales.length)];
    const glow = glowTreeIdx.has(i);
    const tree = makeTree(scale, glow);
    tree.position.set(Math.cos(a) * r, terrainHeight(r) - 0.6, Math.sin(a) * r);
    tree.rotation.y = Math.random() * 6.28;
    forest.add(tree);
    if (glow && lightsPlaced < faerieLights) {
      const pl = new THREE.PointLight(lightCols[lightsPlaced % lightCols.length], 0.95, 90, 2);
      pl.position.set(tree.position.x, tree.position.y + tree.userData.topY * 0.8, tree.position.z);
      forest.add(pl);
      lightsPlaced++;
    }
  }

  // ---- glowing mushrooms near the shore ----
  const mushCount = HQ ? 16 : 5;
  for (let i = 0; i < mushCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = R_SHORE + R_WATER * (0.04 + Math.random() * 0.42);
    const m = makeMushroom();
    m.position.set(Math.cos(a) * r, terrainHeight(r) - 0.2, Math.sin(a) * r);
    forest.add(m);
    if (HQ && i % 6 === 0) {
      const gl = new THREE.PointLight(m.userData.capColor, 0.5, 22, 2);
      gl.position.set(m.position.x, m.position.y + 1.5, m.position.z);
      forest.add(gl);
    }
  }

  // ---- 2D billboard grass & foliage (animated wind sway, much lighter) ----
  // Disperse densely on the forest floor, avoiding the sandy shore zone.
  // Uses camera-facing billboards with a procedural grass texture and
  // vertex shader wind animation — far cheaper than 3D grass GLBs.
  const grassMinR = R_SHORE + R_WATER * 0.14;   // past the sandy beach
  const grassMaxR = R_WATER * 3.5;               // out to forest edge
  const grassCount = HQ ? 400 : 80;
  const grassBlades = [];

  // procedural grass texture (canvas → canvas texture)
  const grassTex = (function makeGrassTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 128;
    const ctx = c.getContext('2d');
    // gradient: dark base → bright tip
    const grad = ctx.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0, '#1a3a1a');
    grad.addColorStop(0.5, '#2e6b3e');
    grad.addColorStop(1, '#4a9a5a');
    ctx.fillStyle = grad;
    // draw several blade shapes
    for (let i = 0; i < 5; i++) {
      const x = 8 + i * 12 + Math.random() * 4;
      const w = 4 + Math.random() * 3;
      const h = 80 + Math.random() * 40;
      ctx.beginPath();
      ctx.moveTo(x - w / 2, 128);
      ctx.quadraticCurveTo(x, 128 - h * 0.6, x, 128 - h);
      ctx.quadraticCurveTo(x + w / 2, 128 - h * 0.4, x + w / 2, 128);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    return tex;
  })();

  // bush/flower billboard texture
  const bushTex = (function makeBushTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    // green bush blob with some flowers
    ctx.fillStyle = '#2a5a3a';
    ctx.beginPath();
    ctx.arc(64, 70, 45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a7a4a';
    ctx.beginPath();
    ctx.arc(50, 60, 25, 0, Math.PI * 2);
    ctx.arc(80, 55, 22, 0, Math.PI * 2);
    ctx.fill();
    // scattered flowers
    const fcols = ['#ff6b9a', '#ffd27a', '#a07aff'];
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = fcols[i % 3];
      ctx.beginPath();
      ctx.arc(35 + Math.random() * 60, 40 + Math.random() * 40, 3 + Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    return tex;
  })();

  const grassMat = new THREE.MeshBasicMaterial({
    map: grassTex,
    transparent: true,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
    fog: true,
  });
  const bushMatBB = new THREE.MeshBasicMaterial({
    map: bushTex,
    transparent: true,
    alphaTest: 0.2,
    side: THREE.DoubleSide,
    fog: true,
  });

  // shared billboard geometry — a plane that we'll position and scale per instance
  const bbGeo = new THREE.PlaneGeometry(1, 1);
  bbGeo.translate(0, 0.5, 0); // anchor at bottom

  for (let i = 0; i < grassCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = grassMinR + Math.random() * (grassMaxR - grassMinR);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const by = terrainHeight(r) - 0.1;
    const isBush = Math.random() < 0.15;
    const mat = isBush ? bushMatBB : grassMat;
    const bb = new THREE.Mesh(bbGeo, mat);
    const h = isBush ? 3 + Math.random() * 3 : 2.5 + Math.random() * 3;
    const w = isBush ? h : h * 0.4;
    bb.scale.set(w, h, 1);
    bb.position.set(cx + (Math.random() - 0.5) * 3, by, cz + (Math.random() - 0.5) * 3);
    bb.userData = { baseRot: Math.random() * Math.PI, phase: Math.random() * 6.28, swayAmt: 0.05 + Math.random() * 0.08, isBush };
    grassBlades.push(bb);
    forest.add(bb);
  }

  // store for wind animation
  window.__grassBlades = grassBlades;

  // ---- sparse beach weeds in the sandy zone ----
  const beachWeedCount = HQ ? 18 : 6;
  const beachMinR = R_SHORE + R_WATER * 0.01;
  const beachMaxR = R_SHORE + R_WATER * 0.12;
  for (let i = 0; i < beachWeedCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = beachMinR + Math.random() * (beachMaxR - beachMinR);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const by = terrainHeight(r) - 0.05;
    // sparse thin grass tufts
    const weedMat = stdMat(0x8a9a6a, { roughness: 0.9, flatShading: true });
    const weedGeo = geo('beachWeed', () => new THREE.ConeGeometry(0.08, 1, 3));
    const n = 2 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const h = 0.5 + Math.random() * 1.0;
      const blade = new THREE.Mesh(weedGeo, weedMat);
      blade.scale.set(1, h, 1);
      blade.position.set(cx + (Math.random() - 0.5) * 0.8, by + h / 2, cz + (Math.random() - 0.5) * 0.8);
      blade.rotation.z = (Math.random() - 0.5) * 0.4;
      blade.rotation.x = (Math.random() - 0.5) * 0.4;
      forest.add(blade);
    }
  }

  // ---- cattails / reeds at the waterline (GLB if available) ----
  const reedMat = stdMat(0x2e6b3a, { roughness: 0.8 });
  const reedMat2 = stdMat(0x3f8a4a, { roughness: 0.8 });
  const tailMat = stdMat(0x6b4a2a, { roughness: 0.9 });
  const reedGeo = geo('reedStalk', () => new THREE.CylinderGeometry(0.05, 0.12, 1, 5));
  const tailGeo = geo('catTail', () => (typeof THREE.CapsuleGeometry === 'function')
    ? new THREE.CapsuleGeometry(0.22, 0.9, 4, 8)
    : new THREE.CylinderGeometry(0.22, 0.22, 1.2, 8));
  const clusters = HQ ? 16 : 6;
  for (let i = 0; i < clusters; i++) {
    const a = (i / clusters) * Math.PI * 2 + Math.random() * 0.5;
    const r = R_SHORE + R_WATER * (-0.02 + Math.random() * 0.09);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, by = terrainHeight(r) - 0.4;
    const glb = assetCache.reeds ? instantiateGLB('reeds') : null;
    if (glb) { glb.root.scale.multiplyScalar(4 + Math.random() * 3); glb.root.position.set(cx, by, cz); forest.add(glb.root); continue; }
    const n = 4 + Math.floor(Math.random() * 4);
    for (let j = 0; j < n; j++) {
      const h = 5 + Math.random() * 6;
      const reed = new THREE.Mesh(reedGeo, Math.random() > 0.5 ? reedMat : reedMat2);
      reed.scale.y = h;
      const rx = cx + (Math.random() - 0.5) * 4, rz = cz + (Math.random() - 0.5) * 4;
      reed.position.set(rx, by + h / 2, rz);
      reed.rotation.z = (Math.random() - 0.5) * 0.35;
      reed.rotation.x = (Math.random() - 0.5) * 0.3;
      forest.add(reed);
      if (Math.random() > 0.55) {
        const tail = new THREE.Mesh(tailGeo, tailMat);
        tail.position.set(rx, by + h - 0.4, rz);
        forest.add(tail);
      }
    }
  }

  // ---- rocks ----
  const rockCount = HQ ? 9 : 4;
  for (let i = 0; i < rockCount; i++) {
    const a = (i / rockCount) * Math.PI * 2 + Math.random() * 0.5;
    const r = R_SHORE + R_WATER * (-0.04 + Math.random() * 0.36);
    let rock;
    const glb = assetCache.rocks ? instantiateGLB('rocks') : null;
    if (glb) { rock = glb.root; rock.scale.multiplyScalar(3 + Math.random() * 3); }
    else {
      rock = new THREE.Mesh(
        geo('rockGeo', () => new THREE.DodecahedronGeometry(1, 0)),
        stdMat(0x4a5058, { roughness: 0.95, flatShading: true })
      );
      rock.scale.set(2 + Math.random() * 2.4, 1.4 + Math.random() * 1.6, 2 + Math.random() * 2.4);
    }
    rock.position.set(Math.cos(a) * r, terrainHeight(r) - 0.3, Math.sin(a) * r);
    rock.rotation.set(Math.random() * 0.4, Math.random() * Math.PI * 2, Math.random() * 0.4);
    forest.add(rock);
  }

  scene.add(forest);

  // ---- energy dome (transparent geodesic shell over the pond) ----
  buildDome();

  // ---- observation platform ring (tourist walkway at terrain edge) ----
  buildPlatform();

  // ---- fireflies drifting over the water ----
  if (HQ) buildFireflies();
}

// ===== ENERGY DOME =====
// A transparent geodesic dome that encloses the pond — visible as a faint
// energy lattice with a subtle pulse. Gives the "space terrarium" feel.
function buildDome() {
  const DOME_R = R_WATER * 2.4;
  const domeGeo = new THREE.IcosahedronGeometry(DOME_R, 3);
  const edges = new THREE.EdgesGeometry(domeGeo);
  const domeMat = new THREE.LineBasicMaterial({
    color: 0x4fd9ff,
    transparent: true,
    opacity: 0.12,
    fog: false,
  });
  const dome = new THREE.LineSegments(edges, domeMat);
  dome.position.y = 0;
  scene.add(dome);

  // inner translucent shell — very faint, just enough to catch light
  const shellMat = new THREE.MeshBasicMaterial({
    color: 0x1a4a6a,
    transparent: true,
    opacity: 0.04,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
  const shell = new THREE.Mesh(domeGeo, shellMat);
  scene.add(shell);

  // glowing equator ring
  const ringGeo = new THREE.TorusGeometry(DOME_R, 0.3, 8, 80);
  ringGeo.rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x4fd9ff, transparent: true, opacity: 0.3, fog: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  scene.add(ring);

  // store for animation
  window.__dome = { mat: domeMat, shellMat, ringMat };
}

// ===== OBSERVATION PLATFORM =====
// A circular walkway at the terrain edge with railing — like a tourist
// viewing deck overlooking the pond from inside the dome.
function buildPlatform() {
  const platR = R_WATER * 1.06;
  const platW = 6;

  // walkway surface
  const walkGeo = new THREE.RingGeometry(platR, platR + platW, 80, 2);
  walkGeo.rotateX(-Math.PI / 2);
  const walkMat = stdMat(0x3a4a5a, { roughness: 0.6, metalness: 0.3, flatShading: true });
  const walk = new THREE.Mesh(walkGeo, walkMat);
  walk.position.y = terrainHeight(platR) + 0.5;
  scene.add(walk);

  // glowing edge strips
  const edgeInGeo = new THREE.RingGeometry(platR - 0.2, platR + 0.2, 80, 1);
  edgeInGeo.rotateX(-Math.PI / 2);
  const edgeOutGeo = new THREE.RingGeometry(platR + platW - 0.2, platR + platW + 0.2, 80, 1);
  edgeOutGeo.rotateX(-Math.PI / 2);
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x4fd9ff, transparent: true, opacity: 0.5, fog: false });
  const edgeIn = new THREE.Mesh(edgeInGeo, edgeMat);
  edgeIn.position.y = walk.position.y + 0.06;
  scene.add(edgeIn);
  const edgeOut = new THREE.Mesh(edgeOutGeo, edgeMat);
  edgeOut.position.y = walk.position.y + 0.06;
  scene.add(edgeOut);

  // railing posts + top rail
  const railH = 1.8;
  const postGeo = new THREE.CylinderGeometry(0.06, 0.06, railH, 4);
  const railMat = stdMat(0x6a7a8a, { roughness: 0.4, metalness: 0.5 });
  const postCount = 40;
  for (let i = 0; i < postCount; i++) {
    const a = (i / postCount) * Math.PI * 2;
    // inner rail
    const px = Math.cos(a) * platR, pz = Math.sin(a) * platR;
    const post = new THREE.Mesh(postGeo, railMat);
    post.position.set(px, walk.position.y + railH / 2, pz);
    scene.add(post);
    // outer rail
    const px2 = Math.cos(a) * (platR + platW), pz2 = Math.sin(a) * (platR + platW);
    const post2 = new THREE.Mesh(postGeo, railMat);
    post2.position.set(px2, walk.position.y + railH / 2, pz2);
    scene.add(post2);
  }
  // top rail rings (torus)
  const railInGeo = new THREE.TorusGeometry(platR, 0.05, 6, 80);
  railInGeo.rotateX(Math.PI / 2);
  const railIn = new THREE.Mesh(railInGeo, railMat);
  railIn.position.y = walk.position.y + railH;
  scene.add(railIn);
  const railOutGeo = new THREE.TorusGeometry(platR + platW, 0.05, 6, 80);
  railOutGeo.rotateX(Math.PI / 2);
  const railOut = new THREE.Mesh(railOutGeo, railMat);
  railOut.position.y = walk.position.y + railH;
  scene.add(railOut);

  // support pillars down to terrain
  const pillarGeo = new THREE.CylinderGeometry(0.15, 0.2, 1, 6);
  const pillarMat = stdMat(0x2a3a4a, { roughness: 0.7, metalness: 0.3, flatShading: true });
  const pillarCount = 16;
  for (let i = 0; i < pillarCount; i++) {
    const a = (i / pillarCount) * Math.PI * 2;
    const px = Math.cos(a) * (platR + platW / 2), pz = Math.sin(a) * (platR + platW / 2);
    const gy = terrainHeight(Math.hypot(px, pz));
    const ph = walk.position.y - gy;
    if (ph > 0.5) {
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.scale.y = ph;
      pillar.position.set(px, gy + ph / 2, pz);
      scene.add(pillar);
    }
  }
}

function buildFireflies() {
  const count = 70;
  const g = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const base = [];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * R_WATER * 0.95;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, y = 2 + Math.random() * 16;
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    base.push({ x, y, z, px: Math.random() * 6.28, py: Math.random() * 6.28, pz: Math.random() * 6.28, sp: 0.4 + Math.random() * 0.8 });
  }
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const sprite = makeGlowSprite();
  const mat = new THREE.PointsMaterial({
    color: 0xffe7a0, size: 2.2, map: sprite, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const pts = new THREE.Points(g, mat);
  pts.renderOrder = 5;
  scene.add(pts);
  fireflyState = { pts, positions, base, count, geo: g };
}

// tiny radial-gradient texture for soft glowing points
function makeGlowSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const cx = c.getContext('2d');
  const grd = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,240,180,0.85)');
  grd.addColorStop(1, 'rgba(255,220,120,0)');
  cx.fillStyle = grd; cx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function updateFireflies(t) {
  if (!fireflyState) return;
  const { positions, base, count, geo } = fireflyState;
  for (let i = 0; i < count; i++) {
    const b = base[i];
    positions[i * 3] = b.x + Math.sin(t * b.sp + b.px) * 3.0;
    positions[i * 3 + 1] = b.y + Math.sin(t * b.sp * 0.7 + b.py) * 1.8;
    positions[i * 3 + 2] = b.z + Math.cos(t * b.sp + b.pz) * 3.0;
  }
  geo.attributes.position.needsUpdate = true;
  fireflyState.pts.material.opacity = 0.6 + Math.sin(t * 1.3) * 0.25;
}

// ===================================================================
// INPUT — raycast taps create actions; drags orbit the camera
// ===================================================================
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let currentTool = 'wave';

function screenToGame(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(waterPlane, hit)) return null;
  return { x: clamp(hit.x / SCALE + W / 2, 0, W), y: clamp(hit.z / SCALE + H / 2, 0, H) };
}

let pDownX = 0, pDownY = 0, pDownT = 0, pMoved = false;
let hasInteracted = false;
function hideHintOnce() {
  if (hasInteracted) return;
  hasInteracted = true;
  const hint = document.getElementById('hint');
  if (hint) hint.style.opacity = '0';
}

canvas.addEventListener('pointerdown', (e) => {
  pDownX = e.clientX; pDownY = e.clientY; pDownT = performance.now(); pMoved = false;
});
canvas.addEventListener('pointermove', (e) => {
  if (Math.hypot(e.clientX - pDownX, e.clientY - pDownY) > 8) pMoved = true;
});
canvas.addEventListener('pointerup', (e) => {
  const elapsed = performance.now() - pDownT;
  if (pMoved || elapsed > 450) return; // it was a camera drag
  const p = screenToGame(e.clientX, e.clientY);
  if (!p) return;
  disturbWater(p.x, p.y, 8, 120);
  doAction(p.x, p.y);
  hideHintOnce();
});

function doAction(x, y) {
  switch (currentTool) {
    case 'wave':
      if (waveReady) {
        const splashAngle = Math.random() * Math.PI * 2;
        addWave(x, y, { splashAngle });
        triggerWaveCooldown();
        incrementStat('totalWaves');
        sendAction({ type: 'wave', x: normX(x), y: normY(y), splashAngle });
      }
      break;
    case 'fish':
      addCreature('fish', x, y);
      incrementStat('totalFish');
      sendAction({ type: 'creature', creatureType: 'fish', x: normX(x), y: normY(y) });
      break;
    case 'frog':
      addCreature('frog', x, y);
      incrementStat('totalFrogs');
      sendAction({ type: 'creature', creatureType: 'frog', x: normX(x), y: normY(y) });
      break;
    case 'dragonfly':
      addCreature('dragonfly', x, y);
      incrementStat('totalDragonflies');
      sendAction({ type: 'creature', creatureType: 'dragonfly', x: normX(x), y: normY(y) });
      break;
    case 'lily':
      if (addLily(x, y)) {
        incrementStat('totalLilies');
        sendAction({ type: 'lily', x: normX(x), y: normY(y) });
      }
      break;
  }
}

// ===== TOOLBAR =====
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => { currentTool = btn.dataset.tool; updateToolButtons(); });
});
function updateToolButtons() {
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === currentTool));
}
updateToolButtons();

// ===== WAVE COOLDOWN =====
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
  if (pct >= 1) { waveReady = true; cooldownBar.classList.remove('visible'); cooldownFill.classList.add('ready'); }
}
function triggerWaveCooldown() { waveReady = false; waveCooldownStart = Date.now(); }

// ===================================================================
// EVENT SYSTEM
// ===================================================================
const eventBanner = document.getElementById('event-banner');
let currentEvent = null;
let currentEventStart = 0;
const EVENT_DURATION = 10;
let nextEventTime = Date.now() + 30000 + Math.random() * 30000;

const EVENT_TYPES = [
  { id: 'catch_flies', text: 'A swarm of flies appears!', spawn: () => { for (let i = 0; i < 8; i++) addCreature('dragonfly', Math.random() * W, Math.random() * H); } },
  { id: 'big_fish', text: 'A legendary fish surfaces...', legendary: true, spawn: () => { addCreature('fish', Math.random() * W, Math.random() * H, { tier: 3 }); } },
  { id: 'frog_party', text: 'Frogs are gathering!', spawn: () => { for (let i = 0; i < 4; i++) addCreature('frog', Math.random() * W, Math.random() * H); } },
  { id: 'lily_bloom', text: 'Lily pads are blooming!', spawn: () => { for (let i = 0; i < 5; i++) addLily(Math.random() * W, Math.random() * H); } },
  { id: 'bird_strike', text: 'BIRDS INCOMING — frogs and fish beware!', spawn: () => { spawnBirdBarrage(); } },
];

function showEventBanner(evt, seconds) {
  eventBanner.classList.toggle('legendary', !!evt.legendary);
  eventBanner.innerHTML = `${escapeHtml(evt.text)} <span class="event-timer">${seconds}s</span>`;
  eventBanner.classList.add('visible');
}

function updateEvents() {
  if (currentEvent) {
    const elapsed = (Date.now() - currentEventStart) / 1000;
    const remaining = Math.max(0, EVENT_DURATION - elapsed);
    if (remaining <= 0) {
      currentEvent = null;
      eventBanner.classList.remove('visible');
      nextEventTime = Date.now() + 30000 + Math.random() * 30000;
    } else {
      showEventBanner(currentEvent, Math.ceil(remaining));
    }
  } else if (Date.now() > nextEventTime) {
    const evt = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
    currentEvent = evt;
    currentEventStart = Date.now();
    evt.spawn();
    showEventBanner(evt, EVENT_DURATION);
    addToast('the pond', evt.text.toLowerCase().replace(/[.!]+$/, ''), 'event');
    sendAction({ type: 'event', eventId: evt.id });
  }
}

// ===== BIRD BARRAGE =====
function spawnBirdBarrage() {
  const frogs = creatures.filter(c => c.type === 'frog' && c.life > 0.3);
  const fish = creatures.filter(c => c.type === 'fish' && c.life > 0.3 && !c.isPlayer);
  const allTargets = [...frogs, ...fish];
  if (allTargets.length === 0) return;
  const shuffled = allTargets.sort(() => Math.random() - 0.5);
  const birdCount = Math.min(shuffled.length * 2, 6 + Math.floor(Math.random() * 10));
  for (let i = 0; i < birdCount; i++) {
    if (birds.length >= MAX_BIRDS) break;
    setTimeout(() => { if (birds.length < MAX_BIRDS) birds.push(new Bird3D(shuffled[i % shuffled.length])); }, i * 150);
  }
}

function maybeSpawnRandomBirds() {
  const frogs = creatures.filter(c => c.type === 'frog' && c.life > 0.3);
  const fish = creatures.filter(c => c.type === 'fish' && c.life > 0.3 && !c.isPlayer);
  if (frogs.length + fish.length < 2) return;
  if (Math.random() < 0.008) { spawnBirdBarrage(); sendAction({ type: 'birds' }); }
}

// ===================================================================
// RED BUTTON + WAVE POOL
// ===================================================================
let redButtonEl = null;
let wavePoolActive = false;
let wavePoolTimer = 0;
const wavePoolBanner = document.getElementById('wave-pool-banner');

function updateRedButton() {
  if (!redButtonEl && !wavePoolActive && Math.random() < 0.000167) spawnRedButton();
  if (wavePoolActive) {
    wavePoolTimer -= 1;
    waterUniforms.uWavePool.value = Math.min(1, waterUniforms.uWavePool.value + 0.05);
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
    if (wavePoolTimer <= 0) { wavePoolActive = false; wavePoolBanner.classList.remove('visible'); }
  } else if (waterUniforms.uWavePool.value > 0) {
    waterUniforms.uWavePool.value = Math.max(0, waterUniforms.uWavePool.value - 0.03);
  }
}

function spawnRedButton() {
  redButtonEl = document.createElement('div');
  redButtonEl.id = 'red-button';
  const margin = 90;
  redButtonEl.style.left = (margin + Math.random() * (window.innerWidth - margin * 2 - 52)) + 'px';
  redButtonEl.style.top = (margin + Math.random() * (window.innerHeight - margin * 2 - 52)) + 'px';
  redButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    activateWavePool();
    if (redButtonEl) { redButtonEl.remove(); redButtonEl = null; }
    sendAction({ type: 'wavepool' });
  });
  document.body.appendChild(redButtonEl);
  setTimeout(() => { if (redButtonEl) { redButtonEl.remove(); redButtonEl = null; } }, 15000);
}

function activateWavePool() {
  wavePoolActive = true;
  wavePoolTimer = 600;
  wavePoolBanner.classList.add('visible');
}

// ===================================================================
// WEBSOCKET CLIENT  (same protocol as the 2D pond)
// ===================================================================
let ws = null;
let wsConnected = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let useFallbackURL = false;
let myUserId = null;
let myUserName = '';
const onlineCountEl = document.getElementById('online-count');

function connectWS() {
  const url = useFallbackURL ? WS_URL_FALLBACK : WS_URL;
  let opened = false;
  try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }

  const connectTimeout = setTimeout(() => { if (!wsConnected) { try { ws.close(); } catch (e) {} } }, 8000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    opened = true; wsConnected = true; reconnectAttempts = 0;
    onlineCountEl.textContent = 'connected';
  };
  ws.onmessage = (event) => { try { handleMessage(JSON.parse(event.data)); } catch (e) {} };
  ws.onclose = () => {
    clearTimeout(connectTimeout);
    wsConnected = false;
    if (!opened) useFallbackURL = !useFallbackURL;
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > 10) { onlineCountEl.textContent = 'offline — solo mode'; return; }
  const delay = IS_MOBILE ? 4000 : 2500;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, delay);
}

function sendAction(action) {
  if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(action)); } catch (e) {}
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      applySnapshot(msg.state);
      if (msg.you) {
        myUserId = msg.you.id;
        myUserName = msg.you.name;
        if (!myFish) spawnPlayerFish();
      }
      if (msg.users) renderUserList(msg.users);
      break;
    case 'action':
      applyRemoteAction(msg.action);
      if (msg.action.actorName) addToast(msg.action.actorName, describeAction(msg.action), 'action');
      break;
    case 'presence':
      onlineCountEl.textContent = `${msg.count} ${msg.count === 1 ? 'soul' : 'souls'} in the pond`;
      break;
    case 'join':
      addToast(msg.user.name, 'joined the pond', 'join');
      break;
    case 'leave':
      addToast(msg.name, 'left the pond', 'leave');
      break;
    case 'users':
      renderUserList(msg.users);
      break;
  }
}

function applySnapshot(state) {
  if (state.creatures) {
    state.creatures.slice(-20).forEach(c => {
      addCreature(c.type, denormX(c.x), denormY(c.y), c.tier !== undefined ? { tier: c.tier } : undefined, true);
    });
  }
  if (state.lilies) {
    state.lilies.slice(-15).forEach(l => addLily(denormX(l.x), denormY(l.y), true));
  }
}

function applyRemoteAction(action) {
  const x = action.x !== undefined ? denormX(action.x) : 0;
  const y = action.y !== undefined ? denormY(action.y) : 0;
  switch (action.type) {
    case 'wave': addWave(x, y, { splashAngle: action.splashAngle }); break;
    case 'creature': addCreature(action.creatureType, x, y); break;
    case 'lily': addLily(x, y); break;
    case 'event': {
      const evt = EVENT_TYPES.find(e => e.id === action.eventId);
      if (evt) { currentEvent = evt; currentEventStart = Date.now(); evt.spawn(); showEventBanner(evt, EVENT_DURATION); }
      break;
    }
    case 'wavepool': activateWavePool(); break;
    case 'birds': spawnBirdBarrage(); break;
  }
}

function spawnPlayerFish() {
  const x = W * 0.5 + (Math.random() - 0.5) * 100;
  const y = H * 0.5 + (Math.random() - 0.5) * 100;
  const fish = new Fish3D(x, y, undefined, true);
  fish.setPlayer(myUserName || 'you');
  creatures.push(fish);
  myFish = fish; isDead = false;
  respawnBanner.classList.remove('visible');
  ripples.push(new Ripple3D(x, y, { maxRadius: 50 }));
}

const CREATURE_EMOJI = { fish: '\ud83d\udc1f', frog: '\ud83d\udc38', dragonfly: '\ud83e\udeb0', lily: '\ud83c\udf3f' };
function describeAction(action) {
  switch (action.type) {
    case 'wave': return 'made a wave';
    case 'creature': return `spawned a ${CREATURE_EMOJI[action.creatureType] || action.creatureType}`;
    case 'lily': return 'planted a lily pad';
    case 'event': return 'triggered an event';
    case 'wavepool': return 'pressed the red button!';
    case 'birds': return 'summoned birds!';
    default: return action.type;
  }
}

// ===================================================================
// TOASTS (replace the 2D feed)
// ===================================================================
const toastContainer = document.getElementById('toast-container');
const MAX_TOASTS = 5;

function addToast(name, action, type) {
  const cls = type === 'action' ? 'action-type' : (type || 'action-type');
  const t = document.createElement('div');
  t.className = `toast toast-${cls}`;
  t.innerHTML = `<span class="toast-name">${escapeHtml(name)}</span> <span class="toast-action">${escapeHtml(action)}</span>`;
  toastContainer.appendChild(t);
  while (toastContainer.children.length > MAX_TOASTS) toastContainer.removeChild(toastContainer.firstChild);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 420); }, 4200);
}

// ===================================================================
// RETENTION — session timer, daily streak, lifetime stats, achievements
// ===================================================================
let sessionStart = Date.now();
let sessionTimerHandle = null;

function startSessionTimer() {
  const el = document.getElementById('session-timer');
  if (sessionTimerHandle) clearInterval(sessionTimerHandle);
  sessionTimerHandle = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    if (el) el.textContent = `${mm}:${ss}`;
    // accrue lifetime time every 5s to limit writes
    if (elapsed > 0 && elapsed % 5 === 0) {
      const s = loadStats();
      s.totalTimeSeconds = (s.totalTimeSeconds || 0) + 5;
      saveStats(s);
      checkAchievements(s);
    }
  }, 1000);
}

function checkStreak() {
  const today = new Date().toDateString();
  let data; try { data = JSON.parse(localStorage.getItem('pond_streak') || '{}'); } catch (e) { data = {}; }
  if (data.lastVisit === today) return data.streak || 1;
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const streak = data.lastVisit === yesterday ? (data.streak || 0) + 1 : 1;
  localStorage.setItem('pond_streak', JSON.stringify({ lastVisit: today, streak }));
  return streak;
}

function loadStats() { try { return JSON.parse(localStorage.getItem('pond_stats') || '{}'); } catch (e) { return {}; } }
function saveStats(s) { try { localStorage.setItem('pond_stats', JSON.stringify(s)); } catch (e) {} }
function incrementStat(key) {
  const s = loadStats();
  s[key] = (s[key] || 0) + 1;
  saveStats(s);
  checkAchievements(s);
  if (userPanel.classList.contains('visible')) renderStats(s);
}

const ACHIEVEMENTS = [
  { id: 'first_wave', name: 'First Wave', ico: '🌊', check: s => (s.totalWaves || 0) >= 1 },
  { id: 'pond_keeper', name: 'Pond Keeper', ico: '🌿', check: s => (s.totalLilies || 0) >= 10 },
  { id: 'fish_farmer', name: 'Fish Farmer', ico: '🐟', check: s => (s.totalFish || 0) >= 25 },
  { id: 'frog_friend', name: 'Frog Friend', ico: '🐸', check: s => (s.totalFrogs || 0) >= 10 },
  { id: 'pond_regular', name: 'Pond Regular', ico: '🔥', check: s => (s.streak || 0) >= 3 },
  { id: 'deep_diver', name: 'Deep Diver', ico: '🤿', check: s => (s.totalTimeSeconds || 0) >= 1800 },
];

function loadUnlocked() { try { return JSON.parse(localStorage.getItem('pond_achievements') || '[]'); } catch (e) { return []; } }
function checkAchievements(stats) {
  const unlocked = loadUnlocked();
  let changed = false;
  for (const a of ACHIEVEMENTS) {
    if (!unlocked.includes(a.id) && a.check(stats)) {
      unlocked.push(a.id); changed = true;
      addToast('achievement', `unlocked · ${a.name}`, 'event');
    }
  }
  if (changed) {
    localStorage.setItem('pond_achievements', JSON.stringify(unlocked));
    renderAchievements();
  }
}

// ===================================================================
// USER / PROFILE PANEL
// ===================================================================
const userPanel = document.getElementById('user-panel');
const panelBackdrop = document.getElementById('panel-backdrop');
const userListEl = document.getElementById('user-list');
const userPanelClose = document.getElementById('user-panel-close');
let lastUsers = [];

function renderStreak() {
  const el = document.getElementById('panel-streak');
  let data; try { data = JSON.parse(localStorage.getItem('pond_streak') || '{}'); } catch (e) { data = {}; }
  const streak = data.streak || 1;
  el.innerHTML = `
    <span class="streak-flame">🔥</span>
    <span class="streak-info">
      <span class="streak-count">${streak}</span>
      <span class="streak-label">day${streak === 1 ? '' : 's'} in a row</span>
    </span>`;
}

function renderStats(s) {
  s = s || loadStats();
  const el = document.getElementById('panel-stats');
  const mins = Math.floor((s.totalTimeSeconds || 0) / 60);
  const pills = [
    ['🌊', s.totalWaves || 0, 'waves'],
    ['🐟', s.totalFish || 0, 'fish'],
    ['🐸', s.totalFrogs || 0, 'frogs'],
    ['🌿', s.totalLilies || 0, 'lilies'],
    ['🪰', s.totalDragonflies || 0, 'flies'],
    ['⏱', mins, 'min'],
  ];
  el.innerHTML = pills.map(([i, v, n]) =>
    `<div class="stat-pill"><span class="stat-value">${v}</span><span class="stat-name">${i} ${n}</span></div>`
  ).join('');
}

function renderAchievements() {
  const el = document.getElementById('panel-achievements');
  const unlocked = loadUnlocked();
  el.innerHTML = ACHIEVEMENTS.map(a => {
    const on = unlocked.includes(a.id);
    return `<div class="achv-pill ${on ? 'unlocked' : ''}"><span class="achv-ico">${a.ico}</span>${escapeHtml(a.name)}</div>`;
  }).join('');
}

function renderUserList(users) {
  if (users) lastUsers = users;
  userListEl.innerHTML = '';
  lastUsers.forEach(u => {
    const row = document.createElement('div');
    row.className = 'user-row' + (u.id === myUserId ? ' me' : '');
    const counts = u.counts || {};
    const stats = [];
    if (counts.wave) stats.push(`🌊 ${counts.wave}`);
    if (counts.fish) stats.push(`🐟 ${counts.fish}`);
    if (counts.frog) stats.push(`🐸 ${counts.frog}`);
    if (counts.dragonfly) stats.push(`🪰 ${counts.dragonfly}`);
    if (counts.lily) stats.push(`🌿 ${counts.lily}`);
    const statsHtml = stats.length ? stats.join(' ') : 'just watching';
    const avatar = (u.name || '?').charAt(0).toUpperCase();
    row.innerHTML = `
      <div class="user-avatar">${escapeHtml(avatar)}</div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(u.name)}${u.id === myUserId ? ' (you)' : ''}</div>
        <div class="user-stats">${statsHtml}</div>
      </div>`;
    userListEl.appendChild(row);
  });
}

function renderUserPanel() { renderStreak(); renderStats(); renderAchievements(); renderUserList(); }

function openPanel() { renderUserPanel(); userPanel.classList.add('visible'); panelBackdrop.classList.add('visible'); }
function closePanel() { userPanel.classList.remove('visible'); panelBackdrop.classList.remove('visible'); }

onlineCountEl.addEventListener('click', (e) => { e.stopPropagation(); userPanel.classList.contains('visible') ? closePanel() : openPanel(); });
userPanelClose.addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });
panelBackdrop.addEventListener('click', closePanel);

// respawn button
document.getElementById('respawn-btn').addEventListener('click', () => {
  if (!isDead && myFish) return;
  spawnPlayerFish();
  if (myFish) sendAction({ type: 'creature', creatureType: 'fish', x: normX(myFish.x), y: normY(myFish.y) });
});

// ===================================================================
// RIDE-ALONG CAMERA — press C to follow your fish, C again for orbit
// ===================================================================
let cameraMode = 'orbit';
const _camLook = new THREE.Vector3(0, 0, 0);
const _camTarget = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
const _fwd = new THREE.Vector3();
let camHintEl = null;

function setCamHint(text, active) {
  if (!camHintEl) {
    camHintEl = document.createElement('div');
    camHintEl.id = 'cam-hint';
    document.body.appendChild(camHintEl);
  }
  camHintEl.textContent = text;
  camHintEl.classList.toggle('active', !!active);
}

function setCameraMode(mode) {
  if (mode === 'follow') {
    if (!myFish) spawnPlayerFish();   // give the rider a fish if they have none
    if (!myFish) return;
    cameraMode = 'follow';
    controls.enabled = false;
    controls.autoRotate = false;
    _camLook.copy(controls.target);
    setCamHint('riding your fish · press C for orbit view', true);
  } else {
    cameraMode = 'orbit';
    controls.enabled = true;
    controls.target.set(0, 0, 0);
    lastInteract = performance.now();
    setCamHint('press C to ride your fish', false);
  }
}

function updateFollowCamera() {
  const fx = toWorldX(myFish.x), fz = toWorldZ(myFish.y);
  const depth = -(1.5 + myFish.tier * 1.25);
  const a = myFish.angle;
  _fwd.set(Math.cos(a), 0, Math.sin(a));
  const fishLen = myFish.size * myFish.growthScale * SCALE * VISUAL;
  const back = 6 + fishLen * 2.4;
  const up = 2.4 + fishLen * 0.8;
  _camDesired.set(fx - _fwd.x * back, depth + up, fz - _fwd.z * back);
  camera.position.lerp(_camDesired, 0.09);
  _camTarget.set(fx + _fwd.x * 4, depth + 0.3, fz + _fwd.z * 4);
  _camLook.lerp(_camTarget, 0.12);
  camera.lookAt(_camLook);
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key && e.key.toLowerCase() === 'c') {
    setCameraMode(cameraMode === 'follow' ? 'orbit' : 'follow');
  }
});

// ===================================================================
// MAIN LOOP
// ===================================================================
let lastTime = performance.now();
let frameCount = 0;

function animate() {
  requestAnimationFrame(animate);
  try {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 16.67, 3);
    lastTime = now;
    frameCount++;

    const t = waterUniforms.uTime.value += 0.016 * dt;

    // animate space skybox
    if (window.__skyShader) window.__skyShader.uniforms.uTime.value = t;

    // animate dome pulse
    if (window.__dome) {
      const p = 0.10 + 0.04 * Math.sin(t * 0.8);
      window.__dome.mat.opacity = p;
      window.__dome.shellMat.opacity = 0.03 + 0.02 * Math.sin(t * 0.6);
      window.__dome.ringMat.opacity = 0.25 + 0.08 * Math.sin(t * 1.2);
    }

    // animate billboard grass: face camera + wind sway
    if (window.__grassBlades) {
      const blades = window.__grassBlades;
      const camPos = camera.position;
      for (let i = 0; i < blades.length; i++) {
        const b = blades[i];
        // face camera (billboard Y rotation only)
        const dx = camPos.x - b.position.x;
        const dz = camPos.z - b.position.z;
        b.rotation.y = Math.atan2(dx, dz) + b.userData.baseRot * 0.3;
        // wind sway — subtle z rotation oscillation
        if (!b.userData.isBush) {
          b.rotation.z = Math.sin(t * 1.5 + b.userData.phase) * b.userData.swayAmt;
        }
      }
    }

    lilies = lilies.filter(l => { const a = l.update(); if (a) l.sync3D(); else l.destroy(); return a; });
    ripples = ripples.filter(r => { const a = r.update(); if (a) r.sync3D(); else r.destroy(); return a; });
    creatures = creatures.filter(c => { const a = c.update(dt); if (a) c.sync3D(dt); else c.destroy(); return a; });

    if (myFish && (myFish.life <= 0 || !creatures.includes(myFish))) {
      myFish = null; isDead = true; respawnBanner.classList.add('visible');
    }

    birds = birds.filter(b => { const a = b.update(dt); if (a) b.sync3D(); else b.destroy(); return a; });
    waves = waves.filter(w => { const a = w.update(dt); if (a) w.sync3D(); else w.destroy(); return a; });

    if (frameCount % 2 === 0) updateCooldown();
    if (frameCount % 4 === 0) updateEvents();
    if (frameCount % 4 === 0) updateRedButton();
    if (frameCount % 60 === 0) maybeSpawnRandomBirds();

    updateFireflies(waterUniforms.uTime.value);

    if (cameraMode === 'follow') {
      if (myFish) updateFollowCamera();
      else setCameraMode('orbit'); // fish died — drop back to orbit
    } else {
      // resume gentle auto-rotate after a period of no interaction
      if (!controls.autoRotate && now - lastInteract > 6000) controls.autoRotate = true;
      controls.update();
    }
    renderer.render(scene, camera);
  } catch (e) { /* keep the loop alive */ }
}

// ===================================================================
// SEED + INIT
// ===================================================================
function seedInitialLife() {
  if (creatures.length === 0 && lilies.length === 0) {
    addLily(W * 0.25, H * 0.65, true);
    addLily(W * 0.72, H * 0.38, true);
    addLily(W * 0.5, H * 0.75, true);
    addCreature('fish', W * 0.5, H * 0.5, undefined, true);
    addCreature('fish', W * 0.4, H * 0.6, undefined, true);
    addCreature('fish', W * 0.65, H * 0.55, undefined, true);
    addCreature('fish', W * 0.3, H * 0.4, { tier: 1 }, true);
    addCreature('dragonfly', W * 0.6, H * 0.3, undefined, true);
    addCreature('dragonfly', W * 0.7, H * 0.25, undefined, true);
    addCreature('frog', W * 0.3, H * 0.7, undefined, true);
  }
  // offline/solo: give the player their own fish to ride (online players
  // receive theirs from the server snapshot instead)
  if (!myFish && !wsConnected) spawnPlayerFish();
}

function init() {
  buildEnvironment();

  // retention setup
  const streak = checkStreak();
  const s = loadStats();
  s.streak = streak;
  saveStats(s);
  renderUserPanel();
  checkAchievements(s);
  startSessionTimer();
  setCamHint('press C to ride your fish', false);

  connectWS();

  // fall back to a lively pond if the socket is slow/offline
  setTimeout(seedInitialLife, 1500);

  animate();

  // reveal the scene
  setTimeout(() => {
    const ls = document.getElementById('loading-screen');
    if (ls) ls.classList.add('hidden');
  }, 700);
}

// Load GLB assets (procedural fallback on any failure), then start.
Promise.all(Object.entries(ASSETS).map(([k, v]) => loadAsset(k, v))).then(init);
