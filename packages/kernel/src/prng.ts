/**
 * Deterministic Seeded Pseudo-Random Number Generator (PRNG)
 * Implements the Chance Node (c) in the universal game system G.
 * Purely functional: given (state, seed), transition is 100% bit-level deterministic.
 */

import { DiceSpec } from './types';

export class DeterministicPRNG {
  /**
   * Mulberry32 algorithm: fast, high quality 32-bit state generator
   */
  public static next(seed: number): { value: number; nextSeed: number } {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return { value, nextSeed: seed >>> 0 };
  }

  public static nextInt(seed: number, min: number, max: number): { value: number; nextSeed: number } {
    const { value, nextSeed } = this.next(seed);
    const intVal = Math.floor(value * (max - min + 1)) + min;
    return { value: intVal, nextSeed };
  }

  public static shuffle<T>(seed: number, array: readonly T[]): { result: T[]; nextSeed: number } {
    const copy = [...array];
    let currentSeed = seed;
    for (let i = copy.length - 1; i > 0; i--) {
      const { value, nextSeed } = this.nextInt(currentSeed, 0, i);
      currentSeed = nextSeed;
      const temp = copy[i];
      copy[i] = copy[value];
      copy[value] = temp;
    }
    return { result: copy, nextSeed: currentSeed };
  }

  public static rollDice(seed: number, count: number = 2, sides: number = 6): { rolls: number[]; sum: number; nextSeed: number } {
    const faces = Array.from({ length: sides }, (_, index) => index + 1);
    return this.rollFaces(seed, { count, faces });
  }

  /**
   * Roll dice with arbitrary face values (0/1/2, custom faces, etc.).
   * Every face is equally likely; the state transition stays deterministic.
   */
  public static rollFaces(
    seed: number,
    spec: DiceSpec
  ): { rolls: number[]; sum: number; nextSeed: number } {
    const faces = spec.faces.length > 0 ? spec.faces : [1];
    const count = Math.max(0, Math.floor(spec.count));
    const rolls: number[] = [];
    let currentSeed = seed;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const { value, nextSeed } = this.nextInt(currentSeed, 0, faces.length - 1);
      rolls.push(faces[value]);
      sum += faces[value];
      currentSeed = nextSeed;
    }
    return { rolls, sum, nextSeed: currentSeed };
  }
}
