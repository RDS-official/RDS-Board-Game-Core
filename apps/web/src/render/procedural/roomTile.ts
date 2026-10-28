import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAT } from './materials';
import { PROPS, PropSpec } from './props';
import { DoorDir, hashString, layoutRoom, PlacedProp } from './roomLayout';
import { CANVAS_FONT_STACK } from '../fonts';

export interface RoomTileOptions {
  roomId?: string;
  floor?: 'GROUND' | 'UPPER' | 'BASEMENT' | string;
  special?: string | null;
  tags?: string[];
  symbol?: string | null;
  /** Wall the sealed front door is drawn on (FRONT_DOOR rooms only). */
  frontDoor?: string | null;
  isPreview?: boolean;
}

const TILE = 2.84;
const HALF = TILE / 2;
const THICK = 0.1;
const INNER = HALF - THICK; // 1.32
const DOOR_HALF = 0.46;
const BACK_H = 0.42;
const FRONT_H = 0.17;

/* -------------------------------------------------------------------------- */
/* Per-room set dressing                                                      */
/* -------------------------------------------------------------------------- */

type Wish = string | { id: string; count: number };

const ROOM_PROPS: Record<string, Wish[]> = {
  entrance_hall: ['armorStand', 'mirrorStand', 'planter', 'candelabra'],
  foyer: ['sofa', 'sideTable', 'planter', 'chandelier'],
  grand_staircase: ['grandStaircase', 'candelabra'],
  kitchen: ['kitchenCounter', 'hangingPots', 'pantryShelf', 'debrisPile'],
  dining_room: ['diningTable', { id: 'diningChair', count: 3 }, 'fireplace', 'chandelier', { id: 'candelabra', count: 1 }],
  drawing_room: ['sofa', 'armchair', 'sideTable', 'fireplace', 'globeStand'],
  library: [{ id: 'bookshelf', count: 2 }, 'writingDesk', 'armchair', 'grandfatherClock'],
  study: ['writingDesk', 'bookshelf', 'grandfatherClock', 'globeStand'],
  conservatory: ['gardenBench', { id: 'planter', count: 2 }, 'statue', 'debrisPile'],
  chapel: ['altar', { id: 'candelabra', count: 2 }, 'statue', 'armorStand'],
  garden: ['gardenBench', { id: 'planter', count: 3 }, 'statue', 'debrisPile'],
  graveyard: ['coffin', 'skullStack', 'statue', 'debrisPile', 'planter'],
  gymnasium: ['gardenBench', 'crateStack', 'debrisPile', 'planter'],
  ballroom: ['piano', 'sofa', 'sideTable', 'chandelier', 'statue', 'armchair'],
  upper_landing: ['grandfatherClock', 'armorStand', 'candelabra'],
  master_bedroom: ['fourPosterBed', 'wardrobe', { id: 'nightstand', count: 2 }, 'chestOfDrawers'],
  nursery: ['cradle', 'rockingHorse', 'toyChest', 'nightstand', 'chestOfDrawers'],
  attic: [{ id: 'crateStack', count: 2 }, 'debrisPile', 'grandfatherClock'],
  balcony: ['gardenBench', 'planter', 'statue'],
  tower: ['telescope', 'bookshelf', 'candelabra', 'statue'],
  bedroom: ['singleBed', 'wardrobe', 'chestOfDrawers', 'nightstand', 'writingDesk'],
  bloody_room: ['singleBed', 'wardrobe', 'bonePile', 'debrisPile'],
  gallery: ['sofa', 'armchair', 'statue', 'candelabra', 'planter'],
  collapsed_room: [{ id: 'debrisPile', count: 2 }, 'crateStack'],
  observatory: ['telescope', 'bookshelf', 'writingDesk', 'globeStand'],
  junk_room: [{ id: 'crateStack', count: 2 }, 'barrelStack', 'debrisPile', 'bookshelf'],
  basement_landing: ['boiler', 'crateStack', 'debrisPile'],
  catacombs: [{ id: 'coffin', count: 2 }, 'bonePile', 'skullStack', 'stalagmites'],
  crypt: ['sarcophagus', 'candelabra', 'bonePile'],
  pentagram_chamber: ['ritualCircle', 'altar', { id: 'candelabra', count: 2 }, 'skullStack'],
  furnace_room: ['furnace', 'coalPile', 'crateStack', 'debrisPile'],
  coal_chute: [{ id: 'coalPile', count: 2 }, 'crateStack', 'debrisPile'],
  vault: ['vaultDoor', 'crateStack', 'candelabra', 'armorStand'],
  wine_cellar: [{ id: 'wineRack', count: 2 }, 'barrelStack', 'candelabra', 'debrisPile'],
  workshop: ['workbench', 'crateStack', 'barrelStack', 'debrisPile'],
  laboratory: ['labBench', 'specimenShelf', 'workbench', 'globeStand'],
  operating_lab: ['operatingTable', 'specimenShelf', 'labBench', 'specimenJarsSmall'],
  larder: [{ id: 'pantryShelf', count: 2 }, 'barrelStack', 'debrisPile'],
  underground_lake: ['waterPool', { id: 'stalagmites', count: 2 }, 'coffin', 'debrisPile'],
  mystic_elevator: ['armorStand', 'candelabra', 'debrisPile', 'statue']
};

/** Rooms whose solid walls get a window with moonlight behind them. */
const WINDOWED = new Set([
  'conservatory',
  'garden',
  'balcony',
  'tower',
  'observatory',
  'gallery',
  'study',
  'library',
  'master_bedroom',
  'bedroom',
  'entrance_hall',
  'foyer'
]);

/** Palette of floor treatments, keyed by room. */
type FloorStyle = 'PLANK' | 'PARQUET' | 'FLAGSTONE' | 'DIRT' | 'MARBLE' | 'CARPET';

