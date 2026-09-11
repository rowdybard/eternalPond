/* Small shared CC0 albedo maps; one GPU copy per surface family. */
(function () {
  'use strict';
  const loader = new THREE.TextureLoader();
  const textures = {};
  for (const name of ['bark', 'ground', 'rock', 'concrete']) {
    const texture = loader.load(`assets/natural-${name}-albedo.jpg`);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    textures[name] = texture;
  }
  window.PondSurfaceTextures = textures;

  // World mapping avoids UV stretch on large terrain rings and merged rocks.
  // The existing material colors remain the art direction; the photograph adds
  // natural grain, lichen, leaf litter and surface variation.
  window.applyPondWorldTexture = function (material, texture, scale, planar) {
    material.map = texture;
    const before = material.onBeforeCompile;
    const key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader) => {
      before.call(material, shader);
      shader.vertexShader = 'varying vec3 vSurfacePoint; varying vec3 vSurfaceNormal;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
        #include <project_vertex>
        vec4 surfacePoint = vec4(transformed, 1.0);
        vec3 surfaceNormal = objectNormal;
        #ifdef USE_INSTANCING
          surfacePoint = instanceMatrix * surfacePoint;
          surfaceNormal = mat3(instanceMatrix) * surfaceNormal;
        #endif
        vSurfacePoint = (modelMatrix * surfacePoint).xyz;
        vSurfaceNormal = normalize(mat3(modelMatrix) * surfaceNormal);
      `);
      shader.fragmentShader = 'varying vec3 vSurfacePoint; varying vec3 vSurfaceNormal;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        vec3 surfaceUV = vSurfacePoint * ${scale.toFixed(4)};
        ${planar ? `
          // Three rotated scales suppress recognisable repeated leaf-litter tiles.
          vec2 groundUV = surfaceUV.xz;
          groundUV += vec2(sin(vSurfacePoint.z * 0.021), cos(vSurfacePoint.x * 0.027)) * 0.38;
          vec3 surfaceSample = texture2D(map, groundUV).rgb * 0.40;
          surfaceSample += texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * groundUV * 0.73 + vec2(0.37, 0.61)).rgb * 0.35;
          surfaceSample += texture2D(map, mat2(0.36, 0.93, -0.93, 0.36) * groundUV * 1.37 + vec2(0.79, 0.13)).rgb * 0.25;
        ` : `
          vec3 surfaceBlend = pow(abs(vSurfaceNormal), vec3(4.0));
          surfaceBlend /= max(0.0001, dot(surfaceBlend, vec3(1.0)));
          vec3 surfaceSample = texture2D(map, surfaceUV.yz).rgb * surfaceBlend.x
                             + texture2D(map, surfaceUV.xz).rgb * surfaceBlend.y
                             + texture2D(map, surfaceUV.xy).rgb * surfaceBlend.z;
        `}
        diffuseColor.rgb *= ${planar ? 'mix(vec3(0.76), surfaceSample * 1.22, 0.28)' : 'mix(vec3(0.62), surfaceSample * 1.20, 0.64)'};
      `);
    };
    material.customProgramCacheKey = () => `${key}:world-surface:${scale}:${!!planar}`;
    material.needsUpdate = true;
    return material;
  };
}());
