import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  db,
  itemsTable,
  telegramLobbiesTable,
  telegramCasinoSessionsTable,
  telegramTradesTable,
  telegramOutboxTable,
  telegramPlayerEquipmentTable,
  telegramPlayerInventoryTable,
  telegramPlayersTable,
  telegramPlayerSettingsTable,
  telegramPetsTable,
  telegramPartiesTable,
  telegramPartyMembersTable,
  telegramUpdatesTable,
} from "@workspace/db";
import type {
  CombatState,
  EquipmentSlot,
  Fighter,
  LobbyMember,
  LobbyState,
  TelegramLobby,
  ItemDrop,
  Item,
  InlineKeyboardMarkup,
  TelegramOutboxMessage,
  TelegramPlayer,
  CasinoSessionState,
  TelegramTradeState,
  TradeOffer,
} from "@workspace/db";
import type { TelegramUpdate } from "./telegram-types";
import biomeDefinitions from "../data/biomes.json";

const SYSTEM_OWNER_TELEGRAM_ID = "806866054";

/** Central owner check: all future privileged/admin commands must use this guard. */
function isSystemOwner(telegramId: string): boolean {
  return telegramId === SYSTEM_OWNER_TELEGRAM_ID;
}

type Actor = {
  id: string;
  firstName: string;
  username: string | null;
};

type IncomingEvent = {
  updateId: number;
  actor: Actor;
  chatId: string;
  // Destination for replies stays the chat where the update originated, even when
  // a private command is executed against a selected group save.
  responseChatId: string;
  chatType: string;
  newChatMembers: Actor[];
  callbackQueryId: string | null;
  messageId: number | null;
  text: string | null;
  callbackData: string | null;
};

type Reply = {
  text: string;
  // Silently consume an update without sending a Telegram message.
  silent?: boolean;
  keyboard?: InlineKeyboardMarkup;
  // Messages for several players at once carry no "Message for" label
  // and are never auto-deleted.
  broadcast?: boolean;
  // Shared boss/duel lobby message: "post" sends it, "edit" updates it in place.
  lobbyId?: number;
  lobbyAction?: "post" | "edit";
  // Pop-up text shown when the pressed button is acknowledged.
  callbackText?: string;
  // Also delete this player's older private bot messages (e.g. the menu they pressed).
  cleanupOwner?: boolean;
};

type MonsterTemplate = {
  mobId: string;
  name: string;
  hp: number;
  attack: number;
  xpReward: number;
  dropTable: ItemDrop[];
  rare?: boolean;
};

type Region = {
  id: number;
  name: string;
  level: number;
  recommendedLevel: string;
  monsters: MonsterTemplate[];
  boss: MonsterTemplate & { minLevel: number };
};

const regions: Region[] = biomeDefinitions.map((biome) => {
  const level = Number.parseInt(biome.recommended_level, 10);
  if (!Number.isInteger(level)) {
    throw new Error(`Invalid recommended_level for biome ${biome.biome_id}`);
  }
  const mapDrops = (
    drops: Array<{ item_id: string; chance: number }>,
  ): ItemDrop[] =>
    drops.map((drop) => ({
      itemId: drop.item_id,
      chance: drop.chance,
    }));

  return {
    id: biome.biome_id,
    name: biome.name,
    level,
    recommendedLevel: biome.recommended_level,
    monsters: biome.mobs.map((mob) => ({
      mobId: mob.mob_id,
      name: mob.name,
      hp: Math.max(1, Math.floor(mob.hp * 0.92)),
      attack: Math.max(1, Math.floor(mob.atk * 0.92)),
      xpReward: mob.xp_reward,
      rare: Boolean(mob.rare),
      dropTable: mapDrops(mob.drop_table),
    })),
    boss: {
      mobId: biome.boss.mob_id,
      name: biome.boss.name,
      minLevel: biome.boss.min_level,
      hp: biome.boss.hp,
      attack: biome.boss.atk,
      xpReward: biome.boss.xp_reward,
      dropTable: mapDrops(biome.boss.drop_table),
    },
  };
});

type ExplorationEventDefinition = { id: string; title: string; rarity: "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary" | "Mythic"; weight: number; description: string };

// Twenty exploration event archetypes are available in every biome. Their flavor text
// is tied to the current region, while rarity weights keep powerful rewards uncommon.
const explorationEventDefinitions: ExplorationEventDefinition[] = [
  { id: "lost_satchel", title: "Lost Adventurer's Satchel", rarity: "Common", weight: 15, description: "A weather-beaten satchel lies beside the trail." },
  { id: "old_waystone", title: "Ancient Waystone", rarity: "Common", weight: 13, description: "Faint runes glow on a stone marker." },
  { id: "healing_spring", title: "Hidden Healing Spring", rarity: "Common", weight: 12, description: "Clear water bubbles up from a hidden spring." },
  { id: "herbs", title: "Rare Medicinal Herbs", rarity: "Common", weight: 11, description: "You find useful herbs growing between the rocks." },
  { id: "pouch", title: "Abandoned Coin Pouch", rarity: "Common", weight: 11, description: "A small pouch is half-buried in the dirt." },
  { id: "mushrooms", title: "Glowing Mushroom Ring", rarity: "Common", weight: 10, description: "A ring of strange mushrooms hums with faint magic." },
  { id: "campfire", title: "Forgotten Campfire", rarity: "Common", weight: 10, description: "An abandoned camp still has a few useful supplies." },
  { id: "kind_spirit", title: "Wandering Kind Spirit", rarity: "Common", weight: 9, description: "A gentle spirit offers to share a little of its energy." },
  { id: "merchant", title: "Traveling Merchant's Cache", rarity: "Uncommon", weight: 8, description: "A merchant's hidden emergency stash has been left behind." },
  { id: "wandering_merchant", title: "Wandering Merchant", rarity: "Uncommon", weight: 7, description: "A road-worn trader waves you over and opens a travelling shop. The deeper the region, the rarer the wares." },
  { id: "buried_cache", title: "Buried Cache", rarity: "Uncommon", weight: 8, description: "You notice a corner of a small chest poking out of the ground." },
  { id: "ancient_runes", title: "Whispering Runes", rarity: "Uncommon", weight: 7, description: "The runes reveal a fragment of forgotten knowledge." },
  { id: "lucky_coin", title: "Lucky Silver Coin", rarity: "Uncommon", weight: 7, description: "A silver coin spins on the ground, refusing to fall over." },
  { id: "spirit_guide", title: "Guardian's Blessing", rarity: "Rare", weight: 5, description: "A guardian presence offers a restorative blessing." },
  { id: "crystal_shard", title: "Unstable Crystal Shard", rarity: "Rare", weight: 5, description: "A rare crystal pulses with concentrated energy." },
  { id: "treasure_map", title: "Torn Treasure Map", rarity: "Rare", weight: 4, description: "The map marks a nearby stash that someone never reclaimed." },
  { id: "cursed_altar", title: "Cursed Altar", rarity: "Rare", weight: 4, description: "A cracked altar offers wealth at a dangerous price." },
  { id: "time_rift", title: "Temporal Rift", rarity: "Epic", weight: 2, description: "A tear in time lets you glimpse battles yet to come." },
  { id: "phoenix_ember", title: "Phoenix Ember", rarity: "Epic", weight: 2, description: "A warm ember beats like a tiny, living heart." },
  { id: "glowing_chest", title: "Luminous Treasure Chest", rarity: "Legendary", weight: 1, description: "A radiant chest shines with treasure... and a sinister pulse." },
  { id: "fate_shrine", title: "Shrine of Fortune", rarity: "Legendary", weight: 1, description: "An ancient shrine offers a rare boon to those who dare approach." },
  { id: "forgotten_orb_cache", title: "Forgotten Class Orb Cache", rarity: "Rare", weight: 0.2, description: "A sealed cache hums with the power of a random class orb. Most contain common magic, but rare auras can be felt within." },
  { id: "ancient_orb_shrine", title: "Ancient Orb Shrine", rarity: "Epic", weight: 0.08, description: "An ancient shrine offers a class orb to a worthy explorer. Its rarity is left to fate." },
  { id: "mythic_orb_rift", title: "Mythic Orb Rift", rarity: "Legendary", weight: 0.015, description: "A nearly invisible rift vibrates with extraordinary class energy. Only a few ever find one." },
];

const biomeEventFlair: Record<string, string> = {
  "Emerald Grove": "emerald leaves rustle around you",
  "Whispering Woods": "the trees whisper your name",
  "Sunken Catacombs": "dust and cold mist drift through the ruins",
  "Scorching Wastes": "hot winds sweep across the scorched ground",
  "Frostbite Peaks": "ice crystals glitter in the bitter wind",
  "Misty Swamps": "strange lights dance above the murky water",
  "Volcanic Core": "embers drift through the trembling air",
  "Sky Citadel": "clouds swirl beneath the floating stonework",
  "Shadow Realm": "living shadows ripple at the edge of sight",
  "Abyssal Throne": "the abyss hums with ancient power",
};

const classes = {
  warrior: { name: "Warrior", rarity: "Common", hpBonus: 10, attackBonus: 2, defenseBonus: 2, passive: "warrior" },
  explorer: { name: "Explorer", rarity: "Common", hpBonus: 4, attackBonus: 3, defenseBonus: 1, passive: "explorer" },
  arcanist: { name: "Arcanist", rarity: "Common", hpBonus: 0, attackBonus: 6, defenseBonus: 0, passive: "arcanist" },
  duelist: { name: "Duelist", rarity: "Uncommon", hpBonus: 2, attackBonus: 4, defenseBonus: 0, passive: "duelist" },
  warden: { name: "Warden", rarity: "Rare", hpBonus: 14, attackBonus: 1, defenseBonus: 3, passive: "warden" },
  bloodweaver: { name: "Bloodweaver", rarity: "Rare", hpBonus: 3, attackBonus: 4, defenseBonus: 1, passive: "bloodweaver" },
  stormcaller: { name: "Stormcaller", rarity: "Epic", hpBonus: 1, attackBonus: 7, defenseBonus: 0, passive: "stormcaller" },
  voidstalker: { name: "Voidstalker", rarity: "Legendary", hpBonus: 5, attackBonus: 6, defenseBonus: 2, passive: "voidstalker" },
  phoenixborn: { name: "Phoenixborn", rarity: "Mythic", hpBonus: 12, attackBonus: 7, defenseBonus: 2, passive: "phoenixborn" },
  abyssal: { name: "Abyssal", rarity: "Mythic", hpBonus: 8, attackBonus: 8, defenseBonus: 3, passive: "abyssal" },
  seraphim: { name: "Seraphim", rarity: "Mythic", hpBonus: 10, attackBonus: 6, defenseBonus: 4, passive: "seraphim" },
  necromancer: { name: "Necromancer", rarity: "Legendary", hpBonus: 6, attackBonus: 5, defenseBonus: 2, passive: "necromancer" },
} as const;

const menuKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "🧭 Explore", callback_data: "explore" },
      { text: "👤 Profile", callback_data: "profile" },
    ],
    [
      { text: "🎒 Backpack", callback_data: "inventory" },
      { text: "🗺️ Places", callback_data: "places" },
    ],
    [
      { text: "🐉 Boss", callback_data: "lobby:new:boss" },
      { text: "⚔️ Duel", callback_data: "lobby:new:duel" },
      { text: "🏟️ Arena", callback_data: "lobby:new:arena" },
    ],
    [{ text: "🎰 Casino", callback_data: "casino" }],
    [{ text: "🤝 Trade", callback_data: "trade:help" }],
    [{ text: "⚙️ Settings", callback_data: "settings" }],
  ],
};

const indexKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [{ text: "⚔️ Weapons", callback_data: "index:weapons" }, { text: "🛡️ Armors", callback_data: "index:armors" }],
    [{ text: "🛡️ Off-Hands", callback_data: "index:offhands" }, { text: "🧪 Consumables", callback_data: "index:consumables" }],
    [{ text: "🔮 Class Orbs", callback_data: "index:classes" }],
    [{ text: "⬅️ Back to Menu", callback_data: "menu" }],
  ],
};
const classIndexKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [{ text: "🔴 Warrior", callback_data: "index:class:warrior" }, { text: "🟢 Explorer", callback_data: "index:class:explorer" }, { text: "🔵 Arcanist", callback_data: "index:class:arcanist" }],
    [{ text: "🟡 Duelist", callback_data: "index:class:duelist" }, { text: "🟤 Warden", callback_data: "index:class:warden" }, { text: "❤️ Bloodweaver", callback_data: "index:class:bloodweaver" }],
    [{ text: "🟣 Stormcaller", callback_data: "index:class:stormcaller" }, { text: "⚫ Voidstalker", callback_data: "index:class:voidstalker" }],
    [{ text: "🟠 Phoenixborn", callback_data: "index:class:phoenixborn" }, { text: "🟪 Abyssal", callback_data: "index:class:abyssal" }],
    [{ text: "⚪ Seraphim", callback_data: "index:class:seraphim" }, { text: "🟢 Necromancer", callback_data: "index:class:necromancer" }],
    [{ text: "⬅️ Categories", callback_data: "index" }],
  ],
};
const classIndexDetails: Record<string, string> = {
  warrior: "🔴 Warrior — Common\n❤️ HP +10 · ⚔️ ATK +2 · 🛡️ DEF +2\nPassive — Iron Will: reduces incoming attack damage by 1 (minimum 1).",
  explorer: "🟢 Explorer — Common\n❤️ HP +4 · ⚔️ ATK +3 · 🛡️ DEF +1\nPassive — Evasive Step: 5% chance to evade an attack; exploration-focused bonuses may also apply.",
  arcanist: "🔵 Arcanist — Common\n❤️ HP +0 · ⚔️ ATK +6 · 🛡️ DEF +0\nPassive — Arcane Surge: chance to empower an attack with bonus magic damage.",
  duelist: "🟡 Duelist — Uncommon\n❤️ HP +2 · ⚔️ ATK +4 · 🛡️ DEF +0\nPassive — Precision Strike: improves critical-hit chance.",
  warden: "🟤 Warden — Rare\n❤️ HP +14 · ⚔️ ATK +1 · 🛡️ DEF +3\nPassive — Guardian Shell: reduces incoming damage.",
  bloodweaver: "❤️ Bloodweaver — Rare\n❤️ HP +3 · ⚔️ ATK +4 · 🛡️ DEF +1\nPassive — Blood Pact: restores HP when dealing damage.",
  stormcaller: "🟣 Stormcaller — Epic\n❤️ HP +1 · ⚔️ ATK +7 · 🛡️ DEF +0\nPassive — Tempest Surge: can deal bonus damage when HP is low.",
  voidstalker: "⚫ Voidstalker — Legendary\n❤️ HP +5 · ⚔️ ATK +6 · 🛡️ DEF +2\nPassive — Shadow Rend: chance to deal bonus damage.",
  phoenixborn: "🟠 Phoenixborn — Mythic\n❤️ HP +12 · ⚔️ ATK +7 · 🛡️ DEF +2\nPassive — Rebirth: chance to survive a fatal hit.",
  abyssal: "🟪 Abyssal — Mythic\n❤️ HP +8 · ⚔️ ATK +8 · 🛡️ DEF +3\nPassive — Abyssal Rift: 12% chance to deal 60% bonus damage and recover up to 2 HP.",
  seraphim: "⚪ Seraphim — Mythic\n❤️ HP +10 · ⚔️ ATK +6 · 🛡️ DEF +4\nPassive — Seraphic Grace: 10% chance to deal 50% bonus damage and recover up to 3 HP.",
  necromancer: "🟢 Necromancer — Legendary\n❤️ HP +6 · ⚔️ ATK +5 · 🛡️ DEF +2\nPassive — Soul Shard: 12% chance to deal 45% bonus damage and recover up to 2 HP.",
};

const settingsKeyboard = (language: string): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: `🌐 Language: ${language === "it" ? "🇮🇹 Italiano" : "🇬🇧 English"}`, callback_data: "settings:language" }],
    [{ text: "⬅️ Back", callback_data: "menu" }],
  ],
});

const italianPhrases: Array<[string, string]> = [
  ["Exced The Wise — Visitor from the Future", "Exced il Saggio — Visitatore dal Futuro"],
  ["A sudden ripple tears through the air. An ancient sage steps out, his robes shimmering with constellations that have not yet been born.", "Un'improvvisa increspatura squarcia l'aria. Un antico saggio ne emerge, con le vesti scintillanti di costellazioni che devono ancora nascere."],
  ["I am Exced The Wise. I have crossed the ages and traveled far beyond the edges of your world. I came from the future to find you, adventurer, and leave you a gift. Your path still has a destiny to fulfill.", "Sono Exced il Saggio. Ho attraversato le ere e viaggiato ben oltre i confini del tuo mondo. Vengo dal futuro per trovarti, avventuriero, e lasciarti un dono. Il tuo cammino ha ancora un destino da compiere."],
  ["He opens his hand, revealing a gift shaped by fate. Will you accept it?", "Apre la mano, rivelando un dono plasmato dal destino. Vuoi accettarlo?"],
  ["A TIME ANOMALY APPEARS!", "È APPARSA UN'ANOMALIA TEMPORALE!"],
  ["Accept Exced's Gift", "Accetta il dono di Exced"],
  ["Exced The Wise — A Gift Beyond Time", "Exced il Saggio — Un dono oltre il tempo"],
  ["Take this, adventurer. May it guide you toward the future I have seen.", "Prendi questo, avventuriero. Possa guidarti verso il futuro che ho visto."],
  ["IMPOSSIBLE LUCK! Exced's future sight reveals two gifts for you!", "FORTUNA IMPOSSIBILE! La vista sul futuro di Exced ti rivela due doni!"],
  ["Exced offers you one gift.", "Exced ti offre un dono."],
  ["Gift ", "Dono "], ["Class Orb", "Sfera di Classe"], ["Unknown", "Sconosciuta"],
  ["10,000 Coins (no Class Orbs were available).", "10.000 monete (nessuna Sfera di Classe disponibile)."],
  ["10,000 Coins (no Tier 3+ items were available).", "10.000 monete (nessun oggetto di Tier 3 o superiore disponibile)."],
  ["10,000 Coins (the Stick was missing from the item catalog).", "10.000 monete (lo Stick non era presente nel catalogo degli oggetti)."],
  ["10,000 Coins!", "10.000 monete!"], ["Coins!", "monete!"], ["Potions!", "Pozioni!"],
  ["Our paths may never cross again, but remember: the future is shaped by what you do next.", "Forse le nostre strade non si incroceranno mai più, ma ricorda: il futuro prende forma grazie a ciò che farai."],
  ["Continue exploring", "Continua a esplorare"], ["Main menu", "Menu principale"],
  ["TIME ANOMALY", "ANOMALIA TEMPORALE"],
  ["Welcome back,", "Bentornato,"], ["You are in", "Ti trovi in"], ["What would you like to do?", "Cosa vuoi fare?"],
  ["Explore", "Esplora"], ["Profile", "Profilo"], ["Backpack", "Inventario"], ["Places", "Luoghi"], ["Boss", "Boss"], ["Duel", "Duello"], ["Sleep", "Riposa"], ["Casino", "Casinò"], ["Trade", "Scambio"],
  ["Settings", "Impostazioni"], ["Language", "Lingua"], ["English", "Inglese"], ["Italiano", "Italiano"], ["Back", "Indietro"], ["Category", "Categoria"],
  ["Your Inventory", "Il tuo inventario"], ["Weapons", "Armi"], ["Armors", "Armature"], ["Off-Hand", "Secondaria"], ["Consumables", "Consumabili"], ["Class Orbs", "Sfere Classe"],
  ["Your profile", "Il tuo profilo"], ["Level", "Livello"], ["XP", "Esperienza"], ["Coins", "Monete"], ["HP", "PV"], ["Attack", "Attacco"], ["Defense", "Difesa"],
  ["Investigate", "Esamina"], ["Leave", "Lascia"], ["Use", "Usa"], ["Equip", "Equipaggia"], ["Unequip", "Rimuovi"], ["Accept", "Accetta"], ["Cancel", "Annulla"], ["Confirm", "Conferma"],
  ["You don't have enough coins.", "Non hai abbastanza monete."], ["You are in the middle of a fight.", "Sei nel mezzo di un combattimento."], ["You are waiting in a lobby.", "Sei in attesa in una lobby."],
  ["Common", "Comune"], ["Uncommon", "Non comune"], ["Rare", "Raro"], ["Epic", "Epico"], ["Legendary", "Leggendario"], ["Mythic", "Mitico"],
  ["Your save", "Il tuo salvataggio"], ["has been deleted", "è stato eliminato"], ["No active enemy", "Nessun nemico attivo"], ["coins", "monete"], ["coins.", "monete."],
  ["Choose an option below.", "Scegli un'opzione qui sotto."], ["This item is no longer available.", "Questo oggetto non è più disponibile."], ["This exploration event has already ended.", "Questo evento di esplorazione è già terminato."],
  ["Current language:", "Lingua attuale:"], ["Choose your language.", "Scegli la tua lingua."], ["Language updated:", "Lingua aggiornata:"], ["Your personal messages will be shown in English.", "I tuoi messaggi personali saranno mostrati in inglese."], ["Your personal messages will be translated into Italian.", "I tuoi messaggi personali saranno tradotti in italiano."],
  ["You have", "Hai"], ["You need", "Ti servono"], ["You found", "Hai trovato"], ["You received", "Hai ricevuto"], ["You gained", "Hai guadagnato"], ["You lost", "Hai perso"], ["You healed", "Hai recuperato"], ["damage", "danni"], ["Health", "Salute"], ["Experience", "Esperienza"], ["Reward", "Ricompensa"], ["Rewards", "Ricompense"], ["Inventory", "Inventario"], ["Item", "Oggetto"], ["Quantity", "Quantità"], ["Price", "Prezzo"], ["Buy", "Compra"], ["Purchase", "Acquista"], ["Leave Shop", "Lascia il negozio"], ["Return to Merchant", "Torna dal mercante"], ["Wandering Merchant", "Mercante itinerante"],
  ["Combat", "Combattimento"], ["Victory", "Vittoria"], ["Defeat", "Sconfitta"], ["Attack", "Attacco"], ["Defend", "Difendi"], ["Flee", "Fuggi"], ["Your turn", "Il tuo turno"], ["Enemy turn", "Turno del nemico"], ["Critical hit", "Colpo critico"], ["You defeated", "Hai sconfitto"], ["has appeared", "è apparso"], ["Explore the area", "Esplora l'area"], ["Exploration", "Esplorazione"], ["Event", "Evento"], ["Chance", "Probabilità"], ["Rare", "Raro"], ["Epic", "Epico"],
  ["Open your inventory", "Apri il tuo inventario"], ["No items found.", "Nessun oggetto trovato."], ["You don't own this item.", "Non possiedi questo oggetto."], ["You cannot use this item in combat.", "Non puoi usare questo oggetto in combattimento."], ["You cannot equip a consumable.", "Non puoi equipaggiare un consumabile."], ["You cannot use equipment.", "Non puoi usare un equipaggiamento come consumabile."], ["The enemy attacks", "Il nemico attacca"], ["The enemy dealt", "Il nemico ha inflitto"], ["Your balance", "Il tuo saldo"], ["Enter a whole number", "Inserisci un numero intero"], ["at least", "almeno"], ["Bet", "Puntata"], ["You win", "Hai vinto"], ["You lose", "Hai perso"], ["Challenge", "Sfida"], ["has challenged you", "ti ha sfidato"], ["Accept challenge", "Accetta la sfida"], ["Join challenge", "Unisciti alla sfida"], ["The challenge has expired.", "La sfida è scaduta."],
];
const additionalItalianPhrases: Array<[string, string]> = [
  ["🧭 Explore", "🧭 Esplora"], ["👤 Profile", "👤 Profilo"], ["🎒 Backpack", "🎒 Inventario"], ["🗺️ Places", "🗺️ Luoghi"], ["😴 Sleep", "😴 Riposa"], ["⚙️ Settings", "⚙️ Impostazioni"], ["🔮 Class Orbs", "🔮 Sfere di Classe"], ["Back to Menu", "Torna al menu"], ["Categories", "Categorie"], ["🛡️ Defense", "🛡️ Difesa"], ["🎒 Inventory", "🎒 Inventario"],
  ["Lost Adventurer's Satchel", "Bisaccia dell'avventuriero perduta"], ["Ancient Waystone", "Antica pietra miliare"], ["Hidden Healing Spring", "Sorgente curativa nascosta"], ["Rare Medicinal Herbs", "Erbe medicinali rare"], ["Abandoned Coin Pouch", "Borsa di monete abbandonata"], ["Glowing Mushroom Ring", "Cerchio di funghi luminosi"], ["Forgotten Campfire", "Falò dimenticato"], ["Wandering Kind Spirit", "Spirito benevolo errante"], ["Traveling Merchant's Cache", "Nascondiglio del mercante itinerante"], ["Wandering Merchant", "Mercante itinerante"], ["Buried Cache", "Nascondiglio sepolto"], ["Whispering Runes", "Rune sussurranti"], ["Lucky Silver Coin", "Moneta d'argento fortunata"], ["Guardian's Blessing", "Benedizione del guardiano"], ["Unstable Crystal Shard", "Frammento di cristallo instabile"], ["Torn Treasure Map", "Mappa del tesoro strappata"], ["Cursed Altar", "Altare maledetto"], ["Temporal Rift", "Fenditura temporale"], ["Phoenix Ember", "Brace della fenice"], ["Luminous Treasure Chest", "Scrigno del tesoro luminoso"], ["Shrine of Fortune", "Santuario della fortuna"], ["Forgotten Class Orb Cache", "Nascondiglio dimenticato di Sfere di Classe"], ["Ancient Orb Shrine", "Antico santuario delle sfere"], ["Mythic Orb Rift", "Fenditura della sfera mitica"],
  ["Faint runes glow on a stone marker.", "Rune fioche brillano su un cippo di pietra."], ["Clear water bubbles up from a hidden spring.", "Acqua limpida sgorga da una sorgente nascosta."], ["You find useful herbs growing between the rocks.", "Trovi erbe utili che crescono tra le rocce."], ["A small pouch is half-buried in the dirt.", "Una piccola borsa è per metà sepolta nella terra."], ["A ring of strange mushrooms hums with faint magic.", "Un cerchio di strani funghi vibra di una debole magia."], ["An abandoned camp still has a few useful supplies.", "Un accampamento abbandonato conserva ancora alcune provviste utili."], ["A gentle spirit offers to share a little of its energy.", "Uno spirito benevolo ti offre parte della sua energia."], ["A merchant's hidden emergency stash has been left behind.", "È rimasta una scorta d'emergenza nascosta da un mercante."], ["A road-worn trader waves you over and opens a travelling shop. The deeper the region, the rarer the wares.", "Un mercante provato dal viaggio ti fa cenno di avvicinarti e apre un negozio itinerante. Più la regione è profonda, più rara è la merce."], ["You notice a corner of a small chest poking out of the ground.", "Noti l'angolo di un piccolo scrigno che spunta dal terreno."], ["The runes reveal a fragment of forgotten knowledge.", "Le rune rivelano un frammento di conoscenza dimenticata."], ["A silver coin spins on the ground, refusing to fall over.", "Una moneta d'argento gira sul terreno senza mai cadere."], ["A guardian presence offers a restorative blessing.", "Una presenza guardiana ti offre una benedizione rigenerante."], ["A rare crystal pulses with concentrated energy.", "Un cristallo raro pulsa di energia concentrata."], ["The map marks a nearby stash that someone never reclaimed.", "La mappa indica un nascondiglio vicino che nessuno è mai tornato a reclamare."], ["A cracked altar offers wealth at a dangerous price.", "Un altare crepato offre ricchezze a un prezzo pericoloso."], ["A tear in time lets you glimpse battles yet to come.", "Uno squarcio nel tempo ti permette di intravedere battaglie future."], ["A warm ember beats like a tiny, living heart.", "Una brace calda pulsa come un piccolo cuore vivente."], ["A radiant chest shines with treasure... and a sinister pulse.", "Uno scrigno radioso brilla di tesori... e di un impulso sinistro."], ["An ancient shrine offers a rare boon to those who dare approach.", "Un antico santuario offre un raro dono a chi osa avvicinarsi."], ["A sealed cache hums with the power of a random class orb. Most contain common magic, but rare auras can be felt within.", "Un nascondiglio sigillato vibra del potere di una Sfera di Classe casuale. La maggior parte contiene magia comune, ma al suo interno si percepiscono aure rare."], ["An ancient shrine offers a class orb to a worthy explorer. Its rarity is left to fate.", "Un antico santuario offre una Sfera di Classe a un esploratore meritevole. La sua rarità è affidata al destino."], ["A nearly invisible rift vibrates with extraordinary class energy. Only a few ever find one.", "Una fenditura quasi invisibile vibra di straordinaria energia di classe. Pochissimi riescono a trovarla."],
  ["Arena is available in group chats only.", "L'Arena è disponibile solo nelle chat di gruppo."], ["Duels need at least two players. Add me to a group chat to challenge your friends!", "I duelli richiedono almeno due giocatori. Aggiungimi a una chat di gruppo per sfidare i tuoi amici!"], ["Casino action not recognized.", "Azione del casinò non riconosciuta."], ["This Coin Flip challenge has expired. Open a new one from Casino.", "Questa sfida a testa o croce è scaduta. Aprine una nuova dal Casinò."], ["You cannot join your own challenge.", "Non puoi unirti alla tua stessa sfida."], ["Start Blackjack from Casino and enter a bet first.", "Avvia il Blackjack dal Casinò e inserisci prima una puntata."], ["This Blackjack game expired. Open Casino to start again.", "Questa partita di Blackjack è scaduta. Apri il Casinò per ricominciare."], ["Double is only available on your first two cards.", "Puoi raddoppiare solo sulle prime due carte."], ["Unknown Blackjack move.", "Mossa di Blackjack sconosciuta."], ["Push — your bet is returned.", "Pareggio: la tua puntata ti viene restituita."], ["Enter a whole-number bet of at least 1 coin.", "Inserisci una puntata in numero intero di almeno 1 moneta."], ["No active casino bet is waiting for you.", "Non c'è nessuna puntata del casinò in attesa."], ["This casino session expired. Open Casino to start again.", "Questa sessione del casinò è scaduta. Apri il Casinò per ricominciare."], ["No match — you lose your bet.", "Nessuna combinazione: perdi la puntata."], ["HEADS — you win!", "TESTA — hai vinto!"], ["TAILS — you lose.", "CROCE — hai perso."], ["The challenge cannot be settled because the other player's save is missing.", "La sfida non può essere conclusa perché manca il salvataggio dell'altro giocatore."], ["It's not your turn to enter a bet.", "Non è il tuo turno per inserire una puntata."],
  ["The wandering merchant has no wares for this region today.", "Oggi il mercante itinerante non ha merce per questa regione."], ["This merchant offer is no longer available.", "Questa offerta del mercante non è più disponibile."], ["This is not your active exploration event.", "Questo non è il tuo evento di esplorazione attivo."], ["The cache is empty; no suitable equipment is configured yet.", "Il nascondiglio è vuoto: non è ancora configurato alcun equipaggiamento adatto."], ["The magical cache is empty: no Class Orbs are configured.", "Il nascondiglio magico è vuoto: non sono configurate Sfere di Classe."], ["You uncover equipment", "Hai scoperto dell'equipaggiamento"], ["The crystal reveals", "Il cristallo rivela"], ["The map leads to", "La mappa conduce a"], ["The shard crumbles into valuable dust.", "Il frammento si sbriciola in polvere preziosa."], ["The chest erupts with cursed light! You lose ", "Lo scrigno esplode in una luce maledetta! Perdi "], ["The shrine grants 50 XP.", "Il santuario concede 50 punti esperienza."], ["Fortune smiles on you: you also recover ", "La fortuna ti sorride: recuperi anche "], ["Restore up to 3 HP whenever you attack.", "Recupera fino a 3 PV ogni volta che attacchi."], ["Take 1 less damage from enemy attacks (minimum 1).", "Subisci 1 danno in meno dagli attacchi nemici (minimo 1)."], ["Take 3 less damage from enemy attacks (minimum 1).", "Subisci 3 danni in meno dagli attacchi nemici (minimo 1)."], ["Deal 35% more damage while at 40% HP or lower.", "Infliggi il 35% di danni in più quando hai il 40% dei PV o meno."], ["Balanced combat training.", "Addestramento equilibrato al combattimento."], ["No bonuses", "Nessun bonus"], ["Jobless", "Senza classe"], ["Adventurer", "Avventuriero"], ["Invalid slot.", "Slot non valido."], ["The orb will be consumed.", "La sfera verrà consumata."], ["You can't change equipment during combat.", "Non puoi cambiare equipaggiamento durante il combattimento."], ["You don't own an item with that ID.", "Non possiedi un oggetto con questo ID."], ["You can't use a Class Orb during combat.", "Non puoi usare una Sfera di Classe durante il combattimento."], ["You don't own this Class Orb.", "Non possiedi questa Sfera di Classe."], ["Use /equip ID for weapons, armor or off-hand items, /use ID for consumables, and /orb ID for Class Orbs.", "Usa /equip ID per armi, armature o oggetti secondari, /use ID per i consumabili e /orb ID per le Sfere di Classe."], ["No weapons found.", "Nessuna arma trovata."], ["No armor found.", "Nessuna armatura trovata."], ["No off-hand items found.", "Nessun oggetto secondario trovato."], ["No consumables found.", "Nessun consumabile trovato."], ["No Class Orbs found.", "Nessuna Sfera di Classe trovata."], ["During a fight use Attack, Inventory or Flee. Using a consumable with /use ID spends your turn and the enemy will strike back.", "Durante un combattimento usa Attacca, Inventario o Fuggi. Usare un consumabile con /use ID consuma il tuo turno e il nemico contrattaccherà."],
];

