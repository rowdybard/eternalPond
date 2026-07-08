/* ===================================================================
   eternal pond — 3D engine (pond3d.js)
   Three.js r128. All game logic ported from the 2D pond.js:
   AI, eating, events, WebSocket protocol, player fish, red button,
   wave pool. Canvas-2D rendering is replaced by Three.js meshes.
   GLB models are loaded if present in assets/, otherwise the
   engine falls back to high-quality procedural meshes.
=================================================================== */

// ===== BOOT GUARD =====
// If the Three.js CDN failed to load there is no pond to render — swap the
// loading screen into a gentle failure state instead of hanging forever.
if (typeof THREE === 'undefined') {
  const st = document.querySelector('#loading-screen .loading-status');
  const bar = document.querySelector('#loading-screen .loading-bar');
  if (st) st.textContent = 'the pond could not wake — check your connection and refresh';
  if (bar) bar.style.display = 'none';
  throw new Error('three.js failed to load');
}

// ===== LOADING SCREEN =====
// Cycle quiet status phrases while assets stream in, so a slow network reads
// as intentional rather than broken. Cleared by hideLoadingScreen().
const LOADING_PHRASES = ['summoning the water…', 'growing the reeds…', 'waking the fish…', 'raising the dome…', 'joining the shared pond…'];
let loadingPhraseIdx = 0;
const loadingPhraseTimer = setInterval(() => {
  const st = document.querySelector('#loading-screen .loading-status');
  if (!st) return;
  loadingPhraseIdx = (loadingPhraseIdx + 1) % LOADING_PHRASES.length;
  st.textContent = LOADING_PHRASES[loadingPhraseIdx];
}, 1100);

function hideLoadingScreen() {
  clearInterval(loadingPhraseTimer);
  const ls = document.getElementById('loading-screen');
  if (ls) ls.classList.add('hidden');
}

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
const WAVE_COOLDOWN = 800;
const WAVE_COOLUP = 200;
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

// ===== SPAWN / PLAY-AREA MAPPING =====
// Positions are mapped game->world by POS_SCALE, which is DECOUPLED from SCALE
// (SCALE still governs creature/effect SIZES). POS_SCALE makes the logical game
// disc fill the pond so creatures spawn & roam across ~95% of the water instead
// of clustering in the central ~65%. The pond, terrain, forest, dome, buildings
// and celestials are all built in world units and are completely unaffected.
const POS_SCALE = R_WATER / (W / 2);   // game radius 500 -> R_WATER  (~0.263)
const FILL_R_WORLD = R_WATER * 0.95;   // outermost fillable radius (surface things)
const PLAY_CX = W / 2, PLAY_CY = H / 2;

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

// ===== POND-DISC HELPERS =====
// game-space distance from the pond centre
function gameRadius(x, y) { return Math.hypot(x - PLAY_CX, y - PLAY_CY); }

// Clamp a game point to within `maxWorldR` (world units) of the pond centre.
// Returns a {x,y} game point that maps inside the water disc.
function clampToPond(x, y, maxWorldR) {
  const maxGameR = (maxWorldR != null ? maxWorldR : FILL_R_WORLD) / POS_SCALE;
  const r = Math.hypot(x - PLAY_CX, y - PLAY_CY);
  if (r <= maxGameR || r < 1e-6) return { x, y };
  const k = maxGameR / r;
  return { x: PLAY_CX + (x - PLAY_CX) * k, y: PLAY_CY + (y - PLAY_CY) * k };
}

// Uniform-by-area random game point within the fillable pond disc.
function randomPondPoint(maxWorldR) {
  const maxGameR = (maxWorldR != null ? maxWorldR : FILL_R_WORLD) / POS_SCALE;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * maxGameR;
  return { x: PLAY_CX + Math.cos(a) * r, y: PLAY_CY + Math.sin(a) * r };
}