function floorStyleFor(roomId: string, floor: string): FloorStyle {
  if (floor === 'BASEMENT') {
    if (roomId === 'catacombs' || roomId === 'graveyard') return 'DIRT';
    if (roomId === 'underground_lake') return 'DIRT';
    return 'FLAGSTONE';
  }
  if (roomId === 'ballroom' || roomId === 'foyer' || roomId === 'chapel') return 'MARBLE';
  if (roomId === 'dining_room' || roomId === 'drawing_room' || roomId === 'library') return 'PARQUET';
  if (roomId === 'conservatory' || roomId === 'garden') return 'DIRT';
  if (floor === 'UPPER') return 'PLANK';
  return 'PLANK';
}

/** Base timber tone per floor: warm walnut downstairs, cold old oak above. */
function woodTone(floor: string): string {
  if (floor === 'BASEMENT') return '#41301f';
  if (floor === 'UPPER') return '#4a3122';
  return '#5a3a24';
}

/* -------------------------------------------------------------------------- */
/* Floor texture painter                                                      */
/* -------------------------------------------------------------------------- */

export class RoomTileBuilder {
  private static roomTextureCache = new Map<string, THREE.CanvasTexture>();

  public static createRoomTexture(
    name: string,
    color: string = '#3e2723',
    doors: DoorDir[] = [],
    floor: string = 'GROUND',
    roomId = ''
  ): THREE.CanvasTexture {
    const style = floorStyleFor(roomId, floor);
    // Tiles keep a warm timber palette; the floor meta colour tints the trim.
    const base = style === 'PLANK' || style === 'PARQUET' ? woodTone(floor) : color;
    const key = `${roomId}|${name}|${color}|${[...doors].sort().join('')}|${floor}|${style}`;
    const cached = this.roomTextureCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    const px = 512 / TILE; // world units -> pixels

    /* ------------------------------- ground ------------------------------- */
    if (style === 'FLAGSTONE') {
      ctx.fillStyle = '#12161a';
      ctx.fillRect(0, 0, 512, 512);
      for (let x = 0; x < 512; x += 74) {
        for (let y = 0; y < 512; y += 74) {
          const v = ((x * 13 + y * 29) % 17) - 8;
          ctx.fillStyle = `rgb(${38 + v}, ${43 + v}, ${50 + v})`;
          ctx.fillRect(x + 3, y + 3, 68, 68);
          ctx.strokeStyle = 'rgba(6,8,10,0.9)';
          ctx.lineWidth = 5;
          ctx.strokeRect(x, y, 74, 74);
          // Chipped corners
          ctx.fillStyle = 'rgba(10,13,16,0.55)';
          ctx.beginPath();
          ctx.arc(x + 6, y + 6, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (style === 'DIRT') {
      ctx.fillStyle = '#2a2118';
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 900; i += 1) {
        const x = ((i * 71) % 512) + ((i * 13) % 5);
        const y = (i * 137) % 512;
        ctx.fillStyle = i % 3 === 0 ? 'rgba(12,9,6,0.5)' : 'rgba(84,66,44,0.16)';
        ctx.fillRect(x, y, 3 + (i % 4), 2 + (i % 3));
      }
      // Sparse flagstone remains
      for (let i = 0; i < 6; i += 1) {
        const x = (i * 89) % 460;
        const y = (i * 151) % 460;
        ctx.fillStyle = 'rgba(60,64,68,0.45)';
        ctx.fillRect(x, y, 52, 46);
        ctx.strokeStyle = 'rgba(10,10,10,0.7)';
        ctx.strokeRect(x, y, 52, 46);
      }
    } else if (style === 'MARBLE') {
      const base = '#4a4640';
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 512, 512);
      const tile = 128;
      for (let x = 0; x < 512; x += tile) {
        for (let y = 0; y < 512; y += tile) {
          const even = ((x / tile) | 0) % 2 === ((y / tile) | 0) % 2;
          ctx.fillStyle = even ? '#5b564d' : '#3a3631';
          ctx.fillRect(x + 2, y + 2, tile - 4, tile - 4);
          // Veining
          ctx.strokeStyle = 'rgba(180,175,160,0.10)';
          ctx.lineWidth = 1.6;
          for (let v = 0; v < 3; v += 1) {
            ctx.beginPath();
            ctx.moveTo(x + 10, y + 20 + v * 40);
            ctx.bezierCurveTo(x + 40, y + 10 + v * 40, x + 80, y + 50 + v * 40, x + tile - 10, y + 30 + v * 40);
            ctx.stroke();
          }
        }
      }
      ctx.strokeStyle = 'rgba(200,180,120,0.16)';
      ctx.lineWidth = 3;
      for (let x = 0; x <= 512; x += tile) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 512);
        ctx.moveTo(0, x);
        ctx.lineTo(512, x);
        ctx.stroke();
      }
    } else if (style === 'PARQUET') {
      ctx.fillStyle = base || '#3b2618';
      ctx.fillRect(0, 0, 512, 512);
      const bw = 128;
      const bh = 42;
      for (let row = 0; row * bh < 512; row += 1) {
        const y = row * bh;
        for (let col = 0; col * bw < 512; col += 1) {
          const x = col * bw + (row % 2) * (bw / 2) - bw / 2;
          const v = ((row * 7 + col * 11) % 13) - 6;
          ctx.fillStyle = `rgba(${92 + v}, ${62 + v}, ${38 + v}, 0.55)`;
          ctx.fillRect(x + 2, y + 2, bw - 4, bh - 4);
          ctx.strokeStyle = 'rgba(12,8,5,0.75)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, bw, bh);
          ctx.strokeStyle = 'rgba(0,0,0,0.16)';
          ctx.lineWidth = 1;
          for (let g = 0; g < 4; g += 1) {
            ctx.beginPath();
            ctx.moveTo(x + 4, y + 8 + g * 8);
            ctx.bezierCurveTo(x + bw * 0.4, y + 6 + g * 8, x + bw * 0.6, y + 11 + g * 8, x + bw - 4, y + 9 + g * 8);
            ctx.stroke();
          }
        }
      }
      ctx.strokeStyle = 'rgba(210,175,110,0.22)';
      ctx.lineWidth = 4;
      ctx.strokeRect(16, 16, 480, 480);
    } else {
      // PLANK
      ctx.fillStyle = base || '#3e2723';
      ctx.fillRect(0, 0, 512, 512);
      const plankH = 512 / 8;
      for (let row = 0; row < 8; row += 1) {
        const y = row * plankH;
        const v = ((row * 17) % 11) - 5;
        ctx.fillStyle = `rgba(${22 + v}, ${14 + v}, ${9 + v}, 0.42)`;
        ctx.fillRect(0, y, 512, plankH);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(512, y);
        ctx.stroke();
        // Grain
        for (let g = 0; g < 9; g += 1) {
          const gy = y + 6 + ((g * 7 + row * 5) % (plankH - 12));
          ctx.strokeStyle = `rgba(0,0,0,${0.04 + (g % 3) * 0.02})`;
          ctx.lineWidth = 1 + (g % 2);
          ctx.beginPath();
          ctx.moveTo(0, gy);
          ctx.bezierCurveTo(150, gy + ((g % 3) - 1) * 4, 360, gy + (((g + 1) % 3) - 1) * 4, 512, gy);
          ctx.stroke();
        }
        // Staggered joints
        const j1 = (row * 173) % 512;
        const j2 = (j1 + 256) % 512;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(j1, y);
        ctx.lineTo(j1, y + plankH);
        ctx.moveTo(j2, y);
        ctx.lineTo(j2, y + plankH);
        ctx.stroke();
      }
    }

    /* ---------------------------- room overlays ---------------------------- */
    const carpetRooms = new Set(['entrance_hall', 'foyer', 'dining_room', 'ballroom', 'master_bedroom', 'drawing_room']);
    if (carpetRooms.has(roomId)) {
      const inset = 176;
      const w = 512 - inset * 2;
      // Deep pile with a velvet sheen toward the light source.
      const sheen = ctx.createLinearGradient(inset, inset, inset + w, inset + w);
      sheen.addColorStop(0, '#5d1119');
      sheen.addColorStop(0.45, '#75151f');
      sheen.addColorStop(1, '#4a0d14');
      ctx.fillStyle = sheen;
      ctx.beginPath();
      ctx.roundRect(inset, inset, w, w, 6);
      ctx.fill();

      // Woven pile texture
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(inset, inset, w, w, 6);
      ctx.clip();
      for (let i = 0; i < w; i += 4) {
        ctx.fillStyle = i % 8 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,190,150,0.045)';
        ctx.fillRect(inset + i, inset, 2, w);
      }
      ctx.restore();

      // Gold border bands
      ctx.strokeStyle = 'rgba(214,178,100,0.62)';
      ctx.lineWidth = 5;
      ctx.strokeRect(inset + 3, inset + 3, w - 6, w - 6);
      ctx.strokeStyle = 'rgba(214,178,100,0.28)';
      ctx.lineWidth = 2;
      ctx.strokeRect(inset + 13, inset + 13, w - 26, w - 26);

      // Corner lozenges
      for (const [cx, cy] of [
        [inset + 24, inset + 24],
        [inset + w - 24, inset + 24],
        [inset + 24, inset + w - 24],
        [inset + w - 24, inset + w - 24]
      ]) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = 'rgba(214,178,100,0.4)';
        ctx.fillRect(-6, -6, 12, 12);
        ctx.restore();
      }

