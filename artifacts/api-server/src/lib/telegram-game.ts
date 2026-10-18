import {
  and,
  asc,
  eq,
  isNull,
  sql,
} from "drizzle-orm";
import {
  db,
  itemsTable,
  telegramOutboxTable,
  telegramPlayerInventoryTable,
  telegramPlayersTable,
  telegramUpdatesTable,
} from "@workspace/db";
import type {
  CombatState,
  Item,
  InlineKeyboardMarkup,
  TelegramOutboxMessage,
  TelegramPlayer,
} from "@workspace/db";
import type { TelegramUpdate } from "./telegram-types";

type Actor = {
  id: string;
  firstName: string;
  username: string | null;
};

type IncomingEvent = {
  updateId: number;
  actor: Actor;
  chatId: string;
  chatType: string;
  newChatMembers: Actor[];
  callbackQueryId: string | null;
  text: string | null;
  callbackData: string | null;
};

type Reply = {
  text: string;
  keyboard?: InlineKeyboardMarkup;
};

type Region = {
  id: number;
  name: string;
  level: number;
  monsters: Array<Omit<CombatState, "hp" | "maxHp"> & { hp: number }>;
  scenes: string[];
};

const regions: Region[] = [
  {
    id: 1,
    name: "Emerald Grove",
    level: 0,
    monsters: [
      { name: "Lupo d'ombra", hp: 15, attack: 4, xpReward: 15, coinReward: 9 },
      { name: "Sciame di spine", hp: 18, attack: 5, xpReward: 18, coinReward: 12 },
      { name: "Cervo corrotto", hp: 22, attack: 6, xpReward: 22, coinReward: 16 },
    ],
    scenes: [
      "Sotto le chiome smeraldine, qualcosa segue i tuoi passi.",
      "Una folata gelida attraversa il sentiero. Le foglie si muovono controvento.",
      "Le rovine di un vecchio accampamento affiorano dal muschio.",
    ],
  },
  {
    id: 2,
    name: "Cripta di Vetro",
    level: 3,
    monsters: [
      { name: "Sentinella riflessa", hp: 27, attack: 7, xpReward: 30, coinReward: 24 },
      { name: "Ragno di quarzo", hp: 32, attack: 8, xpReward: 34, coinReward: 28 },
      { name: "Custode infranto", hp: 38, attack: 9, xpReward: 40, coinReward: 36 },
    ],
    scenes: [
      "La luce si spezza in mille frammenti sulle pareti di cristallo.",
      "Sotto il pavimento trasparente, un'ombra si muove nella direzione opposta alla tua.",
      "Una campana di vetro vibra senza emettere alcun suono.",
    ],
  },
  {
    id: 3,
    name: "Fortezza Sommersa",
    level: 5,
    monsters: [
      { name: "Cavaliere annegato", hp: 46, attack: 11, xpReward: 50, coinReward: 46 },
      { name: "Serpe degli abissi", hp: 52, attack: 12, xpReward: 56, coinReward: 52 },
      { name: "Ammiraglio senza volto", hp: 60, attack: 13, xpReward: 64, coinReward: 64 },
    ],
    scenes: [
      "L'acqua nera sale lungo le mura, ma le torce restano accese.",
      "Una catena si tende nell'oscurità e trascina qualcosa verso di te.",
      "Il portone sommerso si apre quanto basta per lasciar passare un'armatura vuota.",
    ],
  },
];

const classes = {
  guerriero: { name: "Guerriero", hpBonus: 10, attackBonus: 2, defenseBonus: 2 },
  esploratore: { name: "Esploratore", hpBonus: 4, attackBonus: 3, defenseBonus: 1 },
  arcanista: { name: "Arcanista", hpBonus: 0, attackBonus: 6, defenseBonus: 0 },
} as const;

const menuKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "Esplora", callback_data: "explore" },
      { text: "Profilo", callback_data: "profile" },
    ],
    [
      { text: "Inventory", callback_data: "inventory" },
      { text: "Luoghi", callback_data: "places" },
    ],
  ],
};

const inventoryCategories = [
  { type: "Weapons", label: "Armi" },
  { type: "Armors", label: "Armature" },
  { type: "ClassOrb", label: "Class Orb" },
] as const;

const inventoryKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [button("Posseduti", "inventory:owned")],
    [
      button("Armi", "inventory:catalog:Weapons"),
      button("Armature", "inventory:catalog:Armors"),
    ],
    [button("Class Orb", "inventory:catalog:ClassOrb")],
    [button("Menu", "menu")],
  ],
};

const combatKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "Attacca", callback_data: "attack" },
      { text: "Usa pozione", callback_data: "potion" },
    ],
    [{ text: "Fuggi", callback_data: "flee" }],
  ],
};

function getIncomingEvent(update: TelegramUpdate): IncomingEvent | null {
  const message = update.message;
  const callback = update.callback_query;
  const newChatMembers = (message?.new_chat_members ?? [])
    .filter((member) => !member.is_bot)
    .map((member) => ({
      id: String(member.id),
      firstName: member.first_name || member.username || "Viandante",
      username: member.username ?? null,
    }));
  const actorSource =
    message?.from ??
    callback?.from ??
    message?.new_chat_members?.find((member) => !member.is_bot);
  const chat = message?.chat ?? callback?.message?.chat;
  if (!actorSource || !chat) return null;
  if (actorSource.is_bot) return null;

  return {
    updateId: update.update_id,
    actor: {
      id: String(actorSource.id),
      firstName: actorSource.first_name || actorSource.username || "Viandante",
      username: actorSource.username ?? null,
    },
    chatId: String(chat.id),
    chatType: chat.type,
    newChatMembers,
    callbackQueryId: callback?.id ?? null,
    text: message?.text ?? null,
    callbackData: callback?.data ?? null,
  };
}

