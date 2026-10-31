import * as THREE from 'three';
import { CANVAS_FONT_STACK } from '../fonts';

/**
 * Seat standees.
 *
 * A plaque that floats and follows the camera reads as a HUD element, not as a
 * thing on the table. Each seat now gets a physical standee: a matte black metal
 * disc turned from solid stock, with a dark-walnut board leaning back on it. The
 * board is cut to playing-card size, so it belongs to the same family as the
 * cards it stands next to.
 *
 * Board face (portrait, like a card):
 *   ┌────────────┐
 *   │   ◉ avatar │   avatar coin in the player's colour
 *   │    昵称     │   nickname
 *   │  筹码 990   │   the numbers that matter for this game
 *   │    ♠ 2     │   suit / seat marker
 *   └────────────┘
 */

export interface SeatPlateInfo {
  name: string;
  avatar: string;
  /** Player accent colour (hex). */
  color: string;
  /** Second line: role, stack, status… */
  detail?: string;
  /** Whose turn it is: brass rim + a chevron. */
  active?: boolean;
  /** Dimmed when the seat is out of the hand (folded / busted / dead). */
  muted?: boolean;
  /** Small marker under the text (suit symbol or seat number). */
  marker?: string;
  /**
   * What this seat did on the current street (过牌 / 跟注 20 / 加注到 40 / 弃牌 /
   * 全押 200). Painted as a badge on the board; replaces the marker while set.
   */
  action?: string;
  /**
   * Wood species of the board. Blinds get their own timber so the table reads
   * at a glance: pine for the big blind, red pine for the small blind, walnut
   * for everyone else.
   */
  wood?: WoodKind;
}

export type WoodKind = 'walnut' | 'pine' | 'redPine';

interface WoodPalette {
  light: string;
  mid: string;
  dark: string;
  /** Lettering colour: dark ink on pale pine, ivory on the dark species. */
  ink: string;
  /** Secondary line colour. */
  inkSoft: string;
  /** Grain stroke colour. */
  grain: string;
}

const WOODS: Record<WoodKind, WoodPalette> = {
  walnut: {
    light: '#5c4128',
    mid: '#4a3320',
    dark: '#2a1b0e',
    ink: '#f2e8d2',
    inkSoft: 'rgba(242, 232, 210, 0.74)',
    grain: 'rgba(0, 0, 0, 0.3)'
  },
  // Pine: pale, warm, clearly lighter than the felt.
  pine: {
    light: '#e8cd97',
    mid: '#d8b878',
    dark: '#b8934f',
    ink: '#3a2412',
    inkSoft: 'rgba(58, 36, 18, 0.72)',
    grain: 'rgba(120, 82, 40, 0.34)'
  },
  // Red pine (红松): warm reddish brown, darker than pine, warmer than walnut.
  redPine: {
    light: '#b8734b',
    mid: '#9c5636',
    dark: '#6f3520',
    ink: '#fbeee0',
    inkSoft: 'rgba(251, 238, 224, 0.78)',
    grain: 'rgba(58, 20, 8, 0.34)'
  }
};

/** Card-sized board: matches the community/hole cards on the felt. */
export const SEAT_BOARD = { width: 0.86, height: 1.24, thickness: 0.045 } as const;
/** Metal disc under the board. */
export const SEAT_BASE = { radius: 0.5, height: 0.055 } as const;
/** Lean of the board away from the table centre (radians). */
const BOARD_TILT = 1.02;

const BRASS = '#c9a24a';

export class SeatPlateBuilder {
  private static faceCache = new Map<string, THREE.CanvasTexture>();
  private static metalTexture: THREE.CanvasTexture | null = null;

