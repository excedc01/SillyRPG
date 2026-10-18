import type { ItemDrop, ItemStats, ItemType } from "@workspace/db";

export type Rng = () => number;

// ---------------------------------------------------------------------------
// Class Orb: drop rarissimo in generale.
//
// Le probabilità scritte in biomes.json vengono moltiplicate per
// CLASS_ORB_DROP_MULTIPLIER e poi limitate a CLASS_ORB_MAX_DROP_CHANCE, così
// nessuna orb può superare il 3% a uccisione anche se i dati dicono di più
// (es. 0.25). Per renderle ancora più rare basta abbassare queste due costanti.
// ---------------------------------------------------------------------------
export const CLASS_ORB_DROP_MULTIPLIER = 0.2;
export const CLASS_ORB_MAX_DROP_CHANCE = 0.03;

export const CRIT_MULTIPLIER = 1.5;
export const MAX_CRIT_RATE = 0.75;
export const DEATH_COIN_PENALTY = 5;
export const FLEE_CHANCE = 0.6;
export const BOSS_FLEE_CHANCE = 0.3;

export function xpForNextLevel(level: number): number {
  return (level + 1) * 35;
}

export function effectiveDropChance(type: ItemType, baseChance: number): number {
  const chance = Math.min(1, Math.max(0, baseChance));
  if (type === "ClassOrb") {
    return Math.min(chance * CLASS_ORB_DROP_MULTIPLIER, CLASS_ORB_MAX_DROP_CHANCE);
  }
  return chance;
}

/**
 * Tira i dadi per la drop table di un nemico.
 * - Gli oggetti che non esistono nel catalogo vengono ignorati.
 * - Le Class Orb sono uniche: una già posseduta non cade più, e da una
 *   singola uccisione può cadere al massimo una orb.
 */
export function rollDrops(
  table: readonly ItemDrop[],
  catalog: ReadonlyMap<string, { type: ItemType }>,
  ownedOrbIds: ReadonlySet<string>,
  rng: Rng = Math.random,
): string[] {
  const dropped: string[] = [];
  let orbDropped = false;
  for (const entry of table) {
    const item = catalog.get(entry.itemId);
    if (!item) continue;
    const isOrb = item.type === "ClassOrb";
    if (isOrb && (orbDropped || ownedOrbIds.has(entry.itemId))) continue;
    if (rng() < effectiveDropChance(item.type, entry.chance)) {
      dropped.push(entry.itemId);
      if (isOrb) orbDropped = true;
    }
  }
  return dropped;
}

export type GearBonus = { atk: number; def: number; hp: number; critRate: number };

export function sumGearBonus(items: ReadonlyArray<{ stats: ItemStats }>): GearBonus {
  const bonus: GearBonus = { atk: 0, def: 0, hp: 0, critRate: 0 };
  for (const { stats } of items) {
    bonus.atk += stats.atk ?? 0;
    bonus.def += stats.def ?? 0;
    bonus.hp += stats.hp ?? 0;
    bonus.critRate += stats.crit_rate ?? 0;
  }
  return bonus;
}

export type EffectiveStats = {
  attack: number;
  defense: number;
  maxHp: number;
  critRate: number;
};

export function effectiveStats(
  base: { attack: number; defense: number; maxHp: number },
  bonus: GearBonus,
): EffectiveStats {
  return {
    attack: Math.max(1, base.attack + bonus.atk),
    defense: Math.max(0, base.defense + bonus.def),
    maxHp: Math.max(1, base.maxHp + bonus.hp),
    critRate: Math.min(MAX_CRIT_RATE, Math.max(0, bonus.critRate)),
  };
}

/** Monete ottenute: i dati dei mostri non le definiscono, le ricaviamo dagli XP. */
export function coinReward(xpReward: number, isBoss: boolean, rng: Rng = Math.random): number {
  const low = isBoss ? 1.5 : 0.4;
  const high = isBoss ? 2.5 : 0.8;
  return Math.max(1, Math.round(xpReward * (low + rng() * (high - low))));
}

/** Una pozione cura il 35% dei PV massimi (minimo 15), così resta utile ai livelli alti. */
export function potionHeal(maxHp: number): number {
  return Math.max(15, Math.round(maxHp * 0.35));
}

export function potionPrice(level: number): number {
  return 15 + level * 2;
}
