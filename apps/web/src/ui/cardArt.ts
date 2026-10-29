import { UiCardDetail } from '@rds/app/contracts';

/**
 * Dark occult plate for the card detail sheet.
 *
 * The house's cards are not paper: they are lacquered plates pulled out of a
 * Victorian cabinet — near-black grounds, tarnished gold hairlines, a candle
 * halo and a motif that reads at a glance. Two layers decide what a card looks
 * like:
 *
 *  1. **Category language** — EVENT plates fracture (sharp rays and cracks),
 *     ITEM plates stage a still life (niche, plinth, rivets), OMEN plates
 *     circle a single watching mark (concentric rings, arch, keystone).
 *  2. **Per-card motif** — the name picks a motif by keyword when it can
 *     ("骷髅万能钥匙" → skull), otherwise by a stable hash. The hash also drives
 *     the ray count, ring rotation, stains, scratches and the little corner
 *     rune, so two cards sharing a motif still never look alike.
 *
 * Everything is deterministic: the same card always yields the same plate, and
 * no external asset is ever fetched.
 */

/** Category vocabulary; anything unknown (Splendor, Sanguosha…) uses RELIC. */
type PlateKind = 'OMEN' | 'ITEM' | 'EVENT' | 'ROOM';

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

interface PlatePalette {
  /** Radial ground: centre → mid → rim. */
  ground: [string, string, string];
  /** Hairline / linework colour (also the SVG `color`, so `currentColor` works). */
  line: string;
  /** Category highlight: glows, solid marks, key strokes. */
  accent: string;
  /** Wash used to fill silhouettes so they read as relief. */
  wash: string;
}

const PALETTES: Record<PlateKind, PlatePalette> = {
  OMEN: {
    ground: ['#2b0d18', '#190710', '#080307'],
    line: '#e3c07a',
    accent: '#c9455f',
    wash: 'rgba(201,69,95,0.16)'
  },
  ITEM: {
    ground: ['#2a1c0d', '#180f07', '#070403'],
    line: '#e6c07a',
    accent: '#d9a45b',
    wash: 'rgba(217,164,91,0.13)'
  },
  EVENT: {
    ground: ['#16202c', '#0c121a', '#04070b'],
    line: '#b9c6d6',
    accent: '#8fa4bd',
    wash: 'rgba(143,164,189,0.13)'
  },
  ROOM: {
    ground: ['#231a10', '#150f09', '#060403'],
    line: '#d9c39a',
    accent: '#a8865a',
    wash: 'rgba(168,134,90,0.13)'
  }
};

/** Stable per-card numbers, all derived from the name hash. */
interface PlateSpec {
  kind: PlateKind;
  palette: PlatePalette;
  motif: Motif;
  /** 0–23: rotation step of the astrolabe ring, in 15° units. */
  ringStep: number;
  /** 12 / 16 / 20 / 24 rays for EVENT plates and tick counts for OMEN. */
  rays: number;
  /** 0–7: which corner rune this card carries. */
  rune: number;
  /** 3–5: how many age spots bleed through the lacquer. */
  stains: number;
  /** Hex tail used to keep every gradient/filter id unique per card. */
  uid: string;
  seed: number;
}

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
 * Keyword → motif, first match wins. Order is deliberate: weapons are matched
 * before hands ("老式左轮手枪" is a blade, not a claw) and skulls before keys
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

/**
 * Deterministic ink illustration for the card detail sheet.
 *
 * Landscape plate: category backdrop, medallion, per-card motif and a corner
 * rune cartouche. The title/facts live in the sheet body, so this stays purely
 * graphic and never competes with the type.
 */
