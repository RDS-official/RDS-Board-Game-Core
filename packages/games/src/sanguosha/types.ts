import type { EntityId, PlayerId } from '@rds/kernel/types';

/** Table rules supported by the fixture. */
export type SanguoshaMode = 'identity' | 'team' | 'kill_next';

/** Role tokens. Identity mode uses the classic four; the other modes are public. */
export type SgsRole = 'LORD' | 'LOYALIST' | 'REBEL' | 'SPY' | 'TEAM_A' | 'TEAM_B' | 'KILL_NEXT';

/** One seat's table assignment, persisted in `globalVars.seats`. */
export interface SgsSeatAssignment {
  playerId: PlayerId;
  isAi: boolean;
  aiTier?: 'beginner' | 'intermediate' | 'advanced';
}

/** Card taxonomy used by the Sanguosha fixture. */
export type SgsCardCategory = 'BASIC' | 'TRICK' | 'DELAYED' | 'EQUIP';

export type SgsCardSubtype =
  | 'STRIKE'
  | 'DODGE'
  | 'PEACH'
  | 'WINE'
  | 'DISMANTLE'
  | 'SNATCH'
  | 'DUEL'
  | 'BORROW_SWORD'
  | 'EX_NIHILO'
  | 'NULLIFY'
  | 'BARBARIAN'
  | 'ARROW'
  | 'PEACH_GARDEN'
  | 'HARVEST'
  | 'IRON_CHAIN'
  | 'FIRE_ATTACK'
  | 'INDULGENCE'
  | 'LIGHTNING'
  | 'SUPPLY_SHORTAGE'
  | 'WEAPON'
  | 'ARMOR'
  | 'HORSE_PLUS'
  | 'HORSE_MINUS'
  | 'TREASURE';

export type SgsElement = 'NORMAL' | 'FIRE' | 'THUNDER';

export interface SgsCardMeta {
  code: string;
  zh: string;
  en: string;
  category: SgsCardCategory;
  subtype: SgsCardSubtype;
  desc: string;
  /** Equipment slot. Only present for equipment cards. */
  equipSlot?: 'WEAPON' | 'ARMOR' | 'HORSE_PLUS' | 'HORSE_MINUS' | 'TREASURE';
  /** Weapon attack range. */
  range?: number;
  element?: SgsElement;
  /** Armor/weapon hook implementation id, when the card has one. */
  hookId?: string;
}

/** Data carried by `entity.components.custom` on a card. */
export interface SgsCardCustom {
  code: string;
  category: SgsCardCategory;
  subtype: SgsCardSubtype;
  zh: string;
  en: string;
  desc: string;
  /** Unique physical-card label for action buttons (serial suffix included). */
  actionLabel?: string;
  suit: string;
  rank: number;
  color: string;
  element?: SgsElement;
  equipSlot?: string;
  range?: number;
  hookId?: string;
}

/** Player state carried in `player.customProps`. */
export interface SgsPlayerProps {
  hp: number;
  maxHp: number;
  /** Persistent table points (awarded once at the final whistle). */
  points?: number;
  heroId: string;
  heroName: string;
  kingdom: 'WEI' | 'SHU' | 'WU' | 'QUN';
  gender: 'MALE' | 'FEMALE';
  skills: string[];
  skillNames: string[];
  /** Skills printed on the hero that are lord-only. */
  lordSkills?: string[];
  chained?: boolean;
  skipPlay?: boolean;
  skipDraw?: boolean;
  wineBonus?: number;
  wineUsed?: boolean;
  rendeGiven?: number;
  rendeHealed?: boolean;
  zhihengUsed?: boolean;
  kurouUsed?: boolean;
  qingnangUsed?: boolean;
  jieyinUsed?: boolean;
  lijianUsed?: boolean;
  strikesUsed?: number;
  roleRevealed?: boolean;
  dying?: boolean;
  [key: string]: unknown;
}

/** One physical card before it is turned into an ECS entity. */
export interface SgsCardSeed {
  code: string;
  suit: string;
  rank: number;
}

/** Pending trick resolution, kept serializable in `globalVars.pendingTrick`. */
export interface SgsPendingTrick {
  kind: SgsCardSubtype;
  cardId: EntityId;
  sourceId: PlayerId;
  targetIds: PlayerId[];
  targetIndex: number;
  /** `jiedao`: the victim the weapon owner must strike. */
  victimId?: PlayerId;
  /** `huogong`: the revealed hand card. */
  revealedCardId?: EntityId;
  /** The pending delayed trick is being judged, not used from hand. */
  judgeMode?: boolean;
  wuxieCount: number;
}

/** Context of an unresolved Strike. */
export interface SgsStrikeContext {
  sourceId: PlayerId;
  targetId: PlayerId;
  cardId: EntityId;
  element: SgsElement;
  amount: number;
  dodgesNeeded: number;
  dodgesPlayed: number;
  noDodge: boolean;
  armorIgnored: boolean;
  /** The target already spent this Strike's Bagua judgement. */
  baguaUsed?: boolean;
  /** The source already used Green Dragon Crescent Blade on this Strike. */
  qinglongUsed?: boolean;
  /** Cards played as the Strike (two cards for Zhangba, etc.). */
  cardIds: EntityId[];
}

/** Context of a Duel response chain. */
export interface SgsDuelContext {
  sourceId: PlayerId;
  targetId: PlayerId;
  responder: PlayerId;
  opponent: PlayerId;
  strikesNeeded: number;
  strikesPlayed: number;
}

/** Context of a mass trick (Barbarian Invasion / Arrow Barrage). */
export interface SgsMassTrickContext {
  kind: 'BARBARIAN' | 'ARROW';
  cardId: EntityId;
  sourceId: PlayerId;
  targetIds: PlayerId[];
  targetIndex: number;
}

/** One Strike queued by Fangtian Halberd across multiple targets. */
export interface SgsStrikeQueue {
  sourceId: PlayerId;
  cardId: EntityId;
  cardIds: EntityId[];
  element: 'NORMAL' | 'FIRE' | 'THUNDER';
  targets: PlayerId[];
  index: number;
  /** Wine bonus captured when the original Strike was used. */
  bonus: number;
}

export interface SgsPendingChoiceOption {
  id: string;
  label: string;
  cardId?: EntityId;
  zone?: 'HAND' | 'EQUIP' | 'JUDGE';
}

/** A player-owned pending choice, resolved through a single-participant DecisionWindow. */
export interface SgsPendingChoice {
  id: string;
  playerId: PlayerId;
  kind: 'DISMANTLE_PICK' | 'HARVEST_PICK' | 'FIRE_ATTACK_PICK';
  sourceId: PlayerId;
  targetId: PlayerId;
  snatch?: boolean;
  options: SgsPendingChoiceOption[];
  /** Harvest: remaining target seats in settlement order. */
  targetIds?: PlayerId[];
  targetIndex?: number;
  /** Harvest/Fire Attack: cards currently revealed in the processing area. */
  revealedCardIds?: EntityId[];
  revealedCardId?: EntityId;
}

/** Context of a dying-rescue window. */
export interface SgsDyingContext {
  victimId: PlayerId;
  sourceId: PlayerId | null;
  killerId: PlayerId | null;
  cardId?: EntityId;
  reason: string;
}
