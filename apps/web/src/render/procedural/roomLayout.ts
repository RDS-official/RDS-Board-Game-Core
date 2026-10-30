import { PropSpec, PROPS } from './props';

/**
 * Door-aware furniture layout.
 *
 * The engineer's contract here is simple and strict:
 *  - no prop may sit inside a door's approach corridor;
 *  - the walkable remainder must stay connected, so every door can still be
 *    reached from every other door;
 *  - layout is deterministic per room (seeded), so a repaint never shuffles
 *    the furniture between rebuilds.
 *
 * It runs on a coarse occupancy grid (≈0.11 world units per cell).
 */

export type DoorDir = 'N' | 'S' | 'E' | 'W';

export interface Rect {
  /** centre X */
  x: number;
  /** centre Z */
  z: number;
  /** full width along X */
  w: number;
  /** full depth along Z */
  d: number;
}

export interface PlacedProp {
  spec: PropSpec;
  x: number;
  z: number;
  yaw: number;
  rect: Rect;
  wall?: DoorDir;
}

export interface LayoutRequest {
  /** Half extent of the walkable floor (tile size / 2 - wall thickness). */
  inner: number;
  doors: DoorDir[];
  /** Desired props, in priority order. Unknown ids are skipped. */
  wanted: (string | { id: string; count?: number })[];
  seed: number;
  /** Half width of a door opening (door gap = 2 * doorHalf). */
  doorHalf?: number;
  /** How far into the room a door corridor is protected. */
  approachDepth?: number;
  /** When set, logs every rejection reason for this prop id. */
  debugId?: string;
}

export interface LayoutResult {
  placed: PlacedProp[];
  /** Props requested but rejected for lack of legal space. */
  rejected: string[];
}

const CELL = 0.11;
const PROP_MARGIN = 0.045;

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DOOR_VECTORS: Record<DoorDir, [number, number]> = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0]
};

/** Yaw that turns a prop built facing +Z so its back hugs the given wall. */
function yawForWall(wall: DoorDir): number {
  switch (wall) {
    case 'N':
      return 0;
    case 'E':
      return -Math.PI / 2;
    case 'S':
      return Math.PI;
    case 'W':
      return Math.PI / 2;
  }
}

/** Footprint AABB after the 90°-quantised rotation. */
function footprintFor(spec: PropSpec, wall?: DoorDir): { w: number; d: number } {
  if (!wall || wall === 'N' || wall === 'S') return { w: spec.width, d: spec.depth };
  return { w: spec.depth, d: spec.width };
}

class Occupancy {
  readonly n: number;
  readonly cells: Uint8Array;

  constructor(readonly inner: number) {
    const span = inner * 2;
    this.n = Math.max(6, Math.ceil(span / CELL));
    this.cells = new Uint8Array(this.n * this.n);
  }

  cellSize(): number {
    return (this.inner * 2) / this.n;
  }

  /** World coordinate of the centre of cell (i, j). */
  centre(i: number, j: number): [number, number] {
    const s = this.cellSize();
    return [-this.inner + (i + 0.5) * s, -this.inner + (j + 0.5) * s];
  }

  indexAt(x: number, z: number): [number, number] {
    const s = this.cellSize();
    const i = Math.floor((x + this.inner) / s);
    const j = Math.floor((z + this.inner) / s);
    return [Math.min(this.n - 1, Math.max(0, i)), Math.min(this.n - 1, Math.max(0, j))];
  }

  /** Mark a rect (optionally inflated) as blocked for props. */
  fill(rect: Rect, inflated = 0): void {
    this.paint(rect, inflated, 1);
  }

  /** Clear a rect (optionally inflated) back to walkable. */
  clear(rect: Rect, inflated = 0): void {
    this.paint(rect, inflated, 0);
  }

  private paint(rect: Rect, inflated: number, value: 0 | 1): void {
    const s = this.cellSize();
    const i0 = Math.floor((rect.x - rect.w / 2 - inflated + this.inner) / s);
    const i1 = Math.ceil((rect.x + rect.w / 2 + inflated + this.inner) / s);
    const j0 = Math.floor((rect.z - rect.d / 2 - inflated + this.inner) / s);
    const j1 = Math.ceil((rect.z + rect.d / 2 + inflated + this.inner) / s);
    for (let j = Math.max(0, j0); j < Math.min(this.n, j1); j += 1) {
      for (let i = Math.max(0, i0); i < Math.min(this.n, i1); i += 1) {
        this.cells[j * this.n + i] = value;
      }
    }
  }

