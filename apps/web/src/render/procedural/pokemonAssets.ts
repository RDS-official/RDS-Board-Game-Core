import * as THREE from 'three';
import deckJson from '@rds/games/splendor/pokemonData.json';
import { MASTER_BALL, PKMN_BALL_IMAGE, PKMN_CARD_BACK, POKEBALL_COLORS } from '@rds/games/splendor/setup';

/**
 * Pokémon Splendor asset library.
 *
 * Loads the card artwork, Poké Ball token sprites and card backs imported
 * from Ethan9123/pokemon-splendor (mounted under /public/pokemon).
 *
 * Every texture is cached per URL and walked through a small load-state
 * machine (`pending` → `loaded` | `failed`) so the renderer can:
 *   · keep painting procedural art while the network is still busy,
 *   · fall back to that procedural art when an asset is missing or corrupt,
 *   · repaint once when the artwork has settled (`onTexturesReady`).
 *
 * A broken asset never throws: it logs a warning, is dropped from the cache
 * and resolves to `null`, which is the "use the procedural fallback" signal
 * the callers already understand. Textures are handed out while still in
 * flight, so a load that fails *after* a material took the texture only clears
 * up on the next rebuild — that is what the `onTexturesReady` repaint is for.
 */

/**
 * Aspect ratio (width / height) of the 1.35 × 2.0 splendor card cell.
 *
 * Imported artwork is not drawn at that ratio: card faces are 560 × 747
 * (0.7497), poké-mart cards ~0.645 and card backs 180 × 240 (0.75). Textures
 * are letterboxed rather than stretched across the quad.
 */
export const PKMN_CARD_ASPECT = 1.35 / 2;

/** Aspect drift below this is not worth a UV correction. */
const ASPECT_TOLERANCE = 0.02;

export type TextureLoadState = 'pending' | 'loaded' | 'failed';

export interface PokemonTextureStats {
  /** Unique artwork URLs requested so far. */
  total: number;
  /** Loads still in flight. */
  pending: number;
  /** Loads that produced a usable texture. */
  loaded: number;
  /** Loads that failed and left the caller on procedural art. */
  failed: number;
  /** Sorted list of failed URLs, for a HUD readout or debugging. */
  failedUrls: string[];
  /** True once the first load batch has drained (see `onTexturesReady`). */
  ready: boolean;
}

interface TextureEntry {
  /** Handed out by `loadTexture`; null once the load failed. */
  texture: THREE.Texture | null;
  state: TextureLoadState;
  /** Target quad ratio for `fitTextureToAspect`, when the caller asked for one. */
  aspect: number | null;
  /** One-shot notification hooks (attach the bitmap to a material, …). */
  onLoaded: Set<(texture: THREE.Texture) => void>;
  /** Promise bridges waiting for this load to settle. */
  settle: Array<(texture: THREE.Texture | null) => void>;
}

export interface LoadTextureOptions {
  /**
   * Target quad aspect (width / height). The decoded bitmap is letterboxed to
   * this ratio with repeat/offset. First value wins for a shared URL; a later
   * caller with a different ratio gets its own correction applied on top.
   */
  aspect?: number;
  /** Runs once the bitmap is decoded, or synchronously when already cached. */
  onLoaded?: (texture: THREE.Texture) => void;
}

const entries = new Map<string, TextureEntry>();
const readyListeners = new Set<() => void>();
let readyLatched = false;
let readyCheckScheduled = false;

/**
 * One image loader for the whole module. `TextureLoader` is deliberately not
 * used: it builds its own `Texture` internally and hands *that* to `onLoad`,
 * which would leave the texture we cache here without a bitmap.
 */
const imageLoader = new THREE.ImageLoader();

/* ----------------------------- load state -------------------------------- */

/** Pending / loaded / failed bookkeeping for the whole asset set. */
export function getTextureStats(): PokemonTextureStats {
  let pending = 0;
  let loaded = 0;
  const failedUrls: string[] = [];
  for (const [url, entry] of entries) {
    if (entry.state === 'pending') pending++;
    else if (entry.state === 'loaded') loaded++;
    else failedUrls.push(url);
  }
  return {
    total: entries.size,
    pending,
    loaded,
    failed: failedUrls.length,
    failedUrls: failedUrls.sort(),
    ready: readyLatched
  };
}

/** True once the first batch of requested artwork has finished (loaded or failed). */
export function isTexturesReady(): boolean {
  return readyLatched;
}

