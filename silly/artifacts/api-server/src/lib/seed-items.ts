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