function translateReply(reply: Reply, language: string): Reply {
  if (language !== "it") return reply;
  const translate = (input: string) => {
    let output = input;
    for (const [en, it] of [...italianPhrases, ...additionalItalianPhrases]) output = output.split(en).join(it);
    return output;
  };
  return { ...reply, text: translate(reply.text), keyboard: reply.keyboard ? { ...reply.keyboard, inline_keyboard: reply.keyboard.inline_keyboard.map(row => row.map(button => ({ ...button, text: translate(button.text) }))) } : undefined };
}

const slotByItemType: Partial<Record<Item["type"], EquipmentSlot>> = {
  Weapons: "weapon",
  Armors: "armor",
  "Off-Hand": "off-hand",
};

const slotLabels: Record<EquipmentSlot, string> = {
  weapon: "Weapon",
  armor: "Armor",
  "off-hand": "Off-Hand",
};

// Rest cost: coins per missing HP (rounded up, minimum 1).
// Max HP already includes the HP bonuses of the equipped armor.
const SLEEP_COST_PER_HP = 0.5;

function sleepCost(missingHp: number): number {
  return Math.max(1, Math.ceil(missingHp * SLEEP_COST_PER_HP));
}

async function combatKeyboardFor(tx: Tx, player: TelegramPlayer): Promise<InlineKeyboardMarkup> {
  const equipped = await getEquippedItems(tx, player);
  const hasShield = equipped.some(
    (item) => item.type === "Off-Hand" && /shield/i.test(item.name),
  );
  const actions = [
    { text: "⚔️ Attack", callback_data: "attack" },
    { text: "🎒 Inventory", callback_data: "combat:inventory" },
  ];
  if (hasShield) actions.push({ text: "🛡️ Defense", callback_data: "defense" });
  return {
    inline_keyboard: [actions, [{ text: "🏃 Flee", callback_data: "flee" }]],
  };
}

function getIncomingEvent(update: TelegramUpdate): IncomingEvent | null {
  const message = update.message;
  const callback = update.callback_query;
  const newChatMembers = (message?.new_chat_members ?? [])
    .filter((member) => !member.is_bot)
    .map((member) => ({
      id: String(member.id),
      firstName: member.first_name || member.username || "Adventurer",
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
      firstName: actorSource.first_name || actorSource.username || "Adventurer",
      username: actorSource.username ?? null,
    },
    chatId: String(chat.id),
    responseChatId: String(chat.id),
    chatType: chat.type,
    newChatMembers,
    callbackQueryId: callback?.id ?? null,
    messageId: message?.message_id ?? null,
    text: message?.text ?? null,
    callbackData: callback?.data ?? null,
  };
}

function button(text: string, callbackData: string) {
  return { text, callback_data: callbackData };
}

function adminKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [
    [button("📊 Bot statistics", "admin:stats")],
    [button("🔎 Player lookup", "admin:lookup"), button("🎁 Manage resources", "admin:resources")],
    [button("❔ Admin help", "admin:help")],
    [button("⬅️ Back", "menu")],
  ] };
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

type ClassId = keyof typeof classes;

function isClassId(value: unknown): value is ClassId {
  return typeof value === "string" && Object.hasOwn(classes, value);
}

// class_id is the source of truth; older saves fall back to the name in `archetype`.
function classIdOf(player: TelegramPlayer): ClassId | null {
  if (isClassId(player.classId)) return player.classId;
  const legacy = (Object.keys(classes) as ClassId[]).find(
    (key) => classes[key].name === player.archetype,
  );
  return legacy ?? null;
}

function classLabel(player: TelegramPlayer): string {
  const classId = classIdOf(player);
  return classId ? classes[classId].name : "Jobless";
}

function classStats(classId: ClassId, level: number) {
  const base = baseStats(level);
  const bonuses = classes[classId];
  return {
    hp: base.hp + bonuses.hpBonus,
    attack: base.attack + bonuses.attackBonus,
    defense: base.defense + bonuses.defenseBonus,
  };
}

// Aliases accepted in the stats.class_id field of orbs.
const classAliases: Record<string, ClassId> = {
  mage: "arcanist",
  archer: "explorer",
  ranger: "explorer",
  angel: "seraphim",
  seraphimorb: "seraphim",
};

function classPassive(player: TelegramPlayer) {
  const id = classIdOf(player);
  return id ? classes[id].passive : "steady";
}

function incomingCombatDamage(player: TelegramPlayer, enemy: CombatState): number {
  const passive = classPassive(player);
  if (passive === "explorer" && Math.random() < 0.05) return 0;
  const reduction = passive === "warden" ? 3 : passive === "warrior" ? 1 : 0;
  return Math.max(1, enemy.attack + randomInt(0, 2) - player.defense - reduction);
}

function normalizeClassId(value: unknown): ClassId | null {
  if (typeof value !== "string") return null;
  if (isClassId(value)) return value;
  return classAliases[value.toLowerCase()] ?? null;
}

function orbClassId(stats: Item["stats"], orbName = ""): ClassId | null {
  const configured = normalizeClassId(stats.class_id);
  if (configured) return configured;
  // Legacy catalog entries may have no class_id (or an obsolete value).
  // Infer the class from the orb name so older Abyssal Orbs remain usable.
  const name = orbName.toLowerCase();
  if (/necromancer|necro/.test(name)) return "necromancer";
  if (/abyssal/.test(name)) return "abyssal";
  if (/necromancer|necro/.test(name)) return "necromancer";
  if (/seraphim|seraphic|angelic/.test(name)) return "seraphim";
  if (/arcanist|mage/.test(name)) return "arcanist";
  if (/warrior|fighter/.test(name)) return "warrior";
  if (/explorer|ranger|archer/.test(name)) return "explorer";
  if (/duelist/.test(name)) return "duelist";
  if (/warden/.test(name)) return "warden";
  if (/bloodweaver/.test(name)) return "bloodweaver";
  if (/stormcaller/.test(name)) return "stormcaller";
  if (/voidstalker/.test(name)) return "voidstalker";
  if (/phoenixborn|phoenix/.test(name)) return "phoenixborn";
  return null;
}

// Class Orbs have rarity-based chances independent from biome drop tables.
const orbDropChance: Record<string, { mob: number; boss: number }> = {
  Common: { mob: 0.01, boss: 0.05 },
  Uncommon: { mob: 0.006, boss: 0.03 },
  Rare: { mob: 0.003, boss: 0.015 },
  Epic: { mob: 0.0015, boss: 0.008 },
  Legendary: { mob: 0.0007, boss: 0.004 },
  Mythic: { mob: 0.00025, boss: 0.0015 },
};

function playerScope(event: IncomingEvent) {
  return and(
    eq(telegramPlayersTable.telegramId, event.actor.id),
    eq(telegramPlayersTable.chatId, event.chatId),
  );
}

function formatProfile(player: TelegramPlayer): string {
  const region = getRegion(player.biomeId);
  const nextLevelXp = xpToNext(player.level);
  const combatLine = player.combat
    ? `\n\nIn combat: ${player.combat.name} (${player.combat.hp}/${player.combat.maxHp} HP)`
    : "";
  const titles = [
    isSystemOwner(player.telegramId) ? "👑 [System Owner]" : "",
    player.telegramId === "681549636" ? "🧪 [First Tester]" : "",
    player.telegramId === "7398484644" ? "🧪 [Special Tester]" : "",
  ].filter(Boolean);
  const header = `📜 User character sheet${titles.length ? `\n\n${titles.join("\n")}` : ""}`;
  const details = [
    `Name: ${player.characterName}`,
    "",
    `${classLabel(player)} · Level ${player.level}`,
    "",
    `Experience: ${player.xp}/${nextLevelXp} XP`,
    "",
    `♻️ Rebirths: ${player.rebirths} · 🪙 rCoins: ${player.rCoins}`,
    `✨ XP bonus: +${player.rebirths * 5}% · 💰 Gold bonus: +${player.rebirths * 5}%`,
    "",
    `❤️ Health: ${player.hp}/${player.maxHp} HP`,
    `⚔️ Attack: ${player.attack} · 🛡️ Defense: ${player.defense}`,
    "",
    `Biome: ${region.name}`,
  ].join("\n");
  return `${header}\n\n${details}${combatLine}`;
}

const passiveDescriptions: Record<string, string> = {
  steady: "Balanced combat training.",
  warrior: "Take 1 less damage from enemy attacks (minimum 1).",
  explorer: "5% chance to evade an enemy attack completely.",
  arcanist: "15% chance to deal 25% bonus damage on an attack.",
  duelist: "+12% critical-hit chance.",
  warden: "Take 3 less damage from enemy attacks (minimum 1).",
  bloodweaver: "Restore up to 3 HP whenever you attack.",
  stormcaller: "Deal 35% more damage while at 40% HP or lower.",
  voidstalker: "18% chance to deal 75% bonus damage on an attack.",
  phoenixborn: "35% chance to survive a fatal enemy hit with 1 HP.",
  abyssal: "12% chance to unleash an Abyssal Rift, dealing 60% bonus damage and restoring 2 HP.",
  seraphim: "10% chance to unleash Seraphic Grace, dealing 50% bonus damage and restoring 3 HP.",
  necromancer: "12% chance to raise a soul shard, dealing 45% bonus damage and restoring 2 HP.",
};

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
  const orbClass = orbClassId(item.stats);
  const orbColor: Record<ClassId, string> = {
    warrior: "🔴", explorer: "🟢", arcanist: "🔵", duelist: "🟡",
    warden: "🟤", bloodweaver: "❤️", stormcaller: "🟣", voidstalker: "⚫", phoenixborn: "🟠", abyssal: "🟪", seraphim: "⚪", necromancer: "🟩",
  };
  const classLine = orbClass ? `\n  ${orbColor[orbClass]} Class: ${classes[orbClass].name} (${classes[orbClass].rarity})\n  Passive: ${passiveDescriptions[classes[orbClass].passive]}` : "";
  const effect = item.passiveOrEffect
    ? `\n  Effect: ${item.passiveOrEffect}`
    : "";

  const rarityIcon: Record<string, string> = {
    Common: "⚪",
    Uncommon: "🟢",
    Rare: "🔵",
    Epic: "🟣",
    Legendary: "🟠",
    Mythic: "🔴",
  };
  return [
    `${rarityIcon[item.rarity] ?? "⚪"} ${item.name}${quantityLabel} — ${item.rarity} · Tier ${item.tier}`,
    `  ${stats.length > 0 ? stats.join(" · ") : "No bonuses"}`,
  ].join("\n") + classLine + effect;
}

async function getOwnedInventoryItems(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  player: TelegramPlayer,
) {
  return tx
    .select({
      inventoryId: telegramPlayerInventoryTable.inventoryId,
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getEquippedItems(tx: Tx, player: TelegramPlayer) {
  return tx
    .select({
      slot: telegramPlayerEquipmentTable.slot,
      itemId: itemsTable.itemId,
      name: itemsTable.name,
      type: itemsTable.type,
      tier: itemsTable.tier,
      rarity: itemsTable.rarity,
      stats: itemsTable.stats,
      passiveOrEffect: itemsTable.passiveOrEffect,
    })
    .from(telegramPlayerEquipmentTable)
    .innerJoin(
      itemsTable,
      eq(telegramPlayerEquipmentTable.itemId, itemsTable.itemId),
    )
    .where(
      and(
        eq(telegramPlayerEquipmentTable.telegramId, player.telegramId),
        eq(telegramPlayerEquipmentTable.chatId, player.chatId),
      ),
    );
}

function statBonuses(stats: Item["stats"]) {
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  return {
    hp: Math.trunc(num(stats.hp)),
    atk: Math.trunc(num(stats.atk)),
    def: Math.trunc(num(stats.def)),
  };
}

async function getCritChance(tx: Tx, player: TelegramPlayer): Promise<number> {
  const equipped = await getEquippedItems(tx, player);
  const total = equipped.reduce((sum, item) => {
    const crit = item.stats.crit_rate;
    return sum + (typeof crit === "number" ? crit : 0);
  }, 0);
  return clamp(total, 0, 1);
}

const inventoryCategories = ["Weapons", "Armors", "Off-Hand", "Consumables", "ClassOrb"] as const;
type InventoryCategory = (typeof inventoryCategories)[number];

function isInventoryCategory(value: string | undefined): value is InventoryCategory {
  return !!value && (inventoryCategories as readonly string[]).includes(value);
}

async function backpackReply(
  tx: Tx,
  player: TelegramPlayer,
  notice?: string,
  category: InventoryCategory = "Weapons",
): Promise<Reply> {
  const ownedItems = await getOwnedInventoryItems(tx, player);
  const equipped = await getEquippedItems(tx, player);
  const equippedBySlot = new Map(equipped.map((item) => [item.slot, item]));
  const equippedIds = new Set(equipped.map((item) => item.itemId));
  const equipmentLines = (["weapon", "armor", "off-hand"] as const).map((slot) => {
    const item = equippedBySlot.get(slot);
    return item ? `${slotLabels[slot]}: ${formatItem(item)}` : `${slotLabels[slot]}: —`;
  });
  const visibleItems = ownedItems.filter((item) => item.type === category);
  // Legacy healing potions are stored as a player counter rather than catalog inventory rows.
  // Expose them through a stable virtual inventory ID so they remain usable with /use.
  const LEGACY_POTION_INVENTORY_ID = 999;
  const categoryIndex = inventoryCategories.indexOf(category);
  const nextCategory = inventoryCategories[(categoryIndex + 1) % inventoryCategories.length]!;
  const itemLines = visibleItems.length > 0 ? visibleItems.map((item) => {
    const equippedLabel = equippedIds.has(item.itemId) ? " · [Equipped]" : "";
    const command = item.type === "Weapons" || item.type === "Armors" || item.type === "Off-Hand"
      ? `/equip ${item.inventoryId}`
      : item.type === "Consumables" ? `/use ${item.inventoryId}` : `/orb ${item.inventoryId}`;
    return `#${item.inventoryId} · ${formatItem(item, item.quantity)}${equippedLabel}\n  ${command}`;
  }) : [category === "Weapons" ? "No weapons found." : category === "Armors" ? "No armor found." : category === "Off-Hand" ? "No off-hand items found." : category === "Consumables" ? "No consumables found." : "No Class Orbs found."];
  if (category === "Consumables" && player.potions > 0) {
    itemLines.push(`#${LEGACY_POTION_INVENTORY_ID} · 🧪 Healing Potion ×${player.potions} — Common\n  /use ${LEGACY_POTION_INVENTORY_ID}`);
  }

  return {
    text: [
      ...(notice ? [notice, ""] : []),
      `🎒 ${player.characterName}'s Inventory`,
      `⚔️ Attack: ${player.attack} · 🛡️ Defense: ${player.defense} · ❤️ Max HP: ${player.maxHp}`,
      "",
      "🛡️ EQUIPPED",
      ...equipmentLines,
      "",
      `📂 CATEGORY: ${category.toUpperCase()}`,
      ...itemLines,
      "",
      "Use /equip ID for weapons, armor or off-hand items, /use ID for consumables, and /orb ID for Class Orbs.",
      `🧪 Healing potions: ${player.potions}`,
      `💰 Coins: ${player.coins}`,
    ].join("\n"),
    keyboard: { inline_keyboard: [[button("Category", `inventory:category:${nextCategory}`)], [button("⬅️ Back", "menu")]] },
  };
}

async function equipItem(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  inventoryId: number,
): Promise<Reply> {
  if (player.combat) {
    return backpackReply(tx, player, "You can't change equipment during combat.");
  }

  const [owned] = await tx
    .select({
      inventoryId: telegramPlayerInventoryTable.inventoryId,
      itemId: itemsTable.itemId,
      name: itemsTable.name,
      type: itemsTable.type,
      stats: itemsTable.stats,
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
        eq(telegramPlayerInventoryTable.inventoryId, inventoryId),
      ),
    )
    .limit(1);
  if (!owned) return backpackReply(tx, player, "You don't own an item with that ID.");

  const slot = slotByItemType[owned.type];
  if (!slot) {
    return backpackReply(tx, player, `${owned.name} can't be equipped.`);
  }

  const equipped = await getEquippedItems(tx, player);
  const current = equipped.find((item) => item.slot === slot);
  if (current?.itemId === owned.itemId) {
    return backpackReply(tx, player, `${owned.name} is already equipped.`);
  }

  const removed = current ? statBonuses(current.stats) : { hp: 0, atk: 0, def: 0 };
  const added = statBonuses(owned.stats);
  const maxHp = Math.max(1, player.maxHp - removed.hp + added.hp);
  const updates = {
    maxHp,
    hp: clamp(player.hp - removed.hp + added.hp, 1, maxHp),
    attack: Math.max(0, player.attack - removed.atk + added.atk),
    defense: Math.max(0, player.defense - removed.def + added.def),
  };

  await tx
    .insert(telegramPlayerEquipmentTable)
    .values({
      telegramId: player.telegramId,
      chatId: player.chatId,
      slot,
      itemId: owned.itemId,
    })
    .onConflictDoUpdate({
      target: [
        telegramPlayerEquipmentTable.telegramId,
        telegramPlayerEquipmentTable.chatId,
        telegramPlayerEquipmentTable.slot,
      ],
      set: { itemId: owned.itemId, equippedAt: new Date() },
    });
  const [updated] = await tx
    .update(telegramPlayersTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(playerScope(event))
    .returning();
  return backpackReply(
    tx,
    updated ?? player,
    `✅ You equip ${owned.name}.`,
  );
}

async function unequipSlot(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  slotKey: string,
): Promise<Reply> {
  if (slotKey !== "weapon" && slotKey !== "armor") {
    return backpackReply(tx, player, "Invalid slot.");
  }
  if (player.combat) {
    return backpackReply(
      tx,
      player,
      "You can't change equipment during combat.",
    );
  }
  const equipped = await getEquippedItems(tx, player);
  const current = equipped.find((item) => item.slot === slotKey);
  if (!current) {
    return backpackReply(tx, player, `Nothing equipped in the ${slotLabels[slotKey].toLowerCase()} slot.`);
  }

  const removed = statBonuses(current.stats);
  const maxHp = Math.max(1, player.maxHp - removed.hp);
  await tx
    .delete(telegramPlayerEquipmentTable)
    .where(
      and(
        eq(telegramPlayerEquipmentTable.telegramId, player.telegramId),
        eq(telegramPlayerEquipmentTable.chatId, player.chatId),
        eq(telegramPlayerEquipmentTable.slot, slotKey),
      ),
    );
  const [updated] = await tx
    .update(telegramPlayersTable)
    .set({
      maxHp,
      hp: clamp(player.hp - removed.hp, 1, maxHp),
      attack: Math.max(0, player.attack - removed.atk),
      defense: Math.max(0, player.defense - removed.def),
      updatedAt: new Date(),
    })
    .where(playerScope(event))
    .returning();
  return backpackReply(tx, updated ?? player, `➖ You remove ${current.name}.`);
}

async function recalculateStats(
  tx: Tx,
  player: TelegramPlayer,
  classId: ClassId,
  level: number,
) {
  const stats = classStats(classId, level);
  const equipped = await getEquippedItems(tx, player);
  const bonus = equipped.reduce(
    (sum, item) => {
      const b = statBonuses(item.stats);
      return { hp: sum.hp + b.hp, atk: sum.atk + b.atk, def: sum.def + b.def };
    },
    { hp: 0, atk: 0, def: 0 },
  );
  return {
    maxHp: Math.max(1, stats.hp + bonus.hp),
    attack: Math.max(0, stats.attack + bonus.atk),
    defense: Math.max(0, stats.defense + bonus.def),
  };
}

async function useOrb(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  inventoryId: number,
  confirmed: boolean,
): Promise<Reply> {
  if (player.combat) {
    return backpackReply(tx, player, "You can't use a Class Orb during combat.");
  }
  const [orb] = await tx
    .select({
      itemId: itemsTable.itemId,
      name: itemsTable.name,
      type: itemsTable.type,
      stats: itemsTable.stats,
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
        eq(telegramPlayerInventoryTable.inventoryId, inventoryId),
      ),
    )
    .limit(1);
  if (!orb || orb.type !== "ClassOrb") {
    return backpackReply(tx, player, "You don't own this Class Orb.");
  }
  const newClassId = orbClassId(orb.stats, orb.name);
  if (!newClassId) {
    return backpackReply(tx, player, `${orb.name} isn't linked to any class yet.`);
  }

  const currentClassId = classIdOf(player);
  if (currentClassId === newClassId) {
    return backpackReply(tx, player, `Your class is already ${classes[newClassId].name}.`);
  }

  if (currentClassId && !confirmed) {
    return {
      text: [
        `Using ${orb.name} will change your class to ${classes[newClassId].name} (currently ${classes[currentClassId].name}).`,
        `Warning: your level will be reset to 1 (currently ${player.level}) and your experience to 0.`,
        "The orb will be consumed.",
      ].join("\n"),
      keyboard: {
        inline_keyboard: [
          [button("✅ Confirm", `orbok:${inventoryId}`)],
          [button("❌ Cancel", "inventory")],
          [button("⬅️ Back", "menu")],
        ],
      },
    };
  }

  const level = 1;
  const stats = await recalculateStats(tx, player, newClassId, level);
  const biomeId = getRegion(player.biomeId).level > level ? 1 : player.biomeId;
  const [updated] = await tx
    .update(telegramPlayersTable)
    .set({
      classId: newClassId,
      archetype: classes[newClassId].name,
      level,
      xp: 0,
      maxHp: stats.maxHp,
      hp: stats.maxHp,
      attack: stats.attack,
      defense: stats.defense,
      biomeId,
      updatedAt: new Date(),
    })
    .where(playerScope(event))
    .returning();

  if (orb.quantity > 1) {
    await tx
      .update(telegramPlayerInventoryTable)
      .set({ quantity: orb.quantity - 1 })
      .where(
        and(
          eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
          eq(telegramPlayerInventoryTable.chatId, player.chatId),
          eq(telegramPlayerInventoryTable.itemId, orb.itemId),
        ),
      );
  } else {
    await tx
      .delete(telegramPlayerInventoryTable)
      .where(
        and(
          eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
          eq(telegramPlayerInventoryTable.chatId, player.chatId),
          eq(telegramPlayerInventoryTable.itemId, orb.itemId),
        ),
      );
  }

  const final = updated ?? player;
  return {
    text: [
      `🔮 You use ${orb.name} and your class becomes ${classes[newClassId].name}!`,
      `Level ${final.level} · ${final.maxHp} HP, attack ${final.attack}, defense ${final.defense}.`,
    ].join("\n"),
    keyboard: menuKeyboard,
  };
}

async function grantDropNames(
  tx: Tx,
  player: TelegramPlayer,
  dropTable: ItemDrop[] | undefined,
  isBoss: boolean,
): Promise<string[]> {
  const rolled = (dropTable ?? []).filter((drop) => Math.random() < drop.chance);

  // Class Orbs don't follow the mobs' drop_table: they have dedicated chances.
  const orbs = await tx
    .select({ itemId: itemsTable.itemId, stats: itemsTable.stats })
    .from(itemsTable)
    .where(eq(itemsTable.type, "ClassOrb"));
  const orbIds = new Set(orbs.map((orb) => orb.itemId));
  const wonIds = new Set(
    rolled.map((drop) => drop.itemId).filter((id) => !orbIds.has(id)),
  );
  for (const orb of orbs) {
    const classId = orbClassId(orb.stats);
    if (!classId) continue;
    const rarity = classes[classId].rarity;
    // Abyssal is a true ultra-rare Mythic: far rarer than other Mythic orbs.
    const baseChance = classId === "abyssal"
      ? (isBoss ? 0.00015 : 0.000025) // 0.015% boss, 0.0025% regular mob
      : (orbDropChance[rarity] ?? orbDropChance.Rare!)[isBoss ? "boss" : "mob"];
    // Keep the starter trio accessible; all advanced class orbs are rarer.
    // Mage and Archer are aliases for Arcanist and Explorer respectively.
    const isStarterClass = ["warrior", "arcanist", "explorer"].includes(classId);
    const chance = isStarterClass ? baseChance : baseChance * 0.1;
    if (Math.random() < chance) wonIds.add(orb.itemId);
  }
  if (wonIds.size === 0) return [];

  const rows = await tx
    .select({ itemId: itemsTable.itemId, name: itemsTable.name })
    .from(itemsTable)
    .where(inArray(itemsTable.itemId, [...wonIds]));
  const lines: string[] = [];
  for (const row of rows) {
    await tx
      .insert(telegramPlayerInventoryTable)
      .values({
        telegramId: player.telegramId,
        chatId: player.chatId,
        itemId: row.itemId,
      })
      .onConflictDoUpdate({
        target: [
          telegramPlayerInventoryTable.telegramId,
          telegramPlayerInventoryTable.chatId,
          telegramPlayerInventoryTable.itemId,
        ],
        set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` },
      });
    lines.push(row.name);
  }
  return lines;
}

async function grantDrops(
  tx: Tx,
  player: TelegramPlayer,
  dropTable: ItemDrop[] | undefined,
  isBoss: boolean,
): Promise<string[]> {
  const names = await grantDropNames(tx, player, dropTable, isBoss);
  return names.map((name) => `🎁 You find: ${name}!`);
}

async function grantShadowCloneReward(tx: Tx, player: TelegramPlayer): Promise<string[]> {
  const eligible = await tx
    .select({ itemId: itemsTable.itemId, name: itemsTable.name, tier: itemsTable.tier })
    .from(itemsTable)
    .where(sql`${itemsTable.tier} >= 2`);
  if (eligible.length === 0) {
    return ["⚠️ No tier 2+ items are configured in the item catalog, so the guaranteed drop could not be granted."];
  }
  const guaranteed = eligible[randomInt(0, eligible.length - 1)]!;
  const won = [guaranteed];
  // A small lucky chance to receive a second high-tier item.
  if (eligible.length > 1 && Math.random() < 0.12) {
    const extras = eligible.filter((item) => item.itemId !== guaranteed.itemId);
    won.push(extras[randomInt(0, extras.length - 1)]!);
  }
  for (const item of won) {
    await tx.insert(telegramPlayerInventoryTable).values({
      telegramId: player.telegramId,
      chatId: player.chatId,
      itemId: item.itemId,
    }).onConflictDoUpdate({
      target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId],
      set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` },
    });
  }
  return won.map((item, index) => index === 0
    ? `🌑 Guaranteed drop: ${item.name} (Tier ${item.tier})!`
    : `🍀 Lucky bonus drop: ${item.name} (Tier ${item.tier})!`);
}

async function resolveShadowCloneDefeat(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  enemy: CombatState,
): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
  const coinsLost = Math.floor(player.coins * 0.3);
  const level = Math.max(0, player.level - 1);
  const maxHp = Math.max(1, player.maxHp - (player.level > 0 ? 5 : 0));
  const attack = Math.max(0, player.attack - (player.level > 0 ? 1 : 0));
  const defense = Math.max(0, player.defense - (player.level > 0 && player.level % 2 === 0 ? 1 : 0));
  const xp = Math.min(player.xp, Math.max(0, xpToNext(level) - 1));
  const coins = player.coins - coinsLost;
  await tx.update(telegramPlayersTable).set({
    combat: null, level, xp, maxHp, hp: maxHp, attack, defense, coins, updatedAt: new Date(),
  }).where(playerScope(event));
  return {
    text: [
      `🌑 ${enemy.name} defeats you. The Shadow Clone drains your strength as you respawn.`,
      `⬇️ You lose one level (${player.level} → ${level}) and 30% of your coins (${coinsLost} lost, ${coins} remaining).`,
      `❤️ You respawn with full health: ${maxHp} HP.`,
    ].join("\n"),
    keyboard: menuKeyboard,
  };
}

const casinoKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [
    [button("🪙 Coin Flip · Solo", "casino:coin:solo"), button("🪙 Coin Flip · Versus", "casino:coin:versus")],
    [button("🃏 Blackjack", "casino:blackjack"), button("🎰 Slot Machine", "casino:slots")],
    [button("⬅️ Back", "menu")],
  ],
};

function casinoBackKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[button("⬅️ Back", "casino")], [button("🏠 Menu", "menu")]] };
}

