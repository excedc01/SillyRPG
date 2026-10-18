import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  boolean,
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


export const telegramPlayerSettingsTable = pgTable("telegram_player_settings", {
  telegramId: text("telegram_id").primaryKey(),
  language: text("language").notNull().default("en"),
  selectedChatId: text("selected_chat_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ItemDrop = { itemId: string; chance: number };

export const equipmentSlots = ["weapon", "armor", "off-hand"] as const;
export type EquipmentSlot = (typeof equipmentSlots)[number];

export type CombatState = {
  mobId?: string;
  biomeId?: number;
  isBoss?: boolean;
  isShadowClone?: boolean;
  isShiny?: boolean;
  name: string;
  hp: number;
  maxHp: number;
  attack: number;
  xpReward: number;
  coinReward?: number;
  dropTable?: ItemDrop[];
  attackBuff?: number;
  defenseBuff?: number;
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
    archetype: text("archetype").notNull().default("Jobless"),
    classId: text("class_id"),
    level: integer("level").notNull().default(0),
    xp: integer("xp").notNull().default(0),
    hp: integer("hp").notNull().default(20),
    maxHp: integer("max_hp").notNull().default(20),
    attack: integer("attack").notNull().default(4),
    defense: integer("defense").notNull().default(1),
    potions: integer("potions").notNull().default(2),
    coins: integer("coins").notNull().default(10),
    rebirths: integer("rebirths").notNull().default(0),
    rCoins: integer("r_coins").notNull().default(0),
    biomeId: integer("biome_id").notNull().default(1),
    combat: jsonb("combat").$type<CombatState | null>(),
    explorationEvent: jsonb("exploration_event").$type<{ id: string; title: string; description: string; rarity: string; biomeId: number; offers?: Array<{ itemId: string; price: number }> } | null>(),
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
    inventoryId: serial("inventory_id").notNull().unique(),
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

export const telegramPlayerEquipmentTable = pgTable(
  "telegram_player_equipment",
  {
    telegramId: text("telegram_id").notNull(),
    chatId: text("chat_id").notNull(),
    slot: text("slot").$type<EquipmentSlot>().notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => itemsTable.itemId, { onDelete: "cascade" }),
    equippedAt: timestamp("equipped_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.telegramId, table.chatId, table.slot] }),
    foreignKey({
      name: "telegram_player_equipment_player_fk",
      columns: [table.telegramId, table.chatId],
      foreignColumns: [
        telegramPlayersTable.telegramId,
        telegramPlayersTable.chatId,
      ],
    }).onDelete("cascade"),
  ],
);

export type TelegramPlayerEquipment =
  typeof telegramPlayerEquipmentTable.$inferSelect;

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
  // null for messages produced by the lobby timer instead of a Telegram update.
  updateId: integer("update_id").unique(),
  chatId: text("chat_id").notNull(),
  callbackQueryId: text("callback_query_id"),
  // Telegram user the message is addressed to (null = broadcast, never auto-deleted).
  ownerId: text("owner_id"),
  // Telegram message_id once delivered; cleared when the message is deleted.
  messageId: integer("message_id"),
  // message_id of the player's own command message, deleted after the reply is sent.
  triggerMessageId: integer("trigger_message_id"),
  // Also delete this player's older private bot messages once this one is out
  // (used by shared lobby messages, which have no single owner).
  cleanupOwnerId: text("cleanup_owner_id"),
  // Shared boss/duel lobby message: "post" sends it, "edit" updates it in place.
  lobbyId: integer("lobby_id"),
  lobbyAction: text("lobby_action").$type<"post" | "edit">(),
  // Optional pop-up text shown when the pressed button is acknowledged.
  callbackText: text("callback_text"),
  text: text("text").notNull(),
  replyMarkup: jsonb("reply_markup").$type<InlineKeyboardMarkup | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export type TelegramOutboxMessage = typeof telegramOutboxTable.$inferSelect;


export type LobbyKind = "boss" | "duel" | "arena";
export type LobbyStatus = "open" | "active" | "finished";

export type LobbyMember = { telegramId: string; name: string; level: number };

export type Fighter = {
  telegramId: string;
  name: string;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  crit: number;
  doubleHitChance?: number;
  potions: number;
  potionsUsed: number;
  alive: boolean;
  fled: boolean;
  action: "attack" | "potion" | null;
  dealt: number;
  taken: number;
};

export type LobbyState = {
  members: LobbyMember[];
  fighters: Fighter[];
  boss: CombatState | null;
  log: string[];
};

// Co-op boss fights and duels: one row per lobby, from "open" (30s waiting
// room) through "active" (round-based fight) to "finished".
export const telegramLobbiesTable = pgTable("telegram_lobbies", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  kind: text("kind").$type<LobbyKind>().notNull(),
  status: text("status").$type<LobbyStatus>().notNull().default("open"),
  hostId: text("host_id").notNull(),
  regionId: integer("region_id"),
  round: integer("round").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  roundDeadline: timestamp("round_deadline", { withTimezone: true }),
  messageId: integer("message_id"),
  state: jsonb("state").$type<LobbyState>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TelegramLobby = typeof telegramLobbiesTable.$inferSelect;


export type CasinoGame = "coinflip" | "blackjack" | "slots";
export type CasinoSessionState = {
  phase: "choose" | "bet" | "join" | "host_bet" | "opponent_bet" | "blackjack";
  ownerName?: string;
  opponentName?: string;
  bet?: number;
  hostBet?: number;
  opponentBet?: number;
  deck?: number[];
  playerHand?: number[];
  dealerHand?: number[];
  doubled?: boolean;
};

// Temporary casino sessions are scoped to a chat and a player/lobby.
export const telegramCasinoSessionsTable = pgTable("telegram_casino_sessions", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  game: text("game").$type<CasinoGame>().notNull(),
  status: text("status").$type<"open" | "active" | "finished">().notNull().default("active"),
  ownerId: text("owner_id").notNull(),
  opponentId: text("opponent_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  state: jsonb("state").$type<CasinoSessionState>().notNull(),
  messageId: integer("message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type TelegramCasinoSession = typeof telegramCasinoSessionsTable.$inferSelect;

export type TradeOffer = { items: Record<string, number>; coins: number };
export type TelegramTradeState = {
  phase: "request" | "offer1" | "offer2" | "review" | "confirm";
  player1Id: string; player1Name: string; player2Id: string; player2Name: string;
  offer1: TradeOffer; offer2: TradeOffer; confirmed1?: boolean; confirmed2?: boolean;
};
export const telegramTradesTable = pgTable("telegram_trades", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  status: text("status").$type<"active" | "completed" | "cancelled">().notNull().default("active"),
  state: jsonb("state").$type<TelegramTradeState>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});


// Permanent companion pets, including pets stored in the player's Box.
export const telegramPetsTable = pgTable("telegram_pets", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  chatId: text("chat_id").notNull(),
  species: text("species").notNull(),
  originalOwnerName: text("original_owner_name").notNull().default("Unknown"),
  isShiny: boolean("is_shiny").notNull().default(false),
  nickname: text("nickname").notNull().default("__PENDING_NAME__"),
  level: integer("level").notNull().default(0),
  xp: integer("xp").notNull().default(0),
  passiveName: text("passive_name"),
  passiveDescription: text("passive_description"),
  passiveBonus: integer("passive_bonus").notNull().default(0),
  active: integer("active").notNull().default(0),
  boxed: integer("boxed").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "telegram_pets_player_fk", columns: [table.telegramId, table.chatId], foreignColumns: [telegramPlayersTable.telegramId, telegramPlayersTable.chatId] }).onDelete("cascade"),
]);


// Persistent parties and pending invitations. A player can belong to one party per save/chat.
export const telegramPartiesTable = pgTable("telegram_parties", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  leaderId: text("leader_id").notNull(),
  leaderName: text("leader_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const telegramPartyMembersTable = pgTable("telegram_party_members", {
  partyId: integer("party_id").notNull().references(() => telegramPartiesTable.id, { onDelete: "cascade" }),
  telegramId: text("telegram_id").notNull(),
  chatId: text("chat_id").notNull(),
  username: text("username"),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("invited"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.telegramId, table.chatId] })]);