  /** One board face: timber grain, brass frame, avatar coin and lettering. */
  private static faceTexture(info: SeatPlateInfo): THREE.CanvasTexture {
    const key = [
      info.name,
      info.avatar,
      info.color,
      info.detail ?? '',
      info.marker ?? '',
      info.action ?? '',
      info.active ? 'a' : '',
      info.muted ? 'm' : '',
      info.wood ?? 'walnut'
    ].join('|');
    const cached = this.faceCache.get(key);
    if (cached) return cached;

    const wood = WOODS[info.wood ?? 'walnut'];

    const width = 384;
    const height = 554; // card aspect (0.86 : 1.24)
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the seat board');

    // Timber: the species is chosen by the caller (blinds get their own board).
    const board = ctx.createLinearGradient(0, 0, width * 0.35, height);
    board.addColorStop(0, wood.light);
    board.addColorStop(0.5, wood.mid);
    board.addColorStop(1, wood.dark);
    ctx.fillStyle = board;
    ctx.fillRect(0, 0, width, height);

    // Fine grain: long, slightly wavy lines plus a few darker seams.
    let seed = 0x2c1b3f;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 120; i++) {
      const x = rnd() * width;
      const wobble = 2 + rnd() * 7;
      ctx.strokeStyle = wood.grain;
      ctx.lineWidth = 0.5 + rnd() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, -10);
      for (let y = 0; y <= height + 10; y += 36) {
        ctx.lineTo(x + Math.sin((y + i * 29) / 70) * wobble, y);
      }
      ctx.stroke();
    }
    // A knot or two.
    for (let i = 0; i < 2; i++) {
      const cx = 40 + rnd() * (width - 80);
      const cy = 60 + rnd() * (height - 120);
      const radius = 10 + rnd() * 16;
      const knot = ctx.createRadialGradient(cx, cy, 1, cx, cy, radius);
      knot.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
      knot.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = knot;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Brass frame (thicker when it is this seat's turn).
    ctx.strokeStyle = info.active ? BRASS : 'rgba(201, 162, 74, 0.5)';
    ctx.lineWidth = info.active ? 7 : 3;
    ctx.strokeRect(14, 14, width - 28, height - 28);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(24, 24, width - 48, height - 48);

    // Avatar coin.
    const coinX = width / 2;
    const coinY = 148;
    const coinR = 66;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.arc(coinX, coinY + 3, coinR + 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = info.muted ? 'rgba(110, 110, 110, 0.55)' : info.color;
    ctx.beginPath();
    ctx.arc(coinX, coinY, coinR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = info.active ? BRASS : wood.inkSoft;
    ctx.lineWidth = info.active ? 6 : 3;
    ctx.beginPath();
    ctx.arc(coinX, coinY, coinR, 0, Math.PI * 2);
    ctx.stroke();

    const glyph = String(info.avatar || info.name.slice(0, 1) || '?');
    ctx.fillStyle = wood.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${glyph.length > 1 ? 70 : 78}px ${CANVAS_FONT_STACK}`;
    ctx.fillText(glyph, coinX, coinY + 4);

    // Nickname.
    ctx.textAlign = 'center';
    ctx.fillStyle = info.muted ? 'rgba(120, 110, 96, 0.75)' : wood.ink;
    let nameSize = 58;
    ctx.font = `700 ${nameSize}px ${CANVAS_FONT_STACK}`;
    while (ctx.measureText(info.name).width > width - 56 && nameSize > 22) {
      nameSize -= 2;
      ctx.font = `700 ${nameSize}px ${CANVAS_FONT_STACK}`;
    }
    ctx.fillText(info.name, coinX, 276);

    // Detail lines (at most two).
    if (info.detail) {
      ctx.fillStyle = wood.inkSoft;
      ctx.font = `600 31px ${CANVAS_FONT_STACK}`;
      info.detail
        .split(' · ')
        .slice(0, 2)
        .forEach((part, index) => {
          let text = part;
          while (ctx.measureText(text).width > width - 60 && text.length > 2) text = text.slice(0, -2);
          ctx.fillText(text, coinX, 330 + index * 38);
        });
    }

    // Suit / seat marker in the lower third.
    // Action badge: what this seat did on the current street. It takes the
    // marker's place while set, because the action is the more urgent fact.
    if (info.action) {
      const aggressive = /加注|全押|下注/.test(info.action);
      const folded = /弃牌/.test(info.action);
      const badgeW = 268;
      const badgeH = 62;
      const badgeY = height - 128;
      ctx.fillStyle = folded ? '#8c1c28' : aggressive ? BRASS : 'rgba(10, 7, 4, 0.66)';
      ctx.beginPath();
      ctx.roundRect(coinX - badgeW / 2, badgeY - badgeH / 2, badgeW, badgeH, 18);
      ctx.fill();
      ctx.strokeStyle = aggressive || folded ? 'rgba(0, 0, 0, 0.45)' : 'rgba(201, 162, 74, 0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(coinX - badgeW / 2, badgeY - badgeH / 2, badgeW, badgeH, 18);
      ctx.stroke();

      ctx.fillStyle = aggressive ? '#241708' : '#f6ecd2';
      ctx.font = `700 34px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let text = info.action;
      while (ctx.measureText(text).width > badgeW - 26 && text.length > 2) text = text.slice(0, -2);
      ctx.fillText(text, coinX, badgeY + 1);
    } else if (info.marker) {
      ctx.fillStyle = info.active ? BRASS : wood.inkSoft;
      ctx.font = `600 64px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.marker, coinX, height - 96);
    }

    // Turn chevron at the top edge.
    if (info.active) {
      ctx.fillStyle = BRASS;
      ctx.beginPath();
      ctx.moveTo(coinX - 18, 34);
      ctx.lineTo(coinX, 54);
      ctx.lineTo(coinX + 18, 34);
      ctx.closePath();
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.faceCache.set(key, texture);
    return texture;
  }

  /** Brushed black metal for the disc (concentric machining marks). */
  private static baseTexture(): THREE.CanvasTexture {
    if (this.metalTexture) return this.metalTexture;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the seat base');

    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    let seed = 0x51f3a7;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let radius = 6; radius < size / 2; radius += 1.6) {
      ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.22)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(201, 162, 74, 0.28)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2 - 14, 0, Math.PI * 2);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.metalTexture = texture;
    return texture;
  }

  /**
   * A standee: black metal disc plus a walnut board leaning away from the table
   * centre, so its face tilts toward a camera above the table.
   *
   * `outward` is the unit vector from the table centre to the seat; the group is
   * yawed to match, which keeps the board's top edge pointing away from the pot.
   */
  public static createStandee(
    info: SeatPlateInfo,
    outward: THREE.Vector2
  ): { group: THREE.Group; plate: THREE.Mesh; lamp?: THREE.Mesh } {
    const group = new THREE.Group();
    group.rotation.y = Math.atan2(outward.x, outward.y);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(SEAT_BASE.radius, SEAT_BASE.radius * 0.94, SEAT_BASE.height, 48),
      new THREE.MeshStandardMaterial({
        map: this.baseTexture(),
        color: 0xffffff,
        roughness: 0.58,
        metalness: 0.82
      })
    );
    base.position.y = SEAT_BASE.height / 2;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    // 行动指示灯：嵌在底座正面边缘正中，端面与底座侧面齐平。谁在操作，一眼
    // 就能看出来；立在牌桌对面时也读得到，且不会像贴片一样浮在木头表面。
    let lamp: THREE.Mesh | undefined;
    if (info.active) {
      lamp = new THREE.Mesh(
        new THREE.CylinderGeometry(0.042, 0.042, 0.016, 20),
        new THREE.MeshBasicMaterial({ color: 0xff3b2a })
      );
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(0, SEAT_BASE.height * 0.5, SEAT_BASE.radius - 0.006);
      group.add(lamp);

      // 一层极淡的光晕，让这颗灯在俯视角也能被注意到（不参与拾取）。
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(0.07, 20),
        new THREE.MeshBasicMaterial({ color: 0xff6a4a, transparent: true, opacity: 0.2 })
      );
      halo.position.set(0, SEAT_BASE.height * 0.5, SEAT_BASE.radius + 0.001);
      group.add(halo);
    }

    const face = this.faceTexture(info);
    const side = new THREE.MeshStandardMaterial({ color: 0x1b120c, roughness: 0.78, metalness: 0.05 });
    const top = new THREE.MeshBasicMaterial({ map: face });
    // Box material order: +X, -X, +Y, -Y, +Z, -Z — the painted face is +Y, the
    // same convention the card meshes use.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(SEAT_BOARD.width, SEAT_BOARD.thickness, SEAT_BOARD.height),
      [side, side, top, side, side, side]
    );
    // Lean the board so its face tilts up toward the viewer.
    //
    // BoxGeometry maps a texture's top edge to local -Z, so the raised edge must
    // be -Z: with the group yawed at the camera that puts the lettering's top
    // away from the viewer (upright) and the face normal up-and-toward them.
    // Rotating the other way tips the face away and the text reads upside down.
    plate.rotation.x = BOARD_TILT;
    plate.position.set(
      0,
      // 抬高一点：牌脚原本压在底座上，看起来像陷进去了。
      SEAT_BASE.height + 0.05 + (SEAT_BOARD.height / 2) * Math.cos(BOARD_TILT),
      (SEAT_BOARD.height / 2) * Math.sin(BOARD_TILT) * 0.55
    );
    plate.castShadow = true;
    plate.receiveShadow = true;
    group.add(plate);

    return { group, plate };
  }
}