  /** True when every cell the rect overlaps is free (value !== 1). */
  isFree(rect: Rect, inflated = 0): boolean {
    const s = this.cellSize();
    const i0 = Math.floor((rect.x - rect.w / 2 - inflated + this.inner) / s);
    const i1 = Math.ceil((rect.x + rect.w / 2 + inflated + this.inner) / s);
    const j0 = Math.floor((rect.z - rect.d / 2 - inflated + this.inner) / s);
    const j1 = Math.ceil((rect.z + rect.d / 2 + inflated + this.inner) / s);
    for (let j = j0; j < j1; j += 1) {
      for (let i = i0; i < i1; i += 1) {
        if (i < 0 || j < 0 || i >= this.n || j >= this.n) return false;
        if (this.cells[j * this.n + i] === 1) return false;
      }
    }
    return true;
  }

  /** Flood fill from `starts`; returns the visited mask. */
  reachable(starts: [number, number][]): Uint8Array {
    const visited = new Uint8Array(this.n * this.n);
    const queue: number[] = [];
    for (const [si, sj] of starts) {
      const idx = sj * this.n + si;
      if (this.cells[idx] === 1 || visited[idx]) continue;
      visited[idx] = 1;
      queue.push(idx);
    }
    while (queue.length > 0) {
      const idx = queue.pop()!;
      const i = idx % this.n;
      const j = (idx - i) / this.n;
      const push = (ni: number, nj: number) => {
        if (ni < 0 || nj < 0 || ni >= this.n || nj >= this.n) return;
        const nidx = nj * this.n + ni;
        if (visited[nidx] || this.cells[nidx] === 1) return;
        visited[nidx] = 1;
        queue.push(nidx);
      };
      push(i + 1, j);
      push(i - 1, j);
      push(i, j + 1);
      push(i, j - 1);
    }
    return visited;
  }
}