export function cardArtSvg(card: UiCardDetail): string {
  const spec = plateSpec(card);
  const { palette, uid } = spec;
  const cx = 130;
  const cy = 58;

  return `
    <svg viewBox="0 0 260 120" preserveAspectRatio="xMidYMid slice" role="img"
         aria-label="${escapeXml(card.title)}" color="${palette.line}"
         style="display:block;width:100%;height:100%">
      <defs>
        <radialGradient id="cg${uid}" cx="50%" cy="42%" r="78%">
          <stop offset="0%" stop-color="${palette.ground[0]}" />
          <stop offset="62%" stop-color="${palette.ground[1]}" />
          <stop offset="100%" stop-color="${palette.ground[2]}" />
        </radialGradient>
        <radialGradient id="ch${uid}" cx="50%" cy="46%" r="50%">
          <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0.34" />
          <stop offset="55%" stop-color="${palette.accent}" stop-opacity="0.1" />
          <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="cv${uid}" cx="50%" cy="48%" r="72%">
          <stop offset="52%" stop-color="#000" stop-opacity="0" />
          <stop offset="100%" stop-color="#000" stop-opacity="0.72" />
        </radialGradient>
      </defs>

      <rect width="260" height="120" fill="url(#cg${uid})" />
      ${grain(spec)}
      ${categoryBackdrop(spec, cx, cy)}
      <rect width="260" height="120" fill="url(#cv${uid})" />
      ${frame(spec)}
      ${medallion(spec, cx, cy)}
      <g transform="translate(${cx} ${cy}) scale(0.62) translate(-110 -70)" stroke-width="2.4"
         fill="none" stroke="${palette.line}" stroke-linecap="round" stroke-linejoin="round">
        ${motifMarkup(spec.motif, palette)}
      </g>
      ${runeCartouche(spec)}
    </svg>
  `;
}

/* -------------------------------------------------------------------------- */
/* Spec derivation                                                             */
/* -------------------------------------------------------------------------- */

function plateSpec(card: UiCardDetail): PlateSpec {
  const kind = plateKind(card.kind);
  const seed = fnv1a(`${card.kind}|${card.title}|${card.en ?? ''}`);
  const nameText = `${card.title} ${card.en ?? ''}`.toLowerCase();
  return {
    kind,
    palette: PALETTES[kind],
    motif: motifFor(nameText, seed),
    ringStep: seed % 24,
    rays: 12 + (seed % 4) * 4,
    rune: (seed >>> 3) % 8,
    stains: 3 + ((seed >>> 7) % 3),
    uid: (seed % 1679616).toString(36),
    seed
  };
}

function plateKind(kind: string): PlateKind {
  if (kind === 'OMEN' || kind === 'ITEM' || kind === 'EVENT' || kind === 'ROOM') return kind;
  return 'ITEM';
}

function motifFor(text: string, seed: number): Motif {
  for (const [motif, pattern] of MOTIF_KEYWORDS) {
    if (pattern.test(text)) return motif;
  }
  return MOTIF_ORDER[seed % MOTIF_ORDER.length];
}

/* -------------------------------------------------------------------------- */
/* Deterministic noise                                                         */
/* -------------------------------------------------------------------------- */