// Largest WORLD radius where the pond bottom stays at least `clearance` below a
// swimmer at world-Y `swimDepthY`, so it never clips the rising shore. The bowl
// bottom is monotonic past R_PLAY, so a short binary search inverts it.
function maxSwimWorldR(swimDepthY, clearance) {
  const target = swimDepthY - clearance;           // terrainHeight(r) must be <= target
  if (terrainHeight(FILL_R_WORLD) <= target) return FILL_R_WORLD;
  if (terrainHeight(0) > target) return R_PLAY * 0.5; // degenerate guard
  let lo = 0, hi = FILL_R_WORLD;
  for (let i = 0; i < 22; i++) { const mid = (lo + hi) * 0.5; if (terrainHeight(mid) <= target) lo = mid; else hi = mid; }
  return lo;
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
function toWorldX(x) { return (x - W / 2) * POS_SCALE; }
function toWorldZ(y) { return (y - H / 2) * POS_SCALE; }

// ===== THREE.JS CORE =====
const canvas = document.getElementById('pond3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW_QUALITY ? 1.0 : 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // filmic rolloff keeps bright celestials from clipping
renderer.toneMappingExposure = 1.0;                 // neutral — a lift here compounds water glare

const scene = new THREE.Scene();
const FOG_COLOR = 0x0a0a18;
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0016);
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
controls.panSpeed = 1.0;
controls.screenSpacePanning = false; // pan along the ground plane, not the screen plane
controls.minDistance = 40;
controls.maxDistance = 320;
controls.minPolarAngle = 0.18;
controls.maxPolarAngle = 1.46; // stop just above the horizon — never go underwater
controls.autoRotate = true;
controls.autoRotateSpeed = 0.28;
controls.rotateSpeed = 0.65;
if (controls.touches) controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

// Panning uses Three's built-in ground pan (controls.screenSpacePanning is
// set false above): pixel movement is converted to world units via the
// camera->target distance + FOV, then the target slides along the camera's
// ground-projected right/forward axes. This is stable at every camera angle —
// including near-horizontal — and replaces the old Y=0 plane raycast, whose
// rays grazed the plane at shallow angles and flung the target thousands of
// units away. The one path serves desktop right-drag and two-finger touch.
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Constrain the pan target to a flat disc and keep the camera inside the dome.
const PAN_RADIUS = R_WATER * 1.2;
const DOME_R = R_WATER * 2.4;
const _domeR = DOME_R * 0.92;
const _domeDir = new THREE.Vector3();
controls.addEventListener('change', () => {
  // lock the target to the ground and clamp it to a horizontal disc. Move the
  // camera by the same delta so the orbit offset is preserved — holding an
  // outward drag at the boundary feels like a clean wall, not a slow creep.
  controls.target.y = 0;
  const d = Math.hypot(controls.target.x, controls.target.z);
  if (d > PAN_RADIUS) {
    const k = PAN_RADIUS / d;
    const dx = controls.target.x * (k - 1);
    const dz = controls.target.z * (k - 1);
    controls.target.x += dx;
    controls.target.z += dz;
    camera.position.x += dx;
    camera.position.z += dz;
  }
  // If the camera leaves the dome, pull it back ALONG the camera->target line
  // (shortens the zoom distance, preserves the view direction). The previous
  // code scaled the position toward the world origin, which yanked the camera
  // sideways whenever the target was panned off-centre. Solve for the point on
  // the dome sphere along the target->camera ray: |target + t*dir|^2 = R^2.
  _domeDir.copy(camera.position).sub(controls.target);
  const curDist = _domeDir.length();
  if (curDist > 1e-4) {
    _domeDir.divideScalar(curDist); // unit dir, target -> camera
    const b = controls.target.dot(_domeDir);
    const c = controls.target.lengthSq() - _domeR * _domeR;
    const tMax = -b + Math.sqrt(Math.max(0, b * b - c));
    if (curDist > tMax) camera.position.copy(controls.target).addScaledVector(_domeDir, tMax);
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
const sun = new THREE.DirectionalLight(0xfff1d6, 0.85);
sun.position.set(58, 130, 46);
scene.add(sun);
const sunDir = new THREE.Vector3().copy(sun.position).normalize();

const hemi = new THREE.HemisphereLight(0x88aaff, 0x1a2a3a, 0.55);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x1a3050, 0.5);
scene.add(ambient);

// faint rim/back light for separation
const rim = new THREE.DirectionalLight(0x4fd9ff, 0.25);
rim.position.set(-70, 40, -90);
scene.add(rim);

// ===== SPACE SKYBOX =====
// Deep space with stars, nebula clouds, and a distant planet.
// Procedurally generated in the fragment shader — no textures needed.
(function buildSpaceSky() {
  const skyGeo = new THREE.SphereGeometry(3000, 32, 20);
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
        for (int i = 0; i < 2; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
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
        // star field — 2 layers
        for (int layer = 0; layer < 2; layer++) {
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
  uDeep: { value: new THREE.Color(0x0a2a38) },
  uShallow: { value: new THREE.Color(0x1a5560) },
  uFoam: { value: new THREE.Color(0xc0d8d8) },
  uFog: { value: new THREE.Color(FOG_COLOR) },
  uFogDensity: { value: scene.fog.density },
};

// Circular pond disc (RingGeometry gives plenty of radial rings for the
// vertex-displaced ripples, and a circular edge melts into the forest fog
// instead of showing a hard square boundary).
const waterGeo = new THREE.RingGeometry(0.4, R_WATER, LOW_QUALITY ? 64 : 96, LOW_QUALITY ? 20 : 40);
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
      h += sin(p.x * 0.060 + t * 1.10) * 0.06;
      h += sin(p.y * 0.052 - t * 0.92) * 0.06;
      h += sin((p.x + p.y) * 0.044 + t * 0.70) * 0.04;
      h += cos(p.x * 0.115 - p.y * 0.093 + t * 1.45) * 0.02;
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
        h += sin(band * 0.9) * env * r.w * 3.2;
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
      // normal via finite differences — 2 taps instead of 4 (central difference)
      float d = 1.6;
      float eR = elevation(p + vec2(d, 0.0), uTime);
      float eU = elevation(p + vec2(0.0, d), uTime);
      vNormal = normalize(vec3(e - eR, d, e - eU));
      vWorld = wp.xyz;
      vCrest = clamp(e * 0.5 + 0.5, 0.0, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    precision highp float;
    uniform vec3 uSunDir; uniform vec3 uDeep; uniform vec3 uShallow;
    uniform vec3 uFoam; uniform vec3 uFog; uniform float uFogDensity;
    uniform float uShoreR;
    varying vec3 vWorld; varying vec3 vNormal; varying float vCrest;

    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);

      vec3 base = mix(uDeep, uShallow, clamp(vCrest * 0.9 + fres * 0.3, 0.0, 1.0));
      // sun specular — tight, restrained glint (a broad bright wash hid the fish)
      vec3 Hh = normalize(uSunDir + V);
      float spec = pow(max(dot(N, Hh), 0.0), 160.0);
      // diffuse sky tint
      float diff = max(dot(N, vec3(0.0, 1.0, 0.0)), 0.0);
      vec3 col = base + uShallow * diff * 0.08;
      col += vec3(1.0, 0.97, 0.9) * spec * 0.35;
      col += uFoam * smoothstep(0.72, 0.95, vCrest) * 0.5;     // crest foam

      // distance fog (manual, since this material has fog disabled)
      float dcam = length(cameraPosition - vWorld);
      float fog = 1.0 - exp(-uFogDensity * uFogDensity * dcam * dcam);
      col = mix(col, uFog, clamp(fog, 0.0, 1.0));

      // clearer water near the surface so the fish below read clearly;
      // and fade transparency to zero at the shore so the waterline melts
      // into the wet-sand band instead of forming a hard edge.
      float shore = smoothstep(uShoreR, uShoreR - 24.0, length(vWorld.xz));
      float alpha = clamp(0.52 + fres * 0.22, 0.0, 0.9) * shore;
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
  const s = clamp((strength || 1) * 0.1, 0.18, 1.8);
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
  fish: 'assets/fish.glb',
  frog: 'assets/frog.glb',
  dragonfly: 'assets/dragonfly.glb',
  lily: 'assets/lily.glb',
  bird: 'assets/bird.glb',
  rocks: 'assets/rocks.glb',
  reeds: 'assets/reeds.glb',
  tree_pine: 'assets/tree_pine.glb',
  tree_birch: 'assets/tree_birch.glb',
  tree_maple: 'assets/tree_maple.glb',
  tree_oak: 'assets/tree_oak.glb',
  tree_autumn: 'assets/tree_autumn.glb',
  grass: 'assets/grass.glb',
  grass_tall: 'assets/grass_tall.glb',
  bush: 'assets/bush.glb',
  bush_flowers: 'assets/bush_flowers.glb',
  flowers: 'assets/flowers.glb',
  bushes: 'assets/bushes.glb',
  flower_bushes: 'assets/flower_bushes.glb',
  scifibuilding: 'assets/scifibuilding.glb',
  sun: 'assets/ps1_style_low_poly_sun.glb',
  earth: 'assets/ps1_style_low_poly_earth.glb',
  moon: 'assets/ps1_style_low_poly_moon.glb',
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

// ---------- PROCEDURAL PENGUIN (legendary fish) ----------
// Swimming pose: torpedo body lying belly-down with the head along +X (the
// axis sync3D yaws toward the swim direction), white tummy, swept-back
// flippers, and paddling feet on a rear pivot that wags like a fish tail.
function buildPenguin(color) {
  const g = new THREE.Group();
  const col = new THREE.Color(color);
  const coat = stdMat(0x1c2430, { roughness: 0.5, metalness: 0.05, emissive: col.clone().multiplyScalar(0.18).getHex() });
  const tummyMat = stdMat(0xe8ecf0, { roughness: 0.55 });
  const orange = stdMat(0xe8933a, { roughness: 0.5 });

  const body = new THREE.Mesh(geo('pengBody', () => new THREE.SphereGeometry(1, 18, 14)), coat);
  body.scale.set(1.3, 0.62, 0.55); g.add(body);

  // white belly
  const tummy = new THREE.Mesh(geo('pengBody', () => new THREE.SphereGeometry(1, 18, 14)), tummyMat);
  tummy.scale.set(1.16, 0.5, 0.44); tummy.position.y = -0.16; g.add(tummy);

  // head with white cheek patches
  const head = new THREE.Mesh(geo('pengHead', () => new THREE.SphereGeometry(0.46, 14, 12)), coat);
  head.position.set(1.05, 0.22, 0); g.add(head);
  for (const s of [-1, 1]) {
    const patch = new THREE.Mesh(geo('pengCheek', () => new THREE.SphereGeometry(0.18, 10, 8)), tummyMat);
    patch.scale.set(0.9, 1.1, 0.7);
    patch.position.set(1.18, 0.14, s * 0.24); g.add(patch);
  }

  // beak — wide, flat penguin beak from a squashed sphere
  const beak = new THREE.Mesh(geo('pengBeak', () => new THREE.SphereGeometry(0.22, 10, 8)), orange);
  beak.scale.set(1.15, 0.42, 0.72);
  beak.position.set(1.48, 0.16, 0); g.add(beak);
  // beak ridge / tip for definition
  const beakTip = new THREE.Mesh(geo('pengBeakTip', () => new THREE.SphereGeometry(0.14, 8, 6)), orange);
  beakTip.scale.set(0.9, 0.38, 0.6);
  beakTip.position.set(1.62, 0.15, 0); g.add(beakTip);

  // big googly silly eyes — white sclera bulging out + black pupil
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15 });
  const eyeBlack = new THREE.MeshStandardMaterial({ color: 0x05080c, roughness: 0.1 });
  const eyeShine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const s of [-1, 1]) {
    // sclera
    const sclera = new THREE.Mesh(geo('pengEyeW', () => new THREE.SphereGeometry(0.17, 14, 12)), eyeWhite);
    sclera.position.set(1.28, 0.42, s * 0.22); g.add(sclera);
    // pupil
    const pupil = new THREE.Mesh(geo('pengEyeB', () => new THREE.SphereGeometry(0.09, 12, 10)), eyeBlack);
    pupil.position.set(1.40, 0.42, s * 0.22); g.add(pupil);
    // glint
    const glint = new THREE.Mesh(geo('pengEyeG', () => new THREE.SphereGeometry(0.03, 8, 6)), eyeShine);
    glint.position.set(1.46, 0.46, s * 0.20); g.add(glint);
  }

  // flippers, swept back along the body
  for (const s of [-1, 1]) {
    const fl = new THREE.Mesh(geo('pengFlipper', () => new THREE.SphereGeometry(0.5, 12, 10)), coat);
    fl.scale.set(0.9, 0.16, 0.34);
    fl.position.set(0.1, 0.05, s * 0.6);
    fl.rotation.y = s * 0.55;
    fl.rotation.x = s * 0.25;
    g.add(fl);
  }

  // paddling feet + stubby tail on a rear pivot — sync3D wags it like a tail
  const tailPivot = new THREE.Group(); tailPivot.position.set(-1.1, -0.12, 0);
  for (const s of [-1, 1]) {
    const foot = new THREE.Mesh(geo('pengFoot', () => new THREE.SphereGeometry(0.16, 8, 6)), orange);
    foot.scale.set(1.7, 0.35, 0.9);
    foot.position.set(-0.25, 0, s * 0.2);
    tailPivot.add(foot);
  }
  const tail = new THREE.Mesh(geo('pengTail', () => new THREE.ConeGeometry(0.2, 0.5, 6)), coat);
  tail.rotation.z = Math.PI / 2; tail.position.set(-0.3, 0.1, 0);
  tailPivot.add(tail);
  g.add(tailPivot);

  // legendary glow — same treatment as a tier-3 procedural fish
  const glow = new THREE.PointLight(col.getHex(), 0.9, 14, 2);
  g.add(glow);

  g.userData = { tail: tailPivot, body, materials: [coat, tummyMat, orange, eyeWhite, eyeBlack], glow };
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
  { name: 'small',     sizeMin: 8,  sizeMax: 14, speed: 0.8, color: ['#f9b208', '#e94560', '#00f5d4', '#ff6b6b'], eatCount: 0, eatRange: 0, eats: 'plankton' },
  { name: 'medium',    sizeMin: 16, sizeMax: 24, speed: 0.7, color: ['#f9b208', '#e94560', '#4ecdc4'], eatCount: 2, eatRange: 80, eats: 'fish' },
  { name: 'large',     sizeMin: 26, sizeMax: 36, speed: 0.6, color: ['#e94560', '#9b5de5'], eatCount: 4, eatRange: 120, eats: 'fish' },
  { name: 'legendary', sizeMin: 40, sizeMax: 55, speed: 0.5, color: ['#9b5de5', '#ffe66d'], eatCount: 6, eatRange: 160, eats: 'fish' },
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
    this.disturbAccum = 1.2; // fire on first update
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
        c.vx = (c.vx || 0) + Math.cos(angle) * power * 0.04;
        c.vy = (c.vy || 0) + Math.sin(angle) * power * 0.04;
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
    if (this.disturbAccum > 0.3) {
      this.disturbAccum = 0;
      disturbWater(this.x, this.y, waveStrength * 5, 60);
    }
    return this.life > 0;
  }

  sync3D() {}

  destroy() {}
}

// ===== RIPPLE (ambient) =====
class Ripple3D {
  constructor(x, y, opts = {}) {
    this.x = x; this.y = y;
    this.radius = opts.startRadius || 0;
    this.maxRadius = opts.maxRadius || (60 + Math.random() * 40);
    this.speed = opts.speed || 1.2;
    this.opacity = opts.opacity != null ? opts.opacity : 0.32;
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
    const r = Math.max(0.1, this.radius * POS_SCALE);
    this.mesh.scale.set(r, 1, r);
    this.mesh.material.opacity = this.life * this.opacity;
  }
  destroy() { scene.remove(this.mesh); this.mesh.material.dispose(); }
}

// ===== PLANKTON =====
// Tiny glowing food particles that drift in the water. Small fish (tier 0)
// hunt them. Spawned in packs of ~15-20 via the plankton tool.
let plankton = [];
const MAX_PLANKTON = 300;
const PLANKTON_BASELINE = 40; // client-local ambient food kept topped up

class Plankton3D {
  constructor(x, y) {
    this.type = 'plankton';
    this.x = x; this.y = y;
    this.vx = (Math.random() - 0.5) * 0.15;
    this.vy = (Math.random() - 0.5) * 0.15;
    this.life = 1;
    this.decay = 0.000003 + Math.random() * 0.000002;
    this.size = 1 + Math.random() * 1.5;
    this.phase = Math.random() * Math.PI * 2;
    this.depth = -0.4 - Math.random() * 0.4; // settle just below the surface (-0.4..-0.8)
    const col = [0x80ff80, 0x40e0d0, 0xaaff60, 0x60ffaa][Math.floor(Math.random() * 4)];
    this.mesh = new THREE.Mesh(
      geo('plankton', () => new THREE.SphereGeometry(0.15, 6, 4)),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false, fog: true })
    );
    this.mesh.position.set(toWorldX(x), this.depth, toWorldZ(y));
    scene.add(this.mesh);
  }

  update(dt) {
    this.phase += 0.05;
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= 0.98;
    this.vy *= 0.98;
    // gentle drift
    this.vx += (Math.random() - 0.5) * 0.01;
    this.vy += (Math.random() - 0.5) * 0.01;
    this.life -= this.decay;
    if (isOffScreen(this.x, this.y)) return false;
    return this.life > 0;
  }

  sync3D() {
    const bob = Math.sin(this.phase) * 0.15;
    this.mesh.position.set(toWorldX(this.x), this.depth + bob, toWorldZ(this.y));
    // final world radius ~0.15-0.22 (sphere geo radius is 0.15), slight size variation
    const s = 1.0 + (this.size - 1) * 0.31;
    this.mesh.scale.setScalar(s);
    this.mesh.material.opacity = this.life * 0.55;
  }

  destroy() { scene.remove(this.mesh); }
}

