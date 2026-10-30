import * as THREE from 'three';
import { CardFace } from '@rds/kernel/types';
import { CANVAS_FONT_STACK, CANVAS_SERIF_STACK } from '../fonts';

/**
 * Procedural Card Builder.
 *
 * Front faces are painted as **dark occult plates**: near-black lacquer,
 * tarnished gold hairlines, a candle halo and a single readable motif. The
 * language is shared with the DOM sheet (`apps/web/src/ui/cardArt.ts`) — the
 * two renderers cannot import each other (the UI layer may only reach
 * `@rds/app/contracts`), so the palette, the motif set and the per-category
 * composition are mirrored deliberately. Change one, change both.
 *
 * Two layers decide a face:
 *  1. **Category** — EVENT fractures (rays, cracks, chevron corners), ITEM
 *     stages a still life (niche, plinth, rivets), OMEN circles one watching
 *     mark (rings, arch, keystone). Anything else (Splendor, Sanguosha…) gets
 *     the relic frame with its own gem/shield sigil.
 *  2. **Card** — the name hash picks a motif when no keyword matches, and
 *     always drives ray counts, ring rotation, stains and the corner rune, so
 *     no two cards look alike even inside one category.
 *
 * 100% self-contained — no external image files, no `Math.random()` (a seeded
 * LCG keeps every plate byte-identical across reloads).
 */

/** Bumped whenever the painter changes: part of the texture cache key. */
const FACE_STYLE_VERSION = 'occult-dark-v1';

type PlateKind = 'OMEN' | 'ITEM' | 'EVENT' | 'ROOM' | 'RELIC';

type Motif =
  | 'skull'
  | 'eye'
  | 'raven'
  | 'claw'
  | 'blade'
  | 'drop'
  | 'key'
  | 'tome'
  | 'candle'
  | 'vessel'
  | 'ring'
  | 'serpent'
  | 'house';

interface PlateStyle {
  /** Radial ground: centre → mid → rim. */
  ground: [string, string, string];
  /** Gold hairline used for every frame and rule. */
  line: string;
  /** Category highlight: glows, solid marks, badges. */
  accent: string;
  /** Silhouette wash, so motifs read as relief. */
  wash: string;
  /** Header band base (dark, slightly tinted). */
  band: string;
  /** Primary / secondary text on the dark ground. */
  ink: string;
  inkDim: string;
}

const STYLES: Record<Exclude<PlateKind, 'RELIC'>, PlateStyle> = {
  OMEN: {
    ground: ['#2b0d18', '#190710', '#080307'],
    line: '#e3c07a',
    accent: '#c9455f',
    wash: 'rgba(201,69,95,0.18)',
    band: 'rgba(26,8,15,0.94)',
    ink: '#f8eedb',
    inkDim: 'rgba(232,214,190,0.74)'
  },
  ITEM: {
    ground: ['#2a1c0d', '#180f07', '#070403'],
    line: '#e6c07a',
    accent: '#d9a45b',
    wash: 'rgba(217,164,91,0.16)',
    band: 'rgba(23,15,7,0.94)',
    ink: '#f8eedb',
    inkDim: 'rgba(230,213,184,0.74)'
  },
  EVENT: {
    ground: ['#16202c', '#0c121a', '#04070b'],
    line: '#b9c6d6',
    accent: '#8fa4bd',
    wash: 'rgba(143,164,189,0.16)',
    band: 'rgba(10,14,20,0.94)',
    ink: '#f2f5fa',
    inkDim: 'rgba(199,212,226,0.72)'
  },
  ROOM: {
    ground: ['#231a10', '#150f09', '#060403'],
    line: '#d9c39a',
    accent: '#a8865a',
    wash: 'rgba(168,134,90,0.16)',
    band: 'rgba(19,14,9,0.94)',
    ink: '#f6eddc',
    inkDim: 'rgba(226,212,186,0.72)'
  }
};

const MOTIF_ORDER: Motif[] = [
  'skull',
  'eye',
  'raven',
  'claw',
  'blade',
  'drop',
  'key',
  'tome',
  'candle',
  'vessel',
  'ring',
  'serpent',
  'house'
];

/**
 * Keyword → motif; first match wins. Order is deliberate: weapons are matched
 * before hands ("左轮手枪" is a blade, not a claw) and skulls before keys
 * ("骷髅万能钥匙" is a skull).
 */
const MOTIF_KEYWORDS: [Motif, RegExp][] = [
  ['skull', /骷髅|头骨|颅|骸|skull|bone|骨/],
  ['eye', /眼|目|凝视|窥|瞳|eye|gaze|watch|stare/],
  ['blade', /刃|刀|斧|剑|矛|枪|镐|针|箭|匕|axe|blade|dagger|sword|spear|revolver|gun|pick|needle|arrow/],
  ['claw', /爪|手|指|掌|hand|claw|finger|grip/],
  ['drop', /滴|血|泪|drip|blood|tear|drop/],
  ['raven', /鸦|鸟|翼|羽|raven|crow|bird|feather|wing/],
  ['key', /钥匙|锁|机关|谜|key|lock|puzzle/],
  ['tome', /书|古籍|卷|笔记|信|纸|book|tome|grimoire|scroll|letter|page/],
  ['candle', /烛|灯|火|焰|光|candle|lantern|lamp|fire|flame|torch/],
  ['vessel', /瓶|药|瓮|罐|球|盐|水晶|bottle|vial|potion|jar|orb|ball|crystal|salt|flask/],
  ['ring', /环|戒|护符|徽记|奖章|铃|石|币|时空|传送|amulet|ring|charm|symbol|medal|bell|coin|stone|portal/],
  ['serpent', /蛇|藤|根|触|绳|链|serpent|snake|vine|tentacle|rope|chain|worm/],
  ['house', /宅|屋|门|楼|塔|廊|房|house|door|mansion|tower|corridor|room/]
];