export function layoutRoom(request: LayoutRequest): LayoutResult {
  const { inner, doors, seed } = request;
  const doorHalf = request.doorHalf ?? 0.46;
  const approachDepth = request.approachDepth ?? 0.58;
  // The grid must be a little larger than the walkable interior so that props
  // hugging a wall still land inside it.
  const grid = new Occupancy(inner + 0.14);
  const rng = makeRng(seed);

  // 1. Door approach corridors: walkable, but furniture is forbidden.
  const doorCells: [number, number][] = [];
  for (const dir of doors) {
    const [vx, vz] = DOOR_VECTORS[dir];
    const w = vx !== 0 ? approachDepth : doorHalf * 2;
    const d = vz !== 0 ? approachDepth : doorHalf * 2;
    const cx = vx * (inner - approachDepth / 2);
    const cz = vz * (inner - approachDepth / 2);
    grid.fill({ x: cx, z: cz, w, d }, 0.04);
    // Remember the innermost walkable cell of the corridor.
    const probeX = vx * (inner - approachDepth - grid.cellSize() * 0.6);
    const probeZ = vz * (inner - approachDepth - grid.cellSize() * 0.6);
    doorCells.push(grid.indexAt(probeX, probeZ));
  }

  // Corridor cells are blocked for props but must stay walkable, so keep a
  // copy of the "prop-forbidden" mask and clear it for walking.
  const propForbidden = Uint8Array.from(grid.cells);
  grid.cells.fill(0);

  /** Exact corridor rectangles: placement tests use these, not the grid. */
  const corridorRects: Rect[] = [];
  for (const dir of doors) {
    const [vx, vz] = DOOR_VECTORS[dir];
    const w = vx !== 0 ? approachDepth : doorHalf * 2;
    const d = vz !== 0 ? approachDepth : doorHalf * 2;
    corridorRects.push({
      x: vx * (inner - approachDepth / 2),
      z: vz * (inner - approachDepth / 2),
      w,
      d
    });
  }

  const placed: PlacedProp[] = [];
  const rejected: string[] = [];

  const centreCell = grid.indexAt(0, 0);
  // Walkability is anchored on the doors themselves: a room may legitimately
  // have a dining table in the middle, as long as every door stays reachable.
  const required: [number, number][] = doorCells.length > 0 ? doorCells : [centreCell];
  const origin = required[0];

  const overlaps = (a: Rect, b: Rect, pad = 0): boolean => {
    const dx = Math.abs(a.x - b.x) < (a.w + b.w) / 2 + pad;
    const dz = Math.abs(a.z - b.z) < (a.d + b.d) / 2 + pad;
    return dx && dz;
  };

  const commit = (spec: PropSpec, x: number, z: number, wall?: DoorDir): boolean => {
    const trace = request.debugId === spec.id ? (msg: string) => console.log(`  [${spec.id}] ${msg}`) : () => undefined;
    const fp = footprintFor(spec, wall);
    const rect: Rect = { x, z, w: fp.w, d: fp.d };
    if (Math.abs(x) + rect.w / 2 > inner + 0.001) {
      trace(`out of bounds X x=${x.toFixed(2)} half=${(rect.w / 2).toFixed(2)}`);
      return false;
    }
    if (Math.abs(z) + rect.d / 2 > inner + 0.001) {
      trace(`out of bounds Z z=${z.toFixed(2)} half=${(rect.d / 2).toFixed(2)}`);
      return false;
    }
    // Exact overlap against already-placed furniture.
    for (const other of placed) {
      if (other.spec.decal || other.spec.ceiling || other.spec.wallMounted) continue;
      if (overlaps(rect, other.rect, PROP_MARGIN * 2)) {
        trace(`overlaps ${other.spec.id} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
        return false;
      }
    }
    // Never intrude into a doorway approach corridor.
    for (const corridor of corridorRects) {
      if (overlaps(rect, corridor, PROP_MARGIN)) {
        trace(`blocks a door corridor at (${x.toFixed(2)}, ${z.toFixed(2)}) wall=${wall}`);
        return false;
      }
    }
    // Temporarily block, then verify every door is still mutually reachable.
    grid.fill(rect, PROP_MARGIN);
    const visited = grid.reachable([[origin[0], origin[1]]]);
    const connected = required.every(([ri, rj]) => visited[rj * grid.n + ri] === 1);
    if (!connected) {
      trace(`would disconnect a door at (${x.toFixed(2)}, ${z.toFixed(2)}) wall=${wall}`);
      grid.clear(rect, PROP_MARGIN);
      return false;
    }
    placed.push({ spec, x, z, yaw: wall ? yawForWall(wall) : 0, rect, wall });
    return true;
  };

  /** Candidate wall slots for a wall-anchored prop, near-to-far from a corner. */
  const wallCandidates = (spec: PropSpec, wall: DoorDir): { x: number; z: number }[] => {
    const fp = footprintFor(spec, wall);
    const [vx, vz] = DOOR_VECTORS[wall];
    // The extent along the wall vs. away from it depends on the wall orientation.
    const alongHalf = (vx !== 0 ? fp.d : fp.w) / 2;
    const normalHalf = (vx !== 0 ? fp.w : fp.d) / 2;
    const alongMin = -inner + alongHalf + 0.02;
    const alongMax = inner - alongHalf - 0.02;
    if (alongMax < alongMin) return [];
    const steps = 15;
    const offsets: number[] = [];
    for (let k = 0; k < steps; k += 1) {
      offsets.push(alongMin + ((alongMax - alongMin) * k) / (steps - 1));
    }
    // Prefer wall ends (corners read better) then the middle.
    offsets.sort((a, b) => {
      const half = (alongMax - alongMin) / 2;
      const da = Math.abs(Math.abs(a) - half);
      const db = Math.abs(Math.abs(b) - half);
      return db - da + (rng() - 0.5) * 0.02;
    });
    const out: { x: number; z: number }[] = [];
    const depthOffset = inner - normalHalf - 0.02;
    for (const along of offsets) {
      if (vx !== 0) out.push({ x: vx * depthOffset, z: along });
      else out.push({ x: along, z: vz * depthOffset });
    }
    return out;
  };

  /** Spiral of interior positions for free-standing props. */
  const centreCandidates = (spec: PropSpec): { x: number; z: number }[] => {
    const out: { x: number; z: number }[] = [];
    const limit = inner - Math.max(spec.width, spec.depth) / 2 - 0.03;
    const ring = [0, 0.34, 0.62, 0.9];
    for (const r of ring) {
      if (r > limit) break;
      if (r === 0) {
        out.push({ x: 0, z: 0 });
        continue;
      }
      const count = Math.max(4, Math.round((2 * Math.PI * r) / 0.34));
      for (let k = 0; k < count; k += 1) {
        const a = (k * 2 * Math.PI) / count + rng() * 0.25;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (Math.abs(x) + spec.width / 2 > inner) continue;
        if (Math.abs(z) + spec.depth / 2 > inner) continue;
        out.push({ x, z });
      }
    }
    return out;
  };

  // 2. Normalise the wish list into concrete prop instances.
  const wish: { spec: PropSpec | undefined; id: string }[] = [];
  request.wanted.forEach(entry => {
    const id = typeof entry === 'string' ? entry : entry.id;
    const count = typeof entry === 'string' ? 1 : entry.count ?? 1;
    const spec = PROPS[id];
    if (!spec) {
      rejected.push(id);
      return;
    }
    for (let i = 0; i < count; i += 1) wish.push({ spec, id });
    if (!spec) rejected.push(id);
  });

  // 3. Floor decals first: they never block a doorway and everything else may
  //    sit on top of them.
  const decals = wish.filter(w => w.spec?.decal);
  for (const entry of decals) {
    const spec = entry.spec!;
    placed.push({ spec, x: 0, z: 0, yaw: 0, rect: { x: 0, z: 0, w: 0, d: 0 } });
  }

  // 4. Wall-hugging props (they define the room's read), then centre pieces,
  //    then satellites (chairs around a table), then clutter.
  const rest = wish.filter(w => !w.spec?.decal);
  const wallProps = rest.filter(w => w.spec && w.spec.anchor !== 'CENTER');
  const satellites = rest.filter(w => w.spec?.anchor === 'CENTER' && w.spec.satellite);
  const centreProps = rest.filter(w => w.spec?.anchor === 'CENTER' && !w.spec.satellite);
  let centrepiece: PlacedProp | undefined;

  for (const entry of wallProps) {
    const spec = entry.spec!;
    if (spec.ceiling || spec.wallMounted) {
      // No footprint; borrow a wall to sit on (or the ceiling centre).
      const wall: DoorDir = doors.length === 0 ? 'N' : (['N', 'W', 'E', 'S'] as DoorDir[]).find(d => !doors.includes(d)) ?? 'N';
      const [vx, vz] = DOOR_VECTORS[wall];
      const x = spec.ceiling ? 0 : vx * (inner - spec.depth / 2 - 0.03);
      const z = spec.ceiling ? 0 : vz * (inner - spec.depth / 2 - 0.03);
      placed.push({ spec, x, z, yaw: spec.ceiling ? 0 : yawForWall(wall), rect: { x, z, w: 0, d: 0 }, wall });
      continue;
    }
    // Try the preferred wall, then the others.
    const order: DoorDir[] = [spec.anchor as DoorDir, 'N', 'E', 'S', 'W'].filter(
      (d, i, arr) => arr.indexOf(d) === i && (d === 'N' || d === 'S' || d === 'E' || d === 'W')
    ) as DoorDir[];
    let ok = false;
    for (const wall of order) {
      for (const cand of wallCandidates(spec, wall)) {
        if (commit(spec, cand.x, cand.z, wall)) {
          ok = true;
          break;
        }
      }
      if (ok) break;
    }
    if (!ok) rejected.push(spec.id);
  }

  for (const entry of centreProps) {
    const spec = entry.spec!;
    if (spec.ceiling) {
      placed.push({ spec, x: 0, z: 0, yaw: 0, rect: { x: 0, z: 0, w: 0, d: 0 } });
      continue;
    }
    let ok = false;
    for (const cand of centreCandidates(spec)) {
      if (commit(spec, cand.x, cand.z)) {
        ok = true;
        if (!centrepiece && spec.width * spec.depth > 0.14) centrepiece = placed[placed.length - 1];
        break;
      }
    }
    if (!ok) rejected.push(spec.id);
  }

  // 5. Satellites orbit the centrepiece (dining chairs around a table).
  for (const entry of satellites) {
    const spec = entry.spec!;
    let ok = false;
    if (centrepiece) {
      const gap = spec.satelliteGap ?? 0.13;
      const host = centrepiece;
      const offX = host.rect.w / 2 + spec.width / 2 + gap;
      const offZ = host.rect.d / 2 + spec.depth / 2 + gap;
      // Satellite props are built facing +Z, so the yaw must turn their front
      // toward the host: north seat faces +Z (yaw 0), west seat faces +X (π/2).
      const candidates = [
        { x: host.x, z: host.z - offZ, yaw: 0 },
        { x: host.x, z: host.z + offZ, yaw: Math.PI },
        { x: host.x - offX, z: host.z, yaw: Math.PI / 2 },
        { x: host.x + offX, z: host.z, yaw: -Math.PI / 2 }
      ];
      // Shuffle deterministically so chairs do not always ring in the same order.
      const rot = Math.floor(rng() * candidates.length);
      const ordered = [...candidates.slice(rot), ...candidates.slice(0, rot)];
      for (const cand of ordered) {
        if (commit(spec, cand.x, cand.z)) {
          placed[placed.length - 1].yaw = cand.yaw;
          ok = true;
          break;
        }
      }
    }
    if (!ok) {
      for (const cand of centreCandidates(spec)) {
        if (commit(spec, cand.x, cand.z)) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) rejected.push(spec.id);
  }

  return { placed, rejected };
}
