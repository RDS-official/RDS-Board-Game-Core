import * as THREE from 'three';
import { CANVAS_FONT_STACK } from '../fonts';

/**
 * Seat nameplates.
 *
 * A brass ring on the felt reads as "a slot", not as "a person". Each seat now
 * carries a small wooden plaque — avatar coin, nickname, and the player's colour
 * as an inlay stripe — drawn with the same palette as the rest of the table
 * (warm oak, brass rivets, ivory lettering). The plaque is a camera-facing
 * sprite, so the name stays readable from any orbit angle, and it is the click
 * target that opens the player sheet.
 */

export interface SeatPlateInfo {
  name: string;
  avatar: string;
  /** Player accent colour (hex). */
  color: string;
  /** Second line: role, seat marker or status. */
  detail?: string;
  /** Whose turn it is: brass rim + a ▶ marker. */
  active?: boolean;
  /** Dimmed when the seat is out of the hand (folded / busted / dead). */
  muted?: boolean;
}

const OAK_LIGHT = '#8a5a30';
const OAK_DARK = '#5a3719';
const OAK_GRAIN = 'rgba(38, 22, 10, 0.35)';
const BRASS = '#c9a24a';
const IVORY = '#f6ecd2';

export class SeatPlateBuilder {
  private static cache = new Map<string, THREE.CanvasTexture>();

  /** Wood grain, avatar coin and lettering for one plaque. */
  private static texture(info: SeatPlateInfo): THREE.CanvasTexture {
    const key = [info.name, info.avatar, info.color, info.detail ?? '', info.active ? 'a' : '', info.muted ? 'm' : ''].join('|');
    const cached = this.cache.get(key);
    if (cached) return cached;

    const width = 512;
    const height = 224;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the seat plate');

    // Oak board: vertical gradient plus deterministic grain arcs.
    const board = ctx.createLinearGradient(0, 0, 0, height);
    board.addColorStop(0, OAK_LIGHT);
    board.addColorStop(0.55, '#74492a');
    board.addColorStop(1, OAK_DARK);
    ctx.fillStyle = board;
    ctx.beginPath();
    ctx.roundRect(6, 6, width - 12, height - 12, 26);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(6, 6, width - 12, height - 12, 26);
    ctx.clip();
    let seed = 0x1f3d5b;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 46; i++) {
      const y = rnd() * height;
      const drift = 6 + rnd() * 16;
      ctx.strokeStyle = OAK_GRAIN;
      ctx.lineWidth = 0.6 + rnd() * 2.2;
      ctx.beginPath();
      ctx.moveTo(-20, y);
      for (let x = 0; x <= width + 20; x += 40) {
        ctx.lineTo(x, y + Math.sin((x + i * 37) / 90) * drift);
      }
      ctx.stroke();
    }
    // A couple of knots so the board is not uniform.
    for (let i = 0; i < 3; i++) {
      const cx = 60 + rnd() * (width - 120);
      const cy = 30 + rnd() * (height - 60);
      const radius = 8 + rnd() * 14;
      const knot = ctx.createRadialGradient(cx, cy, 1, cx, cy, radius);
      knot.addColorStop(0, 'rgba(30, 16, 6, 0.55)');
      knot.addColorStop(1, 'rgba(30, 16, 6, 0)');
      ctx.fillStyle = knot;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Bevel + rim (brass when it is this player's turn).
    ctx.strokeStyle = 'rgba(20, 10, 4, 0.55)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.roundRect(6, 6, width - 12, height - 12, 26);
    ctx.stroke();
    ctx.strokeStyle = info.active ? BRASS : 'rgba(201, 162, 74, 0.42)';
    ctx.lineWidth = info.active ? 6 : 3;
    ctx.beginPath();
    ctx.roundRect(12, 12, width - 24, height - 24, 20);
    ctx.stroke();

    // Brass rivets in the corners.
    for (const [x, y] of [
      [30, 30],
      [width - 30, 30],
      [30, height - 30],
      [width - 30, height - 30]
    ]) {
      ctx.fillStyle = BRASS;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 240, 200, 0.6)';
      ctx.beginPath();
      ctx.arc(x - 1.4, y - 1.4, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Avatar coin: player colour ring, tinted face, emoji or letter inside.
    const coinX = 96;
    const coinY = height / 2;
    const coinR = 62;
    ctx.fillStyle = 'rgba(12, 8, 4, 0.45)';
    ctx.beginPath();
    ctx.arc(coinX, coinY, coinR + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = info.muted ? 'rgba(120, 120, 120, 0.5)' : info.color;
    ctx.beginPath();
    ctx.arc(coinX, coinY, coinR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = info.active ? BRASS : 'rgba(246, 236, 210, 0.55)';
    ctx.lineWidth = info.active ? 5 : 3;
    ctx.beginPath();
    ctx.arc(coinX, coinY, coinR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = IVORY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const glyph = String(info.avatar || info.name.slice(0, 1) || '?');
    // Emoji avatars are wide; a single letter needs a bigger size.
    const glyphSize = glyph.length > 1 ? 66 : 74;
    ctx.font = `${glyphSize}px ${CANVAS_FONT_STACK}`;
    ctx.fillText(glyph, coinX, coinY + 4);

    // Name + detail line.
    const textLeft = coinX + coinR + 28;
    const maxWidth = width - textLeft - 34;
    ctx.textAlign = 'left';
    ctx.fillStyle = info.muted ? 'rgba(246, 236, 210, 0.55)' : IVORY;
    let nameSize = 54;
    ctx.font = `700 ${nameSize}px ${CANVAS_FONT_STACK}`;
    while (ctx.measureText(info.name).width > maxWidth && nameSize > 26) {
      nameSize -= 2;
      ctx.font = `700 ${nameSize}px ${CANVAS_FONT_STACK}`;
    }
    ctx.fillText(info.name, textLeft, info.detail ? height / 2 - 22 : height / 2 + 2);

    if (info.detail) {
      ctx.fillStyle = 'rgba(246, 236, 210, 0.72)';
      ctx.font = `500 30px ${CANVAS_FONT_STACK}`;
      let detail = info.detail;
      while (ctx.measureText(detail).width > maxWidth && detail.length > 2) {
        detail = detail.slice(0, -2);
      }
      ctx.fillText(detail, textLeft, height / 2 + 34);
    }

    // Turn marker: a brass chevron on the left edge.
    if (info.active) {
      ctx.fillStyle = BRASS;
      ctx.beginPath();
      ctx.moveTo(18, height / 2 - 16);
      ctx.lineTo(34, height / 2);
      ctx.lineTo(18, height / 2 + 16);
      ctx.closePath();
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.cache.set(key, texture);
    return texture;
  }

  /**
   * A camera-facing plaque. Sprites are used on purpose: the table is orbited,
   * and a fixed orientation would show the back of the plaque from half of the
   * angles.
   */
  public static createPlate(info: SeatPlateInfo, width = 3.1): THREE.Sprite {
    const texture = this.texture(info);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    const aspect = 224 / 512;
    sprite.scale.set(width, width * aspect, 1);
    return sprite;
  }
}
