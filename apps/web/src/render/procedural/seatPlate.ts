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
  /** Emoji fallback avatar (fixtures / AI seats). */
  avatar: string;
  /**
   * 联机身份的真头像（`/avatars/…`）。有图就把它画进铜圈，emoji 只当占位，
   * 这样牌桌上的立牌和玩家卡是同一张脸。
   */
  avatarUrl?: string;
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
   * 底座半圆环的灯态：轮到此人 = 'turn'（呼吸红），已准备待命 = 'idle'（白），
   * 还没准备 = 'off'（磨砂白、不发光）。
   */
  lamp?: 'off' | 'idle' | 'turn';
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
      info.avatarUrl ?? '',
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
    // 真头像异步到货：先拿 emoji 兜底把整块板画完，图片到了只重绘铜圈。
    this.paintAvatarImage(ctx, info, texture, { x: coinX, y: coinY, r: coinR });
    this.faceCache.set(key, texture);
    return texture;
  }

  /**
   * 把大厅头像画进铜圈。
   *
   * 立牌纹理是开局同步画好的，头像却要联网加载；所以先用 emoji 占位，图片到位
   * 后只重绘铜圈那一块（圆形裁切 + cover 缩放）再 `needsUpdate`，不会整块闪白。
   * 加载失败就保持 emoji，离线/无头像的座位照旧。
   */
  private static paintAvatarImage(
    ctx: CanvasRenderingContext2D,
    info: SeatPlateInfo,
    texture: THREE.CanvasTexture,
    coin: { x: number; y: number; r: number }
  ): void {
    const url = info.avatarUrl;
    if (!url || typeof Image === 'undefined') return;
    const wood = WOODS[info.wood ?? 'walnut'];
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const sourceW = image.naturalWidth || image.width;
      const sourceH = image.naturalHeight || image.height;
      if (!sourceW || !sourceH) return;
      const diameter = coin.r * 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(coin.x, coin.y, coin.r - 2, 0, Math.PI * 2);
      ctx.clip();
      if (info.muted) ctx.globalAlpha = 0.45;
      // cover：短边铺满铜圈，长边居中裁掉。
      const scale = Math.max(diameter / sourceW, diameter / sourceH);
      const w = sourceW * scale;
      const h = sourceH * scale;
      ctx.drawImage(image, coin.x - w / 2, coin.y - h / 2, w, h);
      ctx.restore();
      // 重描铜圈，盖住圆形裁切的毛边。
      ctx.strokeStyle = info.active ? BRASS : wood.inkSoft;
      ctx.lineWidth = info.active ? 6 : 3;
      ctx.beginPath();
      ctx.arc(coin.x, coin.y, coin.r, 0, Math.PI * 2);
      ctx.stroke();
      texture.needsUpdate = true;
    };
    image.src = url;
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
    // 半圆环呼吸灯：贴在底座上表面、沿前缘的一段弧。`lamp` 三态由调用方按牌**局**
    // 语义给出——轮到此人 = 红，已准备 / 本轮已动作 = 淡绿，未就位 = 磨砂白。
    // 灯是贴在底座上的，不做成贴片或宝石，近看也只是一道细弧。
    let lamp: THREE.Mesh | undefined;
    {
      // 初始一律磨砂白；真正的灯态由场景每帧按牌局刷新（节点是增量复用的，
      // 建牌那一刻的状态不可靠）。
      const tone = 0xd6d9de;
      const opacity = 0.22;
      lamp = new THREE.Mesh(
        new THREE.RingGeometry(SEAT_BASE.radius * 0.868, SEAT_BASE.radius * 0.914, 64, 1, 0, Math.PI),
        new THREE.MeshBasicMaterial({
          color: tone,
          transparent: true,
          opacity,
          // 灯是贴在底座顶面上的平面：不开 polygonOffset 会与圆盘顶面共面打架
          // （深度值几乎相同，画面上时有时无）。让它永远压过底座。
          // RingGeometry 是单面平面，绕 X 转 90° 后法线朝下；从上往下看就是背面，
          // 会被默认的 FrontSide 剔除——这是它一直看不见的根本原因。
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2
        })
      );
      // 半径对齐底座贴图里的黄铜装饰槽：贴图 256px、槽在 114px（= 0.8906 半径），
      // 所以灯环取 0.868~0.914 R，点亮的正是那道装饰条本身。
      // RingGeometry 画在 XY 平面；抬平后 +Y 指向 +Z。板身挡住的是 +Z 那半，
      // 所以取 PI..2PI 这半圈——正好落在相机看得见的那一侧（后缘）。
      lamp.rotation.x = Math.PI / 2;
      lamp.position.y = SEAT_BASE.height + 0.005;
      group.add(lamp);
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
    // 让牌的下沿**正好贴在底座上表面**，不要陷进去、也不要悬空。
    //
    // 绕 X 转 θ 之后，板的最低角在局部坐标是 (0, ±T/2, +H/2)，落到世界里下沉
    // (H/2)·sinθ + (T/2)·cosθ —— 所以板心的 y 必须等于「底座高 + 这段下沉量」。
    // 同一旋转把下沿往前推了 (H/2)·cosθ，因此板心还要往回退同样多（再加一点前移
    // 余量），下沿才落在底座圆心附近而不是伸出盘沿。
    const sink =
      (SEAT_BOARD.height / 2) * Math.sin(BOARD_TILT) +
      (SEAT_BOARD.thickness / 2) * Math.cos(BOARD_TILT);
    const toeForward = (SEAT_BOARD.height / 2) * Math.cos(BOARD_TILT);
    const toeZ = 0.1; // 下沿相对底座圆心的前后位置
    plate.position.set(0, SEAT_BASE.height + sink, toeZ - toeForward);
    plate.castShadow = true;
    plate.receiveShadow = true;
    group.add(plate);

    return { group, plate, lamp };
  }
}