      // Central medallion
      ctx.strokeStyle = 'rgba(214,178,100,0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(256, 256, 56, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(256, 256, 40, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (roomId === 'bloody_room' || roomId === 'operating_lab') {
      for (let i = 0; i < 26; i += 1) {
        const x = (i * 97) % 470 + 20;
        const y = (i * 163) % 470 + 20;
        const r = 8 + ((i * 7) % 26);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(96,8,10,0.55)');
        grad.addColorStop(1, 'rgba(60,4,6,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Drag streaks
      for (let i = 0; i < 4; i += 1) {
        ctx.strokeStyle = 'rgba(80,6,8,0.42)';
        ctx.lineWidth = 10 + i * 3;
        ctx.beginPath();
        ctx.moveTo(60 + i * 40, 470);
        ctx.bezierCurveTo(120, 360, 300, 340, 460, 200 + i * 20);
        ctx.stroke();
      }
    }

    if (roomId === 'collapsed_room') {
      ctx.fillStyle = '#050506';
      ctx.beginPath();
      ctx.moveTo(150, 170);
      ctx.lineTo(268, 132);
      ctx.lineTo(372, 196);
      ctx.lineTo(356, 318);
      ctx.lineTo(252, 380);
      ctx.lineTo(146, 306);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,96,60,0.6)';
      ctx.lineWidth = 6;
      ctx.stroke();
      // Splintered planks around the rim
      for (let i = 0; i < 14; i += 1) {
        const a = (i / 14) * Math.PI * 2;
        ctx.strokeStyle = 'rgba(140,108,68,0.45)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(256 + Math.cos(a) * 110, 256 + Math.sin(a) * 110);
        ctx.lineTo(256 + Math.cos(a) * 140, 256 + Math.sin(a) * 140);
        ctx.stroke();
      }
    }

