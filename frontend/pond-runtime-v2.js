(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const ORBIT_PERIOD_MS = 60 * 60 * 1000;
  const BACKGROUND_FISH_CAP = LOW_QUALITY ? 160 : 260;
  const reducedMotionKey = 'eternalpond.reduced-motion.v2';
  const mutedKey = 'pond_muted';

  function shortestAngle(from, to) {
    return ((to - from + Math.PI * 3) % TAU) - Math.PI;
  }

  function colorCss(value) {
    return `#${Number(value || 0x79d1c2).toString(16).padStart(6, '0')}`;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
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

  function normalizedToGame(point) {
    return { x: point.x * W, y: point.z * H };
  }

  function normalizedToWorld(x, z, depth, target) {
    const result = target || new THREE.Vector3();
    const worldX = (x - 0.5) * W * POS_SCALE;
    const worldZ = (z - 0.5) * H * POS_SCALE;
    const desiredDepth = -0.7 - depth * 10.5;
    const floor = terrainHeight(Math.hypot(worldX, worldZ)) + 0.55;
    return result.set(worldX, Math.min(-0.28, Math.max(desiredDepth, floor)), worldZ);
  }

  class PondAudioV2 {
    constructor() {
      this.context = null;
      this.master = null;
      this.enabled = true;
      this.awake = false;
      this.ambientNodes = [];
      this.nextAccentAt = 0;
      this.lastRippleAt = 0;
      this.rippleBlend = 0;
      this.rippleTimer = null;
      try { this.enabled = localStorage.getItem(mutedKey) !== '1'; }
      catch (error) { this.enabled = true; }
    }

    awaken() {
      if (this.awake) {
        if (this.context && this.context.state === 'suspended') this.context.resume().catch(() => {});
        return;
      }
      this.awake = true;
      if (!this.enabled) return;
      this.createContext();
    }

    createContext() {
      if (this.context) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      try {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = this.enabled ? 0.16 : 0;
        this.master.connect(this.context.destination);
        this.startAmbientBed();
      } catch (error) {
        this.context = null;
        this.master = null;
      }
    }

    startAmbientBed() {
      const context = this.context;
      if (!context || !this.master) return;
      const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;

      const water = context.createBufferSource();
      const waterFilter = context.createBiquadFilter();
      const waterGain = context.createGain();
      water.buffer = buffer;
      water.loop = true;
      waterFilter.type = 'lowpass';
      waterFilter.frequency.value = 720;
      waterGain.gain.value = 0.028;
      water.connect(waterFilter).connect(waterGain).connect(this.master);
      water.start();

      const reeds = context.createBufferSource();
      const reedsFilter = context.createBiquadFilter();
      const reedsGain = context.createGain();
      reeds.buffer = buffer;
      reeds.loop = true;
      reedsFilter.type = 'bandpass';
      reedsFilter.frequency.value = 1850;
      reedsFilter.Q.value = 1.8;
      reedsGain.gain.value = 0.008;
      reeds.connect(reedsFilter).connect(reedsGain).connect(this.master);
      reeds.start();

      const hum = context.createOscillator();
      const humGain = context.createGain();
      hum.type = 'sine';
      hum.frequency.value = 48;
      humGain.gain.value = 0.025;
      hum.connect(humGain).connect(this.master);
      hum.start();
      this.ambientNodes.push(water, reeds, hum);
    }

    toggle() {
      this.enabled = !this.enabled;
      try { localStorage.setItem(mutedKey, this.enabled ? '0' : '1'); }
      catch (error) { /* Keep the visit-local setting. */ }
      if (this.enabled) {
        this.createContext();
        if (this.context && this.context.state === 'suspended') this.context.resume().catch(() => {});
      }
      if (this.master && this.context) {
        this.master.gain.cancelScheduledValues(this.context.currentTime);
        this.master.gain.setTargetAtTime(this.enabled ? 0.16 : 0, this.context.currentTime, 0.08);
      }
      return this.enabled;
    }

    playRipple(strength) {
      if (!this.enabled || !this.context || !this.master) return;
      if (strength > 0) this.rippleBlend = Math.min(1.5, this.rippleBlend + strength);
      const elapsed = performance.now() - this.lastRippleAt;
      if (elapsed < 85) {
        if (this.rippleTimer === null) {
          this.rippleTimer = setTimeout(() => {
            this.rippleTimer = null;
            this.playRipple(0);
          }, 85 - elapsed);
        }
        return;
      }
      this.lastRippleAt = performance.now();
      const blendedStrength = Math.max(0.25, Math.min(1, this.rippleBlend));
      this.rippleBlend = 0;
      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(380 + Math.random() * 120, now);
      oscillator.frequency.exponentialRampToValueAtTime(190, now + 0.28);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.045 * blendedStrength, now + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now);
      oscillator.stop(now + 0.36);
    }

    playNature(kind, strength) {
      if (!this.enabled || !this.context || !this.master) return;
      if (kind !== 'frog_call' && kind !== 'bird_transition' && kind !== 'bird_hunt') return;
      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = kind === 'frog_call' ? 'sine' : 'triangle';
      const start = kind === 'frog_call' ? 145 : kind === 'bird_hunt' ? 720 : 540;
      oscillator.frequency.setValueAtTime(start, now);
      oscillator.frequency.exponentialRampToValueAtTime(kind === 'frog_call' ? 92 : 380, now + 0.42);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.018 * (strength || 0.5), now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now);
      oscillator.stop(now + 0.62);
    }

    update(serverNow, orbitPhase) {
      if (!this.enabled || !this.context || serverNow < this.nextAccentAt) return;
      this.nextAccentAt = serverNow + 9000 + Math.random() * 17000;
      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 110 + orbitPhase * 70;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.008, now + 0.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.4);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now);
      oscillator.stop(now + 3.5);
    }
  }

  class BackgroundFishRenderer {
    constructor(capacity) {
      this.capacity = capacity;
      this.root = new THREE.Object3D();
      this.bodyNode = new THREE.Object3D();
      this.bellyNode = new THREE.Object3D();
      this.tailPivot = new THREE.Object3D();
      this.tailNode = new THREE.Object3D();
      this.dorsalNode = new THREE.Object3D();
      this.eyeNodes = [new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D()];
      this.root.add(this.bodyNode, this.bellyNode, this.tailPivot, this.dorsalNode, ...this.eyeNodes);
      this.tailPivot.add(this.tailNode);
      this.bodyNode.scale.set(1.3, 0.6, 0.42);
      this.bellyNode.scale.set(1.18, 0.42, 0.36);
      this.bellyNode.position.y = -0.16;
      this.tailPivot.position.x = -1.15;
      this.tailNode.position.x = -0.5;
      this.tailNode.rotation.z = Math.PI / 2;
      this.tailNode.scale.set(1, 1, 0.28);
      this.dorsalNode.position.set(-0.1, 0.5, 0);
      this.dorsalNode.scale.set(1, 1, 0.18);
      for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
        const side = sideIndex === 0 ? -1 : 1;
        this.eyeNodes[sideIndex * 2].position.set(0.78, 0.12, side * 0.28);
        this.eyeNodes[sideIndex * 2].scale.setScalar(0.16);
        this.eyeNodes[sideIndex * 2 + 1].position.set(0.88, 0.12, side * 0.3);
        this.eyeNodes[sideIndex * 2 + 1].scale.setScalar(0.09);
      }

      const bodyGeometry = geo('fishBody', () => new THREE.SphereGeometry(1, 18, 14));
      const tailGeometry = geo('fishTail', () => new THREE.ConeGeometry(0.62, 1.05, 4));
      const dorsalGeometry = geo('fishDorsal', () => new THREE.ConeGeometry(0.34, 0.8, 3));
      const eyeWhiteGeometry = geo('fishEyeW', () => new THREE.SphereGeometry(1, 10, 8));
      const eyeBlackGeometry = geo('fishEyeB', () => new THREE.SphereGeometry(1, 8, 6));
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.4,
        metalness: 0.08,
        emissive: 0x172020,
        vertexColors: true,
      });
      const finMaterial = bodyMaterial.clone();
      finMaterial.transparent = true;
      finMaterial.opacity = 0.92;
      const bellyMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.12,
        roughness: 0.5,
        depthWrite: false,
      });
      const eyeWhiteMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
      const eyeBlackMaterial = new THREE.MeshStandardMaterial({ color: 0x05080c, roughness: 0.2 });
      this.body = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, capacity);
      this.belly = new THREE.InstancedMesh(bodyGeometry, bellyMaterial, capacity);
      this.tail = new THREE.InstancedMesh(tailGeometry, finMaterial, capacity);
      this.dorsal = new THREE.InstancedMesh(dorsalGeometry, finMaterial.clone(), capacity);
      this.eyeWhite = new THREE.InstancedMesh(eyeWhiteGeometry, eyeWhiteMaterial, capacity * 2);
      this.eyeBlack = new THREE.InstancedMesh(eyeBlackGeometry, eyeBlackMaterial, capacity * 2);
      this.meshes = [this.body, this.belly, this.tail, this.dorsal, this.eyeWhite, this.eyeBlack];
      for (const mesh of this.meshes) {
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(mesh);
      }
      this.color = new THREE.Color();
    }

    write(index, state, elapsed) {
      normalizedToWorld(state.x, state.z, state.depth, this.root.position);
      const phase = (state.seed || hashString(state.id || String(index))) * 0.001;
      this.root.position.y += Math.sin(elapsed * 1.8 + phase) * 0.18;
      this.root.rotation.set(0, -state.heading, Math.sin(elapsed * 2.2 + phase) * 0.04);
      this.root.scale.setScalar(0.58 + state.size * 0.64);
      this.tailPivot.rotation.y = Math.sin(elapsed * 7.2 + phase) * 0.5;
      this.root.updateMatrixWorld(true);
      this.body.setMatrixAt(index, this.bodyNode.matrixWorld);
      this.belly.setMatrixAt(index, this.bellyNode.matrixWorld);
      this.tail.setMatrixAt(index, this.tailNode.matrixWorld);
      this.dorsal.setMatrixAt(index, this.dorsalNode.matrixWorld);
      for (let side = 0; side < 2; side++) {
        this.eyeWhite.setMatrixAt(index * 2 + side, this.eyeNodes[side * 2].matrixWorld);
        this.eyeBlack.setMatrixAt(index * 2 + side, this.eyeNodes[side * 2 + 1].matrixWorld);
      }
      const fablePalette = [0xf9b208, 0xe94560, 0x00f5d4, 0xff6b6b, 0x4ecdc4, 0x9b5de5];
      this.color.setHex(fablePalette[Math.abs(hashString(state.id || String(index))) % fablePalette.length]);
      this.body.setColorAt(index, this.color);
      this.tail.setColorAt(index, this.color);
      this.dorsal.setColorAt(index, this.color);
    }

    update(schools, elapsed) {
      let count = 0;
      for (const school of schools) {
        const visibleCount = Math.min(school.count, this.capacity - count);
        const random = mulberry(Number(school.seed || hashString(school.id)));
        for (let index = 0; index < visibleCount && count < this.capacity; index++) {
          const baseAngle = random() * TAU;
          const radius = school.kind === 'wild'
            ? Math.sqrt(random()) * 0.38
            : 0.01 + random() * 0.055;
          const centerX = school.kind === 'wild' ? 0.5 : school.x;
          const centerZ = school.kind === 'wild' ? 0.5 : school.z;
          const speed = 0.028 + random() * 0.026;
          const angle = baseAngle + elapsed * speed;
          this.write(count++, {
            id: `${school.id}:${index}`,
            x: centerX + Math.cos(angle) * radius,
            z: centerZ + Math.sin(angle) * radius,
            depth: 0.31 + random() * 0.28,
            heading: angle + Math.PI / 2,
            size: school.kind === 'memorial' ? 0.72 : 0.4 + random() * 0.28,
            tint: school.tint,
            seed: Number(school.seed) ^ index,
          }, elapsed);
        }
      }
      this.body.count = count;
      this.belly.count = count;
      this.tail.count = count;
      this.dorsal.count = count;
      this.eyeWhite.count = count * 2;
      this.eyeBlack.count = count * 2;
      for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
      if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
      if (this.tail.instanceColor) this.tail.instanceColor.needsUpdate = true;
      if (this.dorsal.instanceColor) this.dorsal.instanceColor.needsUpdate = true;
    }
  }

  function addUnderwaterFillRuntime(material, strength) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * ${strength.toFixed(2)};`
      );
    };
    material.customProgramCacheKey = () => `canonical-underwater-fill-${strength.toFixed(2)}`;
  }

  class CodexFishRenderer {
    constructor(capacity) {
      this.capacity = capacity;
      this.matrix = new THREE.Matrix4();
      this.center = new THREE.Vector3();
      this.position = new THREE.Vector3();
      this.quaternion = new THREE.Quaternion();
      this.rotation = new THREE.Euler();
      this.scale = new THREE.Vector3();
      this.color = new THREE.Color();
      this.white = new THREE.Color(0xf2eee1);
      this.faded = new THREE.Color(0xcbd4cb);
      this.raycaster = new THREE.Raycaster();
      this.pointer = new THREE.Vector2();
      this.indexToId = [];

      const bodyGeometry = new THREE.SphereGeometry(1, LOW_QUALITY ? 8 : 11, LOW_QUALITY ? 5 : 7);
      const bodyMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: false,
      });
      this.bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, capacity);

      const tailGeometry = new THREE.ConeGeometry(0.62, 1.2, 4);
      tailGeometry.rotateZ(-Math.PI / 2);
      const tailMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      this.tails = new THREE.InstancedMesh(tailGeometry, tailMaterial, capacity);

      const finGeometry = new THREE.ConeGeometry(0.42, 0.9, 3);
      const finMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      this.fins = new THREE.InstancedMesh(finGeometry, finMaterial, capacity);

      const sideFinGeometry = new THREE.ConeGeometry(0.34, 0.95, 3);
      sideFinGeometry.rotateX(Math.PI / 2);
      this.sideFins = new THREE.InstancedMesh(sideFinGeometry, finMaterial, capacity * 2);

      const eyeGeometry = new THREE.SphereGeometry(1, LOW_QUALITY ? 5 : 7, LOW_QUALITY ? 4 : 6);
      this.eyeWhites = new THREE.InstancedMesh(eyeGeometry, new THREE.MeshBasicMaterial({
        color: 0xf3eee0,
        toneMapped: false,
      }), capacity * 2);
      this.eyePupils = new THREE.InstancedMesh(eyeGeometry, new THREE.MeshBasicMaterial({
        color: 0x17383b,
        toneMapped: false,
      }), capacity * 2);
      this.mouths = new THREE.InstancedMesh(eyeGeometry, new THREE.MeshBasicMaterial({
        color: 0x24494c,
        toneMapped: false,
      }), capacity);

      this.singleMeshes = [this.bodies, this.tails, this.fins, this.mouths];
      this.doubleMeshes = [this.sideFins, this.eyeWhites, this.eyePupils];
      this.colorMeshes = [this.bodies, this.tails, this.fins, this.sideFins];
      this.meshes = [...this.singleMeshes, ...this.doubleMeshes];
      for (const mesh of this.colorMeshes) {
        mesh.setColorAt(0, this.white);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      for (const mesh of this.meshes) {
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(mesh);
      }
    }

    write(index, state, elapsed, owned, interactiveId) {
      const baseSize = 0.82 + state.size * 0.96;
      normalizedToWorld(state.x, state.z, state.depth, this.center);
      const phase = hashString(state.id) * 0.001;
      this.center.y += Math.sin(elapsed * 2.1 + phase) * 0.12;
      this.position.copy(this.center);
      this.rotation.set(0, -state.heading, Math.sin(elapsed * 1.7 + phase) * 0.035);
      this.quaternion.setFromEuler(this.rotation);
      this.scale.set(baseSize * 1.48, baseSize * 0.56, baseSize * 0.43);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.bodies.setMatrixAt(index, this.matrix);

      this.color.setHex(Number(state.tint || 0x61c8bf));
      if (state.lifeKind === 'memorial') this.color.lerp(this.white, 0.2);
      if (state.ageRatio > 0.86) this.color.lerp(this.faded, (state.ageRatio - 0.86) / 0.14 * 0.38);
      if (owned) this.color.lerp(this.white, 0.26).offsetHSL(0, 0.04, 0.06);
      if (state.glint) this.color.lerp(this.white, 0.72);
      this.bodies.setColorAt(index, this.color);

      const forwardX = Math.cos(state.heading);
      const forwardZ = Math.sin(state.heading);
      const lateralX = -forwardZ;
      const lateralZ = forwardX;
      const tailWag = reducedMotion ? 0 : Math.sin(elapsed * 7.2 + phase * 3) * 0.3;
      this.position.copy(this.center);
      this.position.x -= forwardX * baseSize * 1.48;
      this.position.z -= forwardZ * baseSize * 1.48;
      this.rotation.set(0, -state.heading + tailWag, 0);
      this.quaternion.setFromEuler(this.rotation);
      this.scale.set(baseSize * 0.74, baseSize * 0.88, baseSize * 0.34);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.tails.setMatrixAt(index, this.matrix);
      this.tails.setColorAt(index, this.color);

      this.position.copy(this.center);
      this.position.x -= forwardX * baseSize * 0.23;
      this.position.z -= forwardZ * baseSize * 0.23;
      this.position.y += baseSize * 0.48;
      this.rotation.set(0, -state.heading, 0);
      this.quaternion.setFromEuler(this.rotation);
      this.scale.set(baseSize * 0.38, baseSize * 0.5, baseSize * 0.16);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.fins.setMatrixAt(index, this.matrix);
      this.fins.setColorAt(index, this.color);

      const pairedIndex = index * 2;
      const finFlap = reducedMotion ? 0 : Math.sin(elapsed * 4.4 + phase * 2.2) * 0.08;
      for (let pair = 0; pair < 2; pair++) {
        const side = pair === 0 ? -1 : 1;
        const instanceIndex = pairedIndex + pair;

        this.position.copy(this.center);
        this.position.x += (-forwardX * 0.1 + lateralX * side * 0.42) * baseSize;
        this.position.y -= baseSize * 0.08;
        this.position.z += (-forwardZ * 0.1 + lateralZ * side * 0.42) * baseSize;
        this.rotation.set(0.22 + finFlap, -state.heading + (side < 0 ? Math.PI : 0), 0);
        this.quaternion.setFromEuler(this.rotation);
        this.scale.set(baseSize * 0.48, baseSize * 0.3, baseSize * 0.66);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.sideFins.setMatrixAt(instanceIndex, this.matrix);
        this.sideFins.setColorAt(instanceIndex, this.color);

        this.position.copy(this.center);
        this.position.x += (forwardX * 1.01 + lateralX * side * 0.36) * baseSize;
        this.position.y += baseSize * 0.13;
        this.position.z += (forwardZ * 1.01 + lateralZ * side * 0.36) * baseSize;
        this.quaternion.identity();
        this.scale.setScalar(baseSize * 0.075);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.eyeWhites.setMatrixAt(instanceIndex, this.matrix);

        this.position.copy(this.center);
        this.position.x += (forwardX * 1.045 + lateralX * side * 0.425) * baseSize;
        this.position.y += baseSize * 0.135;
        this.position.z += (forwardZ * 1.045 + lateralZ * side * 0.425) * baseSize;
        this.scale.setScalar(baseSize * 0.035);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.eyePupils.setMatrixAt(instanceIndex, this.matrix);
      }

      this.position.copy(this.center);
      this.position.x += forwardX * baseSize * 1.445;
      this.position.y -= baseSize * 0.055;
      this.position.z += forwardZ * baseSize * 1.445;
      this.rotation.set(0, -state.heading, 0);
      this.quaternion.setFromEuler(this.rotation);
      this.scale.set(baseSize * 0.035, baseSize * 0.035, baseSize * 0.13);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mouths.setMatrixAt(index, this.matrix);
      this.indexToId[index] = interactiveId || '';
    }

    update(trackedViews, _cohorts, elapsed, ownedEntityId) {
      let count = 0;
      this.indexToId.length = 0;
      for (const view of trackedViews) {
        if (count >= this.capacity) break;
        if (view.state.kind !== 'soulFish' && view.state.kind !== 'wildFish') continue;
        if (view.hiddenUntil && view.hiddenUntil > elapsed) continue;
        this.write(count++, {
          ...view.state,
          x: view.currentX,
          z: view.currentZ,
          depth: view.currentDepth,
          heading: view.currentHeading,
          glint: view.glintUntil > client.serverNow(),
        }, elapsed, view.state.id === ownedEntityId, view.state.id);
      }

      for (const mesh of this.singleMeshes) {
        mesh.count = count;
      }
      for (const mesh of this.doubleMeshes) {
        mesh.count = count * 2;
      }
      for (const mesh of this.meshes) {
        mesh.instanceMatrix.needsUpdate = true;
      }
      for (const mesh of this.colorMeshes) {
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }

    entityAtScreen(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, camera);
      const hit = this.raycaster.intersectObject(this.bodies, false)[0];
      if (!hit || hit.instanceId === undefined) return null;
      return this.indexToId[hit.instanceId] || null;
    }
  }

  function buildBirdCatch() {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0x61c8bf, toneMapped: false });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 5), material);
    body.scale.set(1.55, 0.58, 0.48);
    group.add(body);
    const tailGeometry = new THREE.ConeGeometry(0.085, 0.18, 4);
    tailGeometry.rotateZ(-Math.PI / 2);
    const tail = new THREE.Mesh(tailGeometry, material);
    tail.position.x = -0.2;
    group.add(tail);
    const finGeometry = new THREE.ConeGeometry(0.055, 0.13, 3);
    const fin = new THREE.Mesh(finGeometry, material);
    fin.position.set(-0.01, 0.095, 0);
    group.add(fin);
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 5, 4),
      new THREE.MeshBasicMaterial({ color: 0xf3eee0, toneMapped: false })
    );
    eye.position.set(0.11, 0.025, 0.052);
    group.add(eye);
    group.position.set(0.46, -0.08, 0);
    group.rotation.z = -0.28;
    group.visible = false;
    group.userData.bodyMaterial = material;
    return group;
  }

  class BirdStrikeVisual {
    constructor(target, index, onCatch) {
      this.target = target;
      this.onCatch = onCatch;
      this.age = -index * 0.22;
      this.duration = 5.2;
      this.impacted = false;
      this.previousPosition = new THREE.Vector3();
      this.position = new THREE.Vector3();
      this.targetWorld = normalizedToWorld(target.x, target.z, 0, new THREE.Vector3());
      this.targetWorld.y = 1.25;

      const random = mulberry(hashString(`bird-strike:${target.id}:${index}`));
      const approachAngle = random() * TAU;
      this.start = new THREE.Vector3(
        this.targetWorld.x - Math.cos(approachAngle) * R_WATER * 1.55,
        36 + random() * 10,
        this.targetWorld.z - Math.sin(approachAngle) * R_WATER * 1.55
      );
      this.exit = new THREE.Vector3(
        this.targetWorld.x + Math.cos(approachAngle) * R_WATER * 1.7,
        48 + random() * 12,
        this.targetWorld.z + Math.sin(approachAngle) * R_WATER * 1.7
      );
      this.position.copy(this.start);
      this.previousPosition.copy(this.start);

      const glb = assetCache.bird ? instantiateGLB('bird') : null;
      this.model = glb ? glb.root : buildBird('#2d3138');
      this.mixer = glb ? glb.mixer : null;
      this.mesh = unitWrap(this.model);
      this.mesh.scale.setScalar(7.2 + random() * 1.8);
      this.mesh.visible = false;
      this.catch = buildBirdCatch();
      this.catch.userData.bodyMaterial.color.setHex(Number(target.tint || 0x61c8bf));
      this.mesh.add(this.catch);
      scene.add(this.mesh);
      this.shadow = makeBlobShadow(1);
      this.shadow.visible = false;
      scene.add(this.shadow);
    }

    update(deltaSeconds, elapsed) {
      this.age += deltaSeconds;
      if (this.age < 0) return true;
      const progress = Math.min(1, this.age / this.duration);
      this.mesh.visible = true;
      this.shadow.visible = true;
      this.previousPosition.copy(this.position);

      if (progress < 0.52) {
        const raw = progress / 0.52;
        const eased = raw * raw * (3 - 2 * raw);
        this.position.copy(this.start).lerp(this.targetWorld, eased);
        this.position.y += Math.sin(raw * Math.PI) * 7;
      } else {
        const raw = (progress - 0.52) / 0.48;
        const eased = raw * raw * (3 - 2 * raw);
        this.position.copy(this.targetWorld).lerp(this.exit, eased);
        this.position.y += Math.sin(raw * Math.PI) * 5;
      }

      if (!this.impacted && progress >= 0.5) {
        this.impacted = true;
        this.catch.visible = true;
        const gameX = this.target.x * W;
        const gameY = this.target.z * H;
        addRipple(gameX, gameY, { maxRadius: 64, speed: 1.35, opacity: 0.4 });
        disturbWater(gameX, gameY, 7, 90);
        this.onCatch(this.target.id, elapsed + 12);
      }

      const dx = this.position.x - this.previousPosition.x;
      const dz = this.position.z - this.previousPosition.z;
      const heading = Math.atan2(dz, dx);
      this.mesh.position.copy(this.position);
      this.mesh.rotation.y = -heading;
      this.mesh.rotation.z = progress < 0.52 ? -0.3 : 0.38;
      this.mesh.rotation.x = progress > 0.43 && progress < 0.6 ? -0.2 : 0;
      if (this.mixer) this.mixer.update(deltaSeconds);
      else if (this.model.userData.wings) {
        const flap = Math.sin(elapsed * 11 + this.age * 2) * 0.9;
        for (const wing of this.model.userData.wings) {
          wing.pivot.rotation.x = flap * wing.side;
          wing.pivot.rotation.z = 0;
        }
      }

      this.shadow.position.set(this.position.x, 0.1, this.position.z);
      this.shadow.scale.setScalar(5 + this.position.y * 0.11);
      this.shadow.material.opacity = clamp(0.3 - this.position.y * 0.006, 0.025, 0.24);
      return progress < 1;
    }

    destroy() {
      scene.remove(this.mesh);
      scene.remove(this.shadow);
      this.shadow.material.dispose();
    }
  }

  class CanonicalEntityLayer {
    constructor() {
      this.tracked = new Map();
      this.backgroundCohorts = [];
      this.natureEvents = new Map();
      this.eventVisuals = new Map();
      this.eventEffects = new Set();
      this.background = new CodexFishRenderer(LOW_QUALITY ? 360 : 520);
      this.ownedEntityId = null;
      this.raycaster = new THREE.Raycaster();
      this.pointer = new THREE.Vector2();
      this.worldPoint = new THREE.Vector3();
      this.worldPointB = new THREE.Vector3();
      this.worldDirection = new THREE.Vector3();
    }

    createView(state) {
      const view = {
        state,
        currentX: state.x,
        currentZ: state.z,
        currentDepth: state.depth,
        currentHeading: state.heading,
        targetX: state.x,
        targetZ: state.z,
        targetDepth: state.depth,
        targetHeading: state.heading,
        fish: null,
        lily: null,
        bird: null,
        frog: null,
        hiddenUntil: 0,
        glintUntil: 0,
      };
      if (state.kind === 'legendaryPenguin') {
        const fish = new Fish3D(state.x * W, state.z * H, 3, false);
        fish.decay = 0;
        fish.life = 1;
        fish.invuln = 0;
        fish.growthScale = 1;
        view.fish = fish;
      } else if (state.kind === 'lily') {
        const hasFlower = (hashString(state.id) % 100) < (state.state && state.state.source === 'offering' ? 72 : 48);
        const model = buildLily(hasFlower);
        model.traverse((node) => {
          if (!node.isMesh || !node.material) return;
          node.material.transparent = false;
          node.material.opacity = 1;
          node.material.depthWrite = true;
          node.renderOrder = 4;
        });
        const mesh = unitWrap(model);
        scene.add(mesh);
        view.lily = {
          model,
          mesh,
          size: 18 + state.size * 16,
          hasFlower,
          baseColors: new Map(),
        };
        model.traverse((node) => {
          if (node.isMesh && node.material && node.material.color) view.lily.baseColors.set(node.material, node.material.color.clone());
        });
      } else if (state.kind === 'bird') {
        const glb = assetCache.bird ? instantiateGLB('bird') : null;
        const model = glb ? glb.root : buildBird('#333640');
        const mesh = unitWrap(model);
        scene.add(mesh);
        const seed = hashString(state.id);
        const ordinalMatch = state.id.match(/(\d+)$/);
        const ordinal = ordinalMatch ? Number(ordinalMatch[1]) : seed;
        const shadow = makeBlobShadow(1);
        scene.add(shadow);
        view.bird = {
          model,
          mesh,
          shadow,
          mixer: glb ? glb.mixer : null,
          phase: seed * 0.001,
          idleRole: ordinal % 3,
          perchAngle: (seed % 6283) / 1000,
          perchIndex: ordinal,
          flightSpeed: 0.13 + (seed % 1000) / 1000 * 0.045,
          flightRadius: R_WATER * (0.48 + ((seed >>> 8) % 1000) / 1000 * 0.22),
          flightSquash: 0.72 + ((seed >>> 16) % 1000) / 1000 * 0.2,
        };
      } else if (state.kind === 'frog') {
        const model = buildFrog();
        const mesh = unitWrap(model);
        const shadow = makeBlobShadow(1);
        const tongueMaterial = new THREE.MeshStandardMaterial({ color: 0xf36f88, emissive: 0x4a0f1b, roughness: 0.42 });
        const tongue = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 1, 7), tongueMaterial);
        const tongueTip = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), tongueMaterial);
        tongue.visible = false;
        tongueTip.visible = false;
        scene.add(mesh, shadow, tongue, tongueTip);
        view.frog = {
          model,
          mesh,
          shadow,
          tongue,
          tongueTip,
          baseScale: 5.4,
          feedEvent: null,
        };
      }
      return view;
    }

    remove(id) {
      const view = this.tracked.get(id);
      if (!view) return;
      if (view.fish) view.fish.destroy();
      if (view.lily) scene.remove(view.lily.mesh);
      if (view.bird) {
        scene.remove(view.bird.mesh);
        scene.remove(view.bird.shadow);
        view.bird.shadow.material.dispose();
      }
      if (view.frog) {
        scene.remove(view.frog.mesh, view.frog.shadow, view.frog.tongue, view.frog.tongueTip);
        view.frog.shadow.material.dispose();
        view.frog.tongue.geometry.dispose();
        view.frog.tongue.material.dispose();
        view.frog.tongueTip.geometry.dispose();
      }
      this.tracked.delete(id);
      if (id === this.ownedEntityId) myFish = null;
    }

    upsert(state, immediate) {
      let view = this.tracked.get(state.id);
      if (!view) {
        view = this.createView(state);
        this.tracked.set(state.id, view);
        return;
      }
      view.state = state;
      view.targetX = state.x;
      view.targetZ = state.z;
      view.targetDepth = state.depth;
      view.targetHeading = state.heading;
      if (immediate) {
        view.currentX = state.x;
        view.currentZ = state.z;
        view.currentDepth = state.depth;
        view.currentHeading = state.heading;
      }
    }

    applyMotion(motion) {
      const view = this.tracked.get(motion.id);
      if (!view) return;
      view.targetX = motion.x;
      view.targetZ = motion.z;
      view.targetDepth = motion.depth;
      view.targetHeading = motion.heading;
      view.state = Object.assign({}, view.state, {
        x: motion.x,
        z: motion.z,
        depth: motion.depth,
        heading: motion.heading,
        size: motion.size,
        ageRatio: motion.ageRatio,
        state: motion.state || view.state.state || {},
      });
    }

    applyNatureEvents(events) {
      const now = client.serverNow();
      for (const event of events || []) {
        if (!event || event.endsAt <= now) continue;
        const isNew = !this.natureEvents.has(event.id);
        this.natureEvents.set(event.id, event);
        if (isNew) audio.playNature(event.kind, event.strength);
        if (event.kind === 'fish_glint') {
          for (const id of event.targetIds || []) {
            const view = this.tracked.get(id);
            if (view) view.glintUntil = Math.max(view.glintUntil || 0, event.endsAt);
          }
        }
        if ((event.kind === 'frog_feed' || event.kind === 'dragonfly_pass')
          && !this.eventVisuals.has(event.id)
          && !(event.kind === 'frog_feed' && this.eventEffects.has(event.id))) {
          const model = buildDragonfly(event.kind === 'frog_feed' ? '#6ec9d2' : '#91d6c6');
          const mesh = unitWrap(model);
          scene.add(mesh);
          this.eventVisuals.set(event.id, { model, mesh });
        }
        if (event.kind === 'water_disturbance' && !this.eventEffects.has(event.id)) {
          const point = normalizedToGame(event);
          addRipple(point.x, point.y, { maxRadius: 48, speed: 0.8, opacity: 0.2 });
          disturbWater(point.x, point.y, 4.5, 70);
          this.eventEffects.add(event.id);
        }
      }
    }

    applySnapshot(snapshot) {
      const incoming = new Set(snapshot.entities.map((entity) => entity.id));
      for (const id of this.tracked.keys()) if (!incoming.has(id)) this.remove(id);
      for (const state of snapshot.entities) this.upsert(state, true);
      this.backgroundCohorts = snapshot.backgroundCohorts || [];
      this.applyNatureEvents(snapshot.natureEvents || []);
    }

    applyDelta(delta) {
      for (const id of delta.removedIds || []) this.remove(id);
      for (const id of delta.hiddenIds || []) this.remove(id);
      for (const state of delta.upserts || []) this.upsert(state, false);
      for (const motion of delta.motions || []) this.applyMotion(motion);
      this.backgroundCohorts = delta.backgroundCohorts || this.backgroundCohorts;
      this.applyNatureEvents(delta.natureEvents || []);
    }

    setOwnedEntity(id) {
      this.ownedEntityId = id;
      myFish = null;
    }

    syncFish(view, deltaSeconds, elapsed) {
      const fish = view.fish;
      const state = view.state;
      fish.tailPhase += deltaSeconds * 7.2;
      fish.bob += deltaSeconds * 1.8;
      fish.x = view.currentX * W;
      fish.y = view.currentZ * H;
      fish.angle = view.currentHeading;
      normalizedToWorld(view.currentX, view.currentZ, view.currentDepth, this.worldPoint);
      this.worldPoint.y += Math.sin(fish.bob) * 0.2;
      fish.mesh.position.copy(this.worldPoint);
      fish.mesh.rotation.y = -view.currentHeading;
      fish.mesh.rotation.z = Math.sin(fish.tailPhase * 0.32) * 0.065;
      fish.mesh.scale.setScalar(fish.size * SCALE * VISUAL);
      if (fish.mixer) fish.mixer.update(deltaSeconds);
      else if (fish.model.userData.tail) fish.model.userData.tail.rotation.y = Math.sin(fish.tailPhase) * 0.5;
      if (fish.model.userData.glow) {
        const glow = fish.model.userData.glow;
        const pulse = 0.82 + Math.sin(elapsed * 2.1) * 0.18;
        if (glow.isSprite) glow.material.opacity = glow.userData.baseOpacity * pulse;
      }
      if (state.refugeUntil && state.refugeUntil > client.serverNow() && fish.model.userData.body) {
        fish.model.userData.body.rotation.x = Math.sin(elapsed * 1.4) * 0.018;
      }
    }

    syncLily(view, elapsed) {
      const lily = view.lily;
      const state = view.state;
      const now = client.serverNow();
      const source = state.state && state.state.source;
      const growth = source === 'baseline' || !state.bornAt
        ? 1
        : THREE.MathUtils.clamp((now - state.bornAt) / ORBIT_PERIOD_MS, 0.02, 1);
      const returningAt = state.state && state.state.returningAt;
      const returning = returningAt && state.endsAt && now >= returningAt
        ? THREE.MathUtils.clamp((now - returningAt) / Math.max(1, state.endsAt - returningAt), 0, 1)
        : 0;
      const worldX = toWorldX(view.currentX * W);
      const worldZ = toWorldZ(view.currentZ * H);
      const waveY = sampleWaterHeight(worldX, worldZ, waterUniforms.uTime.value);
      const sink = returning > 0.88 ? Math.pow((returning - 0.88) / 0.12, 2) * 0.75 : 0;
      const eventRock = [...this.natureEvents.values()].some((event) => event.kind === 'lily_movement' && event.targetIds.includes(state.id));
      const rock = (eventRock ? 0.055 : 0.018) * Math.sin(elapsed * (eventRock ? 3.2 : 0.7) + hashString(state.id));
      lily.mesh.position.set(worldX, waveY + 0.16 - sink, worldZ);
      lily.mesh.rotation.set(rock * 0.45, view.currentHeading, rock);
      lily.mesh.scale.setScalar(Math.max(0.001, lily.size * SCALE * VISUAL * growth * (1 - returning * 0.68)));
      const flower = lily.model.userData.flowerGroup;
      if (flower) {
        flower.visible = lily.hasFlower && growth > 0.72 && returning < 0.98;
        const close = 1 - returning * 0.88;
        flower.scale.set(close, Math.max(0.08, close * close), close);
      }
      for (const [material, base] of lily.baseColors) {
        material.color.copy(base).lerp(new THREE.Color(0x667168), returning * 0.78);
        material.transparent = false;
        material.opacity = 1;
        material.depthWrite = true;
      }
    }

    activeNature(kind, entityId) {
      const now = client.serverNow();
      for (const event of this.natureEvents.values()) {
        if (event.kind === kind && event.startsAt <= now && event.endsAt > now && event.targetIds.includes(entityId)) return event;
      }
      return null;
    }

    syncFrog(view, elapsed) {
      const frog = view.frog;
      const state = view.state;
      const runtime = state.state || {};
      const growth = THREE.MathUtils.clamp(view.debugGrowth || runtime.growthScale || 1, 1, 3);
      const frogX = view.debugPinned ? 0.5 : view.currentX;
      const frogZ = view.debugPinned ? 0.5 : view.currentZ;
      const worldX = toWorldX(frogX * W);
      const worldZ = toWorldZ(frogZ * H);
      const radius = Math.hypot(worldX, worldZ);
      const mode = runtime.mode || 'floating';
      const surface = sampleWaterHeight(worldX, worldZ, waterUniforms.uTime.value);
      let height = surface + 0.38;
      if (mode === 'swimming') height = surface - 0.05;
      else if (mode === 'shore' || mode === 'ground') height = terrainHeight(radius) + 0.65;
      else if (mode === 'lily') height = surface + 0.5;
      const transitionStart = runtime.transitionStartedAt || 0;
      const transitionEnd = runtime.transitionEndsAt || 0;
      const transitionProgress = transitionEnd > transitionStart
        ? THREE.MathUtils.clamp((client.serverNow() - transitionStart) / (transitionEnd - transitionStart), 0, 1)
        : 1;
      const hop = transitionProgress < 1 ? Math.sin(transitionProgress * Math.PI) * (mode === 'ground' ? 5.2 : 2.8) : 0;
      const feedEvent = this.activeNature('frog_feed', state.id);
      const callEvent = this.activeNature('frog_call', state.id);
      const feedProgress = feedEvent
        ? THREE.MathUtils.clamp((client.serverNow() - feedEvent.startsAt) / Math.max(1, feedEvent.endsAt - feedEvent.startsAt), 0, 1)
        : 0;
      const chew = feedEvent && feedProgress > 0.67 && feedProgress < 0.94
        ? Math.sin((feedProgress - 0.67) * Math.PI * 15) * (1 - (feedProgress - 0.67) / 0.27)
        : 0;
      const callPulse = callEvent ? Math.max(0, Math.sin((client.serverNow() - callEvent.startsAt) * 0.012)) * 0.055 : 0;
      const pulse = 1 + (feedEvent ? Math.max(0, chew) * 0.045 : 0) + callPulse;
      frog.mesh.position.set(worldX, height + hop, worldZ);
      frog.mesh.rotation.y = -view.currentHeading;
      frog.mesh.scale.setScalar(frog.baseScale * growth * pulse);
      frog.shadow.position.set(worldX, Math.max(0.07, terrainHeight(radius) + 0.08), worldZ);
      frog.shadow.scale.setScalar(frog.baseScale * growth * (1.05 - Math.min(0.6, hop * 0.06)));
      frog.shadow.material.opacity = mode === 'swimming' ? 0.08 : 0.2 * (1 - Math.min(0.75, hop * 0.08));

      const rig = frog.model.userData;
      if (rig.lowerJaw) rig.lowerJaw.rotation.z = feedEvent ? -Math.sin(Math.min(1, feedProgress / 0.2) * Math.PI) * 0.16 - Math.max(0, chew) * 0.08 : 0;
      if (rig.eyeGroups) {
        const blink = feedEvent && feedProgress > 0.72 && feedProgress < 0.82 ? 0.12 : 1;
        for (const eye of rig.eyeGroups) eye.scale.y = blink;
      }
      frog.mesh.updateMatrixWorld(true);

      frog.tongue.visible = false;
      frog.tongueTip.visible = false;
      if (feedEvent && rig.tongueAnchor) {
        const visual = this.eventVisuals.get(feedEvent.id);
        const start = feedEvent.from || { x: state.x, z: state.z };
        const end = feedEvent.to || { x: state.x, z: state.z };
        const approach = THREE.MathUtils.clamp(feedProgress / 0.48, 0, 1);
        const insectX = THREE.MathUtils.lerp(start.x, end.x, approach * 0.35) + Math.sin(elapsed * 11 + feedEvent.seed) * 0.004;
        const insectZ = THREE.MathUtils.lerp(start.z, end.z, approach * 0.35) + Math.cos(elapsed * 9 + feedEvent.seed) * 0.004;
        normalizedToWorld(insectX, insectZ, 0, this.worldPointB);
        this.worldPointB.y = surface + 2.1 + Math.sin(elapsed * 8) * 0.22;
        rig.tongueAnchor.getWorldPosition(this.worldPoint);

        let tongueAmount = 0;
        if (feedProgress >= 0.24 && feedProgress < 0.48) tongueAmount = (feedProgress - 0.24) / 0.24;
        else if (feedProgress >= 0.48 && feedProgress < 0.72) tongueAmount = 1 - (feedProgress - 0.48) / 0.24;
        tongueAmount = tongueAmount * tongueAmount * (3 - 2 * tongueAmount);
        const tip = this.worldDirection.copy(this.worldPoint).lerp(this.worldPointB, tongueAmount);
        if (feedProgress >= 0.48 && feedProgress < 0.72 && visual) visual.mesh.position.copy(tip);
        else if (visual) visual.mesh.position.copy(this.worldPointB);
        if (visual) {
          visual.mesh.visible = feedProgress < 0.72;
          visual.mesh.rotation.y = elapsed * 3.5;
          visual.mesh.scale.setScalar(1.1);
        }
        if (tongueAmount > 0.01) {
          const length = this.worldPoint.distanceTo(tip);
          frog.tongue.visible = true;
          frog.tongueTip.visible = true;
          frog.tongue.position.copy(this.worldPoint).lerp(tip, 0.5);
          frog.tongue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.worldPointB.copy(tip).sub(this.worldPoint).normalize());
          frog.tongue.scale.set(growth, Math.max(0.01, length), growth);
          frog.tongueTip.position.copy(tip);
          frog.tongueTip.scale.setScalar(growth);
        }
      }
    }

    syncBird(view, deltaSeconds, elapsed) {
      const bird = view.bird;
      const now = client.serverNow();
      const worldSeconds = now / 1000;
      const birdScale = 3.8 + view.state.size * 1.2;
      const runtime = view.state.state || {};
      const mode = runtime.mode || 'circling';
      let x = toWorldX(view.currentX * W);
      let z = toWorldZ(view.currentZ * H);
      const radius = Math.hypot(x, z);
      let groundHeight = terrainHeight(radius) + 0.08;
      let height = mode === 'circling' ? 18 : mode === 'perched' ? groundHeight + 10.5 : groundHeight + 1.2;
      let heading = view.currentHeading;
      let pitch = 0;
      let bank = 0;
      let flap = mode === 'circling' ? Math.sin(worldSeconds * 8.5 + bird.phase) * 0.72 : 0.82;
      const transitionStart = runtime.transitionStartedAt || 0;
      const transitionEnd = runtime.transitionEndsAt || 0;
      if (transitionEnd > now && transitionEnd > transitionStart) {
        const progress = THREE.MathUtils.clamp((now - transitionStart) / (transitionEnd - transitionStart), 0, 1);
        height += Math.sin(progress * Math.PI) * 8;
        flap = Math.sin(worldSeconds * 10 + bird.phase) * 0.78;
      }
      if (mode === 'foraging') {
        pitch = Math.max(0, Math.sin(worldSeconds * 2.2 + bird.phase)) * 0.34;
      } else if (mode === 'circling') {
        bank = Math.sin(worldSeconds * 1.2 + bird.phase) * 0.23;
      }

      const hunt = this.activeNature('bird_hunt', view.state.id);
      if (hunt) {
        const progress = THREE.MathUtils.clamp((now - hunt.startsAt) / Math.max(1, hunt.endsAt - hunt.startsAt), 0, 1);
        const targetX = toWorldX(hunt.x * W);
        const targetZ = toWorldZ(hunt.z * H);
        const ordinal = bird.perchIndex % 6;
        const angle = ordinal / 6 * TAU + bird.phase;
        const startX = targetX + Math.cos(angle) * 90;
        const startZ = targetZ + Math.sin(angle) * 90;
        const exitX = targetX - Math.cos(angle) * 120;
        const exitZ = targetZ - Math.sin(angle) * 120;
        if (progress < 0.54) {
          const p = progress / 0.54;
          x = THREE.MathUtils.lerp(startX, targetX, p);
          z = THREE.MathUtils.lerp(startZ, targetZ, p);
          height = THREE.MathUtils.lerp(24, 1.2, p) + Math.sin(p * Math.PI) * 4;
        } else {
          const p = (progress - 0.54) / 0.46;
          x = THREE.MathUtils.lerp(targetX, exitX, p);
          z = THREE.MathUtils.lerp(targetZ, exitZ, p);
          height = THREE.MathUtils.lerp(1.2, 25, p);
        }
        heading = Math.atan2(z - bird.mesh.position.z, x - bird.mesh.position.x);
        pitch = progress < 0.54 ? -0.28 : 0.3;
        bank = Math.sin(progress * Math.PI * 2 + ordinal) * 0.36;
        flap = Math.sin(worldSeconds * 12 + bird.phase) * 0.82;
      }

      bird.mesh.position.set(x, height, z);
      bird.mesh.rotation.set(pitch, -heading, bank);
      bird.mesh.scale.setScalar(birdScale);
      if (bird.mixer) bird.mixer.update(deltaSeconds);
      else if (bird.model.userData.wings) {
        for (const wing of bird.model.userData.wings) {
          wing.pivot.rotation.x = flap * wing.side;
          wing.pivot.rotation.z = 0;
        }
      }
      bird.shadow.visible = mode !== 'perched' || !!hunt;
      if (bird.shadow.visible) {
        bird.shadow.position.set(x, groundHeight, z);
        const clearance = Math.max(0, height - groundHeight);
        bird.shadow.scale.setScalar(birdScale * (0.72 + clearance * 0.025));
        bird.shadow.material.opacity = clamp(0.28 - clearance * 0.007, 0.025, 0.24);
      }
    }

    getBirdStrikeTargets(limit, slot) {
      return [...this.tracked.values()]
        .filter((view) => view.state.kind === 'wildFish' && (!view.hiddenUntil || view.hiddenUntil <= elapsedV2))
        .sort((a, b) => hashString(`${slot}:${a.state.id}`) - hashString(`${slot}:${b.state.id}`))
        .slice(0, limit)
        .map((view) => ({
          id: view.state.id,
          x: view.currentX,
          z: view.currentZ,
          tint: view.state.tint,
        }));
    }

    hideForStrike(id, until) {
      const view = this.tracked.get(id);
      if (view) view.hiddenUntil = until;
    }

    updateNatureVisuals(elapsed) {
      const now = client.serverNow();
      for (const [id, event] of [...this.natureEvents]) {
        const duration = Math.max(1, event.endsAt - event.startsAt);
        const progress = THREE.MathUtils.clamp((now - event.startsAt) / duration, 0, 1);
        const visual = this.eventVisuals.get(id);
        if (event.kind === 'dragonfly_pass' && visual) {
          const from = event.from || { x: 0.1, z: event.z };
          const to = event.to || { x: 0.9, z: event.z };
          const x = THREE.MathUtils.lerp(from.x, to.x, progress);
          const z = THREE.MathUtils.lerp(from.z, to.z, progress);
          normalizedToWorld(x, z, 0, this.worldPoint);
          visual.mesh.position.set(this.worldPoint.x, 4.2 + Math.sin(elapsed * 8 + event.seed) * 0.5, this.worldPoint.z);
          visual.mesh.rotation.y = -Math.atan2(to.z - from.z, to.x - from.x);
          visual.mesh.scale.setScalar(1.2);
        }
        if (event.kind === 'frog_feed' && progress >= 0.72 && visual) {
          scene.remove(visual.mesh);
          this.eventVisuals.delete(id);
          if (!this.eventEffects.has(id)) {
            const point = normalizedToGame(event);
            addRipple(point.x, point.y, { maxRadius: 24, speed: 0.62, opacity: 0.18 });
            this.eventEffects.add(id);
          }
        }
        if (event.kind === 'bird_hunt' && progress >= 0.52 && !this.eventEffects.has(id)) {
          const point = normalizedToGame(event);
          addRipple(point.x, point.y, { maxRadius: 68, speed: 1.4, opacity: 0.34 });
          disturbWater(point.x, point.y, 8, 90);
          this.eventEffects.add(id);
        }
        if (event.endsAt <= now) {
          if (visual) scene.remove(visual.mesh);
          this.eventVisuals.delete(id);
          this.natureEvents.delete(id);
          this.eventEffects.delete(id);
        }
      }
    }

    update(deltaSeconds, elapsed) {
      this.updateNatureVisuals(elapsed);
      const smoothing = reducedMotion ? 1 : 1 - Math.exp(-deltaSeconds * 9.5);
      for (const view of this.tracked.values()) {
        view.currentX = THREE.MathUtils.lerp(view.currentX, view.targetX, smoothing);
        view.currentZ = THREE.MathUtils.lerp(view.currentZ, view.targetZ, smoothing);
        view.currentDepth = THREE.MathUtils.lerp(view.currentDepth, view.targetDepth, smoothing);
        view.currentHeading += shortestAngle(view.currentHeading, view.targetHeading) * smoothing;
        if (view.fish) this.syncFish(view, deltaSeconds, elapsed);
        else if (view.lily) this.syncLily(view, elapsed);
        else if (view.bird) this.syncBird(view, deltaSeconds, elapsed);
        else if (view.frog) this.syncFrog(view, elapsed);
      }
      this.background.update(this.tracked.values(), this.backgroundCohorts, elapsed, this.ownedEntityId);
      myFish = null;
    }

    getWorldPosition(id, target) {
      const view = this.tracked.get(id);
      if (!view) return null;
      return normalizedToWorld(view.currentX, view.currentZ, view.currentDepth, target);
    }

    ownedEntityAtScreen(clientX, clientY) {
      const hitId = this.background.entityAtScreen(clientX, clientY);
      return hitId && hitId === this.ownedEntityId ? hitId : null;
    }

    getLabelAnchors(width, height) {
      const candidates = [];
      for (const view of this.tracked.values()) {
        const state = view.state;
        if (!state.soulId || !state.label) continue;
        const point = normalizedToWorld(view.currentX, view.currentZ, view.currentDepth).add(new THREE.Vector3(0, 2.8, 0));
        const projected = point.project(camera);
        if (projected.z < -1 || projected.z > 1 || projected.x < -1.1 || projected.x > 1.1 || projected.y < -1.1 || projected.y > 1.1) continue;
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        const labelWidth = Math.min(190, Math.max(54, state.label.length * 6.2 + 16));
        candidates.push({
          id: state.id,
          text: state.label,
          x,
          y,
          color: colorCss(state.tint),
          owned: state.id === this.ownedEntityId,
          rect: { left: x - labelWidth * 0.5, right: x + labelWidth * 0.5, top: y - 22, bottom: y + 2 },
        });
      }
      if (candidates.length === 0) return [];

      const parent = candidates.map((_, index) => index);
      const find = (index) => {
        let cursor = index;
        while (parent[cursor] !== cursor) {
          parent[cursor] = parent[parent[cursor]];
          cursor = parent[cursor];
        }
        return cursor;
      };
      const unite = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent[rootB] = rootA;
      };
      for (let a = 0; a < candidates.length; a++) {
        for (let b = a + 1; b < candidates.length; b++) {
          const one = candidates[a].rect;
          const two = candidates[b].rect;
          if (one.left < two.right && one.right > two.left && one.top < two.bottom && one.bottom > two.top) unite(a, b);
        }
      }
      const groups = new Map();
      for (let index = 0; index < candidates.length; index++) {
        const root = find(index);
        const group = groups.get(root) || [];
        group.push(candidates[index]);
        groups.set(root, group);
      }

      const anchors = [];
      for (const [root, group] of groups) {
        if (group.length === 1) {
          const item = group[0];
          anchors.push({ key: item.id, text: item.text, x: item.x, y: item.y, color: item.color, owned: item.owned, cluster: false });
          continue;
        }
        const owned = group.find((item) => item.owned);
        const clustered = owned ? group.filter((item) => !item.owned) : group;
        if (owned) anchors.push({ key: owned.id, text: owned.text, x: owned.x, y: owned.y, color: owned.color, owned: true, cluster: false });
        if (clustered.length > 0) {
          const averageX = clustered.reduce((sum, item) => sum + item.x, 0) / clustered.length;
          const averageY = clustered.reduce((sum, item) => sum + item.y, 0) / clustered.length + (owned ? 24 : 0);
          anchors.push({
            key: `cluster:${root}`,
            text: `${clustered.length} ${clustered.length === 1 ? 'soul' : 'souls'} moving together`,
            x: averageX,
            y: averageY,
            color: '#b9dad1',
            owned: false,
            cluster: true,
          });
        }
      }
      return anchors;
    }
  }

  class StableCamera {
    constructor(layer, onModeChange) {
      this.layer = layer;
      this.onModeChange = onModeChange;
      this.mode = 'free';
      this.rideBearing = 0.82;
      this.lookTarget = controls.target.clone();
      this.desired = new THREE.Vector3();
      this.ownedPosition = new THREE.Vector3();
      this.freePosition = camera.position.clone();
      this.freeTarget = controls.target.clone();
      this.deathStartedAt = 0;
    }

    enterRide() {
      const id = this.layer.ownedEntityId;
      if (!id || !this.layer.getWorldPosition(id, this.ownedPosition)) return false;
      if (this.mode === 'free') {
        this.freePosition.copy(camera.position);
        this.freeTarget.copy(controls.target);
      }
      const offset = camera.position.clone().sub(this.ownedPosition);
      this.rideBearing = Math.atan2(offset.z, offset.x);
      this.lookTarget.copy(this.ownedPosition);
      this.mode = 'ride';
      controls.enabled = false;
      controls.autoRotate = false;
      client.focus(id);
      if (this.onModeChange) this.onModeChange('ride');
      return true;
    }

    enterFree() {
      this.mode = 'free';
      controls.enabled = true;
      camera.position.copy(this.freePosition);
      controls.target.copy(this.freeTarget);
      this.lookTarget.copy(this.freeTarget);
      lastInteract = performance.now();
      controls.update();
      client.focus(null);
      if (this.onModeChange) this.onModeChange('free');
    }

    toggle() {
      if (this.mode === 'ride') this.enterFree();
      else this.enterRide();
    }

    beginDeath() {
      this.mode = 'death';
      this.deathStartedAt = performance.now();
      controls.enabled = false;
      if (this.onModeChange) this.onModeChange('death');
    }

    adjustBearing(deltaPixels) {
      if (this.mode === 'ride') this.rideBearing += deltaPixels * 0.006;
    }

    update(deltaSeconds, now) {
      if (this.mode === 'free') {
        if (!reducedMotion && !controls.autoRotate && now - lastInteract > 6000) controls.autoRotate = true;
        controls.update();
        return;
      }
      controls.enabled = false;
      if (this.mode === 'death') {
        const age = (now - this.deathStartedAt) / 1000;
        camera.position.y += deltaSeconds * (4.5 + Math.min(5, age));
        this.lookTarget.lerp(new THREE.Vector3(0, 3, 0), 1 - Math.exp(-deltaSeconds * 0.8));
        camera.lookAt(this.lookTarget);
        if (age > 4.4) this.enterFree();
        return;
      }
      const id = this.layer.ownedEntityId;
      if (!id || !this.layer.getWorldPosition(id, this.ownedPosition)) {
        this.enterFree();
        return;
      }
      const radius = 18;
      this.desired.set(
        this.ownedPosition.x + Math.cos(this.rideBearing) * radius,
        this.ownedPosition.y + 8.5,
        this.ownedPosition.z + Math.sin(this.rideBearing) * radius
      );
      camera.position.lerp(this.desired, 1 - Math.exp(-deltaSeconds * 3.2));
      this.lookTarget.lerp(this.ownedPosition.clone().add(new THREE.Vector3(0, 0.55, 0)), 1 - Math.exp(-deltaSeconds * 4.4));
      camera.lookAt(this.lookTarget);
    }
  }

  let reducedMotion = false;
  try {
    const saved = localStorage.getItem(reducedMotionKey);
    reducedMotion = saved === null ? matchMedia('(prefers-reduced-motion: reduce)').matches : saved === 'true';
  } catch (error) {
    reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  const ui = new window.PondUI({ reducedMotion });
  const audio = new PondAudioV2();
  const client = new window.PondClientV2({ renderer: 'webgl', reducedMotion });
  const entities = new CanonicalEntityLayer();
  const stableCamera = new StableCamera(entities, (mode) => ui.setCameraMode(mode));
  const interactionRaycaster = new THREE.Raycaster();
  const interactionPointer = new THREE.Vector2();
  const interactionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let latestSnapshot = null;
  let orbitEpoch = Math.floor(Date.now() / ORBIT_PERIOD_MS) * ORBIT_PERIOD_MS;
  let orbitPeriod = ORBIT_PERIOD_MS;
  let returningEntityId = null;
  let resumedReturningFish = false;
  let queued = false;
  let frameCountV2 = 0;
  let previousFrame = performance.now();
  let elapsedV2 = 0;
  let lastLabelUpdate = 0;
  let lastAudioUpdate = 0;
  let loopErrors = 0;

  function serverOrbitPhase() {
    const elapsed = ((client.serverNow() - orbitEpoch) % orbitPeriod + orbitPeriod) % orbitPeriod;
    return elapsed / orbitPeriod;
  }

  function waterPointAtScreen(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    interactionPointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    interactionRaycaster.setFromCamera(interactionPointer, camera);
    const hit = new THREE.Vector3();
    if (!interactionRaycaster.ray.intersectPlane(interactionPlane, hit)) return null;
    if (Math.hypot(hit.x, hit.z) > FILL_R_WORLD) return null;
    return {
      normalized: {
        x: THREE.MathUtils.clamp(hit.x / (W * POS_SCALE) + 0.5, 0, 1),
        z: THREE.MathUtils.clamp(hit.z / (H * POS_SCALE) + 0.5, 0, 1),
      },
      world: hit,
    };
  }

  function applyRitual(ritual) {
    if (ritual.kind === 'ripple' && client.identity && ritual.soulId === client.identity.id) return;
    const point = normalizedToGame({ x: ritual.x, z: ritual.z });
    const strength = ritual.strength || 0.4;
    addRipple(point.x, point.y, {
      maxRadius: ritual.kind === 'birth' ? 86 : 42 + strength * 46,
      speed: ritual.kind === 'birth' ? 1.8 : 1.1,
      opacity: 0.18 + strength * 0.22,
    });
    disturbWater(point.x, point.y, 3 + strength * 8, 50 + strength * 90);
    if (ritual.kind === 'food') addPlanktonPack(point.x, point.y, true);
    if (ritual.kind === 'birth') audio.playRipple(0.9);
    else if (ritual.kind === 'ripple') audio.playRipple(0.45);
  }

  function applyLocalRipple(point, strength) {
    const game = normalizedToGame(point);
    const force = strength || 0.52;
    addRipple(game.x, game.y, { maxRadius: 44 + force * 34, speed: 1.18, opacity: 0.2 + force * 0.16 });
    disturbWater(game.x, game.y, 3.4 + force * 4.8, 72);
    audio.playRipple(force);
  }

  function spawnBirdStrikeEvent(slot) {
    const birds = [...entities.tracked.values()].filter((view) => view.state.kind === 'bird');
    const target = [...entities.tracked.values()].find((view) => view.state.kind === 'wildFish');
    if (birds.length === 0) return false;
    const now = client.serverNow();
    const targetX = target ? target.currentX : 0.5;
    const targetZ = target ? target.currentZ : 0.5;
    entities.applyNatureEvents([{
      id: `debug_bird_hunt_${slot}`,
      kind: 'bird_hunt',
      startsAt: now,
      endsAt: now + 8000,
      x: targetX,
      z: targetZ,
      strength: 0.9,
      seed: hashString(`debug_bird_hunt_${slot}`),
      targetIds: [...birds.map((view) => view.state.id), ...(target ? [target.state.id] : [])],
    }]);
    return true;
  }

  function spawnFrogFeedDebug(slot) {
    const frog = [...entities.tracked.values()].find((view) => view.state.kind === 'frog');
    if (!frog) return false;
    const now = client.serverNow();
    const insectId = `debug_insect_${slot}`;
    frog.debugPinned = true;
    frog.debugGrowth = 3;
    frog.currentX = frog.targetX = 0.5;
    frog.currentZ = frog.targetZ = 0.5;
    frog.state = Object.assign({}, frog.state, {
      x: 0.5,
      z: 0.5,
      heading: Math.PI * 0.18,
      state: Object.assign({}, frog.state.state, { growthScale: 3, mode: 'floating' }),
    });
    frog.currentHeading = frog.targetHeading = frog.state.heading;
    stableCamera.enterFree();
    stableCamera.freePosition.set(16, 8, 0);
    stableCamera.freeTarget.set(0, 1.2, 0);
    camera.position.copy(stableCamera.freePosition);
    controls.target.copy(stableCamera.freeTarget);
    controls.autoRotate = false;
    controls.update();
    entities.applyNatureEvents([{
      id: `debug_frog_feed_${slot}`,
      kind: 'frog_feed',
      startsAt: now,
      endsAt: now + 3200,
      x: 0.5,
      z: 0.5,
      strength: 0.9,
      seed: hashString(`debug_frog_feed_${slot}`),
      targetIds: [frog.state.id, insectId],
      frogId: frog.state.id,
      insectId,
      from: {
        x: 0.545,
        z: 0.47,
      },
      to: { x: 0.5, z: 0.5 },
    }]);
    return true;
  }

  function handleSnapshot(snapshot) {
    latestSnapshot = snapshot;
    orbitEpoch = snapshot.orbit.epoch;
    orbitPeriod = snapshot.orbit.periodMs;
    entities.applySnapshot(snapshot);
    entities.setOwnedEntity(client.ownedEntityId);
    ui.setSnapshot(snapshot);
    ui.setQueue(null);
    queued = false;
    ui.showBirthCue(!client.ownedEntityId);
    ui.setCameraAvailable(!!client.ownedEntityId && entities.tracked.has(client.ownedEntityId));
    if (returningEntityId && client.ownedEntityId === returningEntityId && !resumedReturningFish) {
      resumedReturningFish = true;
      stableCamera.enterRide();
    }
  }

  client.on('state', (state) => ui.setConnection(state));
  client.on('message', (message) => {
    if (message.type === 'welcome') {
      ui.setIdentity(message.identity);
      returningEntityId = message.ownedEntityId;
      entities.setOwnedEntity(message.ownedEntityId);
      if (message.recentLifeRecord) ui.showLifeEnded(message.recentLifeRecord.ageText, false);
    } else if (message.type === 'snapshot') {
      handleSnapshot(message.snapshot);
    } else if (message.type === 'delta') {
      entities.applyDelta(message);
      for (const ritual of message.rituals || []) applyRitual(ritual);
    } else if (message.type === 'presence') {
      ui.updatePresence(message.connectedSouls, message.capacity);
    } else if (message.type === 'queue') {
      queued = true;
      ui.setQueue(message);
    } else if (message.type === 'lifeEnded') {
      if (!client.ownedEntityId || message.entityId === entities.ownedEntityId) {
        entities.setOwnedEntity(null);
        ui.setCameraAvailable(false);
        stableCamera.beginDeath();
        ui.showLifeEnded(message.ageText);
      }
    } else if (message.type === 'ritualAck' && !message.accepted) {
      if (message.reason === 'cooldown' && message.nextOfferingAt) {
        const minutes = Math.max(1, Math.ceil((message.nextOfferingAt - client.serverNow()) / 60000));
        ui.showNotice(`the pond can receive another offering in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
      } else if (message.reason === 'spectator') {
        ui.showNotice('this view can witness the pond, but cannot enter it');
      }
    } else if (message.type === 'error') {
      ui.showNotice(message.message || 'the shared water shifted out of reach');
    }
  });

  ui.onSoundToggle = () => ui.setSoundEnabled(audio.toggle());
  ui.setSoundEnabled(audio.enabled);
  ui.onReducedMotion = (next) => {
    reducedMotion = next;
    controls.autoRotate = !next;
    try { localStorage.setItem(reducedMotionKey, String(next)); }
    catch (error) { /* Keep the visit-local setting. */ }
  };
  ui.onOffering = (offering, point) => {
    audio.awaken();
    client.offer(point, offering);
  };
  ui.onCameraToggle = () => {
    if (entities.ownedEntityId && entities.tracked.has(entities.ownedEntityId)) stableCamera.toggle();
  };

  function awakenExperience() {
    ui.awaken();
    audio.awaken();
  }

  const gesture = {
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    lastX: 0,
    moved: false,
    held: false,
    holdTimer: null,
  };

  function overlayTarget(target) {
    return target instanceof Element && !!target.closest('button, aside, input, .offering-menu');
  }

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    const fallbackUrl = new URL(location.href);
    fallbackUrl.searchParams.set('renderer', 'canvas');
    location.replace(fallbackUrl.href);
  }, { once: true });

  canvas.addEventListener('pointerdown', (event) => {
    if (overlayTarget(event.target)) return;
    canvas.focus({ preventScroll: true });
    awakenExperience();
    ui.hideOfferingMenu();
    gesture.active = true;
    gesture.pointerId = event.pointerId;
    gesture.startX = event.clientX;
    gesture.startY = event.clientY;
    gesture.lastX = event.clientX;
    gesture.moved = false;
    gesture.held = false;
    gesture.holdTimer = entities.ownedEntityId && entities.tracked.has(entities.ownedEntityId) ? setTimeout(() => {
      if (!gesture.active || gesture.moved) return;
      const point = waterPointAtScreen(gesture.startX, gesture.startY);
      if (!point) return;
      gesture.held = true;
      ui.showOfferingMenu(gesture.startX, gesture.startY, point.normalized);
    }, 560) : null;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!gesture.active || event.pointerId !== gesture.pointerId) return;
    const deltaX = event.clientX - gesture.lastX;
    gesture.lastX = event.clientX;
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 9) {
      gesture.moved = true;
      if (gesture.holdTimer !== null) clearTimeout(gesture.holdTimer);
      gesture.holdTimer = null;
    }
    stableCamera.adjustBearing(deltaX);
  });

  function finishGesture(event) {
    if (!gesture.active || event.pointerId !== gesture.pointerId) return;
    if (gesture.holdTimer !== null) clearTimeout(gesture.holdTimer);
    const moved = gesture.moved;
    const held = gesture.held;
    gesture.active = false;
    gesture.holdTimer = null;
    if (moved || held || overlayTarget(event.target)) return;
    if (entities.ownedEntityAtScreen(event.clientX, event.clientY)) {
      stableCamera.enterRide();
      return;
    }
    const point = waterPointAtScreen(event.clientX, event.clientY);
    if (!point) return;
    applyLocalRipple(point.normalized, client.ownedEntityId ? 0.52 : 0.72);
    if (!client.ownedEntityId) {
      if (!queued) {
        client.incarnate(point.normalized);
        ui.showBirthCue(false);
      }
    } else {
      client.ripple(point.normalized);
    }
  }

  canvas.addEventListener('pointerup', finishGesture);
  canvas.addEventListener('pointercancel', finishGesture);
  addEventListener('keydown', (event) => {
    if (event.repeat || event.key.toLowerCase() !== 'c' || event.target instanceof HTMLInputElement) return;
    awakenExperience();
    if (entities.ownedEntityId) stableCamera.toggle();
  });

  function updateCelestials(phase, t) {
    if (!window.__celestials) return;
    let earthPosition = null;
    let celestialSunPosition = null;
    for (const celestial of window.__celestials) {
      if (celestial.type === 'sun') {
        const angle = Math.PI + phase * TAU;
        const sx = Math.cos(angle) * celestial.orbitR;
        const sz = Math.sin(angle) * celestial.orbitR;
        const sy = celestial.baseY + Math.sin(angle) * celestial.orbitR * celestial.orbitTilt;
        celestial.obj.position.set(sx, sy, sz);
        celestial.obj.rotation.y = t * 0.02;
        celestialSunPosition = celestial.obj.position;
      } else if (celestial.type === 'earth') {
        const angle = phase * TAU;
        const ex = Math.cos(angle) * celestial.orbitR;
        const ez = Math.sin(angle) * celestial.orbitR;
        const ey = Math.sin(angle * 0.5) * celestial.orbitR * celestial.orbitTilt;
        celestial.obj.position.set(ex, ey + 200, ez);
        celestial.obj.rotation.y = t * 0.03;
        earthPosition = celestial.obj.position;
      } else if (celestial.type === 'moon') {
        const angle = phase * TAU * 12;
        const mx = Math.cos(angle) * celestial.orbitR;
        const mz = Math.sin(angle) * celestial.orbitR;
        const my = Math.sin(angle * 2) * celestial.orbitR * 0.3;
        if (earthPosition) celestial.obj.position.set(earthPosition.x + mx, earthPosition.y + my, earthPosition.z + mz);
        else celestial.obj.position.set(mx, my + 200, mz);
        celestial.obj.rotation.y = t * 0.05;
      }
    }
    if (celestialSunPosition) {
      const direction = celestialSunPosition.clone().normalize();
      direction.y = Math.max(0.16, Math.abs(direction.y));
      direction.normalize();
      sun.position.copy(direction).multiplyScalar(170);
      waterUniforms.uSunDir.value.copy(direction);
      sun.intensity = 0.62 + Math.max(0, celestialSunPosition.y / 900) * 0.42;
    }
  }

  function installLegendaryBenchmarkV2() {
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const countLights = () => {
      let count = 0;
      scene.traverse((node) => { if (node.isPointLight) count++; });
      return count;
    };
    window.__pondDebug = Object.assign(window.__pondDebug || {}, {
      async benchmarkLegendary(requestedCount) {
        const count = Math.max(1, Math.min(50, Math.round(Number(requestedCount) || 20)));
        const before = countLights();
        const fish = [];
        const spawnTimes = [];
        let maxFrameGapMs = 0;
        let previous = await nextFrame();
        for (let index = 0; index < count; index++) {
          const started = performance.now();
          const point = randomPondPoint(R_WATER * 0.62);
          const legendary = new Fish3D(point.x, point.y, 3, false);
          fish.push(legendary);
          spawnTimes.push(performance.now() - started);
          const frame = await nextFrame();
          maxFrameGapMs = Math.max(maxFrameGapMs, frame - previous);
          previous = frame;
        }
        for (const legendary of fish) legendary.destroy();
        const thresholdMs = IS_MOBILE ? 150 : 100;
        const result = {
          count,
          pointLightsAdded: countLights() - before,
          maxSpawnMs: Math.max.apply(Math, spawnTimes),
          maxFrameGapMs,
          thresholdMs,
          passed: countLights() === before && maxFrameGapMs <= thresholdMs,
        };
        console.table(result);
        return result;
      },
      snapshot: () => latestSnapshot,
      entityCount: () => entities.tracked.size,
      backgroundCount: () => entities.background.bodies.count,
      cameraMode: () => stableCamera.mode,
      triggerBirdStrike: () => spawnBirdStrikeEvent(Math.floor(client.serverNow() / 45000)),
    });
  }

  function animateV2() {
    requestAnimationFrame(animateV2);
    try {
      const now = performance.now();
      const deltaSeconds = Math.min(0.05, Math.max(0, (now - previousFrame) / 1000));
      const dt = deltaSeconds / 0.01667;
      previousFrame = now;
      elapsedV2 += deltaSeconds;
      frameCountV2++;
      const t = waterUniforms.uTime.value += deltaSeconds;
      const phase = serverOrbitPhase();

      if (window.__skyShader) window.__skyShader.uniforms.uTime.value = t;
      if (shoreUniforms) shoreUniforms.uTime.value = t;
      if (window.__dome) {
        window.__dome.mat.opacity = 0.1 + 0.04 * Math.sin(t * 0.8);
        window.__dome.shellMat.opacity = 0.03 + 0.02 * Math.sin(t * 0.6);
        window.__dome.ringMat.opacity = 0.25 + 0.08 * Math.sin(t * 1.2);
      }
      updateCelestials(phase, t);

      if (window.__grassBlades && frameCountV2 % 5 === 0) {
        const reedGust = [...entities.natureEvents.values()].some((event) => event.kind === 'reed_gust' && event.endsAt > client.serverNow());
        for (const blade of window.__grassBlades) {
          blade.rotation.y = Math.atan2(camera.position.x - blade.position.x, camera.position.z - blade.position.z);
          if (!blade.userData.isBush) blade.rotation.z = Math.sin(t * (reedGust ? 2.4 : 1.5) + blade.userData.phase) * blade.userData.swayAmt * (reedGust ? 2.2 : 1);
        }
      }

      if (frameCountV2 % 2 === 0) {
        lilies = lilies.filter((lily) => { const alive = lily.update(); if (alive) lily.sync3D(); else lily.destroy(); return alive; });
        ripples = ripples.filter((ripple) => { const alive = ripple.update(); if (alive) ripple.sync3D(); else ripple.destroy(); return alive; });
        updateFireflies(t);
        if (fireflyState) {
          const night = THREE.MathUtils.clamp((-Math.sin(phase * TAU) + 0.12) * 1.4, 0.04, 1);
          fireflyState.pts.material.opacity = night * (0.58 + Math.sin(t * 1.3) * 0.2);
        }
      }
      plankton = plankton.filter((item) => { const alive = item.update(dt); if (alive) item.sync3D(); else item.destroy(); return alive; });
      creatures = creatures.filter((creature) => { const alive = creature.update(dt); if (alive) creature.sync3D(dt); else creature.destroy(); return alive; });
      birds = birds.filter((bird) => { const alive = bird.update(dt); if (alive) bird.sync3D(); else bird.destroy(); return alive; });
      waves = waves.filter((wave) => { const alive = wave.update(dt); if (alive) wave.sync3D(); else wave.destroy(); return alive; });
      entities.update(deltaSeconds, elapsedV2);
      stableCamera.update(deltaSeconds, now);

      if (now - lastLabelUpdate > 90) {
        ui.updateLabels(entities.getLabelAnchors(innerWidth, innerHeight));
        lastLabelUpdate = now;
      }
      if (now - lastAudioUpdate > 800) {
        audio.update(client.serverNow(), phase);
        lastAudioUpdate = now;
      }
      renderer.render(scene, camera);
      loopErrors = 0;
    } catch (error) {
      loopErrors++;
      if (loopErrors === 120) {
        console.error('Eternal Pond render loop fault', error);
        ui.showNotice('the water has gone still; a refresh may wake it');
      }
    }
  }

  function startRuntime() {
    buildEnvironment();
    prewarmLegendaryFish();
    installLegendaryBenchmarkV2();
    controls.autoRotate = !reducedMotion;
    client.connect();
    animateV2();
    setInterval(() => ui.updateLedgerClock(client.serverNow()), 60000);
    setTimeout(hideLoadingScreen, 450);

    if (new URLSearchParams(location.search).get('benchmark') === 'legendary' && window.__pondDebug) {
      setTimeout(async () => {
        const result = await window.__pondDebug.benchmarkLegendary(20);
        document.documentElement.dataset.legendaryBenchmark = JSON.stringify(result);
      }, 900);
    }
    const debugEvent = new URLSearchParams(location.search).get('event');
    const localDebug = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (localDebug && debugEvent === 'birds') {
      setTimeout(() => spawnBirdStrikeEvent(Math.floor(client.serverNow() / 45000)), 1200);
    }
    if (localDebug && debugEvent === 'frogs') {
      setTimeout(() => spawnFrogFeedDebug(Math.floor(client.serverNow() / 45000)), 1200);
    }
  }

  addEventListener('beforeunload', () => client.dispose());
  const assetsReadyV2 = Promise.all(Object.entries(ASSETS).map(([key, url]) => loadAsset(key, url)));
  Promise.race([assetsReadyV2, new Promise((resolve) => setTimeout(resolve, 15000))]).then(startRuntime);
}());
