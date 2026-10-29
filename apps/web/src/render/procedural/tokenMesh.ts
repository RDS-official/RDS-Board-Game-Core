import * as THREE from 'three';
import { GEM_COLORS, GemType } from '@rds/games/splendor/setup';
import { isMasterBall, pokeBallTexture, resolveBallColor } from './pokemonAssets';

/**
 * Ball colour that will actually be rendered for this token, or null when the
 * caller should fall back to the procedural gem chip.
 *
 * Accepts the six canonical colours, the master-ball spellings (`master`,
 * `masterBall`, …) and the deprecated Splendor gem aliases (`ruby`, `sapphire`,
 * `onyx`, …), so a caller that still speaks the old five-gem vocabulary still
 * lands on a ball. Falls back to `gem` when the explicit colour is unknown.
 */
export function resolveTokenBallColor(
  gem: GemType | 'gold',
  pkmnColor?: string
): string | null {
  return resolveBallColor(pkmnColor) ?? resolveBallColor(gem);
}

/** Base tint per ball, used while the artwork is still in flight. */
const BALL_TINTS: Record<string, number> = {
  red: 0xd32f2f,
  blue: 0x1e88e5,
  black: 0x212121,
  pink: 0xec407a,
  yellow: 0xfdd835,
  purple: 0x8e24aa
};

/** Gold used to set the purple master ball apart from the five regular balls. */
const MASTER_BALL_GOLD = 0xffc94d;