function fnv1a(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small LCG so every derived position is reproducible from the name hash. */
function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Lacquer grain: fine dust, then a few long scratches and blood specks. */
function grain(spec: PlateSpec): string {
  const rnd = lcg(spec.seed ^ 0x9e3779b9);
  const parts: string[] = [];

  for (let i = 0; i < 46; i++) {
    const x = rnd() * 260;
    const y = rnd() * 120;
    const r = 0.4 + rnd() * 0.9;
    const a = 0.04 + rnd() * 0.07;
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#fff" opacity="${a.toFixed(3)}" />`);
  }

  for (let i = 0; i < 5; i++) {
    const x = 12 + rnd() * 230;
    const y = 10 + rnd() * 100;
    const len = 10 + rnd() * 26;
    const tilt = (rnd() - 0.5) * 14;
    parts.push(
      `<path d="M${x.toFixed(1)} ${y.toFixed(1)}l${len.toFixed(1)} ${tilt.toFixed(1)}" stroke="#fff" stroke-width="0.5" opacity="0.09" fill="none" />`
    );
  }

  for (let i = 0; i < spec.stains; i++) {
    const x = 20 + rnd() * 220;
    const y = 16 + rnd() * 88;
    const r = 3 + rnd() * 9;
    parts.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${r.toFixed(1)}" ry="${(r * 0.62).toFixed(1)}" fill="${spec.palette.accent}" opacity="0.07" />`);
  }

  return `<g>${parts.join('')}</g>`;
}

/* -------------------------------------------------------------------------- */
/* Category composition                                                        */
/* -------------------------------------------------------------------------- */

function categoryBackdrop(spec: PlateSpec, cx: number, cy: number): string {
  if (spec.kind === 'EVENT') return eventFracture(spec, cx, cy);
  if (spec.kind === 'OMEN') return omenAstrolabe(spec, cx, cy);
  return relicStillLife(spec, cx, cy);
}

/** EVENT — the plate has been struck: sharp rays and running cracks. */
function eventFracture(spec: PlateSpec, cx: number, cy: number): string {
  const rnd = lcg(spec.seed ^ 0x51ed2701);
  const rays: string[] = [];
  for (let i = 0; i < spec.rays; i++) {
    const angle = (Math.PI * 2 * i) / spec.rays + (rnd() - 0.5) * 0.12;
    const inner = 34 + rnd() * 6;
    const outer = inner + 18 + rnd() * 30;
    const midR = (inner + outer) / 2;
    const bend = (rnd() - 0.5) * 0.22;
    const x1 = cx + Math.cos(angle) * inner;
    const y1 = cy + Math.sin(angle) * inner * 0.82;
    const xm = cx + Math.cos(angle + bend) * midR;
    const ym = cy + Math.sin(angle + bend) * midR * 0.82;
    const x2 = cx + Math.cos(angle) * outer;
    const y2 = cy + Math.sin(angle) * outer * 0.82;
    const opacity = 0.16 + rnd() * 0.3;
    rays.push(
      `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${xm.toFixed(1)} ${ym.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}" opacity="${opacity.toFixed(2)}" />`
    );
  }

  const cracks: string[] = [];
  for (let c = 0; c < 3; c++) {
    const angle = rnd() * Math.PI * 2;
    let x = cx + Math.cos(angle) * 30;
    let y = cy + Math.sin(angle) * 26;
    let path = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    for (let step = 0; step < 4; step++) {
      x += Math.cos(angle + (rnd() - 0.5) * 0.8) * 20;
      y += Math.sin(angle + (rnd() - 0.5) * 0.8) * 16;
      path += `L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    cracks.push(`<path d="${path}" stroke-width="1.1" opacity="0.34" />`);
  }

  return `
    <g fill="none" stroke="${spec.palette.accent}" stroke-linecap="round" stroke-linejoin="round">
      ${rays.join('')}
      ${cracks.join('')}
    </g>
    <ellipse cx="${cx}" cy="${cy}" rx="118" ry="54" fill="url(#ch${spec.uid})" opacity="0.55" />
  `;
}

/** ITEM — a still life: niche, plinth and rivets, like a cabinet display. */
function relicStillLife(spec: PlateSpec, cx: number, cy: number): string {
  const rnd = lcg(spec.seed ^ 0x27d4eb2f);
  const rivets: string[] = [];
  for (const [x, y] of [
    [16, 16],
    [244, 16],
    [16, 104],
    [244, 104]
  ] as [number, number][]) {
    rivets.push(`<circle cx="${x}" cy="${y}" r="2.1" fill="${spec.palette.accent}" opacity="0.55" stroke="none" />`);
    rivets.push(`<circle cx="${x}" cy="${y}" r="4.4" fill="none" stroke="currentColor" stroke-width="0.7" opacity="0.4" />`);
  }

  const motes: string[] = [];
  for (let i = 0; i < 4; i++) {
    const x = 40 + rnd() * 180;
    const y = 24 + rnd() * 50;
    motes.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.6 + rnd()).toFixed(1)}" fill="currentColor" opacity="0.22" stroke="none" />`);
  }

  return `
    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <path d="M84 98V58c0-20 18-30 46-30s46 10 46 30v40" opacity="0.2" stroke-width="1" />
      <path d="M46 100h168" opacity="0.34" stroke-width="1.2" />
      <path d="M60 100v9M200 100v9" opacity="0.24" stroke-width="1.2" />
    </g>
    <ellipse cx="${cx}" cy="98" rx="52" ry="6" fill="#000" opacity="0.55" />
    <ellipse cx="${cx}" cy="${cy}" rx="60" ry="42" fill="url(#ch${spec.uid})" opacity="0.6" />
    <g>${rivets.join('')}${motes.join('')}</g>
  `;
}

/** OMEN — an astrolabe: concentric rings, tick marks, a pointed arch. */
function omenAstrolabe(spec: PlateSpec, cx: number, cy: number): string {
  const ticks: string[] = [];
  const count = spec.rays;
  const rotation = (spec.ringStep * Math.PI) / 12;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + rotation;
    const major = i % 4 === 0;
    const r0 = major ? 44 : 47;
    const r1 = 53;
    ticks.push(
      `<path d="M${(cx + Math.cos(angle) * r0).toFixed(1)} ${(cy + Math.sin(angle) * r0 * 0.86).toFixed(1)}L${(
        cx + Math.cos(angle) * r1
      ).toFixed(1)} ${(cy + Math.sin(angle) * r1 * 0.86).toFixed(1)}" stroke-width="${major ? 1.2 : 0.7}" opacity="${
        major ? 0.6 : 0.34
      }" />`
    );
  }

  return `
    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <ellipse cx="${cx}" cy="${cy}" rx="56" ry="47" opacity="0.2" stroke-width="1" />
      <ellipse cx="${cx}" cy="${cy}" rx="40" ry="34" opacity="0.3" stroke-width="1" />
      <path d="M64 104c0-30 20-50 66-66 46 16 66 36 66 66" opacity="0.28" stroke-width="1.1" />
      ${ticks.join('')}
    </g>
    <path d="M${cx} 6l6 7-6 7-6-7Z" fill="${spec.palette.accent}" opacity="0.6" stroke="none" />
    <ellipse cx="${cx}" cy="${cy}" rx="62" ry="46" fill="url(#ch${spec.uid})" opacity="0.7" />
  `;
}

