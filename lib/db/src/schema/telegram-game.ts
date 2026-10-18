import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { itemsTable } from "./items";

export type CombatState = {
  name: string;
  hp: number;
  maxHp: number;
  attack: number;
  xpReward: number;
  coinReward: number;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: Array<
    Array<{ text: string; callback_data: string }>
  >;
};

export const telegramPlayersTable = pgTable(
  "telegram_players",
  {
    telegramId: text("telegram_id").notNull(),
    chatId: text("chat_id").notNull(),
    username: text("username"),
    characterName: text("character_name").notNull(),
    archetype: text("archetype").notNull().default("Nessuna"),
    level: integer("level").notNull().default(0),
    xp: integer("xp").notNull().default(0),
    hp: integer("hp").notNull().default(20),
    maxHp: integer("max_hp").notNull().default(20),
    attack: integer("attack").notNull().default(4),
    defense: integer("defense").notNull().default(1),
    potions: integer("potions").notNull().default(2),
    coins: integer("coins").notNull().default(10),
    biomeId: integer("biome_id").notNull().default(1),
    combat: jsonb("combat").$type<CombatState | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.telegramId, table.chatId] }),
  ],
);

export const telegramPlayerInventoryTable = pgTable(
  "telegram_player_inventory",
  {
    telegramId: text("telegram_id").notNull(),
    chatId: text("chat_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => itemsTable.itemId, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.telegramId, table.chatId, table.itemId],
    }),
    foreignKey({
      name: "telegram_player_inventory_player_fk",
      columns: [table.telegramId, table.chatId],
      foreignColumns: [
        telegramPlayersTable.telegramId,
        telegramPlayersTable.chatId,
      ],
    }).onDelete("cascade"),
    check(
      "telegram_player_inventory_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
  ],
);

export const insertTelegramPlayerInventorySchema = createInsertSchema(
  telegramPlayerInventoryTable,
).omit({ acquiredAt: true });

export type TelegramPlayerInventoryItem =
  typeof telegramPlayerInventoryTable.$inferSelect;
export type InsertTelegramPlayerInventory =
  typeof telegramPlayerInventoryTable.$inferInsert;

export const insertTelegramPlayerSchema = createInsertSchema(
  telegramPlayersTable,
).omit({ createdAt: true, updatedAt: true });

export type InsertTelegramPlayer = typeof telegramPlayersTable.$inferInsert;
export type TelegramPlayer = typeof telegramPlayersTable.$inferSelect;

export const telegramUpdatesTable = pgTable("telegram_game_updates", {
  updateId: integer("update_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const telegramOutboxTable = pgTable("telegram_game_outbox", {
  id: serial("id").primaryKey(),
  updateId: integer("update_id").notNull().unique(),
  chatId: text("chat_id").notNull(),
  callbackQueryId: text("callback_query_id"),
  text: text("text").notNull(),
  replyMarkup: jsonb("reply_markup").$type<InlineKeyboardMarkup | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export type TelegramOutboxMessage = typeof telegramOutboxTable.$inferSelect;
