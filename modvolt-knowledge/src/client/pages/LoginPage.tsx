import React, { useState } from "react";
import { useAuth } from "../lib/auth.js";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand" style={{ justifyContent: "center" }}>
          <span className="dot" /> Modvolt Knowledge
        </div>
        <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
          Interní znalostní databáze
        </p>
        <div className="field">
          <label>E-mail</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label>Heslo</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "Přihlašuji…" : "Přihlásit se"}
        </button>
      </form>
    </div>
  );
}