function button(text: string, callbackData: string) {
  return { text, callback_data: callbackData };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRegion(id: number): Region {
  return regions.find((region) => region.id === id) ?? regions[0]!;
}

function baseStats(level: number) {
  return {
    hp: 20 + level * 5,
    attack: 4 + level,
    defense: 1 + Math.floor(level / 2),
  };
}

function classStats(archetypeKey: keyof typeof classes, level: number) {
  const base = baseStats(level);
  const bonuses = classes[archetypeKey];
  return {
    hp: base.hp + bonuses.hpBonus,
    attack: base.attack + bonuses.attackBonus,
    defense: base.defense + bonuses.defenseBonus,
  };
}

function playerScope(event: IncomingEvent) {
  return and(
    eq(telegramPlayersTable.telegramId, event.actor.id),
    eq(telegramPlayersTable.chatId, event.chatId),
  );
}

function classSelectionReply(): Reply {
  return {
    text: "Il personaggio è pronto. Scegli una classe per iniziare a combattere:",
    keyboard: {
      inline_keyboard: [
        [button("Guerriero · resistente", "class:guerriero")],
        [button("Esploratore · rapido", "class:esploratore")],
        [button("Arcanista · potente", "class:arcanista")],
      ],
    },
  };
}

function formatProfile(player: TelegramPlayer): string {
  const region = getRegion(player.biomeId);
  const nextLevelXp = (player.level + 1) * 35;
  const combatLine = player.combat
    ? `\n\nIn combattimento: ${player.combat.name} (${player.combat.hp}/${player.combat.maxHp} PV)`
    : "";
  return [
    `Scheda di ${player.characterName}`,
    `${player.archetype} · Livello ${player.level}`,
    `Esperienza: ${player.xp}/${nextLevelXp} XP`,
    `Salute: ${player.hp}/${player.maxHp} PV`,
    `Attacco: ${player.attack} · Difesa: ${player.defense}`,
    `Bioma: ${region.name}`,
    combatLine,
  ].join("\n");
}

function formatItem(
  item: Pick<
    Item,
    "name" | "rarity" | "tier" | "stats" | "passiveOrEffect"
  >,
  quantity?: number,
): string {
  const statLabels: Record<string, string> = {
    hp: "HP",
    mp: "MP",
    atk: "ATK",
    def: "DEF",
    crit_rate: "Crit",
  };
  const stats = Object.entries(item.stats).flatMap(([key, value]) => {
    if (!(key in statLabels) || typeof value !== "number") return [];
    const label = statLabels[key]!;
    const formattedValue =
      key === "crit_rate"
        ? `${value >= 0 ? "+" : ""}${Number((value * 100).toFixed(2))}%`
        : `${value > 0 ? "+" : ""}${value}`;
    return [`${label} ${formattedValue}`];
  });
  const quantityLabel = quantity && quantity > 1 ? ` ×${quantity}` : "";
  const effect = item.passiveOrEffect
    ? `\n  Effetto: ${item.passiveOrEffect}`
    : "";

  return [
    `${item.name}${quantityLabel} — ${item.rarity} · Tier ${item.tier}`,
    `  ${stats.length > 0 ? stats.join(" · ") : "Nessun bonus"}`,
  ].join("\n") + effect;
}

async function getOwnedInventoryItems(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  player: TelegramPlayer,
) {
  return tx
    .select({
      itemId: itemsTable.itemId,
      name: itemsTable.name,
      type: itemsTable.type,
      tier: itemsTable.tier,
      rarity: itemsTable.rarity,
      stats: itemsTable.stats,
      passiveOrEffect: itemsTable.passiveOrEffect,
      quantity: telegramPlayerInventoryTable.quantity,
    })
    .from(telegramPlayerInventoryTable)
    .innerJoin(
      itemsTable,
      eq(telegramPlayerInventoryTable.itemId, itemsTable.itemId),
    )
    .where(
      and(
        eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
        eq(telegramPlayerInventoryTable.chatId, player.chatId),
      ),
    )
    .orderBy(
      asc(itemsTable.type),
      asc(itemsTable.tier),
      asc(itemsTable.name),
    );
}

async function inventoryOverview(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  player: TelegramPlayer,
): Promise<Reply> {
  const ownedItems = await getOwnedInventoryItems(tx, player);
  const catalogItems = await tx
    .select()
    .from(itemsTable)
    .orderBy(asc(itemsTable.type), asc(itemsTable.tier), asc(itemsTable.name));
  const catalogCounts = new Map(
    inventoryCategories.map(({ type }) => [
      type,
      catalogItems.filter((item) => item.type === type).length,
    ]),
  );

  return {
    text: [
      `Inventory di ${player.characterName}`,
      "",
      "OGGETTI POSSEDUTI",
      ...(ownedItems.length > 0
        ? ownedItems.map((item) => `• ${formatItem(item, item.quantity)}`)
        : ["Ancora nessuna arma, armatura o class orb posseduta."]),
      "",
      `Pozioni di cura: ${player.potions}`,
      `Monete: ${player.coins}`,
      "",
      "CATALOGO",
      ...inventoryCategories.map(
        ({ type, label }) => `${label}: ${catalogCounts.get(type) ?? 0}`,
      ),
    ].join("\n"),
    keyboard: inventoryKeyboard,
  };
}

async function ownedInventoryReply(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  player: TelegramPlayer,
): Promise<Reply> {
  const ownedItems = await getOwnedInventoryItems(tx, player);
  return {
    text: [
      `Inventory di ${player.characterName}`,
      "OGGETTI POSSEDUTI",
      ...(ownedItems.length > 0
        ? ownedItems.map((item) => `• ${formatItem(item, item.quantity)}`)
        : ["Ancora nessuna arma, armatura o class orb posseduta."]),
      "",
      `Pozioni di cura: ${player.potions}`,
      `Monete: ${player.coins}`,
    ].join("\n"),
    keyboard: inventoryKeyboard,
  };
}

async function inventoryCatalogReply(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  player: TelegramPlayer,
  category: (typeof inventoryCategories)[number],
): Promise<Reply> {
  const catalogItems = await tx
    .select()
    .from(itemsTable)
    .where(eq(itemsTable.type, category.type))
    .orderBy(asc(itemsTable.tier), asc(itemsTable.name));
  const ownedItems = await getOwnedInventoryItems(tx, player);
  const ownedById = new Map(ownedItems.map((item) => [item.itemId, item]));

  return {
    text: [
      `Inventory di ${player.characterName}`,
      `CATALOGO · ${category.label.toUpperCase()}`,
      "",
      ...(catalogItems.length > 0
        ? catalogItems.map((item) => {
            const ownedItem = ownedById.get(item.itemId);
            return [
              `• ${formatItem(item, ownedItem?.quantity)}`,
              `  ${ownedItem ? "Posseduto" : "Non posseduto"}`,
            ].join("\n");
          })
        : ["Nessun oggetto in questa categoria."]),
    ].join("\n\n"),
    keyboard: inventoryKeyboard,
  };
}

function placesKeyboard(level: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: regions.map((region) => [
      button(
        level >= region.level
          ? region.name
          : `${region.name} · livello ${region.level}`,
        `region:${region.id}`,
      ),
    ]),
  };
}

