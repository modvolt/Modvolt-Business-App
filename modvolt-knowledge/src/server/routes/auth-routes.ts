import { createRouter } from "../lib/async-router.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "../auth/password.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../lib/audit.js";

export const authRouter = createRouter();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Neplatné přihlašovací údaje." });
  }
  const { email, password } = parsed.data;
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  const user = rows[0];
  if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "Nesprávný e-mail nebo heslo." });
  }

  req.session.userId = user.id;
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  await audit(req, "login", "user", user.id);

  res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("modvolt.sid");
    res.json({ ok: true });
  });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.currentUser });
});
