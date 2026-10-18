# Valdombra — RPG Telegram

A text-based RPG adventure playable on Telegram, with characters, exploration, turn-based combat and saved progress.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server and Telegram bot (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` and `TELEGRAM_BOT_TOKEN` (secret created with BotFather)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- Telegram game state and delivery queue: `lib/db/src/schema/telegram-game.ts`
- Shared item catalog and import validation: `lib/db/src/schema/items.ts`
- Telegram command processing and polling: `artifacts/api-server/src/lib/telegram-game.ts` and `telegram-bot.ts`
- API contract source: `lib/api-spec/openapi.yaml`

## Architecture decisions

- The bot uses Telegram long polling so local development does not require a public webhook URL.
- Game updates and outgoing replies are stored in PostgreSQL; a transactional outbox prevents duplicate game actions on Telegram retries.
- Every bot reply starts with a "Message for <name>" line (plain name, no tag). When a reply is delivered, the player's previous bot message and their typed command are deleted to keep the chat clean (groups need the bot to have the delete-messages right).
- `/boss` opens a 30-second co-op lobby (max 4 players) against the region boss; `/duel` opens a 30-second lobby where the first challenger starts a duel. Both are round-based fights on one shared message that is edited in place (20s per round, idle players auto-attack). A background timer in `telegram-bot.ts` closes lobbies and resolves rounds; state lives in `telegram_lobbies`.
- Each character save is scoped to both the Telegram user and the chat, so the same player can have different characters in different groups.
- Item rows follow one shared schema for weapons, armor, and class orbs; populate the catalog only from the data supplied for those categories.

## Product

- Players are automatically given a level-0 character with no class in Emerald Grove; they can choose a class, explore, fight, collect items, and level up.
- Characters are saved per Telegram user and chat. Commands, button interactions, and new-member events create group-scoped saves.

## User preferences

-

## Gotchas

- Set `TELEGRAM_BOT_TOKEN` in Replit Secrets. Never log or display it.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
