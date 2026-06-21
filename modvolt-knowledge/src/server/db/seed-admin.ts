import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { users } from "./schema.js";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";

/**
 * Založí (nebo volitelně aktualizuje) admin účet z ADMIN_EMAIL / ADMIN_PASSWORD.
 * Volá se automaticky při startu serveru (viz runMigrations) i z CLI.
 *
 * - Bez force: admina vytvoří jen pokud ještě neexistuje. Heslo existujícího
 *   účtu se NEPŘEPISUJE, aby restart serveru nezrušil změnu hesla provedenou
 *   v aplikaci.
 * - S force (CLI `db:seed-admin`): vždy přepíše heslo/roli existujícího účtu
 *   na hodnoty z env (reset admina).
 */
export async function seedAdmin(
  db: NodePgDatabase<any>,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { email, password, name } = env.admin;
  if (!email || !password) {
    logger.warn(
      "ADMIN_EMAIL/ADMIN_PASSWORD nejsou nastaveny — admin účet se nevytvoří.",
    );
    return;
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existing.length > 0) {
    if (!opts.force) {
      logger.info(`Admin účet už existuje: ${normalizedEmail} (ponechávám).`);
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await db
      .update(users)
      .set({
        passwordHash,
        role: "admin",
        isActive: true,
        name,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing[0].id));
    logger.info(`Admin účet aktualizován: ${normalizedEmail}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.insert(users).values({
    name,
    email: normalizedEmail,
    passwordHash,
    role: "admin",
    isActive: true,
  });
  logger.info(`Admin účet vytvořen: ${normalizedEmail}`);
}
