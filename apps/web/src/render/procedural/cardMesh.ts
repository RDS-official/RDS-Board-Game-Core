import * as THREE from 'three';
import { CardFace } from '@rds/kernel/types';
import { CANVAS_FONT_STACK, CANVAS_SERIF_STACK } from '../fonts';

/**
 * Procedural Card Builder.
 * Produces authentic antique, weathered, occult horror card textures (Betrayal at House on the Hill)
 * as well as classic tactile tabletop card textures for all engine games.
 * 100% self-contained — no external image files required!
 */
export class CardMeshBuilder {
  private static faceCache = new Map<string, THREE.CanvasTexture>();
  private static backTexture: THREE.CanvasTexture | null = null;

  private static tierColor(type?: string): string {
    if (type === 'TIER_1') return '#2f7d49';
    if (type === 'TIER_2') return '#a8791f';
    if (type === 'TIER_3') return '#245f9e';
    if (type === 'ARMOR') return '#4a5b6a';
    if (type === 'WEAPON') return '#7a3c22';
    if (type === 'TRICK') return '#5b3f86';
    if (type === 'OMEN') return '#6e1a38';
    if (type === 'ITEM') return '#7d5c2e';
    if (type === 'EVENT') return '#2d3742';
    if (type === 'NOBLE') return '#7a5a1f';
    return '#2b2621';
  }