/**
 * Run `callback` once, as soon as every texture requested so far has settled.
 *
 * The renderer uses this to rebuild the board a single time instead of polling
 * per frame — which also swaps any texture that turned out to be broken for the
 * procedural fallback. If the batch has already settled, the callback is
 * invoked on the next microtask. Returns an unsubscribe function (a no-op once
 * latched).
 */
export function onTexturesReady(callback: () => void): () => void {
  if (readyLatched) {
    queueMicrotask(() => invokeReadyListener(callback));
    return () => {};
  }
  readyListeners.add(callback);
  return () => {
    readyListeners.delete(callback);
  };
}

/** Promise flavour of `onTexturesReady`, handy for tests and awaits. */
export function whenTexturesReady(): Promise<void> {
  return new Promise<void>(resolve => {
    onTexturesReady(resolve);
  });
}

function invokeReadyListener(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    console.warn('[pokemonAssets] onTexturesReady listener threw', error);
  }
}

function scheduleReadyCheck(): void {
  if (readyLatched || readyCheckScheduled) return;
  readyCheckScheduled = true;
  // Coalesce into one microtask so a burst of synchronous requests (the render
  // layer asks for a whole market row at once) is counted as a single batch.
  queueMicrotask(() => {
    readyCheckScheduled = false;
    if (readyLatched || entries.size === 0) return;
    for (const entry of entries.values()) {
      if (entry.state === 'pending') return;
    }
    readyLatched = true;
    const listeners = [...readyListeners];
    readyListeners.clear();
    listeners.forEach(invokeReadyListener);
  });
}

function flushSettle(entry: TextureEntry, texture: THREE.Texture | null): void {
  const waiters = entry.settle;
  entry.settle = [];
  waiters.forEach(resolve => { resolve(texture); });
}

/* ------------------------------- loading --------------------------------- */

/**
 * Load (or reuse) a texture by URL.
 *
 * Returns the texture immediately so the material can reference it while the
 * bitmap is still in flight — three uploads it on the first frame after decode,
 * no repaint needed. Returns `null` when the URL is known to be broken, so
 * callers keep their procedural fallback instead of rendering a blank card.
 *
 * Options:
 *   · `aspect`   — letterbox the bitmap to this quad ratio (default: none).
 *   · `onLoaded` — run after decode; also runs synchronously when cached.
 */
export function loadTexture(url: string, options: LoadTextureOptions = {}): THREE.Texture | null {
  const { aspect, onLoaded } = options;
  const existing = entries.get(url);
  if (existing) {
    if (existing.state === 'failed' || !existing.texture) return null;
    if (aspect !== undefined && existing.aspect === null && existing.state === 'pending') {
      existing.aspect = aspect;
    }
    // A second caller may want a different ratio than the one baked in at decode
    // time (rare: the same art shown at another scale). Re-fit on its behalf.
    if (aspect !== undefined && existing.state === 'loaded' && existing.aspect !== aspect) {
      fitTextureToAspect(existing.texture, aspect);
      existing.aspect = aspect;
    }
    if (existing.state === 'loaded') onLoaded?.(existing.texture);
    else if (onLoaded) existing.onLoaded.add(onLoaded);
    return existing.texture;
  }

  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const entry: TextureEntry = {
    texture,
    state: 'pending',
    aspect: aspect ?? null,
    onLoaded: new Set(onLoaded ? [onLoaded] : []),
    settle: []
  };
  entries.set(url, entry);

  const fail = (error: unknown): void => {
    console.warn(`[pokemonAssets] texture failed to load, using procedural fallback: ${url}`, error);
    entry.state = 'failed';
    entry.texture = null;
    entry.onLoaded.clear();
    flushSettle(entry, null);
    scheduleReadyCheck();
  };

  try {
    imageLoader.load(
      url,
      image => {
        texture.image = image;
        entry.state = 'loaded';
        // Aspect fitting runs first so the material hook installed by the caller
        // sees a fully configured texture.
        if (entry.aspect !== null) fitTextureToAspect(texture, entry.aspect);
        // Bumping `needsUpdate` is what makes three upload the bitmap; doing it
        // only here keeps an unresolved texture at version 0, so three binds its
        // placeholder silently instead of warning on every frame.
        texture.needsUpdate = true;
        const hooks = [...entry.onLoaded];
        entry.onLoaded.clear();
        hooks.forEach(hook => {
          try {
            hook(texture);
          } catch (error) {
            console.warn(`[pokemonAssets] texture post-process failed for ${url}`, error);
          }
        });
        flushSettle(entry, texture);
        scheduleReadyCheck();
      },
      undefined,
      fail
    );
  } catch (error) {
    // A synchronous throw from the loader must never escape into the render pass.
    fail(error);
    return null;
  }

  return texture;
}