function cardValue(card: number): number { return Math.min(card, 10); }
function handValue(hand: number[]): number {
  let total = hand.reduce((sum, card) => sum + cardValue(card), 0);
  let aces = hand.filter((card) => card === 1).length;
  while (aces > 0 && total + 10 <= 21) { total += 10; aces--; }
  return total;
}
function drawCard(deck: number[]): number { return deck.pop() ?? randomInt(1, 13); }
function handText(hand: number[]): string {
  const names = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  return hand.map((card) => names[card] ?? "?").join(" · ");
}

async function activeCasinoSession(tx: Tx, chatId: string, ownerId: string, game?: "coinflip" | "blackjack" | "slots") {
  const rows = await tx.select().from(telegramCasinoSessionsTable).where(and(
    eq(telegramCasinoSessionsTable.chatId, chatId), or(eq(telegramCasinoSessionsTable.ownerId, ownerId), eq(telegramCasinoSessionsTable.opponentId, ownerId)),
    eq(telegramCasinoSessionsTable.status, "active"), ...(game ? [eq(telegramCasinoSessionsTable.game, game)] : []),
  )).orderBy(asc(telegramCasinoSessionsTable.id)).limit(1);
  return rows[0] ?? null;
}

async function closePlayerCasinoSessions(tx: Tx, event: IncomingEvent): Promise<void> {
  const sessions = await tx.select({ id: telegramCasinoSessionsTable.id }).from(telegramCasinoSessionsTable).where(and(
    eq(telegramCasinoSessionsTable.chatId, event.chatId),
    or(eq(telegramCasinoSessionsTable.ownerId, event.actor.id), eq(telegramCasinoSessionsTable.opponentId, event.actor.id)),
    inArray(telegramCasinoSessionsTable.status, ["open", "active"]),
  ));
  for (const session of sessions) {
    await tx.update(telegramCasinoSessionsTable).set({ status: "finished", updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
  }
}

async function casinoReply(tx: Tx, event: IncomingEvent, player: TelegramPlayer): Promise<Reply> {
  const callback = event.callbackData;
  if (callback === "casino") return { text: `🎰 Casino\nYour balance: ${player.coins} coins. Choose a game.`, keyboard: casinoKeyboard };
  if (callback === "casino:coin:solo" || callback === "casino:slots") {
    const game = callback === "casino:slots" ? "slots" : "coinflip";
    await closePlayerCasinoSessions(tx, event);
    await tx.insert(telegramCasinoSessionsTable).values({ chatId: event.chatId, game, ownerId: event.actor.id, status: "active", expiresAt: new Date(Date.now() + 10 * 60_000), state: { phase: "bet", ownerName: player.characterName } });
    return { text: `${game === "slots" ? "🎰 Slot Machine" : "🪙 Coin Flip"}\nYour balance: ${player.coins} coins. Send the number of coins you want to bet (minimum 1).`, keyboard: casinoBackKeyboard() };
  }
  if (callback === "casino:coin:versus") {
    await closePlayerCasinoSessions(tx, event);
    const [session] = await tx.insert(telegramCasinoSessionsTable).values({ chatId: event.chatId, game: "coinflip", ownerId: event.actor.id, status: "open", expiresAt: new Date(Date.now() + 30_000), state: { phase: "join", ownerName: player.characterName } }).returning();
    return { text: `🪙 Coin Flip challenge by ${player.characterName}! Another player has 30 seconds to join. Both players will then enter their own bets.`, keyboard: { inline_keyboard: [[button("🤝 Join challenge", `casino:coin:join:${session!.id}`)], [button("⬅️ Back", "casino")]] } };
  }
  if (callback === "casino:blackjack") {
    await closePlayerCasinoSessions(tx, event);
    await tx.insert(telegramCasinoSessionsTable).values({ chatId: event.chatId, game: "blackjack", ownerId: event.actor.id, status: "active", expiresAt: new Date(Date.now() + 10 * 60_000), state: { phase: "bet", ownerName: player.characterName } });
    return { text: `🃏 Blackjack\nYour balance: ${player.coins} coins. Send your bet (minimum 1). After the bet, use Hit, Stand or Double.`, keyboard: casinoBackKeyboard() };
  }
  if (callback?.startsWith("casino:coin:join:")) {
    const id = Number(callback.split(":").pop());
    const [session] = await tx.select().from(telegramCasinoSessionsTable).where(and(eq(telegramCasinoSessionsTable.id, id), eq(telegramCasinoSessionsTable.chatId, event.chatId), eq(telegramCasinoSessionsTable.game, "coinflip"), eq(telegramCasinoSessionsTable.status, "open"))).limit(1);
    if (!session || session.expiresAt.getTime() < Date.now()) return { text: "This Coin Flip challenge has expired. Open a new one from Casino.", keyboard: casinoKeyboard };
    if (session.ownerId === event.actor.id) return { text: "You cannot join your own challenge.", keyboard: casinoKeyboard };
    await closePlayerCasinoSessions(tx, event);
    await tx.update(telegramCasinoSessionsTable).set({ opponentId: event.actor.id, status: "active", expiresAt: new Date(Date.now() + 10 * 60_000), state: { phase: "host_bet", ownerName: session.state.ownerName, opponentName: player.characterName } }).where(eq(telegramCasinoSessionsTable.id, id));
    return { text: `🤝 ${player.characterName} joined ${session.state.ownerName}'s Coin Flip! Both players must send their bets in turn. ${session.state.ownerName}, enter your bet first.`, keyboard: casinoBackKeyboard() };
  }
  if (callback?.startsWith("casino:bj:")) return blackjackAction(tx, event, player, callback.split(":").pop() ?? "");
  return { text: "Casino action not recognized.", keyboard: casinoKeyboard };
}

async function blackjackAction(tx: Tx, event: IncomingEvent, player: TelegramPlayer, action: string): Promise<Reply> {
  const session = await activeCasinoSession(tx, event.chatId, event.actor.id, "blackjack");
  if (!session || session.state.phase !== "blackjack") return { text: "Start Blackjack from Casino and enter a bet first.", keyboard: casinoKeyboard };
  if (session.expiresAt.getTime() < Date.now()) {
    await tx.update(telegramCasinoSessionsTable).set({ status: "finished", updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: "This Blackjack game expired. Open Casino to start again.", keyboard: casinoKeyboard };
  }
  const state = { ...session.state };
  const hand = [...(state.playerHand ?? [])]; const dealer = [...(state.dealerHand ?? [])]; const deck = [...(state.deck ?? [])];
  let bet = state.bet ?? 0;
  if (action === "double") {
    if (state.doubled || hand.length !== 2) return { text: "Double is only available on your first two cards.", keyboard: casinoBackKeyboard() };
    if (player.coins < bet) return { text: `You need ${bet} more coins to double. Balance: ${player.coins}.`, keyboard: casinoBackKeyboard() };
    bet *= 2; await tx.update(telegramPlayersTable).set({ coins: player.coins - (state.bet ?? 0), updatedAt: new Date() }).where(playerScope(event)); state.doubled = true;
    hand.push(drawCard(deck));
  } else if (action === "hit") hand.push(drawCard(deck));
  else if (action !== "stand") return { text: "Unknown Blackjack move.", keyboard: casinoBackKeyboard() };
  const playerTotal = handValue(hand);
  let finished = action === "stand" || action === "double" || playerTotal >= 21;
  if (!finished) {
    await tx.update(telegramCasinoSessionsTable).set({ state: { ...state, playerHand: hand, dealerHand: dealer, deck, bet }, updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: `🃏 Your hand: ${handText(hand)} (${playerTotal})\nDealer: ${handText(dealer)}\nBet: ${bet} coins.`, keyboard: { inline_keyboard: [[button("➕ Hit", "casino:bj:hit"), button("✋ Stand", "casino:bj:stand")], [button("💥 Double", "casino:bj:double")], [button("⬅️ Back", "casino")]] } };
  }
  while (handValue(dealer) < 17) dealer.push(drawCard(deck));
  const dealerTotal = handValue(dealer);
  let payout = 0; let result = "You lose.";
  if (playerTotal <= 21 && (dealerTotal > 21 || playerTotal > dealerTotal)) { payout = bet * 2; result = `You win ${bet} coins!`; }
  else if (playerTotal === dealerTotal) { payout = bet; result = "Push — your bet is returned."; }
  const current = await tx.select().from(telegramPlayersTable).where(playerScope(event)).limit(1);
  const balance = (current[0]?.coins ?? player.coins) + payout;
  await tx.update(telegramPlayersTable).set({ coins: balance, updatedAt: new Date() }).where(playerScope(event));
  await tx.update(telegramCasinoSessionsTable).set({ status: "finished", updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
  return { text: `🃏 Blackjack result\nYour hand: ${handText(hand)} (${playerTotal})\nDealer: ${handText(dealer)} (${dealerTotal})\n${result}\nBalance: ${balance} coins.`, keyboard: casinoKeyboard };
}

async function processCasinoBet(tx: Tx, event: IncomingEvent, player: TelegramPlayer, amount: number): Promise<Reply> {
  if (!Number.isSafeInteger(amount) || amount < 1) return { text: "Enter a whole-number bet of at least 1 coin.", keyboard: casinoBackKeyboard() };
  const session = await activeCasinoSession(tx, event.chatId, event.actor.id);
  if (!session || !["bet", "host_bet", "opponent_bet"].includes(session.state.phase)) return { text: "No active casino bet is waiting for you.", keyboard: casinoKeyboard };
  if (session.expiresAt.getTime() < Date.now()) {
    await tx.update(telegramCasinoSessionsTable).set({ status: "finished", updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: "This casino session expired. Open Casino to start again.", keyboard: casinoKeyboard };
  }
  if (amount > player.coins) return { text: `You only have ${player.coins} coins. Enter a smaller bet.`, keyboard: casinoBackKeyboard() };
  if (session.game === "blackjack") {
    const deck = Array.from({ length: 52 }, (_, i) => (i % 13) + 1).sort(() => Math.random() - 0.5);
    const hand = [drawCard(deck), drawCard(deck)]; const dealer = [drawCard(deck), drawCard(deck)];
    await tx.update(telegramPlayersTable).set({ coins: player.coins - amount, updatedAt: new Date() }).where(playerScope(event));
    const state: CasinoSessionState = { phase: "blackjack", ownerName: player.characterName, bet: amount, deck, playerHand: hand, dealerHand: dealer };
    await tx.update(telegramCasinoSessionsTable).set({ state, updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: `🃏 Your hand: ${handText(hand)} (${handValue(hand)})\nDealer: ${handText([dealer[0]! , 0].filter((n) => n !== 0))} + hidden card\nBet: ${amount} coins.`, keyboard: { inline_keyboard: [[button("➕ Hit", "casino:bj:hit"), button("✋ Stand", "casino:bj:stand")], [button("💥 Double", "casino:bj:double")], [button("⬅️ Back", "casino")]] } };
  }
  if (session.game === "slots") {
    const symbols = ["🍒", "🍋", "🍇", "🔔", "⭐", "7️⃣"]; const reels = [randomInt(0,5), randomInt(0,5), randomInt(0,5)];
    const triple = reels[0] === reels[1] && reels[1] === reels[2]; const pair = reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2];
    const multiplier = triple ? (reels[0] === 5 ? 8 : reels[0] === 4 ? 5 : 4) : pair ? 2 : 0;
    const payout = amount * multiplier; const balance = player.coins - amount + payout;
    await tx.update(telegramPlayersTable).set({ coins: balance, updatedAt: new Date() }).where(playerScope(event));
    await tx.update(telegramCasinoSessionsTable).set({ status: "finished", updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: `🎰 ${symbols[reels[0]!]} | ${symbols[reels[1]!]} | ${symbols[reels[2]!]}\nBet: ${amount} coins\n${multiplier ? `You win ${payout} coins (${multiplier}x)!` : "No match — you lose your bet."}\nBalance: ${balance} coins.`, keyboard: casinoKeyboard };
  }
  if (session.state.phase === "bet") {
    const won = Math.random() < 0.5; const balance = player.coins - amount + (won ? amount * 2 : 0);
    await tx.update(telegramPlayersTable).set({ coins: balance, updatedAt: new Date() }).where(playerScope(event));
    await tx.update(telegramCasinoSessionsTable).set({ status: "finished", updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: `🪙 Coin Flip: ${won ? "HEADS — you win!" : "TAILS — you lose."}\nBet: ${amount} coins\nBalance: ${balance} coins.`, keyboard: casinoKeyboard };
  }
  if (session.state.phase === "host_bet" && event.actor.id === session.ownerId) {
    await tx.update(telegramPlayersTable).set({ coins: player.coins - amount, updatedAt: new Date() }).where(playerScope(event));
    await tx.update(telegramCasinoSessionsTable).set({ state: { ...session.state, hostBet: amount, phase: "opponent_bet" }, updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: `${player.characterName} bet ${amount} coins. ${session.state.opponentName}, enter your bet now.`, keyboard: casinoBackKeyboard(), broadcast: true };
  }
  if (session.state.phase === "opponent_bet" && event.actor.id === session.opponentId) {
    const host = await tx.select().from(telegramPlayersTable).where(and(eq(telegramPlayersTable.telegramId, session.ownerId), eq(telegramPlayersTable.chatId, event.chatId))).limit(1);
    if (!host[0]) return { text: "The challenge cannot be settled because the other player's save is missing.", keyboard: casinoKeyboard };
    const hostBet = session.state.hostBet ?? 0; const won = Math.random() < 0.5;
    const hostBalance = host[0].coins + (won ? hostBet + amount : 0); const opponentBalance = player.coins - amount + (won ? 0 : hostBet + amount);
    await tx.update(telegramPlayersTable).set({ coins: hostBalance, updatedAt: new Date() }).where(and(eq(telegramPlayersTable.telegramId, session.ownerId), eq(telegramPlayersTable.chatId, event.chatId)));
    await tx.update(telegramPlayersTable).set({ coins: opponentBalance, updatedAt: new Date() }).where(playerScope(event));
    await tx.update(telegramCasinoSessionsTable).set({ status: "finished", updatedAt: new Date() }).where(eq(telegramCasinoSessionsTable.id, session.id));
    return { text: `🪙 Coin Flip result: ${won ? session.state.ownerName + " wins" : session.state.opponentName + " wins"}!\n${session.state.ownerName}: bet ${hostBet} · balance ${hostBalance}\n${session.state.opponentName}: bet ${amount} · balance ${opponentBalance}.`, keyboard: casinoKeyboard, broadcast: true };
  }
  return { text: "It's not your turn to enter a bet.", keyboard: casinoBackKeyboard() };
}

function placesKeyboard(player: TelegramPlayer): InlineKeyboardMarkup {
  const rows = regions.map((region) => [
    button(
      player.level >= region.level
        ? `${region.name} · level ${region.recommendedLevel}`
        : `${region.name} · unlocks at level ${region.level}`,
      `region:${region.id}`,
    ),
  ]);
  const currentRegion = getRegion(player.biomeId);
  rows.push([
    button(
      player.level >= currentRegion.boss.minLevel
        ? `Boss: ${currentRegion.boss.name}`
        : `Boss: ${currentRegion.boss.name} · level ${currentRegion.boss.minLevel}`,
      `boss:${currentRegion.id}`,
    ),
  ]);

  rows.push([button("⬅️ Back", "menu")]);
  return {
    inline_keyboard: rows,
  };
}

async function homeReply(tx: Tx, player: TelegramPlayer): Promise<Reply> {
  const [ownedPet] = await tx.select({ id: telegramPetsTable.id }).from(telegramPetsTable)
    .where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId))).limit(1);
  let rows = [...menuKeyboard.inline_keyboard];
  if (ownedPet) rows = [...rows.slice(0, 3), [button("📦 Box", "box")], ...rows.slice(3)];
  if (player.level >= 101) rows.push([button("🔴🌀 Time Travel ⏳", "timetravel:prompt")]);
  const keyboard: InlineKeyboardMarkup = { inline_keyboard: rows };
  return {
    text: `Welcome back, ${player.characterName}${player.telegramId === "681549636" ? " 🧪 [First Tester]" : ""}. You are in ${getRegion(player.biomeId).name}.\n\nWhat would you like to do?`,
    keyboard,
  };
}

// "Message for <name>" marker. It uses the plain first name only: no @username
// and no mention entity, so Telegram never tags or notifies the player.
function ownerLabel(actor: Actor): string {
  return `📨 Message for ${plainName(actor)}`;
}

async function enqueueReply(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  reply: Reply,
): Promise<void> {
  if (reply.silent) return;
  const trimmedText = event.text?.trim() ?? "";
  const firstToken = trimmedText.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const quickAliases = new Set(["arena", "aarena", "hhunt", "dduel", "ccf", "eequip", "uuse", "ssleep", "bboss", "pprofile", "bbj", "sslot"]);
  const isCommand = trimmedText.startsWith("/") || quickAliases.has(firstToken);
  // Shared lobby messages, broadcasts and pure button acknowledgements have no single owner.
  const owned =
    !reply.broadcast && reply.lobbyId === undefined && reply.text !== "";
  const [userSettings] = owned ? await tx.select().from(telegramPlayerSettingsTable).where(eq(telegramPlayerSettingsTable.telegramId, event.actor.id)).limit(1) : [];
  const localizedReply = owned ? translateReply(reply, userSettings?.language ?? "en") : reply;
  await tx.insert(telegramOutboxTable).values({
    updateId: event.updateId,
    chatId: event.responseChatId,
    callbackQueryId: event.callbackQueryId,
    ownerId: owned ? event.actor.id : null,
    cleanupOwnerId: reply.cleanupOwner ? event.actor.id : null,
    triggerMessageId: (isCommand || (event.text !== null && /^\d+$/.test(event.text.trim()))) ? event.messageId : null,
    lobbyId: reply.lobbyId ?? null,
    lobbyAction: reply.lobbyAction ?? null,
    callbackText: reply.callbackText ?? null,
    text: owned ? `${ownerLabel(event.actor)}\n\n${localizedReply.text}` : reply.text,
    replyMarkup: localizedReply.keyboard ?? null,
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
      characterName: (actor.firstName || actor.username || "Adventurer").slice(0, 48),
      archetype: "Jobless",
      classId: null,
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

function helpReply(): Reply {
  return {
    text: [
      "📖 Adventure commands:",
      "🏁 /start — create your character (Jobless) or reopen the menu",
      "💾 /saves — in private chat, choose which existing group save to play with",
      "🗑️ /Wipedata — permanently reset your save in this group (confirmation required)",
      "🧭 /explore — look for encounters, coins and items",
      "👤 /profile — stats and progress",
      "📚 /index — mini wiki for equipment, consumables and class orbs",
      "🏆 /Leaderboard — top 10 players by level, with a button to view the richest players",
      "🎒 /inventory — browse one inventory category at a time",
      "🐾 /box — manage captured pets; /box deposit ID, /box withdraw ID, /box trade @Username ID",
      "💰 /sell ID * or /sell ID NUMBER — sell an item stack or quantity; /sell RARITY weapons|armors — bulk-sell by rarity",
      "⚔️ /equip ID — equip a weapon or armor by its inventory ID",
      "🧪 /use ID — use a consumable by its inventory ID (uses your combat turn)",
      "🔮 /orb ID — use a Class Orb by its inventory ID",
      "🗺️ /places — choose your next region",
      "😴 /sleep — restore all HP in exchange for coins",
      "🐉 /boss — open a 30-second co-op boss lobby (up to 4 players)",
      "⚔️ /duel — open a 30-second duel lobby; the first challenger starts the fight",
      "🤝 /Trade @Username — safely trade items and coins with another player",
      "⚡ Quick commands (no slash): Hhunt, Dduel @User, Ccf Solo [Coins], Ccf Multi, Eequip ID, Uuse ID, Ssleep, Bboss, Pprofile, Bbj Coins, Sslot Coins",
      "",
      "During a fight use Attack, Inventory or Flee. Using a consumable with /use ID spends your turn and the enemy will strike back.",
    ].join("\n"),
    keyboard: { inline_keyboard: [[button("⬅️ Back", "menu")]] },
  };
}

async function startExplorationEvent(tx: Tx, event: IncomingEvent, player: TelegramPlayer, region: Region): Promise<Reply> {
  // Exced is a separate ultra-rare encounter: exactly a 0.5% chance on each exploration.
  if (Math.random() < 0.005) {
    const pending = {
      id: "exced_the_wise",
      title: "Exced The Wise — Visitor from the Future",
      description: `A sudden ripple tears through the air. An ancient sage steps out, his robes shimmering with constellations that have not yet been born.

‘I am Exced The Wise. I have crossed the ages and traveled far beyond the edges of your world. I came from the future to find you, adventurer, and leave you a gift. Your path still has a destiny to fulfill.’

He opens his hand, revealing a gift shaped by fate. Will you accept it?`,
      rarity: "Mythic" as const,
      biomeId: region.id,
    };
    await tx.update(telegramPlayersTable).set({ explorationEvent: pending, updatedAt: new Date() }).where(playerScope(event));
    return {
      text: `⏳ A TIME ANOMALY APPEARS!\n\n${pending.title}\n${pending.description}`,
      keyboard: { inline_keyboard: [[button("🎁 Accept Exced's Gift", `exploreevent:take:${pending.id}`), button("🏃 Leave", "exploreevent:leave")]] },
    };
  }

  const totalWeight = explorationEventDefinitions.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  let chosen = explorationEventDefinitions[0]!;
  for (const item of explorationEventDefinitions) {
    roll -= item.weight;
    if (roll < 0) { chosen = item; break; }
  }
  const pending = { id: chosen.id, title: chosen.title, description: chosen.description, rarity: chosen.rarity, biomeId: region.id };
  await tx.update(telegramPlayersTable).set({ explorationEvent: pending, updatedAt: new Date() }).where(playerScope(event));
  const flair = biomeEventFlair[region.name] ?? `the strange atmosphere of ${region.name} surrounds you`;
  return {
    text: `🧭 ${flair}.

${chosen.rarity === "Legendary" ? "✨ RARE DISCOVERY! " : chosen.rarity === "Epic" ? "🌟 EPIC DISCOVERY! " : chosen.rarity === "Rare" ? "💠 RARE EVENT! " : ""}${chosen.title}
${chosen.description}

What will you do? You can always leave without taking the risk.`,
    keyboard: { inline_keyboard: [[button("🔎 Investigate", `exploreevent:take:${chosen.id}`), button("🏃 Leave", "exploreevent:leave")]] },
  };
}

async function wanderingMerchantReply(tx: Tx, event: IncomingEvent, player: TelegramPlayer, pending: NonNullable<TelegramPlayer["explorationEvent"]>): Promise<Reply> {
  const region = getRegion(pending.biomeId);
  const maxTier = Math.max(0, Math.min(4, Math.floor((region.level - 1) / 2)));
  // Catching Net is a guaranteed merchant staple and is reusable (never consumed).
  await tx.insert(itemsTable).values({ itemId: "catching_net", name: "Catching Net", type: "Consumables", tier: 0, rarity: "Uncommon", stats: { effect: "catch_monster", power: 0 }, passiveOrEffect: "catch_monster" }).onConflictDoNothing();
  const candidates = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name, type: itemsTable.type, tier: itemsTable.tier, rarity: itemsTable.rarity })
    .from(itemsTable).where(sql`${itemsTable.type} IN ('Weapons', 'Armors', 'Off-Hand', 'Consumables') AND ${itemsTable.tier} <= ${maxTier}`);
  const pool = candidates.filter((item) => item.type === "Consumables" || item.type === "Weapons" || item.type === "Armors" || item.type === "Off-Hand");
  if (!pool.length) return { text: "The wandering merchant has no wares for this region today.", keyboard: menuKeyboard };
  const offers = pending.offers?.filter((offer) => pool.some((item) => item.itemId === offer.itemId)) ?? [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(pool.length, randomInt(12, 20))).map((item) => ({ itemId: item.itemId, price: Math.max(5, (item.tier + 1) * 25 + (item.type === "Consumables" ? 10 : 35) + randomInt(0, 25)) }));
  if (!offers.some((offer) => offer.itemId === "catching_net")) offers.unshift({ itemId: "catching_net", price: 100 });
  const nextPending = { ...pending, offers };
  await tx.update(telegramPlayersTable).set({ explorationEvent: nextPending, updatedAt: new Date() }).where(playerScope(event));
  const byType = ["Weapons", "Armors", "Off-Hand", "Consumables"] as const;
  const lines = [`🧳 Wandering Merchant — ${region.name}`, `Your region limits the merchant to items up to Tier ${maxTier}.`, `Your Coins: ${player.coins}`, ""];
  for (const type of byType) {
    const typeOffers = offers.map((offer, index) => ({ ...offer, index })).filter((offer) => pool.find((item) => item.itemId === offer.itemId)?.type === type);
    if (!typeOffers.length) continue;
    lines.push(`— ${type.toUpperCase()} —`);
    for (const offer of typeOffers) {
      const item = pool.find((candidate) => candidate.itemId === offer.itemId)!;
      lines.push(`#${offer.index + 1} ${item.name} · ${item.rarity} · ${offer.price} Coins`);
    }
  }
  const buttons = offers.map((offer, index) => { const item = pool.find((candidate) => candidate.itemId === offer.itemId)!; return button(`Buy #${index + 1} · ${offer.price}c`, `merchant:buy:${index}`); });
  const rows = [] as Array<Array<{text:string; callback_data:string}>>;
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([button("Leave Shop", "merchant:leave")]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

async function buyMerchantOffer(tx: Tx, event: IncomingEvent, player: TelegramPlayer, index: number): Promise<Reply> {
  const pending = player.explorationEvent;
  const offer = pending?.id === "wandering_merchant" ? pending.offers?.[index] : undefined;
  if (!offer) return { text: "This merchant offer is no longer available.", keyboard: menuKeyboard };
  if (player.coins < offer.price) return { text: `You need ${offer.price} Coins to buy this item. You have ${player.coins}.`, keyboard: await wanderingMerchantReply(tx, event, player, pending!) };
  const [item] = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name }).from(itemsTable).where(eq(itemsTable.itemId, offer.itemId)).limit(1);
  if (!item) return { text: "This item is no longer available.", keyboard: menuKeyboard };
  await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: item.itemId }).onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
  await tx.update(telegramPlayersTable).set({ coins: player.coins - offer.price, updatedAt: new Date() }).where(playerScope(event));
  const refreshed = { ...pending!, offers: pending!.offers!.filter((_, offerIndex) => offerIndex !== index) };
  await tx.update(telegramPlayersTable).set({ explorationEvent: refreshed, updatedAt: new Date() }).where(playerScope(event));
  return { text: `✅ Purchased ${item.name} for ${offer.price} Coins.`, keyboard: { inline_keyboard: [[button("Return to Merchant", "merchant:back"), button("Leave Shop", "merchant:leave")]] } };
}

async function resolveExplorationEvent(tx: Tx, event: IncomingEvent, player: TelegramPlayer, callback: string): Promise<Reply> {
  const pending = player.explorationEvent;
  if (!pending) return { text: "This exploration event has already ended. Use Explore to discover something new.", keyboard: menuKeyboard };
  if (callback === "exploreevent:leave") {
    await tx.update(telegramPlayersTable).set({ explorationEvent: null, updatedAt: new Date() }).where(playerScope(event));
    return { text: `🏃 You leave ${pending.title} behind and continue safely. No risk, no reward.\n\nWhat next?`, keyboard: { inline_keyboard: [[button("😴 Rest", "sleep"), button("🧭 Continue exploring", "explore")], [button("🏠 Main menu", "menu")]] } };
  }
  if (callback !== `exploreevent:take:${pending.id}`) return { text: "This is not your active exploration event.", keyboard: menuKeyboard };
  if (pending.id === "wandering_merchant") return wanderingMerchantReply(tx, event, player, pending);
  await tx.update(telegramPlayersTable).set({ explorationEvent: null, updatedAt: new Date() }).where(playerScope(event));
  if (pending.id === "exced_the_wise") {
    const doubleGift = Math.random() < 0.005;
    const giftCount = doubleGift ? 2 : 1;
    const lines = ["⏳ Exced The Wise — A Gift Beyond Time", "‘Take this, adventurer. May it guide you toward the future I have seen.’", doubleGift ? "🌌 IMPOSSIBLE LUCK! Exced's future sight reveals two gifts for you!" : "🎁 Exced offers you one gift."];
    let gainedCoins = player.coins;
    let gainedPotions = player.potions;
    for (let giftIndex = 0; giftIndex < giftCount; giftIndex++) {
      const rewardType = randomInt(0, 4);
      if (rewardType === 0) {
        const orbs = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name, stats: itemsTable.stats }).from(itemsTable).where(eq(itemsTable.type, "ClassOrb"));
        if (orbs.length) {
          const orb = orbs[randomInt(0, orbs.length - 1)]!;
          await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: orb.itemId })
            .onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
          const classId = orbClassId(orb.stats);
          lines.push(`🔮 Gift ${giftIndex + 1}: ${orb.name} (${classId ? classes[classId].rarity : "Unknown"} Class Orb)!`);
        } else { gainedCoins += 10_000; lines.push(`🪙 Gift ${giftIndex + 1}: 10,000 Coins (no Class Orbs were available).`); }
      } else if (rewardType === 1) {
        const items = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name, tier: itemsTable.tier }).from(itemsTable)
          .where(sql`${itemsTable.tier} >= 3 AND ${itemsTable.type} IN ('Weapons', 'Armors', 'Off-Hand', 'Consumables')`);
        if (items.length) {
          const item = items[randomInt(0, items.length - 1)]!;
          await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: item.itemId })
            .onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
          lines.push(`🎁 Gift ${giftIndex + 1}: ${item.name} (Tier ${item.tier})!`);
        } else { gainedCoins += 10_000; lines.push(`🪙 Gift ${giftIndex + 1}: 10,000 Coins (no Tier 3+ items were available).`); }
      } else if (rewardType === 2) {
        gainedPotions += 250;
        lines.push(`🧪 Gift ${giftIndex + 1}: 250 Potions!`);
      } else if (rewardType === 3) {
        const sticks = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name, tier: itemsTable.tier }).from(itemsTable)
          .where(sql`LOWER(${itemsTable.name}) = 'stick'`);
        if (sticks.length) {
          const stick = sticks[0]!;
          await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: stick.itemId })
            .onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
          lines.push(`🪵 Gift ${giftIndex + 1}: ${stick.name}!`);
        } else { gainedCoins += 10_000; lines.push(`🪙 Gift ${giftIndex + 1}: 10,000 Coins (the Stick was missing from the item catalog).`); }
      } else {
        gainedCoins += 10_000;
        lines.push(`🪙 Gift ${giftIndex + 1}: 10,000 Coins!`);
      }
    }
    await tx.update(telegramPlayersTable).set({ coins: gainedCoins, potions: gainedPotions, updatedAt: new Date() }).where(playerScope(event));
    lines.push("\n‘Our paths may never cross again, but remember: the future is shaped by what you do next.’ — Exced The Wise");
    return { text: lines.join("\n"), keyboard: { inline_keyboard: [[button("🧭 Continue exploring", "explore")], [button("🏠 Main menu", "menu")]] } };
  }
  const lines: string[] = [`🧭 ${pending.title}`];
  const coins = (amount: number) => { const value = Math.max(0, amount); lines.push(`🪙 You find ${value} coins.`); return value; };
  const giveItem = async (minTier: number, label: string) => {
    const candidates = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name, tier: itemsTable.tier })
      .from(itemsTable).where(sql`${itemsTable.tier} >= ${minTier} AND ${itemsTable.type} IN ('Weapons', 'Armors', 'Off-Hand')`);
    if (!candidates.length) { lines.push("The cache is empty; no suitable equipment is configured yet."); return; }
    const item = candidates[randomInt(0, candidates.length - 1)]!;
    await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: item.itemId })
      .onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
    lines.push(`🎁 ${label}: ${item.name} (Tier ${item.tier}).`);
  };
  let newCoins = player.coins;
  let newHp = player.hp;
  let newXp = player.xp;
  let newPotions = player.potions;
  let level = player.level;
  let maxHp = player.maxHp;
  let attack = player.attack;
  let defense = player.defense;
  const grantRandomClassOrb = async (label: string) => {
    const available = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name, stats: itemsTable.stats })
      .from(itemsTable).where(eq(itemsTable.type, "ClassOrb"));
    const rarityWeights: Record<string, number> = { Common: 60, Uncommon: 25, Rare: 10, Epic: 4, Legendary: 1, Mythic: 0.25 };
    const weighted = available.map((orb) => {
      const classId = orbClassId(orb.stats);
      const rarity = classId ? classes[classId].rarity : "Common";
      // Starter classes remain accessible; advanced class orbs are rarer in caches.
      // Abyssal remains exceptionally rare even among Mythic orbs.
      const isStarterClass = !!classId && ["warrior", "arcanist", "explorer"].includes(classId);
      const weight = classId === "abyssal" ? 0.025 : (rarityWeights[rarity] ?? 1) * (isStarterClass ? 1 : 0.1);
      return { orb, weight };
    }).filter((entry) => entry.weight > 0);
    if (!weighted.length) { lines.push("The magical cache is empty: no Class Orbs are configured."); return; }
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = Math.random() * total;
    let selected = weighted[0]!;
    for (const entry of weighted) { roll -= entry.weight; if (roll < 0) { selected = entry; break; } }
    await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: selected.orb.itemId })
      .onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
    const classId = orbClassId(selected.orb.stats);
    const rarity = classId ? classes[classId].rarity : "Unknown";
    lines.push(`🔮 ${label}: ${selected.orb.name} (${rarity} Class Orb)!`);
  };
  switch (pending.id) {
    case "lost_satchel": newCoins += coins(randomInt(8, 20)); break;
    case "old_waystone": newXp += randomInt(8, 18); lines.push(`📘 You gain ${newXp - player.xp} XP from the ancient inscription.`); break;
    case "healing_spring": { const healed = Math.min(player.maxHp - player.hp, randomInt(8, 18)); newHp += healed; lines.push(`💚 The spring restores ${healed} HP.`); break; }
    case "herbs": newPotions += 1; lines.push("🧪 You gather ingredients and craft 1 potion."); break;
    case "pouch": newCoins += coins(randomInt(12, 30)); break;
    case "mushrooms": if (Math.random() < 0.7) { newHp = Math.min(player.maxHp, player.hp + 10); lines.push("🍄 The mushrooms restore 10 HP."); } else { newPotions += 1; lines.push("🍄 You safely collect a potion ingredient and gain 1 potion."); } break;
    case "campfire": newPotions += 1; newCoins += coins(randomInt(3, 10)); lines.push("🔥 You salvage 1 potion from the camp supplies."); break;
    case "kind_spirit": { const healed = Math.min(player.maxHp - player.hp, 5); newHp += healed; newXp += 10; lines.push(`👻 A kind spirit restores ${healed} HP and grants 10 XP.`); break; }
    case "merchant": newCoins += coins(randomInt(20, 45)); break;
    case "buried_cache": await giveItem(1, "You uncover equipment"); break;
    case "ancient_runes": newXp += randomInt(20, 35); lines.push(`📚 You decipher the runes and gain ${newXp - player.xp} XP.`); break;
    case "lucky_coin": newCoins += coins(randomInt(25, 55)); break;
    case "spirit_guide": { const healed = Math.min(player.maxHp - player.hp, Math.ceil(player.maxHp * 0.25)); newHp += healed; newXp += 15; lines.push(`✨ A guardian restores ${healed} HP and blesses you with 15 XP.`); break; }
    case "crystal_shard": if (Math.random() < 0.75) await giveItem(2, "The crystal reveals"); else { newCoins += coins(randomInt(20, 40)); lines.push("💎 The shard crumbles into valuable dust."); } break;
    case "treasure_map": if (Math.random() < 0.5) await giveItem(2, "The map leads to"); else newCoins += coins(randomInt(35, 70)); break;
    case "cursed_altar": if (Math.random() < 0.55) { newCoins += coins(randomInt(40, 80)); lines.push("🕯️ The altar accepts your offering and leaves the coins behind."); } else { const damage = Math.min(Math.max(0, newHp - 1), Math.ceil(player.maxHp * 0.2)); newHp -= damage; lines.push(`☠️ The curse strikes you for ${damage} HP.`); } break;
    case "time_rift": newXp += randomInt(45, 70); lines.push(`🌀 Time folds around you. You gain ${newXp - player.xp} XP.`); break;
    case "phoenix_ember": { const healed = Math.min(player.maxHp - player.hp, Math.ceil(player.maxHp * 0.4)); newHp += healed; newPotions += 1; lines.push(`🔥 The ember restores ${healed} HP and grants 1 potion.`); break; }
    case "glowing_chest": if (Math.random() < 0.6) { await giveItem(2, "The luminous chest contains"); newCoins += coins(randomInt(20, 50)); } else { const damage = Math.min(newHp, Math.ceil(player.maxHp * 0.4)); newHp -= damage; lines.push(`💥 The chest erupts with cursed light! You lose ${damage} HP (40% of your maximum HP).`); } break;
    case "fate_shrine": if (Math.random() < 0.5) { await giveItem(3, "The shrine grants"); newXp += 50; lines.push("🌠 The shrine grants 50 XP."); } else { newCoins += coins(randomInt(80, 130)); const healed = Math.min(player.maxHp - newHp, 15); newHp += healed; lines.push(`🌠 Fortune smiles on you: you also recover ${healed} HP.`); } break;
    case "forgotten_orb_cache": await grantRandomClassOrb("The cache reveals"); newCoins += coins(randomInt(5, 20)); break;
    case "ancient_orb_shrine": await grantRandomClassOrb("The shrine bestows"); newXp += 25; lines.push("✨ The shrine also grants 25 XP."); break;
    case "mythic_orb_rift": await grantRandomClassOrb("The rift tears open and grants"); newCoins += coins(randomInt(40, 90)); break;
  }
  while (newXp >= xpToNext(level)) { newXp -= xpToNext(level); level += 1; maxHp += 5; attack += 1; if (level % 2 === 0) defense += 1; newHp = Math.min(maxHp, newHp + 5); lines.push(`🎉 Level up! You reach level ${level}: +5 max HP and +1 attack.`); }
  await tx.update(telegramPlayersTable).set({ coins: newCoins, hp: newHp, xp: newXp, potions: newPotions, level, maxHp, attack, defense, updatedAt: new Date() }).where(playerScope(event));
  let earnedXp = newXp - player.xp;
  for (let crossedLevel = player.level; crossedLevel < level; crossedLevel++) earnedXp += xpToNext(crossedLevel);
  earnedXp = Math.max(0, earnedXp);
  const earnedGold = Math.max(0, newCoins - player.coins);
  if (earnedXp > 0 || earnedGold > 0) {
    const [partyMember] = await tx.select().from(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId), eq(telegramPartyMembersTable.status, "member"))).limit(1);
    if (partyMember) {
      const allies = await tx.select().from(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.partyId, partyMember.partyId), eq(telegramPartyMembersTable.status, "member")));
      for (const ally of allies) {
        if (ally.telegramId === player.telegramId && ally.chatId === player.chatId) continue;
        const [allyPlayer] = await tx.select().from(telegramPlayersTable).where(and(eq(telegramPlayersTable.telegramId, ally.telegramId), eq(telegramPlayersTable.chatId, ally.chatId))).limit(1);
        if (!allyPlayer) continue;
        const bonusXp = Math.floor(earnedXp * 0.05); const bonusGold = Math.floor(earnedGold * 0.05);
        if (bonusXp || bonusGold) {
          let allyXp = allyPlayer.xp + bonusXp; let allyLevel = allyPlayer.level; let allyMaxHp = allyPlayer.maxHp; let allyAttack = allyPlayer.attack; let allyDefense = allyPlayer.defense; let allyHp = allyPlayer.hp;
          while (allyXp >= xpToNext(allyLevel)) { allyXp -= xpToNext(allyLevel); allyLevel += 1; allyMaxHp += 5; allyAttack += 1; if (allyLevel % 2 === 0) allyDefense += 1; allyHp = Math.min(allyMaxHp, allyHp + 5); }
          await tx.update(telegramPlayersTable).set({ xp: allyXp, level: allyLevel, maxHp: allyMaxHp, attack: allyAttack, defense: allyDefense, hp: allyHp, coins: allyPlayer.coins + bonusGold, updatedAt: new Date() }).where(and(eq(telegramPlayersTable.telegramId, ally.telegramId), eq(telegramPlayersTable.chatId, ally.chatId)));
        }
      }
    }
  }
  return { text: `${lines.join("\n")}\n\nWhat next?`, keyboard: { inline_keyboard: [[button("😴 Rest", "sleep"), button("🧭 Continue exploring", "explore")], [button("🏠 Main menu", "menu")]] } };
}