function homeReply(player: TelegramPlayer): Reply {
  if (player.archetype === "Nessuna") return classSelectionReply();
  return {
    text: `Bentornato, ${player.characterName}. Sei in ${getRegion(player.biomeId).name}.\n\nCosa vuoi fare?`,
    keyboard: menuKeyboard,
  };
}

async function enqueueReply(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  reply: Reply,
): Promise<void> {
  await tx.insert(telegramOutboxTable).values({
    updateId: event.updateId,
    chatId: event.chatId,
    callbackQueryId: event.callbackQueryId,
    text: reply.text,
    replyMarkup: reply.keyboard ?? null,
  });
}

async function ensurePlayer(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  chatId: string,
  actor: Actor,
): Promise<TelegramPlayer> {
  const stats = baseStats(0);
  const [player] = await tx
    .insert(telegramPlayersTable)
    .values({
      telegramId: actor.id,
      chatId,
      username: actor.username,
      characterName: (actor.firstName || actor.username || "Viandante").slice(0, 48),
      archetype: "Nessuna",
      level: 0,
      xp: 0,
      hp: stats.hp,
      maxHp: stats.hp,
      attack: stats.attack,
      defense: stats.defense,
      potions: 2,
      coins: 10,
      biomeId: 1,
      combat: null,
    })
    .onConflictDoNothing()
    .returning();

  if (player) return player;

  const [existing] = await tx
    .select()
    .from(telegramPlayersTable)
    .where(
      and(
        eq(telegramPlayersTable.telegramId, actor.id),
        eq(telegramPlayersTable.chatId, chatId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Telegram player upsert could not be read back");
  return existing;
}

async function chooseClass(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
  archetypeKey: keyof typeof classes,
): Promise<Reply> {
  if (player.archetype !== "Nessuna") return homeReply(player);

  const archetype = classes[archetypeKey];
  const stats = classStats(archetypeKey, player.level);
  const [updatedPlayer] = await tx
    .update(telegramPlayersTable)
    .set({
      archetype: archetype.name,
      hp: stats.hp,
      maxHp: stats.hp,
      attack: stats.attack,
      defense: stats.defense,
      updatedAt: new Date(),
    })
    .where(playerScope(event))
    .returning();

  if (!updatedPlayer) throw new Error("Telegram player disappeared during class selection");
  return {
    text: [
      `La tua avventura comincia, ${updatedPlayer.characterName}.`,
      `${updatedPlayer.archetype} · livello ${updatedPlayer.level}: ${updatedPlayer.maxHp} PV, attacco ${updatedPlayer.attack}, difesa ${updatedPlayer.defense}.`,
      `Hai ${updatedPlayer.potions} pozioni e ${updatedPlayer.coins} monete. ${getRegion(updatedPlayer.biomeId).name} ti aspetta.`,
      "",
      "Usa i pulsanti o scrivi /aiuto per vedere i comandi.",
    ].join("\n"),
    keyboard: menuKeyboard,
  };
}

function helpReply(): Reply {
  return {
    text: [
      "Comandi dell'avventura:",
      "/start — crea il personaggio o riapre il menu",
      "/esplora — cerca incontri, monete e oggetti",
      "/profilo — statistiche e progressi",
      "/inventory (/inventario) — oggetti posseduti e catalogo",
      "/luoghi — scegli la prossima regione",
      "",
      "Durante uno scontro usa Attacca, Usa pozione o Fuggi.",
    ].join("\n"),
    keyboard: menuKeyboard,
  };
}

async function explore(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  if (player.archetype === "Nessuna") return classSelectionReply();
  if (player.combat) {
    return {
      text: `Sei già impegnato contro ${player.combat.name}. Scegli un'azione.`,
      keyboard: combatKeyboard,
    };
  }
  if (player.hp <= 0) {
    return { text: "Sei troppo ferito per proseguire. Riposa e riprova." };
  }

  const region = getRegion(player.biomeId);
  const scene = region.scenes[randomInt(0, region.scenes.length - 1)]!;
  const roll = Math.random();

  if (roll < 0.68) {
    const template = region.monsters[randomInt(0, region.monsters.length - 1)]!;
    const enemy: CombatState = { ...template, maxHp: template.hp };
    await tx
      .update(telegramPlayersTable)
      .set({ combat: enemy, updatedAt: new Date() })
      .where(playerScope(event));
    return {
      text: `${scene}\n\n${enemy.name} ti sbarra il cammino! (${enemy.hp} PV)\n\nChe fai?`,
      keyboard: combatKeyboard,
    };
  }

  if (roll < 0.91) {
    const coinsFound = randomInt(5, 16);
    await tx
      .update(telegramPlayersTable)
      .set({ coins: player.coins + coinsFound, updatedAt: new Date() })
      .where(playerScope(event));
    return {
      text: `${scene}\n\nTrovi una borsa dimenticata con ${coinsFound} monete. Ora ne hai ${player.coins + coinsFound}.`,
      keyboard: menuKeyboard,
    };
  }

  await tx
    .update(telegramPlayersTable)
    .set({ potions: player.potions + 1, updatedAt: new Date() })
    .where(playerScope(event));
  return {
    text: `${scene}\n\nTra le radici trovi una pozione intatta. Ora ne hai ${player.potions + 1}.`,
    keyboard: menuKeyboard,
  };
}

async function attack(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  const enemy = player.combat;
  if (!enemy) return { text: "Non sei in combattimento. Usa Esplora per cercare un'avventura.", keyboard: menuKeyboard };

  const damage = Math.max(1, player.attack + randomInt(0, 3) - 1);
  const enemyHp = Math.max(0, enemy.hp - damage);
  const lines = [`Colpisci ${enemy.name}: ${damage} danni.`];

  if (enemyHp === 0) {
    let xp = player.xp + enemy.xpReward;
    let level = player.level;
    let maxHp = player.maxHp;
    let playerAttack = player.attack;
    let defense = player.defense;
    const levelMessages: string[] = [];

    while (xp >= (level + 1) * 35) {
      xp -= (level + 1) * 35;
      level += 1;
      maxHp += 5;
      playerAttack += 1;
      if (level % 2 === 0) defense += 1;
      levelMessages.push(`Raggiungi il livello ${level}: +5 PV massimi e +1 attacco.`);
    }

    const newHp = clamp(player.hp + 3 + levelMessages.length * 5, 1, maxHp);
    const gainedPotion = Math.random() < 0.2 ? 1 : 0;
    const coins = player.coins + enemy.coinReward;
    await tx
      .update(telegramPlayersTable)
      .set({
        combat: null,
        hp: newHp,
        maxHp,
        attack: playerAttack,
        defense,
        level,
        xp,
        coins,
        potions: player.potions + gainedPotion,
        updatedAt: new Date(),
      })
      .where(playerScope(event));

    lines.push(
      `${enemy.name} è sconfitto. Ottieni ${enemy.xpReward} XP e ${enemy.coinReward} monete.`,
    );
    if (gainedPotion) lines.push("Tra i resti trovi anche una pozione.");
    lines.push(...levelMessages);
    lines.push(`Salute: ${newHp}/${maxHp} PV · Monete: ${coins}.`);
    return { text: lines.join("\n"), keyboard: menuKeyboard };
  }

  const updatedEnemy = { ...enemy, hp: enemyHp };
  const enemyDamage = Math.max(1, enemy.attack + randomInt(0, 2) - player.defense);
  const newHp = Math.max(0, player.hp - enemyDamage);
  lines.push(`${enemy.name} contrattacca: ${enemyDamage} danni.`);

  if (newHp === 0) {
    const coins = Math.max(0, player.coins - 5);
    await tx
      .update(telegramPlayersTable)
      .set({
        combat: null,
        hp: player.maxHp,
        coins,
        updatedAt: new Date(),
      })
      .where(playerScope(event));
    lines.push(`Cadi a terra, ma ti risvegli al sicuro con tutta la salute. Perdi 5 monete (te ne restano ${coins}).`);
    return { text: lines.join("\n"), keyboard: menuKeyboard };
  }

  await tx
    .update(telegramPlayersTable)
    .set({
      combat: updatedEnemy,
      hp: newHp,
      updatedAt: new Date(),
    })
    .where(playerScope(event));
  lines.push(`Tu: ${newHp}/${player.maxHp} PV · ${enemy.name}: ${enemyHp}/${enemy.maxHp} PV.`);
  return { text: lines.join("\n"), keyboard: combatKeyboard };
}

async function usePotion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  if (!player.combat) return { text: "Le pozioni si usano durante un combattimento.", keyboard: menuKeyboard };
  if (player.potions <= 0) return { text: "Non hai pozioni. Prova a esplorare per trovarne una.", keyboard: combatKeyboard };

  const healed = Math.min(15, player.maxHp - player.hp);
  const hp = player.hp + healed;
  const enemyDamage = Math.max(1, player.combat.attack + randomInt(0, 2) - player.defense);
  const newHp = Math.max(0, hp - enemyDamage);
  const lines = [`Usi una pozione e recuperi ${healed} PV.`, `${player.combat.name} ti colpisce: ${enemyDamage} danni.`];

  if (newHp === 0) {
    const coins = Math.max(0, player.coins - 5);
    await tx
      .update(telegramPlayersTable)
      .set({
        combat: null,
        hp: player.maxHp,
        potions: player.potions - 1,
        coins,
        updatedAt: new Date(),
      })
      .where(playerScope(event));
    lines.push(`Cadi a terra e ti risvegli al sicuro. Perdi 5 monete (te ne restano ${coins}).`);
    return { text: lines.join("\n"), keyboard: menuKeyboard };
  }

  await tx
    .update(telegramPlayersTable)
    .set({
      hp: newHp,
      potions: player.potions - 1,
      updatedAt: new Date(),
    })
    .where(playerScope(event));
  lines.push(`Salute: ${newHp}/${player.maxHp} PV · Pozioni: ${player.potions - 1}.`);
  return { text: lines.join("\n"), keyboard: combatKeyboard };
}

async function flee(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  const enemy = player.combat;
  if (!enemy) return { text: "Non c'è nessuno da cui fuggire.", keyboard: menuKeyboard };

  if (Math.random() < 0.6) {
    await tx
      .update(telegramPlayersTable)
      .set({ combat: null, updatedAt: new Date() })
      .where(playerScope(event));
    return { text: `Ti allontani da ${enemy.name} e torni sul sentiero.`, keyboard: menuKeyboard };
  }

  const damage = Math.max(1, enemy.attack + randomInt(0, 2) - player.defense);
  const hp = Math.max(0, player.hp - damage);
  if (hp === 0) {
    const coins = Math.max(0, player.coins - 5);
    await tx
      .update(telegramPlayersTable)
      .set({
        combat: null,
        hp: player.maxHp,
        coins,
        updatedAt: new Date(),
      })
      .where(playerScope(event));
    return {
      text: `Non riesci a fuggire: ${enemy.name} ti infligge ${damage} danni. Ti risvegli al sicuro e perdi 5 monete.`,
      keyboard: menuKeyboard,
    };
  }

  await tx
    .update(telegramPlayersTable)
    .set({ hp, updatedAt: new Date() })
    .where(playerScope(event));
  return {
    text: `Non riesci a fuggire: ${enemy.name} ti infligge ${damage} danni. Hai ${hp}/${player.maxHp} PV.`,
    keyboard: combatKeyboard,
  };
}

async function chooseRegion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
  regionId: string,
): Promise<Reply> {
  const region = regions.find((candidate) => candidate.id === Number(regionId));
  if (!region) return { text: "Questo luogo non esiste.", keyboard: placesKeyboard(player.level) };
  if (player.level < region.level) {
    return {
      text: `Il ${region.name} è troppo pericoloso. Raggiungi il livello ${region.level} per entrarci.`,
      keyboard: placesKeyboard(player.level),
    };
  }
  if (player.combat) {
    return { text: "Prima devi concludere il combattimento in corso.", keyboard: combatKeyboard };
  }
  await tx
    .update(telegramPlayersTable)
    .set({ biomeId: region.id, updatedAt: new Date() })
    .where(playerScope(event));
  return { text: `Raggiungi il ${region.name}. Usa Esplora quando vuoi.`, keyboard: menuKeyboard };
}

async function handleEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
): Promise<Reply> {
  const command = event.text?.trim().split(/\s+/, 1)[0]?.split("@", 1)[0]?.toLowerCase();
  const callback = event.callbackData;

  if (event.newChatMembers.length > 0) {
    for (const member of event.newChatMembers) {
      await ensurePlayer(tx, event.chatId, member);
    }
    const names = event.newChatMembers.map((member) => member.firstName).join(", ");
    return {
      text: `Benvenuto in Valdombra, ${names}! Ho creato un salvataggio personale per ogni membro. Scegli la tua classe:`,
      keyboard: classSelectionReply().keyboard,
    };
  }

  const player = await ensurePlayer(tx, event.chatId, event.actor);

  if (command === "/start" || command === "/menu" || callback === "menu") {
    return homeReply(player);
  }

  if (callback?.startsWith("class:")) {
    const key = callback.slice("class:".length);
    if (!Object.hasOwn(classes, key)) return { text: "Classe non valida. Usa /start per riprovare." };
    return chooseClass(tx, event, player, key as keyof typeof classes);
  }

  if (command === "/aiuto" || command === "/help" || callback === "help") {
    return helpReply();
  }
  if (command === "/profilo" || callback === "profile") {
    return { text: formatProfile(player), keyboard: menuKeyboard };
  }
  if (
    command === "/inventario" ||
    command === "/inventory" ||
    callback === "inventory"
  ) {
    return inventoryOverview(tx, player);
  }
  if (callback === "inventory:owned") {
    return ownedInventoryReply(tx, player);
  }
  if (callback?.startsWith("inventory:catalog:")) {
    const categoryType = callback.slice("inventory:catalog:".length);
    const category = inventoryCategories.find(
      (candidate) => candidate.type === categoryType,
    );
    if (!category) {
      return {
        text: "Categoria non valida. Apri di nuovo Inventory dal menu.",
        keyboard: inventoryKeyboard,
      };
    }
    return inventoryCatalogReply(tx, player, category);
  }
  if (player.archetype === "Nessuna") return classSelectionReply();

  if (command === "/luoghi" || callback === "places") {
    return {
      text: `Ti trovi in ${getRegion(player.biomeId).name}. Dove vuoi andare?`,
      keyboard: placesKeyboard(player.level),
    };
  }
  if (callback?.startsWith("region:")) {
    return chooseRegion(tx, event, player, callback.slice("region:".length));
  }
  if (command === "/esplora" || callback === "explore") {
    return explore(tx, event, player);
  }
  if (callback === "attack") return attack(tx, event, player);
  if (callback === "potion") return usePotion(tx, event, player);
  if (callback === "flee") return flee(tx, event, player);
  if (!event.text) return { text: "Non ho capito l'azione. Usa i pulsanti o /aiuto.", keyboard: menuKeyboard };

  return {
    text: "Non riconosco quel comando. Usa i pulsanti o scrivi /aiuto.",
    keyboard: menuKeyboard,
  };
}

