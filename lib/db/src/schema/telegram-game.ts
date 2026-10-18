import { createInsertSchema } from "drizzle-zod";
import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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

export const telegramPlayersTable = pgTable("telegram_players", {
  telegramId: text("telegram_id").primaryKey(),
  username: text("username"),
  characterName: text("character_name").notNull(),
  archetype: text("archetype").notNull(),
  level: integer("level").notNull().default(1),
  xp: integer("xp").notNull().default(0),
  hp: integer("hp").notNull(),
  maxHp: integer("max_hp").notNull(),
  attack: integer("attack").notNull(),
  defense: integer("defense").notNull(),
  potions: integer("potions").notNull().default(2),
  coins: integer("coins").notNull().default(0),
  location: text("location").notNull().default("bosco"),
  combat: jsonb("combat").$type<CombatState | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
