import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Entity, MapGraphNode, ProjectedGameState } from '@rds/kernel/types';
import { TransactionalAnimationQueue } from './animationQueue';
import { BoardRaycaster, InteractiveObjectData } from './raycaster';
import { CardMeshBuilder } from './procedural/cardMesh';
import { ChipMeshBuilder } from './procedural/chipMesh';
import { SeatPlateBuilder, type WoodKind } from './procedural/seatPlate';
import { pokemonCardBackTexture, pokemonCardTexture } from './procedural/pokemonAssets';
import { DiceMeshBuilder } from './procedural/diceMesh';
import { HexTileBuilder } from './procedural/hexTile';
import { RoomTileBuilder } from './procedural/roomTile';
import { TokenMeshBuilder } from './procedural/tokenMesh';
import { GameTableBuilder, TABLE_SIZE } from './table';
import { ObjectTemplateCache, signatureOf } from './objectCache';
import { createDefaultProjectionRegistry, ProjectionRegistry } from './projectionPort';
import { LabelOverlay, WorldLabel } from './labels/labelOverlay';
import { ScreenRect } from './labels/labelLayout';
import { buildCardGroups } from './cardGroups';
import { cardGroupKey } from './cardGroups';
import { PresentationPhysics } from './physics';
import { BoardGameAudio } from './audio';
import { CANVAS_FONT_STACK } from './fonts';
import { handLayout, handRowSpan } from '../ui/handLayout';
import { BOARD_ROW_PITCH, boardCardPosition, boardRowFrame, type ViewerBearing } from './boardFacing';
import {
  DEALER_LIFT,
  dealerAreaYaw,
  dealerBobOffset,
  shortestAngleDelta
} from './dealerArea';

export type CameraPreset = 'ISOMETRIC' | 'TOP_DOWN' | 'PLAYER_1' | 'PLAYER_2' | 'SEAT';

/**
 * Parts of the canvas covered by the shell, in CSS pixels.
 *
 * The renderer owns no UI knowledge: the HUD measures its own drawers/dock and
 * hands these four plain numbers over. Camera framing keeps the board centred in
 * the remaining rectangle while the canvas itself still renders full-bleed.
 */
export interface ViewportInsets {
  left: number;
  right: number;
  bottom: number;
  top: number;
  /**
   * Height of the bottom action dock in CSS pixels, or 0 when no dock is
   * painted. `bottom` is only sent while the dock is open; the camera-attached
   * hand needs the persistent desktop dock too, so the HUD publishes its
   * measured height separately.
   */
  dockHeight?: number;
}

/* ---------------------------------------------------------------------- */
/* Hand row geometry                                                       */
/* ---------------------------------------------------------------------- */

/**
 * World width of one hand row. This is the "container width" the fisheye
 * layout normalises against, so it is the hard budget: however many cards a
 * player holds, they are spread over exactly this strip in front of the seat.
 */
const HAND_ROW_SPAN = 9.6;
/**
 * Fixed distance from the seat centre outwards to a hand row.
 *
 * The depth is deliberately a constant: the old per-frame "dodge the HUD"
 * solver was removed (2026-11). The viewer's own hand is now drawn as a
 * camera-attached overlay group (see `updateCameraAttachedHand`), so nothing in
 * the render loop moves a hand row to chase a panel.
 */
const HAND_ROW_DEPTH = 2.0;
/**
 * Push applied to a plain BOARD anchor before the row is laid out. Poker anchors
 * the board at z = -0.85 precisely so that this offset lands the row on the felt;
 * keeping the constant here means the board does not move when the facing
 * capability is switched on.
 */
const BOARD_ROW_Z_OFFSET = 0.85;
/**
 * The revealed board row floats above the felt as an upright display.
 *
 * Cards stand 70° up from the table (20° off vertical) so their faces read from
 * a seated camera, hang `BOARD_ROW_HOVER_Y` above the felt — clear of the chips
 * and the seat standees — and bob on a 4 s sine (`render/dealerArea.ts`).
 *
 * The public pose is `rotation.x = −70°`: that angle is what the cards are set
 * to. The house card mesh paints its face on +Y, so a −70° X rotation on its own
 * would show the back; the row geometry carries a compensating +140° X turn so
 * the readable easel pose (face up and toward the camera) is what the viewer
 * sees at the specified −70°.
 */
const BOARD_ROW_VISUAL_TILT = (70 * Math.PI) / 180;
const BOARD_ROW_TILT = -BOARD_ROW_VISUAL_TILT;
/** Compensating turn baked into the row card geometry (see above). */
const BOARD_ROW_GEOMETRY_TILT = BOARD_ROW_VISUAL_TILT - BOARD_ROW_TILT;
/** Gap between the felt and the bottom edge of the floating row. */
const BOARD_ROW_HOVER_Y = 0.6;
/** Table height of the hand row. */
const HAND_ROW_Y = 0.13;
/**
 * The viewer's own hand is a screen-space overlay: one group placed in front of
 * the camera, sized in world units at that distance. The numbers below are the
 * only knobs; the group position is derived from the live camera each frame.
 */
const OWN_HAND_DISTANCE = 7;
/** Displayed width of one own-hand card at distance `OWN_HAND_DISTANCE`. */
const OWN_HAND_CARD_WIDTH = 0.62;
/** Card aspect (the hand mesh keeps the 1.12 : 1.68 face ratio). */
const OWN_HAND_CARD_HEIGHT = OWN_HAND_CARD_WIDTH * 1.5;
/** Maximum strip the own-hand fan may occupy, in world units at that distance. */
const OWN_HAND_MAX_SPAN = 4.6;
/**
 * Beyond the standard framing distance the overlay starts to recede as well.
 *
 * It trails the orbit by half: normal seated views keep the old seven-unit
 * attachment, while pulled-back overviews gain enough depth to shrink sooner
 * and further without letting the hand race away from the camera.
 */
const OWN_HAND_TRACK_START = 33;
const OWN_HAND_DISTANCE_TRACK = 0.5;
/** Furthest the overlay may sit from the camera, in world units. */
const OWN_HAND_MAX_DISTANCE = 17;
/** Partial compensation: screen height falls as `d ** -0.4` between the clamps. */
const OWN_HAND_SCALE_EXPONENT = 0.6;
const OWN_HAND_SCALE_MIN = 0.75;
const OWN_HAND_SCALE_MAX = 1.5;
/** Frame-rate independent damping (~0.11/frame at 60 Hz for both). */
const OWN_HAND_SCALE_DAMPING = 7;
const OWN_HAND_DISTANCE_DAMPING = 7;
/** Space between the hand's bottom edge and the dock top. */
const OWN_HAND_DOCK_GAP_PX = 14;
/** The row centre never leaves the lower half of the viewport. */
const OWN_HAND_MIN_CENTER = 0.56;
/** ...and never floats up towards the middle of the screen either. */
const OWN_HAND_MAX_CENTER = 0.74;
/** Adjacent own-hand cards overlap by 18% of their displayed width. */
const OWN_HAND_OVERLAP = 0.18;
/** Tilt added per card either side of the fan centre. */
const OWN_HAND_FAN_TILT = (2.5 * Math.PI) / 180;
/** Vertical rise of the centre card over the outer cards. */
const OWN_HAND_ARC_RISE = 0.035;
/** Hovered card enlargement and lift. */
const OWN_HAND_HOVER_SCALE = 1.12;
const OWN_HAND_HOVER_LIFT = 0.03;
/** Cut animation: gather, split and spring-back timings (milliseconds). */
const OWN_HAND_CUT_GATHER_MS = 140;
const OWN_HAND_CUT_SPLIT_MS = 70;
const OWN_HAND_CUT_RETURN_MS = 150;
/** Per-card animation stagger. */
const OWN_HAND_CUT_STAGGER_MS = 12;
/** Lift while the hand is gathered into one pile. */
const OWN_HAND_CUT_LIFT = 0.05;
/** Left/right displacement of the two cut piles. */
const OWN_HAND_CUT_SPLIT = 0.12;
/** Shadow softness / colour, kept below the card's own opacity budget. */
const OWN_HAND_SHADOW_OPACITY = 0.28;
/** Drag clearance above the first surface under the card. */
const CARD_DRAG_LIFT = 0.35;
/**
 * Tabletop card faces are 1.2× their previous printed size.
 *
 * Hand, community and discard/deck cards all derive from these constants so a
 * future size change moves every pile together instead of drifting apart.
 */
const CARD_SIZE_MULTIPLIER = 1.2;
const CARD_W = 1.35 * CARD_SIZE_MULTIPLIER;
const CARD_H = 2.0 * CARD_SIZE_MULTIPLIER;
/** Display scale of a card in the shared board row. */
const BOARD_ROW_CARD_SCALE = 0.62;
/**
 * How far a board card's centre sits above the group origin once tilted: its
 * half height projected onto the vertical axis, so the bottom edge lands on the
 * hover plane instead of sinking into the felt.
 */
const BOARD_ROW_CARD_LIFT =
  (CARD_H * BOARD_ROW_CARD_SCALE * Math.sin(BOARD_ROW_VISUAL_TILT)) / 2;
const DECK_CARD_W = 1.25 * CARD_SIZE_MULTIPLIER;
const DECK_CARD_H = 1.85 * CARD_SIZE_MULTIPLIER;
/** Base canvas font size for table labels (before the zone-label shrink). */
const TABLE_LABEL_FONT_SIZE = 52;
/** Table labels were too large after the 1.2x card pass: draw them at 60%. */
const ZONE_LABEL_SCALE = 0.6;
/**
 * Zone labels use a 2048x512 backing canvas. The extra pixels are downsampled
 * to the 0.6x footprint, so the smaller text keeps clean antialiased edges.
 */
const ZONE_LABEL_SUPERSAMPLE = 2;
const ZONE_LABEL_BASE_Y = 0.55;
/**
 * Bumped whenever the label painter changes.
 *
 * Cached label sprites are keyed by their text and styling; without this the
 * first paint after a painter edit would keep serving the old artwork until the
 * label text happened to change.
 */
const LABEL_PAINTER_VERSION = 1;
/**
 * Fixed per-role offsets (parent-local X/Y/Z) keep the three piles legible
 * instead of stacking their labels over the same centre point.
 */
const ZONE_LABEL_OFFSETS: Record<string, { x: number; y: number; z: number }> = {
  zone_deck: { x: -0.4, y: 0.2, z: -0.2 },
  zone_burn: { x: 0.3, y: 0.2, z: 0.4 },
  zone_muck: { x: 0, y: -0.22, z: 0 }
};
/** Type-level fallbacks for every non-poker draw/discard pile. */
const ZONE_LABEL_TYPE_OFFSETS: Record<string, { x: number; y: number; z: number }> = {
  DECK: { x: -0.4, y: 0.2, z: -0.2 },
  DISCARD: { x: 0, y: -0.22, z: 0 }
};
/**
 * Pot readout: sit just above the chip pile (y <= 0.45), and use the same 0.6x
 * footprint as the table labels so the 390 px seat view does not crop it.
 */
const POKER_POT_X = -0.3;
const POKER_POT_LABEL_Y = 0.33;
const POKER_POT_LABEL_SCALE = 0.6;
/**
 * Per-sync visual budget for state-derived tabletop actions. A reconnect can
 * deliver a batch of cards, chips and folds at once; the first twelve get a
 * tween and the rest land on their resting pose immediately.
 */
const TABLE_ACTION_ANIMATION_LIMIT = 12;
/** Hole-card deal flight: short enough to overlap, long enough to read. */
const DEAL_ANIMATION_MS = 320;
/** Chips keep the existing unhurried arc while the cards get the shorter beat. */
const CHIP_FLIGHT_MS = 460;
/** Folded hole cards slide to the muck and fade inside this window. */
const FOLD_ANIMATION_MS = 320;
const FOLD_STAGGER_MS = 35;
/** How long each face (avatar / current-street bet) stays on a seat beacon. */
const BEACON_FACE_MS = 2000;
/** Native hand-card mesh; the layout width below is its displayed size. */
const HAND_CARD_MESH_WIDTH = 1.12 * CARD_SIZE_MULTIPLIER;
/** World width of a hand card at layout scale 1. */
const HAND_CARD_WIDTH = 0.63 * CARD_SIZE_MULTIPLIER;
/** Total in-plane fan spread (radians) from the left card to the right one. */
const HAND_FAN_YAW = 0.5;
/** Fan angle added per card, so a two-card hand stays almost flat. */
const HAND_FAN_STEP = 0.055;
/** Per-card height step, so overlapping cards keep a stable draw order. */
const HAND_CARD_STACK_STEP = 0.0025;
/** How far the hovered card rises out of the row. */
const HAND_HOVER_LIFT = 0.09;
/** The pointer has to come this close (px) to a row before it takes focus. */
const HAND_FOCUS_BAND_PX = 160;

/** A laid-out hand row: its world frame plus the cards it owns, in order. */
interface HandRow {
  zoneId: string;
  ids: string[];
  /**
   * The seat this row belongs to and the direction leading away from the table.
   * Kept as stable metadata even for the viewer's camera-attached row, so the
   * row's logical anchor never depends on where the camera happens to be.
   */
  seatX: number;
  seatZ: number;
  outX: number;
  outZ: number;
  /** Fixed outward distance from the seat centre. */
  depth: number;
  /** Stable seat-frame anchor, independent of viewport/camera. */
  originX: number;
  originZ: number;
  axisX: number;
  axisZ: number;
  facing: number;
  /** Width of the strip this hand is laid out in (see `handRowSpan`). */
  span: number;
  /** `true` for the viewer's own hand: meshes live in `ownHandGroup`. */
  cameraAttached: boolean;
  /** Eased fisheye state: pointer position along the row (0..1) + strength. */
  focus: { x: number; strength: number };
  /** Where `focus` is heading; the pointer sets it, the loop eases towards it. */
  target: { x: number; strength: number };
}

/** One card's desk in the own-hand cut animation, captured after fan layout. */
interface OwnHandCutCard {
  id: string;
  mesh: THREE.Object3D;
  shadow?: THREE.Mesh;
  fanX: number;
  fanY: number;
  fanZ: number;
  fanRotation: number;
  delay: number;
  /** -1 for the left pile, +1 for the right pile. */
  side: -1 | 1;
}

interface OwnHandCutState {
  /** False until the expensive rebuild render has completed once. */
  warmedUp: boolean;
  /** Set after the warm-up frame; null until then. */
  startedAt: number | null;
  /** Gather + split + spring-back, including the last card's stagger. */
  duration: number;
  zoneId: string;
  cards: OwnHandCutCard[];
}

export interface PlacementPreview {
  name: string;
  position: [number, number, number];
  rotation: number;
  doors: string[];
  color: string;
  defId?: string;
  en?: string;
  floor?: string;
  col?: number;
  row?: number;
  symbol?: string;
  text?: string;
  special?: string;
  tags?: string[];
  fromRoomId?: string;
  entryDir?: string;
  connections?: {
    dir: 'N' | 'S' | 'E' | 'W' | string;
    dirZh: string;
    neighborRoomId?: string;
    neighborRoomName?: string;
    connected: boolean;
    status: 'connected' | 'blocked' | 'open';
  }[];
}

/** Presentation-only hints; the app layer supplies these, never core state. */
export interface LayoutHints {
  padding?: number;
  cameraDirection?: [number, number, number];
  minDistance?: number;
  /**
   * Capability: the shared board row turns to face the seated viewer instead of
   * keeping one fixed world bearing (see `render/boardFacing.ts`). Games that do
   * not declare it, and any camera that is not bound to a seat, keep the legacy
   * fixed-north row.
   */
  boardFacesViewer?: boolean;
}

export interface RenderStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  lastSyncMs: number;
  /** Full board rebuilds since the scene was created. */
  boardRebuilds: number;
  /** Furniture templates reused instead of rebuilt (since the last reset). */
  cachedObjects: number;
  /** Furniture templates that had to be re-run because content changed. */
  rebuiltObjects: number;
  /** Templates evicted because the board stopped asking for them. */
  evictedObjects: number;
}

/* -------------------------------------------------------------------------- */
/* Pokémon Splendor presentation tables                                       */
/* -------------------------------------------------------------------------- */

/**
 * Face-down art per deck zone, as plain URLs from `/public/pokemon/backs`.
 *
 * Declared here (instead of going through the fixture's `PKMN_CARD_BACK`) so
 * the renderer keeps drawing card backs even while the rules package is being
 * reworked. `CardMeshBuilder.loadImageTexture` caches by URL, so switching
 * between decks re-uses one texture per art file.
 */
const PKMN_BACK_URL_BY_ZONE: Record<string, string> = {
  zone_deck_s1: '/pokemon/backs/stage1.webp',
  zone_deck_s2: '/pokemon/backs/stage2.webp',
  zone_deck_s3: '/pokemon/backs/stage3.webp',
  zone_deck_rare: '/pokemon/backs/rare.webp',
  zone_deck_legend: '/pokemon/backs/legend.webp',
  zone_deck_mega: '/pokemon/backs/stage3.webp',
  zone_deck_pokemart: '/pokemon/backs/pokemart-1.png'
};

/** Same art keyed by the entity's `components.custom.pkmnTier` token. */
const PKMN_BACK_URL_BY_TIER: Record<string, string> = {
  stage1: '/pokemon/backs/stage1.webp',
  stage2: '/pokemon/backs/stage2.webp',
  stage3: '/pokemon/backs/stage3.webp',
  rare: '/pokemon/backs/rare.webp',
  legend: '/pokemon/backs/legend.webp',
  mega: '/pokemon/backs/stage3.webp',
  pmL1: '/pokemon/backs/pokemart-1.png',
  pmL2: '/pokemon/backs/pokemart-2.png',
  pmL3: '/pokemon/backs/pokemart-3.png'
};

/** Short deck captions for the count labels under each pile. */
const PKMN_DECK_LABEL: Record<string, string> = {
  zone_deck_s1: '一阶',
  zone_deck_s2: '二阶',
  zone_deck_s3: '三阶',
  zone_deck_rare: '稀有',
  zone_deck_legend: '传说',
  zone_deck_mega: 'MEGA',
  zone_deck_pokemart: '商店'
};

/** Ball colours in bank/tray order — the canonical fixture order. */
const PKMN_BALL_ORDER = ['red', 'blue', 'black', 'pink', 'yellow', 'purple'] as const;

const PKMN_BALL_TINT: Record<string, string> = {
  red: '#e53935',
  blue: '#1e88e5',
  black: '#4a4a4a',
  pink: '#ec407a',
  yellow: '#fdd835',
  purple: '#8e24aa'
};

const PKMN_BALL_LABEL: Record<string, string> = {
  red: '红',
  blue: '蓝',
  black: '黑',
  pink: '粉',
  yellow: '黄',
  purple: '紫'
};

/** The wild substitute colour: drawn with a golden halo so it reads distinct. */
const PKMN_MASTER_BALL = 'purple';

/** Cards whose bonus cannot be read are parked in this pseudo-column. */
const PKMN_NO_BONUS_COLUMN = 'none';

/**
 * Fixed deck rail on the left side of the table.
 *
 * The renderer owns the table layout (the fixture's anchors are a rules-side
 * detail and, with the new rare/legend decks, no longer hold a clean grid).
 * Stage decks form one column; the special decks sit outboard of their reveal
 * slot so no pile ever covers a face-up card.
 */
/**
 * The printed card aspect (560×747 artwork, 180×240 backs: both 0.75).
 *
 * Every Pokémon card — market, deck, tableau, rare/legend reveal — is derived
 * from this one width/height pair. A card that does not match it shows its art
 * stretched, and a pile sized differently from the card it deals reads as two
 * kinds of card instead of the same card, face down.
 */
const PKMN_CARD_W = 1.2;
const PKMN_CARD_H = PKMN_CARD_W / 0.75;
/** Deck piles share the face-up footprint but sit a touch smaller for depth. */
const PKMN_DECK_CARD_W = 1.08;
const PKMN_DECK_CARD_H = PKMN_DECK_CARD_W / 0.75;
/** Tableau cards: same aspect, reduced so a full column still fits its band. */
const PKMN_SMALL_CARD_W = 0.78;
const PKMN_SMALL_CARD_H = PKMN_SMALL_CARD_W / 0.75;

/**
 * The table reads in three bands, and every band derives its extent from the
 * card footprint so nothing can drift into its neighbour:
 *
 *     stage decks │ market grid │ ball bank
 *            ↑ each pile sits on its own market row
 *     rare │ legend  ── along the top, pile beside its revealed card
 *
 * A stage deck lives directly left of the row it feeds, so a player reads
 * "this pile dealt this row" without scanning. The two special decks sit
 * across the top: their revealed card is the point, and the pile is only the
 * reminder that four more are queued behind it.
 */
const PKMN_DECK_RAIL_X = -8.5;
const PKMN_DECK_ROW_STEP = PKMN_DECK_CARD_H + 0.5;
const PKMN_DECK_Z_TOP = 2.6;

/** Stage piles: one per market row, at the row's own depth. */
const PKMN_DECK_RAIL: Record<string, [number, number, number]> = {
  zone_deck_s1: [PKMN_DECK_RAIL_X, 0.06, PKMN_DECK_Z_TOP],
  zone_deck_s2: [PKMN_DECK_RAIL_X, 0.06, PKMN_DECK_Z_TOP - PKMN_DECK_ROW_STEP],
  zone_deck_s3: [PKMN_DECK_RAIL_X, 0.06, PKMN_DECK_Z_TOP - 2 * PKMN_DECK_ROW_STEP],
  // Special piles sit along the top band, each beside its own reveal slot.
  // The pair stays left of the market's centre line so both groups read as one
  // row, not as two islands straddling the grid.
  zone_deck_rare: [-6.4, 0.06, PKMN_DECK_Z_TOP + PKMN_DECK_ROW_STEP],
  zone_deck_legend: [-3.6, 0.06, PKMN_DECK_Z_TOP + PKMN_DECK_ROW_STEP]
  // Mega Evolution and Poké Mart piles are absent from the base game, so they
  // hold no rail slot here either. Add them back only alongside their rules.
};

/**
 * Reveal slots: the face-up special card, immediately right of its own pile.
 *
 * Reading order is left to right — pile, then the card it dealt — so the two
 * halves make one row each instead of a pile stacked on a card.
 */
const PKMN_REVEAL_RAIL: Record<string, [number, number, number]> = {
  zone_rare: [-5.15, 0.1, PKMN_DECK_Z_TOP + PKMN_DECK_ROW_STEP],
  zone_legend: [-2.35, 0.1, PKMN_DECK_Z_TOP + PKMN_DECK_ROW_STEP]
};

/**
 * Bonus colours in canonical ball order; a card whose bonus cannot be read is
 * parked in the `none` column so it never invents a new column mid-game.
 */
const PKMN_BONUS_ORDER = [...PKMN_BALL_ORDER, PKMN_NO_BONUS_COLUMN] as string[];

/** Deprecated classic Splendor gem names → ball colour. */
const PKMN_BONUS_ALIAS: Record<string, string> = {
  ruby: 'red',
  sapphire: 'blue',
  onyx: 'black',
  diamond: 'pink',
  gold: 'yellow',
  emerald: 'purple'
};

/** Extra caption for the fallback column. */
const PKMN_BONUS_LABEL_EXTRA: Record<string, string> = { [PKMN_NO_BONUS_COLUMN]: '其他' };

/**
 * Tableau bands sit along the near edge of the table, one slot per seat.
 *
 * The value is chosen so the bands land inside the default isometric framing:
 * the splendor fixture has no map nodes, so `fitCameraToBoard` has nothing to
 * fit to and the preset camera stays put — anything parked beyond z ≈ 8 falls
 * off the bottom of the viewport.
 */
const PKMN_TABLEAU_Z = 6.1;
const PKMN_TABLEAU_SLOT_WIDTH = 5.3;
/** Column pitch inside a tableau: narrower than the card so columns layer. */
const PKMN_TABLEAU_COLUMN_STEP = 0.66;
/** Distance from a tableau's centre to its buried-Pokémon pile. */
const PKMN_BURIED_OFFSET_X = 2.28;

/**
 * Market grid: four cards per tier, three tiers.
 *
 * The gutters are derived from the card footprint rather than written as
 * absolute numbers, so a card that grows cannot silently overlap its neighbour
 * (the bug this replaced: a 2.0-tall card on a 2.4 row pitch, captions
 * colliding with the row below).
 */
const PKMN_MARKET_COLUMNS = 4;
const PKMN_MARKET_X = 0.4;
/** Aligned with `PKMN_DECK_Z_TOP` so pile and row read as one line. */
const PKMN_MARKET_Z1 = PKMN_DECK_Z_TOP;
const PKMN_MARKET_PITCH_X = PKMN_CARD_W + 0.34;
const PKMN_MARKET_PITCH_Z = PKMN_CARD_H + 0.52;

/** Ease used by every phase of the own-hand cut. */
function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/**
 * FNV-1a 32-bit hash. Used for stable per-seat jitter: the standees are rebuilt
 * on every sync, so a `Math.random()` tilt would flicker.
 */
/**
 * 这个座位是否已经「准备好参与牌局」。
 *
 * 两个来源：开局前看 `globalVars.seating.ready`，每手结束后看 `hand.readyForNext`。
 * 只有准备好了，底座半圆环才点亮（白）；否则保持磨砂白。
 */
function isSeatAi(state: ProjectedGameState, seatId: string): boolean {
  const seats = state.globalVars.seats as { playerId?: string; isAi?: boolean }[] | undefined;
  return seats?.find(s => s.playerId === seatId)?.isAi === true;
}