async function explore(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  if (player.explorationEvent) {
    return { text: `You still have an unresolved exploration event: ${player.explorationEvent.title}. Choose an option below.`, keyboard: { inline_keyboard: [[button("🔎 Investigate", `exploreevent:take:${player.explorationEvent.id}`), button("🏃 Leave", "exploreevent:leave")]] } };
  }
  if (player.combat) {
    return {
      text: `You are already fighting ${player.combat.name}. Choose an action.`,
      keyboard: await combatKeyboardFor(tx, player),
    };
  }
  if (player.hp <= 0) {
    return { text: "You are too wounded to continue. Rest and try again." };
  }

  const region = getRegion(player.biomeId);
  const scene = `You explore ${region.name}.`;
  const roll = Math.random();

  if (roll < 0.73) {
    // Rare encounter: roughly 2% of hunts that would start a normal mob fight.
    let enemy: CombatState;
    if (Math.random() < 0.02) {
      const groupPlayers = await tx.select({
        telegramId: telegramPlayersTable.telegramId,
        characterName: telegramPlayersTable.characterName,
        level: telegramPlayersTable.level,
      }).from(telegramPlayersTable).where(and(
        eq(telegramPlayersTable.chatId, event.chatId),
        sql`${telegramPlayersTable.telegramId} <> ${event.actor.id}`,
      ));
      if (groupPlayers.length > 0) {
        const source = groupPlayers[randomInt(0, groupPlayers.length - 1)]!;
        const cloneLevel = randomInt(Math.max(player.level, source.level), Math.max(player.level, source.level) + 3);
        const base = baseStats(cloneLevel);
        const sourceName = source.characterName || "Unknown Player";
        enemy = {
          mobId: "shadow_clone",
          name: `${sourceName} Shadow Clone`,
          hp: Math.max(player.maxHp, base.hp + 5),
          maxHp: Math.max(player.maxHp, base.hp + 5),
          attack: Math.max(player.attack, base.attack + 2),
          xpReward: Math.max(20, cloneLevel * 18),
          coinReward: Math.max(10, cloneLevel * 12),
          biomeId: region.id,
          isBoss: false,
          isShadowClone: true,
          dropTable: [],
        };
      } else {
        const template = (Math.random() < 0.03 && region.monsters.some((m) => m.rare) ? region.monsters.filter((m) => m.rare)[randomInt(0, region.monsters.filter((m) => m.rare).length - 1)]! : (() => { const pool = region.monsters.filter((m) => !m.rare); const choices = pool.length ? pool : region.monsters; return choices[randomInt(0, choices.length - 1)]!; })());
        enemy = { ...template, maxHp: template.hp, biomeId: region.id, isBoss: false };
      }
    } else {
      const template = (Math.random() < 0.03 && region.monsters.some((m) => m.rare) ? region.monsters.filter((m) => m.rare)[randomInt(0, region.monsters.filter((m) => m.rare).length - 1)]! : (() => { const pool = region.monsters.filter((m) => !m.rare); const choices = pool.length ? pool : region.monsters; return choices[randomInt(0, choices.length - 1)]!; })());
      enemy = {
        ...template,
        maxHp: template.hp,
        biomeId: region.id,
        isBoss: false,
      };
    }
    if (!enemy.isShadowClone && region.monsters.some((m) => m.mobId === enemy.mobId && m.rare)) {
      enemy.name = `★ Rare ${enemy.name}`;
      enemy.xpReward = Math.floor(enemy.xpReward * 2.5);
      enemy.coinReward = Math.max(enemy.coinReward ?? 0, region.level * 25 + 50);
    }
    // Shiny monsters can appear in place of any regular encounter (1% chance).
    // Their combat stats are doubled and their ordinary drop chances are improved.
    if (!enemy.isShadowClone && !enemy.isBoss && Math.random() < 0.01) {
      enemy.isShiny = true;
      enemy.name = `✨Shiny✨ ${enemy.name}`;
      enemy.hp *= 2;
      enemy.maxHp *= 2;
      enemy.attack *= 2;
      enemy.xpReward = Math.floor(enemy.xpReward * 2);
      enemy.coinReward = Math.max(enemy.coinReward ?? 0, region.level * 40 + 100);
      enemy.dropTable = (enemy.dropTable ?? []).map((drop) => ({ ...drop, chance: Math.min(1, drop.chance * 2) }));
    }
    await tx
      .update(telegramPlayersTable)
      .set({ combat: enemy, updatedAt: new Date() })
      .where(playerScope(event));
    return {
      text: `${scene}\n\n${enemy.isShadowClone ? `🌑 RARE ENCOUNTER! ${enemy.name} emerges from the shadows! It is at least your level and may be stronger.` : `${enemy.name.startsWith("★ Rare") ? "✨ RARE ELITE! " : ""}${enemy.name} blocks your path!${enemy.name.startsWith("★ Rare") ? " A dangerous foe with greatly increased rewards!" : ""}`} ⚔️ (${enemy.hp} HP)\n\nWhat do you do?`,
      keyboard: await combatKeyboardFor(tx, player),
    };
  }

  return startExplorationEvent(tx, event, player, region);
}

async function grantConsumableDrop(tx: Tx, player: TelegramPlayer, isBoss = false): Promise<string[]> {
  const chance = isBoss ? 0.65 : 0.22;
  if (Math.random() >= chance) return [];
  const maxTier = isBoss ? Math.min(4, Math.floor(player.level / 4) + 1) : Math.min(3, Math.floor(player.level / 5));
  const tier = Math.floor(Math.random() * (maxTier + 1));
  const candidates = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name }).from(itemsTable)
    .where(and(eq(itemsTable.type, "Consumables"), eq(itemsTable.tier, tier)));
  if (candidates.length === 0) return [];
  const item = candidates[Math.floor(Math.random() * candidates.length)]!;
  await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: item.itemId })
    .onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
  return [`🎒 You found a consumable: ${item.name}!`];
}

function petXpToNext(level: number): number { return 100 + level * 25; }

function createPetPassive(player: TelegramPlayer, equipmentNames: string[]) {
  const classId = classIdOf(player) ?? "explorer";
  const gearText = equipmentNames.length ? equipmentNames.join(" ") : "unarmed";
  const gear = /staff|wand|orb|tome|spell|magic/i.test(gearText) ? "Arcane" : /dagger|knife|bow|claw|assassin/i.test(gearText) ? "Predator" : /shield|plate|armor|helm|guard/i.test(gearText) ? "Guardian" : /sword|blade|axe|great/i.test(gearText) ? "Warbound" : "Adaptive";
  const names: Record<string, string[]> = {
    warrior: ["Blood Bond", "Battleheart", "Iron Vow"], explorer: ["Trailblazer's Instinct", "Wayfinder's Favor", "Adaptive Companion"], arcanist: ["Arcane Resonance", "Mana Echo", "Runic Pulse"], duelist: ["Predator's Instinct", "Perfect Opening", "Twin Fang"], warden: ["Guardian Spirit", "Stonewall Pact", "Bulwark Aura"], bloodweaver: ["Sanguine Link", "Crimson Pact", "Vitality Thread"], stormcaller: ["Storm Sync", "Thunderheart", "Tempest Pulse"], voidstalker: ["Umbral Hunt", "Void Ambush", "Night's Edge"], phoenixborn: ["Ember Rebirth", "Phoenix Link", "Cinderheart"], abyssal: ["Abyssal Echo", "Rift Hunger", "Deep Resonance"], seraphim: ["Celestial Grace", "Radiant Bond", "Halo Ward"], necromancer: ["Soul Leash", "Grave Resonance", "Wraith Pact"]
  };
  // Class + currently equipped gear produce a stable, pet-specific choice.
  const seed = `${player.telegramId}:${player.chatId}:${gearText}:${classId}`;
  let hash = 0; for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const name = `${names[classId][hash % names[classId].length]} · ${gear}`;
  const bonus = 5 + (hash % 8);
  return { name, description: `A bond shaped by ${classes[classId].name} and ${gearText}. Increases this pet's attack damage by ${bonus}% while active.`, bonus };
}

async function attack(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  const enemy = player.combat;
  if (!enemy) return { text: "You are not in combat. Use Explore to look for an adventure.", keyboard: menuKeyboard };

  const itemAttackBonus = enemy.attackBuff ?? 0;
  const baseDamage = Math.max(1, player.attack + randomInt(0, 3) - 1 + itemAttackBonus);
  const passive = classPassive(player);
  const critChance = clamp(await getCritChance(tx, player) + (passive === "duelist" ? 0.12 : 0), 0, 1);
  const isCrit = critChance > 0 && Math.random() < critChance;
  const lowHealthFury = passive === "stormcaller" && player.hp <= player.maxHp * 0.4 ? 1.35 : 1;
  const shadowBurst = passive === "voidstalker" && Math.random() < 0.18 ? 1.75 : 1;
  const arcaneSurge = passive === "arcanist" && Math.random() < 0.15 ? 1.25 : 1;
  const abyssalRift = passive === "abyssal" && Math.random() < 0.12 ? 1.6 : 1;
  const seraphicGrace = passive === "seraphim" && Math.random() < 0.10 ? 1.5 : 1;
  const soulShard = passive === "necromancer" && Math.random() < 0.12 ? 1.45 : 1;
  const damage = Math.max(1, Math.floor((isCrit ? baseDamage * 2 : baseDamage) * lowHealthFury * shadowBurst * arcaneSurge * abyssalRift * seraphicGrace * soulShard));
  const [activePet] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.active, 1), eq(telegramPetsTable.boxed, 0))).limit(1);
  const petBaseDamageRatio = activePet?.isShiny ? 0.3 : 0.2;
  const petDamage = activePet ? Math.max(1, Math.floor(damage * (petBaseDamageRatio + ((activePet.level >= 20 && activePet.passiveBonus) ? activePet.passiveBonus / 100 : 0)))) : 0;
  const enemyHp = Math.max(0, enemy.hp - damage - petDamage);
  const passiveHeal = passive === "bloodweaver" ? Math.min(3, player.maxHp - player.hp) : passive === "abyssal" && abyssalRift > 1 ? Math.min(2, player.maxHp - player.hp)  : passive === "seraphim" && seraphicGrace > 1 ? Math.min(3, player.maxHp - player.hp) : passive === "necromancer" && soulShard > 1 ? Math.min(2, player.maxHp - player.hp) : 0;
  const combatHp = Math.min(player.maxHp, player.hp + passiveHeal);
  const lines = [
    isCrit
      ? `💥 Critical hit! You strike ${enemy.name} for ${damage} damage.`
      : `🗡️ You strike ${enemy.name} for ${damage} damage.`,
  ];
  if (activePet) lines.push(`🐾 ${activePet.nickname} attacks alongside you for ${petDamage} damage!`);

  if (passiveHeal > 0) lines.push(passive === "abyssal" ? `🟪 Abyssal Rift restores ${passiveHeal} HP.` : passive === "seraphim" ? `⚪ Seraphic Grace restores ${passiveHeal} HP.` : `🩸 Bloodweave restores ${passiveHeal} HP.`);
  if (passive === "abyssal" && abyssalRift > 1) lines.push("🟪 Abyssal Rift erupts for 60% bonus damage!");
  if (passive === "seraphim" && seraphicGrace > 1) lines.push("⚪ Seraphic Grace strikes for 50% bonus damage!");
  if (passive === "necromancer" && soulShard > 1) lines.push("🟩 Soul Shard deals 45% bonus damage!");

  if (enemyHp === 0) {
    const xpReward = Math.floor(enemy.xpReward * (1 + (player.rebirths ?? 0) * 0.05));
    let xp = player.xp + xpReward;
    let level = player.level;
    let maxHp = player.maxHp;
    let playerAttack = player.attack;
    let defense = player.defense;
    const levelMessages: string[] = [];

    while (xp >= xpToNext(level)) {
      xp -= xpToNext(level);
      level += 1;
      maxHp += 5;
      playerAttack += 1;
      if (level % 2 === 0) defense += 1;
      levelMessages.push(`You reach level ${level}: +5 max HP and +1 attack.`);
    }

    const newHp = clamp(combatHp + 3 + levelMessages.length * 5, 1, maxHp);
    let petProgressMessage = "";
    const [growingPet] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.active, 1), eq(telegramPetsTable.boxed, 0))).limit(1);
    if (growingPet) {
      let petLevel = Math.max(1, growingPet.level || 1);
      let petXp = growingPet.xp + Math.max(10, enemy.xpReward);
      const oldLevel = petLevel;
      while (petLevel < 20 && petXp >= petXpToNext(petLevel)) { petXp -= petXpToNext(petLevel); petLevel += 1; }
      const petUpdate: Record<string, any> = { level: petLevel, xp: petXp, updatedAt: new Date() };
      if (oldLevel < 20 && petLevel >= 20 && !growingPet.passiveName) {
        const equipped = await getEquippedItems(tx, player);
        const passive = createPetPassive(player, equipped.map((item) => item.name));
        petUpdate.passiveName = passive.name; petUpdate.passiveDescription = passive.description; petUpdate.passiveBonus = passive.bonus;
        petProgressMessage = `\n✨ ${growingPet.nickname} reached Lv. 20 and unlocked **${passive.name}**! ${passive.description}`;
      } else if (petLevel > oldLevel) petProgressMessage = `\n🐾 ${growingPet.nickname} grew to pet level ${petLevel}!`;
      await tx.update(telegramPetsTable).set(petUpdate).where(eq(telegramPetsTable.id, growingPet.id));
    }
    const gainedPotion = Math.random() < 0.2 ? 1 : 0;
    const baseCoinReward = enemy.coinReward ?? Math.max(1, Math.round(enemy.xpReward / 5));
    const coinReward = Math.floor(baseCoinReward * (1 + (player.rebirths ?? 0) * 0.05));
    const coins = player.coins + coinReward;
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
      `🏆 ${enemy.name} is defeated. You gain ${xpReward} XP and ${coinReward} gold.`,
    );
    if (gainedPotion) lines.push("Among the remains you also find a potion.");
    if (enemy.isShadowClone) {
      lines.push(...(await grantShadowCloneReward(tx, player)));
    } else {
      lines.push(...(await grantDrops(tx, player, enemy.dropTable, enemy.isBoss === true)));
      lines.push(...(await grantConsumableDrop(tx, player, enemy.isBoss === true)));
      if (enemy.isShiny) {
        const rareLootPool = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name })
          .from(itemsTable).where(sql`${itemsTable.tier} >= 3`);
        if (rareLootPool.length > 0) {
          const bonusLoot = rareLootPool[randomInt(0, rareLootPool.length - 1)]!;
          await tx.insert(telegramPlayerInventoryTable).values({ telegramId: player.telegramId, chatId: player.chatId, itemId: bonusLoot.itemId })
            .onConflictDoUpdate({ target: [telegramPlayerInventoryTable.telegramId, telegramPlayerInventoryTable.chatId, telegramPlayerInventoryTable.itemId], set: { quantity: sql`${telegramPlayerInventoryTable.quantity} + 1` } });
          lines.push(`✨ Shiny bonus drop: ${bonusLoot.name}!`);
        }
      }
    }
    lines.push(...levelMessages);
    if (petProgressMessage) lines.push(petProgressMessage.trim());
    lines.push(`❤️ Health: ${newHp}/${maxHp} HP · 💰 Coins: ${coins}.`);
    return {
      text: `${lines.join("\n")}\n\nWhat next? Rest to recover HP, or continue exploring right away.`,
      keyboard: { inline_keyboard: [[button("😴 Rest", "sleep"), button("🧭 Continue exploring", "explore")], [button("🏠 Main menu", "menu")]] },
    };
  }

  const updatedEnemy = { ...enemy, hp: enemyHp, attackBuff: 0, defenseBuff: 0 };
  const enemyDamage = incomingCombatDamage(player, enemy);
  let newHp = Math.max(0, combatHp - enemyDamage);
  if (newHp === 0 && classPassive(player) === "phoenixborn" && Math.random() < 0.35) {
    newHp = 1;
    lines.push("🔥 Phoenix Heart activates: you survive a fatal blow with 1 HP!");
  }
  lines.push(`💢 ${enemy.name} strikes back for ${enemyDamage} damage.`);

  if (newHp === 0) {
    if (enemy.isShadowClone) return resolveShadowCloneDefeat(tx, event, player, enemy);
    const coins = Math.max(0, player.coins - 5);
    await tx.update(telegramPlayersTable).set({ combat: null, hp: player.maxHp, coins, updatedAt: new Date() }).where(playerScope(event));
    lines.push(`You collapse, but wake up safe with full health. You lose 5 coins (${coins} left).`);
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
  lines.push(`You: ${newHp}/${player.maxHp} HP · ${enemy.name}: ${enemyHp}/${enemy.maxHp} HP.`);
  return { text: lines.join("\n"), keyboard: await combatKeyboardFor(tx, player) };
}

async function defend(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  const enemy = player.combat;
  if (!enemy) return { text: "You are not in combat.", keyboard: menuKeyboard };
  const equipped = await getEquippedItems(tx, player);
  const hasShield = equipped.some(
    (item) => item.type === "Off-Hand" && /shield/i.test(item.name),
  );
  if (!hasShield) {
    return { text: "You need an equipped shield to use Defense.", keyboard: await combatKeyboardFor(tx, player) };
  }

  const incomingDamage = incomingCombatDamage(player, enemy);
  const blocked = Math.random() < 0.30;
  const damage = blocked ? 0 : Math.max(1, Math.ceil(incomingDamage / 2));
  const hp = Math.max(0, player.hp - damage);
  const lines = [
    blocked
      ? `🛡️ Perfect block! You take no damage from ${enemy.name}.`
      : `🛡️ You brace behind your shield and take half damage (${damage} instead of ${incomingDamage}) from ${enemy.name}.`,
  ];

  if (hp === 0) {
    if (enemy.isShadowClone) return resolveShadowCloneDefeat(tx, event, player, enemy);
    const coins = Math.max(0, player.coins - 5);
    await tx.update(telegramPlayersTable)
      .set({ combat: null, hp: player.maxHp, coins, updatedAt: new Date() })
      .where(playerScope(event));
    lines.push(`💀 You are defeated and respawn with full health. You lose 5 coins (${coins} left).`);
    return { text: lines.join("\n"), keyboard: menuKeyboard };
  }

  await tx.update(telegramPlayersTable)
    .set({ hp, updatedAt: new Date() })
    .where(playerScope(event));
  lines.push(`❤️ Health: ${hp}/${player.maxHp} HP · ${enemy.name}: ${enemy.hp}/${enemy.maxHp} HP.`);
  return { text: lines.join("\n"), keyboard: await combatKeyboardFor(tx, player) };
}

async function consumableInventoryReply(tx: Tx, player: TelegramPlayer, inCombat: boolean): Promise<Reply> {
  return backpackReply(tx, player, undefined, "Consumables");
}