/** Per-card numbers derived from the name hash. */
interface PlateSeed {
  hash: number;
  motif: Motif;
  /** Rotation step of the astrolabe ring, 0–23 (× 15°). */
  ringStep: number;
  /** 12 / 16 / 20 / 24 — rays for EVENT, ticks for OMEN. */
  rays: number;
  /** 0–7: which corner rune this card carries. */
  rune: number;
  /** 3–5 age spots bleeding through the lacquer. */
  stains: number;
}

export class CardMeshBuilder {
  private static faceCache = new Map<string, THREE.CanvasTexture>();
  private static backTexture: THREE.CanvasTexture | null = null;

  /* ---------------------------------------------------------------------- */
  /* Palette / seed helpers                                                  */
  /* ---------------------------------------------------------------------- */

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

  private static plateKind(type?: string): PlateKind {
    if (type === 'OMEN' || type === 'ITEM' || type === 'EVENT' || type === 'ROOM') return type;
    return 'RELIC';
  }

  private static styleFor(face: CardFace): PlateStyle {
    const kind = this.plateKind(face.type);
    if (kind === 'RELIC') {
      return {
        ground: ['#221d15', '#141109', '#060504'],
        line: '#d8c9a4',
        accent: face.color ?? this.tierColor(face.type),
        wash: 'rgba(216,201,164,0.15)',
        band: 'rgba(20,16,11,0.94)',
        ink: '#f7efdd',
        inkDim: 'rgba(224,211,186,0.72)'
      };
    }
    return STYLES[kind];
  }

  private static fnv1a(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Deterministic LCG: same card → same grain, stains and scratches. */
  private static lcg(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  private static seedFor(face: CardFace): PlateSeed {
    const hash = this.fnv1a(`${face.type ?? ''}|${face.title}|${face.suit ?? ''}|${face.rank ?? ''}`);
    const text = `${face.title} ${face.suit ?? ''}`.toLowerCase();
    let motif: Motif | null = null;
    for (const [candidate, pattern] of MOTIF_KEYWORDS) {
      if (pattern.test(text)) {
        motif = candidate;
        break;
      }
    }
    return {
      hash,
      motif: motif ?? MOTIF_ORDER[hash % MOTIF_ORDER.length],
      ringStep: hash % 24,
      rays: 12 + (hash % 4) * 4,
      rune: (hash >>> 3) % 8,
      stains: 3 + ((hash >>> 7) % 3)
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Ground: lacquer, grain, vignette                                        */
  /* ---------------------------------------------------------------------- */

  private static paintGround(ctx: CanvasRenderingContext2D, style: PlateStyle): void {
    const grad = ctx.createRadialGradient(256, 360, 60, 256, 384, 470);
    grad.addColorStop(0, style.ground[0]);
    grad.addColorStop(0.62, style.ground[1]);
    grad.addColorStop(1, style.ground[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 768);
  }

  private static paintGrain(ctx: CanvasRenderingContext2D, seed: PlateSeed, style: PlateStyle): void {
    const rnd = this.lcg(seed.hash ^ 0x9e3779b9);

    for (let i = 0; i < 2600; i++) {
      const x = rnd() * 512;
      const y = rnd() * 768;
      const alpha = 0.015 + rnd() * 0.05;
      ctx.fillStyle = rnd() > 0.45 ? `rgba(255,246,224,${alpha.toFixed(3)})` : `rgba(0,0,0,${(alpha * 1.4).toFixed(3)})`;
      ctx.fillRect(x, y, 1.6, 1.6);
    }

    // Long lacquer scratches.
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const x = rnd() * 512;
      const y = rnd() * 768;
      const len = 30 + rnd() * 140;
      const tilt = (rnd() - 0.5) * 0.9;
      ctx.strokeStyle = `rgba(255,248,230,${(0.02 + rnd() * 0.035).toFixed(3)})`;
      ctx.lineWidth = 0.8 + rnd() * 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(tilt) * len, y + Math.sin(tilt) * len);
      ctx.stroke();
    }
    ctx.restore();

    // Age spots / dried blood.
    for (let i = 0; i < seed.stains; i++) {
      const x = 40 + rnd() * 432;
      const y = 40 + rnd() * 690;
      const r = 14 + rnd() * 54;
      const blot = ctx.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, `${style.accent}22`);
      blot.addColorStop(0.6, `${style.accent}10`);
      blot.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = blot;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.72, rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private static paintVignette(ctx: CanvasRenderingContext2D): void {
    const vig = ctx.createRadialGradient(256, 384, 210, 256, 384, 470);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, 512, 768);
  }

  /* ---------------------------------------------------------------------- */
  /* Category composition                                                    */
  /* ---------------------------------------------------------------------- */

  private static paintCategoryBackdrop(
    ctx: CanvasRenderingContext2D,
    kind: PlateKind,
    style: PlateStyle,
    seed: PlateSeed
  ): void {
    const cx = 256;
    const cy = 322;
    if (kind === 'EVENT') {
      this.paintFracture(ctx, cx, cy, style, seed);
    } else if (kind === 'OMEN') {
      this.paintAstrolabe(ctx, cx, cy, style, seed);
    } else {
      this.paintStillLife(ctx, cx, cy, style, seed);
    }
  }

  /** EVENT — struck plate: faint rays across the whole card, cracks inside. */
  private static paintFracture(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    style: PlateStyle,
    seed: PlateSeed
  ): void {
    const rnd = this.lcg(seed.hash ^ 0x51ed2701);
    ctx.save();
    ctx.strokeStyle = style.accent;
    ctx.lineCap = 'round';

    // Faint field rays behind the medallion.
    for (let i = 0; i < seed.rays; i++) {
      const angle = (Math.PI * 2 * i) / seed.rays + (rnd() - 0.5) * 0.1;
      const inner = 150;
      const outer = 300 + rnd() * 150;
      ctx.globalAlpha = 0.05 + rnd() * 0.06;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle + 0.03) * outer, cy + Math.sin(angle + 0.03) * outer);
      ctx.stroke();
    }

    // Strong jagged rays inside the medallion.
    for (let i = 0; i < seed.rays; i++) {
      const angle = (Math.PI * 2 * i) / seed.rays + (rnd() - 0.5) * 0.12;
      const inner = 44 + rnd() * 12;
      const outer = inner + 42 + rnd() * 52;
      const bend = (rnd() - 0.5) * 0.2;
      ctx.globalAlpha = 0.16 + rnd() * 0.28;
      ctx.lineWidth = 1.4 + rnd() * 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle + bend) * ((inner + outer) / 2), cy + Math.sin(angle + bend) * ((inner + outer) / 2));
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }

    // Running cracks.
    for (let c = 0; c < 3; c++) {
      const angle = rnd() * Math.PI * 2;
      let x = cx + Math.cos(angle) * 34;
      let y = cy + Math.sin(angle) * 34;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let step = 0; step < 4; step++) {
        x += Math.cos(angle + (rnd() - 0.5) * 0.9) * 46;
        y += Math.sin(angle + (rnd() - 0.5) * 0.9) * 46;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** ITEM — still life: a soft display-case glow, a plinth and a cast shadow. */
  private static paintStillLife(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    style: PlateStyle,
    seed: PlateSeed
  ): void {
    const rnd = this.lcg(seed.hash ^ 0x27d4eb2f);
    ctx.save();
    ctx.strokeStyle = style.line;

    // Light falling from above, like a cabinet lamp.
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx - 78, cy + 120);
    ctx.bezierCurveTo(cx - 78, cy - 50, cx + 78, cy - 50, cx + 78, cy + 120);
    ctx.stroke();

    // Plinth.
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(cx - 150, cy + 132);
    ctx.lineTo(cx + 150, cy + 132);
    ctx.stroke();

    // Cast shadow under the object.
    ctx.globalAlpha = 1;
    const shadow = ctx.createRadialGradient(cx, cy + 118, 4, cx, cy + 118, 110);
    shadow.addColorStop(0, 'rgba(0,0,0,0.62)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 118, 110, 22, 0, 0, Math.PI * 2);
    ctx.fill();

    // Floating dust motes.
    for (let i = 0; i < 8; i++) {
      ctx.globalAlpha = 0.08 + rnd() * 0.16;
      ctx.fillStyle = style.line;
      ctx.beginPath();
      ctx.arc(cx - 120 + rnd() * 240, cy - 120 + rnd() * 200, 1 + rnd() * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** OMEN — astrolabe: concentric rings, rotating ticks, pointed arch. */
  private static paintAstrolabe(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    style: PlateStyle,
    seed: PlateSeed
  ): void {
    const rotation = (seed.ringStep * Math.PI) / 12;
    ctx.save();
    ctx.strokeStyle = style.line;
    ctx.lineCap = 'round';

    ctx.globalAlpha = 0.26;
    ctx.lineWidth = 1.6;
    for (const r of [200, 232]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.4;
    for (const r of [126, 142]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Tick ring, rotated per card.
    for (let i = 0; i < seed.rays; i++) {
      const angle = (Math.PI * 2 * i) / seed.rays + rotation;
      const major = i % 4 === 0;
      ctx.globalAlpha = major ? 0.6 : 0.32;
      ctx.lineWidth = major ? 2.4 : 1.3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * 142, cy + Math.sin(angle) * 142);
      ctx.lineTo(cx + Math.cos(angle) * (major ? 170 : 159), cy + Math.sin(angle) * (major ? 170 : 159));
      ctx.stroke();
    }

    // Pointed arch over the medallion.
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 150, 470);
    ctx.quadraticCurveTo(cx - 150, 120, cx, 96);
    ctx.quadraticCurveTo(cx + 150, 120, cx + 150, 470);
    ctx.stroke();

    // Keystone above the arch.
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = style.accent;
    ctx.beginPath();
    ctx.moveTo(cx, 78);
    ctx.lineTo(cx + 9, 92);
    ctx.lineTo(cx, 106);
    ctx.lineTo(cx - 9, 92);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* Frame, corners, header                                                  */
  /* ---------------------------------------------------------------------- */

  private static paintFrame(ctx: CanvasRenderingContext2D, kind: PlateKind, style: PlateStyle, seed: PlateSeed): void {
    ctx.save();
    // Gold hairline + dark inner emboss, so the plate reads as a bevelled tile.
    ctx.strokeStyle = style.line;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    if (kind === 'EVENT') ctx.setLineDash([26, 9]);
    ctx.strokeRect(18, 18, 476, 732);
    ctx.setLineDash([]);

    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(27, 27, 458, 714);

    ctx.strokeStyle = '#000';
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 4;
    ctx.strokeRect(31, 31, 450, 706);
    ctx.restore();

    this.paintCorners(ctx, kind, style);
  }

  private static paintCorners(ctx: CanvasRenderingContext2D, kind: PlateKind, style: PlateStyle): void {
    const corners: [number, number, number][] = [
      [18, 18, 0],
      [494, 18, Math.PI / 2],
      [494, 750, Math.PI],
      [18, 750, -Math.PI / 2]
    ];
    ctx.save();
    ctx.strokeStyle = style.line;
    ctx.lineCap = 'round';
    for (const [x, y, rot] of corners) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (kind === 'EVENT') {
        // Chevrons: nothing soft survives the fracture.
        ctx.moveTo(0, 34);
        ctx.lineTo(20, 26);
        ctx.lineTo(28, 0);
        ctx.stroke();
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.moveTo(10, 40);
        ctx.lineTo(30, 32);
        ctx.lineTo(40, 8);
        ctx.stroke();
      } else if (kind === 'OMEN') {
        // Rosette: a watching dot inside a ring.
        ctx.beginPath();
        ctx.arc(24, 24, 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(24, 0);
        ctx.lineTo(24, 8);
        ctx.moveTo(24, 40);
        ctx.lineTo(24, 48);
        ctx.moveTo(0, 24);
        ctx.lineTo(8, 24);
        ctx.moveTo(40, 24);
        ctx.lineTo(48, 24);
        ctx.stroke();
        ctx.fillStyle = style.accent;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(24, 24, 4.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Brass filigree bracket.
        ctx.beginPath();
        ctx.moveTo(0, 44);
        ctx.lineTo(0, 14);
        ctx.quadraticCurveTo(0, 0, 14, 0);
        ctx.lineTo(44, 0);
        ctx.stroke();
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(0, 28);
        ctx.quadraticCurveTo(18, 28, 28, 18);
        ctx.quadraticCurveTo(28, 0, 46, 0);
        ctx.stroke();
        ctx.fillStyle = style.accent;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(14, 14, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Eight little runes engraved at the foot of the medallion; the hash picks
   * one, so two cards sharing a motif still carry different maker's marks.
   */
  private static paintMakerRune(ctx: CanvasRenderingContext2D, style: PlateStyle, seed: PlateSeed): void {
    ctx.save();
    ctx.translate(256, 428);
    ctx.strokeStyle = style.line;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      const px = Math.cos(a) * 15;
      const py = Math.sin(a) * 15;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();

    // Rune glyphs are authored in a ±11 box; shrink them into the hexagon.
    ctx.scale(0.62, 0.62);
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2.2;
    const runes: ((c: CanvasRenderingContext2D) => void)[] = [
      c => {
        c.moveTo(-5, -11);
        c.lineTo(-5, 11);
        c.moveTo(-5, 0);
        c.lineTo(7, -8);
        c.moveTo(-5, 0);
        c.lineTo(7, 8);
      },
      c => {
        c.moveTo(8, 0);
        c.arc(0, 0, 8, 0, Math.PI * 2);
        c.moveTo(3, 0);
        c.arc(0, 0, 3, 0, Math.PI * 2);
      },
      c => {
        c.moveTo(0, -10);
        c.lineTo(9, 8);
        c.lineTo(-9, 8);
        c.closePath();
        c.moveTo(-5, 8);
        c.lineTo(-5, 14);
        c.moveTo(5, 8);
        c.lineTo(5, 14);
      },
      c => {
        c.moveTo(0, -11);
        c.lineTo(0, 11);
        c.moveTo(-8, -3);
        c.lineTo(8, -3);
        c.moveTo(-5, 5);
        c.lineTo(5, 5);
      },
      c => {
        c.moveTo(-9, -9);
        c.lineTo(-1, 0);
        c.lineTo(-9, 9);
        c.moveTo(1, -9);
        c.lineTo(9, 0);
        c.lineTo(1, 9);
      },
      c => {
        c.rect(-7, -7, 14, 14);
        c.moveTo(-3, -3);
        c.rect(-3, -3, 6, 6);
      },
      c => {
        c.moveTo(-9, -6);
        c.lineTo(9, -6);
        c.moveTo(-9, 0);
        c.lineTo(9, 0);
        c.moveTo(-9, 6);
        c.lineTo(9, 6);
      },
      c => {
        c.moveTo(0, -11);
        c.lineTo(0, 11);
        c.moveTo(-7, -4);
        c.lineTo(0, -11);
        c.lineTo(7, -4);
      }
    ];
    ctx.beginPath();
    runes[seed.rune](ctx);
    ctx.stroke();
    ctx.restore();
  }

  private static paintHeader(
    ctx: CanvasRenderingContext2D,
    face: CardFace,
    style: PlateStyle,
    kind: PlateKind
  ): void {
    // Band.
    const band = ctx.createLinearGradient(0, 18, 0, 124);
    band.addColorStop(0, style.band);
    band.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = band;
    ctx.beginPath();
    ctx.roundRect(18, 18, 476, 106, [7, 7, 0, 0]);
    ctx.fill();

    // Category wash across the band, so the three families read instantly.
    const wash = ctx.createLinearGradient(18, 0, 494, 0);
    wash.addColorStop(0, `${style.accent}00`);
    wash.addColorStop(0.5, `${style.accent}2e`);
    wash.addColorStop(1, `${style.accent}00`);
    ctx.fillStyle = wash;
    ctx.beginPath();
    ctx.roundRect(18, 18, 476, 106, [7, 7, 0, 0]);
    ctx.fill();

    // Gold rules above and below the band.
    ctx.strokeStyle = style.line;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(18, 124);
    ctx.lineTo(494, 124);
    ctx.stroke();
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 129);
    ctx.lineTo(472, 129);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Title: engraved cream on near-black, shrunk to fit.
    let titleSize = 36;
    ctx.font = `700 ${titleSize}px ${CANVAS_SERIF_STACK}`;
    while (ctx.measureText(face.title).width > 420 && titleSize > 18) {
      titleSize -= 2;
      ctx.font = `700 ${titleSize}px ${CANVAS_SERIF_STACK}`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(face.title, 256, 74);
    ctx.fillStyle = style.ink;
    ctx.fillText(face.title, 256, 72);

    // Hairline under the title keeps the band from reading as empty.
    if (kind === 'OMEN' || kind === 'ITEM' || kind === 'EVENT' || kind === 'ROOM') {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = style.accent;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(206, 104);
      ctx.lineTo(306, 104);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private static paintTypeBadge(ctx: CanvasRenderingContext2D, style: PlateStyle, label: string): void {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(176, 140, 160, 32, 16);
    ctx.fillStyle = 'rgba(6,5,4,0.82)';
    ctx.fill();
    ctx.strokeStyle = style.line;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = style.ink;
    ctx.font = `700 15px ${CANVAS_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 256, 157);
    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* Medallion + motifs                                                      */
  /* ---------------------------------------------------------------------- */

  private static paintMedallion(ctx: CanvasRenderingContext2D, style: PlateStyle, kind: PlateKind, face: CardFace, seed: PlateSeed): void {
    const cx = 256;
    const cy = 322;
    const r = 148;

    // Candle halo.
    const halo = ctx.createRadialGradient(cx, cy, 10, cx, cy, r + 40);
    halo.addColorStop(0, `${style.accent}3d`);
    halo.addColorStop(0.55, `${style.accent}14`);
    halo.addColorStop(1, `${style.accent}00`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 40, 0, Math.PI * 2);
    ctx.fill();

    // Plate inside the ring: darker than the ground so the motif pops.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const dish = ctx.createRadialGradient(cx, cy - 30, 20, cx, cy, r);
    dish.addColorStop(0, 'rgba(8,6,6,0.72)');
    dish.addColorStop(1, 'rgba(2,2,2,0.92)');
    ctx.fillStyle = dish;
    ctx.fill();
    ctx.clip();
    this.paintCategoryBackdrop(ctx, kind, style, seed);
    ctx.restore();

    // Double ring.
    ctx.save();
    ctx.strokeStyle = style.line;
    ctx.globalAlpha = 0.62;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = style.accent;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    if (kind === 'RELIC') {
      ctx.save();
      ctx.translate(cx, cy);
      this.drawEmblem(ctx, face.type, 0, 0, style.accent);
      ctx.restore();
      return;
    }

    // Motif, drawn in the same 220×140 box the DOM plate uses.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.42, 1.42);
    ctx.translate(-110, -70);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style.line;
    ctx.lineWidth = 2.4;
    ctx.fillStyle = style.wash;
    this.traceMotif(ctx, seed.motif, style);
    ctx.restore();

    this.paintMakerRune(ctx, style, seed);
  }

  /** Motif geometry mirrors `cardArt.ts` so both renderers read as one set. */
  private static traceMotif(ctx: CanvasRenderingContext2D, motif: Motif, style: PlateStyle): void {
    const accent = style.accent;
    const fillStroke = (build: (c: CanvasRenderingContext2D) => void, fill = true): void => {
      ctx.beginPath();
      build(ctx);
      if (fill) {
        ctx.fill();
      }
      ctx.stroke();
    };

    switch (motif) {
      case 'skull':
        fillStroke(c => {
          c.moveTo(78, 86);
          c.bezierCurveTo(69, 78, 66, 66, 72, 55);
          c.bezierCurveTo(79, 42, 94, 36, 110, 38);
          c.bezierCurveTo(127, 40, 139, 50, 141, 64);
          c.bezierCurveTo(143, 76, 138, 84, 130, 90);
          c.bezierCurveTo(126, 93, 125, 97, 126, 102);
          c.lineTo(85, 102);
          c.bezierCurveTo(86, 96, 85, 91, 78, 86);
          c.closePath();
        });
        ctx.beginPath();
        ctx.moveTo(91, 84);
        ctx.quadraticCurveTo(91, 64, 110, 64);
        ctx.quadraticCurveTo(129, 64, 129, 84);
        ctx.moveTo(85, 88);
        ctx.lineTo(127, 88);
        ctx.moveTo(91, 104);
        ctx.lineTo(122, 104);
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.ellipse(99, 80, 5, 6.4, 0, 0, Math.PI * 2);
        ctx.ellipse(121, 80, 5, 6.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = style.line;
        ctx.beginPath();
        ctx.moveTo(106, 91);
        ctx.lineTo(110, 97);
        ctx.lineTo(114, 91);
        ctx.moveTo(102, 100);
        ctx.lineTo(102, 107);
        ctx.moveTo(110, 100);
        ctx.lineTo(110, 108);
        ctx.moveTo(118, 100);
        ctx.lineTo(118, 107);
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        break;

      case 'eye':
        fillStroke(c => {
          c.moveTo(62, 72);
          c.quadraticCurveTo(89, 48, 123, 42);
          c.quadraticCurveTo(150, 45, 161, 72);
          c.quadraticCurveTo(146, 96, 122, 102);
          c.quadraticCurveTo(89, 105, 62, 72);
          c.closePath();
        });
        ctx.beginPath();
        ctx.arc(113, 72, 19, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(113, 72, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,246,226,0.9)';
        ctx.beginPath();
        ctx.arc(107, 66, 2.4, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'raven':
        fillStroke(c => {
          c.moveTo(74, 96);
          c.bezierCurveTo(66, 82, 70, 64, 86, 54);
          c.bezierCurveTo(100, 46, 118, 48, 130, 58);
          c.lineTo(152, 52);
          c.lineTo(138, 66);
          c.bezierCurveTo(142, 76, 138, 88, 126, 92);
          c.lineTo(134, 108);
          c.lineTo(112, 94);
          c.lineTo(88, 100);
          c.closePath();
        });
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(122, 64, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = style.line;
        ctx.beginPath();
        ctx.moveTo(86, 54);
        ctx.quadraticCurveTo(104, 62, 108, 82);
        ctx.globalAlpha = 0.45;
        ctx.stroke();
        ctx.globalAlpha = 1;
        break;

      case 'drop':
        fillStroke(c => {
          c.moveTo(110, 42);
          c.bezierCurveTo(122, 60, 132, 72, 132, 86);
          c.bezierCurveTo(132, 100, 122, 110, 110, 110);
          c.bezierCurveTo(98, 110, 88, 100, 88, 86);
          c.bezierCurveTo(88, 72, 98, 60, 110, 42);
          c.closePath();
        });
        ctx.strokeStyle = style.line;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(78, 118);
        ctx.quadraticCurveTo(94, 112, 110, 118);
        ctx.quadraticCurveTo(126, 124, 142, 118);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.ellipse(104, 82, 5, 9, -0.3, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'claw':
        fillStroke(c => {
          c.moveTo(76, 102);
          c.bezierCurveTo(69, 94, 67, 80, 73, 71);
          c.lineTo(82, 58);
          c.bezierCurveTo(84, 55, 89, 57, 88, 61);
          c.lineTo(85, 72);
          c.lineTo(100, 43);
          c.bezierCurveTo(102, 40, 107, 42, 106, 46);
          c.lineTo(98, 72);
          c.lineTo(112, 50);
          c.bezierCurveTo(114, 47, 119, 50, 118, 54);
          c.lineTo(109, 77);
          c.lineTo(120, 64);
          c.bezierCurveTo(123, 61, 127, 65, 125, 68);
          c.lineTo(110, 93);
          c.bezierCurveTo(105, 101, 95, 106, 85, 102);
          c.closePath();
        });
        ctx.beginPath();
        ctx.moveTo(78, 94);
        ctx.quadraticCurveTo(95, 101, 112, 94);
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        break;

      case 'blade':
        fillStroke(c => {
          c.moveTo(64, 112);
          c.lineTo(142, 30);
          c.lineTo(150, 22);
          c.lineTo(155, 27);
          c.lineTo(147, 35);
          c.lineTo(69, 117);
          c.closePath();
        });
        ctx.beginPath();
        ctx.moveTo(136, 26);
        ctx.lineTo(150, 16);
        ctx.lineTo(147, 34);
        ctx.moveTo(70, 98);
        ctx.lineTo(56, 112);
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(64, 112);
        ctx.lineTo(72, 110);
        ctx.lineTo(66, 104);
        ctx.closePath();
        ctx.fill();
        break;

      case 'key':
        fillStroke(c => {
          c.arc(90, 66, 22, 0, Math.PI * 2);
        }, false);
        ctx.beginPath();
        ctx.arc(90, 66, 9, 0, Math.PI * 2);
        ctx.moveTo(108, 78);
        ctx.lineTo(158, 128);
        ctx.moveTo(142, 112);
        ctx.lineTo(154, 100);
        ctx.moveTo(152, 122);
        ctx.lineTo(164, 110);
        ctx.stroke();
        break;

      case 'tome':
        fillStroke(c => {
          c.moveTo(62, 42);
          c.lineTo(110, 28);
          c.lineTo(158, 42);
          c.lineTo(158, 108);
          c.lineTo(110, 94);
          c.lineTo(62, 108);
          c.closePath();
        });
        ctx.beginPath();
        ctx.moveTo(110, 28);
        ctx.lineTo(110, 94);
        ctx.moveTo(72, 48);
        ctx.lineTo(100, 56);
        ctx.moveTo(72, 62);
        ctx.lineTo(100, 70);
        ctx.moveTo(120, 56);
        ctx.lineTo(148, 48);
        ctx.moveTo(120, 70);
        ctx.lineTo(148, 62);
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        this.starPath(ctx, 110, 68, 14, 5.5);
        ctx.fill();
        break;

      case 'candle':
        ctx.beginPath();
        ctx.moveTo(95, 112);
        ctx.lineTo(95, 58);
        ctx.lineTo(125, 58);
        ctx.lineTo(125, 112);
        ctx.moveTo(88, 112);
        ctx.lineTo(132, 112);
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(110, 46);
        ctx.bezierCurveTo(103, 38, 106, 29, 110, 23);
        ctx.bezierCurveTo(115, 30, 118, 38, 110, 46);
        ctx.fill();
        ctx.strokeStyle = style.line;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(110, 30);
        ctx.bezierCurveTo(97, 40, 101, 58, 110, 64);
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        break;

      case 'vessel':
        fillStroke(c => {
          c.moveTo(92, 46);
          c.lineTo(128, 46);
          c.lineTo(124, 58);
          c.bezierCurveTo(138, 68, 142, 82, 140, 96);
          c.bezierCurveTo(138, 108, 128, 114, 110, 114);
          c.bezierCurveTo(92, 114, 82, 108, 80, 96);
          c.bezierCurveTo(78, 82, 82, 68, 96, 58);
          c.closePath();
        });
        ctx.beginPath();
        ctx.moveTo(88, 46);
        ctx.lineTo(132, 46);
        ctx.moveTo(96, 38);
        ctx.lineTo(124, 38);
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(110, 74);
        ctx.bezierCurveTo(104, 80, 104, 88, 110, 92);
        ctx.bezierCurveTo(116, 88, 116, 80, 110, 74);
        ctx.fill();
        break;

      case 'ring':
        fillStroke(c => {
          c.arc(110, 70, 30, 0, Math.PI * 2);
        });
        ctx.beginPath();
        ctx.arc(110, 70, 23, 0, Math.PI * 2);
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(110, 44);
        ctx.lineTo(117, 56);
        ctx.lineTo(103, 56);
        ctx.closePath();
        ctx.fill();
        break;

      case 'serpent':
        fillStroke(c => {
          c.moveTo(74, 104);
          c.bezierCurveTo(60, 94, 62, 78, 78, 72);
          c.bezierCurveTo(98, 65, 122, 74, 130, 88);
          c.bezierCurveTo(136, 100, 128, 110, 116, 110);
          c.bezierCurveTo(102, 110, 96, 98, 104, 90);
          c.bezierCurveTo(112, 83, 126, 86, 130, 96);
        }, false);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(130, 96, 3, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'house':
        fillStroke(c => {
          c.moveTo(72, 112);
          c.lineTo(72, 58);
          c.lineTo(110, 34);
          c.lineTo(148, 58);
          c.lineTo(148, 112);
          c.closePath();
        });
        ctx.beginPath();
        ctx.moveTo(92, 112);
        ctx.lineTo(92, 86);
        ctx.quadraticCurveTo(92, 74, 110, 74);
        ctx.quadraticCurveTo(128, 74, 128, 86);
        ctx.lineTo(128, 112);
        ctx.moveTo(82, 66);
        ctx.lineTo(138, 66);
        ctx.moveTo(110, 34);
        ctx.lineTo(110, 52);
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        break;
    }
  }

  private static starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number): void {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = (Math.PI / 5) * i - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /* ---------------------------------------------------------------------- */
  /* Description panel, chips, footer                                        */
  /* ---------------------------------------------------------------------- */

  private static paintDescription(ctx: CanvasRenderingContext2D, face: CardFace, style: PlateStyle): void {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(40, 486, 432, 220, 10);
    ctx.fillStyle = 'rgba(4,4,4,0.78)';
    ctx.fill();
    ctx.strokeStyle = style.line;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Gold tick in the top-left corner of the panel.
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(52, 500);
    ctx.lineTo(76, 500);
    ctx.moveTo(52, 500);
    ctx.lineTo(52, 520);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = style.inkDim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `500 19px ${CANVAS_FONT_STACK}`;

    let lines = this.wrapText(ctx, face.desc ?? '', 384);
    if (lines.length > 8) {
      ctx.font = `500 16px ${CANVAS_FONT_STACK}`;
      lines = this.wrapText(ctx, face.desc ?? '', 396);
    }
    lines.slice(0, 9).forEach((line, i) => { ctx.fillText(line, 66, 512 + i * 22); });
    ctx.restore();
  }

  private static paintChips(ctx: CanvasRenderingContext2D, face: CardFace, style: PlateStyle): void {
    // Splendor-style cost pips, kept off the medallion.
    if (face.cost) {
      const gemColors: Record<string, string> = {
        diamond: '#d9e2e8',
        sapphire: '#2f6fc0',
        emerald: '#2f7d49',
        ruby: '#b3261e',
        onyx: '#2b2b2b'
      };
      const entries = Object.entries(face.cost).filter(([, v]) => v > 0);
      let cy = 210;
      for (const [gem, req] of entries) {
        ctx.beginPath();
        ctx.arc(74, cy, 19, 0, Math.PI * 2);
        ctx.fillStyle = gemColors[gem] ?? '#6b7280';
        ctx.fill();
        ctx.strokeStyle = style.line;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = gem === 'diamond' ? '#2b2b2b' : '#ffffff';
        ctx.font = `700 20px ${CANVAS_FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${req}`, 74, cy + 1);
        cy += 44;
      }
    }

    // Victory points.
    if (typeof face.score === 'number' && face.score > 0) {
      ctx.beginPath();
      ctx.arc(438, 208, 26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(6,5,4,0.9)';
      ctx.fill();
      ctx.strokeStyle = style.accent;
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.fillStyle = style.ink;
      ctx.font = `700 26px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${face.score}`, 438, 210);
    }
  }

  private static paintSuitMarks(ctx: CanvasRenderingContext2D, face: CardFace, style: PlateStyle): void {
    if (!face.suit || !face.rank) return;
    const isRed = face.suit === '\u2665' || face.suit === '\u2666';
    const ink = isRed ? '#e0604e' : style.ink;
    ctx.save();
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `700 34px ${CANVAS_FONT_STACK}`;
    ctx.fillText(`${face.rank}`, 42, 186);
    ctx.font = '28px "Segoe UI Symbol", sans-serif';
    ctx.fillText(face.suit, 42, 220);
    ctx.textAlign = 'right';
    ctx.font = `700 34px ${CANVAS_FONT_STACK}`;
    ctx.fillText(`${face.rank}`, 470, 186);
    ctx.font = '28px "Segoe UI Symbol", sans-serif';
    ctx.fillText(face.suit, 470, 220);
    ctx.restore();
  }

  private static paintFooter(ctx: CanvasRenderingContext2D, style: PlateStyle, kind: PlateKind): void {
    ctx.save();
    const bar = ctx.createLinearGradient(18, 0, 494, 0);
    bar.addColorStop(0, `${style.accent}00`);
    bar.addColorStop(0.5, style.accent);
    bar.addColorStop(1, `${style.accent}00`);
    ctx.fillStyle = bar;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(18, 730, 476, 3);

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = style.line;
    for (const x of [232, 256, 280]) {
      ctx.beginPath();
      ctx.arc(x, 744, x === 256 ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.34;
    ctx.font = `600 11px ${CANVAS_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kind === 'RELIC' ? 'SIGILLUM' : 'DOMUS IN COLLE', 256, 717);
    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* Legacy emblems for non-Betrayal decks (gems, shields, scrolls)          */
  /* ---------------------------------------------------------------------- */

  private static drawGem(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
    const pts: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 1.05]);
    }

    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.86);
    ctx.lineTo(cx + r * 0.5, cy - r * 0.28);
    ctx.lineTo(cx, cy + r * 0.05);
    ctx.lineTo(cx - r * 0.5, cy - r * 0.28);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy - r * 0.28);
    ctx.lineTo(cx, cy + r * 0.05);
    ctx.lineTo(cx, cy + r * 0.9);
    ctx.lineTo(cx - r * 0.86, cy + r * 0.42);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,248,226,0.62)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }

  /** House sigil for decks that are not Betrayal's three card families. */
  private static drawEmblem(
    ctx: CanvasRenderingContext2D,
    type: string | undefined,
    cx: number,
    cy: number,
    color: string
  ): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'TIER_1' || type === 'TIER_2' || type === 'TIER_3') {
      this.drawGem(ctx, 0, 0, 92, color);
    } else if (type === 'BASIC') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(-54, -60);
      ctx.lineTo(50, 56);
      ctx.moveTo(54, -60);
      ctx.lineTo(-50, 56);
      ctx.stroke();
      ctx.strokeStyle = '#c9a24a';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(-66, 44);
      ctx.lineTo(-42, 70);
      ctx.moveTo(66, 44);
      ctx.lineTo(42, 70);
      ctx.stroke();
    } else if (type === 'TRICK') {
      ctx.fillStyle = '#e8dcc0';
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.roundRect(-80, -56, 160, 112, 10);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 6;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(-52, i * 26);
        ctx.lineTo(52, i * 26);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(-80, -56, 14, 0, Math.PI * 2);
      ctx.arc(80, 56, 14, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'ARMOR') {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -70);
      ctx.lineTo(64, -44);
      ctx.lineTo(56, 34);
      ctx.quadraticCurveTo(28, 68, 0, 78);
      ctx.quadraticCurveTo(-28, 68, -56, 34);
      ctx.lineTo(-64, -44);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#e6c976';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(0, -48);
      ctx.lineTo(0, 54);
      ctx.moveTo(-38, -16);
      ctx.lineTo(38, -16);
      ctx.stroke();
    } else if (type === 'NOBLE') {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-64, 36);
      ctx.lineTo(-64, -26);
      ctx.lineTo(-30, 0);
      ctx.lineTo(0, -48);
      ctx.lineTo(30, 0);
      ctx.lineTo(64, -26);
      ctx.lineTo(64, 36);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f0d38a';
      ctx.fillRect(-64, 36, 128, 12);
    } else {
      this.drawGem(ctx, 0, 0, 76, color);
    }

    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* Card back (unchanged antique leather)                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Antique Leather Grimoire Back Texture with embossed gold-foil occult crest
   * and heavy brass corner protectors.
   */
  public static getCardBackTexture(): THREE.CanvasTexture {
    if (this.backTexture) return this.backTexture;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the card back');

    // 1. Decayed Antique Leather Texture
    const grad = ctx.createRadialGradient(256, 384, 80, 256, 384, 420);
    grad.addColorStop(0, '#261219');
    grad.addColorStop(0.65, '#180a0e');
    grad.addColorStop(1, '#0c0406');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 768);

    // Leather grain & cracks (seeded, so the back never flickers between runs).
    const rnd = this.lcg(0x5eed1eaf);
    for (let i = 0; i < 3500; i++) {
      const x = rnd() * 512;
      const y = rnd() * 768;
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.035)';
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
    const drawCorner = (x: number, y: number, rot: number): void => {
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

    ctx.fillStyle = '#d9b45b';
    ctx.beginPath();
    ctx.fillRect(216, 375, 80, 48);
    ctx.fillRect(210, 345, 24, 60);
    ctx.moveTo(210, 345);
    ctx.lineTo(222, 315);
    ctx.lineTo(234, 345);
    ctx.moveTo(234, 375);
    ctx.lineTo(256, 340);
    ctx.lineTo(278, 375);
    ctx.fillRect(280, 350, 20, 55);
    ctx.moveTo(280, 350);
    ctx.lineTo(290, 325);
    ctx.lineTo(300, 350);
    ctx.fill();

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

  /* ---------------------------------------------------------------------- */
  /* Front face                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Front card face: a dark occult plate with a category composition, a
   * per-card motif, gold hairline frame and a readable description panel.
   */
  public static createCardFaceTexture(face: CardFace, isMasked = false): THREE.CanvasTexture {
    // The style version is part of the key: bumping the painter invalidates
    // every cached texture instead of silently serving the old artwork.
    const key = [
      FACE_STYLE_VERSION,
      face.title,
      face.suit ?? '',
      face.rank ?? '',
      face.type ?? '',
      face.score ?? '',
      face.desc ?? '',
      isMasked ? 'masked' : 'open',
      JSON.stringify(face.cost ?? {})
    ].join('|');
    const cached = this.faceCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the card face');

    if (isMasked) {
      this.paintMaskedFace(ctx);
      const maskedTexture = new THREE.CanvasTexture(canvas);
      maskedTexture.colorSpace = THREE.SRGBColorSpace;
      this.faceCache.set(key, maskedTexture);
      return maskedTexture;
    }

    const kind = this.plateKind(face.type);
    const style = this.styleFor(face);
    const seed = this.seedFor(face);

    this.paintGround(ctx, style);
    this.paintGrain(ctx, seed, style);
    this.paintFrame(ctx, kind, style, seed);
    this.paintHeader(ctx, face, style, kind);
    if (face.type) this.paintTypeBadge(ctx, style, this.typeLabel(face.type));
    this.paintMedallion(ctx, style, kind, face, seed);
    this.paintChips(ctx, face, style);
    this.paintSuitMarks(ctx, face, style);
    this.paintDescription(ctx, face, style);
    this.paintFooter(ctx, style, kind);
    this.paintVignette(ctx);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.faceCache.set(key, texture);
    return texture;
  }

  private static typeLabel(type: string): string {
    if (type === 'OMEN') return '预兆 · OMEN';
    if (type === 'ITEM') return '遗物 · ITEM';
    if (type === 'EVENT') return '事件 · EVENT';
    if (type === 'ROOM') return '房间 · ROOM';
    return type;
  }

  /** Face-down: the same lacquer, sealed with red wax. */
  private static paintMaskedFace(ctx: CanvasRenderingContext2D): void {
    const style = STYLES.OMEN;
    ctx.fillStyle = '#0b0809';
    ctx.fillRect(0, 0, 512, 768);

    const rnd = this.lcg(0x51e1);
    for (let i = 0; i < 1800; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(0,0,0,0.2)' : 'rgba(255,246,224,0.03)';
      ctx.fillRect(rnd() * 512, rnd() * 768, 1.8, 1.8);
    }

    const vig = ctx.createRadialGradient(256, 360, 40, 256, 360, 340);
    vig.addColorStop(0, 'rgba(120,20,30,0.5)');
    vig.addColorStop(1, 'rgba(5,8,12,0.96)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, 512, 768);

    // Gold hairline frame + corner ornaments, same language as the front.
    this.paintFrame(ctx, 'OMEN', style, { hash: 7, motif: 'eye', ringStep: 3, rays: 16, rune: 1, stains: 3 });

    // Wax seal.
    ctx.fillStyle = '#7c1420';
    ctx.beginPath();
    ctx.arc(256, 340, 84, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c42838';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,190,190,0.25)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(256, 340, 70, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#f5e4c6';
    ctx.font = 'bold 92px "Georgia", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 256, 344);

    ctx.font = `700 24px ${CANVAS_FONT_STACK}`;
    ctx.fillStyle = '#f0dfc4';
    ctx.fillText('未揭示的秘密', 256, 484);
    ctx.font = `500 15px ${CANVAS_FONT_STACK}`;
    ctx.fillStyle = 'rgba(196,168,138,0.72)';
    ctx.fillText('HIDDEN INFORMATION · 𝒪(s, i)', 256, 522);
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
   * Builds the complete card mesh with a dark lacquered rim.
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

    const faceTextureFinal = faceTextureOverride ?? (face.imageUrl ? this.loadImageTexture(face.imageUrl) : null);
    const faceTexture = faceTextureFinal || this.createCardFaceTexture(face, isMasked);
    const backTexture = backTextureOverride || this.getCardBackTexture();

    // Rim reads as the dark lacquered edge of the plate, not white paper.
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.7, metalness: 0.15 });
    const faceMat = new THREE.MeshStandardMaterial({
      map: faceTexture,
      roughness: faceTextureFinal ? 0.4 : 0.52,
      metalness: 0.06
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
