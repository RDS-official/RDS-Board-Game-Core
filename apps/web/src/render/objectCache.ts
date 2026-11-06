import * as THREE from 'three';

/**
 * Keyed template cache for procedurally built board furniture.
 *
 * ## The problem
 *
 * `BoardGameScene.syncState()` rebuilt every board object on each state change:
 * `clearBoardObjects()` disposed the whole subtree and the renderers then
 * re-ran every procedural builder. That is correct but wasteful — a table mat,
 * a hex tile, a room diorama or a 1024×256 label canvas is a pure function of a
 * handful of arguments, and most of those arguments do not change between two
 * consecutive actions. Measured on the poker fixture (headless Chromium,
 * software raster), one action spent 8–38 ms rebuilding the board, and most of
 * it was furniture that had not changed.
 *
 * ## What this does
 *
 * This is the 3D counterpart of `ui/dom/keyed.ts`. Each object is registered
 * under a **key** (an entity id, or a stable role such as `poker:felt` /
 * `deck-pile:zone_deck`) plus a **signature** (the serialised builder
 * arguments). On the next sync:
 *
 *   - same key + same signature → the builder is **not** re-run; a clone of the
 *     cached template is handed back instead. Cloning an `Object3D` copies the
 *     graph and shares geometry, materials and textures, so it costs a fraction
 *     of the original build.
 *   - same key + different signature → the template is dropped and rebuilt.
 *   - key not requested during the current sync → the template is evicted and
 *     the GPU resources it created are released.
 *
 * Clones are deliberately *fresh objects*: the renderer still owns every object
 * it draws, so per-object mutations (position, rotation, `userData`, highlight
 * material swaps) can never leak back into the template.
 *
 * ## Resource ownership
 *
 * A clone shares geometry/material/texture with its template, so disposing a
 * clone must not dispose them. Every returned subtree is therefore tagged with
 * `userData.sharedGeometry` and `material.userData.shared` — the two flags
 * `BoardGameScene.disposeObject3D()` already honours for pooled room tiles.
 *
 * The cache is the sole owner of what a builder created. Ownership is recorded
 * *before* the shared tags are applied (otherwise the tags would hide the
 * cache's own resources from its disposer), and pooled palette materials that a
 * builder already marked `userData.shared` are never disposed.
 */

interface OwnedResources {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
}

interface CacheEntry {
  signature: string;
  /** Pristine copy; never handed to the renderer. */
  template: THREE.Object3D;
  owned: OwnedResources;
  /** Generation of the last sync that asked for this key. */
  used: number;
}

export interface ObjectCacheStats {
  /** Syncs that reused a cached template instead of rebuilding. */
  hits: number;
  /** Syncs that had to run a builder (new key or changed signature). */
  misses: number;
  /** Entries dropped because a sync did not ask for them any more. */
  evictions: number;
  /** Entries currently held. */
  size: number;
}

/**
 * Cheap content signature for `obtain()`.
 *
 * FNV-1a over the builder arguments: the cache only needs equality, not
 * ordering, and a short string keeps the per-entry footprint small. Objects and
 * arrays are serialised, so pass the exact fields the builder reads.
 */
export function signatureOf(...parts: unknown[]): string {
  const text = parts
    .map((part) => (typeof part === 'string' ? part : (JSON.stringify(part) ?? '')))
    .join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const material = (object as THREE.Mesh).material;
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

/**
 * What this builder call created and therefore what the cache must release.
 *
 * `THREE.Sprite` shares one module-level geometry across every sprite in the
 * process, so its geometry is never owned here.
 */
function collectOwned(root: THREE.Object3D): OwnedResources {
  const owned: OwnedResources = {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
  };
  root.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry;
    if (geometry && !child.userData?.sharedGeometry && !(child instanceof THREE.Sprite)) {
      owned.geometries.add(geometry);
    }
    for (const material of materialsOf(child)) {
      if (!material || material.userData?.shared) continue;
      owned.materials.add(material);
      if (child.userData?.ownedTexture) {
        const map = (material as THREE.MeshBasicMaterial).map;
        if (map) owned.textures.add(map);
      }
    }
  });
  return owned;
}

function disposeOwned(owned: OwnedResources): void {
  for (const texture of owned.textures) texture.dispose();
  for (const material of owned.materials) material.dispose();
  for (const geometry of owned.geometries) geometry.dispose();
}

/**
 * Mark a subtree as sharing GPU resources with the cache.
 *
 * The texture flag is cleared: the cached template owns the map, so a clone
 * disposed by the renderer must not dispose it. The root carries its cache key
 * so diagnostics (and the scene-cache probe) can tell cached furniture apart.
 */
function tagShared(root: THREE.Object3D, key: string): void {
  root.userData.cacheKey = key;
  root.traverse((child) => {
    child.userData.sharedGeometry = true;
    delete child.userData.ownedTexture;
    for (const material of materialsOf(child)) {
      if (!material) continue;
      material.userData = { ...material.userData, shared: true };
    }
  });
}

function cloneOf(template: THREE.Object3D): THREE.Object3D {
  const copy = template.clone(true);
  tagShared(copy, String(template.userData.cacheKey ?? ''));
  return copy;
}

export class ObjectTemplateCache {
  private entries = new Map<string, CacheEntry>();
  private generation = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  /**
   * Start a sync. Entries are considered stale until `obtain()` touches them;
   * `end()` evicts whatever the sync did not ask for.
   */
  begin(): void {
    this.generation += 1;
  }

  /**
   * Get the object for `key`, rebuilding only when the signature moved.
   *
   * `signature` must cover everything the builder reads. Keep it short: it is
   * compared by string equality on every sync, and a missing field shows up as
   * a stale object rather than an error.
   */
  obtain(key: string, signature: string, build: () => THREE.Object3D): THREE.Object3D {
    const entry = this.entries.get(key);
    if (entry && entry.signature === signature) {
      entry.used = this.generation;
      this.hits += 1;
      return cloneOf(entry.template);
    }
    if (entry) {
      this.entries.delete(key);
      disposeOwned(entry.owned);
    }

    const built = build();
    this.misses += 1;
    // Keep a pristine copy: the renderer mutates the object it receives. The key
    // rides on the template so every clone can identify its own furniture.
    const template = built.clone(true);
    template.userData.cacheKey = key;
    this.entries.set(key, {
      signature,
      template,
      owned: collectOwned(built),
      used: this.generation,
    });
    tagShared(built, key);
    return built;
  }

  /** Evict and dispose every template the current sync did not ask for. */
  end(): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.used === this.generation) continue;
      this.entries.delete(key);
      disposeOwned(entry.owned);
      this.evictions += 1;
    }
  }

  /** Drop everything (new game, scene teardown). */
  clear(): void {
    for (const entry of this.entries.values()) disposeOwned(entry.owned);
    this.entries.clear();
  }

  stats(): ObjectCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
    };
  }

  /** Reset the counters without touching the cache (probe / profiling seam). */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}
