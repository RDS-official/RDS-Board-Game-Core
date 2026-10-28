import * as THREE from 'three';

/**
 * Shared PBR material palette for the mansion diorama.
 *
 * Materials are singletons and marked `userData.shared` so the renderer never
 * disposes them between board rebuilds (pooled GPU programs / textures).
 */

function std(
  color: number,
  roughness: number,
  metalness: number,
  extra: Partial<THREE.MeshStandardMaterialParameters> = {}
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  material.userData.shared = true;
  return material;
}

function basic(color: number, extra: Partial<THREE.MeshBasicMaterialParameters> = {}): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color, ...extra });
  material.userData.shared = true;
  return material;
}

export const MAT = {
  /* ------------------------------- timber -------------------------------- */
  walnut: std(0x35201a, 0.72, 0.06),
  mahogany: std(0x4a211a, 0.62, 0.08),
  oak: std(0x54381f, 0.78, 0.04),
  paleOak: std(0x7a5533, 0.8, 0.03),
  ebony: std(0x1b1412, 0.7, 0.08),
  plywood: std(0x6b4a2b, 0.9, 0.02),

  /* -------------------------------- metal -------------------------------- */
  brass: std(0xc59a44, 0.32, 0.85),
  agedBrass: std(0x8d6c2c, 0.45, 0.7),
  copper: std(0xa4562e, 0.42, 0.75),
  iron: std(0x33373d, 0.58, 0.72),
  darkIron: std(0x1f2226, 0.62, 0.65),
  steel: std(0x9aa4ad, 0.3, 0.9),
  rust: std(0x6b3a22, 0.9, 0.25),
  gold: std(0xd8b25c, 0.24, 0.92),

  /* ------------------------------- masonry ------------------------------- */
  stone: std(0x4a4e52, 0.92, 0.04),
  paleStone: std(0x6d7076, 0.9, 0.03),
  slate: std(0x2d3339, 0.88, 0.06),
  marble: std(0xa9a49a, 0.34, 0.05),
  granite: std(0x3b3a38, 0.95, 0.02),
  plaster: std(0x8d8275, 0.95, 0.0),
  /** Red brick for the mansion's outer front door surround. */
  brick: std(0x8c3a28, 0.94, 0.02),

  /* ------------------------------- textiles ------------------------------ */
  crimsonVelvet: std(0x6d1519, 0.94, 0.02),
  emeraldVelvet: std(0x173f2c, 0.94, 0.02),
  plumVelvet: std(0x3a1b3d, 0.94, 0.02),
  wineVelvet: std(0x4c1220, 0.95, 0.02),
  linen: std(0xd8cdba, 0.95, 0.0),
  agedLinen: std(0xa89a83, 0.95, 0.0),
  leather: std(0x4a3122, 0.78, 0.1),
  darkLeather: std(0x2a1d15, 0.8, 0.08),

  /* -------------------------------- misc --------------------------------- */
  bone: std(0xcfc4a8, 0.85, 0.02),
  paper: std(0xd6c9a9, 0.92, 0.0),
  wax: std(0xd9d2bd, 0.75, 0.02),
  glass: std(0x8fb6c4, 0.1, 0.15, { transparent: true, opacity: 0.34 }),
  glassDark: std(0x2b3f4a, 0.12, 0.2, { transparent: true, opacity: 0.45 }),
  water: std(0x1c3a44, 0.08, 0.2, { transparent: true, opacity: 0.66 }),
  porcelain: std(0xe4e1d6, 0.24, 0.04),
  earth: std(0x3a2c1e, 0.98, 0.0),
  waxBlack: std(0x171317, 0.6, 0.05),

  /* ------------------------------ emissives ------------------------------ */
  flame: basic(0xffb347),
  flameCore: basic(0xfff0b8),
  ember: basic(0xff5a1f),
  sicklyGlow: basic(0x9be08a),
  arcaneGlow: basic(0x8f6bff),
  spectralGlow: basic(0xa8e4ff),
  lampGlow: basic(0xffd98a),

  /* -------------------------------- glass -------------------------------- */
  // Window panes must not write depth: they sit inside wall openings and would
  // otherwise sort against the wall bands and shimmer while the camera moves.
  windowPane: std(0x243444, 0.08, 0.2, { transparent: true, opacity: 0.55, depthWrite: false })
} as const;

/** Materials that read as light sources and should also emit light. */
export const EMISSIVE_GLOW = [
  MAT.flame,
  MAT.flameCore,
  MAT.ember,
  MAT.sicklyGlow,
  MAT.arcaneGlow,
  MAT.spectralGlow,
  MAT.lampGlow
] as const;