function addPlanktonPack(x, y, silent) {
  const count = 12 + Math.floor(Math.random() * 8);
  for (let i = 0; i < count; i++) {
    if (plankton.length >= MAX_PLANKTON) plankton.shift().destroy();
    const px = x + (Math.random() - 0.5) * 60;
    const py = y + (Math.random() - 0.5) * 60;
    plankton.push(new Plankton3D(px, py));
  }
  if (!silent) ripples.push(new Ripple3D(x, y, { maxRadius: 30 }));
}

// Client-local ambient food: keep a small baseline of plankton drifting near
// where fish swim so the littlest fish always have something to eat. Not
// broadcast (cosmetic) to avoid multiplayer plankton-count desync.
function topUpPlankton() {
  const count = 3 + Math.floor(Math.random() * 4); // 3-6
  const c = randomPondPoint(R_WATER * 0.82);       // spread food across the water, not just the centre
  const cx = c.x, cy = c.y;
  for (let i = 0; i < count; i++) {
    if (plankton.length >= MAX_PLANKTON) break;
    const px = cx + (Math.random() - 0.5) * 40;
    const py = cy + (Math.random() - 0.5) * 40;
    plankton.push(new Plankton3D(px, py));
  }
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
    this.invuln = 0; // invulnerability timer in frames (90s ~ 5400 frames at 60fps)

    // depth-aware roaming/spawn limit so swimmers never clip the rising shore:
    // bigger/deeper fish keep to deeper water, small fish range nearly to the rim.
    const _swimY = -(1.5 + this.tier * 1.25) - 0.35;   // deepest point of the bob
    this.swimClear = 0.5 + this.tier * 0.35;           // vertical clearance (grows with tier)
    const _maxWorldR = maxSwimWorldR(_swimY, this.swimClear);
    this.maxGameR = _maxWorldR / POS_SCALE;
    const _sp = clampToPond(this.x, this.y, _maxWorldR); // pull edge/event/remote spawns into fittable water
    this.x = _sp.x; this.y = _sp.y;

    const isLegendary = this.tier === 3;
    const glb = !isLegendary && assetCache.fish ? instantiateGLB('fish') : null;
    this.model = glb ? glb.root : (isLegendary ? buildPenguin(this.color) : buildFish(this.color, this.tier));
    this.mixer = glb ? glb.mixer : null;
    this.mesh = unitWrap(this.model);
    this.mesh.rotation.y = -this.angle;
    scene.add(this.mesh);
    this.nameSprite = null;
  }

  setPlayer(name) {
    this.isPlayer = true; this.name = name; this.color = '#00f5d4'; this.decay = 0;
    this.invuln = 5400; // ~90 seconds at 60fps
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
    if (this.invuln > 0) this.invuln -= dt;

    const tierData = FISH_TIERS[this.tier];
    // Tier 0 fish hunt plankton; higher tiers hunt fish/dragonflies
    if (this.tier === 0 && this.eatCooldown <= 0) {
      if (!this.eatTarget || !plankton.includes(this.eatTarget)) {
        let nearest = null, nearestDist = 100;
        for (const p of plankton) {
          const d = dist(this.x, this.y, p.x, p.y);
          if (d < nearestDist) { nearest = p; nearestDist = d; }
        }
        this.eatTarget = nearest;
      }
      if (this.eatTarget) {
        const d = dist(this.x, this.y, this.eatTarget.x, this.eatTarget.y);
        if (d < this.size * 0.8) {
          this.eatTarget.life = 0;
          this.eaten++;
          this.growthScale = Math.min(this.growthScale + 0.05, 1.5);
          // subtle feeding feedback: a faint micro-ripple where the plankton was
          if (ripples.length < MAX_RIPPLES) ripples.push(new Ripple3D(this.eatTarget.x, this.eatTarget.y, { maxRadius: 9, speed: 0.8, opacity: 0.16 }));
          this.eatTarget = null;
          this.eatCooldown = 30;
        } else {
          const targetAngle = Math.atan2(this.eatTarget.y - this.y, this.eatTarget.x - this.x);
          let diff = ((targetAngle - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          this.angle += clamp(diff, -0.08, 0.08);
          this.speed = this.baseSpeed * 1.5;
        }
      }
    } else if (tierData.eatCount > 0 && this.eaten < tierData.eatCount && this.eatCooldown <= 0) {
      if (!this.eatTarget || !creatures.includes(this.eatTarget)) {
        let nearest = null, nearestDist = tierData.eatRange;
        for (const c of creatures) {
          if (c === this) continue;
          if (c.type === 'fish' && c.tier < this.tier && !(c.invuln > 0)) {
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

    // radial soft-bound: ease back toward centre near the depth-aware limit so
    // fish fill the pond evenly instead of stacking in the middle or clipping out.
    const _rg = Math.hypot(this.x - PLAY_CX, this.y - PLAY_CY);
    if (_rg > this.maxGameR * 0.9) {
      const _inward = Math.atan2(PLAY_CY - this.y, PLAY_CX - this.x);
      let _d = ((_inward - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const _push = clamp((_rg - this.maxGameR * 0.9) / (this.maxGameR * 0.1), 0, 1);
      this.angle += clamp(_d, -0.06, 0.06) * _push;
      if (_rg > this.maxGameR) {                       // hard stop at the water's safe edge
        const _k = this.maxGameR / _rg;
        this.x = PLAY_CX + (this.x - PLAY_CX) * _k;
        this.y = PLAY_CY + (this.y - PLAY_CY) * _k;
      }
    }

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
    let depth = -(1.5 + this.tier * 1.25) + Math.sin(this.bob) * 0.35;
    const wx = toWorldX(this.x), wz = toWorldZ(this.y);
    // anti-clip safety net: stay above the local pond bottom, never breach the surface
    depth = Math.max(depth, terrainHeight(Math.hypot(wx, wz)) + this.swimClear);
    depth = Math.min(depth, -0.3);
    this.mesh.position.set(wx, depth, wz);
    this.mesh.rotation.y = -this.angle;
    this.mesh.rotation.z = Math.sin(this.tailPhase) * 0.08; // body roll
    const s = this.size * this.growthScale * SCALE * VISUAL;
    this.mesh.scale.setScalar(s);
    if (this.mixer) this.mixer.update(dt * 0.016);
    else if (this.model.userData.tail) this.model.userData.tail.rotation.y = Math.sin(this.tailPhase) * 0.5;
    if (this.model.userData.glow) this.model.userData.glow.intensity = 0.7 + Math.sin(this.tailPhase * 0.5) * 0.3;
    const fade = this.life < 0.3 ? this.life / 0.3 : 1;
    if (fade < 1) setGroupOpacity(this.model, fade);
    // invulnerability visual: pulsing emissive glow
    if (this.invuln > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(this.tailPhase * 0.3);
      this.model.traverse(c => {
        if (c.isMesh && c.material && c.material.emissive) {
          c.material.emissive.setHex(0x00f5d4);
          c.material.emissiveIntensity = 0.3 + pulse * 0.5;
        }
      });
    }
    if (this.nameSprite) { this.nameSprite.position.set(toWorldX(this.x), 2.6, toWorldZ(this.y)); this.nameSprite.material.opacity = fade; }
  }

  destroy() {
    if (this.carried) return; // mesh is now parented to the bird — bird cleans it up
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
      const _ht = clampToPond(this.x + Math.cos(ang) * distHop, this.y + Math.sin(ang) * distHop, R_WATER * 0.9);
      this.hopTo = { x: _ht.x, y: _ht.y };
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

  destroy() {
    if (this.carried) return; // mesh is parented to the bird — bird cleans it up
    scene.remove(this.mesh); scene.remove(this.tongueTip); scene.remove(this.shadow);
  }
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

    // keep dragonflies hovering over the pond (radial bound)
    const _maxR = FILL_R_WORLD / POS_SCALE;
    const _rg = Math.hypot(this.x - PLAY_CX, this.y - PLAY_CY);
    if (_rg > _maxR) {
      const _k = _maxR / _rg;
      this.x = PLAY_CX + (this.x - PLAY_CX) * _k;
      this.y = PLAY_CY + (this.y - PLAY_CY) * _k;
      this.angle = Math.atan2(PLAY_CY - this.y, PLAY_CX - this.x);
    }

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
    // wave displacement: offsetX/Z drift away from origin, spring back
    this.offX = 0; this.offY = 0;
    this.velX = 0; this.velY = 0;

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

    // wave interaction: check if any wave ring is passing through the lily
    for (const w of waves) {
      const d = dist(w.x, w.y, this.x, this.y);
      const band = Math.abs(d - w.radius);
      if (band < 60 && w.life > 0.1) {
        const angle = Math.atan2(this.y - w.y, this.x - w.x);
        const power = w.force * w.life * w.life * (1 - band / 60) * 0.6;
        this.velX += Math.cos(angle) * power;
        this.velY += Math.sin(angle) * power;
      }
    }
    // spring back to origin
    this.velX -= this.offX * 0.08;
    this.velY -= this.offY * 0.08;
    // damping
    this.velX *= 0.88;
    this.velY *= 0.88;
    this.offX += this.velX;
    this.offY += this.velY;

    return this.life > 0;
  }

  sync3D() {
    const sinkY = this.sinking ? -(1 - this.life) * 4 : 0;
    this.mesh.position.set(toWorldX(this.x + this.offX), 0.12 + sinkY, toWorldZ(this.y + this.offY));
    this.mesh.scale.setScalar(Math.max(0.001, this.size * SCALE * VISUAL));
    // tilt slightly based on displacement direction (riding the wave)
    if (Math.abs(this.offX) > 0.5 || Math.abs(this.offY) > 0.5) {
      this.mesh.rotation.z = -this.velX * 0.002;
      this.mesh.rotation.x = this.velY * 0.002;
    } else {
      this.mesh.rotation.z *= 0.9;
      this.mesh.rotation.x *= 0.9;
    }
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
            this.state = 'escaping'; this.grabbedCreature = true; this.swoopScale = 1; this.exitTimer = 0;
            if (this.target && this.target.mesh) {
              this.caughtMesh = this.target.mesh;
              this.caughtNameSprite = this.target.nameSprite || null;
              this.target.carried = true; // prevent fish.destroy() from removing mesh
              this.target.life = 0; // remove from AI updates
              this.caughtMesh.position.set(0.8, 0, 0); // in front of bird = beak area
              this.caughtMesh.rotation.set(0, 0, 0);
              this.caughtMesh.scale.setScalar(0.6);
              this.mesh.add(this.caughtMesh);
              if (this.caughtNameSprite) this.caughtNameSprite.visible = false;
            } else {
              this.target.life = 0;
            }
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

  destroy() {
    scene.remove(this.mesh); scene.remove(this.shadow);
    if (this.caughtMesh) { this.mesh.remove(this.caughtMesh); this.caughtMesh = null; }
    if (this.caughtNameSprite) { scene.remove(this.caughtNameSprite); this.caughtNameSprite = null; }
  }
}

// ===================================================================
// ENTITY MANAGERS
// ===================================================================
const respawnBanner = document.getElementById('respawn-banner');

function addWave(x, y, opts) {
  if (waves.length >= MAX_WAVES) waves.shift().destroy();
  waves.push(new Wave3D(x, y, opts));
}

function addRipple(x, y, opts) {
  if (ripples.length >= MAX_RIPPLES) ripples.shift().destroy();
  ripples.push(new Ripple3D(x, y, opts));
}

function addCreature(type, x, y, extra, silent) {
  const _p = clampToPond(x, y); x = _p.x; y = _p.y; // keep every spawn inside the water disc
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
    beginFishLife(myUserName || 'you', c.tier);
    updateFishAge();
    respawnBanner.classList.remove('visible');
    ripples.push(new Ripple3D(c.x, c.y, { maxRadius: 50 }));
  }
  return c;
}

let lastLilyPlace = { x: -999, y: -999, time: 0 };
function addLily(x, y, silent) {
  const _p = clampToPond(x, y); x = _p.x; y = _p.y;
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

// Procedurally generated sand grain (free — no downloads, no licensing):
// a warm speckled canvas tiled across the beach band by the shore shader.
function makeSandTexture() {
  const s = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  c.fillStyle = '#8a7a5e'; c.fillRect(0, 0, s, s);
  for (let i = 0; i < 9000; i++) {
    const v = 96 + Math.floor(Math.random() * 90);
    c.fillStyle = `rgba(${v},${Math.floor(v * 0.9)},${Math.floor(v * 0.72)},${(0.2 + Math.random() * 0.4).toFixed(2)})`;
    c.fillRect(Math.floor(Math.random() * s), Math.floor(Math.random() * s), 1, 1);
  }
  for (let i = 0; i < 220; i++) { // scattered darker pebble specks
    c.fillStyle = `rgba(58,50,38,${(0.25 + Math.random() * 0.3).toFixed(2)})`;
    c.fillRect(Math.floor(Math.random() * s), Math.floor(Math.random() * s), 2, 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

let shoreUniforms = null; // animated by the main loop once the terrain builds

// Build the continuous bowl terrain: a high-detail basin+shore disc and a
// lower-detail outer forest-floor plateau, both following terrainHeight().
// Sharing the same angular segment count keeps the shoreline seam crack-free.
function buildTerrain(parent, HQ) {
  const G_OUT = R_WATER * 4.2;
  const deep = new THREE.Color(0x06181f), midB = new THREE.Color(0x0d2a35), shallow = new THREE.Color(0x1a4855);
  const sandWet = new THREE.Color(0x3a6a72), sandDamp = new THREE.Color(0x7ba39a); // blue watery sand
  const mossLit = new THREE.Color(0x40743f), mossDk = new THREE.Color(0x1d3a24), dirt = new THREE.Color(0x281f15);
  const theta = HQ ? 80 : 40;

  function colorFor(r, y, n) {
    // deep underwater: shallow teal grading down to dark deep
    if (y < -3.0) {
      const t = clamp((-y - 3.0) / (POND_DEPTH - 3.0), 0, 1);
      return shallow.clone().lerp(midB, clamp(t * 1.4, 0, 1)).lerp(deep, clamp((t - 0.5) * 1.6, 0, 1));
    }
    // broad shoreline beach straddling the waterline: shallow water -> wet
    // blue sand -> damp sand -> moss, all eased for a buttery-smooth blend
    // that reaches well up the outer bank.
    if (y < 1.6) {
      const t = clamp((y + 3.0) / 4.6, 0, 1);             // 0 (underwater) .. 1 (dry bank)
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

  parent.add(makeRing(0.4, R_SHORE, HQ ? 20 : 10));   // basin + shore
  parent.add(makeRing(R_SHORE, G_OUT, HQ ? 12 : 6));  // forest floor

  // soft caustic shimmer near the bowl bottom
  const caustic = new THREE.Mesh(
    new THREE.CircleGeometry(R_PLAY * 0.95, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x2a7080, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  caustic.position.y = -POND_DEPTH + 0.6;
  parent.add(caustic);

  // ---- sand shoreline + swash foam ----
  // A draped ring straddling the waterline: warm sand grain above the water,
  // an animated foam line that laps in and out with the swash, and alpha
  // fades that melt it into the water inward and the mossy bank outward.
  const SHORE_IN = R_SHORE - 13, SHORE_OUT = R_SHORE + 27;
  const shoreGeo = new THREE.RingGeometry(SHORE_IN, SHORE_OUT, HQ ? 100 : 50, HQ ? 16 : 8);
  shoreGeo.rotateX(-Math.PI / 2);
  {
    const p = shoreGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const r = Math.hypot(x, z);
      const n = Math.sin(x * 0.21) * Math.cos(z * 0.19) * 0.5 + Math.sin((x + z) * 0.13) * 0.5;
      // hug the terrain (same noise as makeRing), but never sink below the
      // water plane — the seaward part of the band floats as surface foam
      p.setY(i, Math.max(terrainHeight(r) + n * noiseAmpAt(r) + 1.2, 1.0));
    }
  }
  shoreUniforms = {
    uTime: { value: 0 },
    uR0: { value: R_SHORE },
    uRIn: { value: SHORE_IN },
    uROut: { value: SHORE_OUT },
    uSand: { value: makeSandTexture() },
    uFog: { value: new THREE.Color(FOG_COLOR) },
    uFogDensity: { value: scene.fog.density },
  };
  const shoreMat = new THREE.ShaderMaterial({
    uniforms: shoreUniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime; uniform float uR0; uniform float uRIn; uniform float uROut;
      uniform sampler2D uSand; uniform vec3 uFog; uniform float uFogDensity;
      varying vec3 vW;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) { return noise(p) * 0.62 + noise(p * 2.3) * 0.38; }

      void main() {
        float r = length(vW.xz);
        float ang = atan(vW.z, vW.x);

        // the waterline breathes — three slow traveling waves lap in and out
        float wl = uR0 - 1.5
          + sin(uTime * 0.50 + ang * 3.0) * 2.4
          + sin(uTime * 0.83 - ang * 5.0 + 1.7) * 1.4
          + sin(uTime * 0.31 + ang * 1.0 + 0.6) * 1.6;
        float d = r - wl;               // <0 = open water, >0 = up the beach

        // sand grain, darker and teal-tinted where the swash keeps it wet
        vec3 grain = texture2D(uSand, vW.xz * 0.13).rgb;
        float wet = smoothstep(7.0, 0.5, d);
        vec3 col = mix(grain, grain * vec3(0.45, 0.62, 0.66), wet);

        // foam crest riding the waterline, noise-broken so it reads as
        // bubbles; it surges on the push and thins on the backwash
        float breakup = fbm(vW.xz * 0.45 + vec2(uTime * 0.10, -uTime * 0.07));
        float band = smoothstep(3.0, 0.3, abs(d + 0.3));
        float surge = 0.75 + 0.35 * cos(uTime * 0.50 + ang * 3.0);
        float foam = band * smoothstep(0.30, 0.72, breakup * 0.75 + band * 0.45) * surge;
        // receding lace left floating just behind the waterline
        float streaks = smoothstep(0.0, -4.5, d) * smoothstep(-10.0, -4.5, d)
                      * smoothstep(0.60, 0.95, fbm(vW.xz * 0.3 + vec2(0.0, uTime * 0.05))) * 0.55;
        float foamAll = clamp(foam + streaks, 0.0, 1.0);
        col = mix(col, vec3(0.82, 0.90, 0.90), foamAll);

        // bare sand only above the waterline; the whole band dissolves
        // into the water inward and the moss outward
        float sandVis = smoothstep(-4.0, -0.5, d) * 0.92;
        float innerFade = smoothstep(uRIn, uRIn + 6.0, r);
        float outerFade = smoothstep(uROut, uROut - 9.0, r);
        float alpha = clamp(sandVis + foamAll, 0.0, 1.0) * innerFade * outerFade;

        // manual fog to match the water shader
        float dc = length(cameraPosition - vW);
        float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dc * dc);
        col = mix(col, uFog, clamp(fogF, 0.0, 1.0));

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const shore = new THREE.Mesh(shoreGeo, shoreMat);
  shore.renderOrder = 3;
  parent.add(shore);
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
  while (glowTreeIdx.size < (HQ ? 5 : 2)) glowTreeIdx.add(Math.floor(Math.random() * treeCount));
  const faerieLights = HQ ? 3 : 0;
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
    // Compute actual bounding box after scale to get true height for grounding
    const treeBox = new THREE.Box3().setFromObject(tree);
    const treeH = treeBox.max.y - treeBox.min.y;
    const treeCenterY = (treeBox.max.y + treeBox.min.y) / 2;
    tree.position.set(Math.cos(a) * r, terrainHeight(r) - treeBox.min.y - 0.6, Math.sin(a) * r);
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
    if (HQ && i % 10 === 0) {
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
  const grassCount = HQ ? 180 : 40;
  const grassBlades = [];

  // procedural grass texture — tall clump, visible from distance
  const grassTex = (function makeGrassTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, '#1a3a1a');
    grad.addColorStop(0.4, '#2e6b3e');
    grad.addColorStop(1, '#5aaa6a');
    ctx.fillStyle = grad;
    // draw tall blade clumps — thick and visible
    for (let i = 0; i < 12; i++) {
      const x = 10 + i * 9 + Math.random() * 5;
      const w = 5 + Math.random() * 4;
      const h = 180 + Math.random() * 60;
      ctx.beginPath();
      ctx.moveTo(x - w / 2, 256);
      ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 8, 256 - h * 0.5, x + (Math.random() - 0.5) * 6, 256 - h);
      ctx.quadraticCurveTo(x + w / 2 + (Math.random() - 0.5) * 4, 256 - h * 0.4, x + w / 2, 256);
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
    const isBush = Math.random() < 0.12;
    const mat = isBush ? bushMatBB : grassMat;
    const bb = new THREE.Mesh(bbGeo, mat);
    const h = isBush ? 12 + Math.random() * 8 : 14 + Math.random() * 10;
    const w = isBush ? h * 0.9 : h * 0.5;
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

  // ---- sci-fi buildings in L-shape around 2 corners of the map ----
  buildSciFiBuildings();

  // ---- celestial bodies (sun, earth, moon) floating in the space skybox ----
  buildCelestials();

  // ---- energy dome (transparent geodesic shell over the pond) ----
  buildDome();

  // ---- fireflies drifting over the water ----
  if (HQ) buildFireflies();
}

// ===== CELESTIAL BODIES =====
// Place GLB sun, earth, and moon as large objects floating in the space
// skybox outside the dome. Earth orbits slowly, moon orbits earth.
// The shader sun stays as the "almighty" light source.
function buildCelestials() {
  const CELESTIAL_R = 2200;
  const celestials = [];

  // Helper: disable fog on all materials in a GLB root (they're far outside fog range)
  function noFog(obj) {
    obj.traverse(c => {
      if (c.isMesh && c.material) {
        c.material.fog = false;
        if (c.material.emissive) c.material.emissiveIntensity = Math.max(c.material.emissiveIntensity || 0, 0.3);
      }
    });
  }

  // Soft warm corona sprite (radial gradient) — additive, always faces camera.
  function makeSunHalo() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const cx = cv.getContext('2d');
    const grd = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grd.addColorStop(0.2, 'rgba(255,255,255,0.55)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    grd.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    cx.fillStyle = grd; cx.fillRect(0, 0, 128, 128);
    const mat = new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv),
      color: 0xffcc66,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      sizeAttenuation: true,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.setScalar(720); // ~2x the sun's ~360-unit apparent disc
    return sp;
  }

  // Sun GLB — orbits slowly through the camera's visible band (joining earth &
  // moon) with a warm emissive disc + soft additive corona, so it reads as a
  // glowing star arcing across its side of the sky instead of sitting off-frame.
  if (assetCache.sun) {
    const sunGlb = instantiateGLB('sun');
    if (sunGlb) {
      const sunModel = sunGlb.root;
      sunModel.scale.multiplyScalar(150);
      noFog(sunModel);
      // warm emissive so the disc glows on its own, not just from scene lights
      sunModel.traverse(c => {
        if (c.isMesh && c.material && c.material.emissive) {
          c.material.emissive.set(0xffb24d);
          c.material.emissiveIntensity = Math.max(c.material.emissiveIntensity || 0, 0.9);
        }
      });
      // group holds the scaled model + a world-scaled corona that tracks it
      const sunGroup = new THREE.Group();
      sunGroup.add(sunModel);
      sunGroup.add(makeSunHalo());
      const startAngle = Math.PI; // begin opposite earth (which starts at angle 0)
      sunGroup.position.set(Math.cos(startAngle) * 1800, 300, Math.sin(startAngle) * 1800);
      scene.add(sunGroup);
      celestials.push({ obj: sunGroup, type: 'sun', orbitR: 1800, orbitSpeed: 0.003, orbitAngle: startAngle, orbitTilt: 0.15, baseY: 300 });
    }
  }

  // Earth GLB — orbits slowly at a fixed radius
  if (assetCache.earth) {
    const earthGlb = instantiateGLB('earth');
    if (earthGlb) {
      const earth = earthGlb.root;
      earth.scale.multiplyScalar(60);
      noFog(earth);
      scene.add(earth);
      celestials.push({ obj: earth, type: 'earth', orbitR: CELESTIAL_R * 0.7, orbitSpeed: 0.005, orbitAngle: 0, orbitTilt: 0.3 });
    }
  }

  // Moon GLB — orbits earth
  if (assetCache.moon) {
    const moonGlb = instantiateGLB('moon');
    if (moonGlb) {
      const moon = moonGlb.root;
      moon.scale.multiplyScalar(20);
      noFog(moon);
      scene.add(moon);
      celestials.push({ obj: moon, type: 'moon', orbitR: 200, orbitSpeed: 0.04, orbitAngle: 0, parent: null });
    }
  }

  window.__celestials = celestials;
}

// ===== SCI-FI BUILDINGS =====
// Place scifibuilding.glb in a uniform L-shape around 2 corners of the map,
// far outside the dome on the outer edges. Massive structures visible from
// inside the dome through the transparent shell.
function buildSciFiBuildings() {
  if (!assetCache.scifibuilding) return;
  const BUILDING_SCALE = 120; // massive — visible from inside the dome
  const SPACING = 380; // uniform spacing between buildings
  const buildR = R_WATER * 4.5 - 75; // moved 75 units closer to the pond

  // Two L-shaped corners: one at angle 0 (east), one at angle PI (west)
  // Each L covers ~63 degrees of arc with buildings placed at uniform spacing
  const corners = [
    { centerAng: 0,            span: Math.PI * 0.35 },          // east corner
    { centerAng: Math.PI,      span: Math.PI * 0.35 },          // west corner
  ];

  for (const corner of corners) {
    const count = Math.floor(corner.span * buildR / SPACING);
    for (let i = 0; i < count; i++) {
      const t = (i / Math.max(count - 1, 1)) - 0.5; // -0.5..0.5
      const a = corner.centerAng + t * corner.span;
      const glb = instantiateGLB('scifibuilding');
      if (!glb) continue;
      const b = glb.root;
      // uniform scale
      b.scale.multiplyScalar(BUILDING_SCALE);
      // place at map edge, sitting on terrain — use actual bbox for grounding
      const bBox = new THREE.Box3().setFromObject(b);
      const bx = Math.cos(a) * buildR;
      const bz = Math.sin(a) * buildR;
      const by = terrainHeight(buildR);
      b.position.set(bx, by - bBox.min.y, bz);
      // face outward (detailed side away from pond, so interior faces the pond)
      b.rotation.y = a;
      scene.add(b);
    }
  }
}

// ===== ENERGY DOME =====
// A transparent geodesic dome that encloses the pond — visible as a faint
// energy lattice with a subtle pulse. Gives the "space terrarium" feel.
function buildDome() {
  const DOME_R = R_WATER * 2.4;
  const domeGeo = new THREE.IcosahedronGeometry(DOME_R, 2);
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
  const ringGeo = new THREE.TorusGeometry(DOME_R, 0.3, 8, 48);
  ringGeo.rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x4fd9ff, transparent: true, opacity: 0.3, fog: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  scene.add(ring);

  // store for animation
  window.__dome = { mat: domeMat, shellMat, ringMat };
}

function buildFireflies() {
  const count = 40;
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
  // invert the POS_SCALE position mapping, then clamp to the fillable pond disc
  // so clicking on (or past) the outer water spawns right at the rim, not snapped
  // back to a central square.
  return clampToPond(hit.x / POS_SCALE + W / 2, hit.z / POS_SCALE + H / 2);
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
  playBloop(340 + Math.random() * 140, 0.032, 0.18);
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
      } else {
        // cooling down — a small fizzle so the tap never feels ignored
        addRipple(x, y, { maxRadius: 16, speed: 1.4, opacity: 0.18 });
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
    case 'plankton':
      addPlanktonPack(x, y);
      incrementStat('totalPlankton');
      sendAction({ type: 'plankton', x: normX(x), y: normY(y) });
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
  { id: 'catch_flies', text: 'A swarm of flies appears!', spawn: () => { for (let i = 0; i < 8; i++) { const p = randomPondPoint(R_WATER * 0.9); addCreature('dragonfly', p.x, p.y); } } },
  { id: 'big_fish', text: 'A legendary fish surfaces...', legendary: true, spawn: () => { const p = randomPondPoint(R_WATER * 0.6); addCreature('fish', p.x, p.y, { tier: 3 }); } },
  { id: 'frog_party', text: 'Frogs are gathering!', spawn: () => { for (let i = 0; i < 4; i++) { const p = randomPondPoint(R_WATER * 0.85); addCreature('frog', p.x, p.y); } } },
  { id: 'lily_bloom', text: 'Lily pads are blooming!', spawn: () => { for (let i = 0; i < 5; i++) { const p = randomPondPoint(R_WATER * 0.88); addLily(p.x, p.y); } } },
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
// WEBSOCKET CLIENT  (same protocol as the 2D pond)
// ===================================================================
let ws = null;
let wsConnected = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let useFallbackURL = false;
let myUserId = null;
let myUserName = '';
let lastPresenceCount = null;
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
    onlineCountEl.classList.remove('state-reconnecting', 'state-offline');
  };
  ws.onmessage = (event) => { try { handleMessage(JSON.parse(event.data)); } catch (e) {} };
  ws.onclose = () => {
    clearTimeout(connectTimeout);
    const wasConnected = wsConnected;
    wsConnected = false;
    if (!opened) useFallbackURL = !useFallbackURL;
    if (wasConnected) {
      onlineCountEl.textContent = 'reconnecting…';
      onlineCountEl.classList.add('state-reconnecting');
    }
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > 10) {
    onlineCountEl.textContent = 'offline — a pond of your own';
    onlineCountEl.classList.remove('state-reconnecting');
    onlineCountEl.classList.add('state-offline');
    return;
  }
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
      onlineCountEl.classList.remove('state-reconnecting', 'state-offline');
      if (lastPresenceCount !== null && msg.count !== lastPresenceCount) {
        onlineCountEl.classList.remove('flash');
        void onlineCountEl.offsetWidth; // restart the animation
        onlineCountEl.classList.add('flash');
      }
      lastPresenceCount = msg.count;
      break;
    case 'join': {
      // arrivals are quiet ripples somewhere on the water, not announcements
      const jp = randomPondPoint(R_WATER * 0.85);
      addRipple(jp.x, jp.y, { maxRadius: 44, speed: 0.8, opacity: 0.24 });
      addToast(msg.user.name, 'slipped into the pond', 'join');
      break;
    }
    case 'leave': {
      const lp = randomPondPoint(R_WATER * 0.85);
      addRipple(lp.x, lp.y, { maxRadius: 30, speed: 0.6, opacity: 0.16 });
      addToast(msg.name, 'drifted away', 'leave');
      break;
    }
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
    case 'plankton': addPlanktonPack(x, y, true); break;
    case 'event': {
      const evt = EVENT_TYPES.find(e => e.id === action.eventId);
      if (evt) { currentEvent = evt; currentEventStart = Date.now(); evt.spawn(); showEventBanner(evt, EVENT_DURATION); }
      break;
    }
    case 'birds': spawnBirdBarrage(); break;
  }
}

// ===================================================================
// AMBIENT AUDIO — tiny procedural water sounds (Web Audio, no files).
// Restrained by design: very low volume, few triggers, easy mute.
// ===================================================================
let audioCtx = null;
let soundMuted = false;
try { soundMuted = localStorage.getItem('pond_muted') === '1'; } catch (e) {}
const muteBtn = document.getElementById('mute-btn');
function renderMuteBtn() { if (muteBtn) muteBtn.textContent = soundMuted ? '🔇' : '🔊'; }
renderMuteBtn();
if (muteBtn) muteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  soundMuted = !soundMuted;
  try { localStorage.setItem('pond_muted', soundMuted ? '1' : '0'); } catch (e2) {}
  renderMuteBtn();
});

function ensureAudio() {
  if (audioCtx) return audioCtx;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  return audioCtx;
}

// A soft sine "droplet": quick downward pitch glide with a fast decay.
function playBloop(freq, vol, dur) {
  if (soundMuted) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
  try {
    freq = freq || 420; vol = vol || 0.04; dur = dur || 0.22;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.55, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  } catch (e) {}
}

// Two gentle rising notes — used only for achievement unlocks.
function playChime() {
  playBloop(660, 0.03, 0.5);
  setTimeout(() => playBloop(880, 0.026, 0.6), 130);
}

// ===================================================================
// FISH MEMORY — emotional continuity via localStorage only.
// The visitor's fish is remembered between visits: its birth time keeps
// counting while they're away, and a faded fish leaves a lifetime behind.
// ===================================================================
const MY_FISH_KEY = 'pond_my_fish';
function loadMyFishRecord() { try { return JSON.parse(localStorage.getItem(MY_FISH_KEY) || 'null'); } catch (e) { return null; } }
function saveMyFishRecord(r) { try { localStorage.setItem(MY_FISH_KEY, JSON.stringify(r)); } catch (e) {} }
let myFishRecord = loadMyFishRecord();
// Captured once at boot: the story of the previous visit's fish (if any).
const prevFishRecord = myFishRecord;

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

// Start (or quietly continue) a fish life. A record that never faded means
// the visitor left with their fish alive — the same life resumes, its age
// still counting from the original birth.
function beginFishLife(name, tier) {
  if (myFishRecord && !myFishRecord.faded) {
    myFishRecord.name = name;
    myFishRecord.tier = tier;
    myFishRecord.lastSeen = Date.now();
  } else {
    myFishRecord = { name, tier, born: Date.now(), lastSeen: Date.now() };
  }
  saveMyFishRecord(myFishRecord);
}

// Close out a life when the fish fades: persist the lifetime and surface it
// in the respawn card so the loss reads as a life lived, not an error.
function endFishLife() {
  const el = document.getElementById('respawn-lifetime');
  if (myFishRecord && !myFishRecord.faded) {
    myFishRecord.faded = Date.now();
    saveMyFishRecord(myFishRecord);
    if (el) el.textContent = 'it swam for ' + formatDuration(myFishRecord.faded - myFishRecord.born);
  } else if (el) {
    el.textContent = '';
  }
  const ageEl = document.getElementById('fish-age');
  if (ageEl) ageEl.textContent = '';
}

function updateFishAge() {
  const ageEl = document.getElementById('fish-age');
  if (!ageEl) return;
  if (myFish && myFishRecord && !myFishRecord.faded) {
    ageEl.textContent = '🐟 ' + formatDuration(Date.now() - myFishRecord.born);
  } else {
    ageEl.textContent = '';
  }
}

// ===================================================================
// WELCOME CARD — one quiet confirmation that your fish is in the pond
// ===================================================================
const welcomeCard = document.getElementById('welcome-card');
let welcomeShown = false;

function showWelcomeCard() {
  if (welcomeShown || !welcomeCard) return;
  welcomeShown = true;
  const title = welcomeCard.querySelector('.welcome-title');
  const sub = welcomeCard.querySelector('.welcome-sub');
  if (prevFishRecord && !prevFishRecord.faded && title && sub) {
    // returning visitor whose fish never faded — the same life continues
    title.textContent = 'your fish is still here';
    sub.textContent = 'it has been swimming for ' + formatDuration(Date.now() - prevFishRecord.born);
  } else if (prevFishRecord && prevFishRecord.faded && title && sub) {
    title.textContent = 'a new fish joins the pond';
    sub.textContent = 'your last one swam for ' + formatDuration(prevFishRecord.faded - prevFishRecord.born);
  }
  welcomeCard.classList.add('visible');
  setTimeout(() => welcomeCard.classList.remove('visible'), 5200);
}

// ===================================================================
// FISH LIVES COUNTER — analytics: how many visitors load into a fish
// ===================================================================
const FISH_LIVES_KEY = 'pond_fish_lives';
let fishLivesCount = 0;
let fishLivesReported = false;

function fetchFishLives() {
  // Try to fetch global count from the worker
  fetch('https://shared-pond.maxpug17.workers.dev/api/fish-lives')
    .then(r => r.json())
    .then(d => {
      if (d && typeof d.count === 'number') {
        fishLivesCount = d.count;
        updateFishLivesDisplay();
      }
    })
    .catch(() => {
      // fallback to localStorage only
      try { fishLivesCount = parseInt(localStorage.getItem(FISH_LIVES_KEY) || '0', 10) || 0; } catch (e) {}
      updateFishLivesDisplay();
    });
}

function reportFishLife() {
  if (fishLivesReported) return;
  fishLivesReported = true;
  fishLivesCount++;
  updateFishLivesDisplay();
  // store locally
  try { localStorage.setItem(FISH_LIVES_KEY, String(fishLivesCount)); } catch (e) {}
  // report to server (fire-and-forget)
  try {
    fetch('https://shared-pond.maxpug17.workers.dev/api/fish-lives', { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (d && typeof d.count === 'number') { fishLivesCount = d.count; updateFishLivesDisplay(); } })
      .catch(() => {});
  } catch (e) {}
}

function updateFishLivesDisplay() {
  const el = document.getElementById('fish-lives');
  if (el) el.textContent = fishLivesCount.toLocaleString() + ' fish lives lived';
}

function spawnPlayerFish() {
  const _p = randomPondPoint(R_WATER * 0.75); // spread the player across the pond, not dead-centre
  const fish = new Fish3D(_p.x, _p.y, undefined, true);
  fish.setPlayer(myUserName || 'you');
  creatures.push(fish);
  myFish = fish; isDead = false;
  respawnBanner.classList.remove('visible');
  // emergence moment: a strong ripple, a delayed echo, stirred water, a soft bloop
  ripples.push(new Ripple3D(fish.x, fish.y, { maxRadius: 80 })); // fish.x/y are post-clamp
  disturbWater(fish.x, fish.y, 9, 130);
  setTimeout(() => { if (myFish === fish) addRipple(fish.x, fish.y, { maxRadius: 46, speed: 0.9, opacity: 0.26 }); }, 260);
  playBloop(300, 0.045, 0.3);
  setTimeout(() => playBloop(430, 0.04, 0.35), 180);
  beginFishLife(myUserName || 'you', fish.tier);
  updateFishAge();
  showWelcomeCard();
  reportFishLife();
}

const CREATURE_EMOJI = { fish: '\ud83d\udc1f', frog: '\ud83d\udc38', dragonfly: '\ud83e\udeb0', lily: '\ud83c\udf3f' };
function describeAction(action) {
  switch (action.type) {
    case 'wave': return 'made a wave';
    case 'creature': return `spawned a ${CREATURE_EMOJI[action.creatureType] || action.creatureType}`;
    case 'lily': return 'planted a lily pad';
    case 'plankton': return 'released plankton';
    case 'event': return 'triggered an event';
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
let loopErrorCount = 0;
let loopErrorNotified = false;

function startSessionTimer() {
  const el = document.getElementById('session-timer');
  if (sessionTimerHandle) clearInterval(sessionTimerHandle);
  sessionTimerHandle = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    if (el) el.textContent = `${mm}:${ss}`;
    updateFishAge();
    // accrue lifetime time every 5s to limit writes
    if (elapsed > 0 && elapsed % 5 === 0) {
      const s = loadStats();
      s.totalTimeSeconds = (s.totalTimeSeconds || 0) + 5;
      saveStats(s);
      checkAchievements(s);
      // heartbeat for fish continuity — the life is still being lived
      if (myFish && myFishRecord && !myFishRecord.faded) {
        myFishRecord.lastSeen = Date.now();
        saveMyFishRecord(myFishRecord);
      }
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

// Each achievement exposes prog(s) -> [current, goal] so locked pills can
// show honest progress instead of an opaque locked state.
const ACHIEVEMENTS = [
  { id: 'first_wave', name: 'First Wave', ico: '🌊', prog: s => [s.totalWaves || 0, 1] },
  { id: 'ripple_maker', name: 'Ripple Maker', ico: '🌀', prog: s => [s.totalWaves || 0, 50] },
  { id: 'life_giver', name: 'Life Giver', ico: '🫧', prog: s => [s.totalFish || 0, 10] },
  { id: 'fish_farmer', name: 'Fish Farmer', ico: '🐟', prog: s => [s.totalFish || 0, 25] },
  { id: 'pond_keeper', name: 'Pond Keeper', ico: '🌿', prog: s => [s.totalLilies || 0, 10] },
  { id: 'frog_friend', name: 'Frog Friend', ico: '🐸', prog: s => [s.totalFrogs || 0, 10] },
  { id: 'pond_regular', name: 'Pond Regular', ico: '🔥', prog: s => [s.streak || 0, 3] },
  { id: 'pond_observer', name: 'Pond Observer', ico: '👁', prog: s => [Math.floor((s.totalTimeSeconds || 0) / 60), 10] },
  { id: 'deep_diver', name: 'Deep Diver', ico: '🤿', prog: s => [Math.floor((s.totalTimeSeconds || 0) / 60), 30] },
];
ACHIEVEMENTS.forEach(a => { a.check = s => { const p = a.prog(s); return p[0] >= p[1]; }; });

function loadUnlocked() { try { return JSON.parse(localStorage.getItem('pond_achievements') || '[]'); } catch (e) { return []; } }
function checkAchievements(stats) {
  const unlocked = loadUnlocked();
  let changed = false;
  for (const a of ACHIEVEMENTS) {
    if (!unlocked.includes(a.id) && a.check(stats)) {
      unlocked.push(a.id); changed = true;
      addToast('achievement', `unlocked · ${a.ico} ${a.name}`, 'event');
      playChime();
      // draw the eye to the panel entrance without opening anything
      onlineCountEl.classList.remove('flash-gold');
      void onlineCountEl.offsetWidth;
      onlineCountEl.classList.add('flash-gold');
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
  const s = loadStats();
  el.innerHTML = ACHIEVEMENTS.map(a => {
    const on = unlocked.includes(a.id);
    if (on) return `<div class="achv-pill unlocked"><span class="achv-ico">${a.ico}</span>${escapeHtml(a.name)}</div>`;
    const p = a.prog(s);
    const cur = Math.min(p[0], p[1]);
    const pct = Math.round((cur / p[1]) * 100);
    return `<div class="achv-pill"><span class="achv-ico">${a.ico}</span>${escapeHtml(a.name)} <span class="achv-count">${cur}/${p[1]}</span><span class="achv-bar" style="width:${pct}%"></span></div>`;
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

    // animate the shoreline swash foam
    if (shoreUniforms) shoreUniforms.uTime.value = t;

    // animate dome pulse
    if (window.__dome) {
      const p = 0.10 + 0.04 * Math.sin(t * 0.8);
      window.__dome.mat.opacity = p;
      window.__dome.shellMat.opacity = 0.03 + 0.02 * Math.sin(t * 0.6);
      window.__dome.ringMat.opacity = 0.25 + 0.08 * Math.sin(t * 1.2);
    }

    // animate celestial orbits
    if (window.__celestials) {
      let earthPos = null;
      for (const c of window.__celestials) {
        if (c.type === 'sun') {
          c.orbitAngle += c.orbitSpeed * 0.016 * dt;
          const sx = Math.cos(c.orbitAngle) * c.orbitR;
          const sz = Math.sin(c.orbitAngle) * c.orbitR;
          const sy = c.baseY + Math.sin(c.orbitAngle) * c.orbitR * c.orbitTilt;
          c.obj.position.set(sx, sy, sz);
          c.obj.rotation.y = t * 0.02;
        } else if (c.type === 'earth') {
          c.orbitAngle += c.orbitSpeed * 0.016 * dt;
          const ex = Math.cos(c.orbitAngle) * c.orbitR;
          const ez = Math.sin(c.orbitAngle) * c.orbitR;
          const ey = Math.sin(c.orbitAngle * 0.5) * c.orbitR * c.orbitTilt;
          c.obj.position.set(ex, ey + 200, ez);
          c.obj.rotation.y = t * 0.03;
          earthPos = c.obj.position;
        } else if (c.type === 'moon') {
          c.orbitAngle += c.orbitSpeed * 0.016 * dt;
          const mx = Math.cos(c.orbitAngle) * c.orbitR;
          const mz = Math.sin(c.orbitAngle) * c.orbitR;
          const my = Math.sin(c.orbitAngle * 2) * c.orbitR * 0.3;
          if (earthPos) {
            c.obj.position.set(earthPos.x + mx, earthPos.y + my, earthPos.z + mz);
          } else {
            c.obj.position.set(mx, my + 200, mz);
          }
          c.obj.rotation.y = t * 0.05;
        }
      }
    }

    // animate billboard grass: face camera + wind sway (throttled to every 5 frames)
    if (window.__grassBlades && (frameCount % 5 === 0)) {
      const blades = window.__grassBlades;
      const camPos = camera.position;
      for (let i = 0; i < blades.length; i++) {
        const b = blades[i];
        const dx = camPos.x - b.position.x;
        const dz = camPos.z - b.position.z;
        b.rotation.y = Math.atan2(dx, dz);
        if (!b.userData.isBush) {
          b.rotation.z = Math.sin(t * 1.5 + b.userData.phase) * b.userData.swayAmt;
        }
      }
    }

    if (frameCount % 2 === 0) {
      lilies = lilies.filter(l => { const a = l.update(); if (a) l.sync3D(); else l.destroy(); return a; });
      ripples = ripples.filter(r => { const a = r.update(); if (a) r.sync3D(); else r.destroy(); return a; });
    }
    plankton = plankton.filter(p => { const a = p.update(dt); if (a) p.sync3D(); else p.destroy(); return a; });
    creatures = creatures.filter(c => { const a = c.update(dt); if (a) c.sync3D(dt); else c.destroy(); return a; });

    if (myFish && (myFish.life <= 0 || !creatures.includes(myFish))) {
      myFish = null; isDead = true;
      endFishLife();
      respawnBanner.classList.add('visible');
    }

    birds = birds.filter(b => { const a = b.update(dt); if (a) b.sync3D(); else b.destroy(); return a; });
    waves = waves.filter(w => { const a = w.update(dt); if (a) w.sync3D(); else w.destroy(); return a; });

    if (frameCount % 2 === 0) updateCooldown();
    if (frameCount % 4 === 0) updateEvents();
    if (frameCount % 60 === 0) maybeSpawnRandomBirds();
    if (frameCount % 45 === 0 && plankton.length < PLANKTON_BASELINE) topUpPlankton();

    // fireflies drift slowly — updating every other frame is imperceptible and
    // halves the position-buffer rewrite + GPU upload
    if (frameCount % 2 === 0) updateFireflies(waterUniforms.uTime.value);

    if (cameraMode === 'follow') {
      if (myFish) updateFollowCamera();
      else setCameraMode('orbit'); // fish died — drop back to orbit
    } else {
      // resume gentle auto-rotate after a period of no interaction
      if (!controls.autoRotate && now - lastInteract > 6000) controls.autoRotate = true;
      controls.update();
    }
    renderer.render(scene, camera);
    loopErrorCount = 0;
  } catch (e) {
    // keep the loop alive, but if errors persist for ~4s of frames, tell the
    // visitor once instead of leaving a silently frozen pond
    loopErrorCount++;
    if (loopErrorCount === 240 && !loopErrorNotified) {
      loopErrorNotified = true;
      try { addToast('the pond', 'something rippled wrong — refresh if the water looks still', 'event'); } catch (e2) {}
    }
  }
}

// ===================================================================
// SEED + INIT
// ===================================================================
function seedInitialLife() {
  if (creatures.length === 0 && lilies.length === 0) {
    for (let i = 0; i < 3; i++) { const p = randomPondPoint(R_WATER * 0.85); addLily(p.x, p.y, true); }
    for (let i = 0; i < 3; i++) { const p = randomPondPoint(R_WATER * 0.85); addCreature('fish', p.x, p.y, undefined, true); }
    { const p = randomPondPoint(R_WATER * 0.7); addCreature('fish', p.x, p.y, { tier: 1 }, true); }
    for (let i = 0; i < 2; i++) { const p = randomPondPoint(R_WATER * 0.9); addCreature('dragonfly', p.x, p.y, undefined, true); }
    { const p = randomPondPoint(R_WATER * 0.85); addCreature('frog', p.x, p.y, undefined, true); }
    for (let i = 0; i < 2; i++) { const p = randomPondPoint(R_WATER * 0.7); addPlanktonPack(p.x, p.y, true); }
  }
  // offline/solo: give the player their own fish to ride (online players
  // receive theirs from the server snapshot instead)
  if (!myFish && !wsConnected) spawnPlayerFish();
}

function init() {
  buildEnvironment();

  // fish lives counter — fetch global count on load
  fetchFishLives();

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

  // reveal the scene — the first frame has already rendered inside animate(),
  // so this is a short grace beat rather than a blind guess
  setTimeout(hideLoadingScreen, 400);
}

// Load GLB assets (procedural fallback on any failure), then start. A slow
// network can't strand the loading screen: after 15s we boot regardless and
// any stragglers simply resolve into the asset cache unused-until-next-spawn.
const assetsReady = Promise.all(Object.entries(ASSETS).map(([k, v]) => loadAsset(k, v)));
Promise.race([assetsReady, new Promise(res => setTimeout(res, 15000))]).then(init);
