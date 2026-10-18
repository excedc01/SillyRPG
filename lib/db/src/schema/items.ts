import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const itemTypes = ["Weapons", "Armors", "ClassOrb"] as const;
export const itemTypeEnum = pgEnum("item_type", itemTypes);

export const itemStatsSchema = z
  .object({
    hp: z.number().int().optional(),
    mp: z.number().int().optional(),
    atk: z.number().int().optional(),
    def: z.number().int().optional(),
    crit_rate: z.number().optional(),
  })
  .passthrough();

export type ItemStats = z.infer<typeof itemStatsSchema>;

export const itemsTable = pgTable(
  "items",
  {
    itemId: text("item_id").primaryKey(),
    name: text("name").notNull(),
    type: itemTypeEnum("type").notNull(),
    tier: integer("tier").notNull(),
    rarity: text("rarity").notNull(),
    stats: jsonb("stats").$type<ItemStats>().notNull(),
    passiveOrEffect: text("passive_or_effect"),
  },
  (table) => [
    check("items_tier_range", sql`${table.tier} BETWEEN 0 AND 4`),
  ],
);

export const insertItemSchema = createInsertSchema(itemsTable, {
  tier: z.number().int().min(0).max(4),
  stats: itemStatsSchema,
});

export const itemCatalogImportSchema = z
  .object({
    item_id: z.string(),
    name: z.string(),
    type: z.enum(itemTypes),
    tier: z.number().int().min(0).max(4),
    rarity: z.string(),
    stats: itemStatsSchema,
    passive_or_effect: z.string().optional(),
  })
  .passthrough();

export type Item = typeof itemsTable.$inferSelect;
export type InsertItem = typeof itemsTable.$inferInsert;