export class TokenMeshBuilder {
  /**
   * A single Poké Ball token: the ball artwork wrapped on a sphere, plus a gold
   * halo for the purple master ball.
   *
   * The bitmap is attached asynchronously: until it decodes the sphere wears a
   * solid tint of the same colour, so a token is never a black blob and a broken
   * asset simply leaves the tint in place rather than aborting the render.
   */
  private static createPokeBallMesh(
    radius: number,
    ballColor: string,
    texture: THREE.Texture
  ): THREE.Group {
    const group = new THREE.Group();
    const master = isMasterBall(ballColor);
    const tint = BALL_TINTS[ballColor] ?? 0xd32f2f;

    const ballMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(tint),
      roughness: master ? 0.18 : 0.25,
      metalness: master ? 0.38 : 0.15
    });
    const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), ballMat);
    ballMesh.castShadow = true;
    // Sphere UVs put the image centre (the ball button) on +X; turn it towards
    // the camera side (+Z) while leaving the equator band horizontal.
    ballMesh.rotation.y = -Math.PI / 2;
    ballMesh.position.y = radius * 0.75;
    group.add(ballMesh);

    // Attach the bitmap only once it has decoded: a `map` with a null image
    // makes three warn on every frame. `pokeBallTexture` invokes the hook
    // synchronously when the texture is already cached, so warm tokens get the
    // artwork on their very first frame.
    const applyArtwork = (loaded: THREE.Texture): void => {
      ballMat.map = loaded;
      ballMat.color.set(0xffffff);
      ballMat.needsUpdate = true;
    };
    if (texture.image) applyArtwork(texture);
    else pokeBallTexture(ballColor, applyArtwork);

    if (master) {
      // Golden ring around the ball's waist.
      const haloGeom = new THREE.TorusGeometry(radius * 1.06, radius * 0.055, 8, 40);
      const haloMat = new THREE.MeshStandardMaterial({
        color: MASTER_BALL_GOLD,
        emissive: MASTER_BALL_GOLD,
        emissiveIntensity: 0.85,
        roughness: 0.25,
        metalness: 0.9
      });
      const halo = new THREE.Mesh(haloGeom, haloMat);
      halo.rotation.x = Math.PI / 2;
      halo.position.y = radius * 0.75;
      group.add(halo);

      // Soft additive aura so the master ball still reads at board zoom.
      const auraMat = new THREE.MeshBasicMaterial({
        color: MASTER_BALL_GOLD,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide
      });
      const aura = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.18, 16, 12), auraMat);
      aura.position.y = radius * 0.75;
      group.add(aura);
    }

    return group;
  }

  /**
   * Create a Splendor Gem Token (Poker chip style with faceted gem emblem).
   * When `usePokeBall` is set the token is rendered as an imported Poké Ball
   * (Ethan9123/pokemon-splendor assets): a sphere wrapped in the ball artwork.
   *
   * All six ball colours resolve, plus master-ball spellings and the deprecated
   * gem aliases. While the artwork is still in flight the sphere wears a tinted
   * placeholder and switches to the bitmap as soon as it decodes, so a slow or
   * broken asset never paints a black or invisible token. The purple master
   * ball additionally gets a gold halo so it reads as the wild token.
   */
  public static createGemTokenMesh(
    gem: GemType | 'gold',
    radius: number = 0.4,
    usePokeBall = false,
    pkmnColor?: string
  ): THREE.Group {
    const group = new THREE.Group();
    const hexColor = GEM_COLORS[gem] || '#ffb300';

    if (usePokeBall) {
      const ballColor = resolveTokenBallColor(gem, pkmnColor);
      const texture = ballColor ? pokeBallTexture(ballColor) : null;
      // `null` means every URL for this token is known to be broken: keep the
      // procedural chip rather than wrapping a sphere in a missing bitmap.
      if (ballColor && texture) {
        group.add(this.createPokeBallMesh(radius, ballColor, texture));
        return group;
      }
    }

    // Base chip cylinder
    const chipGeom = new THREE.CylinderGeometry(radius, radius, 0.08, 32);
    const chipMat = new THREE.MeshStandardMaterial({
      color: 0x263238,
      roughness: 0.3,
      metalness: 0.2
    });
    const chipMesh = new THREE.Mesh(chipGeom, chipMat);
    chipMesh.castShadow = true;
    group.add(chipMesh);

    // Inner gem colored ring
    const ringGeom = new THREE.CylinderGeometry(radius * 0.82, radius * 0.82, 0.085, 24);
    const ringMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hexColor),
      roughness: 0.2,
      metalness: 0.5
    });
    const ringMesh = new THREE.Mesh(ringGeom, ringMat);
    group.add(ringMesh);

    // Center faceted gem shape (octahedron)
    const gemGeom = new THREE.OctahedronGeometry(radius * 0.38);
    const gemMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hexColor),
      roughness: 0.1,
      metalness: 0.8
    });
    const gemMesh = new THREE.Mesh(gemGeom, gemMat);
    gemMesh.position.y = 0.06;
    gemMesh.rotation.y = Math.PI / 4;
    group.add(gemMesh);

    return group;
  }

  /**
   * Create Catan Settlement House
   */
  public static createSettlementMesh(color: string = '#e53935'): THREE.Group {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.4,
      metalness: 0.1
    });

    // Base cube
    const baseGeom = new THREE.BoxGeometry(0.52, 0.36, 0.52);
    const baseMesh = new THREE.Mesh(baseGeom, mat);
    baseMesh.position.y = 0.18;
    baseMesh.castShadow = true;
    group.add(baseMesh);

    // Peaked roof (triangular prism via 3-sided cylinder)
    const roofGeom = new THREE.CylinderGeometry(0.38, 0.38, 0.56, 3);
    const roofMesh = new THREE.Mesh(roofGeom, mat);
    roofMesh.rotation.z = Math.PI / 2;
    roofMesh.rotation.x = Math.PI / 6;
    roofMesh.position.y = 0.48;
    roofMesh.castShadow = true;
    group.add(roofMesh);

    return group;
  }

  /**
   * Create Catan City Castle
   */
  public static createCityMesh(color: string = '#e53935'): THREE.Group {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.4,
      metalness: 0.1
    });

    // Main hall base
    const hallGeom = new THREE.BoxGeometry(0.88, 0.46, 0.58);
    const hallMesh = new THREE.Mesh(hallGeom, mat);
    hallMesh.position.set(0, 0.23, 0);
    hallMesh.castShadow = true;
    group.add(hallMesh);

    // Tall Tower
    const towerGeom = new THREE.BoxGeometry(0.48, 0.86, 0.58);
    const towerMesh = new THREE.Mesh(towerGeom, mat);
    towerMesh.position.set(-0.22, 0.43, 0);
    towerMesh.castShadow = true;
    group.add(towerMesh);

    // Tower peak
    const peakGeom = new THREE.ConeGeometry(0.36, 0.4, 4);
    const peakMesh = new THREE.Mesh(peakGeom, mat);
    peakMesh.position.set(-0.22, 1.06, 0);
    peakMesh.rotation.y = Math.PI / 4;
    peakMesh.castShadow = true;
    group.add(peakMesh);

    return group;
  }

  /**
   * Create Catan Road Bar
   */
  public static createRoadMesh(color: string = '#e53935', length: number = 2.0): THREE.Mesh {
    const geom = new THREE.BoxGeometry(0.26, 0.14, length);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.5,
      metalness: 0.1
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    return mesh;
  }

  /**
   * Create Classic Board Game Meeple Pawn
   */
  public static createMeepleMesh(color: string = '#ffffff'): THREE.Group {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.4,
      metalness: 0.1
    });

    // Head
    const headGeom = new THREE.SphereGeometry(0.18, 16, 16);
    const head = new THREE.Mesh(headGeom, mat);
    head.position.y = 0.72;
    head.castShadow = true;
    group.add(head);

    // Torso / body cone
    const bodyGeom = new THREE.CylinderGeometry(0.16, 0.32, 0.55, 16);
    const body = new THREE.Mesh(bodyGeom, mat);
    body.position.y = 0.35;
    body.castShadow = true;
    group.add(body);

    return group;
  }

  /**
   * Painted tabletop miniature for the Betrayal diorama.
   *
   * The room tiles are 2.84 units across and their walls are 0.42 high, so a
   * character must read at roughly 0.3 units — about person height for a 4.5 m
   * room. Anything larger swallows the furniture.
   */
  public static createCharacterMiniature(
    color: string,
    options: { variant?: 'EXPLORER' | 'TRAITOR' | 'MONSTER'; scale?: number } = {}
  ): THREE.Group {
    const variant = options.variant ?? 'EXPLORER';
    const group = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.62,
      metalness: 0.08
    });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd8b08a, roughness: 0.85, metalness: 0 });
    const base = new THREE.MeshStandardMaterial({ color: 0x14100e, roughness: 0.85, metalness: 0.15 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xc59a44, roughness: 0.35, metalness: 0.8 });

    // Round display base with a brass rim
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.078, 0.014, 16), base);
    disc.position.y = 0.007;
    disc.castShadow = true;
    disc.receiveShadow = true;
    group.add(disc);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.071, 0.006, 6, 20), accent);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.015;
    group.add(rim);

    // Cloak / torso: a tapered body reads as a robed figure from above
    const bodyH = variant === 'MONSTER' ? 0.17 : 0.155;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.062, bodyH, 12), cloth);
    body.position.y = 0.016 + bodyH / 2;
    body.castShadow = true;
    group.add(body);

    // Shoulder cape
    const cape = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.07, 10, 1, true), cloth);
    cape.position.y = 0.016 + bodyH - 0.028;
    cape.castShadow = true;
    group.add(cape);

    // Head
    const headY = 0.016 + bodyH + 0.026;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 10), skin);
    head.position.y = headY;
    head.castShadow = true;
    group.add(head);

    if (variant === 'EXPLORER') {
      // Hat brim
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.006, 12), base);
      brim.position.y = headY + 0.014;
      group.add(brim);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.024, 12), base);
      crown.position.y = headY + 0.028;
      group.add(crown);
    } else if (variant === 'TRAITOR') {
      // Hood
      const hood = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.07, 10), cloth);
      hood.position.y = headY + 0.02;
      group.add(hood);
      // Ember eyes
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff6a2a });
      for (const dx of [-0.011, 0.011]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 6), eyeMat);
        eye.position.set(dx, headY + 0.002, 0.026);
        group.add(eye);
      }
    } else {
      // Monster: hunched mass with a glowing gaze
      const hump = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), cloth);
      hump.position.set(0, 0.016 + bodyH * 0.8, -0.018);
      hump.castShadow = true;
      group.add(hump);
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3b2a });
      for (const dx of [-0.014, 0.014]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.007, 6, 6), eyeMat);
        eye.position.set(dx, headY + 0.004, 0.026);
        group.add(eye);
      }
    }

    const s = options.scale ?? 1;
    group.scale.setScalar(s);
    return group;
  }
}
