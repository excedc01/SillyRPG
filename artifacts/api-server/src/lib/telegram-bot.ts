import { logger } from "./logger";
import {
  getPendingOutboxMessages,
  markOutboxMessageSent,
  processTelegramUpdate,
} from "./telegram-game";
import type { TelegramCallbackAnswer, TelegramUpdate } from "./telegram-types";

const apiBase = "https://api.telegram.org";
const pollingTimeoutSeconds = 25;

type TelegramEnvelope<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
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
    throw new TelegramApiError(method, response.status);
  }
  return envelope.result;
}

async function sendPendingMessages(): Promise<void> {
  const pending = await getPendingOutboxMessages();
  for (const item of pending) {
    if (item.callbackQueryId) {
      const answer: TelegramCallbackAnswer = {
        callback_query_id: item.callbackQueryId,
      };
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

    const payload: Record<string, unknown> = {
      chat_id: item.chatId,
      text: item.text,
    };
    if (item.replyMarkup) payload["reply_markup"] = item.replyMarkup;
    await telegramRequest("sendMessage", payload);
    await markOutboxMessageSent(item.id);
  }
}

async function configureBotCommands(): Promise<void> {
  await telegramRequest("setMyCommands", {
    commands: [
      { command: "start", description: "Crea il personaggio o apre il menu" },
      { command: "esplora", description: "Esplora la regione" },
      { command: "profilo", description: "Mostra la scheda" },
      { command: "inventario", description: "Mostra lo zaino" },
      { command: "luoghi", description: "Scegli una regione" },
      { command: "aiuto", description: "Mostra i comandi" },
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
          { method: error.method, status: error.status },
          "Telegram request failed; polling will retry",
        );
      } else {
        logger.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
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
  await pollLoop();
}