/** Promise wrapper that resolves with the texture, or null when it failed. */
function loadTextureSettled(
  url: string,
  options: LoadTextureOptions = {}
): Promise<THREE.Texture | null> {
  const texture = loadTexture(url, options);
  if (!texture) return Promise.resolve(null);
  const entry = entries.get(url);
  if (!entry || entry.state !== 'pending') return Promise.resolve(texture);
  return new Promise<THREE.Texture | null>(resolve => {
    entry.settle.push(resolve);
  });
}

/**
 * Pre-warm the artwork the market board needs, so the first frame that shows a
 * deck back or a Poké Ball does not flash procedurally-drawn art.
 *
 * Defaults to the card backs used by the market/deck rows plus the six Poké
 * Ball token sprites. Pass explicit URLs to warm a different set (card faces,
 * for instance). Never rejects: failed loads are counted in the returned stats.
 */
export function preloadPokemonAssets(urls?: string[]): Promise<PokemonTextureStats> {
  const requested = urls && urls.length > 0 ? urls : DEFAULT_PRELOAD_URLS;
  const unique: string[] = [];
  const seen = new Set<string>();
  requested.forEach(url => {
    if (typeof url === 'string' && url.length > 0 && !seen.has(url)) {
      seen.add(url);
      unique.push(url);
    }
  });

  const tasks = unique.map(url =>
    loadTextureSettled(url, isCardArtworkUrl(url) ? { aspect: PKMN_CARD_ASPECT } : {})
  );
  // allSettled semantics: one dead image must not abort the rest of the batch.
  return Promise.all(tasks).then(() => getTextureStats());
}

/** Balls are sphere maps and must not be letterboxed; cards and backs are. */
function isCardArtworkUrl(url: string): boolean {
  return url.includes('/pokemon/cards/') || url.includes('/pokemon/backs/');
}

/* --------------------------- aspect correction ---------------------------- */

/**
 * Letterbox `texture` inside a quad of `targetAspect` using repeat/offset.
 *
 * Stretching a 0.7497 artwork across the 1.35 × 2.0 board cell (0.675) squashes
 * the Pokémon by ~11 %; scaling the UV window instead keeps the artwork's own
 * proportions. The window is grown past [0, 1] and the texture is clamped to
 * edge, so the leftover band repeats the outermost texel row/column (the
 * artwork's own frame colour) and nothing is cropped away — important because
 * the cost panel sits flush against the left edge of these cards.
 *
 * Returns true when a correction was applied.
 */
export function fitTextureToAspect(
  texture: THREE.Texture,
  targetAspect: number = PKMN_CARD_ASPECT,
  tolerance: number = ASPECT_TOLERANCE
): boolean {
  texture.center.set(0, 0);

  const image = texture.image as
    | { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
    | null
    | undefined;
  const width = Number(image?.naturalWidth ?? image?.width ?? 0);
  const height = Number(image?.naturalHeight ?? image?.height ?? 0);

  const reset = (): false => {
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
    return false;
  };

  if (!(width > 0) || !(height > 0) || !(targetAspect > 0)) return reset();

  // > 1 when the artwork is relatively wider than the cell.
  const ratio = width / height / targetAspect;
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) <= tolerance) return reset();

  // Padding stretches the sampled window outside the bitmap, so the edges must
  // clamp instead of wrapping around to the opposite side of the artwork.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  if (ratio > 1) {
    // Wider artwork: full width visible, pad the top and bottom bands.
    texture.repeat.set(1, ratio);
    texture.offset.set(0, (1 - ratio) / 2);
  } else {
    // Narrower artwork: full height visible, pad the left and right bands.
    const inverse = 1 / ratio;
    texture.repeat.set(inverse, 1);
    texture.offset.set((1 - inverse) / 2, 0);
  }
  return true;
}

/* --------------------------- per-card lookups ----------------------------- */

export interface PkmnCardArt {
  id: string;
  name: string;
  img: string;
}

