import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

type Tab = "stats" | "users" | "settings" | "audit";

export function AdminPage() {
  const [tab, setTab] = useState<Tab>("stats");
  return (
    <div>
      <h1 className="page-title">Administrace</h1>
      <div className="chip-group" style={{ marginBottom: 16 }}>
        {(["stats", "users", "settings", "audit"] as Tab[]).map((t) => (
          <span
            key={t}
            className={`chip ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {tabLabel(t)}
          </span>
        ))}
      </div>
      {tab === "stats" && <StatsTab />}
      {tab === "users" && <UsersTab />}
      {tab === "settings" && <SettingsTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

function tabLabel(t: Tab): string {
  return { stats: "Přehled", users: "Uživatelé", settings: "Nastavení", audit: "Audit log" }[t];
}

function StatsTab() {
  const [stats, setStats] = useState<any>(null);
  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
  }, []);
  if (!stats) return <div className="spinner">Načítám…</div>;
  return (
    <div className="row">
      <div className="card">
        <div className="tag">Dokumenty</div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.documents}</div>
      </div>
      <div className="card">
        <div className="tag">Uživatelé</div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.users}</div>
      </div>
      <div className="card">
        <div className="tag">Dotazy</div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.queries}</div>
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });

  const load = () => api.adminUsers().then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.createUser(form);
      setForm({ name: "", email: "", password: "", role: "user" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleActive = async (u: any) => {
    await api.updateUser(u.id, { isActive: !u.isActive });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Smazat uživatele?")) return;
    await api.deleteUser(id);
    load();
  };

  return (
    <div>
      <form className="card" onSubmit={create}>
        <h3 style={{ marginTop: 0 }}>Nový uživatel</h3>
        <div className="row">
          <div className="field">
            <label>Jméno</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="field">
            <label>E-mail</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
          <div className="field">
            <label>Heslo (min. 8 znaků)</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          </div>
          <div className="field">
            <label>Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">Uživatel</option>
              <option value="read_only">Pouze čtení</option>
              <option value="admin">Administrátor</option>
            </select>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <button type="submit">Vytvořit</button>
      </form>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Jméno</th>
              <th>E-mail</th>
              <th>Role</th>
              <th>Stav</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td className="tag">{u.role}</td>
                <td>
                  <span className={`badge ${u.isActive ? "indexed" : "failed"}`}>
                    {u.isActive ? "aktivní" : "neaktivní"}
                  </span>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => toggleActive(u)}>
                    {u.isActive ? "Deaktivovat" : "Aktivovat"}
                  </button>
                  <button className="ghost" onClick={() => remove(u.id)}>
                    Smazat
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<{ version: string; description: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then((r) => {
      setSettings(r.settings as Record<string, string>);
      setVersions(r.promptVersions);
    }).catch((e) => setError(e.message));
  }, []);

  const set = (k: string, v: string) => setSettings((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setError("");
    try {
      await api.saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="notice">
        Tato nastavení řídí výchozí chování v aplikaci. Dostupnost AI a web search se
        řídí primárně proměnnými prostředí (env), tato volba slouží jako přepínač v rámci UI.
      </div>
      <div className="field">
        <label>Verze promptu</label>
        <select
          value={settings.ai_prompt_version || "v1"}
          onChange={(e) => set("ai_prompt_version", e.target.value)}
        >
          {versions.map((v) => (
            <option key={v.version} value={v.version}>
              {v.version} — {v.description}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Výchozí počet kontextových chunků</label>
        <input
          type="number"
          value={settings.default_context_chunks || "8"}
          onChange={(e) => set("default_context_chunks", e.target.value)}
        />
      </div>
      <div className="field">
        <label>Povolit nahrávání běžným uživatelům</label>
        <select
          value={settings.allow_user_uploads || "false"}
          onChange={(e) => set("allow_user_uploads", e.target.value)}
        >
          <option value="false">Ne</option>
          <option value="true">Ano</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <button onClick={save}>{saved ? "Uloženo ✓" : "Uložit nastavení"}</button>
    </div>
  );
}

function AuditTab() {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => {
    api.audit().then((r) => setLogs(r.logs)).catch(() => {});
  }, []);
  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Čas</th>
            <th>Akce</th>
            <th>Entita</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="tag">{new Date(l.createdAt).toLocaleString("cs-CZ")}</td>
              <td>{l.action}</td>
              <td className="tag">
                {l.entityType}
                {l.entityId ? ` · ${String(l.entityId).slice(0, 8)}` : ""}
              </td>
              <td className="tag">{l.ipAddress}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
