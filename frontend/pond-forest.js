/* Natural shoreline vegetation. Four branching tree meshes share one leaf atlas.
 * All repeated plants are instanced; alpha-tested leaves write depth, and wind
 * runs in the vertex shader. No shadow maps, per-tree lights, or frame uploads.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const wind = {
    time: typeof waterUniforms !== 'undefined' ? waterUniforms.uTime : { value: 0 },
    motion: { value: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1 },
    gust: { value: 1 },
  };
  const UP = new THREE.Vector3(0, 1, 0);

  function randomSource(seed) {
    return function () {
      let n = seed += 0x6D2B79F5;
      n = Math.imul(n ^ n >>> 15, n | 1);
      n ^= n + Math.imul(n ^ n >>> 7, n | 61);
      return ((n ^ n >>> 14) >>> 0) / 4294967296;
    };
  }

  function terrainY(x, z) {
    const r = Math.hypot(x, z);
    const noise = Math.sin(x * 0.21) * Math.cos(z * 0.19) * 0.5 + Math.sin((x + z) * 0.13) * 0.5;
    return terrainHeight(r) + noise * (0.2 + 0.95 * THREE.MathUtils.clamp((r - R_PLAY) / (R_WATER * 0.6), 0, 1));
  }

  function openGround(x, z, clearance) {
    if (typeof window.getPondWatercourseClearance === 'function'
      && window.getPondWatercourseClearance(x, z) < clearance) return false;
    // Keep the west-side settlement and its approach free of vegetation.
    if (x < -302 && z > -150 && z < 35) return false;
    return true;
  }

  class GeometryBatch {
    constructor() {
      this.positions = [];
      this.normals = [];
      this.uvs = [];
      this.colors = [];
      this.indices = [];
    }

    vertex(point, normal, u, v, color) {
      const index = this.positions.length / 3;
      this.positions.push(point.x, point.y, point.z);
      this.normals.push(normal.x, normal.y, normal.z);
      this.uvs.push(u, v);
      this.colors.push(color.r, color.g, color.b);
      return index;
    }

    branch(start, end, radius, endRadius, color, random, sides = 6) {
      const direction = end.clone().sub(start).normalize();
      const tangent = new THREE.Vector3().crossVectors(direction, Math.abs(direction.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
      const bitangent = new THREE.Vector3().crossVectors(direction, tangent).normalize();
      const base = this.positions.length / 3;
      const shade = new THREE.Color();
      for (let ring = 0; ring < 2; ring++) {
        for (let side = 0; side <= sides; side++) {
          const angle = side / sides * TAU;
          const normal = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
          const width = (ring ? endRadius : radius) * (1 + Math.sin(side * 12.9898 + start.y * 5) * 0.1);
          const position = (ring ? end : start).clone().addScaledVector(normal, width);
          shade.copy(color).multiplyScalar(0.82 + random() * 0.29);
          this.vertex(position, normal, side / sides, ring, shade);
        }
      }
      for (let side = 0; side < sides; side++) {
        const a = base + side, b = base + sides + 1 + side;
        this.indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }

    spray(center, size, aspect, rotation, tile, color) {
      const quaternion = new THREE.Quaternion().setFromEuler(rotation);
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
      const base = this.positions.length / 3;
      const column = tile % 2;
      const row = tile < 2 ? 1 : 0;
      // Gutters protect against adjacent sprites bleeding into distant mipmaps.
      const u0 = column * 0.5 + 0.008, u1 = (column + 1) * 0.5 - 0.008;
      const v0 = row * 0.5 + 0.008, v1 = (row + 1) * 0.5 - 0.008;
      [[-0.5, -0.5, u0, v0], [0.5, -0.5, u1, v0], [0.5, 0.5, u1, v1], [-0.5, 0.5, u0, v1]].forEach(([x, y, u, v]) => {
        const point = new THREE.Vector3(x * size * aspect, y * size, 0).applyQuaternion(quaternion).add(center);
        this.vertex(point, normal, u, v, color);
      });
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    blade(base, direction, length, width, bend, color, sections = 4) {
      const right = new THREE.Vector3(Math.cos(direction), 0, -Math.sin(direction));
      const forward = new THREE.Vector3(Math.sin(direction), 0, Math.cos(direction));
      const start = this.positions.length / 3;
      for (let row = 0; row <= sections; row++) {
        const t = row / sections;
        const center = base.clone().addScaledVector(forward, t * t * bend);
        center.y += length * (t - t * t * 0.13);
        const normal = new THREE.Vector3().crossVectors(right, new THREE.Vector3(forward.x * t * bend, length, forward.z * t * bend)).normalize();
        const halfWidth = width * (1 - t * t) * 0.5 + 0.005;
        const shade = color.clone().multiplyScalar(0.64 + t * 0.36);
        this.vertex(center.clone().addScaledVector(right, -halfWidth), normal, 0, t, shade);
        this.vertex(center.clone().addScaledVector(right, halfWidth), normal, 1, t, shade);
        if (row > 0) {
          const a = start + (row - 1) * 2;
          this.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }

    geometry() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
      geometry.setIndex(this.indices);
      geometry.computeBoundingSphere();
      return geometry;
    }
  }

  function plantMaterial(options, flex) {
    const material = new THREE.MeshStandardMaterial(Object.assign({
      color: 0xffffff, roughness: 0.96, metalness: 0,
      vertexColors: true, side: THREE.DoubleSide,
    }, options));
    if (!flex) return material;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uForestTime = wind.time;
      shader.uniforms.uForestMotion = wind.motion;
      shader.uniforms.uForestGust = wind.gust;
      shader.vertexShader = `uniform float uForestTime; uniform float uForestMotion; uniform float uForestGust;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vec3 forestOrigin = vec3(0.0);
        #ifdef USE_INSTANCING
          forestOrigin = instanceMatrix[3].xyz;
        #endif
        float forestPhase = dot(forestOrigin.xz, vec2(0.039, 0.047));
        float forestTip = pow(clamp(position.y / ${flex.height.toFixed(2)}, 0.0, 1.0), 1.7);
        float forestWave = sin(uForestTime * 0.83 + forestPhase) * 0.68
                         + sin(uForestTime * 1.57 + forestPhase + position.y * 0.36) * 0.32;
        transformed.x += forestWave * forestTip * ${flex.amount.toFixed(3)} * uForestMotion * uForestGust;
        transformed.z += cos(uForestTime * 0.71 + forestPhase) * forestTip * ${ (flex.amount * 0.34).toFixed(3)} * uForestMotion;
      `);
      if (options.map) {
        // Restrained leaf transmission keeps backlit sprays legible inside the
        // dome without changing the scene's light count or flattening the bark.
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.085;');
      } else if (flex.height <= 7) {
        shader.vertexShader = 'varying vec2 vBladeUv;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vBladeUv = uv;');
        shader.fragmentShader = 'varying vec2 vBladeUv;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
          #include <color_fragment>
          float bladeVein = pow(max(0.0, 1.0 - abs(vBladeUv.x * 2.0 - 1.0)), 7.0);
          diffuseColor.rgb *= 0.80 + bladeVein * 0.20 + sin(vBladeUv.x * 39.0) * 0.035;
        `);
      }
    };
    material.customProgramCacheKey = () => `pond-forest-v1:${flex.height}:${flex.amount}:${!!options.map}`;
    return material;
  }

  function treePrototype(species, HQ) {
    const random = randomSource(9481 + species * 7109);
    const wood = new GeometryBatch();
    const leaves = new GeometryBatch();
    const bark = new THREE.Color(species === 1 ? 0xaaa996 : species === 2 ? 0x615c49 : 0x5c5042);
    const leafTint = new THREE.Color();
    const perch = [];
    const height = species === 1 ? 36 : species === 3 ? 43 : 31;
    const crownStart = species === 3 ? 0.22 : species === 2 ? 0.4 : 0.39;
    const trunkRadius = species === 1 ? 0.48 : species === 3 ? 0.72 : 0.91;
    const leanX = (random() - 0.5) * 3, leanZ = (random() - 0.5) * 2.3;
    const trunkAt = (t) => new THREE.Vector3(leanX * t + Math.sin(t * 5) * 0.23, t * height, leanZ * t);
    for (let segment = 0; segment < 9; segment++) {
      const t = segment / 9, next = (segment + 1) / 9;
      wood.branch(trunkAt(t), trunkAt(next), trunkRadius * Math.pow(1 - t, 0.88) + 0.035,
        trunkRadius * Math.pow(1 - next, 0.88) + 0.03, bark, random, HQ ? 7 : 5);
    }
    // Buttress roots ground the trunks without expensive realtime shadows.
    for (let root = 0; root < 5; root++) {
      const angle = root / 5 * TAU + random() * 0.4;
      wood.branch(new THREE.Vector3(0, 1.1, 0), new THREE.Vector3(Math.cos(angle) * trunkRadius * 3.2, 0.08, Math.sin(angle) * trunkRadius * 3.2),
        trunkRadius * 0.57, 0.06, bark, random, 5);
    }

    function foliage(point, size, direction, number) {
      for (let index = 0; index < number; index++) {
        const radius = Math.sqrt(random()) * size * 0.56;
        const angle = random() * TAU;
        const center = point.clone().add(new THREE.Vector3(Math.cos(angle) * radius, (random() - 0.5) * size * 0.72, Math.sin(angle) * radius));
        leafTint.setRGB(0.78 + random() * 0.2, 0.84 + random() * 0.14, 0.73 + random() * 0.17);
        const tilt = species === 2 ? 0.18 + random() * 0.5 : (random() - 0.5) * 2.4;
        leaves.spray(center, size * (0.75 + random() * 0.52), species === 2 ? 0.82 : 1,
          new THREE.Euler(tilt, direction + index * 2.39996, (random() - 0.5) * 1.3), species, leafTint);
      }
    }

    const branches = species === 3 ? 17 : species === 1 ? 12 : 13;
    for (let index = 0; index < branches; index++) {
      const t = crownStart + index / branches * (0.93 - crownStart);
      const start = trunkAt(t);
      const angle = index * 2.39996 + random() * 0.48;
      const silhouette = species === 3 ? (1 - t) * 15.5 : Math.sin((t - crownStart + 0.16) / (1.12 - crownStart) * Math.PI) * (species === 1 ? 7.5 : 12);
      const length = silhouette * (0.75 + random() * 0.37);
      const rise = species === 3 ? 0.75 + random() * 0.75 : species === 2 ? 1.1 : 3.0 + random() * 3.3;
      const end = start.clone().add(new THREE.Vector3(Math.cos(angle) * length, rise, Math.sin(angle) * length));
      const middle = start.clone().lerp(end, 0.54);
      middle.y += species === 2 ? 1.3 : 0.6;
      const radius = trunkRadius * (1 - t) * (species === 1 ? 0.62 : 0.83);
      wood.branch(start, middle, radius + 0.045, radius * 0.58 + 0.02, bark, random, 5);
      wood.branch(middle, end, radius * 0.58 + 0.02, 0.035, bark, random, 5);
      if (index === 2 || index === 5 || index === 8) perch.push(middle.clone());

      const forks = species === 3 ? 4 : 5;
      for (let fork = 0; fork < forks; fork++) {
        const along = 0.32 + fork / forks * 0.66;
        const from = start.clone().lerp(end, along);
        const forkAngle = angle + (fork % 2 ? -1 : 1) * (0.45 + random() * 0.5);
        const forkLength = species === 3 ? 2.2 + length * 0.13 : 2.8 + random() * 2.4;
        const tip = from.clone().add(new THREE.Vector3(Math.cos(forkAngle) * forkLength,
          species === 2 ? -1.5 - random() * 2.4 : 0.3 + random() * 2.5, Math.sin(forkAngle) * forkLength));
        wood.branch(from, tip, 0.085 + (1 - along) * 0.055, 0.018, bark, random, 4);
        const spraySize = species === 3 ? 3.4 : species === 2 ? 4.7 : species === 1 ? 3.3 : 4.6;
        foliage(tip, spraySize, forkAngle, HQ ? 5 : 3);
        if (species === 2) {
          const hanging = tip.clone().add(new THREE.Vector3(Math.cos(forkAngle) * 0.65, -3.2 - random() * 2.2, Math.sin(forkAngle) * 0.65));
          wood.branch(tip, hanging, 0.025, 0.008, bark, random, 3);
          foliage(hanging, 3.9, forkAngle, HQ ? 3 : 2);
        }
      }
      foliage(end, species === 3 ? 3.6 : 4.3, angle, HQ ? 4 : 3);
    }
    foliage(trunkAt(0.94), species === 3 ? 3.0 : 5.0, 0, HQ ? 9 : 6);
    return { wood: wood.geometry(), leaves: leaves.geometry(), perch, height };
  }

  function instances(parent, name, geometry, material, placements) {
    if (!placements.length) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    mesh.name = name;
    // r128 culls instanced batches using the untransformed prototype bounds.
    mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < placements.length; i++) {
      const item = placements[i];
      position.set(item.x, item.y, item.z);
      euler.set(item.rx || 0, item.angle || 0, item.rz || 0);
      quaternion.setFromEuler(euler);
      scale.set(item.sx || item.scale || 1, item.sy || item.scale || 1, item.sz || item.scale || 1);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      if (item.color) mesh.setColorAt(i, item.color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    parent.add(mesh);
    return mesh;
  }

  function shadowTexture() {
    const size = 32, pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const distance = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
      const at = (y * size + x) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = 255;
      pixels[at + 3] = Math.round(Math.pow(Math.max(0, 1 - distance), 1.6) * 255);
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return texture;
  }

  window.buildPondForest = function buildPondForest(parent, HQ) {
    const forest = new THREE.Group();
    forest.name = 'natural-pond-forest';
    parent.add(forest);
    const random = randomSource(20260905);
    const leafMaterials = [];
    const atlas = new THREE.TextureLoader().load('assets/natural-foliage-atlas.png', undefined, undefined, () => {
      // Avoid opaque square cards if the optional texture cannot be fetched.
      for (const material of leafMaterials) material.visible = false;
    });
    atlas.encoding = THREE.sRGBEncoding;
    atlas.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    const foliageMaterial = plantMaterial({ map: atlas, alphaTest: 0.46, depthWrite: true }, { height: 38, amount: 0.42 });
    const barkMaterial = plantMaterial({ side: THREE.FrontSide }, null);
    applyPondWorldTexture(barkMaterial, window.PondSurfaceTextures.bark, 0.32, false);
    leafMaterials.push(foliageMaterial);
    const prototypes = [0, 1, 2, 3].map((species) => treePrototype(species, HQ));
    const trees = [[], [], [], []];
    const treeBases = [];
    const contacts = [];
    const treeCount = HQ ? 112 : 64;
    TREE_PERCHES.length = 0;
    for (let attempt = 0; treeBases.length < treeCount && attempt < treeCount * 24; attempt++) {
      // Loose groves separated by clearings, rather than a uniform tree fence.
      const grove = Math.floor(random() * 11);
      const angle = grove / 11 * TAU + (random() - 0.5) * 0.43;
      const radius = R_SHORE + 18 + Math.pow(random(), 0.8) * 210;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      const frontOpening = z > 0 && ((Math.abs(x) < 57 && radius < R_SHORE + 66)
        || (Math.abs(x) < 32 && radius < R_SHORE + 174));
      if (frontOpening || !openGround(x, z, 11) || treeBases.some((p) => Math.hypot(p.x - x, p.z - z) < 11)) continue;
      const nearWater = radius < R_SHORE + 63;
      const roll = random();
      const species = nearWater && roll < 0.39 ? 2 : roll < 0.3 ? 1 : roll > 0.68 ? 3 : 0;
      const scale = (0.77 + random() * 0.62) * (radius > R_SHORE + 92 ? 1.2 : 0.95);
      const item = { x, z, y: terrainY(x, z) - 0.09, angle: random() * TAU,
        sx: scale * (0.85 + random() * 0.26), sy: scale, sz: scale * (0.85 + random() * 0.26),
        color: new THREE.Color().setRGB(0.88 + random() * 0.12, 0.9 + random() * 0.1, 0.85 + random() * 0.12) };
      trees[species].push(item);
      treeBases.push(item);
      contacts.push({ x, z, y: terrainY(x, z) + 0.08, sx: scale * 10, sy: 1, sz: scale * 9, angle: item.angle });
      const anchor = prototypes[species].perch[treeBases.length % prototypes[species].perch.length].clone();
      anchor.multiply(new THREE.Vector3(item.sx, item.sy, item.sz));
      anchor.applyAxisAngle(UP, item.angle).add(new THREE.Vector3(x, item.y, z));
      TREE_PERCHES.push(anchor);
    }
    const speciesNames = ['oak', 'birch', 'willow', 'cedar'];
    for (let species = 0; species < 4; species++) {
      instances(forest, `forest-${speciesNames[species]}-branches`, prototypes[species].wood, barkMaterial, trees[species]);
      instances(forest, `forest-${speciesNames[species]}-leaves`, prototypes[species].leaves, foliageMaterial, trees[species]);
    }

    const grass = new GeometryBatch();
    for (let blade = 0; blade < 13; blade++) {
      const angle = random() * TAU;
      grass.blade(new THREE.Vector3((random() - 0.5) * 1.2, 0, (random() - 0.5) * 1.2), angle,
        1.3 + random() * 2.8, 0.15 + random() * 0.12, 0.6 + random() * 1.2,
        new THREE.Color(blade % 4 === 0 ? 0x858366 : blade % 3 === 0 ? 0x68754e : 0x536541));
    }
    const grassPatches = [];
    const grassCount = HQ ? 6000 : 2800;
    for (let attempt = 0; grassPatches.length < grassCount && attempt < grassCount * 4; attempt++) {
      const angle = random() * TAU;
      const radius = R_SHORE + 18 + Math.pow(random(), 1.5) * 254;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      // Broad irregular sweeps of grass alternate with moss and exposed soil.
      const patch = Math.sin(x * 0.074 + Math.cos(z * 0.059)) + Math.cos(z * 0.097);
      if (patch < -1.65 || !openGround(x, z, 1.7)) continue;
      const size = 0.9 + random() * 1.0;
      grassPatches.push({ x, z, y: terrainY(x, z) - 0.13, angle: random() * TAU, sx: size * 2.8, sy: size * (0.62 + random() * 0.46), sz: size * 2.8 });
    }
    instances(forest, 'forest-meadow-grasses', grass.geometry(), plantMaterial({ color: 0x3c6125 }, { height: 4, amount: 0.21 }), grassPatches);

    const shrubs = new GeometryBatch();
    for (let spray = 0; spray < 28; spray++) {
      const angle = random() * TAU, radius = Math.sqrt(random()) * 2.9;
      const position = new THREE.Vector3(Math.cos(angle) * radius, 0.5 + Math.sqrt(Math.max(0, 1 - radius / 3)) * 3, Math.sin(angle) * radius);
      shrubs.spray(position, 3.2 + random(), 1, new THREE.Euler((random() - 0.5) * 2, angle, (random() - 0.5)), spray % 3 === 0 ? 3 : 0,
        new THREE.Color(0xb7bba1));
    }
    const shrubPatches = [];
    for (let index = 0; index < (HQ ? 720 : 400); index++) {
      const nearTree = treeBases[index % treeBases.length];
      const angle = random() * TAU, distance = 7 + random() * 19;
      const x = nearTree.x + Math.cos(angle) * distance, z = nearTree.z + Math.sin(angle) * distance;
      if (Math.hypot(x, z) < R_SHORE + 13 || !openGround(x, z, 4)) continue;
      shrubPatches.push({ x, z, y: terrainY(x, z) - 0.2, scale: 0.8 + random() * 0.9, angle });
    }
    const shrubMaterial = plantMaterial({ map: atlas, alphaTest: 0.46, depthWrite: true }, { height: 4.5, amount: 0.16 });
    leafMaterials.push(shrubMaterial);
    instances(forest, 'forest-understory', shrubs.geometry(), shrubMaterial, shrubPatches);

    const reeds = new GeometryBatch();
    const reedColor = new THREE.Color(0x6d7752), dryColor = new THREE.Color(0x918669), seedColor = new THREE.Color(0x66533f);
    for (let stem = 0; stem < 7; stem++) {
      const base = new THREE.Vector3((random() - 0.5) * 2.5, 0, (random() - 0.5) * 2.5);
      const height = 3.8 + random() * 3.1, angle = random() * TAU;
      const tip = base.clone().add(new THREE.Vector3(Math.cos(angle) * 0.65, height, Math.sin(angle) * 0.65));
      reeds.branch(base, tip, 0.032, 0.022, stem % 3 === 0 ? dryColor : reedColor, random, 4);
      if (stem % 2 === 0) reeds.branch(tip.clone().add(new THREE.Vector3(0, -0.8, 0)), tip, 0.11, 0.085, seedColor, random, 5);
      for (let leaf = 0; leaf < 3; leaf++) reeds.blade(base.clone().add(new THREE.Vector3(0, leaf * 0.6, 0)), angle + leaf * 2.4,
        height * (0.55 + random() * 0.22), 0.16 + random() * 0.08, 1.6 + random(), reedColor);
    }
    const reedPatches = [];
    for (let index = 0; index < (HQ ? 68 : 26); index++) {
      const section = Math.floor(random() * 8);
      const angle = section / 8 * TAU + (random() - 0.5) * 0.24;
      const radius = R_SHORE + 0.7 + random() * 13;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      if (!openGround(x, z, 2)) continue;
      reedPatches.push({ x, z, y: Math.max(-0.14, terrainY(x, z) - 0.25), scale: 0.65 + random() * 0.62, angle: random() * TAU });
    }
    instances(forest, 'forest-reedbeds', reeds.geometry(), plantMaterial({ color: 0x5d7435 }, { height: 7, amount: 0.18 }), reedPatches);

    const stoneGeometry = new THREE.IcosahedronGeometry(1, 1);
    const stonePosition = stoneGeometry.attributes.position;
    const stoneColors = [];
    for (let index = 0; index < stonePosition.count; index++) {
      const x = stonePosition.getX(index), y = stonePosition.getY(index), z = stonePosition.getZ(index);
      const weathering = Math.sin(x * 9.1 + z * 5.7) * Math.cos(y * 7.3 - x * 3.9);
      stonePosition.setXYZ(index, x * (1 + weathering * 0.14), y * (1 + weathering * 0.09), z * (1 + weathering * 0.12));
      const color = new THREE.Color(y > 0.3 ? 0x737862 : 0x64665b).multiplyScalar(0.88 + weathering * 0.13);
      stoneColors.push(color.r, color.g, color.b);
    }
    stoneGeometry.setAttribute('color', new THREE.Float32BufferAttribute(stoneColors, 3));
    stoneGeometry.computeVertexNormals();
    const stones = [];
    for (let index = 0; index < (HQ ? 64 : 26); index++) {
      const angle = random() * TAU;
      const radius = R_SHORE - 1.5 + Math.pow(random(), 2) * 72;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      if (!openGround(x, z, 3)) continue;
      const size = index % 9 === 0 ? 3 + random() * 3 : 0.65 + random() * 1.9;
      const item = { x, z, y: terrainY(x, z) + size * 0.1, sx: size * (1.1 + random() * 0.65), sy: size * 0.56,
        sz: size * (0.8 + random() * 0.6), angle: random() * TAU, rx: (random() - 0.5) * 0.28, rz: (random() - 0.5) * 0.22 };
      stones.push(item);
      contacts.push({ x, z, y: terrainY(x, z) + 0.04, sx: item.sx * 2, sy: 1, sz: item.sz * 2, angle: item.angle });
    }
    const stoneMaterial = plantMaterial({ side: THREE.FrontSide, flatShading: true }, null);
    applyPondWorldTexture(stoneMaterial, window.PondSurfaceTextures.rock, 0.24, false);
    instances(forest, 'forest-weathered-stones', stoneGeometry, stoneMaterial, stones);
    const contactGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const contactMaterial = new THREE.MeshBasicMaterial({ color: 0x172018, map: shadowTexture(),
      transparent: true, opacity: 0.29, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    instances(forest, 'forest-ground-contact', contactGeometry, contactMaterial, contacts);

    window.__grassBlades = [];
    window.__pondForest = {
      group: forest,
      trees: treeBases.length,
      treeSpecies: trees.map((items) => items.length),
      grassClumps: grassPatches.length,
      reedClumps: reedPatches.length,
      draws: forest.children.length,
    };
    return forest;
  };

  window.updatePondForest = function updatePondForest(time, reducedMotion, gust) {
    wind.time.value = time;
    wind.motion.value = reducedMotion ? 0 : 1;
    wind.gust.value = gust ? 1.65 : 1;
  };
}());
