/* Render-only tributary. World coordinates throughout; no ecology or network state.
   Five draws in both quality tiers: cliff, channel bed, stones, water, spray. */
(function () {
  'use strict';

  const channelPoints = [
    [-55, -336], [-64, -311], [-60, -293], [-43, -271],
    [-47, -254], [-53, -239], [-41, -220], [-34, -207],
    [-36, -192], [-28, -176], [-28, -164], [-27, -157], [-20, -150], [-16, -144],
    [-19, -136], [-20, -129], [-18, -121], [-17, -116]
  ];
  const curve = new THREE.CatmullRomCurve3(channelPoints.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal');
  const clearancePoints = curve.getPoints(144);
  let state = null;

  // Signed world-unit distance to the water/rock envelope. Available before build,
  // so the forest can reserve a clearing without depending on build order.
  window.getPondWatercourseClearance = function (x, z) {
    let distance = Infinity;
    for (let i = 1; i < clearancePoints.length; i++) {
      const a = clearancePoints[i - 1], b = clearancePoints[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      distance = Math.min(distance, Math.hypot(x - a.x - dx * t, z - a.z - dz * t) - 6.5);
    }
    distance = Math.min(distance, Math.hypot((x + 55) / 1.3, z + 336) - 16);
    const cliff = (Math.hypot((x + 55) / 98, (z + 377) / 52) - 1) * 52;
    return Math.min(distance, cliff);
  };

  window.buildPondWatercourse = function (parent, HQ) {
    if (state) return state.group;
    let seed = 90713;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const group = new THREE.Group();
    group.name = 'waterfall-and-tributary';
    parent.updateMatrixWorld(true);

    // Intersect the actual two terrain rings once at construction. The wide outer
    // triangles differ appreciably from sampling the continuous height function.
    const terrain = parent.children.filter(mesh => mesh.isMesh && mesh.geometry && mesh.geometry.type === 'RingGeometry' && mesh.material.vertexColors);
    const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    function ground(x, z) {
      ray.ray.origin.set(x, 120, z);
      const hit = ray.intersectObjects(terrain, false);
      if (hit.length) return hit[0].point.y;
      const r = Math.hypot(x, z);
      const noise = Math.sin(x * 0.21) * Math.cos(z * 0.19) * 0.5 + Math.sin((x + z) * 0.13) * 0.5;
      return terrainHeight(r) + noise * (0.2 + 0.95 * Math.max(0, Math.min(1, (r - R_PLAY) / (R_WATER * 0.6))));
    }

    const sections = HQ ? 220 : 116;
    const rows = [];
    for (let i = 0; i <= sections; i++) {
      const t = i / sections, p = curve.getPoint(t), tangent = curve.getTangent(t);
      const sideX = tangent.z, sideZ = -tangent.x;
      const width = 2.65 + 2.1 * (1 - t) + 0.4 * Math.sin(t * Math.PI * 3);
      let y = -Infinity;
      for (let k = -2; k <= 2; k++) {
        const w = k * 0.5 * (width + 0.65);
        y = Math.max(y, ground(p.x + sideX * w, p.z + sideZ * w) + 0.25);
      }
      // Keep the outlet in the main water. Its last seven meters are submerged.
      if (t > 0.97) y = Math.max(0.07, y);
      rows.push({ x: p.x, z: p.z, y, sideX, sideZ, width, t });
    }
    for (let i = rows.length - 2; i >= 0; i--) rows[i].y = Math.max(rows[i].y, rows[i + 1].y + 0.008);
    let runLength = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i) runLength += Math.hypot(rows[i].x - rows[i - 1].x, rows[i].z - rows[i - 1].z);
      rows[i].flowDistance = runLength;
    }
    const basinY = Math.max(rows[0].y, ground(-55, -336) + 0.38);
    rows[0].y = basinY;
    const crestY = basinY + 146;

    function batch() { return { position: [], color: [], uv: [], kind: [], index: [] }; }
    function vertex(b, x, y, z, color, u, v, kind) {
      const id = b.position.length / 3;
      b.position.push(x, y, z);
      if (color) b.color.push(color.r, color.g, color.b);
      if (u !== undefined) { b.uv.push(u, v); b.kind.push(kind); }
      return id;
    }
    function tri(b, a, c, d) { b.index.push(a, c, d); }
    function geometry(b) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.position, 3));
      if (b.color.length) g.setAttribute('color', new THREE.Float32BufferAttribute(b.color, 3));
      if (b.uv.length) {
        g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
        g.setAttribute('aKind', new THREE.Float32BufferAttribute(b.kind, 1));
      }
      g.setIndex(b.index);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    }

    const cliff = batch();
    const slate = new THREE.Color(0x424c47), darkSlate = new THREE.Color(0x293633), moss = new THREE.Color(0x475641);
    // Fractured rock masses, with tilted strata and broken silhouettes. All
    // fragments share one draw; moss is part of the rock's vertex color.
    function rock(cx, cy, cz, sx, sy, sz, rotation, damp) {
      const perimeter = [[-0.72, -1], [0.65, -1], [1, -0.57], [1, 0.58], [0.64, 1], [-0.77, 1], [-1, 0.55], [-1, -0.6]];
      const rings = [], cr = Math.cos(rotation), sr = Math.sin(rotation);
      const tint = slate.clone().lerp(darkSlate, damp).multiplyScalar(0.8 + random() * 0.36);
      const tiltX = (random() - 0.5) * 0.35, tiltZ = (random() - 0.5) * 0.26;
      for (let level = 0; level < 5; level++) {
        const ring = [];
        for (let k = 0; k < 8; k++) {
          const t = level / 4;
          const bevel = 0.78 + Math.sin(t * Math.PI) * 0.22 - t * 0.11;
          const px = (perimeter[k][0] + (random() - 0.5) * 0.3) * sx * bevel;
          const pz = (perimeter[k][1] + (random() - 0.5) * 0.25) * sz * bevel;
          const py = cy + (t * 2 - 1) * sy + px * tiltX + pz * tiltZ + (random() - 0.5) * sy * 0.19;
          const color = tint.clone();
          if (level === 4 && damp < 0.65) color.lerp(moss, 0.22 + random() * 0.4);
          ring.push(vertex(cliff, cx + px * cr + pz * sr, py, cz - px * sr + pz * cr, color));
        }
        rings.push(ring);
      }
      for (let level = 0; level < 4; level++) {
        for (let k = 0; k < 8; k++) {
          const n = (k + 1) % 8;
          tri(cliff, rings[level][k], rings[level + 1][k], rings[level][n]);
          tri(cliff, rings[level][n], rings[level + 1][k], rings[level + 1][n]);
        }
      }
      for (let k = 1; k < 7; k++) tri(cliff, rings[4][0], rings[4][k + 1], rings[4][k]);
    }
    // The entire escarpment stands outside the dome. Its broad, uneven shoulders
    // descend into the forest, with a tall central cleft carrying the waterfall.
    for (let column = -4; column <= 4; column++) {
      const cx = -55 + column * 17.7 + (random() - 0.5) * 5;
      const height = [32, 69, 99, 135, 147, 117, 87, 55, 23][column + 4];
      rock(cx, basinY + height * 0.43, -381 + Math.abs(column) * 0.7,
        16 + random() * 4, height * 0.54, 24 + random() * 6,
        (random() - 0.5) * 0.45, Math.abs(column) < 2 ? 0.68 : 0.2);
      if (Math.abs(column) > 1) rock(cx + (random() - 0.5) * 10,
        basinY + height * 0.17, -363, 13 + random() * 8, height * 0.24,
        15 + random() * 4, (random() - 0.5) * 0.8, 0.2);
    }
    for (let i = 0; i < 30; i++) {
      const a = random() * Math.PI * 2;
      const x = -55 + Math.cos(a) * (33 + random() * 44);
      const z = -375 + Math.sin(a) * (21 + random() * 15);
      if (z > -354 && Math.abs(x + 55) < 22) continue;
      rock(x, ground(x, z) + 1.2, z, 5.5 + random() * 7.5, 3.1 + random() * 6.2, 4.5 + random() * 5.4, random() * 2, 0.15);
    }
    // Wet shelves turn one high fall into two connected, turbulent cascades.
    rock(-53.5, basinY + 61.5, -354.0, 14, 2.1, 8.0, -0.04, 0.9);
    rock(-58.0, crestY - 1.5, -358.8, 13.6, 1.55, 10.3, 0.035, 0.75);
    const rockMap = window.PondSurfaceTextures && window.PondSurfaceTextures.rock;
    const cliffMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.91, metalness: 0.02 });
    if (rockMap && window.applyPondWorldTexture) applyPondWorldTexture(cliffMaterial, rockMap, 1 / 6, false);
    const cliffMesh = new THREE.Mesh(geometry(cliff), cliffMaterial);
    cliffMesh.name = 'weathered-slate-escarpment';
    group.add(cliffMesh);

    const bed = batch(), water = batch();
    const bedColors = [new THREE.Color(0x454b3b), new THREE.Color(0x273d37), new THREE.Color(0x182e2b), new THREE.Color(0x273d37), new THREE.Color(0x454b3b)];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const edges = [-1.65, -1.04, 0, 1.04, 1.65];
      for (let k = 0; k < edges.length; k++) {
        const w = row.width * edges[k], x = row.x + row.sideX * w, z = row.z + row.sideZ * w;
        const y = k === 0 || k === 4 ? ground(x, z) + 0.06 : row.y - 0.1;
        vertex(bed, x, y, z, bedColors[k]);
      }
      const divisions = 8;
      for (let k = 0; k <= divisions; k++) {
        const u = k / divisions, w = (u * 2 - 1) * row.width;
        vertex(water, row.x + row.sideX * w, row.y + 0.03, row.z + row.sideZ * w, null, u, row.flowDistance * 0.16, 0);
      }
      if (i) {
        for (let k = 0; k < 4; k++) {
          const a = (i - 1) * 5 + k, b = i * 5 + k;
          tri(bed, a, a + 1, b); tri(bed, a + 1, b + 1, b);
        }
        for (let k = 0; k < divisions; k++) {
          const a = (i - 1) * (divisions + 1) + k, b = i * (divisions + 1) + k;
          tri(water, a, a + 1, b); tri(water, a + 1, b + 1, b);
        }
      }
    }

    function pool(b, radiusX, radiusZ, y, forWater) {
      const n = HQ ? 44 : 28;
      const center = vertex(b, -55, y, -336, forWater ? null : bedColors[2], forWater ? 0.5 : undefined, 0.5, 2);
      const ids = [];
      for (let i = 0; i <= n; i++) {
        const a = i / n * Math.PI * 2;
        const irregular = 1 + Math.sin(a * 3.0) * 0.045 + Math.cos(a * 7.0) * 0.026;
        ids.push(vertex(b, -55 + Math.cos(a) * radiusX * irregular, y, -336 + Math.sin(a) * radiusZ * irregular,
          forWater ? null : bedColors[1], forWater ? Math.cos(a) * 0.5 + 0.5 : undefined, Math.sin(a) * 0.5 + 0.5, 2));
      }
      for (let i = 0; i < n; i++) tri(b, center, ids[i + 1], ids[i]);
    }
    pool(bed, 20.8, 15.2, basinY - 0.13, false);
    pool(water, 20.2, 14.6, basinY + 0.035, true);
    const bedMesh = new THREE.Mesh(geometry(bed), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0, side: THREE.DoubleSide }));
    if (rockMap) applyPondWorldTexture(bedMesh.material, rockMap, 0.34, true);
    bedMesh.name = 'wet-gravel-stream-bed';
    group.add(bedMesh);

    const stoneCount = HQ ? 216 : 120;
    const stoneGeometry = new THREE.IcosahedronGeometry(1, 0);
    const stoneMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.03 });
    const stones = new THREE.InstancedMesh(stoneGeometry, stoneMaterial, stoneCount);
    const dummy = new THREE.Object3D(), stoneColor = new THREE.Color();
    for (let i = 0; i < stoneCount; i++) {
      const row = rows[Math.floor(random() * (rows.length - 4))];
      const side = random() > 0.5 ? 1 : -1;
      const width = row.width * (1.04 + random() * 0.46) * side;
      let x = row.x + row.sideX * width, z = row.z + row.sideZ * width;
      if (i < 36) {
        const angle = i / 36 * Math.PI * 2;
        x = -55 + Math.cos(angle) * (20.1 + random() * 1.5);
        z = -336 + Math.sin(angle) * (14.55 + random() * 1.3);
      }
      const size = 0.3 + Math.pow(random(), 2) * (i < 36 ? 2.6 : 1.35);
      const bedY = Math.max(ground(x, z), i < 36 ? basinY - 0.15 : row.y - 0.17);
      dummy.position.set(x, bedY + size * 0.28, z);
      dummy.rotation.set(random() * 0.45, random() * Math.PI * 2, random() * 0.35);
      dummy.scale.set(size * (1.1 + random() * 0.8), size * 0.48, size * (0.7 + random() * 0.8));
      dummy.updateMatrix(); stones.setMatrixAt(i, dummy.matrix);
      stoneColor.setHSL(0.13 + random() * 0.1, 0.08 + random() * 0.12, 0.18 + random() * 0.15);
      stones.setColorAt(i, stoneColor);
    }
    stones.name = 'tributary-edge-stones';
    stones.instanceMatrix.needsUpdate = true;
    stones.instanceColor.needsUpdate = true;
    group.add(stones);

    function fall(cx, top, bottom, topZ, bottomZ, width, phase) {
      const start = water.position.length / 3;
      const vertical = HQ ? 64 : 32, horizontal = HQ ? 16 : 10;
      for (let j = 0; j <= vertical; j++) {
        const v = j / vertical;
        const flare = 0.83 + v * 0.28 + Math.sin(v * Math.PI * 3 + phase) * 0.075;
        for (let k = 0; k <= horizontal; k++) {
          const u = k / horizontal;
          const x = cx + (u * 2 - 1) * width * flare + Math.sin(v * 6 + phase) * 0.18;
          const y = top + (bottom - top) * v;
          const z = topZ + (bottomZ - topZ) * v * v + Math.sin(u * 13 + v * 7) * 0.24;
          vertex(water, x, y, z, null, u, v, 1);
        }
      }
      for (let j = 0; j < vertical; j++) for (let k = 0; k < horizontal; k++) {
        const a = start + j * (horizontal + 1) + k, b = a + horizontal + 1;
        tri(water, a, b, a + 1); tri(water, a + 1, b, b + 1);
      }
    }
    fall(-57.2, crestY, basinY + 64.0, -348.3, -345.6, 8.6, 0.4);
    fall(-53.3, basinY + 64.3, basinY + 0.12, -345.5, -333.8, 12.6, 2.7);
    fall(-42.4, crestY - 5.0, basinY + 20.0, -349.2, -341.0, 2.8, 1.2);
    fall(-42.4, basinY + 20.3, basinY + 0.12, -341.0, -332.0, 3.2, 2.1);

    const uniforms = {
      ...waterUniforms,
      uFlowTime: { value: 0 },
      uMotion: { value: 1 },
      uMistScale: { value: LOW_QUALITY ? 0.85 : 1.0 }
    };
    const waterMaterial = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      vertexShader: `
        uniform float uFlowTime; uniform float uMotion;
        attribute float aKind;
        varying vec2 vUv; varying vec3 vWorld; varying vec3 vSurfaceNormal; varying float vKind;
        void main() {
          vUv = uv; vKind = aKind;
          vec3 p = position;
          if (aKind > 0.5 && aKind < 1.5) {
            float released = sin(uv.y * 3.14159) * uMotion;
            p.x += sin(uv.y * 31.0 - uFlowTime * 7.0 + uv.x * 8.0) * 0.42 * released;
            p.z += sin(uv.y * 51.0 - uFlowTime * 9.0 + uv.x * 14.0) * 0.46 * released;
            p.y += sin(uv.x * 18.0 + uv.y * 27.0 - uFlowTime * 5.0) * 0.19 * released;
          } else {
            float edge = sin(uv.x * 3.14159);
            p.y += sin(position.x * 0.31 + position.z * 0.43 - uFlowTime * 1.25) * 0.045 * edge * uMotion;
          }
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          vSurfaceNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform float uTime; uniform float uFlowTime;
        uniform vec3 uSunDir; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam;
        uniform vec3 uFog; uniform float uFogDensity;
        varying vec2 vUv; varying vec3 vWorld; varying vec3 vSurfaceNormal; varying float vKind;
        ${POND_WATER_APPEARANCE}
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
        }
        void main() {
          vec3 color; float alpha;
          vec3 viewDir = normalize(cameraPosition - vWorld);
          if (vKind > 0.5 && vKind < 1.5) {
            float edge = smoothstep(0.0, 0.09, vUv.x) * (1.0 - smoothstep(0.91, 1.0, vUv.x));
            // Advect through sqrt(height) so visible flow accelerates as it falls.
            float travel = sqrt(vUv.y + 0.012);
            float thread = noise(vec2(vUv.x * 37.0, travel * 11.0 - uFlowTime * 2.4));
            float streak = noise(vec2(vUv.x * 88.0, travel * 24.0 - uFlowTime * 6.7));
            float broken = smoothstep(0.25, 0.8, thread * 0.62 + streak * 0.38);
            float aerated = smoothstep(0.38, 0.94, vUv.y);
            vec3 normal = normalize(vSurfaceNormal + vec3((thread - 0.5) * 0.3, (streak - 0.5) * 0.28, 0.12));
            if (dot(normal, viewDir) < 0.0) normal = -normal;
            color = pondWaterColor(vWorld, normal, viewDir, 0.76 + broken * 0.16 + aerated * 0.12, 0.82);
            alpha = edge * (0.43 + broken * 0.48);
          } else {
            float n = noise(vec2(vUv.x * 15.0, vUv.y * 3.0 - uFlowTime * 0.9));
            float fine = noise(vWorld.xz * 1.3 + vec2(0.0, -uFlowTime * 0.4));
            vec3 normal = normalize(vec3((n - 0.5) * 0.10, 1.0, (fine - 0.5) * 0.09));
            float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);
            float foam;
            if (vKind > 1.5) {
              vec2 p = (vUv - 0.5) * 2.0;
              float r = length(p);
              float ring = pow(max(0.0, sin(r * 34.0 - uFlowTime * 3.1 + n * 2.8)), 7.0);
              foam = ring * (1.0 - smoothstep(0.2, 0.93, r)) * 0.45;
              alpha = (0.68 + fresnel * 0.2) * (1.0 - smoothstep(0.91, 1.04, r));
            } else {
              float edge = smoothstep(0.0, 0.08, vUv.x) * (1.0 - smoothstep(0.92, 1.0, vUv.x));
              float streak = pow(max(0.0, sin(vUv.y * 12.0 - uFlowTime * 2.6 + vUv.x * 12.0 + n * 5.0)), 14.0);
              foam = streak * smoothstep(0.5, 0.86, n) * 0.24;
              foam += pow(abs(vUv.x * 2.0 - 1.0), 10.0) * n * 0.10;
              alpha = edge * (0.68 + fresnel * 0.2);
            }
            color = pondWaterColor(vWorld, normal, viewDir, 0.54 + foam, 0.88);
          }
          float distanceToEye = length(cameraPosition - vWorld);
          float fog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToEye * distanceToEye);
          gl_FragColor = vec4(mix(color, uFog, fog), alpha);
        }
      `
    });
    const waterMesh = new THREE.Mesh(geometry(water), waterMaterial);
    waterMesh.name = 'flowing-tributary-and-falls';
    waterMesh.renderOrder = 3;
    group.add(waterMesh);

    const sprayCount = HQ ? 72 : 32;
    const sprayGeometry = new THREE.BufferGeometry();
    const positions = [], seeds = [];
    for (let i = 0; i < sprayCount; i++) {
      const shelf = i < Math.floor(sprayCount * 0.22);
      positions.push(shelf ? -54 : -53, basinY + (shelf ? 64.5 : 0.5), shelf ? -345.2 : -333.8);
      seeds.push(random(), random(), random(), random());
    }
    sprayGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    sprayGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    const sprayMaterial = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, toneMapped: false,
      vertexShader: `
        uniform float uFlowTime; uniform float uMistScale;
        attribute vec4 aSeed; varying float vOpacity;
        void main() {
          float age = fract(aSeed.x + uFlowTime * (0.16 + aSeed.y * 0.09));
          float a = aSeed.z * 6.283185;
          vec3 p = position;
          p.x += cos(a) * (6.0 + age * 14.0) * aSeed.y;
          p.z += sin(a) * age * 7.0 + age * 4.7;
          p.y += sin(age * 3.14159) * (1.6 + aSeed.w * 7.5);
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((580.0 + aSeed.w * 730.0) * uMistScale / -mv.z, 1.0, 11.0);
          vOpacity = sin(age * 3.14159) * (0.09 + aSeed.w * 0.11);
        }
      `,
      fragmentShader: `
        uniform vec3 uFoam; varying float vOpacity;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.08, 1.0, d)) * vOpacity;
          gl_FragColor = vec4(uFoam, a);
        }
      `
    });
    const spray = new THREE.Points(sprayGeometry, sprayMaterial);
    spray.name = 'waterfall-impact-spray';
    spray.frustumCulled = false;
    spray.renderOrder = 4;
    group.add(spray);
    parent.add(group);
    state = { group, uniforms, rows, basinY, crestY, spray, runLength, drawCalls: 5 };
    window.__pondWatercourse = state;
    return group;
  };

  window.updatePondWatercourse = function (t, reducedMotion) {
    if (!state) return;
    // All motion stays on the GPU; reduced motion produces a still waterfall.
    state.uniforms.uFlowTime.value = reducedMotion ? 0 : t;
    state.uniforms.uMotion.value = reducedMotion ? 0 : 1;
    state.spray.visible = !reducedMotion;
  };
})();