function seatReadyForPlay(
  state: ProjectedGameState,
  hand: { street?: string; readyForNext?: string[] } | undefined,
  seatId: string
): boolean {
  const seating = state.globalVars.seating as { started?: boolean; ready?: Record<string, boolean> } | undefined;
  if (seating && !seating.started) return seating.ready?.[seatId] === true;
  if (hand?.street === 'COMPLETE') {
    return (hand.readyForNext ?? []).includes(seatId) || isSeatAi(state, seatId);
  }
  return false;
}
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class BoardGameScene {
  private static readonly _scratchNdc = new THREE.Vector2();
  private static readonly _scratchRaycaster = new THREE.Raycaster();
  private static readonly _scratchPoint = new THREE.Vector3();
  private static readonly _scratchPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.2);
  private static readonly _scratchRayOrigin = new THREE.Vector3();
  private static readonly _scratchRayDir = new THREE.Vector3(0, -1, 0);
  /** One soft radial shadow texture shared by every own-hand card. */
  private static ownHandShadowTexture?: THREE.CanvasTexture;

  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster: BoardRaycaster;
  private animQueue: TransactionalAnimationQueue;
  private projection: ProjectionRegistry = createDefaultProjectionRegistry();
  private physics = new PresentationPhysics();
  private focusLight?: THREE.PointLight;
  private lastFrameTime = performance.now();
  private readonly labels: LabelOverlay;

  // Scene entities mapping: entityId -> THREE.Object3D
  private entityMeshes = new Map<string, THREE.Object3D>();
  private nodeMeshes = new Map<string, THREE.Object3D>();
  private edgeMeshes = new Map<string, THREE.Object3D>();

  private boardObjectsGroup = new THREE.Group();
  private dragTargetGroup = new THREE.Group();
  /**
   * The viewer's own hand, drawn as a camera-attached overlay group. Its cards
   * are laid out in the group's local XY plane; the group itself is positioned
   * in front of the camera and shares its quaternion, so the fan always faces
   * the screen centre and follows every pan/tilt without a world-space race.
   */
  private ownHandGroup = new THREE.Group();
  /** Last smoothed camera forward used by the attached hand. */
  private ownHandForward = new THREE.Vector3(0, 0, -1);
  private ownHandQuaternion = new THREE.Quaternion();
  private ownHandReady = false;
  /** Smoothed whole-group scale; 1 is the seated reference size. */
  private ownHandScale = 1;
  /** Smoothed attachment depth, so pulled-back framing eases in instead of popping. */
  private ownHandDepth = OWN_HAND_DISTANCE;
  /**
   * The revealed board row (community cards). Its pivot is the table centre;
   * only yaw changes, so the row turns to face the camera without sliding off
   * the table. The draw pile does **not** live here: a deck is part of the
   * table and keeps its original bearing and position.
   */
  private dealerAreaGroup = new THREE.Group();
  private dealerAreaActive = false;
  private dealerAreaCardIds = new Set<string>();
  private dealerAreaFloatItems: { object: THREE.Object3D; baseY: number }[] = [];
  private dealerAreaHovered = false;
  private dealerAreaLiftUntil = 0;
  /** Restore record for the card currently lifted out of the table by a drag. */
  private draggedVisual?: {
    mesh: THREE.Mesh;
    renderOrder: number;
    materials: THREE.Material[];
    depthTests: boolean[];
  };
  /**
   * Poker effect layer: chip flights, floating amounts and the cards that are
   * still travelling. It survives the per-sync rebuild of `boardObjectsGroup`
   * only for the duration of one animation and is emptied at the start of every
   * poker sync.
   */
  private pokerFxGroup = new THREE.Group();
  /**
   * Seat standees, rebuilt on every sync. Their yaw follows the camera each
   * frame — with a per-seat random offset, so the table does not look like a row
   * of signs snapping to attention.
   */
  private seatStandees: { group: THREE.Group; jitter: number; lamp?: THREE.Mesh; seatId: string }[] = [];
  /** 每个座位「默认视角正下方」的定位标：白点 + 30% 白线 + 状态环/旋转箭头。 */
  /** 外层大方桌的边界（红圈）：立柱活动的外部限制（33 × 24 大桌木沿）。 */
  private tableBounds = {
    rx: TABLE_SIZE.width / 2 - 0.6,
    rz: TABLE_SIZE.length / 2 - 0.6
  };
  /** 内层牌桌椭圆的边界（绿圈）：立柱活动的内部限制（不侵入牌桌牌面）。 */
  private tableInnerOval = { rx: 9.25, rz: 5.95 };
  private seatBeacons: {
    group: THREE.Group;
    ring: THREE.Mesh;
    spinner: THREE.Group;
    arrow: THREE.Mesh;
    line: THREE.Mesh;
    avatarSprite: THREE.Sprite;
    betSprite: THREE.Sprite;
    seatCamPos: THREE.Vector3;
    defaultOutward: { x: number; y: number };
    seatId: string;
  }[] = [];

  /** Previous poker snapshot, used to detect what to animate. */
  private pokerFxPrev: {
    handNo: number;
    street: string;
    community: string[];
    streetBets: Record<string, number>;
    holeCards: Record<string, string[]>;
  } | null = null;
  /**
   * Cards that currently own their pose through a state-derived tween. The
   * per-frame hand layout must not snap them back to the row while they fly.
   */
  private animatingActionCardIds = new Set<string>();
  /** Logical animation slots used by the current sync (max twelve). */
  private actionAnimationSlots = 0;
  /** Fold meshes detached before the board rebuild, consumed by the next FX pass. */
  private pendingPokerFoldVisuals: THREE.Object3D[] = [];
  private isDestroyed = false;
  /**
   * Cached board furniture (labels, table dressing, tiles, cards, tokens).
   *
   * A sync still rebuilds the objects it draws, but pure builders are only
   * re-run when their arguments changed; unchanged furniture is cloned from
   * this cache. See `render/objectCache.ts` for the rationale.
   */
  private furniture = new ObjectTemplateCache();
  /** Full board rebuilds since construction (the cache's blast radius). */
  private boardRebuildCount = 0;
  private lastRawState: ProjectedGameState | null = null;
  private lastState: ProjectedGameState | null = null;
  private lastPlacement?: PlacementPreview;
  private lastLayout?: LayoutHints;
  private lastFitSignature = '';
  private lastBoardKey = '';
  private prePlacementCamera?: { position: THREE.Vector3; target: THREE.Vector3 };
  /** Room the active actor occupied on the previous sync, for camera follow. */
  private lastActorRoomId?: string;
  /** Active actor on the previous sync, for tracking turn switches in GOD mode. */
  private lastActorId?: string;
  /** Floor currently isolated in the 3D scene ('ALL' shows every layer). */
  private visibleFloor = 'ALL';
  private cameraTween?: {
    fromPosition: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPosition: THREE.Vector3;
    toTarget: THREE.Vector3;
    startedAt: number;
    duration: number;
  };
  private skipFitUntil = 0;
  private cameraTweenTimer?: number;
  private lastPreviewRotation?: number;
  private previewObjects: THREE.Object3D[] = [];
  private navArrowMeshes: {
    group: THREE.Object3D;
    material: THREE.MeshStandardMaterial;
    baseIntensity: number;
    baseY: number;
  }[] = [];
  private hasFitted = false;
  private lastSyncMs = 0;
  private hoveredEntityId?: string;
  private fanZoneId?: string;
  /** Hand rows keyed by zone id; the fisheye layout is re-applied per frame. */
  private handRows = new Map<string, HandRow>();
  /**
   * Last fisheye target the pointer asked for. Rows are rebuilt whenever the
   * board changes, so a fresh row picks this up instead of snapping back to a
   * uniform layout under a pointer that never moved.
   */
  private handPointerTarget = { x: 0.5, strength: 0 };
  private lastHandHoverId: string | null = null;
  /** Soft planes that follow each own-hand card; one per card. */
  private ownHandShadows = new Map<string, THREE.Mesh>();
  /** Current one-shot cut animation for the camera-attached hand. */
  private ownHandCut?: OwnHandCutState;
  private reduceMotionQuery?: MediaQueryList;
  private cardVisualOffsets = new Map<string, { dx: number; dz: number }>();
  private groupMembers = new Map<string, string[]>();
  private groupDrag?: {
    groupId: string;
    startWorld: [number, number, number];
    bases: Map<string, [number, number, number]>;
    offsets: Map<string, { dx: number; dz: number }>;
  };
  private draggedEntityId?: string;
  private draggedEntityOrigin?: {
    position: [number, number, number];
    offset: { dx: number; dz: number };
    /** 原始朝向：松手后恢复平放，拖动时的"朝向相机"不能留在桌上。 */
    quaternion: THREE.Quaternion;
  };
  /** Renderer-local deck positions (never written to GameState). */
  private deckVisualOffsets = new Map<string, { dx: number; dz: number }>();
  private deckPiles = new Map<string, { group: THREE.Group; baseX: number; baseZ: number }>();
  private draggedDeckZoneId?: string;
  private draggedHeldY?: number;
  private groupHeldY?: number;
  private cardSettles = new Map<
    string,
    { startY: number; targetY: number; startedAt: number; duration: number }
  >();
  private knownRoomIds = new Set<string>();
  private roomSettles = new Map<
    string,
    { startY: number; targetY: number; startedAt: number; duration: number }
  >();
  private highlightIds = new Set<string>();
  /**
   * Highlighted meshes mapped to the material they had before highlighting.
   *
   * The highlight works by swapping in a per-mesh clone rather than mutating the
   * material: room meshes share material instances, so tinting one tinted every
   * room that shared it and the restore then wrote stale values back, leaving the
   * whole house glowing.
   */
  private highlightedMeshes = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  /** Amber outlines added while a mesh is highlighted; disposed on restore. */
  private highlightHalos: THREE.Object3D[] = [];
  private framing = {
    isoPos: new THREE.Vector3(10.5, 22, 24.5),
    isoTarget: new THREE.Vector3(1.8, 0, -0.2),
    topHeight: 36
  };
  /** HUD-covered edges, measured by the shell and pushed down as plain pixels. */
  private viewportInsets: ViewportInsets = { left: 0, right: 0, bottom: 0, top: 0 };

  private onInteractiveClickCallback?: (data: InteractiveObjectData) => void;

  constructor(container: HTMLElement) {
    this.container = container;

    // 1. Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Static board: shadows only need an update when the scene changes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);
    this.labels = new LabelOverlay(container);
    this.labels.setOnClick(id => {
      if (!id.startsWith('stack:')) return;
      const zoneId = id.slice('stack:'.length);
      this.fanZoneId = this.fanZoneId === zoneId ? undefined : zoneId;
      this.lastBoardKey = '';
      if (this.lastRawState) this.syncState(this.lastRawState, this.lastPlacement, this.lastLayout);
    });
    this.labels.setOnGroupDrag((groupId, phase, clientX, clientY) => {
      this.handleGroupDrag(groupId, phase, clientX, clientY);
    });

    // 2. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a0e);
    this.scene.fog = new THREE.FogExp2(0x070a0e, 0.012);

    // 3. Camera & Controls
    this.camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 120);
    this.setCameraPreset('ISOMETRIC');

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // Do not go below table
    this.controls.minDistance = 3;
    this.controls.maxDistance = 80;
    this.controls.target.set(0, 0, 0);

    // 4. Lighting
    this.setupLighting();

    // 5. Table
    const table = GameTableBuilder.createTable();
    this.scene.add(table);
    this.scene.add(this.boardObjectsGroup);
    this.scene.add(this.ownHandGroup);
    this.dealerAreaGroup.position.y = BOARD_ROW_HOVER_Y;
    this.scene.add(this.dealerAreaGroup);
    this.scene.add(this.dragTargetGroup);
    this.scene.add(this.pokerFxGroup);

    // 6. Raycaster & Animation Queue
    this.raycaster = new BoardRaycaster(this.camera, this.renderer.domElement);
    this.raycaster.onEntityPress(() => {
      // Lock the camera before OrbitControls processes the first drag pixels.
      this.controls.enabled = false;
    });
    this.raycaster.onClick((data) => {
      this.controls.enabled = true;
      if (this.onInteractiveClickCallback) {
        this.onInteractiveClickCallback(data);
      }
    });
    this.raycaster.onDragMove((entityId, clientX, clientY) => {
      if (entityId.startsWith('deck:')) {
        this.followDeckDrag(entityId.slice('deck:'.length), clientX, clientY);
        return;
      }
      this.followCardDrag(entityId, clientX, clientY);
    });

    this.animQueue = new TransactionalAnimationQueue(this.scene, this.camera);

    // 7. Event listeners & Render loop
    window.addEventListener('resize', this.onResize.bind(this));
    // The hand fisheye follows the pointer; it is a presentation gesture only,
    // so it never touches controls or picking.
    this.renderer.domElement.addEventListener('pointermove', this.onHandPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.onHandPointerLeave);
    if (typeof window.matchMedia === 'function') {
      this.reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    }
    this.renderLoop();
  }

  private setupLighting(): void {
    // Warm ambient bounce
    const ambientLight = new THREE.AmbientLight(0xffe9c9, 0.82);
    this.scene.add(ambientLight);

    const hemisphere = new THREE.HemisphereLight(0x9db4d8, 0x1b1410, 0.38);
    this.scene.add(hemisphere);

    // Key lamp above the table (soft, warm)
    const keyLight = new THREE.DirectionalLight(0xfff2dd, 1.28);
    keyLight.position.set(7, 16, 9);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 40;
    keyLight.shadow.camera.left = -16;
    keyLight.shadow.camera.right = 16;
    keyLight.shadow.camera.top = 16;
    keyLight.shadow.camera.bottom = -16;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.radius = 3;
    this.scene.add(keyLight);

    // Cool rim light from the back for depth separation
    const fillLight = new THREE.DirectionalLight(0x8ab6ff, 0.34);
    fillLight.position.set(-10, 9, -12);
    this.scene.add(fillLight);

    // Hanging pendant lamp: tight warm pool over the play surface
    const pendant = new THREE.PointLight(0xffdfae, 46, 46, 2);
    pendant.position.set(0, 8.5, 0);
    this.scene.add(pendant);

    // Inspection lamp: follows the camera target so whichever room you are
    // looking at stays readable inside the dark diorama.
    this.focusLight = new THREE.PointLight(0xffe2b6, 0, 11, 2);
    this.focusLight.position.set(0, 4, 2);
    this.scene.add(this.focusLight);
  }

  /** Keep the warm inspection light over the room under the camera target. */
  private updateFocusLight(): void {
    if (!this.focusLight) return;
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    // Blend from a tight close-up lamp to a broad wash as the camera pulls back,
    // so both the room-level and the whole-board view stay readable.
    const t = THREE.MathUtils.clamp((distance - 6) / 26, 0, 1);
    const height = THREE.MathUtils.lerp(3.4, 12, t);
    this.focusLight.position.set(
      target.x + THREE.MathUtils.lerp(0.6, 2.2, t),
      target.y + height,
      target.z + THREE.MathUtils.lerp(1.9, 5, t)
    );
    // Physical falloff is 1/d², so scale intensity with the square of the lift
    // to hold a roughly constant floor illuminance.
    this.focusLight.intensity = 2.6 * height * height;
    this.focusLight.distance = THREE.MathUtils.lerp(14, 52, t);
  }

  public getAnimationQueue(): TransactionalAnimationQueue {
    return this.animQueue;
  }

  public onInteractiveClick(cb: (data: InteractiveObjectData) => void): void {
    this.onInteractiveClickCallback = cb;
  }

  /** Hover updates the card-title label without rebuilding the board. */
  public onInteractiveHover(cb: (data: InteractiveObjectData | null) => void): void {
    this.raycaster.onHover(data => {
      this.hoveredEntityId = data?.type === 'ENTITY' ? data.id : undefined;
      this.dealerAreaHovered =
        !!data && data.type === 'ENTITY' && this.dealerAreaCardIds.has(data.id);
      if (this.lastState) this.refreshLabels(this.lastState);
      cb(data);
    });
  }

  public onEntityDrop(
    cb: (entityId: string, target: InteractiveObjectData | null, clientX: number, clientY: number) => void
  ): void {
    this.raycaster.onDrop(cb);
  }

  public onEntityDragStart(cb: (entityId: string) => void): void {
    this.raycaster.onDragStart(entityId => {
      // An entity/deck drag is a placement gesture, not a camera orbit gesture.
      this.controls.enabled = false;
      if (entityId.startsWith('deck:')) {
        const zoneId = entityId.slice('deck:'.length);
        if (!this.deckPiles.has(zoneId)) return;
        this.draggedDeckZoneId = zoneId;
        cb(entityId);
        return;
      }
      const mesh = this.entityMeshes.get(entityId);
      if (mesh) {
        const offset = this.cardVisualOffsets.get(entityId) ?? { dx: 0, dz: 0 };
        this.draggedEntityId = entityId;
        const surfaceY = this.surfaceYAt(mesh.position.x, mesh.position.z, entityId);
        this.draggedHeldY = surfaceY + CARD_DRAG_LIFT;
        this.draggedEntityOrigin = {
          position: [mesh.position.x, mesh.position.y, mesh.position.z],
          quaternion: mesh.quaternion.clone(),
          offset: { ...offset }
        };
        this.raiseDraggedCard(mesh);
        // Lift immediately: the drag probe (and the player) should never see the
        // enlarged 1.5× card slice through the felt on the first moved frame.
        if (mesh.position.y < this.draggedHeldY) mesh.position.y = this.draggedHeldY;
      }
      cb(entityId);
    });
  }

  public onEntityDragEnd(cb: () => void): void {
    this.raycaster.onDragEnd(() => {
      this.controls.enabled = true;
      // 松手：把牌放回原来的朝向。牌堆的落点则保留，位置只存在渲染层。
      if (this.draggedEntityId) {
        const mesh = this.entityMeshes.get(this.draggedEntityId);
        if (mesh && this.draggedEntityOrigin) mesh.quaternion.copy(this.draggedEntityOrigin.quaternion);
      }
      this.restoreDraggedCard();
      cb();
      this.draggedEntityId = undefined;
      this.draggedEntityOrigin = undefined;
      this.draggedDeckZoneId = undefined;
      this.draggedHeldY = undefined;
    });
  }

  /**
   * Lift a dragged card above its surface and force it to draw over everything.
   *
   * The card is 1.5× larger than before, so a flat drag at table height either
   * clips the felt or disappears behind a neighbour. Both the material and the
   * render order are restored the moment the pointer is released.
   */
  private raiseDraggedCard(mesh: THREE.Object3D): void {
    const materials: THREE.Material[] = [];
    const depthTests: boolean[] = [];
    mesh.traverse(child => {
      if (!(child as THREE.Mesh).isMesh) return;
      const material = (child as THREE.Mesh).material;
      for (const entry of Array.isArray(material) ? material : [material]) {
        if (!entry || materials.includes(entry)) continue;
        materials.push(entry);
        depthTests.push(entry.depthTest);
        entry.depthTest = false;
      }
    });
    this.draggedVisual = {
      mesh: mesh as THREE.Mesh,
      renderOrder: mesh.renderOrder,
      materials,
      depthTests
    };
    mesh.renderOrder = 10000;
  }

  /** Put a dragged card's materials/render order back exactly as they were. */
  private restoreDraggedCard(): void {
    const visual = this.draggedVisual;
    if (!visual) return;
    for (let i = 0; i < visual.materials.length; i += 1) {
      visual.materials[i].depthTest = visual.depthTests[i];
    }
    visual.mesh.renderOrder = visual.renderOrder;
    this.draggedVisual = undefined;
  }


  public setDropTargets(nodeIds: string[]): void {
    this.clearDropTargets();
    const unique = new Set(nodeIds);
    for (const id of unique) {
      const mesh = this.nodeMeshes.get(id);
      if (!mesh) continue;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.0, 1.22, 48),
        new THREE.MeshBasicMaterial({
          color: 0xf6dc9c,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(mesh.position.x, mesh.position.y + 0.24, mesh.position.z);
      this.dragTargetGroup.add(ring);
    }
  }

  public clearDropTargets(): void {
    while (this.dragTargetGroup.children.length > 0) {
      const child = this.dragTargetGroup.children[0];
      this.dragTargetGroup.remove(child);
      this.disposeObject3D(child);
    }
  }

  /**
   * Presentation-only card repositioning. This never changes GameState; it is
   * an escape hatch for visually overlapping cards on the table.
   */
  public moveCardToScreen(entityId: string, clientX: number, clientY: number): boolean {
    const mesh = this.entityMeshes.get(entityId);
    if (!mesh) return false;
    const point = this.screenToTable(clientX, clientY);
    if (!point) return false;

    const origin = this.draggedEntityOrigin;
    const old = this.cardVisualOffsets.get(entityId) ?? { dx: 0, dz: 0 };
    const baseX = origin ? origin.position[0] - origin.offset.dx : mesh.position.x - old.dx;
    const baseZ = origin ? origin.position[2] - origin.offset.dz : mesh.position.z - old.dz;
    const local = this.pointInParentSpace(mesh.parent, point);
    const dx = local.x - baseX;
    const dz = local.z - baseZ;
    this.cardVisualOffsets.set(entityId, { dx, dz });
    mesh.position.x = baseX + dx;
    mesh.position.z = baseZ + dz;
    this.settleCard(entityId);
    if (this.lastState) this.refreshLabels(this.lastState);
    return true;
  }

  /**
   * Convert a world-space table point into the local space of `parent`.
   *
   * Ordinary board cards live directly under the identity-space board group,
   * so this is a no-op. Community cards live in the rotated dealer group and
   * dragged deck piles in the same group: assigning a world coordinate to their
   * local position would make the card jump when the group turns.
   */
  private pointInParentSpace(
    parent: THREE.Object3D | null,
    point: [number, number, number]
  ): THREE.Vector3 {
    const local = new THREE.Vector3(point[0], point[1], point[2]);
    if (parent && parent !== this.scene && parent !== this.boardObjectsGroup) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(local);
    }
    return local;
  }

  private screenToTable(clientX: number, clientY: number): [number, number, number] | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    BoardGameScene._scratchNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    BoardGameScene._scratchRaycaster.setFromCamera(BoardGameScene._scratchNdc, this.camera);
    if (!BoardGameScene._scratchRaycaster.ray.intersectPlane(BoardGameScene._scratchPlane, BoardGameScene._scratchPoint)) {
      return null;
    }
    return [BoardGameScene._scratchPoint.x, 0.08, BoardGameScene._scratchPoint.z];
  }

  /**
   * Move the draw pile on the felt and remember its offset locally. It is a
   * table gesture, not a rules action: nothing here touches GameState, and the
   * offset survives board rebuilds because it lives in this renderer instance.
   */
  private followDeckDrag(zoneId: string, clientX: number, clientY: number): void {
    if (zoneId !== this.draggedDeckZoneId) return;
    const pile = this.deckPiles.get(zoneId);
    const point = this.screenToTable(clientX, clientY);
    if (!pile || !point) return;
    // Keep the whole pile on the wooden tabletop, not just its centre.
    const margin = DECK_CARD_W * 0.5 + 0.2;
    const x = THREE.MathUtils.clamp(
      point[0],
      -this.tableBounds.rx + margin,
      this.tableBounds.rx - margin
    );
    const z = THREE.MathUtils.clamp(
      point[2],
      -this.tableBounds.rz + margin,
      this.tableBounds.rz - margin
    );
    const local = this.pointInParentSpace(pile.group.parent, [x, 0, z]);
    pile.group.position.x = local.x;
    pile.group.position.z = local.z;
    // Store relative to the logical anchor so a later state sync can place the
    // rebuilt group at the same visual point without knowing pointer history.
    this.deckVisualOffsets.set(zoneId, { dx: local.x - pile.baseX, dz: local.z - pile.baseZ });
  }

  private followCardDrag(entityId: string, clientX: number, clientY: number): void {
    if (entityId !== this.draggedEntityId) return;
    const mesh = this.entityMeshes.get(entityId);
    const point = this.screenToTable(clientX, clientY);
    if (!mesh || !point) return;
    // 拖动时牌心法线对准视锥原点（= 相机位置）：法线指向相机，牌面正对读牌的人。
    // 用基向量构造而不是 setFromUnitVectors —— 后者只约束法线方向，绕视线的自转是
    // 任意的，牌上的字会歪；这里把牌面的「上」（局部 -Z）对齐相机的 up，文字正立。
    const normal = new THREE.Vector3().subVectors(this.camera.position, mesh.position);
    if (normal.lengthSq() > 1e-6) {
      normal.normalize();
      const localZ = this.camera.up.clone().normalize().negate();
      const localX = new THREE.Vector3().crossVectors(normal, localZ).normalize();
      const fixedZ = new THREE.Vector3().crossVectors(localX, normal).normalize();
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(localX, normal, fixedZ));
    }
    this.cardSettles.delete(entityId);
    const local = this.pointInParentSpace(mesh.parent, point);
    mesh.position.x = local.x;
    mesh.position.z = local.z;
    const surfaceY = this.surfaceYAt(point[0], point[2], entityId);
    this.draggedHeldY = surfaceY + CARD_DRAG_LIFT;
  }

  /** Highest mesh top under an x/z point, excluding specified entity/entities. */
  private surfaceYAt(x: number, z: number, excludeIds?: string | string[]): number {
    const ids = excludeIds
      ? (Array.isArray(excludeIds) ? excludeIds : [excludeIds])
      : [];
    const excludedObjects = new Set<THREE.Object3D>();
    for (const id of ids) {
      const obj = this.entityMeshes.get(id);
      if (obj) {
        excludedObjects.add(obj);
        obj.traverse(child => excludedObjects.add(child));
      }
    }

    BoardGameScene._scratchRayOrigin.set(x, 30, z);
    BoardGameScene._scratchRaycaster.set(BoardGameScene._scratchRayOrigin, BoardGameScene._scratchRayDir);
    BoardGameScene._scratchRaycaster.camera = this.camera;
    // Newly created room/card meshes have not rendered yet. Raycaster reads
    // matrixWorld directly, so refresh it before querying the surface or a
    // freshly discarded card lands on the table height and clips the room tile.
    this.scene.updateMatrixWorld(true);
    const hits = BoardGameScene._scratchRaycaster.intersectObjects(
      [...this.boardObjectsGroup.children, ...this.dealerAreaGroup.children],
      true
    );

    const hit = hits.find(entry => {
      if (!(entry.object as THREE.Mesh).isMesh) return false;
      if (excludedObjects.has(entry.object)) return false;
      return true;
    });

    return hit?.point.y ?? 0.02;
  }

  public resetCardDrag(entityId: string): void {
    const origin = this.draggedEntityOrigin;
    const mesh = this.entityMeshes.get(entityId);
    if (!origin || !mesh) return;
    this.draggedHeldY = undefined;
    mesh.position.x = origin.position[0];
    mesh.position.z = origin.position[2];
    this.cardVisualOffsets.set(entityId, { ...origin.offset });
    this.cardSettles.set(entityId, {
      startY: mesh.position.y,
      targetY: origin.position[1],
      startedAt: performance.now(),
      duration: 220
    });
    if (this.lastState) this.refreshLabels(this.lastState);
  }

  public settleCard(entityId: string): void {
    const mesh = this.entityMeshes.get(entityId);
    if (!mesh) return;
    const surfaceY = this.surfaceYAt(mesh.position.x, mesh.position.z, entityId);
    const targetY = Math.max(0.08, surfaceY + 0.015);
    if (Math.abs(mesh.position.y - targetY) < 0.005) {
      mesh.position.y = targetY;
      return;
    }
    // If the frame loop is not ticking (background tab, throttled headless
    // page) an animated settle would freeze halfway and leave the card sunk
    // into the tile. Land it immediately in that case.
    if (performance.now() - this.lastFrameTime > 120) {
      mesh.position.y = targetY;
      this.cardSettles.delete(entityId);
      return;
    }
    this.cardSettles.set(entityId, {
      startY: mesh.position.y,
      targetY,
      startedAt: performance.now(),
      duration: 220
    });
  }

  private scheduleCardSettles(): void {
    for (const [id, entity] of Object.entries(this.lastState?.entities ?? {})) {
      if (entity?.type === 'CARD') {
        const zone = entity.zoneId ? this.lastState?.zones[entity.zoneId] : undefined;
        if (zone?.type === 'HAND' || zone?.type === 'DISCARD' || zone?.type === 'DECK' || zone?.type === 'EQUIP') {
          continue;
        }
        this.settleCard(id);
      }
    }
  }

  private updateCardSettles(now: number): void {
    if (this.draggedEntityId && this.draggedHeldY !== undefined && !this.cardSettles.has(this.draggedEntityId)) {
      const mesh = this.entityMeshes.get(this.draggedEntityId);
      if (mesh) mesh.position.y += (this.draggedHeldY - mesh.position.y) * 0.22;
    }
    if (this.groupDrag && this.groupHeldY !== undefined) {
      for (const id of this.groupDrag.bases.keys()) {
        const mesh = this.entityMeshes.get(id);
        if (mesh) mesh.position.y += (this.groupHeldY - mesh.position.y) * 0.22;
      }
    }
    for (const [id, settle] of this.cardSettles) {
      const mesh = this.entityMeshes.get(id);
      if (!mesh) {
        this.cardSettles.delete(id);
        continue;
      }
      const t = Math.min(1, Math.max(0, (now - settle.startedAt) / settle.duration));
      const eased = 1 - (1 - t) * (1 - t);
      mesh.position.y = settle.startY + (settle.targetY - settle.startY) * eased;
      if (t >= 1) {
        mesh.position.y = settle.targetY;
        this.cardSettles.delete(id);
      }
    }
  }

  private updateRoomSettles(now: number): void {
    for (const [id, settle] of this.roomSettles) {
      const mesh = this.nodeMeshes.get(id);
      if (!mesh) {
        this.roomSettles.delete(id);
        continue;
      }
      const t = Math.min(1, Math.max(0, (now - settle.startedAt) / settle.duration));
      const eased = 1 - Math.pow(1 - t, 3);
      mesh.position.y = settle.startY + (settle.targetY - settle.startY) * eased;
      if (t >= 1) {
        mesh.position.y = settle.targetY;
        this.roomSettles.delete(id);
      }
    }
  }

  /** Presentation-only merge compatibility; never changes GameState. */
  public canMergeCards(sourceId: string, targetId: string): boolean {
    if (sourceId === targetId) return false;
    const state = this.lastState;
    const source = state?.entities[sourceId];
    const target = state?.entities[targetId];
    if (!source || !target || !source.zoneId || source.zoneId !== target.zoneId) return false;
    return cardGroupKey(source as never) === cardGroupKey(target as never);
  }

  /** Snap a dragged card onto another card's visual pile. */
  public mergeCardsVisually(sourceId: string, targetId: string): void {
    const source = this.entityMeshes.get(sourceId);
    const target = this.entityMeshes.get(targetId);
    if (!source || !target) return;
    const old = this.cardVisualOffsets.get(sourceId) ?? { dx: 0, dz: 0 };
    const baseX = source.position.x - old.dx;
    const baseZ = source.position.z - old.dz;
    const dx = target.position.x - baseX + 0.12;
    const dz = target.position.z - baseZ + 0.08;
    this.cardVisualOffsets.set(sourceId, { dx, dz });
    source.position.set(baseX + dx, target.position.y + 0.02, baseZ + dz);
    if (this.lastState) this.refreshLabels(this.lastState);
  }

  /** Visual-only group drag from the ×N badge; never mutates GameState. */
  private handleGroupDrag(
    groupId: string,
    phase: 'start' | 'move' | 'end',
    clientX: number,
    clientY: number
  ): void {
    if (phase === 'start') {
      const ids = this.groupMembers.get(groupId) ?? [];
      const bases = new Map<string, [number, number, number]>();
      const offsets = new Map<string, { dx: number; dz: number }>();
      for (const id of ids) {
        const mesh = this.entityMeshes.get(id);
        if (!mesh) continue;
        const old = this.cardVisualOffsets.get(id) ?? { dx: 0, dz: 0 };
        offsets.set(id, { ...old });
        bases.set(id, [mesh.position.x - old.dx, mesh.position.y, mesh.position.z - old.dz]);
      }
      const startWorld = this.screenToTable(clientX, clientY) ?? [0, 0, 0];
      const maxSurface = Math.max(
        ...[...bases.values()].map(([x, , z]) => this.surfaceYAt(x, z, ids))
      );
      this.groupHeldY = maxSurface + CARD_DRAG_LIFT;
      this.groupDrag = { groupId, startWorld, bases, offsets };
      return;
    }
    if (!this.groupDrag || this.groupDrag.groupId !== groupId) return;
    if (phase === 'end') {
      const ids = [...this.groupDrag.bases.keys()];
      this.groupDrag = undefined;
      this.groupHeldY = undefined;
      for (const id of ids) this.settleCard(id);
      if (this.lastState) this.refreshLabels(this.lastState);
      return;
    }

    const current = this.screenToTable(clientX, clientY);
    if (!current) return;
    const dx = current[0] - this.groupDrag.startWorld[0];
    const dz = current[2] - this.groupDrag.startWorld[2];

    for (const [id, [bx, _by, bz]] of this.groupDrag.bases) {
      const mesh = this.entityMeshes.get(id);
      if (!mesh) continue;
      const start = this.groupDrag.offsets.get(id) ?? { dx: 0, dz: 0 };
      const next = { dx: start.dx + dx, dz: start.dz + dz };
      this.cardVisualOffsets.set(id, next);
      mesh.position.x = bx + next.dx;
      mesh.position.z = bz + next.dz;
    }
  }

  /** Feed kernel visual events into the transactional animation queue. */
  public enqueueAnimations(events: import('@rds/kernel/types').VisualTraceEvent[]): void {
    if (events.length > 0) this.animQueue.enqueue(events);
  }

  /** Frame one floor (or the whole board) without changing logical coordinates. */
  public focusFloor(floorId: string): void {
    this.setVisibleFloor(floorId);
    if (!this.lastState) return;
    if (floorId === 'ALL') {
      this.fitCameraToBoard(this.lastState, this.lastPlacement, this.lastLayout);
      return;
    }
    const anchors = this.floorAnchorsFor(this.lastState, this.lastPlacement);
    const anchor = anchors[floorId];
    if (!anchor) return;
    const center = new THREE.Vector3(anchor.x, 0, anchor.z);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const distance = Math.max(anchor.width, anchor.depth) * 1.35 + 6;
    const targetPos = center.clone().add(direction.multiplyScalar(distance));
    this.skipFitUntil = performance.now() + 600;
    this.startCameraTween(targetPos, center, 480);
  }

  /**
   * Apply floor isolation filter: when a single floor is active, hide objects
   * belonging to other floors. 'ALL' restores full visibility.
   */
  public setVisibleFloor(floorId: string): void {
    this.visibleFloor = floorId;
    this.applyFloorFilter();
    if (this.lastState) {
      this.refreshLabels(this.lastState);
    }
  }

  public getVisibleFloor(): string {
    return this.visibleFloor;
  }

  private applyFloorFilter(): void {
    if (this.lastState?.gameId !== 'betrayal') return;
    const isIsolated = this.visibleFloor !== 'ALL';
    this.boardObjectsGroup.traverse(obj => {
      const floor = obj.userData?.floor as string | undefined;
      if (floor) {
        obj.visible = !isIsolated || floor === this.visibleFloor;
      }
    });
  }

  /**
   * Cinematic close-up on one board node. Used by the room inspector and the
   * modelling review harness; never mutates game state.
   */
  public focusNode(nodeId: string, distance = 6.8): boolean {
    const mesh = this.nodeMeshes.get(nodeId);
    if (!mesh || this.isDestroyed) return false;
    const target = mesh.position.clone();
    target.y = Math.max(0.12, target.y + 0.16);
    const dir = new THREE.Vector3(0.56, 0.92, 0.8).normalize();
    const position = target.clone().addScaledVector(dir, distance);
    this.skipFitUntil = performance.now() + 1400;
    this.startCameraTween(position, target, 520);
    return true;
  }

  /** Recover the wide board framing after a close-up. */
  public clearFocus(): void {
    if (!this.lastState) return;
    this.skipFitUntil = 0;
    this.hasFitted = false;
    this.fitCameraToBoard(this.lastState, this.lastPlacement, this.lastLayout);
  }

  /**
   * Reset board caching and camera tracking state when switching games,
   * guaranteeing that the incoming fixture is fully rendered and reframed.
   */
  public resetForNewGame(): void {
    this.lastBoardKey = '';
    this.lastFitSignature = '';
    this.hasFitted = false;
    this.lastActorRoomId = undefined;
    this.lastActorId = undefined;
    this.visibleFloor = 'ALL';
    this.prePlacementCamera = undefined;
    this.pokerFxPrev = null;
    this.animatingActionCardIds.clear();
    this.actionAnimationSlots = 0;
    this.disposePendingPokerFoldVisuals();
    this.cancelCameraTween();
    // A different fixture shares no furniture: drop the templates rather than
    // carrying the previous table's geometry into the new game.
    this.furniture.clear();
  }

  /**
   * Floating `力量 -2` over a character's miniature.
   *
   * Anchored to the meeple so the number sits on the figure itself rather than
   * a fixed screen spot; falls back to their current room when no token exists.
   */
  public popTraitBurst(playerId: string, text: string, tone: 'physical' | 'mental' | 'heal'): void {
    const mesh = this.entityMeshes.get(`meeple_${playerId}`);
    if (mesh) {
      this.labels.popBurst([mesh.position.x, mesh.position.y + 0.62, mesh.position.z], text, tone);
      return;
    }
    const player = this.lastState?.players[playerId];
    const room = player
      ? this.lastState?.mapGraph.nodes[String(player.customProps?.currentRoomId ?? '')]
      : undefined;
    if (room) {
      this.labels.popBurst([room.position[0], room.position[1] + 0.55, room.position[2]], text, tone);
    }
  }

  /**
   * Tell the camera which canvas edges the HUD is covering.
   *
   * Called whenever a drawer opens/closes or the action dock expands. The view
   * only shifts to keep the board in the uncovered rectangle; the canvas keeps
   * rendering at full size (see `fitCameraToBoard` for later refits). Pure
   * numbers on purpose — the renderer must not import any UI code.
   */
  public setViewportInsets(insets: ViewportInsets): void {
    if (!this.controls || this.isDestroyed) return;
    const next = this.clampViewportInsets(insets);
    const previous = this.viewportInsets;
    if (
      Math.abs(next.left - previous.left) < 0.5 &&
      Math.abs(next.right - previous.right) < 0.5 &&
      Math.abs(next.bottom - previous.bottom) < 0.5 &&
      Math.abs(next.top - previous.top) < 0.5
    ) {
      return;
    }
    this.viewportInsets = next;

    // A drawer on the left moves the visible centre to the right, so the camera
    // target has to move left; a bottom dock does the opposite vertically. The
    // delta is incremental so switching left -> right drawer is symmetric and
    // closing restores the original pose without storing a snapshot.
    const dxPx = (next.left - next.right - (previous.left - previous.right)) / 2;
    const dyPx = (next.top - next.bottom - (previous.top - previous.bottom)) / 2;
    if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return;

    const distance = this.camera.position.distanceTo(this.controls.target);
    const shift = this.screenOffsetToWorld(dxPx, dyPx, distance);
    if (shift.lengthSq() < 1e-6) return;
    const target = this.controls.target.clone().add(shift);
    const position = this.camera.position.clone().add(shift);
    this.skipFitUntil = performance.now() + 320;
    if (this.reduceMotionQuery?.matches) {
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.startCameraTween(position, target, 240);
  }

  /** Clamp arbitrary UI measurements to the current canvas. */
  private clampViewportInsets(insets: ViewportInsets): ViewportInsets {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const value = (input: number): number =>
      Number.isFinite(input) ? Math.max(0, input) : 0;
    const left = Math.min(value(insets.left), width - 1);
    const right = Math.min(value(insets.right), Math.max(0, width - left - 1));
    const top = Math.min(value(insets.top), height - 1);
    const bottom = Math.min(value(insets.bottom), Math.max(0, height - top - 1));
    return { left, right, bottom, top };
  }

  /**
   * Convert a screen-space shift (positive = right/down) into the world-space
   * shift of the orbit target that produces it. The camera's own right/up axes
   * keep the correction valid after the user has orbited the board.
   */
  private screenOffsetToWorld(dxPx: number, dyPx: number, distance: number): THREE.Vector3 {
    const height = Math.max(1, this.container.clientHeight);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const worldPerPixel = (2 * distance * Math.tan(fov / 2)) / height;
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    return right
      .multiplyScalar(-dxPx * worldPerPixel)
      .add(up.multiplyScalar(dyPx * worldPerPixel));
  }

  public setCameraPreset(preset: CameraPreset): void {
    const framing = this.framing;
    const scale = this.framingScale();

    switch (preset) {
      case 'ISOMETRIC': {
        const target = framing.isoTarget;
        const base = framing.isoPos;
        this.camera.position.set(
          target.x + (base.x - target.x) * scale,
          target.y + (base.y - target.y) * scale,
          target.z + (base.z - target.z) * scale
        );
        if (this.controls) this.controls.target.copy(target);
        break;
      }
      case 'TOP_DOWN':
        this.camera.position.set(framing.isoTarget.x, framing.topHeight * scale, 0.02);
        if (this.controls) this.controls.target.set(framing.isoTarget.x, 0, framing.isoTarget.z + 1.4);
        break;
      case 'PLAYER_1':
        this.camera.position.set(0, 7.5, 13);
        if (this.controls) this.controls.target.set(0, 0, 1.2);
        break;
      case 'PLAYER_2':
        this.camera.position.set(0, 7.5, -13);
        if (this.controls) this.controls.target.set(0, 0, -1.2);
        break;
      case 'SEAT':
        // 座位机位需要具体座位，由 `setSeatView` 计算；这里只兜底到等轴。
        break;
    }
    this.controls?.update();
  }

  /**
   * 把镜头放到某个座位自己的视角。
   *
   * 立牌位置取投影后的座位节点（`props.seatIndex` / `props.playerId`），所以补位
   * AI、换座之后的观察者都自动落在正确的座位上。
   */
  public setSeatView(seat: { playerId?: string; seatIndex?: number }): boolean {
    const state = this.lastState;
    if (!state) return false;
    const seats = Object.values(state.mapGraph.nodes).filter(entry => entry.type === 'SEAT');
    const node = seats.find(entry => {
      if (seat.playerId !== undefined) {
        return String(entry.props?.playerId ?? '') === seat.playerId;
      }
      return Number(entry.props?.seatIndex ?? -1) === seat.seatIndex;
    });
    if (!node) return false;

    const [x, , z] = node.position;
    const radius = Math.max(0.001, Math.hypot(x, z));
    const outward = new THREE.Vector2(x / radius, z / radius);
    // 牌桌宽度取座位环的包围盒，只用来定「退多远」的尺度。
    const rx = Math.max(...seats.map(entry => Math.abs(entry.position[0])), 4);
    // 退到立牌外侧多远：跟桌面尺寸走，跟具体哪一座无关。椭圆桌的长短轴座位到
    // 桌心的距离差很多，用「相对立牌」的固定量取景，每个座位看到的立牌大小才一致。
    const back = Math.max(7, rx * 1.05);
    // 视线落在自己立牌顶沿稍往里一点：立牌占画面中下部，牌桌在它上方展开。
    const target = new THREE.Vector3(
      x - outward.x * 2.6,
      0.7,
      z - outward.y * 2.6
    );
    const position = new THREE.Vector3(
      x + outward.x * back,
      2 + back * 0.29,
      z + outward.y * back
    );

    this.skipFitUntil = performance.now() + 900;
    this.startCameraTween(position, target, 520);
    return true;
  }

  /** Pull the camera back on narrower windows so the board still fits. */
  private framingScale(): number {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
    return Math.min(1.25, Math.max(1, 1300 / Math.max(w, 900)));
  }

  /**
   * Map high-dimensional logical coordinates to renderer-world positions once
   * per sync; every renderer subsystem then works in ordinary XYZ.
   * If a room placement is currently previewed, a virtual node is injected so that
   * auto-layer offsets, floor mats, and neighbouring rooms dynamically
   * reflow to accommodate the prospective room before it is placed.
   */
  private projectForDisplay(
    state: ProjectedGameState,
    placement?: PlacementPreview
  ): { state: ProjectedGameState; placementPosition?: [number, number, number] } {
    const nodesToProject: Record<string, MapGraphNode> = { ...state.mapGraph.nodes };
    const previewId = '__placement_preview__';
    const isPlacing = !!(
      placement &&
      placement.floor &&
      placement.col !== undefined &&
      placement.row !== undefined
    );

    if (isPlacing) {
      const layerIndex =
        state.mapGraph.topology?.layers?.find(entry => entry.id === placement!.floor)?.index ?? 1;
      nodesToProject[previewId] = {
        id: previewId,
        type: 'ROOM',
        position: [placement!.col!, placement!.row!, layerIndex],
        positionSpace: 'grid',
        neighbors: [],
        layer: placement!.floor,
        props: {
          name: placement!.name,
          floor: placement!.floor,
          col: placement!.col,
          row: placement!.row,
          doors: placement!.doors,
          symbol: placement!.symbol
        }
      };
    }

    const projected = this.projection.projectAll(nodesToProject, {
      gameId: state.gameId,
      topology: state.mapGraph.topology,
      frames: state.mapGraph.frames
    });

    const nodes: ProjectedGameState['mapGraph']['nodes'] = {};
    for (const [id, node] of Object.entries(state.mapGraph.nodes)) {
      nodes[id] = {
        ...node,
        position: projected[id]?.position ?? node.position
      };
    }

    const placementPosition =
      isPlacing && previewId in projected
        ? (projected[previewId].position as [number, number, number])
        : undefined;

    return {
      state: {
        ...state,
        mapGraph: {
          ...state.mapGraph,
          nodes
        }
      },
      placementPosition
    };
  }

  /** Install a game/presentation-specific projection registry. */
  public setProjectionRegistry(registry: ProjectionRegistry): void {
    this.projection = registry;
    this.lastBoardKey = '';
    if (this.lastRawState) {
      this.syncState(this.lastRawState, this.lastPlacement, this.lastLayout);
    }
  }

  /**
   * Synchronize 3D Scene with Projected State
   */
  public syncState(
    rawState: ProjectedGameState,
    placement?: PlacementPreview,
    layout?: LayoutHints
  ): void {
    const syncStarted = performance.now();
    const previousState = this.lastState;
    this.lastRawState = rawState;
    const { state, placementPosition } = this.projectForDisplay(rawState, placement);
    const displayPlacement: PlacementPreview | undefined = placement
      ? {
          ...placement,
          position: placementPosition ?? placement.position
        }
      : undefined;
    const wasPlacing = !!this.lastPlacement;
    const isPlacing = !!displayPlacement;
    this.lastState = state;
    this.lastPlacement = displayPlacement;
    this.lastLayout = layout;

    if (!wasPlacing && isPlacing) {
      this.beginPlacementCamera(displayPlacement!);
    } else if (wasPlacing && !isPlacing) {
      // The actor may have moved into the newly placed room during this sync;
      // `state` here is the post-placement projection, so it is what we centre on.
      this.endPlacementCamera(state);
    } else if (!isPlacing) {
      this.followActorIfMoved(state);
    }

    const placingSignature = displayPlacement
      ? `${displayPlacement.defId ?? displayPlacement.name}:${displayPlacement.floor}:${displayPlacement.col}:${displayPlacement.row}`
      : 'none';
    const boardKey = `${state.gameId}:${state.viewerId}:${state.actionLog.length}:${state.clock}:${placingSignature}`;
    const boardChanged = boardKey !== this.lastBoardKey;
    if (!boardChanged) {
      // Placement rotation only changes the preview mesh and connection links, not the board.
      this.clearPreviewObjects();
      if (displayPlacement) this.renderPlacementPreview(displayPlacement, state);
      this.applyFloorFilter();
      const fitSignature = `${Object.keys(state.mapGraph.nodes).length}:${displayPlacement ? 'placing' : ''}`;
      if (fitSignature !== this.lastFitSignature) {
        this.lastFitSignature = fitSignature;
        if (!this.cameraTween && performance.now() >= this.skipFitUntil) {
          this.fitCameraToBoard(state, displayPlacement, layout);
        }
      }
      this.lastSyncMs = performance.now() - syncStarted;
      return;
    }

    this.lastBoardKey = boardKey;
    this.boardRebuildCount += 1;
    this.raycaster.clearInteractive();
    // Folded hole cards must leave the table through an animation, but the new
    // projection has already moved them to the muck. Capture their old meshes
    // before the rebuild disposes them; this is a render-only copy.
    this.capturePokerFoldVisuals(previousState, state);

    // Any furniture this sync does not ask for is evicted when the rebuild ends.
    this.furniture.begin();

    // Clear previous board objects (dispose GPU resources; keep cached textures).
    this.clearBoardObjects();
    this.previewObjects = [];
    this.entityMeshes.clear();
    this.nodeMeshes.clear();
    this.edgeMeshes.clear();
    this.renderer.shadowMap.needsUpdate = true;

    // 1. Render Map Graph (Catan Hexes / Betrayal Rooms / Sanguosha Seats)
    this.renderMapGraph(state);

    // Track newly placed rooms to trigger placement animation
    const currentRoomIds = new Set<string>();
    Object.values(state.mapGraph.nodes).forEach(node => {
      if (node.type === 'ROOM') currentRoomIds.add(node.id);
    });
    if (this.knownRoomIds.size > 0) {
      const loopStale = performance.now() - this.lastFrameTime > 120;
      for (const id of currentRoomIds) {
        if (!this.knownRoomIds.has(id)) {
          const mesh = this.nodeMeshes.get(id);
          if (mesh) {
            if (loopStale) {
              // Frame loop throttled: land the tile immediately.
              this.roomSettles.delete(id);
            } else {
              this.roomSettles.set(id, {
                startY: mesh.position.y + 1.25,
                targetY: mesh.position.y,
                startedAt: performance.now(),
                duration: 380
              });
            }
            BoardGameAudio.playTilePlacement();
          }
        }
      }
    }
    this.knownRoomIds = currentRoomIds;

    // 2. Render Entities (Cards, Tokens, Buildings, Dice)
    this.renderEntities(state);
    this.scheduleCardSettles();
    if (displayPlacement) this.renderPlacementPreview(displayPlacement);

    // 3. Re-apply candidate highlights (build spots / buyable cards)
    this.applyHighlights();

    const fitSignature = `${Object.keys(state.mapGraph.nodes).length}:${displayPlacement ? 'placing' : ''}`;
    if (fitSignature !== this.lastFitSignature) {
      this.lastFitSignature = fitSignature;
      if (!this.cameraTween && performance.now() >= this.skipFitUntil) {
        this.fitCameraToBoard(state, displayPlacement, layout);
      }
    }
    this.refreshLabels(state);
    this.applyFloorFilter();
    this.furniture.end();
    this.lastSyncMs = performance.now() - syncStarted;
  }

  /** Build the label set from projected board state; rendering is screen-space. */
  private clusterMeshes(
    members: { id: string; mesh: THREE.Object3D }[],
    threshold: number
  ): { id: string; mesh: THREE.Object3D }[][] {
    const remaining = new Set(members.map((_, index) => index));
    const clusters: { id: string; mesh: THREE.Object3D }[][] = [];
    const world = new THREE.Vector3();
    while (remaining.size > 0) {
      const seed = remaining.values().next().value as number;
      remaining.delete(seed);
      const cluster = [members[seed]];
      const queue = [seed];
      while (queue.length > 0) {
        const current = members[queue.shift()!];
        const currentWorld = current.mesh.getWorldPosition(world).clone();
        for (const index of [...remaining]) {
          const candidate = members[index];
          const candidateWorld = candidate.mesh.getWorldPosition(world);
          const dx = currentWorld.x - candidateWorld.x;
          const dz = currentWorld.z - candidateWorld.z;
          if (dx * dx + dz * dz <= threshold * threshold) {
            remaining.delete(index);
            cluster.push(candidate);
            queue.push(index);
          }
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }

  private refreshLabels(state: ProjectedGameState): void {
    const labels: WorldLabel[] = [];
    this.groupMembers.clear();
    const activeActor = state.activeActorId ?? state.activePlayerId;
    const isIsolated = state.gameId === 'betrayal' && this.visibleFloor !== 'ALL';

    for (const node of Object.values(state.mapGraph.nodes)) {
      if (node.type !== 'ROOM') continue;
      const floor = String(node.props?.floor ?? '');
      if (isIsolated && floor && floor !== this.visibleFloor) continue;
      labels.push({
        id: `room:${node.id}`,
        text: String(node.props?.name ?? '房间'),
        world: [node.position[0], node.position[1] + 0.25, node.position[2] + 1.0],
        priority: 20,
        kind: 'room'
      });
    }

    for (const player of Object.values(state.players)) {
      if (!player.alive) continue;
      const roomId = String(player.customProps?.currentRoomId ?? '');
      const room = state.mapGraph.nodes[roomId];
      const seat = Object.values(state.mapGraph.nodes).find(
        node => node.type === 'SEAT' && node.props?.playerId === player.id
      );
      // A seat-based table draws its own wooden nameplate, which already carries
      // the nickname and the turn marker — a DOM label on top would double it.
      if (seat) continue;
      const node = room ?? seat;
      if (!node) continue;
      const floor = String(room?.props?.floor ?? '');
      if (isIsolated && floor && floor !== this.visibleFloor) continue;
      labels.push({
        id: `player:${player.id}`,
        text: player.id === activeActor ? `▶ ${player.name}` : player.name,
        world: [node.position[0], node.position[1] + 0.9, node.position[2]],
        priority: player.id === activeActor ? 100 : 60,
        kind: 'player'
      });
    }

    for (const entity of Object.values(state.entities)) {
      const custom = entity.components?.custom;
      if (!custom?.monster || custom.dead) continue;
      const entityId = entity.id;
      if (!entityId) continue;
      const roomNode = state.mapGraph.nodes[String(custom.roomId ?? '')];
      const floor = String(roomNode?.props?.floor ?? '');
      if (isIsolated && floor && floor !== this.visibleFloor) continue;
      const npc = Object.values(state.npcs ?? {}).find(candidate => candidate.entityId === entityId);
      const mesh = this.entityMeshes.get(entityId);
      const spatial = entity.components?.spatial;
      const x = mesh?.position.x ?? spatial?.x ?? 0;
      const y = mesh?.position.y ?? spatial?.y ?? 0;
      const z = mesh?.position.z ?? spatial?.z ?? 0;
      labels.push({
        id: `monster:${entityId}`,
        text: String(custom.name ?? '怪物'),
        world: [x, y + 0.65, z],
        priority: npc?.id === activeActor ? 100 : 75,
        kind: 'monster'
      });
    }

    for (const [_zoneId, zone] of Object.entries(state.zones)) {
      // Pokémon Splendor labels its own table: deck piles, per-colour tableau
      // badges and the buried count. The generic same-card clustering would
      // stack a second, floating "卡名 ×N" chip over the market whenever two
      // cards in one row share a name (two 蚊香蝌蚪 at different tiers, say),
      // so that pass is skipped for this game.
      if (state.gameId === 'splendor') continue;
      // The viewer's own hand rides the camera; a world-anchored label would
      // detach from it as soon as the camera moves. Its cards are large and
      // face-on, so the generic cluster chip is unnecessary.
      if (this.handRows.get(zone.id)?.cameraAttached) continue;
      const groups = buildCardGroups(zone, state.entities as unknown as Record<string, Entity>);
      for (const group of groups) {
        if (group.count < 2) continue;
        const members = group.entityIds
          .map(id => ({ id, mesh: this.entityMeshes.get(id) }))
          .filter((entry): entry is { id: string; mesh: THREE.Object3D } => !!entry.mesh)
          // 牌背/被遮挡的牌不挂 `卡名 ×N` 标签：它只会显示成 "Hi… ×2" 这种
          // 被截断的占位文案，既没信息量又挡住桌面（用户 2026-11 反馈）。
          .filter(entry => !state.entities[entry.id]?.isMasked);
        if (members.length < 2) continue;
        for (const cluster of this.clusterMeshes(members, 2.4)) {
          if (cluster.length < 2) continue;
          const world = new THREE.Vector3();
          const center = cluster.reduce<[number, number, number]>(
            (sum, member) => {
              member.mesh.getWorldPosition(world);
              return [sum[0] + world.x, sum[1] + world.y, sum[2] + world.z];
            },
            [0, 0, 0]
          );
          const first = state.entities[group.topId];
          const title =
            first?.components?.cardFace?.title ??
            String(first?.components?.custom?.zh ?? first?.components?.custom?.defId ?? group.defId);
          const id = `${group.id}:${cluster[0].id}`;
          labels.push({
            id,
            text: title,
            count: cluster.length,
            world: [
              center[0] / cluster.length,
              center[1] / cluster.length + 0.55,
              center[2] / cluster.length
            ],
            priority: 60,
            kind: 'group',
            interactive: true,
            groupId: id
          });
          this.groupMembers.set(id, cluster.map(member => member.id));
        }
      }
    }

    for (const id of this.highlightIds) {
      const entity = state.entities[id];
      const mesh = this.entityMeshes.get(id);
      if (!entity || !mesh) continue;
      const text =
        entity.components?.cardFace?.title ??
        String(entity.components?.custom?.zh ?? entity.components?.custom?.name ?? entity.id);
      const world = mesh.getWorldPosition(new THREE.Vector3());
      labels.push({
        id: `card:${id}`,
        text,
        world: [world.x, world.y + 0.4, world.z],
        priority: 95,
        kind: 'card'
      });
    }

    if (this.hoveredEntityId && !this.highlightIds.has(this.hoveredEntityId)) {
      const entity = state.entities[this.hoveredEntityId];
      const mesh = this.entityMeshes.get(this.hoveredEntityId);
      if (entity && mesh) {
        const world = mesh.getWorldPosition(new THREE.Vector3());
        labels.push({
          id: `card:${this.hoveredEntityId}`,
          text:
            entity.components?.cardFace?.title ??
            String(entity.components?.custom?.zh ?? entity.components?.custom?.name ?? entity.id),
          world: [world.x, world.y + 0.4, world.z],
          priority: 96,
          kind: 'card'
        });
      }
    }

    this.labels.setLabels(labels);
  }

  private labelObstacles(): ScreenRect[] {
    const base = this.container.getBoundingClientRect();
    const obstacles: ScreenRect[] = [];
    for (const selector of ['.topbar', '.player-rail', '.action-dock', '.math-inspector-panel']) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        obstacles.push({
          x: rect.left - base.left,
          y: rect.top - base.top,
          width: rect.width,
          height: rect.height
        });
      }
    }
    return obstacles;
  }

  /** Lightweight profiling seam for deciding whether scene diffing is needed. */
  public getRenderStats(): RenderStats {
    const info = this.renderer.info;
    const cache = this.furniture.stats();
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      lastSyncMs: Math.round(this.lastSyncMs * 100) / 100,
      boardRebuilds: this.boardRebuildCount,
      cachedObjects: cache.hits,
      rebuiltObjects: cache.misses,
      evictedObjects: cache.evictions
    };
  }

  private clearPreviewObjects(): void {
    for (const object of this.previewObjects) {
      this.boardObjectsGroup.remove(object);
      this.disposeObject3D(object);
    }
    this.previewObjects = [];
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Remove and release GPU-side resources; shared texture caches stay alive. */
  private clearBoardObjects(): void {
    this.physics.clear();
    this.highlightedMeshes.clear();
    this.navArrowMeshes = [];
    this.restoreDraggedCard();
    this.handRows.clear();
    this.animatingActionCardIds.clear();
    this.deckPiles.clear();
    this.draggedDeckZoneId = undefined;
    this.dealerAreaCardIds.clear();
    this.dealerAreaFloatItems = [];
    this.dealerAreaHovered = false;
    this.ownHandReady = false;
    this.ownHandCut = undefined;
    this.ownHandShadows.clear();
    for (const group of [this.boardObjectsGroup, this.ownHandGroup, this.dealerAreaGroup]) {
      while (group.children.length > 0) {
        const child = group.children[0];
        group.remove(child);
        this.disposeObject3D(child);
      }
    }
  }

  private disposeObject3D(root: THREE.Object3D): void {
    root.traverse(child => {
      const mesh = child as THREE.Mesh;
      // Room tiles are cloned from a cached template and share geometry.
      if (mesh.geometry && !child.userData?.sharedGeometry) mesh.geometry.dispose();
      const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (!material) return;
      const materials = Array.isArray(material) ? material : [material];
      for (const entry of materials) {
        // Pooled palette materials are reused across every room rebuild.
        if (entry.userData?.shared) continue;
        if (child.userData?.ownedTexture && 'map' in entry) {
          (entry as THREE.MeshBasicMaterial).map?.dispose();
        }
        entry.dispose();
      }
    });
  }

  /**
   * Highlight a set of interactive candidates (board targets, cards).
   * Incrementally updates visual highlights and label overlay without destroying/rebuilding the board.
   */
  public setHighlight(ids: string[] | null, _resync = true): void {
    const next = new Set(ids ?? []);
    if (this.highlightIds.size === next.size && [...this.highlightIds].every(id => next.has(id))) {
      return;
    }
    this.highlightIds = next;
    this.applyHighlights();
    if (this.lastState) {
      this.refreshLabels(this.lastState);
    }
  }

  public getHighlight(): string[] {
    return [...this.highlightIds];
  }

  private applyHighlights(): void {
    // 1. Put the original material back on every previously highlighted mesh.
    //    Swapping the reference (instead of copying values into the material)
    //    means a shared material can never be left tinted.
    for (const [mesh, original] of this.highlightedMeshes) {
      const tinted = mesh.material;
      mesh.material = original;
      const originalList = Array.isArray(original) ? original : [original];
      for (const mat of Array.isArray(tinted) ? tinted : [tinted]) {
        if (!originalList.includes(mat)) mat.dispose();
      }
    }
    this.highlightedMeshes.clear();
    for (const halo of this.highlightHalos) {
      halo.parent?.remove(halo);
      halo.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const mat = mesh.material;
        for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
      });
    }
    this.highlightHalos = [];

    if (this.highlightIds.size === 0) return;

    // 2. Give each highlighted mesh its own cloned, tinted material.
    const pulse = (obj: THREE.Object3D) => {
      obj.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || this.highlightedMeshes.has(mesh)) return;

        const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const clones = source.map(mat => {
          const clone = mat.clone() as THREE.MeshStandardMaterial;
          if ('emissive' in clone && clone.emissive) {
            // Hot amber at full strength: the old 0.85 on a dark felt read as a
            // slightly warm card rather than "this one, right now".
            clone.emissive = new THREE.Color(0xffc247);
            clone.emissiveIntensity = 1.9;
          } else if ('color' in clone && (clone as unknown as THREE.MeshBasicMaterial).color) {
            // SAFETY: MeshBasicMaterial and MeshStandardMaterial both implement color and opacity in Three.js runtime
            const basic = clone as unknown as THREE.MeshBasicMaterial;
            basic.color = new THREE.Color(0xf6dc9c);
            basic.opacity = 0.85;
          }
          return clone;
        });

        this.highlightedMeshes.set(mesh, mesh.material);
        mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
      });
    };

    this.highlightIds.forEach(id => {
      const obj = this.nodeMeshes.get(id) || this.edgeMeshes.get(id) || this.entityMeshes.get(id);
      if (!obj) return;
      pulse(obj);
      this.addHighlightHalo(obj);
    });
  }

  /**
   * A bright frame around one highlighted object.
   *
   * The emissive tint alone is easy to miss on a dark felt, especially when the
   * card's own artwork is light: the outline is what makes the pick unambiguous
   * at any camera angle.
   */
  private addHighlightHalo(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // A thin plate just under the object, a touch larger than it: it reads as a
    // glow ring from above and never hides the artwork.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(size.x * 1.14, 0.012, size.z * 1.14),
      new THREE.MeshBasicMaterial({ color: 0xffc247, transparent: true, opacity: 0.9 })
    );
    plate.position.set(center.x, box.min.y - 0.008, center.z);
    plate.renderOrder = 2;
    plate.userData.ownedGeometry = true;
    this.boardObjectsGroup.add(plate);
    this.highlightHalos.push(plate);

    // Four corner ticks so the frame still reads when the plate is occluded by
    // neighbouring cards.
    const tickLen = Math.min(size.x, size.z) * 0.28;
    const tickY = box.max.y + 0.02;
    const corners: [number, number][] = [
      [box.min.x, box.min.z],
      [box.max.x, box.min.z],
      [box.min.x, box.max.z],
      [box.max.x, box.max.z]
    ];
    for (const [cx, cz] of corners) {
      const dx = cx === box.min.x ? 1 : -1;
      const dz = cz === box.min.z ? 1 : -1;
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(tickLen, 0.01, 0.03),
        new THREE.MeshBasicMaterial({ color: 0xffd977, transparent: true, opacity: 0.95 })
      );
      tick.position.set(cx + (dx * tickLen) / 2, tickY, cz);
      this.boardObjectsGroup.add(tick);
      this.highlightHalos.push(tick);

      const tickZ = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.01, tickLen),
        new THREE.MeshBasicMaterial({ color: 0xffd977, transparent: true, opacity: 0.95 })
      );
      tickZ.position.set(cx, tickY, cz + (dz * tickLen) / 2);
      this.boardObjectsGroup.add(tickZ);
      this.highlightHalos.push(tickZ);
    }
  }

  /**
   * Badges for moves the door grid cannot express.
   *
   * Stairs join rooms that share a grid cell across floors, the balcony drops
   * one floor, the rappel edge climbs back up, and the observatory lift reaches
   * any explored room. Without these the only way to use them was the action
   * dock, which is exactly the menu digging this pass removes.
   *
   * The drop is free, so it stays offered even with no moves left; stairs, the
   * rappel and the lift all spend a move and disappear at zero.
   */
  private addSpecialTraversalHints(
    state: ProjectedGameState,
    node: ProjectedGameState['mapGraph']['nodes'][string],
    nodeId: string,
    movesLeft = 0
  ): void {
    const canSpendMove = movesLeft > 0;
    const edges = Object.values(state.mapGraph.edges ?? {});
    const badges: {
      icon: string;
      label: string;
      color: string;
      metadata: Record<string, unknown>;
    }[] = [];

    const seenTargets = new Set<string>();

    for (const edge of edges) {
      const from = String((edge as { from?: string }).from ?? '');
      const to = String((edge as { to?: string }).to ?? '');
      const type = String((edge as { type?: string }).type ?? '');
      const isDirected = !!(edge as { directed?: boolean }).directed;

      let targetRoomId = '';
      if (from === nodeId) {
        targetRoomId = to;
      } else if (to === nodeId && !isDirected) {
        targetRoomId = from;
      }
      if (!targetRoomId || seenTargets.has(targetRoomId)) continue;

      const other = state.mapGraph.nodes[targetRoomId];
      if (!other) continue;

      if (type === 'STAIRS' && canSpendMove) {
        seenTargets.add(targetRoomId);
        const FLOOR_LEVEL: Record<string, number> = {
          BASEMENT: 0,
          GROUND: 1,
          UPPER: 2
        };
        const currentFloor = String(node.props?.floor ?? 'GROUND');
        const targetFloor = String(other.props?.floor ?? 'GROUND');
        const up = (FLOOR_LEVEL[targetFloor] ?? 1) > (FLOOR_LEVEL[currentFloor] ?? 1);
        badges.push({
          icon: up ? '⬆' : '⬇',
          label: up ? '上楼' : '下楼',
          color: up ? '#86a8c4' : '#d9b45b',
          metadata: {
            type: 'ROOM_NAV',
            fromRoomId: nodeId,
            targetRoomId,
            targetName: String(other.props?.name ?? '楼梯'),
            intent: 'interact'
          }
        });
      } else if (type === 'DROP' && canSpendMove && from === nodeId) {
        seenTargets.add(targetRoomId);
        badges.push({
          icon: '⬇',
          label: '跳下',
          color: '#e0a25c',
          metadata: {
            type: 'SPECIAL_MOVE',
            action: 'JUMP_DOWN',
            fromRoomId: nodeId,
            targetRoomId: to,
            targetName: String(other.props?.name ?? '舞厅'),
            intent: 'interact'
          }
        });
      }
    }

    // Rappel back up a drop edge when carrying rope.
    if (canSpendMove && !badges.some(badge => badge.metadata.action === 'JUMP_DOWN')) {
      for (const edge of edges) {
        const to = String((edge as { to?: string }).to ?? '');
        const type = String((edge as { type?: string }).type ?? '');
        if (to !== nodeId || type !== 'DROP') continue;
        const from = String((edge as { from?: string }).from ?? '');
        const upper = state.mapGraph.nodes[from];
        if (!upper) continue;
        badges.push({
          icon: '🪢',
          label: '攀绳',
          color: '#57c08b',
          metadata: {
            type: 'SPECIAL_MOVE',
            action: 'CLIMB_UP',
            fromRoomId: nodeId,
            targetRoomId: from,
            targetName: String(upper.props?.name ?? '上层'),
            intent: 'interact'
          }
        });
      }
    }

    if (canSpendMove && String(node.props?.special ?? '') === 'ELEVATOR') {
      badges.push({
        icon: '🛗',
        label: '乘电梯',
        color: '#b07bf0',
        metadata: { type: 'SPECIAL_MOVE', action: 'USE_ELEVATOR', fromRoomId: nodeId, intent: 'interact' }
      });
    }

    // Actionable room feature: the vault stays closed until someone cracks it.
    if (String(node.props?.special ?? '') === 'VAULT' && !node.props?.opened) {
      badges.push({
        icon: '🗄',
        label: '撬开金库',
        color: '#d9b45b',
        metadata: { type: 'ROOM_FEATURE', feature: 'VAULT', fromRoomId: nodeId, intent: 'interact' }
      });
    }

    // Passive hazard marker: indicates when debuffs take effect
    // (on entry vs on ending turn). Not clickable — pure informative billboard.
    const HAZARD: Record<string, { icon: string; label: string; color: string }> = {
      COAL_CHUTE: { icon: '⚠', label: '煤槽 · 滑落地下室', color: '#c9a24a' },
      COLLAPSED: { icon: '⚠', label: '坍塌 · 入内速度检定', color: '#c9a24a' },
      FURNACE: { icon: '⚠', label: '熔炉 · 停留灼伤', color: '#c9a24a' }
    };
    const hazard = HAZARD[String(node.props?.special ?? '')];
    const nodeFloor = String(node.props?.floor ?? '');
    if (hazard) {
      const plate = this.createLabelSprite(`${hazard.icon} ${hazard.label}`, hazard.color, 24);
      plate.position.set(node.position[0], node.position[1] + 0.72, node.position[2] + 1.02);
      plate.scale.set(1.7, 0.32, 1);
      plate.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(plate);
    }

    badges.forEach((badge, index) => {
      const angle = -Math.PI / 2 + (index - (badges.length - 1) / 2) * 0.72;
      const bx = node.position[0] + Math.cos(angle) * 0.62;
      const bz = node.position[2] + Math.sin(angle) * 0.62 + 0.42;

      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(0.19, 0.19, 0.03, 20),
        new THREE.MeshStandardMaterial({
          color: badge.color,
          emissive: badge.color,
          emissiveIntensity: 0.65,
          roughness: 0.35
        })
      );
      plate.position.set(bx, node.position[1] + 0.14, bz);
      plate.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(plate);
      const plateMat = plate.material as THREE.MeshStandardMaterial;
      const pulseTarget = new THREE.Group();
      pulseTarget.position.copy(plate.position);
      plate.position.set(0, 0, 0);
      pulseTarget.add(plate);
      pulseTarget.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(pulseTarget);
      this.navArrowMeshes.push({
        group: pulseTarget,
        material: plateMat,
        baseIntensity: 0.65,
        baseY: node.position[1] + 0.14
      });

      const glyph = this.createLabelSprite(`${badge.icon} ${badge.label}`, badge.color, 26);
      glyph.position.set(bx, node.position[1] + 0.42, bz);
      glyph.scale.set(1.35, 0.3, 1);
      glyph.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(glyph);

      const interactiveId = `${nodeId}:special:${badge.metadata.action ?? 'nav'}:${String(badge.metadata.targetRoomId ?? '')}`;
      this.raycaster.registerInteractive(plate, {
        type: 'NODE',
        id: interactiveId,
        metadata: badge.metadata
      });
      this.raycaster.registerInteractive(glyph, {
        type: 'NODE',
        id: interactiveId,
        metadata: badge.metadata
      });
    });
  }

  private createFloorNavArrow(
    dir: 'N' | 'S' | 'E' | 'W',
    kind: 'NAV' | 'EXPLORE' | 'CHECK' | 'LOCKED',
    targetName: string
  ): { group: THREE.Group; material: THREE.MeshStandardMaterial } {
    const group = new THREE.Group();
    const isNav = kind === 'NAV';
    const isDanger = kind === 'CHECK' || kind === 'LOCKED';
    // Green = a plain move, amber = an unexplored doorway, red = passing this way
    // costs something (a trait check) or is impossible (the locked front door).
    const mainColor = isDanger ? 0xe23b2a : isNav ? 0x22dd77 : 0xe5a93c;
    const emissiveColor = isDanger ? 0xa11f12 : isNav ? 0x11bb66 : 0x9e6c1a;

    const arrowMat = new THREE.MeshStandardMaterial({
      color: mainColor,
      emissive: emissiveColor,
      emissiveIntensity: 1.0,
      roughness: 0.25,
      metalness: 0.1
    });

    // 2-part chevron on the floor: angled bars forming a chevron pointing forward (+Z local)
    const barGeom = new THREE.BoxGeometry(0.08, 0.024, 0.32);
    const leftBar = new THREE.Mesh(barGeom, arrowMat);
    leftBar.position.set(-0.11, 0.012, -0.06);
    leftBar.rotation.y = Math.PI / 4;
    group.add(leftBar);

    const rightBar = new THREE.Mesh(barGeom, arrowMat);
    rightBar.position.set(0.11, 0.012, -0.06);
    rightBar.rotation.y = -Math.PI / 4;
    group.add(rightBar);

    // Tip marker
    const tipGeom = new THREE.BoxGeometry(0.07, 0.025, 0.07);
    const tip = new THREE.Mesh(tipGeom, arrowMat);
    tip.position.set(0, 0.012, 0.07);
    tip.rotation.y = Math.PI / 4;
    group.add(tip);

    // Floor glowing aura disc
    const auraGeom = new THREE.CircleGeometry(0.36, 16);
    const auraMat = new THREE.MeshBasicMaterial({
      color: mainColor,
      transparent: true,
      opacity: 0.28,
      depthWrite: false
    });
    const aura = new THREE.Mesh(auraGeom, auraMat);
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.004;
    group.add(aura);

    // Floating text label
    const labelText = isNav ? `→ ${targetName}` : '▲ 探索';
    const label = this.createLabelSprite(
      labelText,
      isNav ? '#55ffaa' : '#f5c058',
      24
    );
    label.position.set(0, 0.24, 0);
    label.scale.set(1.4, 0.26, 1);
    group.add(label);

    const yAngles: Record<string, number> = {
      S: 0,
      N: Math.PI,
      E: Math.PI / 2,
      W: -Math.PI / 2
    };
    group.rotation.y = yAngles[dir] ?? 0;

    return { group, material: arrowMat };
  }

  private updateNavArrows(now: number): void {
    if (this.navArrowMeshes.length === 0) return;
    const pulse = 0.85 + 0.35 * Math.sin(now * 0.006);
    for (const item of this.navArrowMeshes) {
      if (item.material) item.material.emissiveIntensity = item.baseIntensity * pulse;
      if (item.group) item.group.position.y = item.baseY + 0.012 * Math.sin(now * 0.005);
    }
  }

  private renderMapGraph(state: ProjectedGameState): void {
    const graph = state.mapGraph;

    // The board group is rebuilt from scratch every sync, so the standee list is
    // rebuilt with it.
    this.seatStandees = [];
    this.seatBeacons = [];
    const seatNodes = Object.values(graph.nodes).filter(node => node.type === 'SEAT');
    if (seatNodes.length > 0) {
      const rx = Math.max(3.6, ...seatNodes.map(node => Math.abs(node.position[0]))) + 1.1;
      const rz = Math.max(2.6, ...seatNodes.map(node => Math.abs(node.position[2]))) + 1.1;
      this.tableInnerOval = { rx: rx + 0.35, rz: rz + 0.35 };
    }

    // Render Nodes
    Object.values(graph.nodes).forEach(node => {
      if (node.type === 'HEX') {
        const resource = node.props.resource || 'wood';
        const hexMesh = this.furniture.obtain(
          `node:${node.id}`,
          signatureOf('hex', 2.15, resource, node.props.diceNumber, node.props.hasRobber),
          () =>
            HexTileBuilder.createHexTileMesh(
              2.15,
              resource,
              node.props.diceNumber,
              node.props.hasRobber
            )
        );
        hexMesh.position.set(node.position[0], node.position[1], node.position[2]);
        this.boardObjectsGroup.add(hexMesh);
        this.nodeMeshes.set(node.id, hexMesh);

        this.raycaster.registerInteractive(hexMesh, {
          type: 'NODE',
          id: node.id,
          metadata: node.props
        });
      } else if (node.type === 'VERTEX') {
        // Vertex spot for settlements
        // Render subtle clickable marker if unoccupied
        if (!node.occupantEntityId) {
          const vMesh = this.furniture.obtain('vertex-marker', 'vertex', () => {
            const vGeom = new THREE.CylinderGeometry(0.17, 0.17, 0.04, 12);
            const vMat = new THREE.MeshBasicMaterial({
              color: 0xd9b45b,
              transparent: true,
              opacity: 0.22
            });
            return new THREE.Mesh(vGeom, vMat);
          });
          vMesh.position.set(node.position[0], 0.205, node.position[2]);
          this.boardObjectsGroup.add(vMesh);
          this.nodeMeshes.set(node.id, vMesh);

          this.raycaster.registerInteractive(vMesh, {
            type: 'NODE',
            id: node.id,
            metadata: { type: 'VERTEX' }
          });
        }
      } else if (node.type === 'ROOM') {
        // Betrayal room tile: 2.5D diorama with a door-aware furniture layout.
        const roomId = node.id.startsWith('room_') ? node.id.slice(5) : node.id;
        const roomFloor = String(node.props.floor ?? '');
        // The room shell is pure furniture: same props → same diorama. Door
        // hotspots and navigation arrows are built below and stay per-sync,
        // because they depend on where the active explorer stands.
        const roomMesh = this.furniture.obtain(
          `node:${node.id}`,
          signatureOf(
            'room',
            node.props.name,
            node.props.color,
            node.props.doors,
            roomFloor,
            node.props.special,
            node.props.tags,
            node.props.symbol,
            node.props.frontDoor
          ),
          () =>
            RoomTileBuilder.createRoomMesh(
              node.props.name || 'Room',
              2.84,
              node.props.color,
              node.props.doors,
              {
                roomId,
                floor: node.props.floor,
                special: node.props.special,
                tags: node.props.tags,
                symbol: node.props.symbol,
                frontDoor: node.props.frontDoor
              }
            )
        );
        roomMesh.position.set(node.position[0], node.position[1], node.position[2]);
        // Tagged so the floor filter can hide/show whole rooms without a rebuild.
        roomMesh.userData.floor = roomFloor;
        this.boardObjectsGroup.add(roomMesh);
        this.nodeMeshes.set(node.id, roomMesh);

        // Active actor movement & door exploration navigation
        const focusActorId =
          state.viewerId !== 'GOD'
            ? state.viewerId
            : (state.activeActorId ?? state.activePlayerId);
        const activeActor = state.players[focusActorId] ?? state.npcs?.[focusActorId];
        const currentActorRoomId = String(
          activeActor?.customProps?.currentRoomId ?? activeActor?.customProps?.roomId ?? ''
        );
        const movesLeft = Number(activeActor?.customProps?.movesLeft ?? 0);
        const isCurrentActorRoom = node.id === currentActorRoomId;

        // Register interactive door exploration and navigation hotspots
        const doors = (node.props.doors ?? []) as ('N' | 'S' | 'E' | 'W')[];
        const halfSize = 2.84 / 2;
        const DIR_DELTAS: Record<string, [number, number]> = {
          N: [0, -1],
          S: [0, 1],
          E: [1, 0],
          W: [-1, 0]
        };
        const OPPOSITES: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };

        for (const dir of doors) {
          const delta = DIR_DELTAS[dir] ?? [0, 0];
          const nodeCol = Number(node.props?.col);
          const nodeRow = Number(node.props?.row);
          const nodeFloor = String(node.props?.floor ?? '');

          const neighborRoom = Object.values(state.mapGraph.nodes).find(other => {
            const p = other.props;
            return (
              other.type === 'ROOM' &&
              p?.floor === nodeFloor &&
              Number(p?.col) === nodeCol + delta[0] &&
              Number(p?.row) === nodeRow + delta[1]
            );
          });

          const neighborDoors = Array.isArray(neighborRoom?.props?.doors) ? neighborRoom.props.doors : [];
          const isConnected = !!(
            neighborRoom &&
            neighborDoors.includes(OPPOSITES[dir]) &&
            (node.neighbors.includes(neighborRoom.id) ||
              !!state.mapGraph.edges[`edge_${node.id}_${neighborRoom.id}`] ||
              !!state.mapGraph.edges[`edge_${neighborRoom.id}_${node.id}`])
          );

          const doorGeom = new THREE.BoxGeometry(
            dir === 'N' || dir === 'S' ? 0.96 : 0.24,
            0.45,
            dir === 'W' || dir === 'E' ? 0.96 : 0.24
          );
          const doorMat = new THREE.MeshBasicMaterial({ visible: false });
          const doorMesh = new THREE.Mesh(doorGeom, doorMat);
          const dx = dir === 'W' ? -halfSize : dir === 'E' ? halfSize : 0;
          const dz = dir === 'N' ? -halfSize : dir === 'S' ? halfSize : 0;
          doorMesh.position.set(node.position[0] + dx, node.position[1] + 0.22, node.position[2] + dz);
          doorMesh.userData.floor = nodeFloor;
          this.boardObjectsGroup.add(doorMesh);

          const CHECK_ON_ENTRY = new Set(['COLLAPSED', 'COAL_CHUTE', 'FURNACE']);
          if (isConnected && neighborRoom) {
            const targetName = String(neighborRoom.props?.name ?? '相邻房间');
            if (isCurrentActorRoom && movesLeft > 0) {
              // Red when stepping through costs a check or health.
              const navKind = CHECK_ON_ENTRY.has(String(neighborRoom.props?.special ?? ''))
                ? 'CHECK'
                : 'NAV';
              const { group: navArrow, material } = this.createFloorNavArrow(dir, navKind, targetName);
              const ax = dir === 'W' ? -1.02 : dir === 'E' ? 1.02 : 0;
              const az = dir === 'N' ? -1.02 : dir === 'S' ? 1.02 : 0;
              const arrowY = node.position[1] + 0.125;
              navArrow.position.set(node.position[0] + ax, arrowY, node.position[2] + az);
              navArrow.userData.floor = nodeFloor;
              this.boardObjectsGroup.add(navArrow);

              this.navArrowMeshes.push({
                group: navArrow,
                material,
                baseIntensity: 1.0,
                baseY: arrowY
              });

              this.raycaster.registerInteractive(navArrow, {
                type: 'NODE',
                id: `${node.id}:nav:${neighborRoom.id}`,
                metadata: {
                  type: 'ROOM_NAV',
                  fromRoomId: node.id,
                  targetRoomId: neighborRoom.id,
                  targetName,
                  direction: dir,
                  intent: 'interact'
                }
              });
            }

            this.raycaster.registerInteractive(doorMesh, {
              type: 'NODE',
              id: `${node.id}:door_nav:${neighborRoom.id}`,
              metadata: {
                type: 'ROOM_NAV',
                fromRoomId: node.id,
                targetRoomId: neighborRoom.id,
                targetName,
                direction: dir,
                intent: 'interact'
              }
            });
          } else if (!neighborRoom) {
            if (isCurrentActorRoom && movesLeft > 0) {
              const isLockedFrontDoor =
                node.props.special === 'FRONT_DOOR' &&
                node.props.frontDoor === dir &&
                state.globalVars.frontDoorLocked !== false;
              const { group: exploreArrow, material } = this.createFloorNavArrow(
                dir,
                isLockedFrontDoor ? 'LOCKED' : 'EXPLORE',
                isLockedFrontDoor ? '前门锁死' : '探索'
              );
              const ax = dir === 'W' ? -1.02 : dir === 'E' ? 1.02 : 0;
              const az = dir === 'N' ? -1.02 : dir === 'S' ? 1.02 : 0;
              const arrowY = node.position[1] + 0.125;
              exploreArrow.position.set(node.position[0] + ax, arrowY, node.position[2] + az);
              exploreArrow.userData.floor = nodeFloor;
              this.boardObjectsGroup.add(exploreArrow);

              this.navArrowMeshes.push({
                group: exploreArrow,
                material,
                baseIntensity: 0.9,
                baseY: arrowY
              });

              this.raycaster.registerInteractive(exploreArrow, {
                type: 'NODE',
                id: `${node.id}:explore:${dir}`,
                metadata: {
                  type: 'DOOR',
                  roomId: node.id,
                  direction: dir,
                  name: node.props.name ?? '当前房间',
                  intent: 'interact'
                }
              });
            }

            this.raycaster.registerInteractive(doorMesh, {
              type: 'NODE',
              id: `${node.id}:door:${dir}`,
              metadata: {
                type: 'DOOR',
                roomId: node.id,
                direction: dir,
                name: node.props.name ?? '当前房间',
                intent: 'interact'
              }
            });
          }
        }

        // Special traversal: stairs between floors, the observatory lift, the
        // collapsed floor and the balcony drop are all one-way or cross-floor
        // links the plain door arrows cannot express.
        if (isCurrentActorRoom) {
          this.addSpecialTraversalHints(state, node, node.id, movesLeft);
        }

        const symbol = node.props?.symbol as string | undefined;
        if (symbol) {
          const icon = symbol === 'EVENT' ? '✦' : symbol === 'ITEM' ? '◆' : '👁';
          const color = symbol === 'EVENT' ? '#e0a25c' : symbol === 'ITEM' ? '#78d6a4' : '#c79bf0';
          const badge = this.createLabelSprite(icon, color, 46);
          badge.position.set(node.position[0] + 0.95, 0.34, node.position[2] - 0.95);
          badge.scale.set(0.42, 0.42, 1);
          badge.userData.floor = roomFloor;
          this.boardObjectsGroup.add(badge);
        }

        // Room names are rendered by the DOM label overlay for collision-free layout.

        this.raycaster.registerInteractive(roomMesh, {
          type: 'NODE',
          id: node.id,
          metadata: node.props
        });
      } else if (node.type === 'SEAT') {
        // Seat standee: a black metal disc on the felt with a card-sized walnut
        // board leaning back on it (avatar coin, nickname, key numbers). It is
        // also the click target that opens the player sheet.
        const seatId = String(node.props?.playerId ?? '');
        const seatPlayer = state.players[seatId];
        const activeActor = state.activeActorId ?? state.activePlayerId;
        const [seatX, , seatZ] = node.position;
        const seatLength = Math.max(0.0001, Math.hypot(seatX, seatZ));
        const outward = new THREE.Vector2(seatX / seatLength, seatZ / seatLength);
        const marker = state.gameId === 'poker' ? '♠' : state.gameId === 'sanguosha' ? '⚔' : undefined;

        // Blinds get their own timber: pine for the big blind, red pine for the
        // small blind, walnut for the rest of the table.
        const handState = state.globalVars.hand as
          | {
              sbSeat?: number;
              bbSeat?: number;
              lastActions?: Record<string, string>;
              folded?: string[];
              street?: string;
              streetBets?: Record<string, number>;
              readyForNext?: string[];
            }
          | undefined;
        const seatIndex = Number(node.props?.seatIndex ?? -1);
        const wood: WoodKind =
          state.gameId === 'poker' && handState
            ? handState.bbSeat === seatIndex
              ? 'pine'
              : handState.sbSeat === seatIndex
                ? 'redPine'
                : 'walnut'
            : 'walnut';

        const { group, plate, lamp } = SeatPlateBuilder.createStandee(
          {
            name: seatPlayer?.name ?? seatId,
            avatar: seatPlayer?.avatar ?? '👤',
            avatarUrl: seatPlayer?.avatarUrl,
            color: seatPlayer?.color ?? '#455a64',
            detail: this.seatPlateDetail(state, seatId),
            chips: String(seatPlayer?.customProps?.chips ?? ''),
            active: seatId === activeActor,
            muted: seatPlayer ? !seatPlayer.alive : false,
            marker,
            // 底座半圆环的三态：轮到 = 红，已准备待命 = 白，未准备 = 磨砂白。
            lamp: seatId === activeActor ? 'turn' : seatReadyForPlay(state, handState, seatId) ? 'idle' : 'off',
            // What this seat did on the current street, painted on the board.
            // A fold outlives its street: once a seat is out of the hand the board
            // keeps saying so until the next hand starts.
            action: handState?.folded?.includes(seatId)
              ? '弃牌'
              : handState?.lastActions?.[seatId],
            wood
          },
          outward
        );
        group.position.set(seatX, 0.055, seatZ);
        // The board tracks the camera (see `updateSeatStandees`) but keeps a
        // per-seat random offset of ±30°: perfectly aligned boards hide the
        // structure of the table and read as a HUD, not as objects. The offset is
        // hashed from the seat id, so a rebuilt sync keeps the same pose.
        // 朝向随镜头（立牌面向观察者），但每座只带 ±20° 的固定偏摆，
        // 免得整桌板子像复制粘贴一样整齐。
        const jitter = (((fnv1a(seatId) % 1000) / 1000) - 0.5) * ((Math.PI * 2) / 9);
        group.rotation.y = Math.atan2(-outward.x, -outward.y) + jitter;
        this.seatStandees.push({ group, jitter, lamp, seatId });
        this.boardObjectsGroup.add(group);

        // 视角定位标：放在「这个座位的默认机位」正下方的地面上——也就是
        // `setSeatView` 里那台相机脚下的位置。竖线高度跟那台相机一样高，所以
        // 站在任何座位看过去，线顶正好是自己眼睛的高度。
        {
          const span = Math.max(
            ...seatNodes.map(entry => Math.abs(entry.position[0])),
            4
          );
          // 视角定位标：活动范围在「绿圈（内层椭圆牌桌）与红圈（外层大方桌木沿）」之间
          const back = Math.max(7, span * 1.05);
          const eye = 2 + back * 0.29;
          const defaultCamX = seatX + outward.x * back;
          const defaultCamZ = seatZ + outward.y * back;
          const clamped = this.clampBeaconPosition(defaultCamX, defaultCamZ, outward);
          const seatCamPos = new THREE.Vector3(defaultCamX, eye, defaultCamZ);
          const beacon = this.createSeatBeacon(
            clamped.x,
            clamped.z,
            eye,
            seatPlayer,
            Number(handState?.streetBets?.[seatId] ?? 0)
          );
          this.seatBeacons.push({
            ...beacon,
            seatCamPos,
            defaultOutward: { x: outward.x, y: outward.y },
            seatId
          });
          this.boardObjectsGroup.add(beacon.group);
        }
        this.raycaster.registerInteractive(plate, {
          type: 'NODE',
          id: node.id,
          metadata: { type: 'SEAT', playerId: seatId }
        });
        this.nodeMeshes.set(node.id, plate);
      }
    });

    // Render Edges (Catan Road Slots)
    Object.values(graph.edges).forEach(edge => {
      if (edge.type === 'ROAD_SLOT' && !edge.occupantEntityId) {
        const fromNode = graph.nodes[edge.from];
        const toNode = graph.nodes[edge.to];
        if (fromNode && toNode) {
          const mx = (fromNode.position[0] + toNode.position[0]) / 2;
          const mz = (fromNode.position[2] + toNode.position[2]) / 2;

          const slotGeom = new THREE.BoxGeometry(0.18, 0.04, 1.2);
          const slotMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.2
          });
          const slotMesh = new THREE.Mesh(slotGeom, slotMat);
          slotMesh.position.set(mx, 0.195, mz);

          // Align rotation with edge angle
          const angle = Math.atan2(toNode.position[0] - fromNode.position[0], toNode.position[2] - fromNode.position[2]);
          slotMesh.rotation.y = angle;

          this.boardObjectsGroup.add(slotMesh);
          this.edgeMeshes.set(edge.id, slotMesh);

          this.raycaster.registerInteractive(slotMesh, {
            type: 'EDGE',
            id: edge.id,
            metadata: { type: 'ROAD_SLOT' }
          });
        }
      }
    });

    // An elevator ride in progress marks every empty doorway it may dock at.
    this.addElevatorDoorwayHints(state);
  }

  /**
   * Yellow arrows on every empty doorway the elevator may dock at.
   *
   * The ride resolves in two steps (roll, then pick), and the pick is a DOORWAY
   * rather than a room: the doorway fixes both where the car lands and which way
   * its single door faces, so this reuses the explore arrow the placement flow
   * already draws.
   */
  private addElevatorDoorwayHints(state: ProjectedGameState): void {
    const globals = state.globalVars as Record<string, unknown> | undefined;
    const ride = globals?.elevatorRide as
      | { sum: number; fromFloor: string; allowSameFloorOnly: boolean }
      | null
      | undefined;
    if (!ride || ride.sum < 2) return;

    const OFFSETS: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
    const rooms = Object.values(state.mapGraph.nodes).filter(node => node.type === 'ROOM');
    const elevatorId =
      String(globals?.elevatorRoomId ?? '') ||
      rooms.find(node => node.props?.special === 'ELEVATOR')?.id ||
      '';

    for (const room of rooms) {
      if (room.id === elevatorId) continue;
      const floor = String(room.props?.floor ?? '');
      if (ride.allowSameFloorOnly && floor !== ride.fromFloor) continue;

      for (const dir of (room.props?.doors ?? []) as ('N' | 'S' | 'E' | 'W')[]) {
        const offset = OFFSETS[dir];
        if (!offset) continue;
        const col = Number(room.props?.col) + offset[0];
        const row = Number(room.props?.row) + offset[1];
        const taken = rooms.some(other => {
          if (other.id === elevatorId) return false;
          return (
            Number(other.props?.col) === col &&
            Number(other.props?.row) === row &&
            String(other.props?.floor ?? '') === floor
          );
        });
        if (taken) continue;

        const { group: arrow, material } = this.createFloorNavArrow(dir, 'EXPLORE', '电梯停靠');
        const ax = dir === 'W' ? -1.02 : dir === 'E' ? 1.02 : 0;
        const az = dir === 'N' ? -1.02 : dir === 'S' ? 1.02 : 0;
        const arrowY = room.position[1] + 0.125;
        arrow.position.set(room.position[0] + ax, arrowY, room.position[2] + az);
        arrow.userData.floor = floor;
        this.boardObjectsGroup.add(arrow);
        this.navArrowMeshes.push({ group: arrow, material, baseIntensity: 0.9, baseY: arrowY });

        this.raycaster.registerInteractive(arrow, {
          type: 'NODE',
          id: `${room.id}:elevator:${dir}`,
          metadata: {
            type: 'DOOR',
            elevator: true,
            roomId: room.id,
            direction: dir,
            name: String(room.props?.name ?? ''),
            intent: 'interact'
          }
        });
      }
    }
  }

  /**
   * The revealed board row that floats and faces the camera, when a fixture has
   * one.
   *
   * Only a table with both a card `BOARD` row and a `DECK` pile owns this
   * arrangement (poker today). Catan's board is tiles, Sanguosha has only a
   * draw pile — neither gets a floating row. The deck is the co-signature of a
   * card table, not a passenger: it stays ordinary table furniture at its own
   * bearing. The resolver deliberately asks about zone capabilities, not
   * `gameId`.
   */
  private resolveDealerArea(state: ProjectedGameState): { boardZoneId: string } | null {
    const board = state.zones.zone_board;
    const deck = state.zones.zone_deck;
    if (!board || !deck || board.type !== 'BOARD' || deck.type !== 'DECK') return null;
    return { boardZoneId: board.id };
  }

  private renderEntities(state: ProjectedGameState): void {
    // ---------- Card zones ----------
    const isPkmnSplendor = state.gameId === 'splendor';
    const dealerArea = this.resolveDealerArea(state);
    this.dealerAreaActive = !!dealerArea;
    Object.values(state.zones).forEach(zone => {
      // Pokémon Splendor owns deck / tableau / buried / rare / legend layout
      // below; skipping them here keeps one renderer per zone.
      if (isPkmnSplendor && this.isPokemonCustomZone(zone.id)) return;

      const items = zone.orderedEntities
        .map(id => state.entities[id])
        .filter((e): e is Partial<Entity> & { isMasked?: boolean; id: string } => !!e && !!e.id && e.type === 'CARD');

      if (items.length === 0) return;

      if (zone.type === 'DECK' || zone.type === 'DISCARD') {
        // Draw piles are table furniture: they never join the floating row, so
        // their yaw and position stay exactly where the zone anchor puts them.
        this.renderCardPile(state, zone, items);
        return;
      }

      if (zone.type === 'HAND') {
        this.renderHand(state, zone, items);
        return;
      }

      if (zone.type === 'EQUIP' || zone.type === 'JUDGE') {
        this.renderSeatCards(state, zone, items);
        return;
      }

      items.forEach((entity, index) => {
        this.renderCardEntity(
          entity,
          zone,
          index,
          items.length,
          !zone.id.startsWith('zone_room_') || index === items.length - 1,
          dealerArea && zone.id === dealerArea.boardZoneId ? this.dealerAreaGroup : this.boardObjectsGroup
        );
      });
    });

    // ---------- Pokémon Splendor: deck piles + player tableaus ----------
    if (state.gameId === 'splendor') {
      // Decks are hidden zones, so the projection masks every card in them.
      // Draw a pile per deck from the (masked) card count and its back art;
      // iterate the zones rather than a fixed list so a new deck still shows.
      for (const deckZone of Object.values(state.zones)) {
        if (deckZone.type !== 'DECK') continue;
        // Only a deck the table actually places is drawn. Expansion piles that
        // the current edition does not deal (Mega, Poké Mart) have no rail slot,
        // and falling back to a shared default anchor stacked every one of them
        // on the same spot — a cairn of blank cards behind the market.
        if (!PKMN_DECK_RAIL[deckZone.id]) continue;
        this.renderPokemonDeckPile(state, deckZone.id);
      }

      // Rare / legendary reveal slots: one face-up card each, on dedicated mat.
      this.renderPokemonRevealSlot(state, 'zone_rare', '稀有', '#c9a7e8');
      this.renderPokemonRevealSlot(state, 'zone_legend', '传说', '#f0d089');

      for (const playerId of state.playerOrder) {
        this.renderPokemonTableau(state, playerId);
        this.renderPokemonBuried(state, playerId);
      }
      this.renderPokemonBank(state);
    }

    // ---------- Board buildings (Catan) ----------
    Object.values(state.entities).forEach(entity => {
      if (!entity || !entity.id || !entity.components) return;

      if (entity.type === 'BUILDING' && entity.components.building) {
        const b = entity.components.building;
        const sp = entity.components.spatial || { x: 0, y: 0.1, z: 0 };

        if (b.type === 'SETTLEMENT') {
          const mesh = TokenMeshBuilder.createSettlementMesh(b.color);
          mesh.position.set(sp.x, 0.2, sp.z);
          this.boardObjectsGroup.add(mesh);
          this.entityMeshes.set(entity.id, mesh);
          this.raycaster.registerInteractive(mesh, { type: 'ENTITY', id: entity.id });
        } else if (b.type === 'CITY') {
          const mesh = TokenMeshBuilder.createCityMesh(b.color);
          mesh.position.set(sp.x, 0.2, sp.z);
          this.boardObjectsGroup.add(mesh);
          this.entityMeshes.set(entity.id, mesh);
          this.raycaster.registerInteractive(mesh, { type: 'ENTITY', id: entity.id });
        } else if (b.type === 'ROAD') {
          const mesh = TokenMeshBuilder.createRoadMesh(b.color);
          mesh.position.set(sp.x, 0.19, sp.z);

          if (sp.nodeId && state.mapGraph.edges[sp.nodeId]) {
            const edge = state.mapGraph.edges[sp.nodeId];
            const fn = state.mapGraph.nodes[edge.from];
            const tn = state.mapGraph.nodes[edge.to];
            if (fn && tn) {
              mesh.rotation.y = Math.atan2(tn.position[0] - fn.position[0], tn.position[2] - fn.position[2]);
            }
          }
          this.boardObjectsGroup.add(mesh);
          this.entityMeshes.set(entity.id, mesh);
        }
      } else if (entity.type === 'TILE' && entity.components.cardFace?.type === 'NOBLE') {
        const face = entity.components.cardFace;
        const mesh = CardMeshBuilder.createCardMesh(face, 1.3, 1.3, !!entity.isMasked);
        const nobleEntities = Object.values(state.entities).filter(e => e?.components?.cardFace?.type === 'NOBLE');
        const index = nobleEntities.indexOf(entity);
        mesh.position.set(-7.6, 0.1, (index - 1) * 1.55);
        mesh.rotation.y = 0;
        this.boardObjectsGroup.add(mesh);
        this.entityMeshes.set(entity.id, mesh);
      }
    });

    // ---------- Dice ----------
    if (state.globalVars.lastDiceRoll && Array.isArray(state.globalVars.lastDiceRoll)) {
      const rolls = state.globalVars.lastDiceRoll;
      rolls.forEach((val: number, i: number) => {
        const diceMesh = DiceMeshBuilder.createDiceMesh(0.55);
        diceMesh.position.set(4.6 + i * 0.85, 0.28, 3.6);
        DiceMeshBuilder.setFaceUp(diceMesh, val);
        this.boardObjectsGroup.add(diceMesh);
        this.raycaster.registerInteractive(diceMesh, { type: 'DICE', id: `dice_${i}`, metadata: { value: val } });
        this.physics.add(`dice_${i}`, diceMesh, {
          kind: 'box',
          halfExtents: [0.275, 0.275, 0.275]
        });
      });
    }

    // ---------- Splendor gem bank ----------
    // Pokémon Splendor draws its six Poké-Ball piles (with per-colour count
    // labels) from `renderPokemonBank`; other fixtures' banks are resource
    // counts with no chip mesh, so there is nothing to draw here any more.

    // ---------- Betrayal explorers ----------
    if (state.gameId === 'betrayal') {
      const occupantsByRoom = new Map<string, number>();
      Object.values(state.players).forEach(p => {
        if (!p.alive || p.customProps.banished) return;
        const roomId = p.customProps.currentRoomId;
        const room = state.mapGraph.nodes[roomId];
        if (!room) return;

        const slot = occupantsByRoom.get(roomId) ?? 0;
        occupantsByRoom.set(roomId, slot + 1);

        const angle = (slot % 3) * ((Math.PI * 2) / 3) + Math.PI / 6;
        const meeple = TokenMeshBuilder.createCharacterMiniature(
          p.role === 'TRAITOR' ? '#c62828' : p.color,
          { variant: p.role === 'TRAITOR' ? 'TRAITOR' : 'EXPLORER' }
        );
        // Stand in the room's open hub so the figure never hides behind a bed.
        meeple.position.set(
          room.position[0] + Math.cos(angle) * 0.3,
          room.position[1] + 0.12,
          room.position[2] + Math.sin(angle) * 0.3
        );
        meeple.userData.floor = String(room.props?.floor ?? '');
        this.boardObjectsGroup.add(meeple);
        this.entityMeshes.set(`meeple_${p.id}`, meeple);
      });

      // Monsters are MEEPLE entities with a `monster` custom component.
      Object.values(state.entities).forEach(entity => {
        const custom = entity?.components?.custom;
        if (!entity?.id || entity.type !== 'MEEPLE' || !custom?.monster) return;
        const spatial = entity.components?.spatial ?? { x: 0, y: 0.12, z: 0 };
        const roomNode = state.mapGraph.nodes[String(custom.roomId ?? '')];
        const x = roomNode ? roomNode.position[0] - 0.28 : spatial.x;
        const z = roomNode ? roomNode.position[2] + 0.3 : spatial.z;
        const stunned = !!custom.stunned;
        const monster = TokenMeshBuilder.createCharacterMiniature(String(custom.color ?? '#b07bf0'), {
          variant: 'MONSTER',
          scale: 1.45
        });
        monster.position.set(x, 0.12, z);
        if (stunned) monster.rotation.z = Math.PI / 2;
        if (roomNode?.props?.floor) monster.userData.floor = String(roomNode.props.floor);
        this.boardObjectsGroup.add(monster);
        this.entityMeshes.set(entity.id, monster);
        this.raycaster.registerInteractive(monster, {
          type: 'ENTITY',
          id: entity.id,
          metadata: custom
        });

        // Monster nameplates are DOM labels; keep the spatial mesh only.
      });
    }

    // ---------- Generic token stacks ----------
    const tokens = Object.values(state.entities).filter(
      entity => entity?.id && entity.type === 'TOKEN'
    );
    for (const candidate of tokens) {
      const entity = candidate as Entity;
      const entityId = String(entity.id);
      const zone = state.zones[entity.zoneId];
      if (!zone) continue;
      const spatial = entity.components?.spatial;
      const anchor = spatial
        ? [spatial.x, spatial.y, spatial.z]
        : zone.anchorPosition ?? [0, 0.1, 0];
      const index = Math.max(0, zone.orderedEntities.indexOf(entityId));
      const color = String(entity.components?.custom?.color ?? '#d9b45b');
      const token = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.07, 24),
        new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.4 })
      );
      token.position.set(anchor[0], anchor[1] + index * 0.06, anchor[2]);
      this.boardObjectsGroup.add(token);
      this.entityMeshes.set(entityId, token);
      this.physics.add(entityId, token, { kind: 'cylinder', radius: 0.2, halfHeight: 0.035 });
      if (index === zone.orderedEntities.length - 1) {
        this.raycaster.registerInteractive(token, { type: 'ENTITY', id: entityId });
      }
    }

    // ---------- Game-specific table dressing ----------
    this.renderGameDecor(state);
  }

  /* ------------------------------------------------------------------ */
  /* Card piles (draw deck / discard)                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Presentation-only fit: logical coordinates never change. Layout hints
   * come from GameCapabilities, not from a gameId switch in the renderer.
   */
  private fitCameraToBoard(
    state: ProjectedGameState,
    placement?: PlacementPreview,
    layout?: LayoutHints
  ): void {
    if (!this.controls) return;
    const xs: number[] = [];
    const zs: number[] = [];
    for (const node of Object.values(state.mapGraph.nodes)) {
      xs.push(node.position[0]);
      zs.push(node.position[2]);
    }
    if (placement) {
      xs.push(placement.position[0]);
      zs.push(placement.position[2]);
    }
    if (xs.length === 0) return;

    const padding = layout?.padding ?? 4;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const targetX = (minX + maxX) / 2;
    const targetZ = (minZ + maxZ) / 2;
    const spanX = maxX - minX + padding * 2;
    const spanZ = maxZ - minZ + padding * 2;
    const target = new THREE.Vector3(targetX, 0, targetZ);
    const direction = this.camera.position.clone().sub(this.controls.target);
    if ((!this.hasFitted || direction.lengthSq() < 0.001) && layout?.cameraDirection) {
      direction.set(...layout.cameraDirection);
    } else if (direction.lengthSq() < 0.001) {
      direction.set(0.6, 24, 31);
    }

    // Fit from the real field of view instead of a fixed multiplier, so the
    // board fills the viewport whatever its aspect ratio or footprint. The
    // canvas stays full-bleed, but the fit is sized against the rectangle the
    // HUD leaves uncovered, then the target is nudged so the board centre lands
    // in that rectangle rather than the canvas centre.
    const fullW = Math.max(1, this.container.clientWidth);
    const fullH = Math.max(1, this.container.clientHeight);
    const safeW = Math.max(1, fullW - this.viewportInsets.left - this.viewportInsets.right);
    const safeH = Math.max(1, fullH - this.viewportInsets.top - this.viewportInsets.bottom);
    const aspect = this.camera.aspect > 0.1 ? this.camera.aspect : 1.6;
    const fovV = THREE.MathUtils.degToRad(this.camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
    const halfX = spanX / 2;
    const halfZ = spanZ / 2;
    // The tilted camera foreshortens Z, so the vertical requirement is relaxed.
    const fitHorizontal = (halfX / Math.tan(fovH / 2)) * (fullW / safeW);
    const fitVertical = ((halfZ * 0.72) / Math.tan(fovV / 2)) * (fullH / safeH);
    const needed = Math.max(
      layout?.minDistance ?? 14,
      Math.max(fitHorizontal, fitVertical) * 1.1 + 3
    );
    // Never zoom in past what the user already chose.
    const distance = Math.min(180, Math.max(this.camera.position.distanceTo(this.controls.target), needed));

    const contentShift = this.screenOffsetToWorld(
      (this.viewportInsets.left - this.viewportInsets.right) / 2,
      (this.viewportInsets.top - this.viewportInsets.bottom) / 2,
      distance
    );
    target.add(contentShift);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(direction.normalize().multiplyScalar(distance));
    this.controls.maxDistance = 190;
    this.controls.update();
    this.hasFitted = true;
  }

  private beginPlacementCamera(placement: PlacementPreview): void {
    if (this.cameraTween) return;
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    this.prePlacementCamera = {
      position: startPosition.clone(),
      target: startTarget.clone()
    };

    // Frame the room being placed, not the whole board: the player is choosing
    // an orientation for that tile, so it should be the thing under the lens.
    const centre = new THREE.Vector3(
      placement.position[0],
      Math.max(0.12, placement.position[1] + 0.16),
      placement.position[2]
    );

    // Keep the player's chosen bearing, come in closer, and lift the eye above
    // the wide-board height so the new tile is read from above with its
    // neighbours still visible around it.
    const dir = startPosition.clone().sub(startTarget);
    const len = dir.length() || 1;
    const arm = Math.min(len, 15);
    dir.normalize();
    // Steepen the arm before scaling: looking down on the tile beats skimming
    // it from the side, which is what a straight copy of the bearing gives.
    dir.y = Math.max(dir.y, 0.72);
    dir.normalize().multiplyScalar(arm);
    const lifted = centre.clone().add(dir);
    lifted.y = Math.max(lifted.y, startPosition.y + Math.max(3.4, arm * 0.34));

    this.skipFitUntil = performance.now() + 900;
    this.startCameraTween(lifted, centre, 650);
  }

  private endPlacementCamera(state?: ProjectedGameState): void {
    const previous = this.prePlacementCamera;
    this.prePlacementCamera = undefined;
    this.cancelCameraTween();
    if (!previous) {
      this.controls.enabled = true;
      return;
    }

    // Rather than jumping back to the old pre-placement room and panning from there,
    // transition directly from the elevated placement view down to the actor
    // in the new room, smoothly restoring the normal playing distance and eye height.
    const focus = state ? this.actorFocusPoint(state) : undefined;
    const targetCenter = focus ?? previous.target;

    // Normal playing offset vector (restores pre-placement eye height & distance)
    const normalOffset = previous.position.clone().sub(previous.target);
    const targetCamPos = targetCenter.clone().add(normalOffset);

    this.skipFitUntil = performance.now() + 650;
    this.startCameraTween(targetCamPos, targetCenter, 460);
  }

  /**
   * Keep the active actor framed when they move or when turns switch.
   *
   * Movement and turn handovers used to leave the camera behind, especially
   * in GOD / spectator mode where actors occupy completely different rooms.
   * Panning (not orbiting or dollying) preserves the player's chosen bearing.
   */
  private followActorIfMoved(state: ProjectedGameState): void {
    const actorId = state.activeActorId ?? state.activePlayerId;
    const actor = actorId ? (state.players[actorId] ?? state.npcs?.[actorId]) : undefined;
    const roomId = String(actor?.customProps?.currentRoomId ?? actor?.customProps?.roomId ?? '');
    const previousRoomId = this.lastActorRoomId;
    const previousActorId = this.lastActorId;

    this.lastActorId = actorId;

    // First sync only records the starting actor & room; there is nothing to follow yet.
    if (!previousRoomId || !roomId) {
      this.lastActorRoomId = roomId || undefined;
      return;
    }

    const actorSwitched = !!previousActorId && previousActorId !== actorId;
    const roomChanged = previousRoomId !== roomId;

    if (!actorSwitched && !roomChanged) return;

    // When an actor switch occurs (turn handed over), it takes precedence over
    // lingering skipFit timers so the new active character is immediately framed.
    if (!actorSwitched && (this.cameraTween || performance.now() < this.skipFitUntil)) {
      // Keep previousRoomId untouched so the next frame can retry once skipFit passes
      return;
    }

    this.lastActorRoomId = roomId || undefined;

    const roomNode = state.mapGraph.nodes[roomId];
    const newFloor = String(roomNode?.props?.floor ?? '');
    if (this.visibleFloor !== 'ALL' && newFloor && newFloor !== this.visibleFloor) {
      this.focusFloor(newFloor);
      return;
    }

    const focus = this.actorFocusPoint(state);
    if (!focus) return;
    this.panToKeepBearing(focus, actorSwitched ? 520 : 460);
  }

  /**
   * World point to frame after a placement or turn change: the room the
   * active actor (player or monster) now stands in.
   */
  private actorFocusPoint(state: ProjectedGameState): THREE.Vector3 | undefined {
    const actorId = state.activeActorId ?? state.activePlayerId;
    const actor = actorId ? (state.players[actorId] ?? state.npcs?.[actorId]) : undefined;
    const roomId = String(actor?.customProps?.currentRoomId ?? actor?.customProps?.roomId ?? '');
    const node = roomId ? state.mapGraph.nodes[roomId] : undefined;
    if (!node) return undefined;
    return new THREE.Vector3(node.position[0], Math.max(0.12, node.position[1] + 0.16), node.position[2]);
  }

  /**
   * Slide the orbit target onto `point` without changing the camera's bearing
   * or its distance to the board, so only the framing shifts.
   */
  private panToKeepBearing(point: THREE.Vector3, duration: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.skipFitUntil = performance.now() + duration + 300;
    this.startCameraTween(point.clone().add(offset), point.clone(), duration);
  }

  /** Abort any in-flight camera tween and its safety timer. */
  private cancelCameraTween(): void {
    if (this.cameraTweenTimer !== undefined) {
      window.clearTimeout(this.cameraTweenTimer);
      this.cameraTweenTimer = undefined;
    }
    this.cameraTween = undefined;
  }

  private startCameraTween(
    toPosition: THREE.Vector3,
    toTarget: THREE.Vector3,
    duration: number
  ): void {
    this.cameraTween = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: toPosition.clone(),
      toTarget: toTarget.clone(),
      startedAt: performance.now(),
      duration
    };
    this.controls.enabled = false;
    // rAF stalls in background tabs would otherwise freeze the camera mid-tween
    // with the orbit controls permanently disabled. Force the final pose.
    if (this.cameraTweenTimer !== undefined) window.clearTimeout(this.cameraTweenTimer);
    this.cameraTweenTimer = window.setTimeout(() => {
      this.cameraTweenTimer = undefined;
      this.finishCameraTween();
    }, duration + 60);
  }

  /** Snap the active camera tween to its destination and hand control back. */
  private finishCameraTween(): void {
    const tween = this.cameraTween;
    if (!tween) {
      this.controls.enabled = true;
      return;
    }
    this.camera.position.copy(tween.toPosition);
    this.controls.target.copy(tween.toTarget);
    this.cameraTween = undefined;
    this.controls.enabled = true;
    this.controls.update();
  }

  private updateCameraTween(now: number): void {
    const tween = this.cameraTween;
    if (!tween) return;
    const t = Math.min(1, Math.max(0, (now - tween.startedAt) / tween.duration));
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (t >= 1) {
      if (this.cameraTweenTimer !== undefined) {
        window.clearTimeout(this.cameraTweenTimer);
        this.cameraTweenTimer = undefined;
      }
      this.finishCameraTween();
    }
  }

  /**
   * Builds the 3D room placement preview: semi-transparent ghost tile, in-world
   * rotate & confirm widgets, and dynamic portal link arches / door beacons.
   */
  private renderPlacementPreview(placement: PlacementPreview, _state?: ProjectedGameState): void {
    if (this.lastPreviewRotation !== undefined && this.lastPreviewRotation !== placement.rotation) {
      BoardGameAudio.playCardFlip();
    }
    this.lastPreviewRotation = placement.rotation;

    const group = RoomTileBuilder.createRoomMesh(
      placement.name,
      2.84,
      placement.color,
      placement.doors as ('N' | 'S' | 'E' | 'W')[],
      {
        floor: placement.floor,
        isPreview: true
      }
    );
    group.position.set(placement.position[0], placement.position[1] + 0.12, placement.position[2]);
    group.rotation.y = -placement.rotation * (Math.PI / 2);
    // Clone the materials before mutating: the palette is shared by every room,
    // so editing it here would ghost the whole board.
    group.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = source.map(material => {
        if (!material) return material;
        const copy = material.clone();
        copy.transparent = true;
        copy.opacity = 0.8;
        copy.depthWrite = false;
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
    });
    this.boardObjectsGroup.add(group);
    this.previewObjects.push(group);

    // Register ghost tile click to rotate directly in 3D
    this.raycaster.registerInteractive(group, {
      type: 'NODE',
      id: 'placement_rotate',
      metadata: { intent: 'rotate' }
    });

    // 3D In-World Interactive Rotate Gizmo (Brass Torus Ring)
    const rotateGizmoGeom = new THREE.TorusGeometry(0.48, 0.05, 8, 24);
    const rotateGizmoMat = new THREE.MeshBasicMaterial({ color: 0xd9b45b });
    const rotateGizmo = new THREE.Mesh(rotateGizmoGeom, rotateGizmoMat);
    rotateGizmo.rotation.x = Math.PI / 2;
    rotateGizmo.position.set(placement.position[0] - 0.75, placement.position[1] + 0.65, placement.position[2]);
    this.boardObjectsGroup.add(rotateGizmo);
    this.previewObjects.push(rotateGizmo);
    this.raycaster.registerInteractive(rotateGizmo, {
      type: 'NODE',
      id: 'placement_rotate',
      metadata: { intent: 'rotate' }
    });

    // 3D In-World Interactive Confirm Gizmo (Emerald Cylinder Disc)
    const confirmGizmoGeom = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16);
    const confirmGizmoMat = new THREE.MeshBasicMaterial({ color: 0x2e9b4e });
    const confirmGizmo = new THREE.Mesh(confirmGizmoGeom, confirmGizmoMat);
    confirmGizmo.position.set(placement.position[0] + 0.75, placement.position[1] + 0.65, placement.position[2]);
    this.boardObjectsGroup.add(confirmGizmo);
    this.previewObjects.push(confirmGizmo);
    this.raycaster.registerInteractive(confirmGizmo, {
      type: 'NODE',
      id: 'placement_confirm',
      metadata: { intent: 'confirm' }
    });

    // 3D Door Connection Visuals: luminous bridges, portal rings and exploration chevrons
    const half = 2.84 / 2;
    const DIR_DELTAS: Record<string, [number, number]> = {
      N: [0, -half],
      S: [0, half],
      E: [half, 0],
      W: [-half, 0]
    };

    for (const conn of placement.connections ?? []) {
      const dir = conn.dir;
      const delta = DIR_DELTAS[dir];
      if (!delta) continue;
      const dx = delta[0];
      const dz = delta[1];
      const doorX = placement.position[0] + dx;
      const doorY = placement.position[1];
      const doorZ = placement.position[2] + dz;

      if (conn.status === 'connected') {
        // Luminous emerald connection bridge between the two doors
        const bridgeGeom = new THREE.BoxGeometry(
          dir === 'N' || dir === 'S' ? 0.96 : 0.2,
          0.04,
          dir === 'N' || dir === 'S' ? 0.2 : 0.96
        );
        const bridgeMat = new THREE.MeshStandardMaterial({
          color: 0x22dd77,
          emissive: 0x11bb66,
          emissiveIntensity: 1.2,
          roughness: 0.3
        });
        const bridge = new THREE.Mesh(bridgeGeom, bridgeMat);
        bridge.position.set(doorX, doorY + 0.128, doorZ);
        this.boardObjectsGroup.add(bridge);
        this.previewObjects.push(bridge);

        // Glowing portal energy ring standing upright in the doorway
        const archGeom = new THREE.TorusGeometry(0.36, 0.024, 8, 24);
        const archMat = new THREE.MeshBasicMaterial({ color: 0x44ffaa });
        const arch = new THREE.Mesh(archGeom, archMat);
        arch.position.set(doorX, doorY + 0.38, doorZ);
        if (dir === 'E' || dir === 'W') arch.rotation.y = Math.PI / 2;
        this.boardObjectsGroup.add(arch);
        this.previewObjects.push(arch);

        // Floating tag
        const tag = this.createLabelSprite(
          `🔗 ${conn.dirZh} ↔ ${conn.neighborRoomName ?? '相邻房间'}`,
          '#55ffaa',
          24
        );
        tag.position.set(doorX + (dx ? Math.sign(dx) * 0.15 : 0), doorY + 0.72, doorZ + (dz ? Math.sign(dz) * 0.15 : 0));
        tag.scale.set(2.0, 0.34, 1);
        this.boardObjectsGroup.add(tag);
        this.previewObjects.push(tag);
      } else if (conn.status === 'blocked') {
        // Warning red barrier
        const blockGeom = new THREE.BoxGeometry(
          dir === 'N' || dir === 'S' ? 0.76 : 0.08,
          0.16,
          dir === 'N' || dir === 'S' ? 0.08 : 0.76
        );
        const blockMat = new THREE.MeshStandardMaterial({
          color: 0x5a1818,
          emissive: 0x2a0808,
          roughness: 0.8
        });
        const block = new THREE.Mesh(blockGeom, blockMat);
        block.position.set(doorX, doorY + 0.24, doorZ);
        this.boardObjectsGroup.add(block);
        this.previewObjects.push(block);

        const tag = this.createLabelSprite(`✕ ${conn.dirZh}面墙`, '#ff7777', 22);
        tag.position.set(doorX + (dx ? Math.sign(dx) * 0.1 : 0), doorY + 0.58, doorZ + (dz ? Math.sign(dz) * 0.1 : 0));
        tag.scale.set(1.6, 0.28, 1);
        this.boardObjectsGroup.add(tag);
        this.previewObjects.push(tag);
      } else if (conn.status === 'open') {
        // Open exploration tag
        const tag = this.createLabelSprite(`▲ ${conn.dirZh}未知`, '#d9b45b', 22);
        tag.position.set(doorX + (dx ? Math.sign(dx) * 0.1 : 0), doorY + 0.52, doorZ + (dz ? Math.sign(dz) * 0.1 : 0));
        tag.scale.set(1.4, 0.26, 1);
        this.boardObjectsGroup.add(tag);
        this.previewObjects.push(tag);
      }
    }

    const connectedList = (placement.connections ?? []).filter(c => c.connected);
    const connectedDetails = connectedList.length > 0
      ? ` · 🔗 打通 ${connectedList.length} 门 (${connectedList.map(c => `${c.dirZh}↔${c.neighborRoomName}`).join('，')})`
      : ' · ⚠️ 未与相邻房间门位接通';
    const label = this.createLabelSprite(
      `↻ 点击旋转 (${placement.rotation * 90}°)${connectedDetails} · ✓ 确认放置`,
      connectedList.length > 0 ? '#66ffbb' : '#e3c77b',
      30
    );
    label.position.set(placement.position[0], placement.position[1] + 1.25, placement.position[2]);
    label.scale.set(connectedList.length > 0 ? 3.4 : 3.0, 0.45, 1);
    this.boardObjectsGroup.add(label);
    this.previewObjects.push(label);

    if (placement.floor) {
      this.previewObjects.forEach(obj => {
        obj.userData.floor = placement.floor;
      });
    }
  }

  private renderCardPile(
    _state: ProjectedGameState,
    zone: ProjectedGameState['zones'][string],
    items: (Partial<Entity> & { isMasked?: boolean; id: string })[]
  ): void {
    const anchor = zone.anchorPosition ?? [0, 0.06, 0];
    const offset = this.deckVisualOffsets.get(zone.id) ?? { dx: 0, dz: 0 };
    const group = new THREE.Group();
    group.position.set(anchor[0] + offset.dx, 0, anchor[2] + offset.dz);
    const isDiscard = zone.type === 'DISCARD';
    const visible = Math.min(items.length, 4);

    for (let i = 0; i < visible; i++) {
      const isTop = i === visible - 1;
      const faceUp = isDiscard && isTop;
      const face = faceUp ? items[i].components?.cardFace || { title: 'Discard' } : { title: 'Card' };
      // A draw pile is the same few card backs on every sync; only the top of a
      // discard pile changes, so the mesh is cached per face + orientation.
      const mesh = this.furniture.obtain(
        `pile:${zone.id}:${i}`,
        signatureOf(face, faceUp, DECK_CARD_W, DECK_CARD_H),
        () => CardMeshBuilder.createCardMesh(face, DECK_CARD_W, DECK_CARD_H, !faceUp)
      );
      // Local coordinates: the pile's world XZ lives on the group so a drag can
      // move every layer (and the count label) as one object.
      mesh.position.set(0, anchor[1] + i * 0.02, 0);
      mesh.rotation.y = i % 2 === 0 ? 0.02 : -0.03;
      group.add(mesh);
      if (isTop) this.entityMeshes.set(items[i].id, mesh);
    }

    const labelOffset =
      ZONE_LABEL_OFFSETS[zone.id] ??
      ZONE_LABEL_TYPE_OFFSETS[zone.type] ??
      { x: 0, y: 0, z: 0 };
    const label = this.createLabelSprite(
      `${zone.name} · ${items.length}`,
      '#cbb57a',
      TABLE_LABEL_FONT_SIZE,
      ZONE_LABEL_SUPERSAMPLE
    );
    label.position.set(
      labelOffset.x,
      ZONE_LABEL_BASE_Y + labelOffset.y,
      labelOffset.z
    );
    // 贴图是 4:1（1024×256）；0.6x 后保留同样比例，文字与胶囊一起缩小。
    label.scale.set(2.6 * ZONE_LABEL_SCALE, 0.65 * ZONE_LABEL_SCALE, 1);
    label.userData.labelRole = 'zone';
    label.userData.zoneId = zone.id;
    label.userData.text = `${zone.name} · ${items.length}`;
    label.userData.fontScale = ZONE_LABEL_SCALE;
    group.add(label);
    this.boardObjectsGroup.add(group);

    // Only draw piles are movable. Discard piles stay mirrored to their zone
    // anchor because their top card is meaningful state, not furniture.
    if (zone.type === 'DECK') {
      this.deckPiles.set(zone.id, { group, baseX: anchor[0], baseZ: anchor[2] });
      this.raycaster.registerInteractive(group, {
        type: 'ZONE',
        id: `deck:${zone.id}`,
        metadata: { zoneId: zone.id, label: zone.name, draggable: true }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pokémon Splendor: decks, tableaus, Poké Ball bank                  */
  /* ------------------------------------------------------------------ */

  /**
   * Zone ids that the Pokémon renderer builds itself instead of the generic
   * card-zone pass. Only applies while the fixture is `splendor`.
   *
   * Deck / rare / legend / tableau / buried zones each have a dedicated
   * renderer below; letting the generic pass draw them too would double every
   * mesh and (for unanchored zones) pile them at the world origin.
   */
  private isPokemonCustomZone(zoneId: string): boolean {
    if (zoneId.startsWith('zone_deck_')) return true;
    if (zoneId === 'zone_rare' || zoneId === 'zone_legend') return true;
    if (zoneId.startsWith('zone_buried_')) return true;
    if (zoneId.startsWith('zone_tableau_')) {
      const seated = this.lastState?.playerOrder ?? [];
      // Tableaus are per-seat; a zone for a seat outside the current roster is
      // left to the generic pass rather than silently dropped.
      return seated.some(playerId => zoneId === `zone_tableau_${playerId}`);
    }
    return false;
  }

  /** Card-back texture for a deck zone, falling back to the tier token. */
  private pokemonBackTextureFor(zoneId: string, tier?: unknown): THREE.Texture | null {
    const directUrl = PKMN_BACK_URL_BY_ZONE[zoneId];
    if (directUrl) return CardMeshBuilder.loadImageTexture(directUrl);
    const tierKey = typeof tier === 'string' ? tier : '';
    const tierUrl = PKMN_BACK_URL_BY_TIER[tierKey];
    if (tierUrl) return CardMeshBuilder.loadImageTexture(tierUrl);
    // Unknown deck: let the asset module pick, then fall back to painted backs.
    return pokemonCardBackTexture({ pkmnTier: tierKey });
  }

  /**
   * A face-down card whose *top* surface is the back art.
   *
   * `createCardMesh` paints the face material on +Y and the back material on
   * −Y (a card lies flat), so a face-down card must hand its back art to the
   * face slot — passing it as `backTextureOverride` would hide it underneath.
   */
  private createPokemonFaceDownMesh(
    art: THREE.Texture | null,
    width: number,
    height: number,
    title = 'Card'
  ): THREE.Mesh {
    return CardMeshBuilder.createCardMesh({ title }, width, height, true, art, null);
  }

  /**
   * Face-down deck pile.
   *
   * Height encodes how many cards remain: the top card of the stack is raised
   * by a compressed per-card offset, so a full deck reads as a chunky block and
   * a nearly drained one as a flat sheet. The stack is presentation only — the
   * logical zone order is never touched.
   */
  private renderPokemonDeckPile(state: ProjectedGameState, zoneId: string): void {
    const zone = state.zones[zoneId];
    if (!zone) return;
    const count = zone.orderedEntities.length;
    if (count === 0) return;

    // The renderer owns the deck rail: fixture anchors predate the rare /
    // legend decks and would stack piles on top of the reveal slots.
    const anchor = PKMN_DECK_RAIL[zoneId] ?? [-6.4, 0.06, -3.2];
    // Deck zones are hidden, so the projected cards carry no custom data. The
    // back art therefore comes from the zone id; the tier token is only a
    // fallback for fixtures that expose one.
    const tierToken = String(state.entities[zone.orderedEntities[0]]?.components?.custom?.pkmnTier ?? '');
    const art = this.pokemonBackTextureFor(zoneId, tierToken);

    // Cap the visible slab so a 35-card deck stays a tidy pile, not a tower.
    const layers = Math.min(count, 18);
    const layerStep = 0.008;
    const slabHeight = Math.max(0.02, layers * layerStep);
    const topY = anchor[1] + slabHeight;

    // Block body sits entirely *below* the top card, so the back art is never
    // occluded by its own edge band.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(PKMN_DECK_CARD_W - 0.03, slabHeight, PKMN_DECK_CARD_H - 0.03),
      new THREE.MeshStandardMaterial({ color: 0x1c2430, roughness: 0.85, metalness: 0.05 })
    );
    slab.position.set(anchor[0], anchor[1] + slabHeight / 2, anchor[2]);
    slab.receiveShadow = true;
    this.boardObjectsGroup.add(slab);

    const mesh = this.createPokemonFaceDownMesh(
      art,
      PKMN_DECK_CARD_W,
      PKMN_DECK_CARD_H,
      PKMN_DECK_LABEL[zoneId] ?? zone.name
    );
    // +0.012 clears the slab's own top face.
    mesh.position.set(anchor[0], topY + 0.012, anchor[2]);
    // A hair of rotation per pile so stacks read as physical objects.
    mesh.rotation.y = 0.04;
    this.boardObjectsGroup.add(mesh);

    // Count label sits in front of the pile, facing the camera.
    const label = this.createLabelSprite(
      `${PKMN_DECK_LABEL[zoneId] ?? zone.name} · ${count}`,
      '#cbb57a',
      72
    );
    // The caption belongs to its own pile: sit it just inside the front edge so
    // the next pile in the rail (one row step away) is never covered.
    label.position.set(anchor[0], topY + 0.05, anchor[2] + PKMN_DECK_CARD_H * 0.5 - 0.16);
    label.scale.set(PKMN_DECK_CARD_W * 1.25, 0.44, 1);
    this.boardObjectsGroup.add(label);
  }

  /**
   * One revealed rare / legendary Pokémon, standing on its own ritual mat.
   *
   * The card itself is a normal face-up market card (full artwork); the slot
   * only adds the mat, a glow ring and the caption so those two single-card
   * rows do not read as an accidental extra market row.
   */
  private renderPokemonRevealSlot(
    state: ProjectedGameState,
    zoneId: string,
    caption: string,
    accent: string
  ): void {
    const zone = state.zones[zoneId];
    if (!zone) return;
    const items = zone.orderedEntities
      .map(id => state.entities[id])
      .filter((e): e is Partial<Entity> & { isMasked?: boolean; id: string } => !!e && !!e.id);
    if (items.length === 0) return;

    const anchor = PKMN_REVEAL_RAIL[zoneId] ?? zone.anchorPosition ?? [-7.7, 0.1, 0];

    // Mat + accent ring: presentation only, never a hit target.
    const mat = new THREE.Mesh(
      new THREE.BoxGeometry(PKMN_CARD_W + 0.26, 0.02, PKMN_CARD_H + 0.26),
      new THREE.MeshStandardMaterial({ color: 0x0a1712, roughness: 0.96, metalness: 0.02 })
    );
    mat.position.set(anchor[0], 0.02, anchor[2]);
    this.boardObjectsGroup.add(mat);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.018, 8, 48),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(accent),
        emissive: new THREE.Color(accent),
        emissiveIntensity: 0.75,
        metalness: 0.7,
        roughness: 0.3
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(anchor[0], 0.05, anchor[2]);
    this.boardObjectsGroup.add(ring);
    this.navArrowMeshes.push({ group: ring, material: ring.material as THREE.MeshStandardMaterial, baseIntensity: 0.75, baseY: 0.05 });

    items.forEach((entity, index) => {
      const face = entity.components?.cardFace || { title: 'Card' };
      const custom = entity.components?.custom as Record<string, unknown> | undefined;
      const isMasked = !!entity.isMasked;
      const mesh = isMasked
        ? this.createPokemonFaceDownMesh(
            this.pokemonBackTextureFor(zoneId, custom?.pkmnTier),
            1.28,
            1.88,
            String(face.title ?? 'Card')
          )
        : CardMeshBuilder.createCardMesh(face, 1.28, 1.88, false, pokemonCardTexture(custom), null);
      // A single card per slot; extra cards (mid-deal) fan harmlessly.
      mesh.position.set(anchor[0] + index * 0.16, anchor[1] + index * 0.02, anchor[2]);
      mesh.rotation.y = index === 0 ? 0 : 0.06 * index;
      this.boardObjectsGroup.add(mesh);
      this.entityMeshes.set(entity.id, mesh);
      this.raycaster.registerInteractive(mesh, {
        type: 'ENTITY',
        id: entity.id,
        metadata: face
      });
    });

    const plate = this.createLabelSprite(caption, accent, 30);
    plate.position.set(anchor[0], 0.52, anchor[2] - 1.16);
    plate.scale.set(1.5, 0.34, 1);
    this.boardObjectsGroup.add(plate);
  }

  /** Normalise a card's `custom.bonus` into one of the six ball colours. */
  private pokemonBonusColumn(custom?: Record<string, unknown>): string {
    const raw = String(custom?.bonusColor ?? custom?.bonus ?? '');
    if (!raw || raw === 'none') return PKMN_NO_BONUS_COLUMN;
    if (PKMN_BONUS_ORDER.includes(raw)) return raw;
    return PKMN_BONUS_ALIAS[raw] ?? PKMN_NO_BONUS_COLUMN;
  }

  /** Table slot for a seat's tableau band (four seats along the near edge). */
  private pokemonTableauSlot(state: ProjectedGameState, playerId: string): [number, number] {
    const index = Math.max(0, state.playerOrder.indexOf(playerId));
    const seats = Math.max(1, state.playerOrder.length);
    // Centre the row of bands on the table.
    const x = (index - (seats - 1) / 2) * PKMN_TABLEAU_SLOT_WIDTH;
    return [x, PKMN_TABLEAU_Z];
  }

  /**
   * A player's caught Pokémon, grouped into one column per ball colour.
   *
   * Columns run left→right in canonical ball order; each is topped with a
   * `红 ×N` badge. Cards inside a column are offset toward the viewer so the
   * badges and the artwork both stay legible at board scale.
   */
  private renderPokemonTableau(state: ProjectedGameState, playerId: string): void {
    const zone = state.zones[`zone_tableau_${playerId}`];
    if (!zone) return;
    const items = zone.orderedEntities
      .map(id => state.entities[id])
      .filter((e): e is Partial<Entity> & { isMasked?: boolean; id: string } => !!e && !!e.id);
    if (items.length === 0) return;

    const [slotX, slotZ] = this.pokemonTableauSlot(state, playerId);
    const playerName = state.players[playerId]?.name ?? playerId;

    // Bucket by bonus colour; entity order inside a column is the zone order,
    // so a deterministic layout never depends on object key iteration.
    const columns = new Map<string, (Partial<Entity> & { isMasked?: boolean; id: string })[]>();
    for (const entity of items) {
      const column = this.pokemonBonusColumn(entity.components?.custom as Record<string, unknown>);
      const bucket = columns.get(column) ?? [];
      bucket.push(entity);
      columns.set(column, bucket);
    }

    const orderedColumns = PKMN_BONUS_ORDER.filter(column => (columns.get(column)?.length ?? 0) > 0);
    const firstColumnX = slotX - ((orderedColumns.length - 1) * PKMN_TABLEAU_COLUMN_STEP) / 2;

    orderedColumns.forEach((column, columnIndex) => {
      const bucket = columns.get(column) ?? [];
      const columnX = firstColumnX + columnIndex * PKMN_TABLEAU_COLUMN_STEP;

      bucket.forEach((entity, rowIndex) => {
        const face = entity.components?.cardFace || { title: 'Card' };
        const custom = entity.components?.custom as Record<string, unknown> | undefined;
        const isMasked = !!entity.isMasked;
        // A masked card must show the back art on its *top* face; a revealed one
        // shows the Pokémon artwork. Both are the +Y material slot.
        const mesh = isMasked
          ? this.createPokemonFaceDownMesh(
              this.pokemonBackTextureFor('', custom?.pkmnTier),
              PKMN_SMALL_CARD_W,
              PKMN_SMALL_CARD_H,
              String(face.title ?? 'Card')
            )
          : CardMeshBuilder.createCardMesh(
              face,
              PKMN_SMALL_CARD_W,
              PKMN_SMALL_CARD_H,
              false,
              pokemonCardTexture(custom),
              null
            );
        // Each successive card overlaps the one behind, like a fan on felt.
        mesh.position.set(columnX, 0.1 + rowIndex * 0.014, slotZ + rowIndex * 0.1);
        mesh.rotation.y = 0.02 * (rowIndex % 2 === 0 ? 1 : -1);
        this.boardObjectsGroup.add(mesh);
        this.entityMeshes.set(entity.id, mesh);
        this.raycaster.registerInteractive(mesh, {
          type: 'ENTITY',
          id: entity.id,
          metadata: face
        });
      });

      // `红 ×N` badge above the column.
      const caption = PKMN_BALL_LABEL[column] ?? PKMN_BONUS_LABEL_EXTRA[column] ?? column;
      const badge = this.createLabelSprite(`${caption} ×${bucket.length}`, PKMN_BALL_TINT[column] ?? '#cbd5e1', 64);
      // Keep the badge near the felt: a sprite that rides too high floats over
      // the market row in the isometric view and reads as part of it.
      badge.position.set(columnX, 0.22, slotZ - PKMN_SMALL_CARD_H * 0.5 - 0.14);
      badge.scale.set(1.24, 0.34, 1);
      this.boardObjectsGroup.add(badge);
    });

    const plate = this.createLabelSprite(`${playerName} · 图鉴 ${items.length}`, '#8fb7d9', 26);
    plate.position.set(slotX, 0.4, slotZ + PKMN_SMALL_CARD_H * 0.5 + 0.86);
    plate.scale.set(2.2, 0.34, 1);
    this.boardObjectsGroup.add(plate);
  }

  /**
   * Buried Pokémon (evolution fodder) as one small face-down stack beside the
   * tableau band. `buriedIds` lives on the player, so the count is read from
   * there; the zone itself supplies the card entities when they are visible.
   */
  private renderPokemonBuried(state: ProjectedGameState, playerId: string): void {
    const buriedIds = (state.players[playerId]?.customProps?.buriedIds ?? []) as unknown[];
    const zone = state.zones[`zone_buried_${playerId}`];
    const count = Math.max(buriedIds.length, zone?.orderedEntities.length ?? 0);
    if (count === 0) return;

    const [slotX, slotZ] = this.pokemonTableauSlot(state, playerId);
    // Park the pile just past the right-most bonus column, inside the band.
    const pileX = slotX + PKMN_BURIED_OFFSET_X;
    const pileZ = slotZ + 0.1;

    const layers = Math.min(count, 12);
    // Each buried card keeps its own art when the zone exposes the entity;
    // otherwise the pile shares one generic back.
    const buriedZone = state.zones[`zone_buried_${playerId}`];
    const buriedIdsInZone = buriedZone?.orderedEntities ?? [];
    const fallbackArt = this.pokemonBackTextureFor('zone_buried', 'stage1');
    for (let i = 0; i < layers; i++) {
      const buriedEntity = state.entities[buriedIdsInZone[i]];
      const tier = String(buriedEntity?.components?.custom?.pkmnTier ?? '');
      const art = tier ? this.pokemonBackTextureFor('zone_buried', tier) : fallbackArt;
      const mesh = this.createPokemonFaceDownMesh(
        art,
        PKMN_SMALL_CARD_W - 0.06,
        PKMN_SMALL_CARD_H - 0.08,
        'Buried'
      );
      mesh.position.set(pileX + i * 0.008, 0.1 + i * 0.012, pileZ);
      mesh.rotation.y = -0.04;
      this.boardObjectsGroup.add(mesh);
    }

    const badge = this.createLabelSprite(`埋没 ×${count}`, '#9aa7b8', 56);
    badge.position.set(pileX, 0.58, pileZ - PKMN_SMALL_CARD_H * 0.5 - 0.2);
    badge.scale.set(1.25, 0.28, 1);
    this.boardObjectsGroup.add(badge);
  }

  /**
   * Six Poké Ball piles with a remaining-count badge each.
   *
   * The tray is widened to six slots; the master ball (purple) gets a golden
   * halo so it never reads as just another colour.
   */
  private renderPokemonBank(state: ProjectedGameState): void {
    const bank = (state.globalVars.bank ?? {}) as Record<string, number>;
    const trayX = 7.4;
    const slotStep = 1.0;
    const firstZ = -((PKMN_BALL_ORDER.length - 1) * slotStep) / 2;

    PKMN_BALL_ORDER.forEach((color, index) => {
      const count = Math.max(0, Number(bank[color] ?? 0));
      const zPos = firstZ + index * slotStep;
      const isMaster = color === PKMN_MASTER_BALL;

      // A shallow well per colour, so an emptied pile still shows a slot.
      const well = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 0.02, 28),
        new THREE.MeshStandardMaterial({ color: 0x131a22, roughness: 0.9, metalness: 0.05 })
      );
      well.position.set(trayX, 0.03, zPos);
      this.boardObjectsGroup.add(well);

      const stack = Math.min(count, 5);
      for (let h = 0; h < stack; h++) {
        const chip = TokenMeshBuilder.createGemTokenMesh(color, 0.28, true, color);
        chip.position.set(trayX - h * 0.1, 0.05 + h * 0.1, zPos);
        this.boardObjectsGroup.add(chip);
        if (h === stack - 1) {
          this.raycaster.registerInteractive(chip, {
            type: 'ENTITY',
            id: `chip_bank_${color}`,
            metadata: { gem: color, count }
          });
        }
      }

      // Master ball halo: a brass ring that reads at any zoom level.
      if (isMaster) {
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(0.34, 0.022, 8, 40),
          new THREE.MeshStandardMaterial({
            color: 0xd9b45b,
            emissive: 0xd9b45b,
            emissiveIntensity: 0.9,
            metalness: 0.85,
            roughness: 0.25
          })
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.set(trayX, 0.2, zPos);
        this.boardObjectsGroup.add(halo);
      }

      const badge = this.createLabelSprite(
        `${PKMN_BALL_LABEL[color] ?? color} ${count}`,
        isMaster ? '#f0d089' : '#cfd8e6',
        28
      );
      badge.position.set(trayX + 0.42, 0.3, zPos);
      badge.scale.set(0.86, 0.24, 1);
      this.boardObjectsGroup.add(badge);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Hands around the table                                              */
  /* ------------------------------------------------------------------ */

  /** Soft alpha mask for the own-hand shadows; one canvas texture for all cards. */
  private static getOwnHandShadowTexture(): THREE.CanvasTexture {
    if (BoardGameScene.ownHandShadowTexture) return BoardGameScene.ownHandShadowTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) {
      const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 31);
      gradient.addColorStop(0, 'rgba(0,0,0,0.92)');
      gradient.addColorStop(0.52, 'rgba(0,0,0,0.55)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 64, 64);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'own-hand-shadow';
    BoardGameScene.ownHandShadowTexture = texture;
    return texture;
  }

  /**
   * A soft elliptical shadow rendered as an ordinary transparent plane.
   *
   * It lives in `ownHandGroup` alongside (not parented to) its card, so the
   * layout and cut animation can keep it exactly 0.01 behind the card without
   * paying for a real-time shadow map. It is deliberately excluded from the
   * raycaster.
   */
  private createOwnHandShadow(cardWidth: number): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: BoardGameScene.getOwnHandShadowTexture(),
      transparent: true,
      opacity: OWN_HAND_SHADOW_OPACITY,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    shadow.scale.set(cardWidth * 0.94, OWN_HAND_CARD_HEIGHT * 0.14, 1);
    shadow.castShadow = false;
    shadow.receiveShadow = false;
    shadow.userData.ownHandShadow = true;
    return shadow;
  }

  /**
   * Width available to the own-hand fan, in world units at its camera distance.
   *
   * The overlay has no seat to spread along, so it uses the visible viewport
   * (minus drawer insets) as its budget. Keeping the cards readable on a phone
   * therefore compresses the fan instead of pushing it off-screen.
   */
  private ownHandMaxWidth(): number {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const visiblePx = Math.max(
      OWN_HAND_CARD_WIDTH * 4,
      width - this.viewportInsets.left - this.viewportInsets.right - 32
    );
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const worldPerPixel = (2 * OWN_HAND_DISTANCE * tanHalf) / height;
    return Math.max(
      OWN_HAND_CARD_WIDTH * 1.6,
      Math.min(OWN_HAND_MAX_SPAN, visiblePx * worldPerPixel)
    );
  }

  /**
   * Card step for the own-hand fan.
   *
   * The 18% overlap is the resting target; only a hand too wide for the viewport
   * is compressed further, so a large hand still fits without changing the
   * normal two-to-seven-card look.
   */
  private ownHandFanMetrics(count: number): { cardWidth: number; step: number; span: number } {
    const cardWidth = OWN_HAND_CARD_WIDTH;
    const desiredStep = cardWidth * (1 - OWN_HAND_OVERLAP);
    const maxStep = count > 1 ? Math.max(0, (this.ownHandMaxWidth() - cardWidth) / (count - 1)) : 0;
    const step = count > 1 ? Math.min(desiredStep, maxStep) : 0;
    return { cardWidth, step, span: cardWidth + Math.max(0, count - 1) * step };
  }

  private ownHandSpan(count: number): number {
    return this.ownHandFanMetrics(count).span;
  }

  /** Keep the own-hand fan fitted after a viewport/drawer resize. */
  private layoutCameraHandRows(): void {
    for (const row of this.handRows.values()) {
      if (!row.cameraAttached) continue;
      row.span = this.ownHandSpan(row.ids.length);
      this.layoutHandRow(row);
    }
  }

  /**
   * Downward offset that puts the attached hand just above the dock.
   *
   * The dock height comes from the HUD's measured insets (the persistent
   * desktop dock does not set `bottom`, hence the separate `dockHeight`), with
   * the row centre clamped to the lower half of the viewport. The vertical
   * offset is in camera-space world units at `OWN_HAND_DISTANCE`.
   */
  private ownHandDrop(): number {
    const height = Math.max(1, this.container.clientHeight);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dock = Math.max(0, this.viewportInsets.dockHeight ?? this.viewportInsets.bottom);
    const halfCard = OWN_HAND_CARD_HEIGHT / (2 * OWN_HAND_DISTANCE * tanHalf);
    const safeCentre = (height - dock) / height - OWN_HAND_DOCK_GAP_PX / height - halfCard;
    const centre = THREE.MathUtils.clamp(
      Math.max(OWN_HAND_MIN_CENTER, safeCentre),
      OWN_HAND_MIN_CENTER,
      OWN_HAND_MAX_CENTER
    );
    // Screen y fraction → camera-space y at distance D (negative is lower).
    return -(1 - 2 * centre) * OWN_HAND_DISTANCE * tanHalf;
  }

  /**
   * Place the viewer's hand group in front of the camera.
   *
   * Position is always derived from the *current* camera position plus a
   * smoothed view direction: translation follows immediately (no rubber-banding
   * against the dock), while orbit/tilt is eased at ~0.2/frame so the hand does
   * not snap when the camera flies to a seat. The group uses the camera's
   * quaternion, so every card plane is parallel to the screen and the fan is
   * permanently centred on the frustum apex.
   */
  private updateCameraAttachedHand(dt: number): void {
    if (this.ownHandGroup.children.length === 0) {
      this.ownHandReady = false;
      return;
    }
    const direction = this.camera.getWorldDirection(BoardGameScene._scratchPoint);
    direction.normalize();
    const snap = !this.ownHandReady || this.reduceMotionQuery?.matches === true;
    if (snap) {
      this.ownHandForward.copy(direction);
      this.ownHandQuaternion.copy(this.camera.quaternion);
    } else {
      const alpha = 1 - Math.exp(-Math.max(0, dt) * 12);
      this.ownHandForward.lerp(direction, alpha).normalize();
      this.ownHandQuaternion.slerp(this.camera.quaternion, alpha);
    }
    this.ownHandReady = true;

    // Normal views keep the historical seven-unit attachment. Only once the
    // camera is pulled past the standard framing does the overlay trail it,
    // preserving the camera-attached feel while giving the scale compensation
    // some depth to work with.
    const orbitDistance = this.camera.position.distanceTo(this.controls.target);
    const targetDepth = THREE.MathUtils.clamp(
      OWN_HAND_DISTANCE +
        Math.max(0, orbitDistance - OWN_HAND_TRACK_START) * OWN_HAND_DISTANCE_TRACK,
      OWN_HAND_DISTANCE,
      OWN_HAND_MAX_DISTANCE
    );
    const depthAlpha = snap ? 1 : 1 - Math.exp(-Math.max(0, dt) * OWN_HAND_DISTANCE_DAMPING);
    this.ownHandDepth = THREE.MathUtils.lerp(this.ownHandDepth, targetDepth, depthAlpha);
    const baseDrop = this.ownHandDrop();
    this.ownHandGroup.position
      .copy(this.camera.position)
      .addScaledVector(this.ownHandForward, this.ownHandDepth);
    this.ownHandGroup.quaternion.copy(this.ownHandQuaternion);
    // `ownHandDrop` is measured in camera-space units, so move along the
    // camera's own up axis. World-down would collapse into depth in a top view.
    const cameraUp = BoardGameScene._scratchPoint
      .set(0, 1, 0)
      .applyQuaternion(this.ownHandQuaternion);
    this.ownHandGroup.position.addScaledVector(cameraUp, -baseDrop);

    const distance = this.camera.position.distanceTo(this.ownHandGroup.position);
    const targetScale = THREE.MathUtils.clamp(
      (distance / OWN_HAND_DISTANCE) ** OWN_HAND_SCALE_EXPONENT,
      OWN_HAND_SCALE_MIN,
      OWN_HAND_SCALE_MAX
    );
    const scaleAlpha = snap ? 1 : 1 - Math.exp(-Math.max(0, dt) * OWN_HAND_SCALE_DAMPING);
    this.ownHandScale = THREE.MathUtils.lerp(this.ownHandScale, targetScale, scaleAlpha);
    this.ownHandGroup.scale.setScalar(this.ownHandScale);

    // Let the hand hug the dock a little more as it grows, without letting the
    // attached overlay slide half a screen upwards when the camera pulls back.
    const drop = baseDrop * THREE.MathUtils.lerp(1, this.ownHandScale, 0.5);
    this.ownHandGroup.position.addScaledVector(cameraUp, baseDrop - drop);
  }

  /**
   * Turn + float the revealed board row.
   *
   * The group pivot is the table centre; only `rotation.y` and a small vertical
   * lift change, so the row never slides across the felt. Every card shares one
   * 4-second sine bob — static under `prefers-reduced-motion` — and a hovered
   * card or a fresh deal raises the whole row by 5 cm.
   */
  private updateDealerArea(dt: number, now: number): void {
    if (!this.dealerAreaActive) return;
    const targetYaw = dealerAreaYaw(this.camera.position.x, this.camera.position.z);
    const delta = shortestAngleDelta(this.dealerAreaGroup.rotation.y, targetYaw);
    const ease = this.reduceMotionQuery?.matches
      ? 1
      : Math.min(1, Math.max(0, dt) * 10);
    this.dealerAreaGroup.rotation.y += delta * ease;

    const lifted = this.dealerAreaHovered || now < this.dealerAreaLiftUntil;
    const targetY = BOARD_ROW_HOVER_Y + (lifted ? DEALER_LIFT : 0);
    this.dealerAreaGroup.position.y += (targetY - this.dealerAreaGroup.position.y) * ease;

    // One shared offset, so the row bobs as a single display rather than as a
    // handful of independently drifting cards.
    const bob = this.reduceMotionQuery?.matches ? 0 : dealerBobOffset(now);
    const dragged = this.draggedEntityId ? this.entityMeshes.get(this.draggedEntityId) : undefined;
    for (const item of this.dealerAreaFloatItems) {
      if (item.object === dragged) continue;
      const pausedUntil = Number(item.object.userData.dealerFloatPauseUntil ?? 0);
      if (now < pausedUntil) continue;
      item.object.position.y = item.baseY + bob;
    }
  }

  /**
   * Which way the seated viewer faces, for laying out a shared board row.
   *
   * Returns null — keep the row at its fixed bearing — unless *all* of these
   * hold: the game declared the `boardFacesViewer` capability, a seat is bound
   * as the viewer, and that seat has a projected SEAT node. A GOD camera, an
   * observer without a seat, or a game that never declared the capability all
   * fall through to the historical layout, so no other fixture changes.
   */
  private boardViewerBearing(state: ProjectedGameState): ViewerBearing | null {
    if (!this.lastLayout?.boardFacesViewer) return null;
    const viewerId = state.viewerId;
    if (!viewerId || viewerId === 'GOD') return null;
    const seatNode = Object.values(state.mapGraph.nodes).find(
      node => node.type === 'SEAT' && String(node.props?.playerId ?? '') === viewerId
    );
    if (!seatNode) return null;
    const [x, , z] = seatNode.position;
    const len = Math.hypot(x, z);
    if (!(len > 1e-6)) return null;
    return { outX: x / len, outZ: z / len };
  }

  private seatFrame(state: ProjectedGameState, ownerId?: string) {
    const seatNode = Object.values(state.mapGraph.nodes).find(
      n => n.type === 'SEAT' && n.props.playerId === ownerId
    );

    if (seatNode) {
      const x = seatNode.position[0];
      const z = seatNode.position[2];
      const len = Math.max(0.0001, Math.hypot(x, z));
      return {
        x,
        z,
        outX: x / len,
        outZ: z / len,
        facing: Math.atan2(x / len, z / len)
      };
    }

    const ownerIndex = Math.max(0, state.playerOrder.indexOf(ownerId || 'p1'));
    const seatCount = Math.max(state.playerOrder.length, 2);
    const theta = Math.PI / 2 + (ownerIndex * Math.PI * 2) / seatCount;
    const x = Math.cos(theta) * 8.2;
    const z = Math.sin(theta) * 5.2;
    return {
      x,
      z,
      outX: Math.cos(theta),
      outZ: Math.sin(theta),
      facing: Math.atan2(Math.cos(theta), Math.sin(theta))
    };
  }

  private renderHand(
    state: ProjectedGameState,
    zone: ProjectedGameState['zones'][string],
    items: (Partial<Entity> & { isMasked?: boolean; id: string })[]
  ): void {
    const frame = this.seatFrame(state, zone.ownerId);
    // The reader's own hand is a camera-attached overlay; every other seat's
    // hand is still a physical row on the felt at the fixed HAND_ROW_DEPTH.
    const cameraAttached =
      state.viewerId !== 'GOD' && !!state.viewerId && zone.ownerId === state.viewerId;
    // The row runs along the seat's tangent: +row is the seat's left-hand side,
    // so index order reads left-to-right for the player sitting there.
    const axisX = -frame.outZ;
    const axisZ = frame.outX;
    const span = cameraAttached
      ? this.ownHandSpan(items.length)
      : handRowSpan(items.length, HAND_ROW_SPAN, HAND_CARD_WIDTH);
    const depth = HAND_ROW_DEPTH;
    const originX = frame.x + frame.outX * depth;
    const originZ = frame.z + frame.outZ * depth;
    const parent = cameraAttached ? this.ownHandGroup : this.boardObjectsGroup;

    // Every card in the hand gets a mesh. There is no count cap any more: the
    // fisheye layout below normalises the whole hand into one strip, so a
    // 50-card hand still fits the row instead of silently dropping 40 cards.
    const ids: string[] = [];
    for (const entity of items) {
      const face = entity.components?.cardFace || { title: 'Card' };
      const handStyle = this.lastState?.gameId === 'poker' ? 'playing' : 'plate';
      // A hand card is a pure function of its face and mask state, so a card
      // that stays in hand across two syncs is cloned, not repainted.
      const mesh = this.furniture.obtain(
        `hand:${entity.id}`,
        signatureOf(
          face,
          HAND_CARD_MESH_WIDTH,
          1.68 * CARD_SIZE_MULTIPLIER,
          !!entity.isMasked,
          handStyle
        ),
        () =>
          CardMeshBuilder.createCardMesh(
            face,
            HAND_CARD_MESH_WIDTH,
            1.68 * CARD_SIZE_MULTIPLIER,
            !!entity.isMasked,
            null,
            null,
            handStyle
          )
      );
      if (cameraAttached) {
        // A screen-space card starts as a vertical quad: +Y (face) → +Z
        // (towards the camera), and its printed top (−Z) → +Y (screen up).
        mesh.rotation.order = 'ZYX';
        mesh.rotation.set(Math.PI / 2, 0, 0);
        mesh.userData.restYaw = 0;
        mesh.userData.ownHandCardId = entity.id;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      } else {
        mesh.rotation.y = frame.facing;
        // The deal tween spins a fresh card and must land on the row's bearing,
        // not on world north; `layoutHandRow` rewrites this every frame anyway.
        mesh.userData.restYaw = frame.facing;
      }
      parent.add(mesh);
      this.entityMeshes.set(entity.id, mesh);
      if (cameraAttached) {
        const shadow = this.createOwnHandShadow(OWN_HAND_CARD_WIDTH);
        shadow.userData.ownHandCardId = entity.id;
        shadow.renderOrder = 80 + ids.length;
        this.ownHandGroup.add(shadow);
        this.ownHandShadows.set(entity.id, shadow);
      }
      this.raycaster.registerInteractive(mesh, {
        type: 'ENTITY',
        id: entity.id,
        // A hand is a read-only HUD surface: still clickable for details, but
        // never a drag prop (the raycaster checks this flag before arming a drag).
        metadata: { ...face, draggable: false }
      });
      ids.push(entity.id);
    }

    const row: HandRow = {
      zoneId: zone.id,
      ids,
      seatX: frame.x,
      seatZ: frame.z,
      outX: frame.outX,
      outZ: frame.outZ,
      depth,
      originX,
      originZ,
      axisX,
      axisZ,
      facing: frame.facing,
      span,
      cameraAttached,
      // Start where the pointer already is, so rebuilding the board does not
      // make the hand re-expand under a stationary cursor.
      focus: { ...this.handPointerTarget },
      target: { ...this.handPointerTarget }
    };
    this.handRows.set(zone.id, row);
    this.layoutHandRow(row);
    if (row.cameraAttached) this.startOwnHandCut(row);
  }

  /**
   * Place one hand row.
   *
   * Other seats use the pure fisheye layout in `ui/handLayout.ts`; the viewer's
   * own hand uses a fixed 18%-overlap fan so it reads as cards held in a hand.
   * Both paths are idempotent, so the render loop can re-run them without
   * rebuilding a mesh.
   */
  private layoutHandRow(row: HandRow): void {
    const count = row.ids.length;
    if (count === 0) return;
    if (row.cameraAttached) {
      this.layoutOwnHandRow(row);
      return;
    }

    const hoveredId = this.hoveredEntityId;
    const hoverIndex = hoveredId ? row.ids.indexOf(hoveredId) : -1;
    const cardWidth = HAND_CARD_WIDTH;
    const layout = handLayout({
      count,
      containerWidth: row.span,
      cardWidth,
      focusX: row.focus.x,
      focusStrength: row.focus.strength,
      hoverIndex: hoverIndex >= 0 ? hoverIndex : null
    });
    // Small hands should stay nearly flat; the fan only opens up as the row
    // fills, which is how the previous hand geometry behaved.
    const yawSpread = Math.min(HAND_FAN_YAW, (count - 1) * HAND_FAN_STEP);

    for (const card of layout.cards) {
      const id = row.ids[card.index];
      const mesh = this.entityMeshes.get(id);
      if (!mesh) continue;
      // A card the user is dragging (or that is settling after a drop) owns its
      // own position; the layout must not fight it. Own-hand cards are not
      // draggable, so this only matters for the seat rows.
      if (
        id === this.draggedEntityId ||
        this.animatingActionCardIds.has(id) ||
        this.cardSettles.has(id) ||
        this.groupDrag?.bases.has(id)
      ) {
        continue;
      }

      const along = card.x - row.span / 2;
      mesh.position.set(
        row.originX + row.axisX * along,
        HAND_ROW_Y + card.index * HAND_CARD_STACK_STEP + card.lift * HAND_HOVER_LIFT,
        row.originZ + row.axisZ * along
      );
      mesh.scale.setScalar((card.scale * cardWidth) / HAND_CARD_MESH_WIDTH);
      mesh.rotation.y = row.facing + (card.x / row.span - 0.5) * yawSpread;
      // Overlapping cards are coplanar; renderOrder plus the tiny height step
      // keeps the fan stacking stable instead of z-fighting.
      mesh.renderOrder = card.z;
      this.applyCardVisualOffset(id, mesh);
    }
  }

  /** Fan position/angle for card `index`, in `ownHandGroup` local space. */
  private ownHandFanPose(
    index: number,
    count: number,
    step: number
  ): { x: number; y: number; rotation: number } {
    const centre = (count - 1) / 2;
    const offset = index - centre;
    const edge = centre > 0 ? Math.abs(offset) / centre : 0;
    return {
      x: offset * step,
      // A shallow rainbow: the middle of the hand sits higher than its ends.
      y: (1 - edge * edge) * OWN_HAND_ARC_RISE,
      // Left cards lean left, right cards lean right, like a held hand.
      rotation: -offset * OWN_HAND_FAN_TILT
    };
  }

  /**
   * Apply an own-hand card's local pose and keep its soft shadow one centimetre
   * behind it. The shadow is an ordinary mesh in the same group, not a real-time
   * shadow-map caster, so moving cards stay cheap.
   */
  private poseOwnHandCard(
    mesh: THREE.Object3D,
    shadow: THREE.Mesh | undefined,
    x: number,
    y: number,
    z: number,
    rotation: number
  ): void {
    mesh.position.set(x, y, z);
    mesh.rotation.set(Math.PI / 2, 0, rotation, 'ZYX');
    if (!shadow) return;

    const displayWidth = mesh.scale.x * HAND_CARD_MESH_WIDTH;
    const displayHeight = displayWidth * 1.5;
    shadow.position.set(x, y - displayHeight * 0.52, z - 0.01);
    shadow.scale.set(displayWidth * 0.94, displayHeight * 0.14, 1);
    shadow.rotation.set(0, 0, rotation);
  }

  /** Resting 18%-overlap fan for the viewer's camera-attached hand. */
  private layoutOwnHandRow(row: HandRow): void {
    const count = row.ids.length;
    const metrics = this.ownHandFanMetrics(count);
    row.span = metrics.span;
    const hoveredId = this.hoveredEntityId;

    row.ids.forEach((id, index) => {
      const mesh = this.entityMeshes.get(id);
      if (!mesh) return;
      const hovered = hoveredId === id;
      const displayScale = hovered ? OWN_HAND_HOVER_SCALE : 1;
      const displayWidth = metrics.cardWidth * displayScale;
      const pose = this.ownHandFanPose(index, count, metrics.step);
      const y = pose.y + (hovered ? OWN_HAND_HOVER_LIFT : 0);

      mesh.scale.setScalar(displayWidth / HAND_CARD_MESH_WIDTH);
      // Left-to-right stacking is explicit, so overlapping cards never swap
      // draw order as the camera or pointer moves.
      mesh.renderOrder = 100 + index;
      const shadow = this.ownHandShadows.get(id);
      if (shadow) shadow.renderOrder = 80 + index;
      this.poseOwnHandCard(mesh, shadow, pose.x, y, index * 0.001, pose.rotation);
    });
  }

  /**
   * Capture the resting fan and start one cut animation.
   *
   * Called after every own-hand rebuild/deal, so the hand visibly re-settles.
   * Reduced-motion users skip the sequence and keep the final fan immediately.
   */
  private startOwnHandCut(row: HandRow): void {
    this.ownHandCut = undefined;
    if (row.ids.length === 0) return;
    if (this.reduceMotionQuery?.matches === true) {
      this.layoutHandRow(row);
      return;
    }

    const count = row.ids.length;
    const cards: OwnHandCutCard[] = [];
    row.ids.forEach((id, index) => {
      const mesh = this.entityMeshes.get(id);
      if (!mesh) return;
      cards.push({
        id,
        mesh,
        shadow: this.ownHandShadows.get(id),
        fanX: mesh.position.x,
        fanY: mesh.position.y,
        fanZ: mesh.position.z,
        fanRotation: mesh.rotation.z,
        delay: index * OWN_HAND_CUT_STAGGER_MS,
        side: index < count / 2 ? -1 : 1
      });
    });
    if (cards.length === 0) return;

    const lastDelay = Math.max(...cards.map(card => card.delay));
    this.ownHandCut = {
      // The rebuild that created these meshes may spend its first frame
      // compiling GPU resources. Starting the clock then would swallow the
      // whole effect, so one full render warms up before the clock starts.
      warmedUp: false,
      startedAt: null,
      duration:
        OWN_HAND_CUT_GATHER_MS + OWN_HAND_CUT_SPLIT_MS + OWN_HAND_CUT_RETURN_MS + lastDelay,
      zoneId: row.zoneId,
      cards
    };
  }

  /** Advance the current cut; runs after the hover layout so it owns the pose. */
  private updateOwnHandCut(now: number): void {
    const cut = this.ownHandCut;
    if (!cut) return;
    const row = this.handRows.get(cut.zoneId);
    if (this.reduceMotionQuery?.matches === true) {
      this.ownHandCut = undefined;
      if (row) this.layoutHandRow(row);
      return;
    }

    if (!cut.warmedUp) {
      // The first frame after a rebuild compiles the new card programs; run it
      // with the resting fan (already laid out) and start the clock next frame.
      cut.warmedUp = true;
      return;
    }
    if (cut.startedAt === null) {
      cut.startedAt = now;
      for (const card of cut.cards) {
        this.poseOwnHandCard(card.mesh, card.shadow, card.fanX, card.fanY, card.fanZ, card.fanRotation);
      }
      return;
    }
    const startedAt = cut.startedAt;
    const springMs = OWN_HAND_CUT_SPLIT_MS + OWN_HAND_CUT_RETURN_MS;
    for (const card of cut.cards) {
      const local = now - startedAt - card.delay;
      let x = card.fanX;
      let y = card.fanY;
      let rotation = card.fanRotation;

      if (local > 0 && local < OWN_HAND_CUT_GATHER_MS + springMs) {
        const gather = easeOutCubic(
          Math.min(1, Math.max(0, local / OWN_HAND_CUT_GATHER_MS))
        );
        x = mix(card.fanX, 0, gather);
        y = mix(card.fanY, OWN_HAND_CUT_LIFT, gather);
        rotation = mix(card.fanRotation, 0, gather);

        if (local > OWN_HAND_CUT_GATHER_MS) {
          const spring = local - OWN_HAND_CUT_GATHER_MS;
          const splitX = card.side * OWN_HAND_CUT_SPLIT;
          const splitY = OWN_HAND_CUT_LIFT - OWN_HAND_CUT_SPLIT;
          const splitRotation = card.side * 0.1;
          const splitProgress = easeOutCubic(
            Math.min(1, spring / OWN_HAND_CUT_SPLIT_MS)
          );
          x = mix(0, splitX, splitProgress);
          y = mix(OWN_HAND_CUT_LIFT, splitY, splitProgress);
          rotation = mix(0, splitRotation, splitProgress);

          if (spring > OWN_HAND_CUT_SPLIT_MS) {
            const returnProgress = easeOutCubic(
              Math.min(1, (spring - OWN_HAND_CUT_SPLIT_MS) / OWN_HAND_CUT_RETURN_MS)
            );
            x = mix(splitX, card.fanX, returnProgress);
            y = mix(splitY, card.fanY, returnProgress);
            rotation = mix(splitRotation, card.fanRotation, returnProgress);
          }
        }
      }
      this.poseOwnHandCard(card.mesh, card.shadow, x, y, card.fanZ, rotation);
    }

    if (now >= startedAt + cut.duration) {
      this.ownHandCut = undefined;
      if (row) this.layoutHandRow(row);
    }
  }

  /** Project a point on a hand row into canvas pixels, or null when behind. */
  private projectHandRowPoint(
    row: HandRow,
    along: number,
    rect: DOMRect
  ): { x: number; y: number } | null {
    const point = BoardGameScene._scratchPoint;
    if (row.cameraAttached) {
      this.ownHandGroup.updateWorldMatrix(true, false);
      point.set(along, 0, 0).applyMatrix4(this.ownHandGroup.matrixWorld);
    } else {
      point.set(
        row.originX + row.axisX * along,
        HAND_ROW_Y,
        row.originZ + row.axisZ * along
      );
    }
    point.applyMatrix4(this.camera.matrixWorldInverse);
    if (point.z > -0.2) return null; // at or behind the camera plane
    point.applyMatrix4(this.camera.projectionMatrix);
    return {
      x: rect.left + (point.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-point.y * 0.5 + 0.5) * rect.height
    };
  }

  /**
   * Map the pointer onto every hand row.
   *
   * The pointer is projected onto each row's screen-space segment and clamped
   * to [0, 1], so hovering past either end parks the focus on that end — the
   * requirement that the fisheye works at the edges, not only in the middle.
   * A row the pointer is far away from goes back to uniform.
   */
  private onHandPointerMove = (event: PointerEvent): void => {
    if (this.handRows.size === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    // Camera matrices are refreshed on render; a pointer event can arrive
    // before the first frame, so make sure the projection is current.
    this.camera.updateMatrixWorld();
    let nearest = Number.POSITIVE_INFINITY;

    for (const row of this.handRows.values()) {
      const start = this.projectHandRowPoint(row, -row.span / 2, rect);
      const end = this.projectHandRowPoint(row, row.span / 2, rect);
      if (!start || !end) {
        row.target = { x: 0.5, strength: 0 };
        continue;
      }
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq < 64) {
        // Row is edge-on: a horizontal cursor position would be meaningless.
        row.target = { x: 0.5, strength: 0 };
        continue;
      }
      const raw = ((event.clientX - start.x) * dx + (event.clientY - start.y) * dy) / lengthSq;
      const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const distance = Math.hypot(
        event.clientX - (start.x + dx * t),
        event.clientY - (start.y + dy * t)
      );
      row.target = distance <= HAND_FOCUS_BAND_PX ? { x: t, strength: 1 } : { x: 0.5, strength: 0 };
      if (distance < nearest) {
        nearest = distance;
        this.handPointerTarget = { ...row.target };
      }
    }
  };

  private onHandPointerLeave = (): void => {
    this.handPointerTarget = { x: 0.5, strength: 0 };
    for (const row of this.handRows.values()) row.target = { x: 0.5, strength: 0 };
  };

  /**
   * Ease every row's fisheye towards its target and re-place the rows that
   * moved. `prefers-reduced-motion` snaps instead of easing.
   */
  private updateHandFocus(dt: number): void {
    if (this.handRows.size === 0) return;
    const snap = this.reduceMotionQuery?.matches === true;
    const ease = snap ? 1 : Math.min(1, dt * 14);
    const hoveredId = this.hoveredEntityId ?? null;
    const hoverChanged = hoveredId !== this.lastHandHoverId;
    this.lastHandHoverId = hoveredId;

    for (const row of this.handRows.values()) {
      const { focus, target } = row;
      const nextX = focus.x + (target.x - focus.x) * ease;
      const nextStrength = focus.strength + (target.strength - focus.strength) * ease;
      const settled = Math.abs(nextX - target.x) < 1e-4 && Math.abs(nextStrength - target.strength) < 1e-4;
      const appliedX = settled ? target.x : nextX;
      const appliedStrength = settled ? target.strength : nextStrength;
      const moved =
        Math.abs(appliedX - focus.x) > 1e-4 || Math.abs(appliedStrength - focus.strength) > 1e-4;
      focus.x = appliedX;
      focus.strength = appliedStrength;
      if (moved || hoverChanged) this.layoutHandRow(row);
    }
  }

  /** Equipment / judgement cards sit beside their owner's seat. */
  private renderSeatCards(
    state: ProjectedGameState,
    zone: ProjectedGameState['zones'][string],
    items: (Partial<Entity> & { isMasked?: boolean; id: string })[]
  ): void {
    const frame = this.seatFrame(state, zone.ownerId);
    const isEquip = zone.type === 'EQUIP';
    const perpX = -frame.outZ;
    const perpZ = frame.outX;
    const side = isEquip ? 1 : -1;
    const limit = Math.min(items.length, 4);

    for (let i = 0; i < limit; i++) {
      const entity = items[i];
      const face = entity.components?.cardFace || { title: 'Card' };
      const mesh = this.furniture.obtain(
        `seat-card:${entity.id}`,
        signatureOf(face, 0.78, 1.16, !!entity.isMasked),
        () => CardMeshBuilder.createCardMesh(face, 0.78, 1.16, !!entity.isMasked)
      );
      const offset = 1.9 + i * 0.55;

      mesh.position.set(
        frame.x + perpX * side * offset - frame.outX * 0.4,
        0.12,
        frame.z + perpZ * side * offset - frame.outZ * 0.4
      );
      mesh.rotation.y = frame.facing;
      mesh.userData.restYaw = frame.facing;
      this.applyCardVisualOffset(entity.id, mesh);
      this.boardObjectsGroup.add(mesh);
      this.entityMeshes.set(entity.id, mesh);
      this.raycaster.registerInteractive(mesh, { type: 'ENTITY', id: entity.id, metadata: face });
    }

    const label = this.createLabelSprite(isEquip ? '装备' : '判定区', '#c9b57a', 36);
    label.position.set(
      frame.x + perpX * side * 2.05 - frame.outX * 1.4,
      0.7,
      frame.z + perpZ * side * 2.05 - frame.outZ * 1.4
    );
    label.scale.set(1.5, 0.42, 1);
    this.boardObjectsGroup.add(label);
  }

  /* ------------------------------------------------------------------ */
  /* Table dressing per game                                             */
  /* ------------------------------------------------------------------ */

  private renderGameDecor(state: ProjectedGameState): void {
    if (state.gameId === 'sanguosha') {
      // Fit the felt to the actual seat ring: 4 seats need much less cloth than
      // 8, and a fixed 9.6×7.4 mat would leave the outer seats floating.
      const seats = Object.values(state.mapGraph.nodes).filter(node => node.type === 'SEAT');
      const halfX = Math.max(4.8, ...seats.map(node => Math.abs(node.position[0]))) + 1.8;
      const halfZ = Math.max(3.7, ...seats.map(node => Math.abs(node.position[2]))) + 1.8;
      this.addTableMat(halfX * 2, halfZ * 2, 0, -0.2);
      const title = this.createLabelSprite('SANGUOSHA · 三国杀', '#c9b57a', 40);
      title.position.set(0, 0.5, halfZ * 0.35);
      title.scale.set(4.4, 0.72, 1);
      this.boardObjectsGroup.add(title);
    }

    if (state.gameId === 'splendor') {
      // Market grid, sized to the actual card extent so the felt never shows a
      // mismatch between the mat and the cards standing on it.
      // One mat per band, each sized from the cards that stand on it.
      const gridW = (PKMN_MARKET_COLUMNS - 1) * PKMN_MARKET_PITCH_X + PKMN_CARD_W + 0.7;
      const gridD = 2 * PKMN_MARKET_PITCH_Z + PKMN_CARD_H + 0.7;
      const gridZ = PKMN_MARKET_Z1 - PKMN_MARKET_PITCH_Z;
      this.addTableMat(gridW, gridD, PKMN_MARKET_X, gridZ);

      // Stage piles: one narrow mat per row, hugging the row it feeds.
      for (let row = 0; row < 3; row += 1) {
        const z = PKMN_DECK_Z_TOP - row * PKMN_DECK_ROW_STEP;
        this.addTableMat(PKMN_DECK_CARD_W + 0.55, PKMN_DECK_CARD_H + 0.5, PKMN_DECK_RAIL_X, z);
      }

      // Top band: each special pile beside the card it revealed.
      for (const zoneId of ['zone_rare', 'zone_legend']) {
        const pile = PKMN_DECK_RAIL[zoneId];
        const reveal = PKMN_REVEAL_RAIL[zoneId];
        if (!pile || !reveal) continue;
        const spanX = reveal[0] - pile[0] + PKMN_CARD_W + 0.55;
        this.addTableMat(spanX, PKMN_CARD_H + 0.5, (pile[0] + reveal[0]) / 2, pile[2]);
      }

      const title = this.createLabelSprite('宝可梦市场 · POKÉMON MARKET', '#c9b57a', 64);
      // Low and just clear of the first row: a tall sprite at this depth is
      // projected back across the cards behind it.
      title.position.set(PKMN_MARKET_X, 0.24, PKMN_MARKET_Z1 + PKMN_CARD_H * 0.5 + 0.52);
      title.scale.set(4.6, 0.58, 1);
      this.boardObjectsGroup.add(title);

      // Poké Ball bank tray — widened to hold all six colours side by side.
      this.addTableMat(1.9, 7.2, 7.55, 0.1);
      const bankTitle = this.createLabelSprite('精灵球银行 · BALL BANK', '#cfd8e6', 56);
      bankTitle.position.set(7.4, 0.42, -3.75);
      bankTitle.scale.set(2.8, 0.44, 1);
      this.boardObjectsGroup.add(bankTitle);

      // One band per seat along the near edge for the caught-Pokémon tableaus.
      const seats = Math.max(1, state.playerOrder.length);
      state.playerOrder.forEach((playerId, index) => {
        const x = (index - (seats - 1) / 2) * PKMN_TABLEAU_SLOT_WIDTH;
        this.addTableMat(PKMN_TABLEAU_SLOT_WIDTH - 0.35, 2.5, x, PKMN_TABLEAU_Z + 0.2);
        const caption = this.createLabelSprite(
          `${state.players[playerId]?.name ?? playerId} · 宝可梦图鉴`,
          state.players[playerId]?.color ?? '#cfd8e6',
          54
        );
        caption.position.set(x, 0.42, PKMN_TABLEAU_Z + 1.42);
        caption.scale.set(2.6, 0.4, 1);
        this.boardObjectsGroup.add(caption);
      });
    }

    if (state.gameId === 'catan') {
      const ports = (state.globalVars.ports ?? []) as {
        position: [number, number, number];
        type: string;
        resource?: string;
      }[];

      for (const port of ports) {
        const resLabel: Record<string, string> = {
          wood: '木材',
          brick: '砖',
          sheep: '羊毛',
          wheat: '麦',
          ore: '矿'
        };
        const text = port.resource ? `${port.type} ${resLabel[port.resource] ?? port.resource}` : port.type;
        const label = this.createLabelSprite(text, port.type === '2:1' ? '#f6dc9c' : '#cbd5e1', 44);
        label.position.set(port.position[0], 0.42, port.position[2]);
        label.scale.set(2.1, 0.46, 1);
        this.boardObjectsGroup.add(label);
      }

      const title = this.createLabelSprite('CATAN · 卡坦岛', '#c9b57a', 38);
      title.position.set(0, 0.5, -6.6);
      title.scale.set(3.6, 0.62, 1);
      this.boardObjectsGroup.add(title);
    }

    if (state.gameId === 'dune_mahjong') {
      this.renderDuneDecor(state);
    }

    if (state.gameId === 'poker') {
      this.renderPokerDecor(state);
    }

    if (state.gameId === 'betrayal') {
      const anchors = this.floorAnchorsFor(state, this.lastPlacement);
      const labels: [string, string][] = [
        ['BASEMENT', '地下室 · BASEMENT'],
        ['GROUND', '一楼 · GROUND'],
        ['UPPER', '二楼 · UPPER']
      ];
      for (const [key, text] of labels) {
        const anchor = anchors[key];
        if (!anchor) continue;
        this.addTableMat(anchor.width + 2, anchor.depth + 2, anchor.x, anchor.z, key);
        const plate = this.createLabelSprite(text, key === 'BASEMENT' ? '#a9c2d8' : key === 'UPPER' ? '#cbb4e8' : '#e0c98a', 34);
        plate.position.set(anchor.x, 0.55, anchor.z + anchor.depth / 2 + 1.3);
        plate.scale.set(6.4, 0.78, 1);
        plate.userData.floor = key;
        this.boardObjectsGroup.add(plate);
      }

      const title = this.createLabelSprite('BETRAYAL · 山屋惊魂', '#c9b57a', 38);
      title.position.set(0, 0.5, 9.8);
      title.scale.set(5.4, 0.66, 1);
      this.boardObjectsGroup.add(title);

      const roomDeckCount = state.zones.zone_room_deck?.orderedEntities.length ?? 0;
      const roomDeckLabel = this.createLabelSprite(`房间板块堆 · ${roomDeckCount}`, '#cbb57a', 34);
      roomDeckLabel.position.set(-12, 0.55, 7.4);
      roomDeckLabel.scale.set(3.4, 0.5, 1);
      this.boardObjectsGroup.add(roomDeckLabel);

      if (state.globalVars.hauntTriggered) {
        const haunt = state.globalVars.haunt as { revealRoomId?: string } | null;
        const room = haunt?.revealRoomId ? state.mapGraph.nodes[haunt.revealRoomId] : undefined;
        const sigil = new THREE.Mesh(
          new THREE.TorusGeometry(1.55, 0.05, 8, 48),
          new THREE.MeshStandardMaterial({ color: 0xd50000, emissive: 0xd50000, emissiveIntensity: 0.9, roughness: 0.4 })
        );
        sigil.rotation.x = -Math.PI / 2;
        sigil.position.set(room?.position[0] ?? 0, 0.08, room?.position[2] ?? 0);
        if (room?.props?.floor) sigil.userData.floor = String(room.props.floor);
        this.boardObjectsGroup.add(sigil);
      }
    }
  }

  private static pokerCloth: THREE.Texture | null = null;

  /**
   * Matte green poker cloth.
   *
   * A flat green disc reads as plastic under the key light, so the cloth is
   * baked once into a canvas: a deep green base, thousands of short fibre
   * strokes at slightly random angles (the weave), soft mottling for depth and
   * a darkened rim where the cloth tucks under the rail. Everything is
   * deterministic — no `Math.random()` — so reloads look identical.
   */
  private static pokerClothTexture(): THREE.Texture {
    if (BoardGameScene.pokerCloth) return BoardGameScene.pokerCloth;

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the poker cloth');

    ctx.fillStyle = '#17603a';
    ctx.fillRect(0, 0, size, size);

    // Deterministic LCG so the weave never changes between reloads.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // Fibre weave: short strokes in both directions plus stray threads.
    for (let i = 0; i < 12000; i++) {
      const x = rnd() * size;
      const y = rnd() * size;
      const length = 2 + rnd() * 5;
      const angle = rnd() > 0.55 ? 0 : Math.PI / 2 + (rnd() - 0.5) * 0.9;
      ctx.strokeStyle = rnd() > 0.5 ? 'rgba(232,255,240,0.05)' : 'rgba(0,0,0,0.055)';
      ctx.lineWidth = 0.7 + rnd() * 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      ctx.stroke();
    }

    // One soft light pool so the cloth is lit unevenly like a real table, but
    // without any distinct patches.
    const sheen = ctx.createRadialGradient(size * 0.42, size * 0.38, size * 0.08, size * 0.5, size * 0.5, size * 0.58);
    sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
    sheen.addColorStop(0.6, 'rgba(255,255,255,0.02)');
    sheen.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);

    // Darkened rim where the cloth meets the rail.
    const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.5);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    BoardGameScene.pokerCloth = texture;
    return texture;
  }

  /**
   * Second line of a seat plate: the numbers that matter for the current game.
   * Poker shows the stack plus the position/status markers, Sanguosha the health
   * and hand size; anything else leaves the plate with just the nickname.
   */
  private seatPlateDetail(state: ProjectedGameState, playerId: string): string | undefined {
    const player = state.players[playerId];
    if (!player) return undefined;

    if (state.gameId === 'poker') {
      const hand = state.globalVars.hand as
        | {
            buttonSeat?: number;
            sbSeat?: number;
            bbSeat?: number;
            folded?: string[];
              street?: string;
              readyForNext?: string[];
            allIn?: string[];
          }
        | undefined;
      const seatIndex = Number(player.customProps?.seat ?? -1);
      const chips = Number(player.customProps?.chips ?? 0);
      const marks: string[] = [];
      if (hand?.buttonSeat === seatIndex) marks.push('庄家');
      if (hand?.sbSeat === seatIndex) marks.push('小盲');
      if (hand?.bbSeat === seatIndex) marks.push('大盲');
      if (hand?.folded?.includes(playerId)) marks.push('弃牌');
      else if (hand?.allIn?.includes(playerId)) marks.push('全押');
      else if (chips <= 0) marks.push('出局');
      return [`筹码 ${chips}`, ...marks].join(' · ');
    }

    if (state.gameId === 'sanguosha') {
      const hp = Number(player.customProps?.hp ?? 0);
      const maxHp = Number(player.customProps?.maxHp ?? 4);
      const cards = state.zones[`zone_hand_${playerId}`]?.orderedEntities.length ?? 0;
      return `体力 ${hp}/${maxHp} · 手牌 ${cards}`;
    }

    return undefined;
  }

  /**
   * Poker table dressing: felt oval, brass rim, pot readout, one stack label per
   * seat and the table title. Presentation only — it reads the projected state
   * and never participates in the rules.
   */
  private renderPokerDecor(state: ProjectedGameState): void {
    // Effects from the previous step never survive into the next one.
    this.clearPokerFx();
    const hand = state.globalVars.hand as
      | {
          pot?: number;
          streetBets?: Record<string, number>;
          buttonSeat?: number;
          folded?: string[];
              street?: string;
              readyForNext?: string[];
          allIn?: string[];
        }
      | undefined;

    const seats = Object.values(state.mapGraph.nodes).filter(node => node.type === 'SEAT');
    const rx = Math.max(3.6, ...seats.map(node => Math.abs(node.position[0]))) + 1.1;
    const rz = Math.max(2.6, ...seats.map(node => Math.abs(node.position[2]))) + 1.1;

    // Padded rail under the cloth: a darker, slightly larger oval so the felt
    // reads as inset rather than painted on the floor.
    //
    // Rail, cloth and rim only depend on the table's radius, which moves when a
    // seat is added or removed — not when a card is dealt. They are the most
    // expensive static furniture on the table (two 96-segment discs and a
    // 72-segment torus), so they come from the template cache.
    const tableSignature = `${rx.toFixed(2)}|${rz.toFixed(2)}`;
    const rail = this.furniture.obtain('poker:rail', tableSignature, () => {
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(1, 96),
        new THREE.MeshStandardMaterial({ color: 0x241a14, roughness: 0.92, metalness: 0.04 })
      );
      mesh.receiveShadow = true;
      return mesh;
    }) as THREE.Mesh;
    rail.rotation.x = -Math.PI / 2;
    rail.scale.set(rx + 0.32, rz + 0.32, 1);
    rail.position.set(0, 0.008, 0);
    this.boardObjectsGroup.add(rail);

    // Matte green cloth with a woven fibre texture (built once, reused).
    // One texture per table: the light pool and the rim shading are baked into
    // it, so it must not tile.
    const clothTexture = BoardGameScene.pokerClothTexture();
    const felt = this.furniture.obtain('poker:felt', tableSignature, () => {
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(1, 96),
        new THREE.MeshStandardMaterial({
          map: clothTexture,
          color: 0xffffff,
          roughness: 1,
          metalness: 0
        })
      );
      mesh.receiveShadow = true;
      return mesh;
    }) as THREE.Mesh;
    felt.rotation.x = -Math.PI / 2;
    felt.scale.set(rx, rz, 1);
    felt.position.set(0, 0.02, 0);
    this.boardObjectsGroup.add(felt);

    const rim = this.furniture.obtain('poker:rim', tableSignature, () => {
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.02, 8, 72),
        new THREE.MeshStandardMaterial({
          color: 0xc9a24a,
          emissive: 0x6b4d12,
          emissiveIntensity: 0.35,
          roughness: 0.5
        })
      );
      return mesh;
    }) as THREE.Mesh;
    rim.rotation.x = -Math.PI / 2;
    rim.scale.set(rx, rz, 1);
    rim.position.set(0, 0.05, 0);
    this.boardObjectsGroup.add(rim);

    const street = Object.values(hand?.streetBets ?? {}).reduce(
      (sum, amount) => sum + Number(amount ?? 0),
      0
    );
    const pot = Number(hand?.pot ?? 0) + street;
    const potZ = this.pokerPotZ(state);
    const potLabel = this.createLabelSprite(
      `POT · 底池 ${pot}`,
      '#f6dc9c',
      46,
      ZONE_LABEL_SUPERSAMPLE
    );
    potLabel.position.set(POKER_POT_X, POKER_POT_LABEL_Y, potZ);
    potLabel.scale.set(
      3.4 * POKER_POT_LABEL_SCALE,
      0.85 * POKER_POT_LABEL_SCALE,
      1
    );
    potLabel.userData.labelRole = 'pot';
    potLabel.userData.text = `POT · 底池 ${pot}`;
    potLabel.userData.fontScale = POKER_POT_LABEL_SCALE;
    this.boardObjectsGroup.add(potLabel);

    // The pot itself: a real pile of chips directly under the readout.
    if (pot > 0) {
      const potChips = this.furniture.obtain('poker:pot-chips', String(pot), () =>
        ChipMeshBuilder.createStack(pot)
      );
      potChips.position.set(POKER_POT_X, 0.03, potZ);
      this.boardObjectsGroup.add(potChips);
    }

    state.playerOrder.forEach(pid => {
      const seatNode = seats.find(node => node.props?.playerId === pid);
      if (!seatNode) return;
      const [x, , z] = seatNode.position;
      const length = Math.max(0.0001, Math.hypot(x, z));
      const inwardX = x / length;
      const inwardZ = z / length;
      const chips = Number(state.players[pid]?.customProps?.chips ?? 0);
      const tangentX = -inwardZ;
      const tangentZ = inwardX;
      if (chips > 0) {
        const stack = this.furniture.obtain(`poker:stack:${pid}`, String(chips), () =>
          ChipMeshBuilder.createStack(chips)
        );
        stack.position.set(
          x - inwardX * 1.9 + tangentX * 1.25,
          0.03,
          z - inwardZ * 1.9 + tangentZ * 1.25
        );
        this.boardObjectsGroup.add(stack);
      }

      // Chips already committed on this street sit between the seat and the pot.
      const bet = Number(hand?.streetBets?.[pid] ?? 0);
      if (bet > 0) {
        const betStack = this.furniture.obtain(`poker:bet:${pid}`, String(bet), () =>
          ChipMeshBuilder.createStack(bet)
        );
        betStack.position.set(x - inwardX * 3.1, 0.03, z - inwardZ * 3.1);
        this.boardObjectsGroup.add(betStack);
      }
    });

    this.animatePokerDeltas(state);
  }

  /** Drop every poker effect object (called at the start of each poker sync). */
  private clearPokerFx(): void {
    for (const child of [...this.pokerFxGroup.children]) {
      this.pokerFxGroup.remove(child);
      child.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        // material.dispose() 不会释放贴图：标签精灵的 CanvasTexture 必须单独 dispose，
        // 否则每手牌泄漏一批 1024x256 纹理。静态共享的桌面呢绒纹理除外。
        const maps: THREE.Texture[] = [];
        const keepMap = (entry: THREE.Material): boolean => entry.userData?.keepTexture === true;
        if (Array.isArray(material)) {
          for (const entry of material) {
            entry.dispose();
            if (!keepMap(entry) && (entry as THREE.MeshStandardMaterial).map) {
              maps.push((entry as THREE.MeshStandardMaterial).map!);
            }
          }
        } else if (material) {
          material.dispose();
          if (!keepMap(material)) {
            const map = (material as THREE.SpriteMaterial | THREE.MeshStandardMaterial).map;
            if (map) maps.push(map);
          }
        }
        for (const map of maps) {
          if (map !== BoardGameScene.pokerCloth) map.dispose();
        }
      });
    }
  }

  /**
   * Animate what changed since the previous poker snapshot.
   *
   * Everything is derived from the projected state itself, never from "who
   * clicked": both the host and every guest run the same diff, so a network
   * update gets the same beats as a local action.
   *
   *  1. **fold** — hole cards slide to the muck and fade;
   *  2. **deal** — hole cards arc out of the deck with a light turn;
   *  3. **reveal** — community cards fly in face-down and flip over on arrival;
   *  4. **chips** — bets fly from the seat to the pot.
   *
   * All four share a twelve-slot budget per sync; excess visuals land in their
   * resting pose immediately.
   */
  private animatePokerDeltas(state: ProjectedGameState): void {
    this.actionAnimationSlots = 0;
    const hand = state.globalVars.hand as
      | {
          handNo?: number;
          street?: string;
          community?: string[];
          streetBets?: Record<string, number>;
        }
      | undefined;
    if (!hand) return;

    const holeCards: Record<string, string[]> = {};
    for (const pid of state.playerOrder) {
      holeCards[pid] = [...(state.zones[`zone_hand_${pid}`]?.orderedEntities ?? [])];
    }
    const current = {
      handNo: Number(hand.handNo ?? 0),
      street: String(hand.street ?? ''),
      community: [...(hand.community ?? [])],
      streetBets: { ...(hand.streetBets ?? {}) },
      holeCards
    };
    const previous = this.pokerFxPrev;
    this.pokerFxPrev = current;
    if (!previous) {
      this.disposePendingPokerFoldVisuals();
      return;
    }

    const deckAnchor = state.zones.zone_deck?.anchorPosition ?? [-6, 0.06, -2.2];
    // The draw pile is a fixed table prop, so its world point is the zone
    // anchor. Board cards live inside the yawed/floating group, which needs the
    // same point in its local space; every other card uses the world point.
    const deckPointWorld = new THREE.Vector3(deckAnchor[0], deckAnchor[1] + 0.3, deckAnchor[2]);
    this.dealerAreaGroup.updateWorldMatrix(true, false);
    const deckPointLocal = this.dealerAreaGroup.worldToLocal(deckPointWorld.clone());

    this.animatePendingPokerFolds(state);

    /* 1. Deal: hole cards that were not in the hand before. */
    const freshCards: { id: string; mesh: THREE.Object3D; to: THREE.Vector3 }[] = [];
    const newHand = current.handNo !== previous.handNo;
    for (const pid of state.playerOrder) {
      const before = newHand ? [] : (previous.holeCards[pid] ?? []);
      for (const id of holeCards[pid]) {
        if (before.includes(id)) continue;
        const mesh = this.entityMeshes.get(id);
        if (!mesh) continue;
        // The viewer's own hand is a camera-attached overlay; flying a card in
        // from a world-space deck point would use the wrong coordinate space.
        // It is laid out immediately instead.
        if (mesh.parent === this.ownHandGroup) continue;
        freshCards.push({ id, mesh, to: mesh.position.clone() });
      }
    }
    if (freshCards.length > 0) {
      const stagger = Math.max(60, Math.min(120, 800 / Math.max(1, freshCards.length)));
      let animated = 0;
      freshCards.forEach(({ id, mesh, to }) => {
        if (!this.takeActionAnimationSlot()) return;
        const from =
          mesh.parent === this.dealerAreaGroup ? deckPointLocal.clone() : deckPointWorld.clone();
        const delay = animated * stagger;
        animated += 1;
        mesh.position.copy(from);
        // A card keeps its resting bearing (a hand card faces its owner's seat,
        // a board card faces the viewer's); only the extra turn of the deal is
        // animated. Writing the absolute spin here would snap the card back to
        // world north for the rest of the animation.
        const restYaw = Number(mesh.userData.restYaw ?? 0);
        this.animatingActionCardIds.add(id);
        this.animQueue.animate(
          DEAL_ANIMATION_MS,
          p => {
            mesh.position.x = THREE.MathUtils.lerp(from.x, to.x, p);
            mesh.position.z = THREE.MathUtils.lerp(from.z, to.z, p);
            mesh.position.y = THREE.MathUtils.lerp(from.y, to.y, p) + Math.sin(Math.PI * p) * 1.1;
            mesh.rotation.y = restYaw + (1 - p) * 0.42;
          },
          () => {
            mesh.position.copy(to);
            mesh.rotation.y = restYaw;
            this.animatingActionCardIds.delete(id);
          },
          delay
        );
      });
    }

    /* 2. Reveal: community cards that just appeared, dealt face-down then turned. */
    const freshBoard = current.community.filter(id => !previous.community.includes(id));
    if (freshBoard.length > 0) {
      const bigStreet = freshBoard.length >= 3;
      const duration = bigStreet ? 780 : 1700;
      const stagger = bigStreet ? 480 : 0;
      this.dealerAreaLiftUntil = Math.max(
        this.dealerAreaLiftUntil,
        performance.now() + 320 + (freshBoard.length - 1) * stagger + duration + 120
      );
      freshBoard.forEach((id, index) => {
        const mesh = this.entityMeshes.get(id);
        if (!mesh) return;
        if (!this.takeActionAnimationSlot()) return;
        const to = mesh.position.clone();
        const from =
          mesh.parent === this.dealerAreaGroup ? deckPointLocal.clone() : deckPointWorld.clone();
        // Start flat face-down on its flip-start angle, then turn to the
        // resting pose: +40° → −70° for the baked row cards, −π → 0 for a plain
        // legacy board row.
        const restTilt = Number(mesh.userData.restTilt ?? 0);
        const flipStart = Number(mesh.userData.flipStartTilt ?? -Math.PI);
        const delay = 320 + index * stagger;
        mesh.position.copy(from);
        mesh.rotation.x = flipStart;
        // The floating bob must not fight the deal arc.
        mesh.userData.dealerFloatPauseUntil = performance.now() + delay + duration + 80;
        this.animQueue.animate(
          duration,
          p => {
            mesh.position.x = THREE.MathUtils.lerp(from.x, to.x, p);
            mesh.position.z = THREE.MathUtils.lerp(from.z, to.z, p);
            mesh.position.y =
              THREE.MathUtils.lerp(from.y, to.y, p) + Math.sin(Math.PI * p) * 1.4;
            // Stay face down for the first third, then turn over.
            const flip = Math.max(0, Math.min(1, (p - 0.3) / 0.7));
            mesh.rotation.x = flipStart + (restTilt - flipStart) * flip;
          },
          undefined,
          delay
        );
      });
    }

    /* 3. Chips: money that moved into the pot this step. */
    const seats = Object.values(state.mapGraph.nodes).filter(node => node.type === 'SEAT');
    const potPoint = new THREE.Vector3(POKER_POT_X, 0.06, this.pokerPotZ(state));
    for (const pid of state.playerOrder) {
      const delta = Number(current.streetBets[pid] ?? 0) - Number(previous.streetBets[pid] ?? 0);
      if (delta <= 0) continue;
      const seatNode = seats.find(node => node.props?.playerId === pid);
      if (!seatNode) continue;
      const [x, , z] = seatNode.position;
      const length = Math.max(0.0001, Math.hypot(x, z));
      const from = new THREE.Vector3(x - (x / length) * 1.9, 0.06, z - (z / length) * 1.9);
      const chips = ChipMeshBuilder.decompose(delta, 6);
      let chipIndex = 0;
      chips.forEach(value => {
        if (!this.takeActionAnimationSlot()) return;
        const chip = ChipMeshBuilder.createChip(value, 0.2);
        chip.position.copy(from);
        this.pokerFxGroup.add(chip);
        const delay = chipIndex * 80;
        chipIndex += 1;
        this.animQueue.animateArc(chip, from, potPoint, 0.85, CHIP_FLIGHT_MS, undefined, delay);
      });

      // The amount floats up over the felt so a 200-chip raise is unmistakable.
      if (!this.takeActionAnimationSlot()) continue;
      const float = this.createLabelSprite(`+${delta}`, '#f6dc9c', 52);
      const startY = 0.9;
      float.position.set(from.x, startY, from.z);
      float.scale.set(1.9, 0.42, 1);
      this.pokerFxGroup.add(float);
      const material = float.material as THREE.SpriteMaterial;
      material.transparent = true;
      this.animQueue.animate(
        1800,
        p => {
          float.position.y = startY + p * 1.5;
          float.position.x = THREE.MathUtils.lerp(from.x, potPoint.x, Math.min(1, p * 0.6));
          float.position.z = THREE.MathUtils.lerp(from.z, potPoint.z, Math.min(1, p * 0.6));
          material.opacity = p < 0.7 ? 1 : Math.max(0, 1 - (p - 0.7) / 0.3);
        },
        undefined,
        220
      );
    }
  }

  /** Returns false once this sync has already queued twelve visible motions. */
  private takeActionAnimationSlot(): boolean {
    if (this.reduceMotionQuery?.matches === true) return false;
    if (this.actionAnimationSlots >= TABLE_ACTION_ANIMATION_LIMIT) return false;
    this.actionAnimationSlots += 1;
    return true;
  }

  /**
   * Capture the old hole-card meshes for players who just folded.
   *
   * This runs before the board rebuild. The new projection has already moved
   * those cards to the muck, so a render-only deep clone is the only way to
   * show them travelling there. It is deliberately a visual difference: the
   * game state changes immediately, the animation never gates it.
   */
  private capturePokerFoldVisuals(
    previous: ProjectedGameState | null,
    next: ProjectedGameState
  ): void {
    this.disposePendingPokerFoldVisuals();
    if (!previous || previous.gameId !== 'poker' || next.gameId !== 'poker') return;
    if (this.reduceMotionQuery?.matches === true) return;

    const priorHand = previous.globalVars.hand as { folded?: string[] } | undefined;
    const nextHand = next.globalVars.hand as { folded?: string[] } | undefined;
    const wasFolded = new Set(priorHand?.folded ?? []);
    const nowFolded = new Set(nextHand?.folded ?? []);
    for (const pid of next.playerOrder) {
      if (!nowFolded.has(pid) || wasFolded.has(pid)) continue;
      for (const id of previous.zones[`zone_hand_${pid}`]?.orderedEntities ?? []) {
        if (this.pendingPokerFoldVisuals.length >= TABLE_ACTION_ANIMATION_LIMIT) return;
        const mesh = this.entityMeshes.get(id);
        if (mesh) this.pendingPokerFoldVisuals.push(this.cloneActionFxObject(mesh, id, pid));
      }
    }
  }

  /** Deep copy a card for a one-shot effect, without sharing disposables. */
  private cloneActionFxObject(source: THREE.Object3D, cardId: string, seatId: string): THREE.Object3D {
    source.updateWorldMatrix(true, false);
    const clone = source.clone(true);
    clone.matrixAutoUpdate = true;
    source.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
    clone.userData.actionFx = true;
    clone.userData.actionFxKind = 'fold';
    clone.userData.actionFxCardId = cardId;
    clone.userData.actionFxSeatId = seatId;
    const materialCopies = new Map<THREE.Material, THREE.Material>();
    clone.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry = mesh.geometry.clone();
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const copyMaterial = (sourceMaterial: THREE.Material): THREE.Material => {
        const existing = materialCopies.get(sourceMaterial);
        if (existing) return existing;
        const material = sourceMaterial.clone();
        material.transparent = true;
        material.depthWrite = false;
        material.userData = { ...material.userData, actionFxBaseOpacity: sourceMaterial.opacity, keepTexture: true };
        materialCopies.set(sourceMaterial, material);
        return material;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(copyMaterial)
        : copyMaterial(mesh.material);
    });
    return clone;
  }

  private actionFxMaterials(object: THREE.Object3D): THREE.Material[] {
    const materials = new Set<THREE.Material>();
    object.traverse(child => {
      const material = (child as THREE.Mesh).material;
      if (!material) return;
      const entries = Array.isArray(material) ? material : [material];
      for (const entry of entries) materials.add(entry);
    });
    return [...materials];
  }

  /** Slide pending folded hands into the muck and fade them out. */
  private animatePendingPokerFolds(state: ProjectedGameState): void {
    const pending = this.pendingPokerFoldVisuals;
    this.pendingPokerFoldVisuals = [];
    if (pending.length === 0) return;
    const anchor = state.zones.zone_muck?.anchorPosition ?? [-6, 0.06, 2.2];
    const target = new THREE.Vector3(anchor[0], anchor[1] + 0.03, anchor[2]);
    pending.forEach((object, index) => {
      if (!this.takeActionAnimationSlot()) {
        this.disposeActionFxObject(object);
        return;
      }
      const cardId = String(object.userData.actionFxCardId ?? '');
      const restingMesh = cardId ? this.entityMeshes.get(cardId) : undefined;
      if (cardId) this.entityMeshes.set(cardId, object);
      const restoreRestingMesh = () => {
        if (!cardId || this.entityMeshes.get(cardId) !== object) return;
        if (restingMesh) this.entityMeshes.set(cardId, restingMesh);
        else this.entityMeshes.delete(cardId);
      };
      this.pokerFxGroup.add(object);
      object.renderOrder = 220 + index;
      const start = object.position.clone();
      const startYaw = object.rotation.y;
      const materials = this.actionFxMaterials(object);
      this.animQueue.animate(
        FOLD_ANIMATION_MS,
        (p, linear) => {
          object.position.x = THREE.MathUtils.lerp(start.x, target.x, p);
          object.position.z = THREE.MathUtils.lerp(start.z, target.z, p);
          object.position.y =
            THREE.MathUtils.lerp(start.y, target.y, p) + Math.sin(Math.PI * p) * 0.18;
          object.rotation.y = startYaw + p * 0.55;
          for (const material of materials) {
            const base = Number(material.userData.actionFxBaseOpacity ?? 1);
            material.opacity =
              base * Math.max(0, Math.min(1, 1 - Math.max(0, linear - 0.5) / 0.5));
          }
        },
        () => {
          restoreRestingMesh();
          this.pokerFxGroup.remove(object);
          this.disposeActionFxObject(object);
        },
        index * FOLD_STAGGER_MS
      );
    });
  }

  private disposePendingPokerFoldVisuals(): void {
    for (const object of this.pendingPokerFoldVisuals) this.disposeActionFxObject(object);
    this.pendingPokerFoldVisuals = [];
  }

  /** Dispose a render-only clone; shared card textures stay alive. */
  private disposeActionFxObject(object: THREE.Object3D): void {
    object.removeFromParent();
    const materials = new Set(this.actionFxMaterials(object));
    object.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const material of materials) material.dispose();
  }

  /** Z of the pot pile, matching `renderPokerDecor`. */
  private pokerPotZ(state: ProjectedGameState): number {
    const seats = Object.values(state.mapGraph.nodes).filter(node => node.type === 'SEAT');
    const rz = Math.max(2.6, ...seats.map(node => Math.abs(node.position[2]))) + 1.1;
    return rz * 0.24;
  }

  private floorAnchorsFor(
    state: ProjectedGameState,
    placement?: PlacementPreview
  ): Record<string, { x: number; z: number; width: number; depth: number }> {
    const activePlacement = placement ?? this.lastPlacement;
    const groups = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number }>();
    for (const node of Object.values(state.mapGraph.nodes)) {
      if (node.type !== 'ROOM') continue;
      const floor = String(node.props?.floor ?? '');
      if (!floor) continue;
      const range = groups.get(floor) ?? { minX: node.position[0], maxX: node.position[0], minZ: node.position[2], maxZ: node.position[2] };
      range.minX = Math.min(range.minX, node.position[0]);
      range.maxX = Math.max(range.maxX, node.position[0]);
      range.minZ = Math.min(range.minZ, node.position[2]);
      range.maxZ = Math.max(range.maxZ, node.position[2]);
      groups.set(floor, range);
    }
    if (activePlacement && activePlacement.floor && activePlacement.position) {
      const floor = activePlacement.floor;
      const range = groups.get(floor) ?? {
        minX: activePlacement.position[0],
        maxX: activePlacement.position[0],
        minZ: activePlacement.position[2],
        maxZ: activePlacement.position[2]
      };
      range.minX = Math.min(range.minX, activePlacement.position[0]);
      range.maxX = Math.max(range.maxX, activePlacement.position[0]);
      range.minZ = Math.min(range.minZ, activePlacement.position[2]);
      range.maxZ = Math.max(range.maxZ, activePlacement.position[2]);
      groups.set(floor, range);
    }
    const anchors: Record<string, { x: number; z: number; width: number; depth: number }> = {};
    for (const [floor, range] of groups) {
      anchors[floor] = {
        x: (range.minX + range.maxX) / 2,
        z: (range.minZ + range.maxZ) / 2,
        width: Math.max(12.6, range.maxX - range.minX + 2.84),
        depth: Math.max(8, range.maxZ - range.minZ + 2.84)
      };
    }
    return anchors;
  }

  /** Dark inset mat with a thin brass outline, used to frame card areas. */
  private addTableMat(width: number, depth: number, x: number, z: number, floor?: string): void {
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.02, depth),
      new THREE.MeshStandardMaterial({ color: 0x0a1712, roughness: 0.96, metalness: 0.02 })
    );
    plate.position.set(x, 0.012, z);
    plate.receiveShadow = true;
    if (floor) plate.userData.floor = floor;
    this.boardObjectsGroup.add(plate);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(plate.geometry),
      new THREE.LineBasicMaterial({ color: 0xc9a24a, transparent: true, opacity: 0.4 })
    );
    edges.position.set(x, 0.024, z);
    if (floor) edges.userData.floor = floor;
    this.boardObjectsGroup.add(edges);
  }

  private renderDuneDecor(state: ProjectedGameState): void {
    // Sand arena floor
    const sandTex = this.createSandTexture();
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(4.4, 72),
      new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.95, metalness: 0.02 })
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.03;
    inner.receiveShadow = true;
    this.boardObjectsGroup.add(inner);

    const arena = new THREE.Mesh(
      new THREE.TorusGeometry(4.42, 0.06, 10, 96),
      new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.85, roughness: 0.28 })
    );
    arena.rotation.x = -Math.PI / 2;
    arena.position.y = 0.05;
    this.boardObjectsGroup.add(arena);

    // Radial ticks around the wheel
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.012, i % 3 === 0 ? 0.42 : 0.22),
        new THREE.MeshStandardMaterial({ color: 0x8a6a2f, roughness: 0.6 })
      );
      tick.position.set(Math.cos(a) * 4.15, 0.045, Math.sin(a) * 4.15);
      tick.rotation.y = -a;
      this.boardObjectsGroup.add(tick);
    }

    // Spice tokens clustered at the centre
    for (let i = 0; i < 16; i++) {
      const a = i * 0.82;
      const r = 0.55 + (i % 4) * 0.5;
      const spice = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.17, 0),
        new THREE.MeshStandardMaterial({
          color: 0xe0922f,
          emissive: 0x6b3f0a,
          emissiveIntensity: 0.55,
          roughness: 0.32,
          metalness: 0.45
        })
      );
      spice.position.set(Math.cos(a) * r, 0.15 + (i % 3) * 0.05, Math.sin(a) * r);
      spice.rotation.set(i, i * 1.7, i * 0.6);
      spice.castShadow = true;
      this.boardObjectsGroup.add(spice);
    }

    // Two battle dials
    const dials: { id: string; x: number; color: string; label: string; troops: number }[] = [
      { id: 'p1', x: -5.9, color: '#2e7d32', label: 'ATREIDES', troops: state.players.p1?.customProps.troops ?? 8 },
      { id: 'p2', x: 5.9, color: '#c62828', label: 'HARKONNEN', troops: state.players.p2?.customProps.troops ?? 10 }
    ];

    dials.forEach(dial => {
      const committed = !!state.globalVars.committedDials?.[dial.id];

      const outer = new THREE.Mesh(
        new THREE.CylinderGeometry(1.25, 1.3, 0.08, 48),
        new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.6, metalness: 0.3 })
      );
      outer.position.set(dial.x, 0.06, 3.4);
      outer.receiveShadow = true;
      this.boardObjectsGroup.add(outer);

      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.02, 1.02, 0.1, 48),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(dial.color),
          roughness: 0.4,
          metalness: 0.3,
          emissive: new THREE.Color(dial.color),
          emissiveIntensity: committed ? 0.55 : 0.08
        })
      );
      base.position.set(dial.x, 0.11, 3.4);
      this.boardObjectsGroup.add(base);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(1.14, 0.035, 8, 48),
        new THREE.MeshStandardMaterial({
          color: committed ? 0xf6dc9c : 0x8a6a2f,
          emissive: committed ? 0xd9b45b : 0x000000,
          emissiveIntensity: committed ? 0.9 : 0,
          metalness: 0.85,
          roughness: 0.3
        })
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(dial.x, 0.17, 3.4);
      this.boardObjectsGroup.add(rim);

      // Troop pips
      for (let i = 0; i < Math.min(dial.troops, 10); i++) {
        const a = (i / 10) * Math.PI * 2;
        const pip = new THREE.Mesh(
          new THREE.SphereGeometry(0.075, 8, 8),
          new THREE.MeshStandardMaterial({ color: 0xf0e6cf, roughness: 0.5 })
        );
        pip.position.set(dial.x + Math.cos(a) * 0.86, 0.19, 3.4 + Math.sin(a) * 0.86);
        this.boardObjectsGroup.add(pip);
      }

      const glyph = this.createLabelSprite(committed ? `LOCKED · ${dial.label}` : dial.label, committed ? '#f6dc9c' : '#cfd8e6', 44);
      glyph.position.set(dial.x, 0.72, 3.4);
      glyph.scale.set(2.6, 0.72, 1);
      this.boardObjectsGroup.add(glyph);
    });

    // Mahjong mode: tile + pond
    if (state.globalVars.battleMode === 'MAHJONG') {
      const tileTex = this.createMahjongTileTexture();
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, 0.26, 1.45),
        [
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.55 }),
          new THREE.MeshStandardMaterial({ color: 0xe4dfd2, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 })
        ]
      );
      tile.position.set(0, 0.15, 0.2);
      tile.rotation.y = 0.35;
      tile.castShadow = true;
      this.boardObjectsGroup.add(tile);

      const label = this.createLabelSprite('PRIORITY CLAIM · 吃 / 碰 / 胡', '#f6dc9c', 42);
      label.position.set(0, 0.95, 5.5);
      label.scale.set(4.6, 0.7, 1);
      this.boardObjectsGroup.add(label);
    } else {
      const title = this.createLabelSprite('SIMULTANEOUS BATTLE WHEEL', '#d8c9a0', 38);
      title.position.set(0, 0.8, -5.3);
      title.scale.set(4.6, 0.66, 1);
      this.boardObjectsGroup.add(title);
    }
  }

  /** Procedural sand texture for the Arrakis battle wheel. */
  private createSandTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(256, 256, 40, 256, 256, 300);
    grad.addColorStop(0, '#c9a367');
    grad.addColorStop(0.55, '#b58a4e');
    grad.addColorStop(1, '#8d6535');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);

    // Ripples
    ctx.strokeStyle = 'rgba(90, 62, 30, 0.18)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 26; i++) {
      ctx.beginPath();
      ctx.arc(256, 256, 26 + i * 9, 0.15 * i, 0.15 * i + 2.2);
      ctx.stroke();
    }

    // Grain
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      const a = Math.random() * 0.09;
      ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,236,196,${a})` : `rgba(80,54,24,${a})`;
      ctx.fillRect(x, y, 2, 2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private createMahjongTileTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 340;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#f6f2e6';
    ctx.fillRect(0, 0, 256, 340);
    ctx.strokeStyle = '#cfc7b3';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, 236, 320);

    // 9 bamboo sticks, stylised
    ctx.fillStyle = '#1f8a4c';
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x = 46 + col * 58;
        const y = 62 + row * 72;
        ctx.fillRect(x, y, 16, 48);
        ctx.beginPath();
        ctx.arc(x + 8, y - 4, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#2f6b4f';
    ctx.font = `700 30px ${CANVAS_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText('九条', 128, 318);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * Painted board label.
   *
   * Painting is expensive — a 1024×256 canvas, text measurement, a mipmapped
   * canvas texture — and the text of a furniture label (`底池 120`, `牌堆 · 39`)
   * changes on a handful of syncs at most. So the paint is cached per
   * (text, colour, font size, supersample): an unchanged label is a clone of the
   * cached sprite instead of another canvas.
   */
  private createLabelSprite(
    text: string,
    color = '#ffffff',
    fontSize = TABLE_LABEL_FONT_SIZE,
    canvasSupersample = 1
  ): THREE.Sprite {
    const supersample = Math.max(1, Math.floor(canvasSupersample));
    const signature = `${LABEL_PAINTER_VERSION}|${text}|${color}|${fontSize}|${supersample}`;
    return this.furniture.obtain(`label:${signature}`, signature, () =>
      this.paintLabelSprite(text, color, fontSize, supersample)
    ) as THREE.Sprite;
  }

  private paintLabelSprite(
    text: string,
    color: string,
    fontSize: number,
    supersample: number
  ): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 1024 * supersample;
    canvas.height = 256 * supersample;
    const ctx = canvas.getContext('2d')!;
    // Keep all drawing coordinates in the original 1024x256 space. The extra
    // backing pixels are real supersampling, not a larger layout.
    ctx.scale(supersample, supersample);

    ctx.clearRect(0, 0, 1024, 256);
    ctx.fillStyle = 'rgba(10,13,19,0.72)';
    ctx.beginPath();
    ctx.roundRect(12, 36, 1000, 184, 40);
    ctx.fill();

    ctx.strokeStyle = 'rgba(217,180,91,0.45)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // 字号占满贴图高度的六成左右（原来只有三成半）：贴图在屏幕上通常只有
    // 一百多像素宽，字越大、落到屏幕上的纹素越多，越清楚。长文本仍由下面的
    // 宽度循环自动缩小。
    const scale = 3.2;
    // 上限 150px：贴图高 256、胶囊内高 184，再大就顶出胶囊了。
    const scaledFontSize = Math.min(fontSize * scale, 150);
    ctx.font = `600 ${scaledFontSize}px ${CANVAS_FONT_STACK}`;
    let fitted = scaledFontSize;
    while (ctx.measureText(text).width > 920 && fitted > 28) {
      fitted -= 4;
      ctx.font = `600 ${fitted}px ${CANVAS_FONT_STACK}`;
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 512, 128);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // 1024px 的标签在屏幕上往往只有一百多像素宽：没有 mipmap 时 GPU 只取 4 个
    // 纹素，文字边缘会碎成噪点（远景尤其明显）。开 mipmap + 各向异性，缩小时
    // 才会平滑地滤到目标尺寸。
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.userData.ownedTexture = true;
    sprite.userData.labelText = text;
    sprite.userData.labelFontSize = fontSize;
    sprite.userData.labelSupersample = supersample;
    return sprite;
  }

  private applyCardVisualOffset(entityId: string, mesh: THREE.Object3D): void {
    const offset = this.cardVisualOffsets.get(entityId);
    if (!offset) return;
    mesh.position.x += offset.dx;
    mesh.position.z += offset.dz;
  }

  private renderCardEntity(
    entity: Partial<Entity> & { isMasked?: boolean; id: string },
    zone: ProjectedGameState['zones'][string],
    index: number,
    totalInZone: number,
    interactive = true,
    parent: THREE.Group = this.boardObjectsGroup
  ): void {
    const face = entity.components?.cardFace || { title: 'Card' };
    const isMasked = !!entity.isMasked;
    const custom = entity.components?.custom as Record<string, unknown> | undefined;
    const isPkmn = this.lastState?.gameId === 'splendor';
    // Poker draws real playing cards (ivory stock, pips, court figures) instead
    // of the house occult plate.
    const cardStyle = this.lastState?.gameId === 'poker' ? 'playing' : 'plate';
    // Cards in the floating board row are posed at `rotation.x = −70°`. The
    // house card mesh paints its face on +Y, so a −70° X rotation alone would
    // show the back; a compensating +140° turn baked into the row cards'
    // geometry makes −70° the readable, camera-facing pose.
    const grouped = parent === this.dealerAreaGroup;
    // The tilt is baked into the geometry, so it has to happen inside the build:
    // a cached card shares its geometry with the template and must not be
    // rotated again on every reuse.
    const mesh = this.furniture.obtain(
      `card:${entity.id}:${grouped ? 'row' : 'board'}`,
      signatureOf(face, isPkmn, isMasked, cardStyle, grouped, custom ?? null),
      () => {
        const built = CardMeshBuilder.createCardMesh(
          face,
          isPkmn ? PKMN_CARD_W : CARD_W,
          isPkmn ? PKMN_CARD_H : CARD_H,
          isMasked,
          isPkmn ? pokemonCardTexture(custom) : null,
          isPkmn ? pokemonCardBackTexture(custom) : null,
          cardStyle
        );
        if (grouped) built.geometry.rotateX(BOARD_ROW_GEOMETRY_TILT);
        return built;
      }
    );

    if (isPkmn && (zone.id === 'zone_market_t1' || zone.id === 'zone_market_t2' || zone.id === 'zone_market_t3')) {
      // One row per tier, laid out from the card size: `PKMN_MARKET_PITCH_X`
      // leaves a readable gutter, and the row pitch leaves room for the caption
      // strip under each card.
      const row = zone.id === 'zone_market_t1' ? 0 : zone.id === 'zone_market_t2' ? 1 : 2;
      const firstX = PKMN_MARKET_X - ((PKMN_MARKET_COLUMNS - 1) * PKMN_MARKET_PITCH_X) / 2;
      mesh.position.set(firstX + index * PKMN_MARKET_PITCH_X, 0.1, PKMN_MARKET_Z1 - row * PKMN_MARKET_PITCH_Z);
      mesh.rotation.y = 0;
    } else if (zone.id === 'zone_market_t1') {
      mesh.position.set(-3.9 + index * 1.52, 0.1, 2.5);
      mesh.rotation.y = 0;
    } else if (zone.id === 'zone_market_t2') {
      mesh.position.set(-3.9 + index * 1.52, 0.1, 0.1);
      mesh.rotation.y = 0;
    } else if (zone.id === 'zone_market_t3') {
      mesh.position.set(-3.9 + index * 1.52, 0.1, -2.3);
      mesh.rotation.y = 0;
    } else if (zone.id.startsWith('zone_tableau_')) {
      mesh.position.set(-9.4 + (index % 5) * 0.72, 0.1 + index * 0.012, 3.2 + Math.floor(index / 5) * 0.78);
      mesh.scale.set(0.55, 0.55, 0.55);
      mesh.rotation.y = 0;
    } else if (zone.type === 'BOARD') {
      const roomId = zone.id.startsWith('zone_room_') ? zone.id.slice('zone_room_'.length) : '';
      const roomNode = roomId ? this.lastState?.mapGraph.nodes[roomId] : undefined;
      if (roomNode?.props?.floor) mesh.userData.floor = String(roomNode.props.floor);
      const anchor = roomNode
        ? [roomNode.position[0], roomNode.position[1] + 0.16, roomNode.position[2]]
        : zone.anchorPosition ?? [0, 0.16, 0];
      if (zone.id.startsWith('zone_room_')) {
        // The module-owned slot is the single source of truth for the item
        // anchor, layout, scale and layer height. The renderer only converts
        // that contract into world coordinates.
        const slot = Object.values(this.lastState?.mapGraph.slots ?? {}).find(
          candidate =>
            candidate.nodeId === roomId &&
            (!candidate.accepts?.entityTypes || candidate.accepts.entityTypes.includes('CARD'))
        );
        const local = slot?.local?.position ?? [0.38, 0.16, 0.48];
        const base = roomNode
          ? [roomNode.position[0] + local[0], roomNode.position[1] + local[1], roomNode.position[2] + local[2]]
          : [anchor[0] + local[0], anchor[1] + local[1], anchor[2] + local[2]];
        const layout = slot?.layout ?? (totalInZone > 1 ? 'FAN' : 'STACK');
        const scale = slot?.visual?.scale ?? 0.3;
        const gap = slot?.visual?.gap ?? 0.58;
        const layerHeight = slot?.visual?.height ?? 0.01;
        const spread = (index - (totalInZone - 1) / 2) * gap;
        mesh.scale.set(scale, scale, scale);
        if (layout === 'FAN') {
          mesh.position.set(base[0] + spread, base[1], base[2]);
          mesh.rotation.y = spread * 0.35;
        } else if (layout === 'STACK') {
          mesh.position.set(base[0], base[1] + index * layerHeight, base[2]);
          mesh.rotation.y = 0.18;
        } else {
          mesh.position.set(base[0] + spread, base[1], base[2]);
          mesh.rotation.y = 0;
        }
      } else {
        // Plain board area (poker community cards, demo displays): centre the
        // whole row and allow five cards instead of clamping at four, which
        // used to push the fifth card off to one side. The cards render at hole
        // -card size — half-scale faces turn the pips into unreadable specks.
        //
        // Orientation: the shared dealer row turns as one group around the
        // table centre (see `updateDealerArea`) and its cards stand upright, so
        // they keep a local yaw of 0. A plain board row in another game still
        // uses the legacy `boardFacesViewer` capability / fixed-north path.
        const shown = Math.min(totalInZone, 5);
        mesh.scale.setScalar(BOARD_ROW_CARD_SCALE);
        const displayState = this.lastState;
        const bearing = grouped ? null : displayState ? this.boardViewerBearing(displayState) : null;
        const row = boardRowFrame({
          count: shown,
          centerX: anchor[0],
          // Keeps the historical centre: the poker anchor sits at z = -0.85 and
          // the row is pushed forward by the same amount to land on the felt.
          centerZ: anchor[2] + BOARD_ROW_Z_OFFSET,
          viewer: bearing,
          pitch: BOARD_ROW_PITCH * CARD_SIZE_MULTIPLIER
        });
        const [px, , pz] = boardCardPosition(row, shown, index, anchor[1]);
        // The floating row hangs above the felt: its pivot sits at the hover
        // plane, and each card is raised by half its tilted height so the
        // bottom edge — not the centre — is what floats.
        const restY = grouped ? BOARD_ROW_CARD_LIFT : anchor[1];
        mesh.position.set(px, restY, pz);
        mesh.rotation.y = row.yaw;
        // Stand the revealed cards up: −70° about their own X. The compensating
        // geometry turn above keeps the visible pose an easel — face up and
        // toward the group's +Z (the camera side), printed top toward +Y.
        mesh.rotation.x = grouped ? BOARD_ROW_TILT : 0;
        // Yaw first, then the reveal flip about the card's *own* long axis.
        // With the default 'XYZ' order the flip would happen about the world X
        // axis instead, so a board card on the left or right of the row would
        // tumble sideways while it turns over.
        mesh.rotation.order = 'YXZ';
        // Recorded so the deal/reveal tweens can restore the row's bearing and
        // its resting tilt instead of snapping the card flat mid-animation.
        mesh.userData.restYaw = row.yaw;
        mesh.userData.restTilt = mesh.rotation.x;
        // Face-down at the deck: the baked row cards lie flat on their back at
        // +40° (the geometry's 140° turn makes the face point at −Y there); a
        // legacy plain board row keeps the historical half-turn flip.
        mesh.userData.flipStartTilt = grouped ? Math.PI - BOARD_ROW_GEOMETRY_TILT : -Math.PI;
        if (grouped) {
          // Stable stacking inside the floating group: higher index draws over
          // its left neighbour, exactly like the fixed felt row did.
          mesh.renderOrder = 10 + index;
          this.dealerAreaCardIds.add(entity.id);
          this.dealerAreaFloatItems.push({ object: mesh, baseY: restY });
        }
      }
    } else if (zone.type === 'HAND' && zone.anchorPosition) {
      const anchor = zone.anchorPosition;
      const shown = Math.min(totalInZone, 7);
      mesh.scale.set(0.62, 0.62, 0.62);
      mesh.position.set(anchor[0] + (index - (shown - 1) / 2) * 0.9, anchor[1], anchor[2]);
      mesh.rotation.y = 0;
    } else {
      mesh.position.set((index - totalInZone / 2) * 1.5, 0.1, 0);
      mesh.rotation.y = 0;
    }

    this.applyCardVisualOffset(entity.id, mesh);
    parent.add(mesh);
    this.entityMeshes.set(entity.id, mesh);
    if (interactive) {
      this.raycaster.registerInteractive(mesh, {
        type: 'ENTITY',
        id: entity.id,
        metadata: face
      });
    }
  }

  private onResize(): void {
    if (!this.container || this.isDestroyed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.layoutCameraHandRows();
  }

  /**
   * Turn each seat board toward the camera (yaw only), keeping its own random
   * offset.
   *
   * Dead-on aiming looked wrong: every board snapped into the same plane, which
   * hides the table's structure. Each seat therefore carries a hashed ±30° offset
   */
  /**
   * 「视角定位标」：地面白点 + 30% 透明竖线 + 状态环 + 环上箭头。
   *
   * 位置是某个座位的默认机位正下方（见 `setSeatView`），竖线高度就是那台相机
   * 的高度——不管从哪个座位看，线顶都落在自己的视平线上。
   */
  /**
   * 把点位约束在「绿圈（内层牌桌椭圆）与红圈（外层大方桌木沿）」之间的环带活动范围内。
   *
   * @param x 目标 X 坐标（如相机在地面上的投影）
   * @param z 目标 Z 坐标
   * @param fallbackOutward 当点位在桌心附近无法确定方向时的推开方向
   */
  private clampBeaconPosition(
    x: number,
    z: number,
    fallbackOutward?: { x: number; y: number }
  ): { x: number; z: number } {
    // 1. 外层边界（红圈）：外层大方桌木沿矩形（rx ≈ 15.9, rz ≈ 11.4）
    const outerRx = this.tableBounds.rx;
    const outerRz = this.tableBounds.rz;
    let px = Math.max(-outerRx, Math.min(outerRx, x));
    let pz = Math.max(-outerRz, Math.min(outerRz, z));

    // 2. 内层边界（绿圈）：内层牌桌椭圆外沿（innerRx, innerRz）
    const { rx: innerRx, rz: innerRz } = this.tableInnerOval;
    const d = Math.hypot(px, pz);
    if (d < 1e-4) {
      const fx = fallbackOutward?.x ?? 0;
      const fz = fallbackOutward?.y ?? 1;
      return { x: fx * innerRx, z: fz * innerRz };
    }

    const ellipseDist = Math.sqrt((px / innerRx) ** 2 + (pz / innerRz) ** 2);
    if (ellipseDist < 1.0) {
      // 位于绿圈内：沿中心到该点的径向推到绿圈外沿
      const factor = 1.0 / Math.max(1e-4, ellipseDist);
      px *= factor;
      pz *= factor;
    }

    return { x: px, z: pz };
  }

  /**
   * 立柱顶端的圆形玩家头像牌：始终朝向视角方向（Sprite），用于快速识别座位玩家。
   */
  private createBeaconAvatarSprite(player?: {
    name?: string;
    avatar?: string;
    avatarUrl?: string;
    color?: string;
  }): THREE.Sprite {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    const drawFallback = () => {
      ctx.clearRect(0, 0, size, size);
      // 底色圆盘
      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 114, 0, Math.PI * 2);
      ctx.fillStyle = player?.color || '#334155';
      ctx.fill();
      ctx.clip();

      // 兜底头像：emoji / 首字
      const glyph = String(player?.avatar || player?.name?.slice(0, 1) || '👤');
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${glyph.length > 1 ? 104 : 118}px ${CANVAS_FONT_STACK}`;
      ctx.fillText(glyph, size / 2, size / 2 + 6);
      ctx.restore();

      // 黄铜圆环金边
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 114, 0, Math.PI * 2);
      ctx.strokeStyle = '#c9a24a';
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.lineWidth = 3;
      ctx.stroke();
    };

    drawFallback();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;

    if (player?.avatarUrl && typeof Image !== 'undefined') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        ctx.clearRect(0, 0, size, size);
        ctx.save();
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, 114, 0, Math.PI * 2);
        ctx.clip();
        const sw = img.naturalWidth || img.width;
        const sh = img.naturalHeight || img.height;
        const scale = Math.max((size - 24) / sw, (size - 24) / sh);
        const w = sw * scale;
        const h = sh * scale;
        ctx.drawImage(img, size / 2 - w / 2, size / 2 - h / 2, w, h);
        ctx.restore();

        // 重绘黄铜金边
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, 114, 0, Math.PI * 2);
        ctx.strokeStyle = '#c9a24a';
        ctx.lineWidth = 12;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.lineWidth = 3;
        ctx.stroke();

        texture.needsUpdate = true;
      };
      img.src = player.avatarUrl;
    }

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.25, 1.25, 1);
    sprite.userData.ownedTexture = true;
    return sprite;
  }

  /** Paint the current-street bet onto an existing beacon coin canvas. */
  private drawBeaconBetFace(canvas: HTMLCanvasElement, amount: number, color?: string): void {
    const size = canvas.width;
    const centre = size / 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);

    const disc = ctx.createRadialGradient(centre, centre - 18, 12, centre, centre, 114);
    disc.addColorStop(0, '#25313b');
    disc.addColorStop(1, '#0b1117');
    ctx.beginPath();
    ctx.arc(centre, centre, 114, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();

    // Keep the seat accent visible, so the coin still says whose bet it is.
    ctx.beginPath();
    ctx.arc(centre, centre, 104, 0, Math.PI * 2);
    ctx.strokeStyle = color || '#334155';
    ctx.lineWidth = 8;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#d8bd78';
    ctx.font = `600 29px ${CANVAS_FONT_STACK}`;
    ctx.fillText('本轮已下注', centre, 88);

    const text = String(Math.max(0, Math.floor(amount)));
    let fontSize = 112;
    ctx.font = `700 ${fontSize}px ${CANVAS_FONT_STACK}`;
    while (ctx.measureText(text).width > 178 && fontSize > 54) {
      fontSize -= 4;
      ctx.font = `700 ${fontSize}px ${CANVAS_FONT_STACK}`;
    }
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(text, centre, 154);

    // Match the avatar coin's brass rim exactly.
    ctx.beginPath();
    ctx.arc(centre, centre, 114, 0, Math.PI * 2);
    ctx.strokeStyle = '#c9a24a';
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  private createBeaconBetSprite(amount: number, color?: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    this.drawBeaconBetFace(canvas, amount, color);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.25, 1.25, 1);
    sprite.visible = false;
    sprite.userData.ownedTexture = true;
    sprite.userData.betAmount = Math.max(0, Math.floor(amount));
    sprite.userData.betColor = color ?? '';
    return sprite;
  }

  private updateBeaconBetSprite(sprite: THREE.Sprite, amount: number): void {
    const next = Math.max(0, Math.floor(amount));
    if (sprite.userData.betAmount === next) return;
    const material = sprite.material as THREE.SpriteMaterial;
    const canvas = material.map?.image as HTMLCanvasElement | undefined;
    if (canvas) this.drawBeaconBetFace(canvas, next, String(sprite.userData.betColor ?? ''));
    if (material.map) material.map.needsUpdate = true;
    sprite.userData.betAmount = next;
  }

  private createSeatBeacon(
    x: number,
    z: number,
    height: number,
    player?: { name?: string; avatar?: string; avatarUrl?: string; color?: string },
    streetBet = 0
  ): {
    group: THREE.Group;
    ring: THREE.Mesh;
    spinner: THREE.Group;
    arrow: THREE.Mesh;
    line: THREE.Mesh;
    avatarSprite: THREE.Sprite;
    betSprite: THREE.Sprite;
  } {
    const group = new THREE.Group();
    // 大方桌木沿上表面在 y = 0.19
    group.position.set(x, 0.19, z);

    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.18, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.01;
    group.add(dot);

    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, height, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    line.position.y = height / 2;
    group.add(line);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 72),
      new THREE.MeshBasicMaterial({
        color: 0x64748b,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);

    const spinner = new THREE.Group();
    spinner.position.y = 0.03;
    spinner.visible = false;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.52);
    shape.lineTo(-0.32, -0.2);
    shape.lineTo(0.32, -0.2);
    shape.closePath();
    const arrow = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({
        color: 0xff9a9a,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.x = 0.93;
    spinner.add(arrow);
    group.add(spinner);

    const avatarSprite = this.createBeaconAvatarSprite(player);
    avatarSprite.position.set(0, height - 0.65, 0);
    group.add(avatarSprite);

    const betSprite = this.createBeaconBetSprite(streetBet, player?.color);
    betSprite.position.copy(avatarSprite.position);
    group.add(betSprite);

    return { group, ring, spinner, arrow, line, avatarSprite, betSprite };
  }

  private updateSeatStandees(dt: number): void {
    const cam = this.camera.position;
    const now = performance.now();
    const pulse = 0.55 + Math.sin(now / 320) * 0.25;
    /** Avatar for 2 s, then this street's committed amount for 2 s. */
    const showBetFace = Math.floor(now / BEACON_FACE_MS) % 2 === 1;
    // 半圆环灯每帧按**当前**牌局刷新：节点是增量复用的，建牌那一刻的状态不可靠。
    const live = this.lastState;
    const actor = live ? (live.activeActorId ?? live.activePlayerId) : undefined;
    const hand = live?.globalVars.hand as
      | {
          street?: string;
          readyForNext?: string[];
          lastActions?: Record<string, string>;
          folded?: string[];
          streetBets?: Record<string, number>;
        }
      | undefined;
    const isSettlement = hand?.street === 'COMPLETE';
    for (const { group, jitter, lamp, seatId } of this.seatStandees) {
      const dx = cam.x - group.position.x;
      const dz = cam.z - group.position.z;
      if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) continue;
      group.rotation.y = Math.atan2(dx, dz) + jitter;
      if (!lamp) continue;
      const material = lamp.material as THREE.MeshBasicMaterial;

      const folded = !!hand?.folded?.includes(seatId);
      // 打牌中轮到该玩家亮红灯（呼吸）；结算态大家都在准备，不亮个人红灯
      const turn = !isSettlement && !!live && seatId === actor;
      // 结算态：准备好了（已点准备或 AI）亮绿灯
      const ready = isSettlement && !!live && seatReadyForPlay(live, hand, seatId);
      // 打牌中：本轮操作过（有过牌、跟注、加注、全押记录，且没弃牌，排除盲注）亮绿灯
      const lastAction = hand?.lastActions?.[seatId];
      const acted =
        !isSettlement &&
        !!lastAction &&
        !folded &&
        !lastAction.includes('盲');
      const green = ready || acted;

      if (folded) {
        // 弃牌的人底座灯变黑
        material.color.setHex(0x050505);
        material.opacity = 0.85;
      } else if (turn) {
        // 轮到该玩家：红灯呼吸
        material.color.setHex(0xff3b2a);
        material.opacity = pulse;
      } else if (green) {
        // 准备好 / 这一轮操作过：翠绿高亮（高饱和度，绝不发白）
        material.color.setHex(0x22c55e);
        material.opacity = 0.95;
      } else {
        // 未准备 / 这一轮尚未操作：熄灭（磨砂灰白）
        material.color.setHex(0x94a3b8);
        material.opacity = 0.22;
      }
    }

    // 视角定位标：环色跟底座灯同源（轮到 = 淡红、已动作/已准备 = 绿、弃牌 = 灰），
    // 只有轮到该玩家时箭头出现并旋转。
    const viewerId = live?.viewerId;
    for (const beacon of this.seatBeacons) {
      const { seatId, seatCamPos, defaultOutward } = beacon;

      // 自己的标柱跟随视角移动：活动范围严格限制在「红圈（大方桌）与绿圈（椭圆牌桌）」之间
      if (seatId === viewerId) {
        const pos = this.clampBeaconPosition(cam.x, cam.z, defaultOutward);
        beacon.group.position.x = pos.x;
        beacon.group.position.z = pos.z;
        beacon.group.position.y = 0.19;
      }

      // 自己的线与头像正对相机时不画（避免遮挡视线）；
      // 其他玩家立柱顶端显示头像圆形贴片（Sprite，始终朝向视角方向）。
      // 相机贴到某支立柱跟前时（例如上帝视角直接切到某个座位机位，viewer
      // 仍是 GOD），头像贴片会撑满整屏，所以近距一律不画。
      const isOther = seatId !== viewerId;
      const nearCamera =
        Math.hypot(cam.x - beacon.group.position.x, cam.z - beacon.group.position.z) < 3;
      const streetBet = Number(hand?.streetBets?.[seatId] ?? 0);
      this.updateBeaconBetSprite(beacon.betSprite, streetBet);
      const showBet = isOther && !nearCamera && showBetFace && streetBet > 0;
      beacon.line.visible = isOther && !nearCamera;
      beacon.avatarSprite.visible = isOther && !nearCamera && !showBet;
      beacon.betSprite.visible = showBet;

      const ringMat = beacon.ring.material as THREE.MeshBasicMaterial;
      const arrowMat = beacon.arrow.material as THREE.MeshBasicMaterial;
      const folded = !!hand?.folded?.includes(seatId);
      const turn = !isSettlement && !!live && seatId === actor;
      const lastAction = hand?.lastActions?.[seatId];
      const acted = !isSettlement && !!lastAction && !folded && !lastAction.includes('盲');
      const ready = isSettlement && !!live && seatReadyForPlay(live, hand, seatId);
      const hex = folded ? 0x6b7280 : turn ? 0xff9a9a : ready || acted ? 0x5fd08a : 0x64748b;
      ringMat.color.setHex(hex);
      arrowMat.color.setHex(0xff9a9a);
      ringMat.opacity = turn ? 0.9 : 0.55;
      beacon.spinner.visible = turn;
      if (turn) beacon.spinner.rotation.y += dt * 2.2;

      // 视角越远圈越小（0.86~0.33），并且同步缩放箭头；
      // 根据每个玩家的视角计算各自的圈：
      // - 自己的圈根据当前相机的真实距离缩放；
      // - 其他玩家的圈根据该玩家默认视角的视距缩放。
      const viewPos = seatId === viewerId ? cam : seatCamPos;
      const dist = Math.hypot(
        viewPos.x - beacon.group.position.x,
        viewPos.y - beacon.group.position.y,
        viewPos.z - beacon.group.position.z
      );
      const far = Math.min(1, Math.max(0, (dist - 4) / 22));
      const ringRadius = 0.86 + (0.33 - 0.86) * far;
      beacon.ring.scale.setScalar(ringRadius);
      const arrowScale = ringRadius / 0.86;
      beacon.arrow.scale.setScalar(arrowScale);
      beacon.arrow.position.x = ringRadius * 0.93;
    }
  }
  private renderLoop(): void {
    if (this.isDestroyed) return;
    requestAnimationFrame(this.renderLoop.bind(this));

    this.controls.update();
    this.animQueue.update();
    const now = performance.now();
    this.updateCameraTween(now);
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.physics.step(dt);
    this.updateFocusLight();
    this.updateHandFocus(dt);
    this.updateOwnHandCut(now);
    this.updateCameraAttachedHand(dt);
    this.updateDealerArea(dt, now);
    this.updateCardSettles(now);
    this.updateRoomSettles(now);
    this.updateNavArrows(now);
    this.updateSeatStandees(dt);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(
      this.camera,
      { width: this.container.clientWidth, height: this.container.clientHeight },
      this.labelObstacles()
    );
  }

  public destroy(): void {
    this.isDestroyed = true;
    window.removeEventListener('resize', this.onResize.bind(this));
    this.renderer.domElement.removeEventListener('pointermove', this.onHandPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onHandPointerLeave);
    this.handRows.clear();
    this.clearBoardObjects();
    this.furniture.clear();
    this.labels.destroy();
    this.physics.dispose();
    this.renderer.dispose();
  }
}
