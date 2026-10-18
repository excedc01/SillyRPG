import { logger } from "./logger";
import {
  clearOutboxMessageId,
  getLobbyMessageId,
  getPendingOutboxMessages,
  getSupersededMessages,
  markOutboxMessageSent,
  processDueLobbies,
  processTelegramUpdate,
  setLobbyMessageId,
} from "./telegram-game";
import type { TelegramCallbackAnswer, TelegramUpdate } from "./telegram-types";
import type { TelegramOutboxMessage } from "@workspace/db";

const apiBase = "https://api.telegram.org";
const pollingTimeoutSeconds = 25;

type TelegramEnvelope<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

// Normalize both current inline keyboards and legacy/nested markup already
// persisted in the outbox. Telegram expects reply_markup.inline_keyboard to
// be an array of button rows; a wrapper like { keyboard: { inline_keyboard } }
// causes HTTP 400 ("field keyboard must be of type Array").
function normalizeReplyMarkup(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const candidate = raw.reply_markup && typeof raw.reply_markup === "object" && !Array.isArray(raw.reply_markup)
    ? raw.reply_markup as Record<string, unknown>
    : raw;

  if (Array.isArray(candidate.inline_keyboard)) {
    return { inline_keyboard: candidate.inline_keyboard };
  }
  if (Array.isArray(candidate.keyboard)) {
    return { keyboard: candidate.keyboard };
  }
  // Handle a legacy nested `keyboard` property containing inline markup.
  if (candidate.keyboard && typeof candidate.keyboard === "object" && !Array.isArray(candidate.keyboard)) {
    const nested = candidate.keyboard as Record<string, unknown>;
    if (Array.isArray(nested.inline_keyboard)) return { inline_keyboard: nested.inline_keyboard };
    if (Array.isArray(nested.keyboard)) return { keyboard: nested.keyboard };
  }
  return undefined;
}