/* -------------------------------------------------------------------------- */
/* Frame                                                                       */
/* -------------------------------------------------------------------------- */

function frame(spec: PlateSpec): string {
  const accent = spec.palette.accent;
  const corners = cornerOrnament(spec.kind, spec.palette.line, accent);
  const dash = spec.kind === 'EVENT' ? ' stroke-dasharray="22 7"' : '';

  return `
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3.5" y="3.5" width="253" height="113" rx="4" stroke="currentColor" stroke-width="1.1" opacity="0.5"${dash} />
      <rect x="7.5" y="7.5" width="245" height="105" rx="3" stroke="${accent}" stroke-width="0.7" opacity="0.32" />
      <rect x="9" y="9" width="242" height="102" rx="3" stroke="#000" stroke-width="1.6" opacity="0.35" />
    </g>
    ${corners}
  `;
}

function cornerOrnament(kind: PlateKind, line: string, accent: string): string {
  const at = (x: number, y: number, rotate: number): string => {
    if (kind === 'EVENT') {
      // Sharp chevrons — nothing soft survives the fracture.
      return `<g transform="translate(${x} ${y}) rotate(${rotate})" fill="none" stroke="${line}" stroke-width="1.1" opacity="0.6">
        <path d="M0 12L9 9L12 0" /><path d="M4 15L12 12L15 4" opacity="0.5" />
      </g>`;
    }
    if (kind === 'OMEN') {
      // Rosette: a watching dot inside a ring of petals.
      return `<g transform="translate(${x} ${y}) rotate(${rotate})" fill="none" stroke="${line}" stroke-width="0.9" opacity="0.55">
        <circle cx="9" cy="9" r="6.4" /><circle cx="9" cy="9" r="2" fill="${accent}" stroke="none" />
        <path d="M9 0v3M9 15v3M0 9h3M15 9h3" opacity="0.7" />
      </g>`;
    }
    // Relic / room: a small brass filigree corner bracket.
    return `<g transform="translate(${x} ${y}) rotate(${rotate})" fill="none" stroke="${line}" stroke-width="1" opacity="0.55">
      <path d="M0 16V5c0-3 2-5 5-5h11" /><path d="M0 10c5 0 8-3 8-8" opacity="0.6" />
      <circle cx="5.4" cy="5.4" r="1.4" fill="${accent}" stroke="none" />
    </g>`;
  };

  return [at(3, 3, 0), at(257, 3, 90), at(257, 117, 180), at(3, 117, 270)].join('');
}

/* -------------------------------------------------------------------------- */
/* Medallion + corner rune                                                     */
/* -------------------------------------------------------------------------- */

function medallion(spec: PlateSpec, cx: number, cy: number): string {
  const { accent, line } = spec.palette;
  return `
    <g fill="none" stroke-linecap="round">
      <circle cx="${cx}" cy="${cy}" r="42" fill="none" stroke="${line}" stroke-width="1" opacity="0.45" />
      <circle cx="${cx}" cy="${cy}" r="36" fill="rgba(4,3,3,0.55)" stroke="${accent}" stroke-width="0.8" opacity="0.8" />
      <circle cx="${cx}" cy="${cy}" r="33" stroke="${line}" stroke-width="0.5" opacity="0.3" />
    </g>
  `;
}

