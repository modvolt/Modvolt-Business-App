import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<
    { version: string; description: string; preview: string }[]
  >([]);
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

  const activeVersion = settings.ai_prompt_version || "v1";
  const activePreview = versions.find((v) => v.version === activeVersion)?.preview;

  return (
    <div>
      <h1 className="page-title">Nastavení</h1>
      <div className="card">
        <div className="notice">
          Tato nastavení řídí výchozí chování v aplikaci. Dostupnost AI a web search se
          řídí primárně proměnnými prostředí (env), tato volba slouží jako přepínač v rámci UI.
          Změny se projeví ihned, bez nutnosti redeploye.
        </div>
        <div className="field">
          <label>Aktivní verze promptu</label>
          <select
            value={activeVersion}
            onChange={(e) => set("ai_prompt_version", e.target.value)}
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version} — {v.description}
              </option>
            ))}
          </select>
        </div>
        {activePreview && (
          <div className="field">
            <label>Náhled systémového promptu (jen pro čtení)</label>
            <textarea
              readOnly
              value={activePreview}
              rows={14}
              style={{ fontFamily: "monospace", fontSize: "0.8rem" }}
            />
            <div className="notice" style={{ marginTop: 8 }}>
              Prompty jsou verzovány v kódu (auditovatelné). Zde můžete jejich znění
              zkontrolovat a vybrat aktivní verzi. Úprava znění promptu se provádí v kódu.
            </div>
          </div>
        )}
        <div className="field">
          <label>Spouštěcí klíčová slova zámku ČSN (csn_only)</label>
          <textarea
            value={settings.csn_lock_keywords || ""}
            onChange={(e) => set("csn_lock_keywords", e.target.value)}
            rows={12}
            placeholder="Jedno klíčové slovo nebo fráze na řádek…"
            style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
          />
          <div className="notice" style={{ marginTop: 8 }}>
            Jedno klíčové slovo nebo fráze na řádek. Pokud dotaz obsahuje některé z nich,
            vynutí se tvrdý zámek na pouze interní normové dokumenty (žádný web). Porovnává
            se bez ohledu na velikost písmen a diakritiku jako podřetězec — zadávejte
            kořeny slov (např. <code>norm</code>, <code>reviz</code>), aby se zachytily i
            různé pády. Čísla norem (ČSN/EN/IEC) jsou navíc hlídána vestavěnými pravidly.
          </div>
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