async function useConsumable(tx: Tx, event: IncomingEvent, player: TelegramPlayer, inventoryId: number): Promise<Reply> {
  // Compatibility: healing potions earned by exploration/combat are stored in the legacy player.potions counter.
  // Give them a stable virtual inventory ID without migrating or resetting existing player data.
  if (inventoryId === 999) return usePotion(tx, event, player);
  const [owned] = await tx.select({ inventoryId: telegramPlayerInventoryTable.inventoryId, itemId: itemsTable.itemId, name: itemsTable.name, rarity: itemsTable.rarity, stats: itemsTable.stats, passiveOrEffect: itemsTable.passiveOrEffect, quantity: telegramPlayerInventoryTable.quantity })
    .from(telegramPlayerInventoryTable).innerJoin(itemsTable, eq(telegramPlayerInventoryTable.itemId, itemsTable.itemId))
    .where(and(eq(telegramPlayerInventoryTable.telegramId, player.telegramId), eq(telegramPlayerInventoryTable.chatId, player.chatId), eq(telegramPlayerInventoryTable.inventoryId, inventoryId), eq(itemsTable.type, "Consumables"))).limit(1);
  if (!owned) return { text: "You do not own that consumable.", keyboard: player.combat ? await combatKeyboardFor(tx, player) : menuKeyboard };
  const effect = String(owned.stats.effect ?? owned.passiveOrEffect ?? "");
  const power = typeof owned.stats.power === "number" ? Math.max(0, Math.trunc(owned.stats.power)) : 0;
  if (effect === "catch_monster" || owned.itemId === "catching_net" || owned.name.toLowerCase() === "catching net") {
    const enemy = player.combat;
    if (!enemy) return { text: "The Catching Net can only be used during combat.", keyboard: await backpackReply(tx, player) };
    if (enemy.isBoss || enemy.hp >= enemy.maxHp * 0.5) return { text: enemy.isBoss ? "Bosses cannot be captured." : "The monster must be below 50% HP before it can be captured.", keyboard: await combatKeyboardFor(tx, player) };
    const missingRatio = 1 - enemy.hp / enemy.maxHp;
    const chance = Math.min(0.95, Math.max(0.10, missingRatio));
    if (Math.random() >= chance) {
      const retaliation = Math.max(0, incomingCombatDamage(player, enemy));
      const hp = Math.max(1, player.hp - retaliation);
      await tx.update(telegramPlayersTable).set({ hp, updatedAt: new Date() }).where(playerScope(event));
      return { text: `🕸️ The Catching Net failed to hold ${enemy.name}! The net is reusable. ${enemy.name} strikes for ${retaliation} damage.`, keyboard: await combatKeyboardFor(tx, { ...player, hp }) };
    }
    const [current] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.active, 1), eq(telegramPetsTable.boxed, 0))).limit(1);
    if (current) await tx.update(telegramPetsTable).set({ active: 0, boxed: 1, updatedAt: new Date() }).where(eq(telegramPetsTable.id, current.id));
    await tx.insert(telegramPetsTable).values({ telegramId: player.telegramId, chatId: player.chatId, species: enemy.name.replace(/^✨Shiny✨\s*/, "").replace(/^★ Rare\s*/, ""), isShiny: enemy.isShiny === true, originalOwnerName: player.characterName, nickname: "__PENDING_NAME__", level: 1, xp: 0, active: 1, boxed: 0 });
    await tx.update(telegramPlayersTable).set({ combat: null, updatedAt: new Date() }).where(playerScope(event));
    return { text: `✨ You captured ${enemy.name}!

Write a name for your new companion in the chat. The Catching Net was not consumed.${current ? ` Your previous pet, ${current.nickname}, has been moved to /box.` : ""}`, keyboard: menuKeyboard };
  }
  if ((effect === "attack" || effect === "defense" || effect === "damage" || effect === "escape") && !player.combat) {
    return { text: `${owned.name} can only be used during combat.`, keyboard: await backpackReply(tx, player) };
  }
  if ((effect === "coins" || effect === "xp") && player.combat) {
    return { text: `${owned.name} can only be used outside combat.`, keyboard: await combatKeyboardFor(tx, player) };
  }

  if (effect === "heal" && player.hp >= player.maxHp) {
    return { text: "Your health is already full. The consumable was not used.", keyboard: player.combat ? await combatKeyboardFor(tx, player) : await backpackReply(tx, player) };
  }
  if (!player.combat && !["heal", "coins", "xp"].includes(effect)) {
    return { text: `${owned.name} can only be used during combat.`, keyboard: await backpackReply(tx, player) };
  }

  // Consume exactly one copy only after all validity checks have passed.
  // inventoryId identifies the owned inventory row; itemId identifies the shared catalog item.
  // Use the resolved row's inventoryId here so consuming an item never references an undefined variable.
  if (owned.quantity > 1) {
    await tx.update(telegramPlayerInventoryTable)
      .set({ quantity: sql`${telegramPlayerInventoryTable.quantity} - 1` })
      .where(and(
        eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
        eq(telegramPlayerInventoryTable.chatId, player.chatId),
        eq(telegramPlayerInventoryTable.inventoryId, owned.inventoryId),
      ));
  } else {
    await tx.delete(telegramPlayerInventoryTable).where(and(
      eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
      eq(telegramPlayerInventoryTable.chatId, player.chatId),
      eq(telegramPlayerInventoryTable.inventoryId, owned.inventoryId),
    ));
  }

  if (effect === "escape") {
    await tx.update(telegramPlayersTable).set({ combat: null, updatedAt: new Date() }).where(playerScope(event));
    return { text: `🌫️ ${owned.name} activates. You escape ${player.combat!.name} safely!`, keyboard: menuKeyboard };
  }
  if (effect === "coins") {
    await tx.update(telegramPlayersTable).set({ coins: player.coins + power, updatedAt: new Date() }).where(playerScope(event));
    return { text: `💰 You use ${owned.name} and gain ${power} coins. Balance: ${player.coins + power}.`, keyboard: await backpackReply(tx, { ...player, coins: player.coins + power }, `${owned.name} used.`) };
  }
  if (effect === "xp") {
    let xp = player.xp + power; let level = player.level; let maxHp = player.maxHp; let attack = player.attack; let defense = player.defense; const lines = [`📘 ${owned.name} grants ${power} XP.`];
    while (xp >= xpToNext(level)) { xp -= xpToNext(level); level++; maxHp += 5; attack++; if (level % 2 === 0) defense++; lines.push(`🎉 You reach level ${level}: +5 max HP and +1 attack.`); }
    await tx.update(telegramPlayersTable).set({ xp, level, maxHp, hp: Math.min(maxHp, player.hp), attack, defense, updatedAt: new Date() }).where(playerScope(event));
    return { text: lines.join("\n"), keyboard: menuKeyboard };
  }

  if (!player.combat) {
    const healed = effect === "heal" ? Math.min(power, player.maxHp - player.hp) : 0;
    if (healed <= 0) return { text: `${owned.name} has no effect outside combat.`, keyboard: await backpackReply(tx, player) };
    await tx.update(telegramPlayersTable).set({ hp: player.hp + healed, updatedAt: new Date() }).where(playerScope(event));
    return { text: `❤️ You use ${owned.name} and recover ${healed} HP. Health: ${player.hp + healed}/${player.maxHp}.`, keyboard: await backpackReply(tx, { ...player, hp: player.hp + healed }, `${owned.name} used.`) };
  }

  const enemy = player.combat;
  let enemyState = { ...enemy };
  let hp = player.hp;
  const lines = [`🧪 You use ${owned.name}.`];
  if (effect === "heal") { const healed = Math.min(power, player.maxHp - hp); hp += healed; lines.push(`❤️ You recover ${healed} HP.`); }
  else if (effect === "damage") { const damage = Math.min(power, Math.max(0, enemyState.hp - 1)); enemyState.hp -= damage; lines.push(`💥 ${enemy.name} takes ${damage} damage.`); }
  else if (effect === "attack") { enemyState.attackBuff = (enemyState.attackBuff ?? 0) + power; lines.push(`⚔️ Your next attack gains +${power} damage.`); }
  else if (effect === "defense") { enemyState.defenseBuff = (enemyState.defenseBuff ?? 0) + power; lines.push(`🛡️ Your next hit is reduced by ${power} damage.`); }
  const enemyDamage = Math.max(0, incomingCombatDamage(player, enemyState) - (enemyState.defenseBuff ?? 0));
  enemyState.defenseBuff = 0;
  hp = Math.max(0, hp - enemyDamage);
  lines.push(`💢 ${enemy.name} strikes back for ${enemyDamage} damage.`);
  if (hp <= 0) {
    const coins = Math.max(0, player.coins - 5);
    await tx.update(telegramPlayersTable).set({ combat: null, hp: player.maxHp, coins, updatedAt: new Date() }).where(playerScope(event));
    lines.push(`💀 You are defeated and respawn with full health. You lose 5 coins (${coins} left).`);
    return { text: lines.join("\n"), keyboard: menuKeyboard };
  }
  await tx.update(telegramPlayersTable).set({ combat: enemyState, hp, updatedAt: new Date() }).where(playerScope(event));
  lines.push(`❤️ Health: ${hp}/${player.maxHp} HP · ${enemy.name}: ${enemyState.hp}/${enemyState.maxHp} HP.`);
  return { text: lines.join("\n"), keyboard: await combatKeyboardFor(tx, { ...player, hp, combat: enemyState }) };
}

async function usePotion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  if (!player.combat) return { text: "Potions can only be used during combat.", keyboard: menuKeyboard };
  if (player.potions <= 0) return { text: "You have no potions. Try exploring to find one.", keyboard: await combatKeyboardFor(tx, player) };

  const healed = Math.min(15, player.maxHp - player.hp);
  const hp = player.hp + healed;
  const enemyDamage = incomingCombatDamage(player, player.combat);
  const newHp = Math.max(0, hp - enemyDamage);
  const lines = [`You drink a potion and recover ${healed} HP.`, `${player.combat.name} hits you for ${enemyDamage} damage.`];

  if (newHp === 0) {
    if (player.combat.isShadowClone) {
      await tx.update(telegramPlayersTable).set({ potions: player.potions - 1, updatedAt: new Date() }).where(playerScope(event));
      return resolveShadowCloneDefeat(tx, event, { ...player, potions: player.potions - 1 }, player.combat);
    }
    const coins = Math.max(0, player.coins - 5);
    await tx.update(telegramPlayersTable).set({ combat: null, hp: player.maxHp, potions: player.potions - 1, coins, updatedAt: new Date() }).where(playerScope(event));
    lines.push(`You collapse and wake up safe. You lose 5 coins (${coins} left).`);
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
  lines.push(`❤️ Health: ${newHp}/${player.maxHp} HP · 🧪 Potions: ${player.potions - 1}.`);
  return { text: lines.join("\n"), keyboard: await combatKeyboardFor(tx, player) };
}

async function flee(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<Reply> {
  const enemy = player.combat;
  if (!enemy) return { text: "There is nothing to flee from.", keyboard: menuKeyboard };

  if (Math.random() < 0.6) {
    await tx
      .update(telegramPlayersTable)
      .set({ combat: null, updatedAt: new Date() })
      .where(playerScope(event));
    return { text: `You slip away from ${enemy.name} and return to the path.`, keyboard: menuKeyboard };
  }

  const damage = incomingCombatDamage(player, enemy);
  const hp = Math.max(0, player.hp - damage);
  if (hp === 0) {
    if (enemy.isShadowClone) return resolveShadowCloneDefeat(tx, event, player, enemy);
    const coins = Math.max(0, player.coins - 5);
    await tx.update(telegramPlayersTable).set({ combat: null, hp: player.maxHp, coins, updatedAt: new Date() }).where(playerScope(event));
    return { text: `You fail to escape: ${enemy.name} deals ${damage} damage to you. You wake up safe and lose 5 coins.`, keyboard: menuKeyboard };
  }

  await tx
    .update(telegramPlayersTable)
    .set({ hp, updatedAt: new Date() })
    .where(playerScope(event));
  return {
    text: `You fail to escape: ${enemy.name} deals ${damage} damage to you. You have ${hp}/${player.maxHp} HP.`,
    keyboard: await combatKeyboardFor(tx, player),
  };
}

async function sleep(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  confirmed: boolean,
): Promise<Reply> {
  if (player.combat) {
    return {
      text: `You can't sleep while fighting ${player.combat.name}.`,
      keyboard: await combatKeyboardFor(tx, player),
    };
  }
  const missingHp = player.maxHp - player.hp;
  if (missingHp <= 0) {
    return {
      text: `You are already in perfect shape (${player.hp}/${player.maxHp} HP). You don't need to sleep.`,
      keyboard: menuKeyboard,
    };
  }
  const cost = sleepCost(missingHp);
  if (player.coins < cost) {
    return {
      text: `Recovering ${missingHp} HP costs ${cost} coins, but you only have ${player.coins}.`,
      keyboard: menuKeyboard,
    };
  }
  if (!confirmed) {
    return {
      text: [
        `🛏️ A night of rest will restore ${missingHp} HP (${player.hp}/${player.maxHp}).`,
        `Cost: ${cost} coins · You have ${player.coins}.`,
      ].join("\n"),
      keyboard: {
        inline_keyboard: [
          [button(`✅ Confirm · ${cost} coins`, "sleep:confirm")],
          [button("❌ Cancel", "menu")],
        ],
      },
    };
  }
  const coins = player.coins - cost;
  await tx
    .update(telegramPlayersTable)
    .set({ hp: player.maxHp, coins, updatedAt: new Date() })
    .where(playerScope(event));
  return {
    text: [
      `😴 You sleep at an inn and recover ${missingHp} HP for ${cost} coins.`,
      `❤️ Health: ${player.maxHp}/${player.maxHp} HP · 💰 Coins: ${coins}.`,
    ].join("\n"),
    keyboard: menuKeyboard,
  };
}

async function startBossFight(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  regionId: string,
): Promise<Reply> {
  const region = regions.find((candidate) => candidate.id === Number(regionId));
  if (!region || region.id !== player.biomeId) {
    return { text: "You can only fight the boss in the region where you are.", keyboard: menuKeyboard };
  }
  if (player.combat) {
    return { text: `You are already fighting ${player.combat.name}.`, keyboard: await combatKeyboardFor(tx, player) };
  }
  if (player.level < region.boss.minLevel) {
    return {
      text: `${region.boss.name} is too strong. Reach level ${region.boss.minLevel}.`,
      keyboard: placesKeyboard(player),
    };
  }
  if (player.hp <= 0) {
    return { text: "You are too wounded to continue. Rest and try again.", keyboard: menuKeyboard };
  }
  const { minLevel: _minLevel, ...template } = region.boss;
  const enemy: CombatState = {
    ...template,
    maxHp: template.hp,
    biomeId: region.id,
    isBoss: true,
  };
  await tx
    .update(telegramPlayersTable)
    .set({ combat: enemy, updatedAt: new Date() })
    .where(playerScope(event));
  return {
    text: `👹 ${enemy.name} appears before you! (${enemy.hp} HP)\n\nWhat do you do?`,
    keyboard: await combatKeyboardFor(tx, player),
  };
}

async function chooseRegion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
  player: TelegramPlayer,
  regionId: string,
): Promise<Reply> {
  const region = regions.find((candidate) => candidate.id === Number(regionId));
  if (!region) return { text: "This place does not exist.", keyboard: placesKeyboard(player) };
  if (player.level < region.level) {
    return {
      text: `${region.name} is too dangerous. Reach level ${region.level} to enter.`,
      keyboard: placesKeyboard(player),
    };
  }
  if (player.combat) {
    return { text: "You must finish the current fight first.", keyboard: await combatKeyboardFor(tx, player) };
  }
  await tx
    .update(telegramPlayersTable)
    .set({ biomeId: region.id, updatedAt: new Date() })
    .where(playerScope(event));
  return { text: `You travel to ${region.name}. Use Explore whenever you like.`, keyboard: menuKeyboard };
}

// ---------------------------------------------------------------------------
// Lobbies: co-op boss fights (/boss) and duels (/duel)
// ---------------------------------------------------------------------------

const LOBBY_SECONDS = 30; // how long a lobby stays open
const ROUND_SECONDS = 20; // time to pick a move each round (idle players auto-attack)
const BOSS_MAX_PLAYERS = 4;
const ARENA_MAX_PLAYERS = 8;
const ARENA_LOBBY_SECONDS = 60;
const ARENA_COOLDOWN_MS = 30 * 60 * 1000;
const POTION_HEAL = 15;
// Duel rewards. XP is a percentage of the XP needed to level up at the
// opponent's level: (level + 1) * 35.
const DUEL_WINNER_PCT = 0.4; // winner: +40% of the loser's coins and +40% XP
const DUEL_LOSER_COIN_PCT = 0.15; // loser: -15% of their own coins
const DUEL_LOSER_XP_PCT = 0.05; // loser: +5% XP

function toast(text: string): Reply {
  return { text: "", callbackText: text };
}

function plainName(actor: Actor): string {
  const raw = actor.firstName || actor.username || "Adventurer";
  return raw.replace(/@/g, "").trim() || "Adventurer";
}