export function cardArtUrl(custom?: Record<string, unknown>): string | null {
  const id = custom?.pkmnId;
  if (typeof id !== 'string') return null;
  return PKMN_BY_ID[id]?.img ?? null;
}

/**
 * Texture for a market card face; null falls back to procedural painting.
 * `aspect` is the target quad ratio (defaults to the 1.35 × 2.0 board cell).
 */
export function pokemonCardTexture(
  custom?: Record<string, unknown>,
  aspect: number = PKMN_CARD_ASPECT
): THREE.Texture | null {
  const url = cardArtUrl(custom);
  return url ? loadTexture(url, { aspect }) : null;
}

/** Texture for a card back; null falls back to procedural painting. */
export function pokemonCardBackTexture(
  custom?: Record<string, unknown>,
  aspect: number = PKMN_CARD_ASPECT
): THREE.Texture | null {
  const tier = String(custom?.pkmnTier ?? '');
  const url = PKMN_BACK_BY_TIER[tier];
  return url ? loadTexture(url, { aspect }) : null;
}

/**
 * Texture for a Poké Ball token; null falls back to the procedural gem chip.
 *
 * `color` accepts the six canonical balls, common master-ball spellings
 * (`master`, `masterBall`, `mb`, `violet`, …) and the deprecated gem aliases
 * (`ruby`, `sapphire`, `onyx`, …).
 */
export function pokeBallTexture(
  color: string | null | undefined,
  onLoaded?: (texture: THREE.Texture) => void
): THREE.Texture | null {
  const url = pokeBallUrl(color);
  return url ? loadTexture(url, { onLoaded }) : null;
}

/** Canonical ball colour for a loose colour/gem/glyph string, or null. */
export function resolveBallColor(color?: string | null): string | null {
  const key = String(color ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (!key) return null;
  if (BALL_URLS[key]) return key;
  const alias = BALL_ALIASES[key];
  return alias && BALL_URLS[alias] ? alias : null;
}

/** True for the master ball colour (the wildcard / legendary token). */
export function isMasterBall(color?: string | null): boolean {
  return resolveBallColor(color) === MASTER_BALL;
}

/** Absolute URL for a ball colour, tolerating a manifest without that key. */
function pokeBallUrl(color?: string | null): string | null {
  const canonical = resolveBallColor(color);
  if (!canonical) return null;
  return BALL_URLS[canonical] ?? `/pokemon/balls/${canonical}.png`;
}

/* ---------------------------- imported manifest --------------------------- */

export const PKMN_BY_ID: Record<string, { img: string; name: string }> = {};
[
  ...deckJson.cards,
  ...deckJson.megas,
  ...deckJson.pokemart
].forEach(card => {
  PKMN_BY_ID[card.id] = { img: card.img, name: card.name };
});

const PKMN_BACK_BY_TIER: Record<string, string> = PKMN_CARD_BACK;
const BALL_URLS: Record<string, string> = PKMN_BALL_IMAGE;

/** Master-ball spellings seen in hand-written card data / older fixtures. */
const BALL_ALIASES: Record<string, string> = {
  master: 'purple',
  masterball: 'purple',
  mb: 'purple',
  violet: 'purple',
  // Deprecated Splendor gem aliases: the classic five-colour vocabulary still
  // reaches the renderer, so those names must resolve onto a ball.
  ruby: 'red',
  sapphire: 'blue',
  onyx: 'black',
  diamond: 'pink',
  emerald: 'yellow',
  // `gold` is Splendor's joker; this fixture's wild substitute is the purple
  // master ball, so the joker must not turn into a yellow ball.
  gold: 'purple'
};

/**
 * Warm set: every deck back shown on the market board plus the six tokens.
 * Deduplicated in canonical order so the preload request is deterministic.
 */
const DEFAULT_PRELOAD_URLS: string[] = (() => {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (url?: string): void => {
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  };
  ['stage1', 'stage2', 'stage3', 'rare', 'legend', 'mega', 'pmL1', 'pmL2', 'pmL3'].forEach(tier => {
    push(PKMN_BACK_BY_TIER[tier]);
  });
  POKEBALL_COLORS.forEach(color => { push(BALL_URLS[color] ?? `/pokemon/balls/${color}.png`); });
  return urls;
})();

/** The default preload list (deck backs + Poké Balls), exposed for the HUD. */
export function pokemonPreloadUrls(): string[] {
  return [...DEFAULT_PRELOAD_URLS];
}
