import {
  and,
  asc,
  eq,
  isNull,
  sql,
} from "drizzle-orm";
import { db, telegramOutboxTable, telegramPlayersTable, telegramUpdatesTable } from "@workspace/db";
import type {
  CombatState,
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
  callbackQueryId: string | null;
  text: string | null;
  callbackData: string | null;
};

type Reply = {
  text: string;
  keyboard?: InlineKeyboardMarkup;
};

type Region = {
  id: string;
  name: string;
  level: number;
  monsters: Array<Omit<CombatState, "hp" | "maxHp"> & { hp: number }>;
  scenes: string[];
};

const regions: Region[] = [
  {
    id: "bosco",
    name: "Bosco di Cenere",
    level: 1,
    monsters: [
      { name: "Lupo d'ombra", hp: 15, attack: 4, xpReward: 15, coinReward: 9 },
      { name: "Sciame di spine", hp: 18, attack: 5, xpReward: 18, coinReward: 12 },
      { name: "Cervo corrotto", hp: 22, attack: 6, xpReward: 22, coinReward: 16 },
    ],
    scenes: [
      "Tra i tronchi anneriti, qualcosa segue i tuoi passi.",
      "Una folata gelida attraversa il sentiero. Le foglie si muovono controvento.",
      "Le rovine di un vecchio accampamento affiorano dal muschio.",
    ],
  },
  {
    id: "cripta",
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
    id: "fortezza",
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
  guerriero: { name: "Guerriero", hp: 34, attack: 8, defense: 3 },
  esploratore: { name: "Esploratore", hp: 28, attack: 9, defense: 2 },
  arcanista: { name: "Arcanista", hp: 24, attack: 12, defense: 1 },
} as const;

const menuKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "Esplora", callback_data: "explore" },
      { text: "Profilo", callback_data: "profile" },
    ],
    [
      { text: "Inventario", callback_data: "inventory" },
      { text: "Luoghi", callback_data: "places" },
    ],
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
  const actorSource = message?.from ?? callback?.from;
  const chat = message?.chat ?? callback?.message?.chat;
  if (!actorSource || !chat) return null;

  return {
    updateId: update.update_id,
    actor: {
      id: String(actorSource.id),
      firstName: actorSource.first_name || "Viandante",
      username: actorSource.username ?? null,
    },
    chatId: String(chat.id),
    chatType: chat.type,
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

function getRegion(id: string): Region {
  return regions.find((region) => region.id === id) ?? regions[0]!;
}

function formatProfile(player: TelegramPlayer): string {
  const region = getRegion(player.location);
  const nextLevelXp = player.level * 35;
  const combatLine = player.combat
    ? `\n\nIn combattimento: ${player.combat.name} (${player.combat.hp}/${player.combat.maxHp} PV)`
    : "";
  return [
    `Scheda di ${player.characterName}`,
    `${player.archetype} · Livello ${player.level}`,
    `Esperienza: ${player.xp}/${nextLevelXp} XP`,
    `Salute: ${player.hp}/${player.maxHp} PV`,
    `Attacco: ${player.attack} · Difesa: ${player.defense}`,
    `Luogo: ${region.name}`,
    combatLine,
  ].join("\n");
}

function formatInventory(player: TelegramPlayer): string {
  return [
    `Zaino di ${player.characterName}`,
    `Pozioni di cura: ${player.potions}`,
    `Monete: ${player.coins}`,
    "Le pozioni si usano durante un combattimento.",
  ].join("\n");
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
  return {
    text: `Bentornato, ${player.characterName}. Sei nel ${getRegion(player.location).name}.\n\nCosa vuoi fare?`,
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

async function createCharacter(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  archetypeKey: keyof typeof classes,
): Promise<Reply> {
  const archetype = classes[archetypeKey];
  const [player] = await tx
    .insert(telegramPlayersTable)
    .values({
      telegramId: event.actor.id,
      username: event.actor.username,
      characterName: event.actor.firstName.slice(0, 48),
      archetype: archetype.name,
      hp: archetype.hp,
      maxHp: archetype.hp,
      attack: archetype.attack,
      defense: archetype.defense,
      potions: 2,
      coins: 10,
      location: "bosco",
      combat: null,
    })
    .onConflictDoNothing()
    .returning();

  if (!player) {
    const [existing] = await tx
      .select()
      .from(telegramPlayersTable)
      .where(eq(telegramPlayersTable.telegramId, event.actor.id))
      .limit(1);
    return existing ? homeReply(existing) : { text: "Non riesco a trovare la tua scheda. Riprova con /start." };
  }

  return {
    text: [
      `La tua avventura comincia, ${player.characterName}.`,
      `${player.archetype}: ${player.maxHp} PV, attacco ${player.attack}, difesa ${player.defense}.`,
      "Hai 2 pozioni. Il Bosco di Cenere ti aspetta.",
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
      "/inventario — pozioni e monete",
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
  if (player.combat) {
    return {
      text: `Sei già impegnato contro ${player.combat.name}. Scegli un'azione.`,
      keyboard: combatKeyboard,
    };
  }
  if (player.hp <= 0) {
    return { text: "Sei troppo ferito per proseguire. Riposa e riprova." };
  }

  const region = getRegion(player.location);
  const scene = region.scenes[randomInt(0, region.scenes.length - 1)]!;
  const roll = Math.random();

  if (roll < 0.68) {
    const template = region.monsters[randomInt(0, region.monsters.length - 1)]!;
    const enemy: CombatState = { ...template, maxHp: template.hp };
    await tx
      .update(telegramPlayersTable)
      .set({ combat: enemy, updatedAt: new Date() })
      .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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
      .where(eq(telegramPlayersTable.telegramId, event.actor.id));
    return {
      text: `${scene}\n\nTrovi una borsa dimenticata con ${coinsFound} monete. Ora ne hai ${player.coins + coinsFound}.`,
      keyboard: menuKeyboard,
    };
  }

  await tx
    .update(telegramPlayersTable)
    .set({ potions: player.potions + 1, updatedAt: new Date() })
    .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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

    while (xp >= level * 35) {
      xp -= level * 35;
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
      .where(eq(telegramPlayersTable.telegramId, event.actor.id));

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
      .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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
    .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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
      .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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
    .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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
      .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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
      .where(eq(telegramPlayersTable.telegramId, event.actor.id));
    return {
      text: `Non riesci a fuggire: ${enemy.name} ti infligge ${damage} danni. Ti risvegli al sicuro e perdi 5 monete.`,
      keyboard: menuKeyboard,
    };
  }

  await tx
    .update(telegramPlayersTable)
    .set({ hp, updatedAt: new Date() })
    .where(eq(telegramPlayersTable.telegramId, event.actor.id));
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
  const region = regions.find((candidate) => candidate.id === regionId);
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
    .set({ location: region.id, updatedAt: new Date() })
    .where(eq(telegramPlayersTable.telegramId, event.actor.id));
  return { text: `Raggiungi il ${region.name}. Usa Esplora quando vuoi.`, keyboard: menuKeyboard };
}

async function handleEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
): Promise<Reply> {
  if (event.chatType !== "private") {
    return { text: "Per giocare e salvare il personaggio in privato, apri la chat diretta con questo bot." };
  }

  const [player] = await tx
    .select()
    .from(telegramPlayersTable)
    .where(eq(telegramPlayersTable.telegramId, event.actor.id))
    .limit(1);
  const command = event.text?.trim().split(/\s+/, 1)[0]?.split("@", 1)[0]?.toLowerCase();
  const callback = event.callbackData;

  if (command === "/start" || command === "/menu" || callback === "menu") {
    if (!player) {
      return {
        text: "Benvenuto a Valdombra. Scegli chi vuoi essere:",
        keyboard: {
          inline_keyboard: [
            [button("Guerriero · resistente", "class:guerriero")],
            [button("Esploratore · rapido", "class:esploratore")],
            [button("Arcanista · potente", "class:arcanista")],
          ],
        },
      };
    }
    return homeReply(player);
  }

  if (callback?.startsWith("class:")) {
    const key = callback.slice("class:".length);
    if (!(key in classes)) return { text: "Classe non valida. Usa /start per riprovare." };
    return createCharacter(tx, event, key as keyof typeof classes);
  }

  if (!player) {
    return { text: "Prima crea il tuo personaggio con /start." };
  }

  if (command === "/aiuto" || command === "/help" || callback === "help") {
    return helpReply();
  }
  if (command === "/profilo" || callback === "profile") {
    return { text: formatProfile(player), keyboard: menuKeyboard };
  }
  if (command === "/inventario" || callback === "inventory") {
    return { text: formatInventory(player), keyboard: menuKeyboard };
  }
  if (command === "/luoghi" || callback === "places") {
    return {
      text: `Ti trovi nel ${getRegion(player.location).name}. Dove vuoi andare?`,
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
