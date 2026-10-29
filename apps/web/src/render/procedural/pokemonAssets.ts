import * as THREE from 'three';

/**
 * Pokémon Splender asset library.
 *
 * Loads the card artwork, Poké Ball token sprites and card backs imported
 * from Ethan9123/pokemon-splendor (mounted under /public/pokemon).
 * Textures are cached per URL; card back gets a deterministic fallback so
 * the board still renders before images finish loading.
 */

const textureCache = new Map<string, THREE.Texture>();

export interface PkmnCardArt {
  id: string;
  name: string;
  img: string;
}

function loader(): THREE.TextureLoader {
  return new THREE.TextureLoader();
}

export function loadTexture(url: string): THREE.Texture {
  const cached = textureCache.get(url);
  if (cached) return cached;
  const tex = loader().load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textureCache.set(url, tex);
  return tex;
}

export function cardArtUrl(custom?: Record<string, unknown>): string | null {
  const id = custom?.pkmnId;
  if (typeof id !== 'string') return null;
  return PKMN_BY_ID[id]?.img ?? null;
}

/** Texture for a market card face; null falls back to procedural painting. */
export function pokemonCardTexture(custom?: Record<string, unknown>): THREE.Texture | null {
  const url = cardArtUrl(custom);
  return url ? loadTexture(url) : null;
}

export function pokemonCardBackTexture(custom?: Record<string, unknown>): THREE.Texture | null {
  const tier = String(custom?.pkmnTier ?? '');
  const url = PKMN_BACK_BY_TIER[tier];
  return url ? loadTexture(url) : null;
}

export function pokeBallTexture(color: string): THREE.Texture | null {
  const url = PKMN_BALL_URLS[color];
  return url ? loadTexture(url) : null;
}

/* ---------------------------- imported manifest --------------------------- */

import deckJson from '@rds/games/splendor/pokemonData.json';
import { PKMN_BALL_IMAGE, PKMN_CARD_BACK } from '@rds/games/splendor/setup';

export const PKMN_BY_ID: Record<string, { img: string; name: string }> = {};
[
  ...deckJson.cards,
  ...deckJson.megas,
  ...deckJson.pokemart
].forEach(card => {
  PKMN_BY_ID[card.id] = { img: card.img, name: card.name };
});

const PKMN_BACK_BY_TIER: Record<string, string> = PKMN_CARD_BACK;
const PKMN_BALL_URLS: Record<string, string> = PKMN_BALL_IMAGE;
