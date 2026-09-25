import * as THREE from 'three';

export const MAX_NODES = 32;

/**
 * Patch a MeshStandardMaterial so it chars, glows and (optionally) burns
 * away along fronts spreading from ignition points.
 *
 * Each node is a vec4: xyz in the mesh's local space, w = how far its burn
 * front has spread (cm), or <= 0 if it has not caught. A fragment is burnt
 * by `b = max(w - distance)`; b > 0 is charred, b > uAshW is gone (if
 * dissolving), and a thin band around the front glows like embers.
 */
export function patchBurnMaterial(material, { dissolve = false, charColor = [0.03, 0.025, 0.022], ashW = 0.5, noise = 0.6, emberColor = [1.0, 0.32, 0.05], meltHeight = 0 } = {}) {
  const nodes = [];
  for (let i = 0; i < MAX_NODES; i++) nodes.push(new THREE.Vector4(0, 0, 0, -1));
  const u = {
    uNodes: { value: nodes },
    uCount: { value: 0 },
    uAshW: { value: ashW },
    uEmber: { value: 0 },
    uHeat: { value: 0 },
    uTime: { value: 0 },
    uMelt: { value: 0 },
    uMeltH: { value: meltHeight },
    uWet: { value: 0 },
  };
  material.userData.burn = u;
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uMelt; uniform float uMeltH;
        varying vec3 vLocal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = transformed;
        if (uMelt > 0.0 && uMeltH > 0.0) {
          float hy = clamp(transformed.y / uMeltH, 0.0, 1.0);
          float slump = uMelt * (0.35 + 0.65 * hy);
          transformed.y *= 1.0 - 0.72 * slump;
          float bulge = uMelt * (1.0 - hy) * 0.45 - uMelt * hy * 0.25;
          transformed.xz *= 1.0 + bulge + 0.08 * uMelt * sin(transformed.y * 3.1 + transformed.x * 2.3);
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec4 uNodes[${MAX_NODES}];
        uniform int uCount;
        uniform float uAshW, uEmber, uHeat, uTime, uWet;
        varying vec3 vLocal;
        float bh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float bnoise(vec3 p){
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(bh(i), bh(i + vec3(1,0,0)), f.x), mix(bh(i + vec3(0,1,0)), bh(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(bh(i + vec3(0,0,1)), bh(i + vec3(1,0,1)), f.x), mix(bh(i + vec3(0,1,1)), bh(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float burnB(){
          float b = -100.0;
          for (int i = 0; i < ${MAX_NODES}; i++) {
            if (i >= uCount) break;
            vec4 n = uNodes[i];
            if (n.w <= 0.0) continue;
            b = max(b, n.w - distance(vLocal, n.xyz));
          }
          float nz = bnoise(vLocal * 1.3) * 0.65 + bnoise(vLocal * 4.1) * 0.35;
          return b + (nz - 0.5) * ${noise.toFixed(3)} * 2.0;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float bB = burnB();
        ${dissolve ? 'if (bB > uAshW) discard;' : ''}
        float charT = smoothstep(-0.2, 0.2, bB);
        float scorch = smoothstep(-1.2, -0.1, bB) * (1.0 - charT);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.45, 0.3, 0.18), scorch * 0.85);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${charColor.map((c) => c.toFixed(3)).join(',')}), charT);
        diffuseColor.rgb *= 1.0 - uWet * 0.35;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 1.0, charT);
        roughnessFactor = mix(roughnessFactor, 0.25, uWet);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float edgeAt = ${dissolve ? 'uAshW - 0.08' : '0.05'};
        float band = exp(-pow((bB - edgeAt) / 0.14, 2.0));
        float flick = 0.65 + 0.35 * sin(uTime * 19.0 + vLocal.x * 7.0 + vLocal.z * 5.0) * sin(uTime * 5.3 + vLocal.y * 9.0);
        float spots = step(0.78, bnoise(vLocal * 6.0 + uTime * 0.2)) * charT;
        vec3 ember = vec3(${emberColor.map((c) => c.toFixed(3)).join(',')});
        totalEmissiveRadiance += ember * (band * 4.0 + spots * 1.6 + charT * 0.25) * uEmber * flick;
        totalEmissiveRadiance += ember * uHeat;`);
  };
  material.customProgramCacheKey = () => `burn-${dissolve}-${ashW}-${noise}-${charColor}-${emberColor}`;
  return u;
}