function xpToNext(level: number): number {
  const base = (level + 1) * 35;
  // From level 20 onward, progression slows by 50% to make high levels more meaningful.
  return level >= 20 ? Math.ceil(base * 1.5) : base;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function hpBar(current: number, max: number, width = 8): string {
  const filled =
    max > 0 ? Math.round((Math.max(0, current) / max) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function applyXp(
  base: { xp: number; level: number; maxHp: number; attack: number; defense: number },
  gained: number,
) {
  let { xp, level, maxHp, attack, defense } = base;
  xp += gained;
  let levelsGained = 0;
  while (xp >= xpToNext(level)) {
    xp -= xpToNext(level);
    level += 1;
    maxHp += 5;
    attack += 1;
    if (level % 2 === 0) defense += 1;
    levelsGained += 1;
  }
  return { xp, level, maxHp, attack, defense, levelsGained };
}

function playerWhere(telegramId: string, chatId: string) {
  return and(
    eq(telegramPlayersTable.telegramId, telegramId),
    eq(telegramPlayersTable.chatId, chatId),
  );
}

async function loadPlayer(
  tx: Tx,
  telegramId: string,
  chatId: string,
): Promise<TelegramPlayer | null> {
  const [player] = await tx
    .select()
    .from(telegramPlayersTable)
    .where(playerWhere(telegramId, chatId))
    .limit(1);
  return player ?? null;
}

async function lockLobby(tx: Tx, id: number): Promise<TelegramLobby | null> {
  const [lobby] = await tx
    .select()
    .from(telegramLobbiesTable)
    .where(eq(telegramLobbiesTable.id, id))
    .limit(1)
    .for("update");
  return lobby ?? null;
}

// The open lobby the player is waiting in, or the fight they are still part of.
async function findActiveLobbyFor(
  tx: Tx,
  chatId: string,
  telegramId: string,
): Promise<TelegramLobby | null> {
  const rows = await tx
    .select()
    .from(telegramLobbiesTable)
    .where(
      and(
        eq(telegramLobbiesTable.chatId, chatId),
        inArray(telegramLobbiesTable.status, ["open", "active"]),
      ),
    );
  return (
    rows.find((lobby) =>
      lobby.status === "open"
        ? lobby.state.members.some((m) => m.telegramId === telegramId)
        : lobby.state.fighters.some(
            (f) => f.telegramId === telegramId && !f.fled,
          ),
    ) ?? null
  );
}

async function lobbyBlockReason(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
): Promise<string | null> {
  if (player.combat) {
    return `You are already fighting ${player.combat.name}. Finish that fight first.`;
  }
  const active = await findActiveLobbyFor(tx, event.chatId, event.actor.id);
  if (active) {
    return active.status === "open"
      ? "You are already waiting in a lobby."
      : "You are in the middle of a fight.";
  }
  return null;
}

function fighterLine(f: Fighter): string {
  if (f.fled) return `🏃 ${f.name} (fled)`;
  const icon = !f.alive ? "💀" : f.action ? "✅" : "⏳";
  return `${icon} ${f.name} ❤️ ${f.hp}/${f.maxHp} ${hpBar(f.hp, f.maxHp)}`;
}

function renderOpenLobby(lobby: TelegramLobby): string {
  const secs = Math.max(
    0,
    Math.ceil((lobby.expiresAt.getTime() - Date.now()) / 1000),
  );
  const members = lobby.state.members;
  if (lobby.kind === "duel") {
    const host = members[0]!;
    return [
      "⚔️ Duel lobby",
      `${host.name} (Lv ${host.level}) ${lobby.state.targetName ? `challenged ${lobby.state.targetName}` : "is looking for an opponent"}!`,
      "",
      `⏳ ${lobby.state.targetName ? `${lobby.state.targetName} can accept` : "Anyone can accept"} within ${secs}s.`,
    ].join("\n");
  }
  if (lobby.kind === "arena") return [
    "🏟️ Arena lobby", `Players ${members.length}/${ARENA_MAX_PLAYERS}`, ...members.map((m) => `• ${m.name} (Lv ${m.level})`),
    "", `⏳ Arena starts in ${secs}s. Join now! Maximum 8 players; last survivor wins.`
  ].join("\n");
  const region = getRegion(lobby.regionId ?? 1);
  return [
    `🐉 Boss lobby: ${region.boss.name} (${region.name})`,
    `Party ${members.length}/${BOSS_MAX_PLAYERS}:`,
    ...members.map((m) => `• ${m.name} (Lv ${m.level})`),
    "",
    `⏳ The fight starts in ${secs}s, or as soon as the party is full.`,
    `Requires being in ${region.name} at level ${region.boss.minLevel}+.`,
  ].join("\n");
}

function renderBattle(lobby: TelegramLobby): string {
  const s = lobby.state;
  const head =
    lobby.kind === "boss" && s.boss
      ? [
          `🐉 ${s.boss.name}`,
          `❤️ ${s.boss.hp}/${s.boss.maxHp} ${hpBar(s.boss.hp, s.boss.maxHp, 12)}`,
        ]
      : [`⚔️ Duel: ${s.fighters.map((f) => f.name).join(" vs ")}`];
  return [
    ...head,
    "",
    ...s.fighters.map(fighterLine),
    "",
    `Round ${lobby.round} · pick a move within ${ROUND_SECONDS}s (idle players auto-attack)`,
    ...(s.log.length > 0 ? ["", "Last round:", ...s.log] : []),
  ].join("\n");
}

function lobbyKeyboard(lobby: TelegramLobby): InlineKeyboardMarkup | undefined {
  if (lobby.status === "open") {
    return {
      inline_keyboard: [
        [
          button(
            lobby.kind === "duel" ? "⚔️ Accept the duel" : lobby.kind === "arena" ? "🏟️ Join Arena" : "🤝 Join the fight",
            `lobby:join:${lobby.id}`,
          ),
        ],
        [button("⬅️ Back", "menu")],
      ],
    };
  }
  if (lobby.status === "active") {
    return {
      inline_keyboard: [
        [
          button("⚔️ Attack", `lobby:act:${lobby.id}:attack`),
          button("🧪 Potion", `lobby:act:${lobby.id}:potion`),
        ],
        [
          button(
            lobby.kind === "duel" ? "🏳️ Forfeit" : "🏃 Flee",
            `lobby:act:${lobby.id}:flee`,
          ),
        ],
      ],
    };
  }
  return undefined;
}

function lobbyReply(
  lobby: TelegramLobby,
  action: "post" | "edit" = "edit",
  callbackText?: string,
): Reply {
  return {
    text: lobby.status === "open" ? renderOpenLobby(lobby) : renderBattle(lobby),
    keyboard: lobbyKeyboard(lobby),
    lobbyId: lobby.id,
    lobbyAction: action,
    callbackText,
  };
}

function finishedReply(lobby: TelegramLobby, text: string): Reply {
  return { text, lobbyId: lobby.id, lobbyAction: "edit" };
}

async function markFinished(
  tx: Tx,
  lobbyId: number,
  state: LobbyState,
): Promise<void> {
  await tx
    .update(telegramLobbiesTable)
    .set({
      status: "finished",
      roundDeadline: null,
      state,
      updatedAt: new Date(),
    })
    .where(eq(telegramLobbiesTable.id, lobbyId));
}

async function openLobby(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  kind: "boss" | "duel" | "arena",
  target?: { telegramId: string; name: string },
): Promise<Reply> {
  if (kind === "duel" && event.chatType === "private") {
    return {
      text: "Duels need at least two players. Add me to a group chat to challenge your friends!",
      keyboard: menuKeyboard,
    };
  }
  if (kind === "arena") {
    if (event.chatType === "private") return { text: "Arena is available in group chats only.", keyboard: menuKeyboard };
    const recent = await tx.select({ id: telegramLobbiesTable.id }).from(telegramLobbiesTable).where(and(
      eq(telegramLobbiesTable.chatId, event.chatId), eq(telegramLobbiesTable.kind, "arena"),
      sql`${telegramLobbiesTable.createdAt} > ${new Date(Date.now() - ARENA_COOLDOWN_MS)}`,
    )).limit(1);
    if (recent.length) {
      const [last] = await tx.select({ createdAt: telegramLobbiesTable.createdAt }).from(telegramLobbiesTable).where(and(eq(telegramLobbiesTable.chatId, event.chatId), eq(telegramLobbiesTable.kind, "arena"))).orderBy(desc(telegramLobbiesTable.createdAt)).limit(1);
      const remaining = Math.max(1, Math.ceil((ARENA_COOLDOWN_MS - (Date.now() - (last?.createdAt.getTime() ?? Date.now()))) / 60000));
      return { text: `🏟️ Arena is on cooldown for this group. Try again in about ${remaining} minute(s).`, keyboard: menuKeyboard };
    }
  }
  const block = await lobbyBlockReason(tx, event, player);
  if (block) return { text: block, keyboard: menuKeyboard };

  const region = getRegion(player.biomeId);
  if (kind === "boss") {
    const cooldownSince = new Date(Date.now() - 60_000);
    const recentBoss = await tx.select({ id: telegramLobbiesTable.id, updatedAt: telegramLobbiesTable.updatedAt })
      .from(telegramLobbiesTable)
      .where(and(
        eq(telegramLobbiesTable.chatId, event.chatId),
        eq(telegramLobbiesTable.kind, "boss"),
        eq(telegramLobbiesTable.regionId, region.id),
        eq(telegramLobbiesTable.status, "finished"),
        sql`${telegramLobbiesTable.updatedAt} > ${cooldownSince}`,
      ))
      .orderBy(desc(telegramLobbiesTable.updatedAt))
      .limit(1);
    if (recentBoss.length) {
      const remaining = Math.max(1, Math.ceil((60_000 - (Date.now() - recentBoss[0]!.updatedAt.getTime())) / 1000));
      return { text: `⏳ The boss is recovering. The whole group can challenge it again in ${remaining} second(s).`, keyboard: menuKeyboard };
    }
  }
  if (kind === "boss" && player.level < region.boss.minLevel) {
    return {
      text: `${region.boss.name} is too strong. Reach level ${region.boss.minLevel}.`,
      keyboard: menuKeyboard,
    };
  }

  const member: LobbyMember = {
    telegramId: event.actor.id,
    name: plainName(event.actor),
    level: player.level,
  };
  const [lobby] = await tx
    .insert(telegramLobbiesTable)
    .values({
      chatId: event.chatId,
      kind,
      status: "open",
      hostId: event.actor.id,
      regionId: kind === "boss" ? region.id : null,
      expiresAt: new Date(Date.now() + (kind === "arena" ? ARENA_LOBBY_SECONDS : LOBBY_SECONDS) * 1000),
      state: { members: [member], fighters: [], boss: null, log: [], ...(target ? { targetTelegramId: target.telegramId, targetName: target.name } : {}) },
    })
    .returning();
  if (!lobby) throw new Error("Lobby could not be created");

  // Nobody else can join a private chat, so a solo boss fight starts right away.
  if (kind === "boss" && event.chatType === "private") {
    const started = await startFight(tx, lobby, "post");
    return { ...started, cleanupOwner: true };
  }
  return { ...lobbyReply(lobby, "post"), cleanupOwner: true };
}

async function joinLobby(
  tx: Tx,
  event: IncomingEvent,
  player: TelegramPlayer,
  lobbyId: number,
): Promise<Reply> {
  if (!Number.isInteger(lobbyId)) return toast("This lobby no longer exists.");
  const lobby = await lockLobby(tx, lobbyId);
  if (!lobby || lobby.chatId !== event.chatId) {
    return toast("This lobby no longer exists.");
  }
  if (lobby.status !== "open" || lobby.expiresAt.getTime() <= Date.now()) {
    return toast("This lobby is closed.");
  }
  if (lobby.state.members.some((m) => m.telegramId === event.actor.id)) {
    return toast(
      lobby.kind === "duel"
        ? "You can't duel yourself."
        : "You are already in this party.",
    );
  }
  if (lobby.kind === "duel" && lobby.state.targetTelegramId && lobby.state.targetTelegramId !== event.actor.id) {
    return toast(`This duel invitation is for @${lobby.state.targetName ?? "the invited player"} only.`);
  }
  const block = await lobbyBlockReason(tx, event, player);
  if (block) return toast(block);

  if (lobby.kind === "arena" && lobby.state.members.length >= ARENA_MAX_PLAYERS) return toast("The Arena is full (8/8 players). Wait for the next one!");
  if (lobby.kind === "boss") {
    const region = getRegion(lobby.regionId ?? 1);
    if (lobby.state.members.length >= BOSS_MAX_PLAYERS) {
      return toast("The party is full.");
    }
    if (player.biomeId !== region.id) {
      return toast(`You must be in ${region.name} to join this fight.`);
    }
    if (player.level < region.boss.minLevel) {
      return toast(
        `You need level ${region.boss.minLevel} to fight ${region.boss.name}.`,
      );
    }
  }

  const members: LobbyMember[] = [
    ...lobby.state.members,
    {
      telegramId: event.actor.id,
      name: plainName(event.actor),
      level: player.level,
    },
  ];
  const [updated] = await tx
    .update(telegramLobbiesTable)
    .set({ state: { ...lobby.state, members }, updatedAt: new Date() })
    .where(eq(telegramLobbiesTable.id, lobby.id))
    .returning();
  if (!updated) return toast("This lobby no longer exists.");

  if (lobby.kind === "duel" || (lobby.kind === "boss" && members.length >= BOSS_MAX_PLAYERS)) {
    return { ...(await startFight(tx, updated, "edit")), callbackText: "Fight!" };
  }
  return lobbyReply(updated, "edit", "You joined the party!");
}

async function startFight(
  tx: Tx,
  lobby: TelegramLobby,
  action: "post" | "edit",
): Promise<Reply> {
  const fighters: Fighter[] = [];
  for (const member of lobby.state.members) {
    const p = await loadPlayer(tx, member.telegramId, lobby.chatId);
    if (!p) continue;
    fighters.push({
      telegramId: p.telegramId,
      name: member.name,
      // Duels are friendly: everybody starts at full health and real HP is untouched.
      hp: lobby.kind === "duel" ? p.maxHp : Math.max(1, p.hp),
      maxHp: p.maxHp,
      attack: p.attack,
      defense: p.defense,
      crit: await getCritChance(tx, p),
      doubleHitChance: (await getEquippedItems(tx, p)).reduce((sum, item) => {
        const chance = item.stats.double_hit_chance;
        return sum + (typeof chance === "number" ? chance : 0);
      }, 0),
      potions: p.potions,
      potionsUsed: 0,
      alive: true,
      fled: false,
      action: null,
      dealt: 0,
      taken: 0,
    });
  }
  if (fighters.length < (lobby.kind === "duel" ? 2 : 1)) {
    await markFinished(tx, lobby.id, lobby.state);
    return finishedReply(lobby, "The fight was cancelled: not enough players.");
  }

  let boss: CombatState | null = null;
  if (lobby.kind === "arena" && lobby.state.members.length >= ARENA_MAX_PLAYERS) return toast("The Arena is full (8/8 players). Wait for the next one!");
  if (lobby.kind === "boss") {
    const region = getRegion(lobby.regionId ?? 1);
    const { minLevel: _minLevel, ...template } = region.boss;
    boss = { ...template, maxHp: template.hp, biomeId: region.id, isBoss: true };
  }

  const [updated] = await tx
    .update(telegramLobbiesTable)
    .set({
      status: "active",
      round: 1,
      roundDeadline: new Date(Date.now() + ROUND_SECONDS * 1000),
      state: { ...lobby.state, fighters, boss, log: [] },
      updatedAt: new Date(),
    })
    .where(eq(telegramLobbiesTable.id, lobby.id))
    .returning();
  if (!updated) throw new Error("Lobby could not be started");
  return lobbyReply(updated, action);
}

function rollAttack(f: Fighter): { damage: number; crit: boolean; doubleHit: boolean } {
  const base = Math.max(1, f.attack + randomInt(0, 3) - 1);
  const crit = f.crit > 0 && Math.random() < f.crit;
  const damage = crit ? base * 2 : base;
  const doubleHit = (f.doubleHitChance ?? 0) > 0 && Math.random() < (f.doubleHitChance ?? 0);
  return { damage: doubleHit ? damage * 2 : damage, crit, doubleHit };
}

function resolveBossRound(state: LobbyState): {
  log: string[];
  result: "victory" | "defeat" | null;
} {
  const boss = state.boss!;
  const log: string[] = [];
  for (const f of state.fighters) {
    if (!f.alive || f.fled) continue;
    if (f.action === "potion" && f.potionsUsed < f.potions) {
      const healed = Math.min(POTION_HEAL, f.maxHp - f.hp);
      f.hp += healed;
      f.potionsUsed += 1;
      log.push(`🧪 ${f.name} drinks a potion (+${healed} HP).`);
      continue;
    }
    const rolled = rollAttack(f);
    const { damage, crit } = rolled;
    boss.hp = Math.max(0, boss.hp - damage);
    f.dealt += damage;
    log.push(
      rolled.doubleHit
        ? `⚔️ ${f.name} triggers a double hit on ${boss.name} for ${damage} total damage!`
        : crit
          ? `💥 ${f.name} crits ${boss.name} for ${damage}!`
          : `🗡️ ${f.name} hits ${boss.name} for ${damage}.`,
    );
    if (boss.hp === 0) return { log, result: "victory" };
  }

  const standing = state.fighters.filter((f) => f.alive && !f.fled);
  const attacks = Math.ceil(standing.length / 2);
  for (const target of shuffle(standing).slice(0, attacks)) {
    const damage = Math.max(
      1,
      boss.attack + randomInt(0, 2) - target.defense,
    );
    target.hp = Math.max(0, target.hp - damage);
    target.taken += damage;
    log.push(`💢 ${boss.name} hits ${target.name} for ${damage}.`);
    if (target.hp === 0) {
      target.alive = false;
      log.push(`💀 ${target.name} falls!`);
    }
  }
  const anyoneLeft = state.fighters.some((f) => f.alive && !f.fled);
  return { log, result: anyoneLeft ? null : "defeat" };
}

function resolveDuelRound(state: LobbyState): {
  log: string[];
  loserId: string | null;
} {
  const log: string[] = [];
  for (const f of shuffle(state.fighters)) {
    if (!f.alive || f.fled) continue;
    const target = state.fighters.find((other) => other !== f)!;
    if (f.action === "potion" && f.potionsUsed < f.potions) {
      const healed = Math.min(POTION_HEAL, f.maxHp - f.hp);
      f.hp += healed;
      f.potionsUsed += 1;
      log.push(`🧪 ${f.name} drinks a potion (+${healed} HP).`);
      continue;
    }
    const rolled = rollAttack(f);
    const damage = Math.max(1, rolled.damage - target.defense);
    target.hp = Math.max(0, target.hp - damage);
    f.dealt += damage;
    target.taken += damage;
    log.push(
      rolled.doubleHit
        ? `⚔️ ${f.name} triggers a double hit on ${target.name} for ${damage} total damage!`
        : rolled.crit
          ? `💥 ${f.name} crits ${target.name} for ${damage}!`
          : `🗡️ ${f.name} hits ${target.name} for ${damage}.`,
    );
    if (target.hp === 0) {
      target.alive = false;
      return { log, loserId: target.telegramId };
    }
  }
  return { log, loserId: null };
}

// Resolves the current round (idle players auto-attack) and either ends the
// fight or opens the next round.
async function settleRound(
  tx: Tx,
  lobby: TelegramLobby,
  state: LobbyState,
  prefix: string[] = [],
): Promise<Reply> {
  if (lobby.kind === "boss") {
    const out = resolveBossRound(state);
    state.log = [...prefix, ...out.log];
    if (out.result) return finishBoss(tx, lobby, state, out.result);
  } else {
    const out = resolveDuelRound(state);
    state.log = [...prefix, ...out.log];
    if (out.loserId) return finishDuel(tx, lobby, state, out.loserId, false);
  }
  for (const f of state.fighters) f.action = null;
  const [updated] = await tx
    .update(telegramLobbiesTable)
    .set({
      round: lobby.round + 1,
      roundDeadline: new Date(Date.now() + ROUND_SECONDS * 1000),
      state,
      updatedAt: new Date(),
    })
    .where(eq(telegramLobbiesTable.id, lobby.id))
    .returning();
  return lobbyReply(updated ?? { ...lobby, state });
}

async function lobbyAction(
  tx: Tx,
  event: IncomingEvent,
  lobbyId: number,
  action: string,
): Promise<Reply> {
  if (
    !Number.isInteger(lobbyId) ||
    (action !== "attack" && action !== "potion" && action !== "flee")
  ) {
    return toast("This fight is over.");
  }
  const lobby = await lockLobby(tx, lobbyId);
  if (!lobby || lobby.chatId !== event.chatId || lobby.status !== "active") {
    return toast("This fight is over.");
  }
  const state = lobby.state;
  const me = state.fighters.find((f) => f.telegramId === event.actor.id);
  if (!me || me.fled) return toast("You are not part of this fight.");
  if (!me.alive) return toast("You have fallen. Cheer on your friends!");

  let prefix: string[] = [];
  if (action === "flee") {
    me.fled = true;
    if (lobby.kind === "duel") {
      return finishDuel(tx, lobby, state, me.telegramId, true);
    }
    prefix = [`🏃 ${me.name} flees the battle!`];
    if (!state.fighters.some((f) => f.alive && !f.fled)) {
      state.log = prefix;
      return finishBoss(tx, lobby, state, "defeat");
    }
  } else {
    if (me.action) return toast("You already picked your move this round.");
    if (action === "potion" && me.potionsUsed >= me.potions) {
      return toast("You have no potions left.");
    }
    me.action = action;
  }

  const waiting = state.fighters.some(
    (f) => f.alive && !f.fled && f.action === null,
  );
  if (!waiting) return settleRound(tx, lobby, state, prefix);

  if (prefix.length > 0) state.log = prefix;
  const [updated] = await tx
    .update(telegramLobbiesTable)
    .set({ state, updatedAt: new Date() })
    .where(eq(telegramLobbiesTable.id, lobby.id))
    .returning();
  const text =
    action === "flee"
      ? "You fled the fight."
      : action === "potion"
        ? "Potion ready!"
        : "Attack ready!";
  return lobbyReply(updated ?? { ...lobby, state }, "edit", text);
}

async function finishDuel(
  tx: Tx,
  lobby: TelegramLobby,
  state: LobbyState,
  loserId: string,
  forfeit: boolean,
): Promise<Reply> {
  const winnerF = state.fighters.find((f) => f.telegramId !== loserId)!;
  const loserF = state.fighters.find((f) => f.telegramId === loserId)!;
  const winner = await loadPlayer(tx, winnerF.telegramId, lobby.chatId);
  const loser = await loadPlayer(tx, loserF.telegramId, lobby.chatId);
  if (!winner || !loser) {
    await markFinished(tx, lobby.id, state);
    return finishedReply(lobby, "The duel was cancelled.");
  }

  const winnerXp = Math.max(1, Math.round(DUEL_WINNER_PCT * xpToNext(loser.level) * (1 + (winner.rebirths ?? 0) * 0.05)));
  const loserXp = Math.max(1, Math.round(DUEL_LOSER_XP_PCT * xpToNext(winner.level) * (1 + (loser.rebirths ?? 0) * 0.05)));
  const winnerCoins = Math.floor(DUEL_WINNER_PCT * loser.coins * (1 + (winner.rebirths ?? 0) * 0.05));
  const loserCoinsLost = Math.floor(DUEL_LOSER_COIN_PCT * loser.coins);

  const w = applyXp(winner, winnerXp);
  const l = applyXp(loser, loserXp);
  await tx
    .update(telegramPlayersTable)
    .set({
      xp: w.xp,
      level: w.level,
      maxHp: w.maxHp,
      attack: w.attack,
      defense: w.defense,
      hp: clamp(winner.hp + w.levelsGained * 5, 1, w.maxHp),
      coins: winner.coins + winnerCoins,
      potions: Math.max(0, winner.potions - winnerF.potionsUsed),
      updatedAt: new Date(),
    })
    .where(playerWhere(winner.telegramId, lobby.chatId));
  await tx
    .update(telegramPlayersTable)
    .set({
      xp: l.xp,
      level: l.level,
      maxHp: l.maxHp,
      attack: l.attack,
      defense: l.defense,
      hp: clamp(loser.hp + l.levelsGained * 5, 1, l.maxHp),
      coins: Math.max(0, loser.coins - loserCoinsLost),
      potions: Math.max(0, loser.potions - loserF.potionsUsed),
      updatedAt: new Date(),
    })
    .where(playerWhere(loser.telegramId, lobby.chatId));

  const lines = [
    `🏆 ${winnerF.name} wins the duel against ${loserF.name}${forfeit ? " (forfeit)" : ""}!`,
    ...(state.log.length > 0 ? ["", ...state.log] : []),
    "",
    `${winnerF.name}: +${winnerCoins} coins · +${winnerXp} XP`,
    `${loserF.name}: -${loserCoinsLost} coins · +${loserXp} XP`,
  ];
  if (w.levelsGained > 0) lines.push(`⬆️ ${winnerF.name} reaches level ${w.level}!`);
  if (l.levelsGained > 0) lines.push(`⬆️ ${loserF.name} reaches level ${l.level}!`);

  await markFinished(tx, lobby.id, state);
  return finishedReply(lobby, lines.join("\n"));
}

async function finishBoss(
  tx: Tx,
  lobby: TelegramLobby,
  state: LobbyState,
  result: "victory" | "defeat",
): Promise<Reply> {
  const boss = state.boss!;
  const region = getRegion(lobby.regionId ?? 1);
  const nextRegion = regions[regions.findIndex((r) => r.id === region.id) + 1];
  const lines: string[] = [
    result === "victory"
      ? `🏆 ${boss.name} is defeated!`
      : `☠️ The party was wiped out by ${boss.name}. Survivors wake up safe, and everyone who fell loses 5 coins.`,
    ...(state.log.length > 0 ? ["", ...state.log] : []),
    "",
  ];

  // Rewards follow each player's contribution: damage dealt plus half of the damage taken.
  const eligible = state.fighters.filter((f) => !f.fled);
  const totalScore = eligible.reduce(
    (sum, f) => sum + f.dealt + f.taken * 0.5,
    0,
  );
  const coinPool = Math.max(1, Math.round(boss.xpReward / 5));

  for (const f of state.fighters) {
    const p = await loadPlayer(tx, f.telegramId, lobby.chatId);
    if (!p) continue;
    const potions = Math.max(0, p.potions - f.potionsUsed);

    if (f.fled) {
      await tx
        .update(telegramPlayersTable)
        .set({ hp: clamp(f.hp, 1, p.maxHp), potions, updatedAt: new Date() })
        .where(playerWhere(p.telegramId, lobby.chatId));
      lines.push(`🏃 ${f.name} fled and earns nothing.`);
      continue;
    }

    if (result === "defeat") {
      await tx
        .update(telegramPlayersTable)
        .set({
          hp: p.maxHp,
          coins: Math.max(0, p.coins - 5),
          potions,
          updatedAt: new Date(),
        })
        .where(playerWhere(p.telegramId, lobby.chatId));
      continue;
    }

    const score = f.dealt + f.taken * 0.5;
    const share = totalScore > 0 ? score / totalScore : 1 / eligible.length;
    const factor = 0.4 + 0.6 * share;
    const xpGain = Math.max(1, Math.round(boss.xpReward * factor * (1 + (p.rebirths ?? 0) * 0.05)));
    const coinGain = Math.max(1, Math.round(coinPool * factor * (1 + (p.rebirths ?? 0) * 0.05)));
    const grown = applyXp(p, xpGain);
    const drops = await grantDropNames(tx, p, boss.dropTable, true);

    let biomeId = p.biomeId;
    let zoneNote = "";
    if (nextRegion) {
      if (grown.level >= nextRegion.level) {
        biomeId = nextRegion.id;
        zoneNote = ` · 🗺️ moves on to ${nextRegion.name}`;
      } else {
        zoneNote = ` · 🔒 level ${nextRegion.level} needed for ${nextRegion.name}`;
      }
    }

    await tx
      .update(telegramPlayersTable)
      .set({
        xp: grown.xp,
        level: grown.level,
        maxHp: grown.maxHp,
        attack: grown.attack,
        defense: grown.defense,
        hp: f.alive
          ? clamp(f.hp + grown.levelsGained * 5, 1, grown.maxHp)
          : grown.maxHp,
        coins: (f.alive ? p.coins : Math.max(0, p.coins - 5)) + coinGain,
        potions,
        biomeId,
        updatedAt: new Date(),
      })
      .where(playerWhere(p.telegramId, lobby.chatId));

    lines.push(
      `${f.alive ? "✅" : "💀"} ${f.name}: +${xpGain} XP · +${coinGain} coins · ${f.dealt} dealt / ${f.taken} taken` +
        (grown.levelsGained > 0 ? ` · ⬆️ level ${grown.level}` : "") +
        (drops.length > 0 ? ` · 🎁 ${drops.join(", ")}` : "") +
        zoneNote,
    );
  }

  await markFinished(tx, lobby.id, state);
  return finishedReply(lobby, lines.join("\n").trimEnd());
}

async function finishArena(tx: Tx, lobby: TelegramLobby): Promise<Reply> {
  const members = lobby.state.members;
  if (members.length < 2) {
    await markFinished(tx, lobby.id, lobby.state);
    return finishedReply(lobby, "🏟️ Arena cancelled: at least 2 players are needed.");
  }
  const contestants = [] as Array<{ id: string; name: string; level: number; coins: number; xp: number; hp: number; attack: number; defense: number }>;
  for (const m of members) {
    const p = await loadPlayer(tx, m.telegramId, lobby.chatId);
    if (p) contestants.push({ id: p.telegramId, name: m.name, level: p.level, coins: p.coins, xp: p.xp, hp: p.maxHp, attack: p.attack, defense: p.defense });
  }
  if (contestants.length < 2) { await markFinished(tx, lobby.id, lobby.state); return finishedReply(lobby, "🏟️ Arena cancelled: not enough valid players."); }
  const avgLevel = Math.max(1, Math.round(contestants.reduce((n,p)=>n+p.level,0)/contestants.length));
  const log: string[] = ["🏟️ ARENA RESULTS", `Players: ${contestants.length}/8 · Average level: ${avgLevel}`, ""];
  const alive = [...contestants].sort(() => Math.random() - 0.5);
  const eliminationOrder: typeof contestants = [];
  while (alive.length > 1) {
    const victimIndex = Math.floor(Math.random() * alive.length);
    const victim = alive.splice(victimIndex, 1)[0]!;
    const killer = alive[Math.floor(Math.random() * alive.length)]!;
    eliminationOrder.unshift(victim);
    log.push(`⚔️ ${killer.name} eliminated ${victim.name}!`);
  }
  const winner = alive[0]!;
  const ordered = [winner, ...eliminationOrder];
  const baseXp = Math.max(20, avgLevel * 18);
  const baseCoins = Math.max(30, avgLevel * 25);
  for (let i=0;i<ordered.length;i++) {
    const p=ordered[i]!; const full=await loadPlayer(tx,p.id,lobby.chatId); if(!full) continue;
    const baseXpReward = i===0 ? baseXp*3 : i===1 ? Math.round(baseXp*1.8) : i===2 ? baseXp : Math.max(5,Math.round(baseXp*0.2));
    const xpReward = Math.floor(baseXpReward * (1 + (full.rebirths ?? 0) * 0.05));
    const baseCoinReward = i===0 ? baseCoins*4 : i===1 ? baseCoins*2 : i===2 ? baseCoins : 0;
    const coinReward = Math.floor(baseCoinReward * (1 + (full.rebirths ?? 0) * 0.05));
    const coinPenalty = i>=3 ? Math.min(full.coins, Math.max(5,Math.round(baseCoins*0.25))) : 0;
    const applied=applyXp(full,xpReward);
    await tx.update(telegramPlayersTable).set({xp:applied.xp,level:applied.level,maxHp:applied.maxHp,attack:applied.attack,defense:applied.defense,hp:clamp(full.hp+applied.levelsGained*5,1,applied.maxHp),coins:Math.max(0,full.coins+coinReward-coinPenalty),updatedAt:new Date()}).where(playerWhere(full.telegramId,lobby.chatId));
    log.push(`${i+1}. ${p.name}: ${i>=3?`-${coinPenalty} Coins · `:""}+${xpReward} XP${coinReward?` · +${coinReward} Coins`:""}`);
  }
  log.push("",`🏆 ARENA CHAMPION: ${winner.name}!`, `Rewards scale with the average level (${avgLevel}).`);
  await markFinished(tx,lobby.id,lobby.state);
  return finishedReply(lobby.id ? lobby : lobby, log.join("\n"));
}

async function closeOpenLobby(tx: Tx, lobby: TelegramLobby): Promise<Reply> {
  if (lobby.kind === "arena") return finishArena(tx, lobby);
  if (lobby.kind === "duel" && lobby.state.members.length < 2) {
    await markFinished(tx, lobby.id, lobby.state);
    const host = lobby.state.members[0]?.name ?? "Nobody";
    return finishedReply(lobby, `⌛ Nobody accepted ${host}'s duel.`);
  }
  return startFight(tx, lobby, "edit");
}

// Called by the bot's timer: starts lobbies whose 30 seconds are over and
// resolves rounds whose time to pick a move has run out.
export async function processDueLobbies(): Promise<void> {
  const now = new Date();
  const due = await db
    .select({ id: telegramLobbiesTable.id })
    .from(telegramLobbiesTable)
    .where(
      or(
        and(
          eq(telegramLobbiesTable.status, "open"),
          lte(telegramLobbiesTable.expiresAt, now),
        ),
        and(
          eq(telegramLobbiesTable.status, "active"),
          lte(telegramLobbiesTable.roundDeadline, now),
        ),
      ),
    );

  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const lobby = await lockLobby(tx, id);
      if (!lobby) return;
      const current = Date.now();
      let reply: Reply | null = null;
      if (lobby.status === "open" && lobby.expiresAt.getTime() <= current) {
        reply = await closeOpenLobby(tx, lobby);
      } else if (
        lobby.status === "active" &&
        lobby.roundDeadline &&
        lobby.roundDeadline.getTime() <= current
      ) {
        reply = await settleRound(tx, lobby, lobby.state);
      }
      if (!reply) return;
      await tx.insert(telegramOutboxTable).values({
        chatId: lobby.chatId,
        ownerId: null,
        lobbyId: reply.lobbyId ?? lobby.id,
        lobbyAction: reply.lobbyAction ?? "edit",
        text: reply.text,
        replyMarkup: reply.keyboard ?? null,
      });
    });
  }
}

export async function getLobbyMessageId(lobbyId: number): Promise<number | null> {
  const [row] = await db
    .select({ messageId: telegramLobbiesTable.messageId })
    .from(telegramLobbiesTable)
    .where(eq(telegramLobbiesTable.id, lobbyId))
    .limit(1);
  return row?.messageId ?? null;
}

export async function setLobbyMessageId(
  lobbyId: number,
  messageId: number,
): Promise<void> {
  await db
    .update(telegramLobbiesTable)
    .set({ messageId })
    .where(eq(telegramLobbiesTable.id, lobbyId));
}

async function leaderboardReply(tx: Tx, chatId: string, mode: "level" | "coins" = "level"): Promise<Reply> {
  const columns = {
    characterName: telegramPlayersTable.characterName,
    level: telegramPlayersTable.level,
    xp: telegramPlayersTable.xp,
    coins: telegramPlayersTable.coins,
  };
  const players = mode === "level"
    ? await tx.select(columns).from(telegramPlayersTable).where(eq(telegramPlayersTable.chatId, chatId)).orderBy(desc(telegramPlayersTable.level), desc(telegramPlayersTable.xp), asc(telegramPlayersTable.characterName)).limit(10)
    : await tx.select(columns).from(telegramPlayersTable).where(eq(telegramPlayersTable.chatId, chatId)).orderBy(desc(telegramPlayersTable.coins), desc(telegramPlayersTable.level), asc(telegramPlayersTable.characterName)).limit(10);
  const title = mode === "level" ? "🏆 Group Leaderboard — Top 10 by Level" : "💰 Group Leaderboard — Top 10 Richest Players";
  const lines = players.length
    ? players.map((p, i) => mode === "level"
      ? `${i + 1}. ${p.characterName} — Level ${p.level} (${p.xp} XP)`
      : `${i + 1}. ${p.characterName} — ${p.coins} coins · Level ${p.level}`)
    : ["No players found in this group yet."];
  return {
    text: `${title}\n\n${lines.join("\n")}`,
    keyboard: { inline_keyboard: [
      [button(mode === "level" ? "💰 View Richest Players" : "🏆 View Strongest Players", mode === "level" ? "leaderboard:coins" : "leaderboard:level")],
      [button("⬅️ Back", "menu")],
    ] },
  };
}

function tradeOfferText(name: string, offer: TradeOffer, itemNames: Map<string, string>): string {
  const lines = [`${name}`, `${offer.coins} Coins`];
  for (const [itemId, quantity] of Object.entries(offer.items)) {
    if (quantity > 0) lines.push(`${quantity} ${itemNames.get(itemId) ?? itemId}`);
  }
  return lines.join("\n");
}

async function tradeItemNames(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name }).from(itemsTable);
  return new Map(rows.map((row) => [row.itemId, row.name]));
}

async function tradeReply(tx: Tx, tradeId: number, state: TelegramTradeState, actorId: string): Promise<Reply> {
  const isFirst = actorId === state.player1Id;
  const currentOffer = isFirst ? state.offer1 : state.offer2;
  const currentId = isFirst ? state.player1Id : state.player2Id;
  const currentName = isFirst ? state.player1Name : state.player2Name;
  const rows = await tx.select({ itemId: itemsTable.itemId, name: itemsTable.name, quantity: telegramPlayerInventoryTable.quantity })
    .from(telegramPlayerInventoryTable).innerJoin(itemsTable, eq(itemsTable.itemId, telegramPlayerInventoryTable.itemId))
    .where(and(eq(telegramPlayerInventoryTable.telegramId, currentId), eq(telegramPlayerInventoryTable.chatId, (await tx.select({chatId: telegramTradesTable.chatId}).from(telegramTradesTable).where(eq(telegramTradesTable.id, tradeId)).limit(1))[0]!.chatId)))
    .orderBy(asc(itemsTable.name));
  const keyboard: Array<Array<{text:string; callback_data:string}>> = [];
  for (const item of rows) {
    const count = currentOffer.items[item.itemId] ?? 0;
    keyboard.push([button(`➕ ${item.name} (${count}/${item.quantity})`, `trade:${tradeId}:item:${item.itemId}:+`), button("➖", `trade:${tradeId}:item:${item.itemId}:-`)]);
  }
  keyboard.push([
    button("Coins -10", `trade:${tradeId}:coins:-10`),
    button("Coins +10", `trade:${tradeId}:coins:+10`),
  ], [
    button("Coins -1", `trade:${tradeId}:coins:-1`),
    button("Coins +1", `trade:${tradeId}:coins:+1`),
  ], [button("✅ Confirm offer", `trade:${tradeId}:offer-confirm`), button("❌ Cancel trade", `trade:${tradeId}:cancel`)]);
  return { text: `🤝 Trade #${tradeId}\n${currentName}, choose items and coins for your offer.\nCoins offered: ${currentOffer.coins}\nTap an item to add/remove one copy, then confirm.`, keyboard: {inline_keyboard: keyboard} };
}