    if (roomId === 'underground_lake') {
      const grad = ctx.createRadialGradient(256, 300, 20, 256, 300, 240);
      grad.addColorStop(0, 'rgba(18,40,48,0.85)');
      grad.addColorStop(0.7, 'rgba(12,26,32,0.6)');
      grad.addColorStop(1, 'rgba(12,26,32,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(256, 300, 230, 200, 0, 0, Math.PI * 2);
      ctx.fill();
      // Ripples
      ctx.strokeStyle = 'rgba(150,200,210,0.14)';
      for (let i = 1; i <= 4; i += 1) {
        ctx.beginPath();
        ctx.ellipse(256, 300, i * 46, i * 40, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (roomId === 'pentagram_chamber') {
      ctx.strokeStyle = 'rgba(170,30,44,0.4)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(256, 256, 150, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(20,12,16,0.75)';
      ctx.lineWidth = 6;
      const pts: [number, number][] = [];
      for (let i = 0; i < 5; i += 1) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        pts.push([256 + Math.cos(a) * 150, 256 + Math.sin(a) * 150]);
      }
      for (let i = 0; i < 5; i += 1) {
        const a = pts[i];
        const b = pts[(i + 2) % 5];
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }

    /* ------------------------------- vignette ------------------------------ */
    const vig = ctx.createRadialGradient(256, 256, 120, 256, 256, 372);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(0.66, 'rgba(0,0,0,0.22)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, 512, 512);

    /* ------------------------------ floor trim ----------------------------- */
    ctx.strokeStyle = style === 'FLAGSTONE' || style === 'DIRT' ? '#0d1013' : '#15110d';
    ctx.lineWidth = 26;
    ctx.strokeRect(13, 13, 486, 486);
    ctx.strokeStyle =
      style === 'FLAGSTONE' || style === 'DIRT' ? 'rgba(128,150,172,0.3)' : 'rgba(201,162,74,0.36)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(30, 30, 452, 452);

    /* ------------------------------ thresholds ----------------------------- */
    const drawThreshold = (dir: DoorDir) => {
      const y = dir === 'N' ? 8 : dir === 'S' ? 476 : 0;
      const x = dir === 'W' ? 8 : dir === 'E' ? 476 : 0;
      const w = dir === 'N' || dir === 'S' ? DOOR_HALF * 2 * px : 30;
      const d = dir === 'E' || dir === 'W' ? DOOR_HALF * 2 * px : 30;
      const px0 = dir === 'N' || dir === 'S' ? 256 - w / 2 : x;
      const py0 = dir === 'E' || dir === 'W' ? 256 - d / 2 : y;
      ctx.fillStyle = style === 'FLAGSTONE' || style === 'DIRT' ? '#4e5a66' : '#b8934a';
      ctx.fillRect(px0, py0, w, d);
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(px0 + 4, py0 + 4, w - 8, d - 8);
      ctx.fillStyle = style === 'FLAGSTONE' || style === 'DIRT' ? '#9fb4c8' : '#f0dcab';
      ctx.font = `700 17px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const chevron = dir === 'N' ? '▲' : dir === 'S' ? '▼' : dir === 'W' ? '◀' : '▶';
      ctx.fillText(chevron, px0 + w / 2, py0 + d / 2);
    };
    doors.forEach(drawThreshold);

    /* -------------------------------- plaque ------------------------------- */
    // The room name is drawn by the DOM label overlay and the tile badge, so
    // the floor stays clear for furniture. A small brass corner inlay keeps the
    // physical board-game feel without competing with the set dressing.
    ctx.save();
    ctx.translate(38, 452);
    ctx.fillStyle = 'rgba(12, 9, 7, 0.8)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 88, 26, 4);
    ctx.fill();
    ctx.strokeStyle = style === 'FLAGSTONE' || style === 'DIRT' ? 'rgba(140,165,190,0.5)' : 'rgba(201,162,74,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = style === 'FLAGSTONE' || style === 'DIRT' ? '#a9c1d8' : '#e8cb81';
    ctx.font = `600 13px ${CANVAS_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const level = floor === 'BASEMENT' ? 'B' : floor === 'UPPER' ? '2' : '1';
    const glyph = style === 'FLAGSTONE' || style === 'DIRT' ? '⌂' : style === 'MARBLE' ? '✦' : '❖';
    ctx.fillText(`${glyph}  ${level}F · ${doors.length}`, 44, 14);
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    this.roomTextureCache.set(key, texture);
    return texture;
  }

  /* ---------------------------- wallpaper --------------------------------- */

  private static wallpaperCache = new Map<string, THREE.MeshStandardMaterial>();

  /** Memoised room templates: cloning beats rebuilding on every board sync. */
  private static meshCache = new Map<string, THREE.Group>();

  /**
   * Pooled wall material with a procedural damask / stone wallpaper.
   * One material per (floor, palette) keeps draw calls and GPU uploads flat.
   */
  public static wallMaterial(kind: 'GROUND' | 'UPPER' | 'BASEMENT', accent?: string | null): THREE.MeshStandardMaterial {
    const key = `${kind}|${accent ?? ''}`;
    const cached = this.wallpaperCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    if (kind === 'BASEMENT') {
      // Damp mortared stone
      ctx.fillStyle = '#31393f';
      ctx.fillRect(0, 0, 128, 128);
      for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 4; col += 1) {
          const x = col * 32 + (row % 2) * 16;
          const y = row * 32;
          const v = (row * 7 + col * 11) % 13;
          ctx.fillStyle = `rgb(${40 + v}, ${46 + v}, ${52 + v})`;
          ctx.fillRect(x + 2, y + 2, 28, 28);
          ctx.strokeStyle = 'rgba(8,10,12,0.9)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, 32, 32);
        }
      }
      // Efflorescence streaks
      for (let i = 0; i < 5; i += 1) {
        ctx.fillStyle = 'rgba(150,170,180,0.05)';
        ctx.fillRect((i * 29) % 128, 0, 3 + (i % 3), 128);
      }
    } else {
      const isUpper = kind === 'UPPER';
      const base = isUpper ? '#553a52' : '#6b5238';
      const motif = isUpper ? 'rgba(186,146,196,0.34)' : 'rgba(214,182,116,0.30)';
      const stripe = isUpper ? 'rgba(34,18,32,0.34)' : 'rgba(32,22,14,0.34)';
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 128, 128);

      // Vertical stripes
      for (let x = 0; x < 128; x += 16) {
        ctx.fillStyle = stripe;
        ctx.fillRect(x, 0, 7, 128);
      }

      // Damask motif, repeated in a half-drop
      for (let row = 0; row < 2; row += 1) {
        for (let col = 0; col < 2; col += 1) {
          const cx = 32 + col * 64 + (row % 2) * 32;
          const cy = 32 + row * 64;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.strokeStyle = motif;
          ctx.fillStyle = motif;
          ctx.lineWidth = 1.6;
          // Symmetric fleur / palmette
          ctx.beginPath();
          ctx.moveTo(0, -17);
          ctx.quadraticCurveTo(11, -9, 6, 2);
          ctx.quadraticCurveTo(13, 8, 0, 18);
          ctx.quadraticCurveTo(-13, 8, -6, 2);
          ctx.quadraticCurveTo(-11, -9, 0, -17);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(0, -3, 3.2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Aged wash / damp patches
      for (let i = 0; i < 40; i += 1) {
        ctx.fillStyle = `rgba(12,8,6,${0.03 + ((i * 7) % 5) * 0.012})`;
        ctx.fillRect((i * 37) % 128, (i * 61) % 128, 10 + (i % 4) * 6, 6 + (i % 3) * 5);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2.2, 1);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      color: new THREE.Color(accent ?? '#ffffff'),
      roughness: kind === 'BASEMENT' ? 0.95 : 0.88,
      metalness: 0.02
    });
    material.userData.shared = true;
    this.wallpaperCache.set(key, material);
    return material;
  }

  /* ------------------------------ shell ---------------------------------- */

  private static addBox(
    target: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    cast = true
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    target.add(mesh);
    return mesh;
  }

  /**
   * One wall run: solid body plus baseboard, wainscot, chair rail and crown
   * moulding, optionally pierced by a door opening and lit by a window.
   */
  private static buildWall(
    target: THREE.Object3D,
    dir: DoorDir,
    height: number,
    door: boolean,
    wallMat: THREE.Material,
    windowed: boolean
  ): void {
    const isHoriz = dir === 'N' || dir === 'S';
    const fixed =
      dir === 'N' ? -HALF + THICK / 2 : dir === 'S' ? HALF - THICK / 2 : dir === 'W' ? -HALF + THICK / 2 : HALF - THICK / 2;
    /** Inward normal sign for the wall. */
    const inward = dir === 'N' || dir === 'W' ? 1 : -1;

    /** Place a band that runs along the wall at an explicit vertical centre. */
    const band = (
      along: number,
      len: number,
      h: number,
      mat: THREE.Material,
      yCenter: number,
      thicknessBoost = 0,
      cast = true
    ) => {
      const depth = THICK + thicknessBoost;
      const shift = (inward * thicknessBoost) / 2;
      if (isHoriz) {
        return this.addBox(target, len, h, depth, mat, along, yCenter, fixed + shift, cast);
      }
      return this.addBox(target, depth, h, len, mat, fixed + shift, yCenter, along, cast);
    };

    const runs: [number, number][] = door
      ? [
          [-HALF, -DOOR_HALF],
          [DOOR_HALF, HALF]
        ]
      : [[-HALF, HALF]];

    const tall = height > 0.24;
    const wainscotTop = 0.05 + height * 0.3;

    for (const [a, b] of runs) {
      const len = b - a;
      const along = (a + b) / 2;

      // Wall body
      band(along, len, height, wallMat, height / 2);
      // Baseboard
      band(along, len, 0.05, MAT.ebony, 0.025, 0.02);
      // Skirting bead
      band(along, len, 0.012, MAT.brass, 0.055, 0.028, false);
      if (tall) {
        // Wainscot panelling
        band(along, len - 0.07, wainscotTop - 0.06, MAT.walnut, (wainscotTop + 0.06) / 2, 0.022, false);
        // Chair rail
        band(along, len, 0.018, MAT.ebony, wainscotTop, 0.034, false);
        // Vertical panel dividers
        const panels = Math.max(1, Math.floor((len - 0.1) / 0.24));
        for (let p = 1; p < panels; p += 1) {
          const off = -len / 2 + (len * p) / panels;
          const px = isHoriz ? along + off : fixed + inward * 0.026;
          const pz = isHoriz ? fixed + inward * 0.026 : along + off;
          this.addBox(
            target,
            isHoriz ? 0.012 : 0.01,
            wainscotTop - 0.09,
            isHoriz ? 0.01 : 0.012,
            MAT.ebony,
            px,
            (wainscotTop + 0.06) / 2,
            pz,
            false
          );
        }
      }
      // Crown moulding (flush with the run: no overhang past the tile edge)
      band(along, len, 0.024, tall ? MAT.brass : MAT.iron, height - 0.012, 0.034, false);

      // Window with moonlight spill
      if (windowed && tall && len > 0.8) {
        const ww = 0.46;
        const wh = height * 0.42;
        const wy = height * 0.56;
        band(along, ww + 0.06, wh + 0.06, MAT.ebony, wy, 0.016, false);
        const glassX = isHoriz ? along : fixed + inward * 0.058;
        const glassZ = isHoriz ? fixed + inward * 0.058 : along;
        const pane = new THREE.Mesh(
          new THREE.BoxGeometry(isHoriz ? ww - 0.02 : 0.014, wh - 0.02, isHoriz ? 0.014 : ww - 0.02),
          MAT.windowPane
        );
        pane.position.set(glassX, wy, glassZ);
        target.add(pane);
        for (const mull of [-ww / 4, 0, ww / 4]) {
          this.addBox(
            target,
            isHoriz ? 0.012 : 0.022,
            wh - 0.03,
            isHoriz ? 0.022 : 0.012,
            MAT.ebony,
            isHoriz ? along + mull : glassX + inward * 0.004,
            wy,
            isHoriz ? glassZ + inward * 0.004 : along + mull,
            false
          );
        }
        this.addBox(
          target,
          isHoriz ? ww : 0.024,
          0.022,
          isHoriz ? 0.024 : ww,
          MAT.ebony,
          glassX + (isHoriz ? 0 : inward * 0.004),
          wy,
          glassZ + (isHoriz ? inward * 0.004 : 0),
          false
        );
        // Soft elliptical moonlight pooling on the floor beneath the window.
        const spill = new THREE.Mesh(new THREE.CircleGeometry(ww * 0.62, 20), moonSpillMaterial());
        spill.rotation.x = -Math.PI / 2;
        spill.position.set(
          isHoriz ? along : fixed + inward * 0.3,
          0.128,
          isHoriz ? fixed + inward * 0.3 : along
        );
        spill.scale.set(1, 0.78, 1);
        spill.renderOrder = 2;
        target.add(spill);
      }
    }

    // Door opening: jambs, beading, lintel and threshold.
    if (door) {
      for (const side of [-1, 1]) {
        band(side * (DOOR_HALF + 0.024), 0.048, height + 0.02, MAT.mahogany, (height + 0.02) / 2, 0.018);
        const beadX = isHoriz ? side * (DOOR_HALF + 0.005) : fixed + inward * 0.078;
        const beadZ = isHoriz ? fixed + inward * 0.078 : side * (DOOR_HALF + 0.005);
        this.addBox(
          target,
          isHoriz ? 0.016 : 0.018,
          height * 0.86,
          isHoriz ? 0.018 : 0.016,
          MAT.brass,
          beadX,
          height * 0.43,
          beadZ,
          false
        );
      }
      // Threshold plate sunk into the floor. Its depth matches the wall so it
      // can never poke into the neighbouring tile (the slab edge is HALF).
      this.addBox(
        target,
        isHoriz ? DOOR_HALF * 2 : THICK,
        0.014,
        isHoriz ? THICK : DOOR_HALF * 2,
        MAT.agedBrass,
        isHoriz ? 0 : fixed,
        0.126,
        isHoriz ? fixed : 0,
        false
      );
      if (tall) {
        // Lintel band + brass capping stay flush with the wall thickness so the
        // finish never reaches past the slab edge into the next tile.
        band(0, DOOR_HALF * 2 + 0.12, 0.07, MAT.mahogany, height - 0.045, 0);
        this.addBox(
          target,
          isHoriz ? DOOR_HALF * 2 + 0.16 : THICK,
          0.026,
          isHoriz ? THICK : DOOR_HALF * 2 + 0.16,
          MAT.brass,
          isHoriz ? 0 : fixed + inward * 0.01,
          height - 0.085,
          isHoriz ? fixed + inward * 0.01 : 0,
          false
        );
      }
    }
  }

  /**
   * Hang portraits, sconces and tapestries on the solid parts of the walls.
   *
   * Deterministic per room, and conservative about occlusion: a wall that
   * already carries a tall cabinet only gets a high sconce.
   */
  private static decorateWalls(
    target: THREE.Object3D,
    doors: DoorDir[],
    roomId: string,
    windowed: boolean,
    floor: string,
    usedWalls: Map<DoorDir, number>
  ): void {
    const innerFace = HALF - THICK;
    const seed = hashString(`walls|${roomId}`);
    const runs: { dir: DoorDir; from: number; to: number }[] = [];
    for (const dir of ['N', 'W', 'S', 'E'] as DoorDir[]) {
      const spans: [number, number][] = doors.includes(dir)
        ? [
            [-HALF, -DOOR_HALF],
            [DOOR_HALF, HALF]
          ]
        : [[-HALF, HALF]];
      for (const [a, b] of spans) {
        const from = a + 0.14;
        const to = b - 0.14;
        if (to - from >= 0.38) runs.push({ dir, from, to });
      }
    }
    if (runs.length === 0) return;

    // Deterministic order so the same room always hangs the same pictures.
    const ordered = runs
      .map((run, index) => ({ run, key: hashString(`${seed}|${run.dir}|${index}`) }))
      .sort((x, y) => x.key - y.key)
      .map(entry => entry.run);

    const ornate = floor !== 'BASEMENT';
    const pool = ornate ? ['portrait', 'sconce', 'tapestry', 'portrait'] : ['sconce', 'tapestry', 'portrait'];
    const count = Math.min(ordered.length, 1 + (seed % 3));

    for (let i = 0; i < count; i += 1) {
      const run = ordered[i];
      const isHoriz = run.dir === 'N' || run.dir === 'S';
      const length = run.to - run.from;
      let along = (run.from + run.to) / 2;

      // Skip the window opening on windowed back walls.
      if (windowed && (run.dir === 'N' || run.dir === 'W') && length > 0.8) {
        const offset = 0.52;
        along = Math.min(run.to - 0.16, Math.max(run.from + 0.16, along + offset));
      }

      // A wall carrying a tall cabinet only gets a high sconce.
      const occupied = usedWalls.get(run.dir) ?? 0;
      const kind = occupied > 0.34 ? 'sconce' : pool[(seed + i) % pool.length];
      const spec = PROPS[kind];
      if (!spec) continue;

      const group = spec.build();
      const inward = run.dir === 'N' || run.dir === 'W' ? 1 : -1;
      const wallCoord = (run.dir === 'N' || run.dir === 'W' ? -innerFace : innerFace) + inward * (spec.depth / 2 + 0.005);
      if (isHoriz) group.position.set(along, 0.12, wallCoord);
      else group.position.set(wallCoord, 0.12, along);
      group.rotation.y =
        run.dir === 'N' ? 0 : run.dir === 'S' ? Math.PI : run.dir === 'E' ? -Math.PI / 2 : Math.PI / 2;
      target.add(group);
    }
  }

  /**
   * The sealed front door of the mansion. The entrance hall is the first tile
   * every game opens on, and its south wall is only a cutaway stub, so the door
   * is a free-standing leaf pair that reads taller than the wall — implying the
   * storey continues behind the cut.
   */
  /**
   * The sealed front door.
   *
   * It is built against the tile's +Z wall and then rotated into place, because
   * the wall it belongs on depends on which side of the house the entrance hall
   * ended up on. Drawing it on a fixed wall put the door facing into the house.
   */
  private static addFrontDoor(target: THREE.Object3D, dir: DoorDir = 'S'): void {
    const door = new THREE.Group();
    target.add(door);
    target = door;
    const z = HALF - THICK - 0.02;
    const W = DOOR_HALF * 2 - 0.02;
    const H = 0.66;
    const base = 0.12;

    // Brick surround + carved lintel. The pale stone panel read as a blank white
    // wall behind the doors; brick ties the entrance to the house's masonry.
    this.addBox(target, W + 0.16, H + 0.12, 0.05, MAT.brick, 0, base + (H + 0.12) / 2, z - 0.01, false);
    this.addBox(target, W + 0.26, 0.07, 0.09, MAT.brick, 0, base + H + 0.12, z + 0.01);
    this.addBox(target, W + 0.3, 0.03, 0.11, MAT.brass, 0, base + H + 0.17, z + 0.01, false);

    // Two leaves
    for (const sx of [-1, 1]) {
      const cx = sx * (W / 4 + 0.005);
      this.addBox(target, W / 2 - 0.015, H, 0.045, MAT.mahogany, cx, base + H / 2, z + 0.035);
      // Vertical plank seams
      for (const dx of [-0.06, 0.06]) {
        this.addBox(target, 0.008, H - 0.06, 0.05, MAT.ebony, cx + dx, base + H / 2, z + 0.036, false);
      }
      // Iron studs
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          this.addBox(
            target,
            0.014,
            0.014,
            0.012,
            MAT.iron,
            cx - 0.075 + col * 0.075,
            base + 0.16 + row * 0.19,
            z + 0.06,
            false
          );
        }
      }
      // Ring knocker
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.008, 6, 14), MAT.iron);
      ring.position.set(cx + sx * 0.12, base + H * 0.52, z + 0.065);
      target.add(ring);
      this.addBox(target, 0.03, 0.02, 0.014, MAT.iron, cx + sx * 0.12, base + H * 0.52 + 0.035, z + 0.06, false);
    }

    // Centre stile with a heavy bar lock
    this.addBox(target, 0.024, H, 0.055, MAT.ebony, 0, base + H / 2, z + 0.04, false);
    this.addBox(target, 0.2, 0.035, 0.03, MAT.iron, 0, base + H * 0.6, z + 0.075, false);
    this.addBox(target, 0.05, 0.05, 0.03, MAT.agedBrass, 0, base + H * 0.6, z + 0.09, false);

    // The door is built against +Z; rotate it onto the wall it belongs on.
    const yaw = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[dir] ?? 0;
    door.rotation.y = yaw;
  }

  /**
   * Builds the complete 2.5D room: floor slab, cutaway walls with trim,
   * door openings, a door-aware furniture layout, and merged draw calls.
   *
   * Results are memoised per tile signature: a room always looks the same, so
   * rebuilds clone a template instead of re-running the layout and the ~600
   * geometry constructions. Clones share geometry, which the renderer must not
   * dispose (see `userData.sharedGeometry`).
   */
  public static createRoomMesh(
    name: string,
    size: number = TILE,
    color: string = '#3e2723',
    doors: DoorDir[] = [],
    options?: RoomTileOptions
  ): THREE.Group {
    const floor = options?.floor || 'GROUND';
    const roomId = options?.roomId ?? '';
    const isPreview = options?.isPreview ?? false;
    const isBasement = floor === 'BASEMENT';
    const scale = size / TILE;

    const cacheKey = `${roomId}|${name}|${size}|${color}|${[...doors].sort().join('')}|${floor}|${options?.frontDoor ?? ''}`;
    if (!isPreview) {
      const cached = this.meshCache.get(cacheKey);
      if (cached) return cached.clone(true);
    }

    const shell = new THREE.Group();

    /* -------------------------------- floor -------------------------------- */
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(size, 0.12, size),
      [
        isBasement ? MAT.slate : MAT.ebony,
        isBasement ? MAT.slate : MAT.ebony,
        new THREE.MeshBasicMaterial({
          map: this.createRoomTexture(name, color, doors, floor, roomId)
        }),
        isBasement ? MAT.slate : MAT.ebony,
        isBasement ? MAT.slate : MAT.ebony,
        isBasement ? MAT.slate : MAT.ebony
      ]
    );
    slab.position.y = 0.06;
    slab.castShadow = true;
    slab.receiveShadow = true;
    shell.add(slab);

    // Plinth lip: inset slightly so two adjacent tiles can never share a
    // coplanar face (the board grid steps 2.86 while the tile is 2.84 wide).
    this.addBox(shell, size - 0.02, 0.03, size - 0.02, isBasement ? MAT.granite : MAT.walnut, 0, 0.015, 0, false);

    if (isPreview) {
      const ghost = mergeByMaterial(shell);
      ghost.scale.set(scale, scale, scale);
      return ghost;
    }

    /* -------------------------------- walls -------------------------------- */
    const wallKind = isBasement ? 'BASEMENT' : floor === 'UPPER' ? 'UPPER' : 'GROUND';
    // Back walls are papered; the low cutaway walls stay plain so they do not
    // compete with the furniture silhouettes.
    const backMat = this.wallMaterial(wallKind);
    const wallMat = isBasement ? MAT.slate : MAT.ebony;
    const windowed = WINDOWED.has(roomId) && floor !== 'BASEMENT';

    this.buildWall(shell, 'N', BACK_H, doors.includes('N'), backMat, windowed);
    this.buildWall(shell, 'W', BACK_H, doors.includes('W'), backMat, windowed);
    this.buildWall(shell, 'S', FRONT_H, doors.includes('S'), wallMat, false);
    this.buildWall(shell, 'E', FRONT_H, doors.includes('E'), wallMat, false);

    /* --------------------------- corner pillars ---------------------------- */
    // Kept inside the tile footprint (max |x| = 1.41 < HALF) so neighbouring
    // rooms never interpenetrate.
    const pillarOffset = HALF - 0.085;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = sx * pillarOffset;
        const pz = sz * pillarOffset;
        this.addBox(shell, 0.12, BACK_H + 0.05, 0.12, backMat, px, (BACK_H + 0.05) / 2, pz);
        this.addBox(shell, 0.14, 0.026, 0.14, MAT.brass, px, BACK_H + 0.06, pz, false);
        this.addBox(shell, 0.13, 0.02, 0.13, MAT.ebony, px, 0.13, pz, false);
      }
    }

    /* ------------------------------ furniture ------------------------------ */
    const wish = ROOM_PROPS[roomId] ?? defaultWish(roomId, floor);
    const layout = layoutRoom({
      inner: INNER,
      doors,
      wanted: wish,
      seed: hashString(`${roomId}|${name}|${doors.join('')}`),
      doorHalf: DOOR_HALF
    });

    for (const placed of layout.placed) {
      const group = placed.spec.build();
      group.position.set(placed.x, 0.12, placed.z);
      group.rotation.y = placed.yaw;
      shell.add(group);
    }

    /* --------------------------- wall decoration --------------------------- */
    // The mansion's sealed front door anchors the entrance hall.
    if (options?.special === 'FRONT_DOOR' || roomId === 'entrance_hall') {
      this.addFrontDoor(shell, (options?.frontDoor as DoorDir | null) ?? 'S');
    }

    // Tall furniture hides anything hung at eye level, so record how much each
    // wall run is already occupied before choosing what to hang.
    const usedWalls = new Map<DoorDir, number>();
    for (const placed of layout.placed) {
      if (!placed.wall) continue;
      usedWalls.set(placed.wall, Math.max(usedWalls.get(placed.wall) ?? 0, placed.spec.height));
    }
    this.decorateWalls(shell, doors, roomId, windowed, floor, usedWalls);

    /* --------------------------- corner dressing --------------------------- */
    // Cobwebs belong in the upper corners, tucked against two walls. Placing
    // them here (rather than as generic wall props) keeps them out of the way
    // of the furniture and reads as age rather than clutter.
    const neglect = hashString(roomId) % 4;
    const webCorners: [number, number, number][] = [
      [-1, -1, Math.PI / 4],
      [1, -1, -Math.PI / 4],
      [-1, 1, (Math.PI * 3) / 4],
      [1, 1, (-Math.PI * 3) / 4]
    ];
    const webCount = neglect === 0 ? 2 : neglect === 1 ? 1 : 0;
    for (let i = 0; i < webCount; i += 1) {
      const [sx, sz, yaw] = webCorners[i];
      const web = PROPS.cobweb.build();
      web.position.set(sx * (HALF - 0.13), BACK_H - 0.1, sz * (HALF - 0.13));
      web.rotation.y = yaw;
      web.scale.setScalar(1.15);
      shell.add(web);
    }

    const merged = mergeByMaterial(shell);
    merged.scale.set(scale, scale, scale);
    if (isPreview) return merged;

    // Mark every merged geometry as shared so clones survive board rebuilds.
    merged.traverse(node => {
      node.userData.sharedGeometry = true;
    });
    this.meshCache.set(cacheKey, merged);
    return merged.clone(true);
  }
}