/** Eight little runes; the hash picks one so cards stay distinguishable. */
function runeCartouche(spec: PlateSpec): string {
  const x = 226;
  const y = 96;
  const { line, accent } = spec.palette;
  const runes = [
    'M-3 -6v12M-3 0l6-5M-3 0l6 5',
    'M0 -5a5 5 0 100 10a5 5 0 100-10M0 -1.4a1.4 1.4 0 100 2.8a1.4 1.4 0 100-2.8',
    'M0 -6l5.2 9h-10.4ZM-3 3v4M3 3v4',
    'M0 -6v12M-5 -1h10M-3.4 3h6.8',
    'M-5 -5l4 5-4 5M1 -5l4 5-4 5',
    'M-4 -4h8v8h-8ZM-1 -1h2v2h-2Z',
    'M-5 -4h10M-5 0h10M-5 4h10',
    'M0 -6v12M-4 -2l4-4 4 4'
  ];

  return `
    <g transform="translate(${x} ${y})" fill="none" stroke="${line}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M0 -11L9.5 -5.5v11L0 11l-9.5-5.5v-11Z" stroke-width="0.9" opacity="0.5" />
      <path d="M0 -8.5L7.3 -4.2v8.4L0 8.5l-7.3-4.3v-8.4Z" stroke="${accent}" stroke-width="0.6" opacity="0.4" />
      <path d="${runes[spec.rune]}" stroke-width="1.1" opacity="0.85" />
    </g>
  `;
}

/* -------------------------------------------------------------------------- */
/* Motifs — drawn in a 220×140 box centred on (110, 70)                       */
/* -------------------------------------------------------------------------- */

function motifMarkup(motif: Motif, palette: PlatePalette): string {
  switch (motif) {
    case 'skull':
      return motifSkull(palette);
    case 'eye':
      return motifEye(palette);
    case 'raven':
      return motifRaven(palette);
    case 'claw':
      return motifClaw(palette);
    case 'drop':
      return motifDrop(palette);
    case 'blade':
      return motifBlade(palette);
    case 'key':
      return motifKey(palette);
    case 'tome':
      return motifTome(palette);
    case 'candle':
      return motifCandle(palette);
    case 'vessel':
      return motifVessel(palette);
    case 'ring':
      return motifRing(palette);
    case 'serpent':
      return motifSerpent(palette);
    case 'house':
      return motifHouse(palette);
  }
}

function motifSkull(p: PlatePalette): string {
  return `
    <path d="M78 86c-9-8-12-20-6-31 7-13 22-19 38-17 17 2 29 12 31 26 2 12-3 20-11 26-4 3-5 7-4 12H85c1-6 0-11-7-16Z" fill="${p.wash}" />
    <path d="M91 84c0-12 8-20 19-20s19 8 19 20" opacity="0.85" />
    <path d="M85 88h42M91 104h31" opacity="0.5" />
    <ellipse cx="99" cy="80" rx="5" ry="6.4" fill="${p.accent}" stroke="none" opacity="0.9" />
    <ellipse cx="121" cy="80" rx="5" ry="6.4" fill="${p.accent}" stroke="none" opacity="0.9" />
    <path d="M106 91l4 6 4-6M102 100v7M110 100v8M118 100v7" opacity="0.7" />
  `;
}

function motifEye(p: PlatePalette): string {
  return `
    <path d="M62 72c18-24 42-33 61-30 17 3 30 14 38 30-15 24-39 35-64 30-15-3-27-13-35-30Z" fill="${p.wash}" />
    <circle cx="113" cy="72" r="19" />
    <circle cx="113" cy="72" r="8" fill="${p.accent}" stroke="none" opacity="0.85" />
    <circle cx="107" cy="66" r="2.4" fill="#fff6e2" stroke="none" opacity="0.9" />
    <path d="M70 72l-8-13M156 72l9-14M78 62l-4-16M149 62l6-17" opacity="0.55" />
  `;
}

function motifRaven(p: PlatePalette): string {
  return `
    <path d="M74 96c-8-14-4-32 12-42 14-8 32-6 44 4l22-6-14 14c4 10 0 22-12 26l8 16-22-14-24 6Z" fill="${p.wash}" />
    <path d="M86 54c12 5 20 16 22 28" opacity="0.45" />
    <circle cx="122" cy="64" r="2.4" fill="${p.accent}" stroke="none" />
  `;
}

function motifDrop(p: PlatePalette): string {
  return `
    <path d="M110 42c12 18 22 30 22 44 0 14-10 24-22 24s-22-10-22-24c0-14 10-26 22-44Z" fill="${p.wash}" />
    <path d="M78 118c10-6 22-6 32 0s22 6 32 0" opacity="0.5" />
    <ellipse cx="104" cy="82" rx="5" ry="9" transform="rotate(-18 104 82)" fill="${p.accent}" stroke="none" opacity="0.85" />
  `;
}