async function handleTrade(tx: Tx, event: IncomingEvent, player: TelegramPlayer, command: string | undefined, callback: string | null): Promise<Reply | null> {
  if (command === "/trade") {
    const targetName = event.text?.trim().split(/\s+/)[1]?.replace(/^@/, "");
    if (!targetName) return { text: "Usage: /Trade @Username", keyboard: menuKeyboard };
    if (event.chatType === "private") return { text: "Use /Trade @Username in a group chat where both players have a save.", keyboard: menuKeyboard };
    const targets = await tx.select().from(telegramPlayersTable).where(and(eq(telegramPlayersTable.chatId, event.chatId), sql`lower(${telegramPlayersTable.username}) = lower(${targetName})`)).limit(1);
    const target = targets[0];
    if (!target) return { text: `I couldn't find @${targetName} in this group's game saves. Ask them to use /start first.`, keyboard: menuKeyboard };
    if (target.telegramId === event.actor.id) return { text: "You cannot trade with yourself.", keyboard: menuKeyboard };
    const active = await tx.select({id: telegramTradesTable.id}).from(telegramTradesTable).where(and(eq(telegramTradesTable.chatId,event.chatId),eq(telegramTradesTable.status,"active"))).limit(1);
    if (active.length) return { text: "Another trade is already active in this group. Finish or cancel it first.", keyboard: menuKeyboard };
    const state: TelegramTradeState = { phase:"request", player1Id:event.actor.id, player1Name:player.characterName, player2Id:target.telegramId, player2Name:target.characterName, offer1:{items:{},coins:0}, offer2:{items:{},coins:0} };
    const [trade] = await tx.insert(telegramTradesTable).values({chatId:event.chatId,state}).returning({id:telegramTradesTable.id});
    return { text:`🤝 Trade request #${trade!.id}\n${player.characterName} wants to trade with ${target.characterName}.\n${target.characterName}, do you accept?`, keyboard:{inline_keyboard:[[button("✅ Accept",`trade:${trade!.id}:accept`),button("❌ Decline",`trade:${trade!.id}:cancel`)]]} };
  }
  if (callback === "trade:help") return { text: "🤝 Trading\nUse /Trade @Username in a group to send a trade request. Both players must review and confirm the final summary.", keyboard:{inline_keyboard:[[button("⬅️ Back","menu")]]} };
  if (!callback?.startsWith("trade:")) return null;
  const parts = callback.split(":");
  const tradeId = Number(parts[1]);
  if (!Number.isInteger(tradeId)) return {text:"Invalid trade.",keyboard:menuKeyboard};
  const [trade] = await tx.select().from(telegramTradesTable).where(and(eq(telegramTradesTable.id,tradeId),eq(telegramTradesTable.chatId,event.chatId),eq(telegramTradesTable.status,"active"))).limit(1);
  if (!trade) return {text:"This trade is no longer active.",keyboard:menuKeyboard};
  const state = trade.state;
  if (parts[2] === "cancel") {
    if (event.actor.id !== state.player1Id && event.actor.id !== state.player2Id) return {text:"Only the two traders can cancel this trade.",keyboard:menuKeyboard};
    await tx.update(telegramTradesTable).set({status:"cancelled",updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
    return {text:`❌ Trade #${tradeId} was cancelled. No items or coins were transferred.`,keyboard:menuKeyboard,broadcast:true};
  }
  if (parts[2] === "accept") {
    if (event.actor.id !== state.player2Id || state.phase !== "request") return {text:"This request is not for you or is no longer waiting.",keyboard:menuKeyboard};
    state.phase="offer1"; await tx.update(telegramTradesTable).set({state,updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
    return tradeReply(tx,tradeId,state,state.player1Id);
  }
  if (event.actor.id !== state.player1Id && event.actor.id !== state.player2Id) return {text:"Only the two traders can use these buttons.",keyboard:menuKeyboard};
  if (parts[2] === "item" && (state.phase === "offer1" || state.phase === "offer2")) {
    const isFirst = event.actor.id === state.player1Id;
    if ((state.phase === "offer1") !== isFirst) return {text:"Please wait for the other player to finish their offer.",keyboard:menuKeyboard};
    const itemId=parts[3] ?? ""; const direction=parts[4]; const offer=isFirst?state.offer1:state.offer2;
    const owned = await tx.select({quantity:telegramPlayerInventoryTable.quantity}).from(telegramPlayerInventoryTable).where(and(eq(telegramPlayerInventoryTable.telegramId,event.actor.id),eq(telegramPlayerInventoryTable.chatId,event.chatId),eq(telegramPlayerInventoryTable.itemId,itemId))).limit(1);
    const current=offer.items[itemId]??0; const max=owned[0]?.quantity??0;
    if(direction==="+" && current<max) offer.items[itemId]=current+1;
    if(direction==="-" && current>0) { if(current===1) delete offer.items[itemId]; else offer.items[itemId]=current-1; }
    if(isFirst) state.offer1=offer; else state.offer2=offer;
    await tx.update(telegramTradesTable).set({state,updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
    return tradeReply(tx,tradeId,state,event.actor.id);
  }
  if (parts[2] === "coins" && (state.phase === "offer1" || state.phase === "offer2")) {
    const isFirst=event.actor.id===state.player1Id;
    if ((state.phase === "offer1") !== isFirst) return {text:"Please wait for the other player to finish their offer.",keyboard:menuKeyboard};
    const offer=isFirst?state.offer1:state.offer2; const delta=Number(parts[3]);
    const [fresh]=await tx.select({coins:telegramPlayersTable.coins}).from(telegramPlayersTable).where(playerWhere(event.actor.id,event.chatId)).limit(1);
    offer.coins=clamp(offer.coins+delta,0,fresh?.coins??0);
    if(isFirst)state.offer1=offer;else state.offer2=offer;
    await tx.update(telegramTradesTable).set({state,updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
    return tradeReply(tx,tradeId,state,event.actor.id);
  }
  if (parts[2] === "offer-confirm" && (state.phase === "offer1" || state.phase === "offer2")) {
    const isFirst=event.actor.id===state.player1Id;
    if ((state.phase === "offer1") !== isFirst) return {text:"Please wait for the other player to finish their offer.",keyboard:menuKeyboard};
    state.phase=isFirst?"offer2":"review";
    await tx.update(telegramTradesTable).set({state,updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
    if(state.phase==="offer2") return tradeReply(tx,tradeId,state,state.player2Id);
    const names=await tradeItemNames(tx);
    return {text:`📋 Trade #${tradeId} — Review both offers\n\n${tradeOfferText(state.player1Name,state.offer1,names)}\n------------------------------\n${tradeOfferText(state.player2Name,state.offer2,names)}\n\nBoth players must confirm this exact trade. Any cancellation aborts it.`,keyboard:{inline_keyboard:[[button("✅ Continue to final confirmation",`trade:${tradeId}:review`),button("❌ Cancel trade",`trade:${tradeId}:cancel`)]]},broadcast:true};
  }
  if(parts[2]==="review" && state.phase==="review") {
    state.phase="confirm"; state.confirmed1=false;state.confirmed2=false;
    await tx.update(telegramTradesTable).set({state,updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
    return {text:`🔒 Final confirmation for trade #${tradeId}\n${state.player1Name} and ${state.player2Name}: confirm only if the summary is correct.`,keyboard:{inline_keyboard:[[button(`✅ ${state.player1Name} confirms`,`trade:${tradeId}:final`),button(`❌ Cancel trade`,`trade:${tradeId}:cancel`)]]},broadcast:true};
  }
  if(parts[2]==="final" && state.phase==="confirm") {
    const isFirst=event.actor.id===state.player1Id;
    if(isFirst)state.confirmed1=true;else state.confirmed2=true;
    if(!state.confirmed1 || !state.confirmed2) {
      await tx.update(telegramTradesTable).set({state,updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
      return {text:`✅ ${isFirst?state.player1Name:state.player2Name} confirmed. Waiting for ${isFirst?state.player2Name:state.player1Name} to confirm the same trade.`,keyboard:{inline_keyboard:[[button(`✅ ${isFirst?state.player2Name:state.player1Name} confirms`,`trade:${tradeId}:final`),button("❌ Cancel trade",`trade:${tradeId}:cancel`)]]},broadcast:true};
    }
    // Revalidate all assets before making any changes. All changes occur in this DB transaction.
    for(const [ownerId,offer] of [[state.player1Id,state.offer1],[state.player2Id,state.offer2]] as Array<[string,TradeOffer]>) {
      const [owner]=await tx.select({coins:telegramPlayersTable.coins}).from(telegramPlayersTable).where(playerWhere(ownerId,event.chatId)).limit(1);
      if(!owner || owner.coins<offer.coins) { await tx.update(telegramTradesTable).set({status:"cancelled",updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId)); return {text:"Trade cancelled: a player's coin balance changed and the offer is no longer valid.",keyboard:menuKeyboard,broadcast:true}; }
      for(const [itemId,qty] of Object.entries(offer.items)) { const [inv]=await tx.select({quantity:telegramPlayerInventoryTable.quantity}).from(telegramPlayerInventoryTable).where(and(eq(telegramPlayerInventoryTable.telegramId,ownerId),eq(telegramPlayerInventoryTable.chatId,event.chatId),eq(telegramPlayerInventoryTable.itemId,itemId))).limit(1); if(!inv || inv.quantity<qty) { await tx.update(telegramTradesTable).set({status:"cancelled",updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId)); return {text:"Trade cancelled: an offered item is no longer available. No assets were transferred.",keyboard:menuKeyboard,broadcast:true}; } }
    }
    for(const [ownerId,receiverId,offer] of [[state.player1Id,state.player2Id,state.offer1],[state.player2Id,state.player1Id,state.offer2]] as Array<[string,string,TradeOffer]>) {
      for(const [itemId,qty] of Object.entries(offer.items)) {
        const [inv]=await tx.select({quantity:telegramPlayerInventoryTable.quantity}).from(telegramPlayerInventoryTable).where(and(eq(telegramPlayerInventoryTable.telegramId,ownerId),eq(telegramPlayerInventoryTable.chatId,event.chatId),eq(telegramPlayerInventoryTable.itemId,itemId))).limit(1);
        if(inv!.quantity===qty) { await tx.delete(telegramPlayerInventoryTable).where(and(eq(telegramPlayerInventoryTable.telegramId,ownerId),eq(telegramPlayerInventoryTable.chatId,event.chatId),eq(telegramPlayerInventoryTable.itemId,itemId))); await tx.delete(telegramPlayerEquipmentTable).where(and(eq(telegramPlayerEquipmentTable.telegramId,ownerId),eq(telegramPlayerEquipmentTable.chatId,event.chatId),eq(telegramPlayerEquipmentTable.itemId,itemId))); }
        else await tx.update(telegramPlayerInventoryTable).set({quantity:inv!.quantity-qty}).where(and(eq(telegramPlayerInventoryTable.telegramId,ownerId),eq(telegramPlayerInventoryTable.chatId,event.chatId),eq(telegramPlayerInventoryTable.itemId,itemId)));
        await tx.insert(telegramPlayerInventoryTable).values({telegramId:receiverId,chatId:event.chatId,itemId,quantity:qty}).onConflictDoUpdate({target:[telegramPlayerInventoryTable.telegramId,telegramPlayerInventoryTable.chatId,telegramPlayerInventoryTable.itemId],set:{quantity:sql`${telegramPlayerInventoryTable.quantity} + ${qty}`}});
      }
    }
    await tx.update(telegramPlayersTable).set({coins:sql`${telegramPlayersTable.coins} - ${state.offer1.coins} + ${state.offer2.coins}`,updatedAt:new Date()}).where(playerWhere(state.player1Id,event.chatId));
    await tx.update(telegramPlayersTable).set({coins:sql`${telegramPlayersTable.coins} - ${state.offer2.coins} + ${state.offer1.coins}`,updatedAt:new Date()}).where(playerWhere(state.player2Id,event.chatId));
    await tx.update(telegramTradesTable).set({status:"completed",updatedAt:new Date()}).where(eq(telegramTradesTable.id,tradeId));
    return {text:`🎉 Trade #${tradeId} completed successfully! All items and coins have been transferred.`,keyboard:menuKeyboard,broadcast:true};
  }
  return {text:"This trade action is no longer available.",keyboard:menuKeyboard};
}

async function handleEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: IncomingEvent,
): Promise<Reply> {
  const rawText = event.text?.trim() ?? "";
  const rawParts = rawText.split(/\s+/).filter(Boolean);
  const rawCommand = rawParts[0]?.split("@", 1)[0]?.toLowerCase() ?? "";
  const aliasCommandMap: Record<string, string> = {
    aarena: "/arena", arena: "/arena",
    hhunt: "/explore", dduel: "/duel", eequip: "/equip", uuse: "/use",
    ssleep: "/sleep", bboss: "/boss", pprofile: "/profile",
    mmenu: "/menu", ppet: "/pet",
  };
  let command = rawCommand.startsWith("/") ? rawCommand : (aliasCommandMap[rawCommand] ?? rawCommand);
  let callback = event.callbackData;
  if (command === "/index" || callback === "index") {
    return { text: "📚 SillyRPG Mini Wiki\n\nChoose a category to learn about equipment, consumables and Class Orbs.", keyboard: indexKeyboard };
  }
  if (callback === "index:classes") {
    return { text: "🔮 Class Orb Index\nChoose a class to view its rarity, base bonuses and passive skill.", keyboard: classIndexKeyboard };
  }
  if (callback?.startsWith("index:class:")) {
    const classKey = callback.slice("index:class:".length);
    return { text: classIndexDetails[classKey] ?? "Class details are not available.", keyboard: { inline_keyboard: [[{ text: "⬅️ All Classes", callback_data: "index:classes" }], [{ text: "📚 Wiki Categories", callback_data: "index" }]] } };
  }
  if (callback?.startsWith("index:")) {
    const section = callback.slice("index:".length);
    const pages: Record<string, string> = {
      weapons: "⚔️ Weapons Wiki\nWeapons provide attack power and may have special effects. Open Inventory → Weapons to see your owned items and their IDs; use /equip ID to equip one.",
      armors: "🛡️ Armors Wiki\nArmor can increase HP, defense and other stats. Open Inventory → Armors to inspect item bonuses and IDs; use /equip ID to equip armor.",
      offhands: "🛡️ Off-Hand Wiki\nOff-hand items include shields and other secondary equipment. Shields may unlock defensive combat actions. Open Inventory → Off-Hand to inspect your items; use /equip ID.",
      consumables: "🧪 Consumables Wiki\nConsumables can heal, restore resources or grant other effects. Their usage rules depend on the item; open Inventory → Consumables and use /use ID.",
    };
    if (pages[section]) return { text: pages[section], keyboard: { inline_keyboard: [[{ text: "⬅️ Wiki Categories", callback_data: "index" }]] } };
  }

  // Owner console is private-chat only and does not depend on the currently selected save.
  if (command === "/admin" || callback === "admin" || callback?.startsWith("admin:")) {
    if (!isSystemOwner(event.actor.id)) {
      return { text: "⛔ Access denied. This command is reserved for the bot owner.", keyboard: menuKeyboard };
    }
    if (event.chatType !== "private") {
      return { text: "🔒 For security, the owner console is available only in a private chat with the bot.", keyboard: menuKeyboard };
    }

    if (callback?.startsWith("admin:confirm:")) {
      const parts = callback.split(":");
      const action = parts[2];
      const targetTelegramId = parts[3] ?? "";
      const targetChatId = parts[4] ?? "";
      const amount = Number(parts[5]);
      if (!["coins", "xp", "potions"].includes(action) || !/^\d+$/.test(targetTelegramId) || !/^-?\d+$/.test(targetChatId) || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
        return { text: "⚠️ This admin action is invalid or expired. Open /admin and try again.", keyboard: adminKeyboard() };
      }
      const [target] = await tx.select().from(telegramPlayersTable).where(and(eq(telegramPlayersTable.telegramId, targetTelegramId), eq(telegramPlayersTable.chatId, targetChatId))).limit(1);
      if (!target) return { text: "❌ That player save no longer exists. Use /admin to try again.", keyboard: adminKeyboard() };
      const whereTarget = and(eq(telegramPlayersTable.telegramId, targetTelegramId), eq(telegramPlayersTable.chatId, targetChatId));
      if (action === "coins") await tx.update(telegramPlayersTable).set({ coins: sql`${telegramPlayersTable.coins} + ${amount}`, updatedAt: new Date() }).where(whereTarget);
      else if (action === "xp") await tx.update(telegramPlayersTable).set({ xp: sql`${telegramPlayersTable.xp} + ${amount}`, updatedAt: new Date() }).where(whereTarget);
      else await tx.update(telegramPlayersTable).set({ potions: sql`${telegramPlayersTable.potions} + ${amount}`, updatedAt: new Date() }).where(whereTarget);
      return { text: `✅ Admin action completed. Added ${amount} ${action} to ${target.characterName} (Telegram ID ${targetTelegramId}, save ${targetChatId}).`, keyboard: adminKeyboard() };
    }

    if (callback === "admin:stats") {
      const players = await tx.select({ telegramId: telegramPlayersTable.telegramId }).from(telegramPlayersTable);
      const uniquePlayers = new Set(players.map((row) => row.telegramId)).size;
      return { text: `📊 Bot statistics\n\n👤 Player saves: ${players.length}\n🧑 Unique Telegram users: ${uniquePlayers}`, keyboard: adminKeyboard() };
    }

    if (command === "/admin" && ["help", "commands"].includes((rawParts[1] ?? "").toLowerCase())) {
      return { text: "👑 System Owner — Admin help\n\n/admin — Open the admin console\n/admin help — Show this command list\n/admin player <telegram_id> — Show detailed player and save information\n/admin coins <telegram_id> <chat_id> <amount> — Add coins (confirmation required)\n/admin xp <telegram_id> <chat_id> <amount> — Add XP (confirmation required)\n/admin potions <telegram_id> <chat_id> <amount> — Add potions (confirmation required)\n\nAll commands are restricted to the System Owner and private chat. Amounts are limited to 1–1,000,000 per action.", keyboard: adminKeyboard() };
    }

    if (command === "/admin" && rawParts[1]?.toLowerCase() === "player") {
      const targetId = rawParts[2] ?? "";
      if (!/^\d+$/.test(targetId)) return { text: "Usage: /admin player <telegram_id>", keyboard: adminKeyboard() };
      const saves = await tx.select({
        telegramId: telegramPlayersTable.telegramId, chatId: telegramPlayersTable.chatId,
        username: telegramPlayersTable.username, characterName: telegramPlayersTable.characterName,
        archetype: telegramPlayersTable.archetype, classId: telegramPlayersTable.classId,
        level: telegramPlayersTable.level, xp: telegramPlayersTable.xp, coins: telegramPlayersTable.coins,
        potions: telegramPlayersTable.potions, hp: telegramPlayersTable.hp, maxHp: telegramPlayersTable.maxHp,
        attack: telegramPlayersTable.attack, defense: telegramPlayersTable.defense,
        biomeId: telegramPlayersTable.biomeId, createdAt: telegramPlayersTable.createdAt,
        updatedAt: telegramPlayersTable.updatedAt, combat: telegramPlayersTable.combat,
      }).from(telegramPlayersTable).where(eq(telegramPlayersTable.telegramId, targetId)).orderBy(asc(telegramPlayersTable.chatId));
      if (!saves.length) return { text: `No saves found for Telegram ID ${targetId}.`, keyboard: adminKeyboard() };
      const lines = saves.map((save, index) => {
        const created = save.createdAt ? save.createdAt.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "Unknown";
        const updated = save.updatedAt ? save.updatedAt.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "Unknown";
        const activeCombat = save.combat ? "Yes" : "No";
        return `${index + 1}. ${save.characterName}\n   Telegram ID: ${save.telegramId}\n   Username: ${save.username ? "@" + save.username : "Not available"}\n   Save / group chat ID: ${save.chatId}\n   Class: ${save.archetype}${save.classId ? ` (${save.classId})` : ""}\n   Level: ${save.level} · XP: ${save.xp}\n   Coins: ${save.coins} · Potions: ${save.potions}\n   HP: ${save.hp}/${save.maxHp} · ATK: ${save.attack} · DEF: ${save.defense}\n   Region / biome ID: ${save.biomeId}\n   In combat: ${activeCombat}\n   Character created: ${created}\n   Last updated: ${updated}`;
      });
      return { text: `🔎 Detailed player report\n\nTelegram ID: ${targetId}\nNumber of saves: ${saves.length}\n\n${lines.join("\n\n")}`, keyboard: adminKeyboard() };
    }

    if (command === "/admin" && ["coins", "xp", "potions"].includes((rawParts[1] ?? "").toLowerCase())) {
      const action = rawParts[1].toLowerCase();
      const targetId = rawParts[2] ?? "";
      const targetChatId = rawParts[3] ?? "";
      const amountText = rawParts[4] ?? "";
      const amount = Number(amountText);
      if (!/^\d+$/.test(targetId) || !/^-?\d+$/.test(targetChatId) || !/^\d+$/.test(amountText) || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
        return { text: `Usage: /admin ${action} <telegram_id> <chat_id> <amount>\nAmount must be between 1 and 1,000,000.`, keyboard: adminKeyboard() };
      }
      const [target] = await tx.select({ characterName: telegramPlayersTable.characterName }).from(telegramPlayersTable).where(and(eq(telegramPlayersTable.telegramId, targetId), eq(telegramPlayersTable.chatId, targetChatId))).limit(1);
      if (!target) return { text: "❌ Save not found. Use /admin player <telegram_id> to inspect the available saves.", keyboard: adminKeyboard() };
      return { text: `⚠️ Confirm admin action\n\nAdd ${amount} ${action} to ${target.characterName}?\nTelegram ID: ${targetId}\nSave/chat ID: ${targetChatId}`, keyboard: { inline_keyboard: [[button("✅ Confirm", `admin:confirm:${action}:${targetId}:${targetChatId}:${amount}`)], [button("❌ Cancel", "admin")]] } };
    }

    if (callback === "admin:help") return { text: "👑 System Owner — Admin help\n\n/admin — Open the admin console\n/admin help — Show this command list\n/admin player <telegram_id> — Show detailed player and save information\n/admin coins <telegram_id> <chat_id> <amount> — Add coins (confirmation required)\n/admin xp <telegram_id> <chat_id> <amount> — Add XP (confirmation required)\n/admin potions <telegram_id> <chat_id> <amount> — Add potions (confirmation required)\n\nAll commands are restricted to the System Owner and private chat. Amounts are limited to 1–1,000,000 per action.", keyboard: adminKeyboard() };
    if (callback === "admin:lookup") return { text: "🔎 Player lookup\n\nSend /admin player <telegram_id> to inspect all saves belonging to a Telegram user.", keyboard: adminKeyboard() };
    if (callback === "admin:resources") return { text: "🎁 Resource management\n\nUse /admin coins <telegram_id> <chat_id> <amount>, /admin xp <telegram_id> <chat_id> <amount>, or /admin potions <telegram_id> <chat_id> <amount>. Every grant asks for confirmation and is limited to 1,000,000 per action.", keyboard: adminKeyboard() };
    return { text: "👑 System Owner Console\n\nChoose a tool below. Resource changes require confirmation and are applied only to the exact save you specify.", keyboard: adminKeyboard() };
  }

  // Save switching is private-chat only. Group commands always remain scoped to that group.
  if (event.chatType === "private" && (command === "/saves" || callback === "saves")) {
    const saves = await tx.select({ chatId: telegramPlayersTable.chatId, characterName: telegramPlayersTable.characterName, level: telegramPlayersTable.level, archetype: telegramPlayersTable.archetype })
      .from(telegramPlayersTable).where(eq(telegramPlayersTable.telegramId, event.actor.id)).orderBy(asc(telegramPlayersTable.chatId));
    if (saves.length === 0) return { text: "No existing group saves found yet. Play in a group first to create a character.", keyboard: menuKeyboard };
    const [settings] = await tx.select().from(telegramPlayerSettingsTable).where(eq(telegramPlayerSettingsTable.telegramId, event.actor.id)).limit(1);
    const rows = saves.map((save) => [{ text: `${settings?.selectedChatId === save.chatId ? "✅ " : ""}${save.characterName} · Lv.${save.level} · ${save.archetype} · ${save.chatId}`, callback_data: `saves:select:${save.chatId}` }]);
    return { text: "💾 Choose which group save to use in this private chat. This does not change your character in any group.", keyboard: { inline_keyboard: rows } };
  }
  if (event.chatType === "private" && callback?.startsWith("saves:select:")) {
    const selectedChatId = callback.slice("saves:select:".length);
    const [save] = await tx.select({ chatId: telegramPlayersTable.chatId, characterName: telegramPlayersTable.characterName, level: telegramPlayersTable.level })
      .from(telegramPlayersTable).where(and(eq(telegramPlayersTable.telegramId, event.actor.id), eq(telegramPlayersTable.chatId, selectedChatId))).limit(1);
    if (!save) return { text: "That save could not be found. Use /saves to refresh the list.", keyboard: menuKeyboard };
    await tx.insert(telegramPlayerSettingsTable).values({ telegramId: event.actor.id, selectedChatId, language: "en" }).onConflictDoUpdate({ target: telegramPlayerSettingsTable.telegramId, set: { selectedChatId, updatedAt: new Date() } });
    event.chatId = selectedChatId;
    return { text: `✅ Selected save: ${save.characterName} · Level ${save.level}. Your private game commands will now use this character. In groups, each group keeps its own save.`, keyboard: menuKeyboard };
  }
  if (event.chatType === "private") {
    const [settings] = await tx.select().from(telegramPlayerSettingsTable).where(eq(telegramPlayerSettingsTable.telegramId, event.actor.id)).limit(1);
    if (settings?.selectedChatId) {
      const [validSave] = await tx.select({ chatId: telegramPlayersTable.chatId }).from(telegramPlayersTable)
        .where(and(eq(telegramPlayersTable.telegramId, event.actor.id), eq(telegramPlayersTable.chatId, settings.selectedChatId))).limit(1);
      if (validSave) event.chatId = validSave.chatId;
    }
  }

  if (event.newChatMembers.length > 0) {
    for (const member of event.newChatMembers) {
      await ensurePlayer(tx, event.chatId, member);
    }
    const names = event.newChatMembers.map((member) => member.firstName).join(", ");
    return {
      text: `Welcome to Valdombra, ${names}! I created a personal save for each member. You are all Jobless until you use a Class Orb.`,
      keyboard: menuKeyboard,
      broadcast: true,
    };
  }

  if (event.chatType !== "private" && (command === "/saves" || callback === "saves" || callback?.startsWith("saves:select:"))) {
    return { text: "Save switching is available only in a private chat with the bot. This group's character cannot be changed here.", keyboard: menuKeyboard };
  }

  const player = await ensurePlayer(tx, event.chatId, event.actor);

  // Handle pet naming before menus, casino shortcuts, or other text handlers can consume the message.
  if (event.text && !rawText.startsWith("/") && !callback) {
    const [unnamedPet] = await tx.select().from(telegramPetsTable)
      .where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.nickname, "__PENDING_NAME__")))
      .orderBy(desc(telegramPetsTable.id)).limit(1);
    if (unnamedPet) {
      const nickname = rawText.slice(0, 32).trim();
      if (nickname) {
        await tx.update(telegramPetsTable).set({ nickname, updatedAt: new Date() }).where(eq(telegramPetsTable.id, unnamedPet.id));
        return { text: `🐾 Your companion is now named ${nickname}! It will grow with you and deal ${unnamedPet.isShiny ? "30%" : "20%"} of your damage. Use /box to manage your pets.`, keyboard: menuKeyboard };
      }
    }
  }

  if (command === "/renamepet") {
    const nickname = rawParts.slice(1).join(" ").trim().slice(0, 32);
    if (!nickname) return { text: "Usage: /renamepet <nuovonome>\\nExample: /renamepet Fuffi", keyboard: menuKeyboard };
    const [pendingPet] = await tx.select().from(telegramPetsTable)
      .where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.nickname, "__PENDING_NAME__")))
      .orderBy(desc(telegramPetsTable.id)).limit(1);
    let targetPet = pendingPet;
    if (!targetPet) {
      const [activePet] = await tx.select().from(telegramPetsTable)
        .where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.active, 1), eq(telegramPetsTable.boxed, 0)))
        .orderBy(desc(telegramPetsTable.id)).limit(1);
      targetPet = activePet;
    }
    if (!targetPet) return { text: "You have no pet to rename. Capture one first or use /box to check your pets.", keyboard: menuKeyboard };
    await tx.update(telegramPetsTable).set({ nickname, updatedAt: new Date() }).where(eq(telegramPetsTable.id, targetPet.id));
    return { text: `🐾 Pet #${targetPet.id} is now named ${nickname}!`, keyboard: menuKeyboard };
  }

  // Party system: /party create | invite @username | accept | leave | info.
  if (command === "/party") {
    const sub = (rawParts[1] ?? "info").toLowerCase();
    const [membership] = await tx.select().from(telegramPartyMembersTable)
      .where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId), eq(telegramPartyMembersTable.status, "member"))).limit(1);
    if (sub === "create") {
      if (membership) return { text: "🧑‍🤝‍🧑 You are already in a party. Use /party info to see it.", keyboard: menuKeyboard };
      const [invitation] = await tx.select().from(telegramPartyMembersTable)
        .where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId), eq(telegramPartyMembersTable.status, "invited"))).limit(1);
      if (invitation) return { text: "You have a pending party invitation. Use /party accept or /party leave to decline it.", keyboard: menuKeyboard };
      const [party] = await tx.insert(telegramPartiesTable).values({ chatId: player.chatId, leaderId: player.telegramId, leaderName: player.characterName }).returning();
      await tx.insert(telegramPartyMembersTable).values({ partyId: party!.id, telegramId: player.telegramId, chatId: player.chatId, username: player.username, displayName: player.characterName, status: "member" });
      return { text: `🧑‍🤝‍🧑 Party created!
Leader: ${player.characterName}
Invite players with /party invite @username.`, keyboard: menuKeyboard };
    }
    if (sub === "accept") {
      if (membership) return { text: "You are already in a party.", keyboard: menuKeyboard };
      const [inv] = await tx.select().from(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId), eq(telegramPartyMembersTable.status, "invited"))).limit(1);
      if (!inv) return { text: "No pending party invitation found.", keyboard: menuKeyboard };
      await tx.update(telegramPartyMembersTable).set({ status: "member", displayName: player.characterName, username: player.username }).where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId)));
      return { text: "✅ You joined the party! You now receive 5% of XP and gold earned by other members during exploration.", keyboard: menuKeyboard };
    }
    if (sub === "leave") {
      if (!membership) { await tx.delete(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId), eq(telegramPartyMembersTable.status, "invited"))); return { text: "You left/declined the party invitation.", keyboard: menuKeyboard }; }
      const [party] = await tx.select().from(telegramPartiesTable).where(eq(telegramPartiesTable.id, membership.partyId)).limit(1);
      await tx.delete(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId)));
      if (party?.leaderId === player.telegramId) {
        const [next] = await tx.select().from(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.partyId, membership.partyId), eq(telegramPartyMembersTable.status, "member"))).limit(1);
        if (next) await tx.update(telegramPartiesTable).set({ leaderId: next.telegramId, leaderName: next.displayName }).where(eq(telegramPartiesTable.id, membership.partyId));
        else await tx.delete(telegramPartiesTable).where(eq(telegramPartiesTable.id, membership.partyId));
      }
      return { text: "👋 You left the party.", keyboard: menuKeyboard };
    }
    if (sub === "invite") {
      if (!membership) return { text: "Create a party first with /party create or join one via /party accept.", keyboard: menuKeyboard };
      const targetName = (rawParts[2] ?? "").replace(/^@/, "").toLowerCase();
      if (!targetName) return { text: "Usage: /party invite @username", keyboard: menuKeyboard };
      const [target] = await tx.select().from(telegramPlayersTable).where(and(eq(telegramPlayersTable.chatId, player.chatId), sql`LOWER(${telegramPlayersTable.username}) = ${targetName}`)).limit(1);
      if (!target) return { text: "Player not found in this chat/save. They must have used the bot here first and have a username.", keyboard: menuKeyboard };
      if (target.telegramId === player.telegramId) return { text: "You cannot invite yourself.", keyboard: menuKeyboard };
      const [existing] = await tx.select().from(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.telegramId, target.telegramId), eq(telegramPartyMembersTable.chatId, target.chatId))).limit(1);
      if (existing?.status === "member") return { text: "That player is already in a party.", keyboard: menuKeyboard };
      if (existing?.status === "invited") return { text: "That player already has a pending party invitation.", keyboard: menuKeyboard };
      await tx.insert(telegramPartyMembersTable).values({ partyId: membership.partyId, telegramId: target.telegramId, chatId: target.chatId, username: target.username, displayName: target.characterName, status: "invited" });
      return { text: `📨 Invitation sent to ${target.characterName}. They can join with /party accept.`, keyboard: menuKeyboard };
    }
    if (sub === "info") {
      if (!membership) {
        const [inv] = await tx.select().from(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.telegramId, player.telegramId), eq(telegramPartyMembersTable.chatId, player.chatId), eq(telegramPartyMembersTable.status, "invited"))).limit(1);
        return { text: inv ? "📨 You have a pending party invitation. Use /party accept to join or /party leave to decline." : "You are not in a party. Create one with /party create.", keyboard: menuKeyboard };
      }
      const members = await tx.select().from(telegramPartyMembersTable).where(and(eq(telegramPartyMembersTable.partyId, membership.partyId), eq(telegramPartyMembersTable.status, "member")));
      return { text: `🧑‍🤝‍🧑 Party #${membership.partyId}
${members.map(m => `${m.telegramId === player.telegramId && m.telegramId === membership.telegramId ? "👑 " : "• "}${m.displayName}`).join("\n")}

🎁 Party passive: 5% of XP and gold from other members' exploration rewards.`, keyboard: menuKeyboard };
    }
    return { text: "🧑‍🤝‍🧑 Party commands:\n/party create\n/party invite @username\n/party accept\n/party info\n/party leave", keyboard: menuKeyboard };
  }

  const tradeReplyResult = await handleTrade(tx, event, player, command, callback);
  if (tradeReplyResult) return tradeReplyResult;

  if (command === "/leaderboard") return leaderboardReply(tx, event.chatId, "level");
  if (callback === "leaderboard:level") return leaderboardReply(tx, event.chatId, "level");
  if (callback === "leaderboard:coins") return leaderboardReply(tx, event.chatId, "coins");

  // Wipe the current player's save for this chat only. The command is intentionally
  // handled here (not exposed as a menu button) and requires explicit confirmation.
  if (command === "/wipedata") {
    return {
      text: "⚠️ Delete your save in this group? This permanently resets your character, level, coins, items, equipment, region and current progress. This cannot be undone.",
      keyboard: {
        inline_keyboard: [[
          { text: "🗑️ Yes, delete my save", callback_data: "wipedata:confirm" },
          { text: "❌ Cancel", callback_data: "wipedata:cancel" },
        ]],
      },
    };
  }
  if (callback === "wipedata:cancel") {
    return { text: "Wipe cancelled. Your save is unchanged.", keyboard: menuKeyboard };
  }
  if (callback === "wipedata:confirm") {
    // End any active lobby involving this player so the old combat state cannot
    // remain attached to a newly created character. Open lobbies simply lose them.
    const lobbies = await tx
      .select()
      .from(telegramLobbiesTable)
      .where(and(
        eq(telegramLobbiesTable.chatId, event.chatId),
        inArray(telegramLobbiesTable.status, ["open", "active"]),
      ));
    for (const lobby of lobbies) {
      const involved = lobby.state.members.some((m) => m.telegramId === event.actor.id) ||
        lobby.state.fighters.some((f) => f.telegramId === event.actor.id);
      if (!involved) continue;
      if (lobby.status === "open") {
        const members = lobby.state.members.filter((m) => m.telegramId !== event.actor.id);
        if (members.length === 0) {
          await tx.update(telegramLobbiesTable)
            .set({ status: "finished", state: { ...lobby.state, members: [] }, updatedAt: new Date() })
            .where(eq(telegramLobbiesTable.id, lobby.id));
        } else {
          await tx.update(telegramLobbiesTable)
            .set({ state: { ...lobby.state, members }, updatedAt: new Date() })
            .where(eq(telegramLobbiesTable.id, lobby.id));
        }
      } else {
        await tx.update(telegramLobbiesTable)
          .set({ status: "finished", updatedAt: new Date() })
          .where(eq(telegramLobbiesTable.id, lobby.id));
        const otherIds = lobby.state.fighters
          .filter((f) => f.telegramId !== event.actor.id)
          .map((f) => f.telegramId);
        for (const otherId of otherIds) {
          await tx.update(telegramPlayersTable)
            .set({ combat: null, updatedAt: new Date() })
            .where(playerWhere(otherId, event.chatId));
        }
      }
    }
    await tx.delete(telegramPlayersTable).where(playerWhere(event.actor.id, event.chatId));
    const resetPlayer = await ensurePlayer(tx, event.chatId, event.actor);
    return {
      text: `✅ Your save in this group has been deleted and restarted. Welcome back, ${resetPlayer.characterName}! You are now level 0 with a fresh character.`,
      keyboard: menuKeyboard,
    };
  }

  // Text-first shortcuts: users can type these without a slash or opening menus.
  if (rawCommand === "ccf") {
    const mode = rawParts[1]?.toLowerCase();
    if (mode === "solo") {
      const amountText = rawParts[2];
      const amount = amountText === undefined ? undefined : (/^\d+$/.test(amountText) ? Number(amountText) : NaN);
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 1)) {
        return { text: "Usage: Ccf Solo [Coins]. Enter a whole number of at least 1.", keyboard: casinoKeyboard };
      }
      const started = await casinoReply(tx, { ...event, callbackData: "casino:coin:solo" }, player);
      if (amount === undefined) return started;
      return processCasinoBet(tx, event, player, amount);
    }
    if (mode === "multi") return casinoReply(tx, { ...event, callbackData: "casino:coin:versus" }, player);
    return { text: "Usage: Ccf Solo [Coins] or Ccf Multi.", keyboard: casinoKeyboard };
  }
  if (rawCommand === "bbj" || rawCommand === "sslot") {
    const amountText = rawParts[1];
    const gameCallback = rawCommand === "bbj" ? "casino:blackjack" : "casino:slots";
    if (!amountText || !/^\d+$/.test(amountText) || !Number.isSafeInteger(Number(amountText)) || Number(amountText) < 1) {
      return { text: `Usage: ${rawCommand === "bbj" ? "Bbj" : "Sslot"} <Coins>. Enter a whole number of at least 1.`, keyboard: casinoKeyboard };
    }
    await casinoReply(tx, { ...event, callbackData: gameCallback }, player);
    return processCasinoBet(tx, event, player, Number(amountText));
  }
  if (callback === "casino" || callback?.startsWith("casino:")) return casinoReply(tx, event, player);
  if (event.text && /^\d+$/.test(event.text.trim())) return processCasinoBet(tx, event, player, Number(event.text.trim()));

  if (command === "/box" || callback === "box") {
    const args = (event.text ?? "").trim().split(/\s+/);
    const action = (args[1] ?? "").toLowerCase();
    if (action === "info") {
      const petId = Number(args[2]);
      if (!Number.isInteger(petId) || petId < 1) return { text: "Usage: /box info PET_ID", keyboard: menuKeyboard };
      const [pet] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.id, petId), eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId))).limit(1);
      if (!pet) return { text: "Pet not found in your Box. Use /box to see your pet IDs.", keyboard: menuKeyboard };
      const level = Math.max(1, pet.level || 1);
      const xp = Math.max(0, pet.xp || 0);
      const xpLine = level >= 20 ? `${xp} XP (maximum level reached)` : `${xp} / ${petXpToNext(level)} XP`;
      const passiveLine = pet.passiveName
        ? `✨ Passive Skill: ${pet.passiveName}\n${pet.passiveDescription ?? "No description available."}`
        : `✨ Passive Skill: Not unlocked (unlocks at Level 20)`;
      const status = pet.active && !pet.boxed ? "Active companion" : "Stored in Box";
      return { text: `🐾 PET DETAILS #${pet.id}\n\nName: ${pet.nickname === "__PENDING_NAME__" ? "Unnamed" : pet.nickname}\nOriginal Species: ${pet.isShiny ? "✨Shiny✨ " : ""}${pet.species}\nCurrent Owner: ${player.characterName}\nOriginal Owner: ${pet.originalOwnerName || "Unknown (captured before owner tracking)"}\nLevel: ${level}\nExperience: ${xpLine}\nStatus: ${status}\n\n${passiveLine}`, keyboard: menuKeyboard };
    }
    if (action === "deposit" || action === "store") { const petId = Number(args[2]); const [pet] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.id, petId), eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.boxed, 0))).limit(1); if (!pet) return { text: "Active pet not found. Use /box to view your pets.", keyboard: menuKeyboard }; await tx.update(telegramPetsTable).set({ active: 0, boxed: 1, updatedAt: new Date() }).where(eq(telegramPetsTable.id, pet.id)); return { text: `📦 ${pet.nickname} was deposited in your Box.`, keyboard: menuKeyboard }; }
    if (action === "withdraw" || action === "take") { const petId = Number(args[2]); const [existing] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.active, 1), eq(telegramPetsTable.boxed, 0))).limit(1); if (existing) await tx.update(telegramPetsTable).set({ active: 0, boxed: 1, updatedAt: new Date() }).where(eq(telegramPetsTable.id, existing.id)); const [pet] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.id, petId), eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.boxed, 1))).limit(1); if (!pet) return { text: "Pet not found in your Box. Use /box to view stored pets.", keyboard: menuKeyboard }; await tx.update(telegramPetsTable).set({ active: 1, boxed: 0, updatedAt: new Date() }).where(eq(telegramPetsTable.id, pet.id)); return { text: `🐾 ${pet.nickname} is now your active companion.`, keyboard: menuKeyboard }; }
    if (action === "trade") { const targetName = args[2]?.replace(/^@/, ""); const petId = Number(args[3]); if (!targetName || !petId) return { text: "Usage: /box trade @Username PET_ID", keyboard: menuKeyboard }; const [target] = await tx.select().from(telegramPlayersTable).where(and(eq(telegramPlayersTable.chatId, event.chatId), sql`lower(${telegramPlayersTable.username}) = lower(${targetName})`)).limit(1); const [pet] = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.id, petId), eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId), eq(telegramPetsTable.boxed, 1))).limit(1); if (!target || !pet) return { text: "Could not find that player or a boxed pet with that ID. Only boxed pets can be traded.", keyboard: menuKeyboard }; await tx.update(telegramPetsTable).set({ telegramId: target.telegramId, chatId: target.chatId, active: 0, boxed: 1, updatedAt: new Date() }).where(eq(telegramPetsTable.id, pet.id)); return { text: `🤝 ${pet.nickname} has been transferred to ${target.characterName}'s Box.`, keyboard: menuKeyboard }; }
    const pets = await tx.select().from(telegramPetsTable).where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId))).orderBy(asc(telegramPetsTable.id));
    const lines = ["📦 Pet Box", "Use /box info PET_ID, /box deposit PET_ID, /box withdraw PET_ID, or /box trade @Username PET_ID."];
    if (!pets.length) lines.push("Your Box is empty. Capture monsters with a Catching Net during combat when they are below 50% HP.");
    for (const pet of pets) {
      lines.push(`#${pet.id} · ${pet.nickname === "__PENDING_NAME__" ? "Awaiting name" : pet.nickname} (${pet.isShiny ? "✨Shiny✨ " : ""}${pet.species}) · Lv. ${Math.max(1, pet.level)} · ${pet.active && !pet.boxed ? "ACTIVE" : "BOXED"}`);
      if (pet.passiveName) lines.push(`   ✨ ${pet.passiveName}: ${pet.passiveDescription ?? "Passive companion ability"}`);
      else if (pet.level >= 20) lines.push("   ✨ Passive ability pending unlock");
      else lines.push(`   XP: ${pet.xp}/${petXpToNext(Math.max(1, pet.level))} · passive unlocks at Lv. 20`);
    }
    return { text: lines.join("\n"), keyboard: { inline_keyboard: [...menuKeyboard.inline_keyboard.slice(0, 3), [button("📦 Box", "box")], ...menuKeyboard.inline_keyboard.slice(3)] } };
  }

  if (command === "/settings" || callback === "settings") {
    const [settings] = await tx.select().from(telegramPlayerSettingsTable).where(eq(telegramPlayerSettingsTable.telegramId, event.actor.id)).limit(1);
    const language = settings?.language ?? "en";
    return { text: `⚙️ Settings\n\nChoose your language. Current language: ${language === "it" ? "🇮🇹 Italiano" : "🇬🇧 English"}.`, keyboard: settingsKeyboard(language) };
  }
  if (callback === "settings:language") {
    const [settings] = await tx.select().from(telegramPlayerSettingsTable).where(eq(telegramPlayerSettingsTable.telegramId, event.actor.id)).limit(1);
    const nextLanguage = settings?.language === "it" ? "en" : "it";
    await tx.insert(telegramPlayerSettingsTable).values({ telegramId: event.actor.id, language: nextLanguage }).onConflictDoUpdate({ target: telegramPlayerSettingsTable.telegramId, set: { language: nextLanguage, updatedAt: new Date() } });
    const label = nextLanguage === "it" ? "🇮🇹 Italiano" : "🇬🇧 English";
    const text = nextLanguage === "it" ? `⚙️ Impostazioni\n\nLingua aggiornata: ${label}. I tuoi messaggi personali saranno tradotti in italiano.` : `⚙️ Settings\n\nLanguage updated: ${label}. Your personal messages will be shown in English.`;
    return { text, keyboard: settingsKeyboard(nextLanguage) };
  }

  if (callback === "timetravel:prompt") {
    if (player.level < 101) return { text: "🔒 Time Travel unlocks at level 101.", keyboard: menuKeyboard };
    return { text: `🔴🌀 TIME TRAVEL ⏳\n\nYou are about to reset your level, XP, stats, class, region, gold, potions, equipment, inventory, and pets. Your Rebirth count and rCoins will be preserved.\n\nCurrent Rebirths: ${player.rebirths}\nReward: +5% XP, +5% gold, and +5 rCoins.\n\nThis cannot be undone. Confirm?`, keyboard: { inline_keyboard: [[button("🔴🌀 Confirm Time Travel", "timetravel:confirm")], [button("❌ Cancel", "menu")]] } };
  }
  if (callback === "timetravel:confirm") {
    if (player.level < 101) return { text: "🔒 You need to reach level 101 to use Time Travel.", keyboard: menuKeyboard };
    await tx.delete(telegramPlayerEquipmentTable).where(and(eq(telegramPlayerEquipmentTable.telegramId, player.telegramId), eq(telegramPlayerEquipmentTable.chatId, player.chatId)));
    await tx.delete(telegramPlayerInventoryTable).where(and(eq(telegramPlayerInventoryTable.telegramId, player.telegramId), eq(telegramPlayerInventoryTable.chatId, player.chatId)));
    await tx.delete(telegramPetsTable).where(and(eq(telegramPetsTable.telegramId, player.telegramId), eq(telegramPetsTable.chatId, player.chatId)));
    const nextRebirths = (player.rebirths ?? 0) + 1;
    await tx.update(telegramPlayersTable).set({ archetype: "Jobless", classId: null, level: 0, xp: 0, hp: 20, maxHp: 20, attack: 4, defense: 1, potions: 2, coins: 10, biomeId: 1, combat: null, explorationEvent: null, rebirths: nextRebirths, rCoins: (player.rCoins ?? 0) + 5, updatedAt: new Date() }).where(playerScope(event));
    return { text: `🌀✨ TIME TRAVEL COMPLETE!\n\n♻️ Rebirth #${nextRebirths} unlocked!\n✨ Permanent XP bonus: +${nextRebirths * 5}%\n💰 Permanent gold bonus: +${nextRebirths * 5}%\n🪙 You received 5 rCoins (total: ${(player.rCoins ?? 0) + 5}).\n\nYour adventure begins again in the first region. Your Rebirths and rCoins are permanent.`, keyboard: menuKeyboard };
  }

  if (command === "/start" || command === "/menu" || callback === "menu") {
    return homeReply(tx, player);
  }

  if (command === "/help" || callback === "help") {
    return helpReply();
  }
  if (command === "/profile" || callback === "profile") {
    return { text: formatProfile(player), keyboard: { inline_keyboard: [[button("⬅️ Back", "menu")]] } };
  }
  if (command === "/pet") {
    const [pet] = await tx.select().from(telegramPetsTable)
      .where(and(
        eq(telegramPetsTable.telegramId, player.telegramId),
        eq(telegramPetsTable.chatId, player.chatId),
        eq(telegramPetsTable.active, 1),
        eq(telegramPetsTable.boxed, 0),
      ))
      .limit(1);
    if (!pet) {
      return { text: "🐾 You don't have an active pet right now. Capture one or withdraw a pet from /box.", keyboard: menuKeyboard };
    }
    const level = Math.max(1, pet.level || 1);
    const xp = Math.max(0, pet.xp || 0);
    const xpLine = level >= 20 ? `${xp} XP (maximum level reached)` : `${xp}/${petXpToNext(level)} XP`;
    const name = pet.nickname === "__PENDING_NAME__" ? "Unnamed (use /renamepet NEW_NAME)" : pet.nickname;
    const passiveLine = pet.passiveName
      ? `✨ Passive Skill: ${pet.passiveName}\n${pet.passiveDescription ?? "No description available."}`
      : "✨ Passive Skill: Not unlocked (unlocks at Level 20)";
    return {
      text: `🐾 ACTIVE PET\n\nName: ${name}\nSpecies: ${pet.isShiny ? "✨Shiny✨ " : ""}${pet.species}\nLevel: ${level}\nExperience: ${xpLine}\n\n${passiveLine}`,
      keyboard: menuKeyboard,
    };
  }
  if (callback?.startsWith("inventory:category:")) {
    const requestedCategory = callback.slice("inventory:category:".length);
    if (isInventoryCategory(requestedCategory)) return backpackReply(tx, player, undefined, requestedCategory);
    return backpackReply(tx, player);
  }
  if (
    command === "/inventory" ||
    callback === "inventory" ||
    callback === "inventory:owned" ||
    callback?.startsWith("inventory:catalog:")
  ) {
    return backpackReply(tx, player);
  }
  // Boss fights and duels.
  if (command === "/arena" || callback === "lobby:new:arena") return openLobby(tx, event, player, "arena");
  if (command === "/boss" || callback === "lobby:new:boss") {
    return openLobby(tx, event, player, "boss");
  }
  if (command === "/duel" || callback === "lobby:new:duel") {
    let target: { telegramId: string; name: string } | undefined;
    if (rawCommand === "dduel" || (rawCommand === "/duel" && rawParts[1]?.startsWith("@"))) {
      const username = (rawParts[1] ?? "").replace(/^@/, "").toLowerCase();
      if (!username) return { text: "Usage: Dduel @Username. The player must have joined this chat and started SillyRPG first.", keyboard: menuKeyboard };
      const [targetPlayer] = await tx.select().from(telegramPlayersTable).where(and(
        eq(telegramPlayersTable.chatId, event.chatId),
        sql`lower(${telegramPlayersTable.username}) = ${username}`,
      )).limit(1);
      if (!targetPlayer) return { text: `I couldn't find @${username}. They must have joined this chat and started SillyRPG first.`, keyboard: menuKeyboard };
      if (targetPlayer.telegramId === event.actor.id) return { text: "You can't duel yourself.", keyboard: menuKeyboard };
      target = { telegramId: targetPlayer.telegramId, name: targetPlayer.characterName };
    }
    return openLobby(tx, event, player, "duel", target);
  }
  if (callback?.startsWith("lobby:join:")) {
    return joinLobby(tx, event, player, Number(callback.slice("lobby:join:".length)));
  }
  if (callback?.startsWith("lobby:act:")) {
    const [, , id, action] = callback.split(":");
    return lobbyAction(tx, event, Number(id), action ?? "");
  }
  if (callback === "merchant:leave") { await tx.update(telegramPlayersTable).set({ explorationEvent: null, updatedAt: new Date() }).where(playerScope(event)); return { text: "You thank the wandering merchant and continue your journey.", keyboard: menuKeyboard }; }
  if (callback === "merchant:back") { if (player.explorationEvent?.id === "wandering_merchant") return wanderingMerchantReply(tx, event, player, player.explorationEvent); return { text: "The merchant has already left.", keyboard: menuKeyboard }; }
  if (callback?.startsWith("merchant:buy:")) return buyMerchantOffer(tx, event, player, Number(callback.slice("merchant:buy:".length)));
  if (callback?.startsWith("exploreevent:")) {
    return resolveExplorationEvent(tx, event, player, callback);
  }

  // While waiting in a lobby or fighting in one, nothing else can be done.
  const guarded =
    command === "/explore" ||
    command === "/sleep" ||
    command === "/use" ||
    command === "/equip" ||
    command === "/orb" ||
    callback === "explore" ||
    callback === "sleep" ||
    callback === "sleep:confirm" ||
    callback === "attack" ||
    callback === "defense" ||
    callback === "potion" ||
    callback === "combat:inventory" ||
    callback?.startsWith("consumable:use:") ||
    callback === "flee" ||
    callback?.startsWith("equip:") ||
    callback?.startsWith("unequip:") ||
    callback?.startsWith("orb:") ||
    callback?.startsWith("orbok:") ||
    callback?.startsWith("boss:") ||
    callback?.startsWith("region:");
  if (guarded) {
    const active = await findActiveLobbyFor(tx, event.chatId, event.actor.id);
    if (active) {
      return {
        text:
          active.status === "open"
            ? "You are waiting in a lobby. Wait for it to start before doing anything else."
            : "You are in the middle of a fight. Use the buttons on the fight message.",
        keyboard: menuKeyboard,
      };
    }
  }

  if (command === "/sell") {
    if (player.combat) return backpackReply(tx, player, "You can't sell items during combat.");
    const parts = (event.text ?? "").trim().split(/\s+/);
    const rawId = parts[1];
    const rawAmount = parts[2];

    // Bulk mode: /sell common weapons, /sell uncommon armors, etc.
    const rarityNames: Record<string, string> = {
      common: "Common", uncommon: "Uncommon", rare: "Rare",
      epic: "Epic", legendary: "Legendary", mythic: "Mythic",
    };
    const typeNames: Record<string, string> = {
      weapon: "Weapons", weapons: "Weapons", armor: "Armors", armors: "Armors",
      armour: "Armors", armours: "Armors",
    };
    const bulkRarity = rawId ? rarityNames[rawId.toLowerCase()] : undefined;
    const bulkType = rawAmount ? typeNames[rawAmount.toLowerCase()] : undefined;
    if (bulkRarity && bulkType && parts.length === 3) {
      const ownedItems = await tx.select({
        inventoryId: telegramPlayerInventoryTable.inventoryId,
        itemId: itemsTable.itemId,
        name: itemsTable.name,
        type: itemsTable.type,
        tier: itemsTable.tier,
        rarity: itemsTable.rarity,
        stats: itemsTable.stats,
        quantity: telegramPlayerInventoryTable.quantity,
      }).from(telegramPlayerInventoryTable)
        .innerJoin(itemsTable, eq(telegramPlayerInventoryTable.itemId, itemsTable.itemId))
        .where(and(
          eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
          eq(telegramPlayerInventoryTable.chatId, player.chatId),
          eq(itemsTable.rarity, bulkRarity),
          eq(itemsTable.type, bulkType),
        ));
      if (!ownedItems.length) return backpackReply(tx, player, `No ${bulkRarity.toLowerCase()} ${bulkType.toLowerCase()} to sell.`);
      const equippedRows = await tx.select({ itemId: telegramPlayerEquipmentTable.itemId })
        .from(telegramPlayerEquipmentTable)
        .where(and(
          eq(telegramPlayerEquipmentTable.telegramId, player.telegramId),
          eq(telegramPlayerEquipmentTable.chatId, player.chatId),
        ));
      const equippedIds = new Set(equippedRows.map(row => row.itemId));
      const rarityMultiplier: Record<string, number> = { Common: 1, Uncommon: 1.5, Rare: 2.5, Epic: 4, Legendary: 7, Mythic: 12 };
      let totalCoins = 0;
      let soldStacks = 0;
      let soldQuantity = 0;
      let skippedEquipped = 0;
      for (const item of ownedItems) {
        if (equippedIds.has(item.itemId)) { skippedEquipped++; continue; }
        const stats = item.stats && typeof item.stats === "object" ? item.stats as Record<string, unknown> : {};
        const statPower = [stats.atk, stats.def, stats.hp].reduce((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0), 0);
        const unitPrice = Math.max(1, Math.floor((5 + Math.max(0, item.tier) * 5 + statPower * 2) * (rarityMultiplier[item.rarity] ?? 1)));
        totalCoins += unitPrice * item.quantity;
        soldQuantity += item.quantity;
        soldStacks++;
        await tx.delete(telegramPlayerInventoryTable).where(and(
          eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
          eq(telegramPlayerInventoryTable.chatId, player.chatId),
          eq(telegramPlayerInventoryTable.inventoryId, item.inventoryId),
        ));
      }
      if (totalCoins === 0) return backpackReply(tx, player, `All matching ${bulkType.toLowerCase()} are equipped; unequip them before selling.`);
      await tx.update(telegramPlayersTable).set({ coins: player.coins + totalCoins, updatedAt: new Date() }).where(playerScope(event));
      const skippedNote = skippedEquipped ? ` Skipped ${skippedEquipped} equipped item${skippedEquipped === 1 ? "" : "s"}.` : "";
      return backpackReply(tx, { ...player, coins: player.coins + totalCoins }, `💰 Bulk sold ${soldQuantity}× ${bulkRarity.toLowerCase()} ${bulkType.toLowerCase()} (${soldStacks} stack${soldStacks === 1 ? "" : "s"}) for ${totalCoins} Coins.${skippedNote}`);
    }
    const inventoryId = rawId && /^\d+$/.test(rawId) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(inventoryId) || inventoryId <= 0 || !rawAmount || !(rawAmount === "*" || /^\d+$/.test(rawAmount))) {
      return { text: "Usage: /sell ID * or /sell ID NUMBER; bulk: /sell common weapons (or uncommon armors). Find IDs in /inventory.", keyboard: await backpackReply(tx, player) };
    }
    const [owned] = await tx.select({
      inventoryId: telegramPlayerInventoryTable.inventoryId,
      itemId: itemsTable.itemId,
      name: itemsTable.name,
      type: itemsTable.type,
      tier: itemsTable.tier,
      rarity: itemsTable.rarity,
      stats: itemsTable.stats,
      quantity: telegramPlayerInventoryTable.quantity,
    }).from(telegramPlayerInventoryTable)
      .innerJoin(itemsTable, eq(telegramPlayerInventoryTable.itemId, itemsTable.itemId))
      .where(and(
        eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
        eq(telegramPlayerInventoryTable.chatId, player.chatId),
        eq(telegramPlayerInventoryTable.inventoryId, inventoryId),
      )).limit(1);
    if (!owned) return backpackReply(tx, player, "You don't own an item with that ID.");
    const equipped = await tx.select({ itemId: telegramPlayerEquipmentTable.itemId })
      .from(telegramPlayerEquipmentTable)
      .where(and(
        eq(telegramPlayerEquipmentTable.telegramId, player.telegramId),
        eq(telegramPlayerEquipmentTable.chatId, player.chatId),
        eq(telegramPlayerEquipmentTable.itemId, owned.itemId),
      )).limit(1);
    if (equipped.length) return backpackReply(tx, player, "You can't sell an equipped item. Unequip it first.");
    const amount = rawAmount === "*" ? owned.quantity : Number(rawAmount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return backpackReply(tx, player, "Quantity must be a positive whole number.");
    if (amount > owned.quantity) return backpackReply(tx, player, `You only have ${owned.quantity} of that item.`);
    const rarityMultiplier: Record<string, number> = { Common: 1, Uncommon: 1.5, Rare: 2.5, Epic: 4, Legendary: 7, Mythic: 12 };
    const stats = owned.stats && typeof owned.stats === "object" ? owned.stats as Record<string, unknown> : {};
    const statPower = [stats.atk, stats.def, stats.hp].reduce((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0), 0);
    const unitPrice = Math.max(1, Math.floor((5 + Math.max(0, owned.tier) * 5 + statPower * 2) * (rarityMultiplier[owned.rarity] ?? 1)));
    const totalPrice = unitPrice * amount;
    if (amount === owned.quantity) {
      await tx.delete(telegramPlayerInventoryTable).where(and(
        eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
        eq(telegramPlayerInventoryTable.chatId, player.chatId),
        eq(telegramPlayerInventoryTable.inventoryId, inventoryId),
      ));
    } else {
      await tx.update(telegramPlayerInventoryTable).set({ quantity: owned.quantity - amount }).where(and(
        eq(telegramPlayerInventoryTable.telegramId, player.telegramId),
        eq(telegramPlayerInventoryTable.chatId, player.chatId),
        eq(telegramPlayerInventoryTable.inventoryId, inventoryId),
      ));
    }
    await tx.update(telegramPlayersTable).set({ coins: player.coins + totalPrice, updatedAt: new Date() }).where(playerScope(event));
    return backpackReply(tx, { ...player, coins: player.coins + totalPrice }, `💰 Sold ${amount}× ${owned.name} for ${totalPrice} Coins (${unitPrice} each).`);
  }

  if (command === "/equip" || command === "/use" || command === "/orb") {
    const rawId = event.text?.trim().split(/\s+/)[1];
    const inventoryId = rawId && /^\d+$/.test(rawId) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(inventoryId) || inventoryId <= 0) {
      return { text: `Usage: ${command} ID. Open /inventory to find an item's numeric ID.`, keyboard: await backpackReply(tx, player) };
    }
    if (command === "/equip") return equipItem(tx, event, player, inventoryId);
    if (command === "/use") return useConsumable(tx, event, player, inventoryId);
    return useOrb(tx, event, player, inventoryId, false);
  }

  if (callback === "combat:inventory") return consumableInventoryReply(tx, player, true);
  if (callback === "combat:back") return { text: `⚔️ Combat: ${player.combat?.name ?? "No active enemy"}.`, keyboard: await combatKeyboardFor(tx, player) };
  if (callback?.startsWith("consumable:use:")) return useConsumable(tx, event, player, Number(callback.slice("consumable:use:".length)));

  if (callback?.startsWith("equip:")) {
    return equipItem(tx, event, player, Number(callback.slice("equip:".length)));
  }
  if (callback?.startsWith("orbok:")) {
    return useOrb(tx, event, player, Number(callback.slice("orbok:".length)), true);
  }
  if (callback?.startsWith("orb:")) {
    return useOrb(tx, event, player, Number(callback.slice("orb:".length)), false);
  }
  if (callback?.startsWith("unequip:")) {
    return unequipSlot(tx, event, player, callback.slice("unequip:".length));
  }

  if (command === "/places" || callback === "places") {
    return {
      text: `You are in ${getRegion(player.biomeId).name}. Where do you want to go?`,
      keyboard: placesKeyboard(player),
    };
  }
  if (callback?.startsWith("boss:")) {
    return startBossFight(tx, event, player, callback.slice("boss:".length));
  }
  if (callback?.startsWith("region:")) {
    return chooseRegion(tx, event, player, callback.slice("region:".length));
  }
  if (command === "/explore" || callback === "explore") {
    return explore(tx, event, player);
  }
  if (command === "/sleep" || callback === "sleep") {
    return sleep(tx, event, player, false);
  }
  if (callback === "sleep:confirm") return sleep(tx, event, player, true);
  if (callback === "attack") return attack(tx, event, player);
  if (callback === "defense") return defend(tx, event, player);
  if (callback === "potion") return usePotion(tx, event, player);
  if (callback === "flee") return flee(tx, event, player);
  if (!event.text) return { text: "I didn't understand that action. Use the buttons or /help.", keyboard: menuKeyboard };

  // Groups often host several bots: silently ignore unknown slash commands so
  // this bot does not clutter the chat when another bot command is used.
  if (event.chatType !== "private" && rawCommand.startsWith("/")) return { text: "", silent: true };

  return {
    text: "I don't recognize that command. Use the buttons or type /help.",
    keyboard: menuKeyboard,
  };
}