export async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const event = getIncomingEvent(update);
  if (!event) return;
  const isCommand = event.text?.trim().startsWith("/") ?? false;
  const isGroupMessage = event.chatType !== "private";
  if (
    isGroupMessage &&
    !isCommand &&
    !event.callbackData &&
    event.newChatMembers.length === 0
  ) {
    return;
  }

  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(telegramUpdatesTable)
      .values({ updateId: event.updateId })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdatesTable.updateId });
    if (!inserted) return;

    const reply = await handleEvent(tx, event);
    await enqueueReply(tx, event, reply);
  });
}

export async function getPendingOutboxMessages(): Promise<TelegramOutboxMessage[]> {
  return db
    .select()
    .from(telegramOutboxTable)
    .where(and(isNull(telegramOutboxTable.sentAt)))
    .orderBy(asc(telegramOutboxTable.id))
    .limit(25);
}

export async function markOutboxMessageSent(id: number): Promise<void> {
  await db
    .update(telegramOutboxTable)
    .set({ sentAt: new Date() })
    .where(eq(telegramOutboxTable.id, id));
}

export async function pruneOldTelegramUpdates(): Promise<void> {
  await db.execute(sql`
    DELETE FROM telegram_game_updates
    WHERE created_at < NOW() - INTERVAL '90 days'
  `);
}
