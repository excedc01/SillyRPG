import app from "./app";
import { logger } from "./lib/logger";
import { migrateLegacyClassIds } from "./lib/legacy-migrations";
import { seedExtraItems } from "./lib/seed-items";
import { startTelegramBot } from "./lib/telegram-bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  const migrated = migrateLegacyClassIds().catch((error: unknown) => {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Legacy class migration failed",
    );
  });
  void seedExtraItems().catch((error: unknown) => {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Extra item catalog could not be synced",
    );
  });
  if (process.env.TELEGRAM_BOT_TOKEN) {
    void migrated.then(() => startTelegramBot()).catch((error: unknown) => {
      logger.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Telegram bot could not start",
      );
    });
  } else {
    logger.warn("TELEGRAM_BOT_TOKEN is not configured; Telegram polling is disabled");
  }
});