export async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const event = getIncomingEvent(update);
  if (!event) return;
  const trimmedText = event.text?.trim() ?? "";
  const firstToken = trimmedText.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const quickAliases = new Set(["arena", "aarena", "hhunt", "dduel", "ccf", "eequip", "uuse", "ssleep", "bboss", "pprofile", "bbj", "sslot"]);
  const isCommand = trimmedText.startsWith("/") || quickAliases.has(firstToken);
  const isGroupMessage = event.chatType !== "private";
  if (
    isGroupMessage &&
    !isCommand &&
    !event.callbackData &&
    event.newChatMembers.length === 0
  ) {
    if (!event.text || !/^\d+$/.test(event.text.trim())) return;
    const pending = await db.select({ id: telegramCasinoSessionsTable.id })
      .from(telegramCasinoSessionsTable)
      .where(and(eq(telegramCasinoSessionsTable.chatId, event.chatId), eq(telegramCasinoSessionsTable.status, "active"), or(eq(telegramCasinoSessionsTable.ownerId, event.actor.id), eq(telegramCasinoSessionsTable.opponentId, event.actor.id))))
      .limit(1);
    if (pending.length === 0) return;
  }

  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(telegramUpdatesTable)
      .values({ updateId: event.updateId })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdatesTable.updateId });
    if (!inserted) return;

    const reply = await handleEvent(tx, event);
    // Unknown slash commands in groups are intentionally ignored without
    // enqueueing a Telegram reply. The reply only exists after handleEvent.
    if (reply.silent) return;
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

export async function markOutboxMessageSent(
  id: number,
  messageId: number | null,
): Promise<void> {
  await db
    .update(telegramOutboxTable)
    .set({ sentAt: new Date(), messageId })
    .where(eq(telegramOutboxTable.id, id));
}

// Earlier bot messages addressed to the same player in the same chat that are
// still on screen: they get deleted once a newer message has been delivered.
export async function getSupersededMessages(
  item: TelegramOutboxMessage,
): Promise<Array<{ id: number; messageId: number }>> {
  const targetId = item.ownerId ?? item.cleanupOwnerId;
  if (!targetId) return [];
  const rows = await db
    .select({
      id: telegramOutboxTable.id,
      messageId: telegramOutboxTable.messageId,
    })
    .from(telegramOutboxTable)
    .where(
      and(
        eq(telegramOutboxTable.chatId, item.chatId),
        eq(telegramOutboxTable.ownerId, targetId),
        isNotNull(telegramOutboxTable.messageId),
        lt(telegramOutboxTable.id, item.id),
      ),
    )
    .orderBy(asc(telegramOutboxTable.id))
    .limit(20);
  return rows.flatMap((row) =>
    row.messageId === null ? [] : [{ id: row.id, messageId: row.messageId }],
  );
}

export async function clearOutboxMessageId(id: number): Promise<void> {
  await db
    .update(telegramOutboxTable)
    .set({ messageId: null })
    .where(eq(telegramOutboxTable.id, id));
}

export async function pruneOldTelegramUpdates(): Promise<void> {
  await db.execute(sql`
    DELETE FROM telegram_game_updates
    WHERE created_at < NOW() - INTERVAL '90 days'
  `);
  await db.execute(sql`
    DELETE FROM telegram_lobbies
    WHERE status = 'finished' AND updated_at < NOW() - INTERVAL '7 days'
  `);
}