class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description?: string,
  ) {
    super(`Telegram API request failed: ${method} (${status})`);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

async function telegramRequest<T>(
  method: string,
  payload?: Record<string, unknown>,
  query?: Record<string, string>,
  timeoutMs = 35_000,
): Promise<T> {
  const url = new URL(`${apiBase}/bot${getBotToken()}/${method}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const envelope = (await response.json()) as TelegramEnvelope<T>;
  if (!response.ok || !envelope.ok) {
    throw new TelegramApiError(method, response.status, envelope.description);
  }
  return envelope.result;
}

async function deleteTelegramMessage(
  chatId: string,
  messageId: number,
): Promise<void> {
  try {
    await telegramRequest<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (error) {
    // Already deleted, older than 48h, or the bot lacks delete rights in this group.
    logger.warn(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
        telegramDescription: error instanceof TelegramApiError ? error.description : undefined,
        telegramMethod: error instanceof TelegramApiError ? error.method : undefined,
        telegramStatus: error instanceof TelegramApiError ? error.status : undefined,
      },
      "Telegram message could not be deleted",
    );
  }
}

// Keeps the chat tidy: once a new reply is out, remove the player's previous
// bot message (the one whose button was just pressed) and their typed command.
async function cleanUpChat(item: TelegramOutboxMessage): Promise<void> {
  try {
    for (const old of await getSupersededMessages(item)) {
      await deleteTelegramMessage(item.chatId, old.messageId);
      await clearOutboxMessageId(old.id);
    }
    if (item.triggerMessageId !== null) {
      await deleteTelegramMessage(item.chatId, item.triggerMessageId);
    }
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Chat cleanup failed; continuing",
    );
  }
}

async function deliverLobbyMessage(item: TelegramOutboxMessage): Promise<void> {
  const lobbyId = item.lobbyId!;
  const lobbyMessageId = await getLobbyMessageId(lobbyId);

  if (item.lobbyAction === "edit" && lobbyMessageId !== null) {
    try {
      await telegramRequest("editMessageText", {
        chat_id: item.chatId,
        message_id: lobbyMessageId,
        text: item.text,
        // Without a keyboard, an empty one removes the old buttons.
        reply_markup: normalizeReplyMarkup(item.replyMarkup) ?? { inline_keyboard: [] },
      });
      await markOutboxMessageSent(item.id, null);
      await cleanUpChat(item);
      return;
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        /not modified/i.test(error.description ?? "")
      ) {
        await markOutboxMessageSent(item.id, null);
        await cleanUpChat(item);
        return;
      }
      logger.warn(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          telegramDescription: error instanceof TelegramApiError ? error.description : undefined,
          telegramMethod: error instanceof TelegramApiError ? error.method : undefined,
          telegramStatus: error instanceof TelegramApiError ? error.status : undefined,
        },
        "Lobby message could not be edited; posting a new one",
      );
    }
  }

  const payload: Record<string, unknown> = {
    chat_id: item.chatId,
    text: item.text,
  };
  const replyMarkup = normalizeReplyMarkup(item.replyMarkup);
  if (replyMarkup) payload["reply_markup"] = replyMarkup;
  const sent = await telegramRequest<{ message_id?: number }>(
    "sendMessage",
    payload,
  );
  if (sent.message_id !== undefined) {
    await setLobbyMessageId(lobbyId, sent.message_id);
  }
  await markOutboxMessageSent(item.id, null);
  await cleanUpChat(item);
}

async function deliverPending(): Promise<void> {
  const pending = await getPendingOutboxMessages();
  for (const item of pending) {
    if (item.callbackQueryId) {
      const answer: TelegramCallbackAnswer = {
        callback_query_id: item.callbackQueryId,
      };
      if (item.callbackText) answer.text = item.callbackText;
      try {
        await telegramRequest<boolean>("answerCallbackQuery", { ...answer });
      } catch (error) {
        logger.warn(
          {
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Telegram callback could not be acknowledged; delivering the game reply anyway",
        );
      }
    }

    // Pure button acknowledgement (pop-up only): nothing to send.
    if (item.text === "") {
      await markOutboxMessageSent(item.id, null);
      continue;
    }

    if (item.lobbyId !== null) {
      await deliverLobbyMessage(item);
      continue;
    }

    const payload: Record<string, unknown> = {
      chat_id: item.chatId,
      text: item.text,
    };
    const replyMarkup = normalizeReplyMarkup(item.replyMarkup);
    if (replyMarkup) payload["reply_markup"] = replyMarkup;
    const sent = await telegramRequest<{ message_id?: number }>(
      "sendMessage",
      payload,
    );
    await markOutboxMessageSent(item.id, sent.message_id ?? null);
    await cleanUpChat(item);
  }
}

// The poll loop and the lobby timer both deliver messages: run them one at a
// time so the same outbox row is never sent twice.
let sendChain: Promise<unknown> = Promise.resolve();
function sendPendingMessages(): Promise<void> {
  const run = sendChain.then(deliverPending, deliverPending);
  sendChain = run.catch(() => undefined);
  return run;
}

// Starts lobbies whose 30 seconds are over and resolves rounds whose time ran out.
async function lobbyTimer(): Promise<void> {
  while (true) {
    await pause(1_000);
    try {
      await processDueLobbies();
      await sendPendingMessages();
    } catch (error) {
      logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          telegramDescription: error instanceof TelegramApiError ? error.description : undefined,
          telegramMethod: error instanceof TelegramApiError ? error.method : undefined,
          telegramStatus: error instanceof TelegramApiError ? error.status : undefined,
        },
        "Lobby timer failed; it will retry",
      );
    }
  }
}

async function configureBotCommands(): Promise<void> {
  await telegramRequest("setMyCommands", {
    commands: [
      { command: "start", description: "Create your character or open the menu" },
      { command: "explore", description: "Explore the region" },
      { command: "profile", description: "Show your character sheet" },
      { command: "inventory", description: "Browse your inventory by category" },
      { command: "equip", description: "Equip a weapon or armor by inventory ID" },
      { command: "use", description: "Use a consumable by inventory ID" },
      { command: "orb", description: "Use a Class Orb by inventory ID" },
      { command: "places", description: "Choose a region" },
      { command: "sleep", description: "Rest and restore your HP" },
      { command: "boss", description: "Open a co-op boss lobby (up to 4 players)" },
      { command: "duel", description: "Challenge anyone in the chat to a duel" },
      { command: "trade", description: "Request a safe item and coin trade" },
      { command: "help", description: "Show the commands" },
    ],
  });
}

async function pollLoop(): Promise<void> {
  let offset = 0;
  let lastPruneAt = 0;

  while (true) {
    try {
      await sendPendingMessages();
      const updates = await telegramRequest<TelegramUpdate[]>(
        "getUpdates",
        undefined,
        {
          offset: String(offset),
          timeout: String(pollingTimeoutSeconds),
          allowed_updates: JSON.stringify(["message", "callback_query"]),
        },
        35_000,
      );

      for (const update of updates) {
        await processTelegramUpdate(update);
        await sendPendingMessages();
        offset = Math.max(offset, update.update_id + 1);
      }

      if (Date.now() - lastPruneAt > 24 * 60 * 60 * 1000) {
        const { pruneOldTelegramUpdates } = await import("./telegram-game");
        await pruneOldTelegramUpdates();
        lastPruneAt = Date.now();
      }
    } catch (error) {
      if (error instanceof TelegramApiError) {
        logger.error(
          {
            method: error.method,
            status: error.status,
            description: error.description,
            errorMessage: error.message,
          },
          "Telegram request failed; polling will retry",
        );
      } else {
        logger.error(
          {
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          "Telegram bot loop failed; polling will retry",
        );
      }
      await pause(5_000);
    }
  }
}

export async function startTelegramBot(): Promise<void> {
  getBotToken();
  const bot = await telegramRequest<{ username?: string }>("getMe");
  await configureBotCommands();
  const webhook = await telegramRequest<{ url: string }>("getWebhookInfo");
  if (webhook.url) {
    logger.error(
      "Telegram has an existing webhook configured for this bot; remove it before using long polling",
    );
    return;
  }
  logger.info({ username: bot.username }, "Telegram bot connected and polling for updates");
  void lobbyTimer();
  await pollLoop();
}
