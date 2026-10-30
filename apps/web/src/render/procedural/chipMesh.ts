import * as THREE from 'three';

/**
 * Casino chip geometry.
 *
 * One chip is a single cylinder mesh with a painted top face (edge spots plus
 * the denomination) and a plain coloured rim, so a 10-seat table still renders
 * in a few hundred draw calls. Stacks are capped: past ten chips the pile stops
 * growing and the exact number lives in the seat label, which keeps a 1000-chip
 * stack from becoming a tower that hides the cards.
 */

/** Classic denomination colours. Anything else falls back to slate. */
export const CHIP_COLORS: Record<number, number> = {
  5: 0xc8102e, // red
  25: 0x1f7a4d, // green
  100: 0x1c1c22, // black
  500: 0x6b3fa0, // purple
  1000: 0xc9a24a // brass
};

const CHIP_HEIGHT = 0.05;
const CHIP_RADIUS = 0.3;
const MAX_STACK_CHIPS = 10;

export class ChipMeshBuilder {
  private static faceCache = new Map<number, THREE.CanvasTexture>();

  /** Top face: coloured disc, white edge spots, denomination in the middle. */
  private static faceTexture(value: number): THREE.CanvasTexture {
    const cached = this.faceCache.get(value);
    if (cached) return cached;

    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the chip face');

    const color = CHIP_COLORS[value] ?? 0x8b93a1;
    const css = `#${color.toString(16).padStart(6, '0')}`;
    const centre = size / 2;

    ctx.fillStyle = css;
    ctx.beginPath();
    ctx.arc(centre, centre, centre - 1, 0, Math.PI * 2);
    ctx.fill();

    // Edge spots: eight white dashes around the rim, the classic casino look.
    ctx.strokeStyle = 'rgba(250,247,239,0.92)';
    ctx.lineWidth = 9;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(centre, centre, centre - 12, angle - 0.16, angle + 0.16);
      ctx.stroke();
    }

    // Inner ring + denomination.
    ctx.strokeStyle = 'rgba(250,247,239,0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(centre, centre, centre - 34, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#faf7ef';
    ctx.font = 'bold 40px "Georgia", "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value), centre, centre + 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.faceCache.set(value, texture);
    return texture;
  }

  /** One chip. Cylinder materials are ordered side, top, bottom. */
  public static createChip(value: number, radius = CHIP_RADIUS): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(radius, radius, CHIP_HEIGHT, 40);
    const side = new THREE.MeshStandardMaterial({
      color: CHIP_COLORS[value] ?? 0x8b93a1,
      roughness: 0.62,
      metalness: 0.04
    });
    const face = new THREE.MeshStandardMaterial({
      map: this.faceTexture(value),
      roughness: 0.55,
      metalness: 0.04
    });
    const mesh = new THREE.Mesh(geometry, [side, face, face]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Split an amount into chip denominations, largest first.
   *
   * The 1000 chip is deliberately left out: a deep stack would collapse into a
   * single gold token, which reads as "no chips on the table". 500/100/25/5
   * capped at ten chips keeps every pile looking like a pile.
   */
  public static decompose(amount: number, maxChips = MAX_STACK_CHIPS): number[] {
    const denominations = [500, 100, 25, 5];
    const chips: number[] = [];
    let rest = Math.max(0, Math.round(amount));
    for (const value of denominations) {
      while (rest >= value && chips.length < maxChips) {
        chips.push(value);
        rest -= value;
      }
    }
    return chips;
  }

  /** A stack worth `amount`, capped at ten chips. */
  public static createStack(amount: number, radius = CHIP_RADIUS): THREE.Group {
    const group = new THREE.Group();
    const chips = this.decompose(amount);
    chips.forEach((value, index) => {
      const chip = this.createChip(value, radius);
      chip.position.set(0, CHIP_HEIGHT / 2 + index * (CHIP_HEIGHT + 0.004), 0);
      // A small deterministic yaw per chip keeps the pile from looking extruded.
      chip.rotation.y = (index * 0.9) % (Math.PI * 2);
      group.add(chip);
    });
    return group;
  }

  /** Height of a stack of `count` chips, for stacking FX on top. */
  public static stackHeight(count: number): number {
    return count * (CHIP_HEIGHT + 0.004);
  }
}