function motifClaw(p: PlatePalette): string {
  return `
    <path d="M76 102c-7-8-9-22-3-31l9-13c2-3 7-1 6 3l-3 11 15-29c2-3 7-1 6 3l-8 26 14-22c2-3 7 0 6 4l-9 23 11-13c3-3 7 1 5 4l-15 25c-5 8-15 13-25 9-6-2-10-8-9-10Z" fill="${p.wash}" />
    <path d="M78 94c9 7 24 8 34 0M90 70l4 24M102 66l2 28M113 70l-2 22" opacity="0.55" />
  `;
}

function motifBlade(p: PlatePalette): string {
  return `
    <path d="M64 112L142 30l8-8 5 5-8 8-78 82Z" fill="${p.wash}" />
    <path d="M136 26l14-10-3 18M70 98l-14 14M78 84l10 9M88 72l10 9M98 62l9 9" />
    <path d="M64 112l8-2-6-6Z" fill="${p.accent}" stroke="none" opacity="0.9" />
  `;
}

function motifKey(p: PlatePalette): string {
  return `
    <circle cx="90" cy="66" r="22" fill="${p.wash}" />
    <circle cx="90" cy="66" r="9" />
    <path d="M108 78l50 50M142 112l12-12M152 122l12-12" />
    <path d="M74 50l-6-10M102 52l8-9M80 82l-9 7" opacity="0.5" />
  `;
}

function motifTome(p: PlatePalette): string {
  return `
    <path d="M62 42l48-14 48 14v66l-48-14-48 14Z" fill="${p.wash}" />
    <path d="M110 28v80M72 48l28 8M72 62l28 8M120 56l28-8M120 70l28-8" opacity="0.7" />
    <circle cx="110" cy="68" r="12" opacity="0.5" />
    <path d="M110 56l4 8 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1Z" fill="${p.accent}" stroke="none" opacity="0.75" />
  `;
}

function motifCandle(p: PlatePalette): string {
  return `
    <path d="M95 112V58h30v54M88 112h44" />
    <path d="M110 46c-7-8-4-17 0-23 5 7 8 15 0 23Z" fill="${p.accent}" stroke="none" opacity="0.85" />
    <path d="M110 30c-13 10-9 28 0 34M98 70l5-5M118 77l6-6" opacity="0.5" />
    <path d="M88 112l-10 8M132 112l10 8" opacity="0.4" />
  `;
}

function motifVessel(p: PlatePalette): string {
  return `
    <path d="M92 46h36l-4 12c14 10 18 24 16 38-2 12-12 18-30 18s-28-6-30-18c-2-14 2-28 16-38Z" fill="${p.wash}" />
    <path d="M88 46h44M96 38h28l-2 8M92 38h36" />
    <path d="M110 74c-6 6-6 14 0 18 6-4 6-12 0-18Z" fill="${p.accent}" stroke="none" opacity="0.75" />
    <path d="M86 92c12 5 36 5 48 0" opacity="0.5" />
  `;
}

function motifRing(p: PlatePalette): string {
  return `
    <circle cx="110" cy="70" r="30" fill="${p.wash}" />
    <circle cx="110" cy="70" r="30" />
    <circle cx="110" cy="70" r="23" opacity="0.5" />
    <path d="M110 44l7 12h-14Z" fill="${p.accent}" stroke="none" opacity="0.9" />
    <path d="M110 40v-8M110 108v-8M80 70h-8M148 70h-8" opacity="0.6" />
  `;
}

function motifSerpent(p: PlatePalette): string {
  return `
    <path d="M74 104c-14-10-12-26 4-32 20-7 44 2 52 16 6 12-2 22-14 22-14 0-20-12-12-20 8-7 22-4 26 6" fill="${p.wash}" />
    <circle cx="130" cy="96" r="3" fill="${p.accent}" stroke="none" />
    <path d="M136 92l9-3-6 8" opacity="0.8" />
    <path d="M84 66l-6-8M104 60l2-9M124 62l6-8" opacity="0.45" />
  `;
}

function motifHouse(p: PlatePalette): string {
  return `
    <path d="M72 112V58l38-24 38 24v54" fill="${p.wash}" />
    <path d="M92 112V86c0-8 8-12 18-12s18 4 18 12v26" />
    <path d="M82 66h56M110 34v18" opacity="0.6" />
    <path d="M60 112h100" opacity="0.5" />
    <circle cx="120" cy="98" r="1.6" fill="${p.accent}" stroke="none" />
    <path d="M70 54l-6-8M150 54l6-8" opacity="0.5" />
  `;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, char => {
    const map: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
    return map[char];
  });
}