/** Fallback dressing when a room has no explicit set (future-proofing). */
function defaultWish(roomId: string, floor: string): (string | { id: string; count: number })[] {
  if (floor === 'BASEMENT') return ['crateStack', 'debrisPile'];
  if (floor === 'UPPER') return ['writingDesk', 'nightstand'];
  return ['sideTable', 'armchair', 'planter'];
}

/* -------------------------------------------------------------------------- */
/* Shared decal material                                                      */
/* -------------------------------------------------------------------------- */

let moonSpill: THREE.MeshBasicMaterial | null = null;

/** Radial-gradient moon pool used under windows and doorways. */
function moonSpillMaterial(): THREE.MeshBasicMaterial {
  if (moonSpill) return moonSpill;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(190,220,245,0.30)');
  grad.addColorStop(0.55, 'rgba(160,200,235,0.12)');
  grad.addColorStop(1, 'rgba(140,180,220,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  moonSpill = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  moonSpill.userData.shared = true;
  return moonSpill;
}

/* -------------------------------------------------------------------------- */
/* Geometry merging                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Merge every single-material mesh in the tree into one mesh per material.
 * A 40-prop room drops from ~400 draw calls to ~14 while keeping shadows.
 */
function mergeByMaterial(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });

  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const passthrough: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = [];

  for (const mesh of meshes) {
    const material = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) {
      passthrough.push({ mesh, matrix: mesh.matrixWorld.clone() });
      continue;
    }
    if (!mesh.geometry) continue;
    const geom = mesh.geometry.clone();
    // Drop attributes that would break the merge contract.
    for (const key of Object.keys(geom.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') geom.deleteAttribute(key);
    }
    geom.applyMatrix4(mesh.matrixWorld);
    const list = buckets.get(material) ?? [];
    list.push(geom);
    buckets.set(material, list);
  }

  const out = new THREE.Group();
  for (const { mesh, matrix } of passthrough) {
    // Detach from the old tree so the caller can dispose the source safely.
    mesh.removeFromParent();
    matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    out.add(mesh);
  }

  buckets.forEach((geoms, material) => {
    const merged =
      geoms.length === 1
        ? geoms[0]
        : mergeGeometries(geoms, false) ??
          (() => {
            // Merge failed (unexpected attribute mismatch) — keep them apart.
            return null;
          })();
    if (!merged) {
      geoms.forEach(g => {
        const m = new THREE.Mesh(g, material);
        m.castShadow = true;
        m.receiveShadow = true;
        out.add(m);
      });
      return;
    }
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  });

  return out;
}
