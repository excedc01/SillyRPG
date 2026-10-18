import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

// One-off, idempotent data fix: saves created before the English translation
// store the old class ids/names. Rewrite them so existing characters keep
// their class. Does nothing once every row is already migrated.
export async function migrateLegacyClassIds(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE telegram_players SET
      class_id = CASE
        WHEN class_id = 'guerriero' OR archetype = 'Guerriero' THEN 'warrior'
        WHEN class_id = 'esploratore' OR archetype = 'Esploratore' THEN 'explorer'
        WHEN class_id = 'arcanista' OR archetype = 'Arcanista' THEN 'arcanist'
        ELSE class_id
      END,
      archetype = CASE
        WHEN class_id = 'guerriero' OR archetype = 'Guerriero' THEN 'Warrior'
        WHEN class_id = 'esploratore' OR archetype = 'Esploratore' THEN 'Explorer'
        WHEN class_id = 'arcanista' OR archetype = 'Arcanista' THEN 'Arcanist'
        ELSE archetype
      END
    WHERE class_id IN ('guerriero', 'esploratore', 'arcanista')
       OR archetype IN ('Guerriero', 'Esploratore', 'Arcanista')
  `);
  logger.info({ rows: result.rowCount ?? 0 }, "Legacy class ids migrated");
}
