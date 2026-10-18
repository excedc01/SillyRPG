import { db, itemCatalogImportSchema, itemsTable, telegramPlayerEquipmentTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import extraItems from "../data/items-extra.json";
import { logger } from "./logger";

// Inserts the extra catalog items if they are missing. onConflictDoNothing:
// never overwrites items already present in the database.
export async function seedExtraItems(): Promise<void> {
  const parsed = itemCatalogImportSchema.array().parse(extraItems);
  const inserted = await db
    .insert(itemsTable)
    .values(
      parsed.map((item) => ({
        itemId: item.item_id,
        name: item.name,
        type: item.type,
        tier: item.tier,
        rarity: item.rarity,
        stats: item.stats,
        passiveOrEffect: item.passive_or_effect ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ itemId: itemsTable.itemId });
  // Repair legacy Class Orb catalog rows in-place: old database rows are not overwritten by the seed insert.
  const classOrbs = await db.select({ itemId: itemsTable.itemId, name: itemsTable.name, stats: itemsTable.stats })
    .from(itemsTable).where(eq(itemsTable.type, "ClassOrb"));
  const classByName: Array<[RegExp, string]> = [
    [/warrior|fighter|red orb/i, "warrior"], [/explorer|ranger|archer|green orb/i, "explorer"],
    [/necromancer|necro/i, "necromancer"], [/abyssal/i, "abyssal"], [/arcanist|mage|blue orb/i, "arcanist"], [/duelist/i, "duelist"],
    [/warden/i, "warden"], [/bloodweaver/i, "bloodweaver"], [/stormcaller/i, "stormcaller"],
    [/voidstalker/i, "voidstalker"], [/phoenixborn|phoenix/i, "phoenixborn"],
  ];
  for (const orb of classOrbs) {
    const stats = (orb.stats && typeof orb.stats === "object" ? orb.stats : {}) as Record<string, unknown>;
    const current = typeof stats.class_id === "string" ? stats.class_id : "";
    const match = classByName.find(([pattern]) => pattern.test(orb.name));
    // Abyssal Orbs were previously mapped to Arcanist; repair that legacy mapping.
    if (current === "abyssal" || (["warrior", "explorer", "arcanist", "duelist", "warden", "bloodweaver", "stormcaller", "voidstalker", "phoenixborn", "seraphim", "necromancer"].includes(current) && !/abyssal/i.test(orb.name))) continue;
    if (match) await db.update(itemsTable).set({ stats: { ...stats, class_id: match[1] } }).where(eq(itemsTable.itemId, orb.itemId));
  }
  // Migrate legacy shields to the dedicated Off-Hand category without touching inventory quantities.
  const shields = await db.select({ itemId: itemsTable.itemId }).from(itemsTable)
    .where(sql`lower(${itemsTable.name}) LIKE '%shield%' AND ${itemsTable.type} = 'Armors'`);
  if (shields.length) {
    const shieldIds = shields.map((item) => item.itemId);
    await db.update(itemsTable).set({ type: "Off-Hand" }).where(inArray(itemsTable.itemId, shieldIds));
    await db.update(telegramPlayerEquipmentTable).set({ slot: "off-hand" }).where(and(eq(telegramPlayerEquipmentTable.slot, "armor"), inArray(telegramPlayerEquipmentTable.itemId, shieldIds)));
  }
  logger.info({ added: inserted.length, migratedShields: shields.length }, "Extra item catalog synced");
}
