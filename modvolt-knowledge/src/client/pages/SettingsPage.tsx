import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<{ version: string; description: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setSettings(r.settings as Record<string, string>);
        setVersions(r.promptVersions);
      })
      .catch((e) => setError(e.message));
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
    <div>
      <h1 className="page-title">Nastavení</h1>
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
    </div>
  );
}
