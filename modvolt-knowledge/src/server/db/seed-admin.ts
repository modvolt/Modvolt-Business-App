import bcrypt from "bcryptjs";
import { pool, db } from "./index.js";
import { users } from "./schema.js";
import { eq } from "drizzle-orm";
import { env } from "../env.js";

async function main() {
  const { email, password, name } = env.admin;
  if (!email || !password) {
    console.error(
      "ADMIN_EMAIL a ADMIN_PASSWORD musí být nastaveny v env pro vytvoření admina.",
    );
    process.exit(1);
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  const passwordHash = await bcrypt.hash(password, 12);

  if (existing.length > 0) {
    await db
      .update(users)
      .set({ passwordHash, role: "admin", isActive: true, name, updatedAt: new Date() })
      .where(eq(users.id, existing[0].id));
    console.log(`Admin účet aktualizován: ${email}`);
  } else {
    await db.insert(users).values({
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: "admin",
      isActive: true,
    });
    console.log(`Admin účet vytvořen: ${email}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Seed admina selhal:", err);
  process.exit(1);
});