  private static drawGem(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
    const pts: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 1.05]);
    }

    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Top facet highlight
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.86);
    ctx.lineTo(cx + r * 0.5, cy - r * 0.28);
    ctx.lineTo(cx, cy + r * 0.05);
    ctx.lineTo(cx - r * 0.5, cy - r * 0.28);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy - r * 0.28);
    ctx.lineTo(cx, cy + r * 0.05);
    ctx.lineTo(cx, cy + r * 0.9);
    ctx.lineTo(cx - r * 0.86, cy + r * 0.42);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * Draws atmospheric emblems customized for occult horror & classic board game genres.
   */
  private static drawEmblem(
    ctx: CanvasRenderingContext2D,
    type: string | undefined,
    cx: number,
    cy: number,
    color: string
  ) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'OMEN') {
      // Occult All-Seeing Eye with mystic radiating starburst
      // Radiating sunburst rays
      ctx.strokeStyle = 'rgba(201, 162, 74, 0.4)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 16; i++) {
        const ang = (Math.PI * 2 / 16) * i;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * 45, Math.sin(ang) * 45);
        ctx.lineTo(Math.cos(ang) * 85, Math.sin(ang) * 85);
        ctx.stroke();
      }

      // Eye contour
      ctx.strokeStyle = '#c9a24a';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(-70, 0);
      ctx.quadraticCurveTo(0, -48, 70, 0);
      ctx.quadraticCurveTo(0, 48, -70, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#1c0f16';
      ctx.fill();

      // Iris & Slit Pupil
      ctx.fillStyle = '#941c3c';
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e6c268';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#0a0507';
      ctx.beginPath();
      ctx.ellipse(0, 0, 7, 20, 0, 0, Math.PI * 2);
      ctx.fill();

      // Gleam
      ctx.fillStyle = '#fff4d6';
      ctx.beginPath();
      ctx.arc(-8, -8, 5, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'ITEM' || type === 'WEAPON') {
      // Crossed Antique Daggers / Relic Cross
      ctx.strokeStyle = '#9ca6b3';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(-54, -60);
      ctx.lineTo(50, 52);
      ctx.moveTo(54, -60);
      ctx.lineTo(-50, 52);
      ctx.stroke();

      // Brass hilts & pommels
      ctx.strokeStyle = '#c9a24a';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(-66, 40);
      ctx.lineTo(-40, 66);
      ctx.moveTo(66, 40);
      ctx.lineTo(40, 66);
      ctx.stroke();

      // Central brass medallion
      ctx.fillStyle = '#3a2414';
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c9a24a';
      ctx.lineWidth = 3;
      ctx.stroke();
    } else if (type === 'EVENT') {
      // Skull of Mortality & Swirling Astral Fog
      ctx.fillStyle = '#e8dcc5';
      // Cranium
      ctx.beginPath();
      ctx.arc(0, -12, 36, 0, Math.PI * 2);
      ctx.fill();
      // Jaw
      ctx.fillRect(-20, 10, 40, 26);

      // Eye sockets
      ctx.fillStyle = '#161d24';
      ctx.beginPath();
      ctx.ellipse(-14, -8, 10, 14, -0.2, 0, Math.PI * 2);
      ctx.ellipse(14, -8, 10, 14, 0.2, 0, Math.PI * 2);
      ctx.fill();

      // Nasal cavity
      ctx.beginPath();
      ctx.moveTo(0, 4);
      ctx.lineTo(-5, 14);
      ctx.lineTo(5, 14);
      ctx.closePath();
      ctx.fill();

      // Teeth notches
      ctx.strokeStyle = '#161d24';
      ctx.lineWidth = 3;
      for (let t = -12; t <= 12; t += 8) {
        ctx.beginPath();
        ctx.moveTo(t, 22);
        ctx.lineTo(t, 36);
        ctx.stroke();
      }
    } else if (type === 'TIER_1' || type === 'TIER_2' || type === 'TIER_3') {
      this.drawGem(ctx, 0, 0, 88, color);
    } else if (type === 'BASIC') {
      // Sanguosha Crossed blades
      ctx.strokeStyle = color;
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(-52, -58);
      ctx.lineTo(48, 54);
      ctx.moveTo(52, -58);
      ctx.lineTo(-48, 54);
      ctx.stroke();
      ctx.strokeStyle = '#c9a24a';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(-64, 44);
      ctx.lineTo(-40, 68);
      ctx.moveTo(64, 44);
      ctx.lineTo(40, 68);
      ctx.stroke();
    } else if (type === 'TRICK') {
      // Scroll
      ctx.fillStyle = '#e8dcc0';
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.roundRect(-78, -54, 156, 108, 10);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 6;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(-52, i * 26);
        ctx.lineTo(52, i * 26);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(-78, -54, 14, 0, Math.PI * 2);
      ctx.arc(78, 54, 14, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'ARMOR') {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -66);
      ctx.lineTo(62, -42);
      ctx.lineTo(54, 32);
      ctx.quadraticCurveTo(28, 66, 0, 76);
      ctx.quadraticCurveTo(-28, 66, -54, 32);
      ctx.lineTo(-62, -42);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#e6c976';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(0, -46);
      ctx.lineTo(0, 52);
      ctx.moveTo(-38, -16);
      ctx.lineTo(38, -16);
      ctx.stroke();
    } else if (type === 'NOBLE') {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-62, 34);
      ctx.lineTo(-62, -26);
      ctx.lineTo(-30, 0);
      ctx.lineTo(0, -46);
      ctx.lineTo(30, 0);
      ctx.lineTo(62, -26);
      ctx.lineTo(62, 34);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f0d38a';
      ctx.fillRect(-62, 34, 124, 12);
    } else {
      this.drawGem(ctx, 0, 0, 74, color);
    }

    ctx.restore();
  }

  /**
   * Antique Leather Grimoire Back Texture with embossed gold-foil occult crest
   * and heavy brass corner protectors.
   */
  public static getCardBackTexture(): THREE.CanvasTexture {
    if (this.backTexture) return this.backTexture;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 768;
    const ctx = canvas.getContext('2d')!;

    // 1. Decayed Antique Leather Texture
    const grad = ctx.createRadialGradient(256, 384, 80, 256, 384, 420);
    grad.addColorStop(0, '#261219');
    grad.addColorStop(0.65, '#180a0e');
    grad.addColorStop(1, '#0c0406');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 768);

    // Leather grain & cracks
    for (let i = 0; i < 3500; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 768;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(x, y, 2, 2);
    }

    // 2. Weathered Gold Foil Double Border
    ctx.strokeStyle = '#c9a24a';
    ctx.lineWidth = 10;
    ctx.strokeRect(20, 20, 472, 728);

    ctx.strokeStyle = 'rgba(201, 162, 74, 0.45)';
    ctx.lineWidth = 3;
    ctx.strokeRect(34, 34, 444, 700);

    // 3. Ornate Brass Corner Protectors
    const drawCorner = (x: number, y: number, rot: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);

      ctx.fillStyle = '#c49a45';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(60, 0);
      ctx.lineTo(0, 60);
      ctx.closePath();
      ctx.fill();

      // Brass rivet
      ctx.fillStyle = '#2b1e0f';
      ctx.beginPath();
      ctx.arc(22, 22, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e6c268';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.restore();
    };

    drawCorner(20, 20, 0);
    drawCorner(492, 20, Math.PI / 2);
    drawCorner(492, 748, Math.PI);
    drawCorner(20, 748, -Math.PI / 2);

    // 4. Central Esoteric Seal (House on the Hill silhouette inside an Ouroboros)
    ctx.save();
    ctx.translate(256, 384);

    // Outer Ouroboros Ring
    ctx.strokeStyle = '#c9a24a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 120, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(201, 162, 74, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 134, 0, Math.PI * 2);
    ctx.stroke();

    // Occult Octagram
    ctx.strokeStyle = 'rgba(201, 162, 74, 0.28)';
    ctx.lineWidth = 2;
    for (let r = 0; r < 8; r++) {
      ctx.rotate(Math.PI / 4);
      ctx.strokeRect(-72, -72, 144, 144);
    }
    ctx.restore();

    // Sinister House Silhouette inside central medallion
    ctx.fillStyle = '#0f0508';
    ctx.beginPath();
    ctx.arc(256, 384, 82, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c9a24a';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Victorian Mansion Graphic
    ctx.fillStyle = '#d9b45b';
    ctx.beginPath();
    // Mansion base
    ctx.fillRect(216, 375, 80, 48);
    // Left tower & spire
    ctx.fillRect(210, 345, 24, 60);
    ctx.moveTo(210, 345);
    ctx.lineTo(222, 315);
    ctx.lineTo(234, 345);
    // Center gable
    ctx.moveTo(234, 375);
    ctx.lineTo(256, 340);
    ctx.lineTo(278, 375);
    // Right turret
    ctx.fillRect(280, 350, 20, 55);
    ctx.moveTo(280, 350);
    ctx.lineTo(290, 325);
    ctx.lineTo(300, 350);
    ctx.fill();

    // Latin Inscription
    ctx.font = 'italic 600 16px "Georgia", "Times New Roman", serif';
    ctx.fillStyle = 'rgba(201, 162, 74, 0.85)';
    ctx.textAlign = 'center';
    ctx.fillText('• MEMENTO MORI •', 256, 545);

    ctx.font = `700 14px ${CANVAS_FONT_STACK}`;
    ctx.fillStyle = 'rgba(201, 162, 74, 0.6)';
    ctx.fillText('BETRAYAL SIMULATOR', 256, 680);

    this.backTexture = new THREE.CanvasTexture(canvas);
    this.backTexture.colorSpace = THREE.SRGBColorSpace;
    return this.backTexture;
  }

  /**
   * Front card face texture with antique aged parchment, stained edges,
   * Victorian filigree borders, and tailored iconography.
   */
  public static createCardFaceTexture(face: CardFace, isMasked = false): THREE.CanvasTexture {
    const key = `${face.title}|${face.suit}|${face.rank}|${isMasked}|${JSON.stringify(face.cost || {})}|${face.type}|${face.score}|${face.desc}`;
    const cached = this.faceCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 768;
    const ctx = canvas.getContext('2d')!;

    // Masked Card: Sinister Dark Seal
    if (isMasked) {
      ctx.fillStyle = '#0f141a';
      ctx.fillRect(0, 0, 512, 768);

      // Red Wax Seal with Skull
      const vig = ctx.createRadialGradient(256, 360, 40, 256, 360, 340);
      vig.addColorStop(0, 'rgba(120, 20, 30, 0.5)');
      vig.addColorStop(1, 'rgba(5, 8, 12, 0.95)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, 512, 768);

      // Wax Seal
      ctx.fillStyle = '#821622';
      ctx.beginPath();
      ctx.arc(256, 340, 84, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c42838';
      ctx.lineWidth = 6;
      ctx.stroke();

      ctx.fillStyle = '#f5e4c6';
      ctx.font = 'bold 96px "Georgia", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 256, 344);

      ctx.font = `700 24px ${CANVAS_FONT_STACK}`;
      ctx.fillStyle = '#cfd9e8';
      ctx.fillText('未揭示的秘密', 256, 480);
      ctx.font = `500 16px ${CANVAS_FONT_STACK}`;
      ctx.fillStyle = '#7a8b9e';
      ctx.fillText('HIDDEN INFORMATION · 𝒪(s, i)', 256, 518);

      const maskedTexture = new THREE.CanvasTexture(canvas);
      maskedTexture.colorSpace = THREE.SRGBColorSpace;
      this.faceCache.set(key, maskedTexture);
      return maskedTexture;
    }

    const isBetrayal = face.type === 'OMEN' || face.type === 'ITEM' || face.type === 'EVENT';
    const accent = face.color || this.tierColor(face.type);

    // 1. Aged Vintage Parchment Background with Darkened Burnt Vignette
    const bgGrad = ctx.createRadialGradient(256, 384, 100, 256, 384, 440);
    if (face.type === 'OMEN') {
      bgGrad.addColorStop(0, '#f2dfca');
      bgGrad.addColorStop(0.7, '#d6ba98');
      bgGrad.addColorStop(1, '#521f2d');
    } else if (face.type === 'EVENT') {
      bgGrad.addColorStop(0, '#e5ded5');
      bgGrad.addColorStop(0.7, '#bcb5ab');
      bgGrad.addColorStop(1, '#2b343d');
    } else {
      bgGrad.addColorStop(0, '#f5ecd5');
      bgGrad.addColorStop(0.7, '#d8c59f');
      bgGrad.addColorStop(1, '#3b2a1a');
    }
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, 512, 768);

    // Paper fibers, age spots, and blood stains
    for (let i = 0; i < 2800; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 768;
      const a = Math.random() * 0.04;
      ctx.fillStyle = `rgba(60,35,15,${a})`;
      ctx.fillRect(x, y, 2, 2);
    }

    // Occult Watermark on Card Center
    ctx.save();
    ctx.translate(256, 320);
    ctx.globalAlpha = 0.08;
    this.drawEmblem(ctx, face.type, 0, 0, '#000000');
    ctx.restore();

    // 2. Gothic Double Frame
    ctx.strokeStyle = accent;
    ctx.lineWidth = 10;
    ctx.strokeRect(16, 16, 480, 736);

    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(26, 26, 460, 716);

    // 3. Ornate Header Ribbon
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(26, 26, 460, 84, [8, 8, 0, 0]);
    ctx.fill();

    // Gold trim under header
    ctx.strokeStyle = '#c9a24a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(26, 110);
    ctx.lineTo(486, 110);
    ctx.stroke();

    // Title
    ctx.fillStyle = '#ffffff';
    let titleSize = 34;
    ctx.font = `700 ${titleSize}px ${CANVAS_SERIF_STACK}`;
    while (ctx.measureText(face.title).width > 420 && titleSize > 18) {
      titleSize -= 2;
      ctx.font = `700 ${titleSize}px ${CANVAS_SERIF_STACK}`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(face.title, 256, 68);

    // Suit / Rank (for Sanguosha / classic cards)
    if (face.suit && face.rank) {
      const isRed = face.suit === '\u2665' || face.suit === '\u2666';
      ctx.fillStyle = isRed ? '#b3261e' : '#22262b';
      ctx.font = `700 38px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'left';
      ctx.fillText(`${face.rank}`, 38, 154);
      ctx.font = '32px "Segoe UI Symbol", sans-serif';
      ctx.fillText(face.suit, 38, 188);

      ctx.textAlign = 'right';
      ctx.font = `700 38px ${CANVAS_FONT_STACK}`;
      ctx.fillText(`${face.rank}`, 474, 154);
      ctx.font = '32px "Segoe UI Symbol", sans-serif';
      ctx.fillText(face.suit, 474, 188);
    }

    // 4. Type Badge Ribbon
    if (face.type) {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(166, 122, 180, 36, 18);
      ctx.fill();
      ctx.strokeStyle = '#c9a24a';
      ctx.lineWidth = 2;
      ctx.stroke();

      const typeZh =
        face.type === 'OMEN'
          ? '预兆 · OMEN'
          : face.type === 'ITEM'
          ? '遗物 · ITEM'
          : face.type === 'EVENT'
          ? '事件 · EVENT'
          : face.type;

      ctx.fillStyle = '#fff4d6';
      ctx.font = `700 16px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(typeZh, 256, 140);
    }

    // 5. Central Emblem Art Area
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(58, 178, 396, 260, 12);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    this.drawEmblem(ctx, face.type, 256, 308, accent);

    // Cost Chips (Splendor)
    if (face.cost) {
      const gemColors: Record<string, string> = {
        diamond: '#d9e2e8',
        sapphire: '#2f6fc0',
        emerald: '#2f7d49',
        ruby: '#b3261e',
        onyx: '#2b2b2b'
      };
      const entries = Object.entries(face.cost).filter(([, v]) => (v as number) > 0);
      let cy = 206;
      entries.forEach(([gem, req]) => {
        const color = gemColors[gem] || '#6b7280';
        ctx.beginPath();
        ctx.arc(92, cy, 21, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = gem === 'diamond' ? '#2b2b2b' : '#ffffff';
        ctx.font = `700 22px ${CANVAS_FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${req}`, 92, cy);
        cy += 46;
      });
    }

    // Victory Points / Score
    if (typeof face.score === 'number' && face.score > 0) {
      ctx.beginPath();
      ctx.arc(424, 206, 28, 0, Math.PI * 2);
      ctx.fillStyle = '#c9a24a';
      ctx.fill();
      ctx.strokeStyle = '#fff8e1';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#231a08';
      ctx.font = `700 28px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${face.score}`, 424, 208);
    }

    // 6. Rules & Description Panel
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.roundRect(44, 460, 424, 250, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60, 40, 20, 0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#211812';
    ctx.font = `600 19px ${CANVAS_FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    let lines = this.wrapText(ctx, face.desc || '', 384);
    if (lines.length > 8) {
      ctx.font = `500 16px ${CANVAS_FONT_STACK}`;
      lines = this.wrapText(ctx, face.desc || '', 384);
    }
    lines.slice(0, 10).forEach((line, i) => ctx.fillText(line, 64, 480 + i * 22));

    // Bottom decorative bar
    ctx.fillStyle = accent;
    ctx.fillRect(26, 720, 460, 8);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.faceCache.set(key, texture);
    return texture;
  }

  private static wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const result: string[] = [];
    let line = '';
    for (const ch of text) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth) {
        if (line) result.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) result.push(line);
    return result;
  }

  /**
   * Builds the complete card mesh with beveled paper rim.
   */
  public static createCardMesh(
    face: CardFace,
    width = 1.4,
    height = 2.1,
    isMasked = false,
    faceTextureOverride?: THREE.Texture | null,
    backTextureOverride?: THREE.Texture | null
  ): THREE.Mesh {
    const geom = new THREE.BoxGeometry(width, 0.02, height);

    const faceTextureFinal =
      faceTextureOverride ??
      (face.imageUrl ? this.loadImageTexture(face.imageUrl) : null);
    const faceTexture = faceTextureFinal || this.createCardFaceTexture(face, isMasked);
    const backTexture = backTextureOverride || this.getCardBackTexture();

    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xd9c8ab, roughness: 0.85 });
    const faceMat = new THREE.MeshStandardMaterial({
      map: faceTexture,
      roughness: faceTextureFinal ? 0.4 : 0.55,
      metalness: 0.02
    });
    const backMat = new THREE.MeshStandardMaterial({ map: backTexture, roughness: 0.6, metalness: 0.05 });

    // Box material order: +X, -X, +Y, -Y, +Z, -Z
    const materials = [edgeMat, edgeMat, faceMat, backMat, edgeMat, edgeMat];
    const mesh = new THREE.Mesh(geom, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    return mesh;
  }

  private static imageTextureCache = new Map<string, THREE.Texture>();

  /** Load an external image (e.g. imported Pokémon card art) as a texture. */
  public static loadImageTexture(url: string): THREE.Texture {
    const cached = this.imageTextureCache.get(url);
    if (cached) return cached;
    const tex = new THREE.TextureLoader().load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.imageTextureCache.set(url, tex);
    return tex;
  }
}
