import React, { useEffect, useState } from "react";
import { api, type PromptVersionInfo } from "../lib/api.js";

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<PromptVersionInfo[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Editor vlastních promptů.
  const [editorVersion, setEditorVersion] = useState("");
  const [editorDescription, setEditorDescription] = useState("");
  const [editorBody, setEditorBody] = useState("");
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [promptError, setPromptError] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);

  const reload = () =>
    api
      .settings()
      .then((r) => {
        setSettings(r.settings as Record<string, string>);
        setVersions(r.promptVersions);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    reload();
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

  const resetEditor = () => {
    setEditorMode("create");
    setEditorVersion("");
    setEditorDescription("");
    setEditorBody("");
    setPromptError("");
  };

  const startNewFrom = (source?: PromptVersionInfo) => {
    setEditorMode("create");
    setEditorVersion("");
    setEditorDescription(source ? `Kopie ${source.version}` : "");
    setEditorBody(source?.body ?? "");
    setPromptError("");
  };

  const startEdit = (p: PromptVersionInfo) => {
    setEditorMode("edit");
    setEditorVersion(p.version);
    setEditorDescription(p.description);
    setEditorBody(p.body);
    setPromptError("");
  };

  const savePrompt = async () => {
    setPromptError("");
    try {
      if (editorMode === "create") {
        await api.createPrompt({
          version: editorVersion.trim(),
          description: editorDescription,
          body: editorBody,
        });
      } else {
        await api.updatePrompt(editorVersion, {
          description: editorDescription,
          body: editorBody,
        });
      }
      await reload();
      setPromptSaved(true);
      setTimeout(() => setPromptSaved(false), 2000);
      resetEditor();
    } catch (err) {
      setPromptError((err as Error).message);
    }
  };

  const deletePrompt = async (version: string) => {
    if (!window.confirm(`Smazat vlastní prompt „${version}"?`)) return;
    setPromptError("");
    try {
      await api.deletePrompt(version);
      await reload();
      if (editorMode === "edit" && editorVersion === version) resetEditor();
    } catch (err) {
      setPromptError((err as Error).message);
    }
  };

  const customVersions = versions.filter((v) => !v.builtIn);

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
                {v.version}{v.builtIn ? " (vestavěná)" : " (vlastní)"} — {v.description}
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
              Náhled obsahuje kompletní systémový prompt. Editovatelné je jen „tělo
              promptu" (základní pravidla); režim zdrojů, pravidla pro fotografie a
              povinný JSON formát odpovědi se přidávají automaticky, aby zůstala
              zachována struktura výstupu a vynucení citací.
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

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Vlastní prompty</h2>
        <div className="notice">
          Zde můžete vytvořit a upravit vlastní verze promptu bez zásahu do kódu. Upravuje
          se „tělo promptu" (základní pravidla / tón). Vestavěné verze jsou jen pro čtení,
          ale lze je naklonovat jako výchozí bod. Uložené verze se objeví ve výběru
          „Aktivní verze promptu" výše.
        </div>

        <div className="field">
          <label>Existující verze</label>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "4px 8px" }}>Verze</th>
                <th style={{ padding: "4px 8px" }}>Popis</th>
                <th style={{ padding: "4px 8px" }}>Typ</th>
                <th style={{ padding: "4px 8px" }}>Akce</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version} style={{ borderTop: "1px solid #2a2a2a" }}>
                  <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{v.version}</td>
                  <td style={{ padding: "4px 8px" }}>{v.description}</td>
                  <td style={{ padding: "4px 8px" }}>{v.builtIn ? "vestavěná" : "vlastní"}</td>
                  <td style={{ padding: "4px 8px" }}>
                    {v.builtIn ? (
                      <button type="button" onClick={() => startNewFrom(v)}>
                        Klonovat
                      </button>
                    ) : (
                      <>
                        <button type="button" onClick={() => startEdit(v)}>
                          Upravit
                        </button>{" "}
                        <button type="button" onClick={() => deletePrompt(v.version)}>
                          Smazat
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => startNewFrom()}>
              + Nová vlastní verze
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            {editorMode === "create" ? "Nová verze" : `Úprava verze: ${editorVersion}`}
          </label>
          {editorMode === "create" && (
            <input
              value={editorVersion}
              onChange={(e) => setEditorVersion(e.target.value)}
              placeholder="Identifikátor verze (např. vlastni-1)"
            />
          )}
        </div>
        <div className="field">
          <label>Popis</label>
          <input
            value={editorDescription}
            onChange={(e) => setEditorDescription(e.target.value)}
            placeholder="Krátký popis verze"
          />
        </div>
        <div className="field">
          <label>Tělo promptu (základní pravidla)</label>
          <textarea
            value={editorBody}
            onChange={(e) => setEditorBody(e.target.value)}
            rows={16}
            placeholder="Základní pravidla a tón promptu…"
            style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
          />
          <div className="notice" style={{ marginTop: 8 }}>
            Režim zdrojů, pravidla pro fotografie a povinný JSON formát odpovědi se
            přidávají automaticky — sem patří jen základní pravidla a tón.
          </div>
        </div>
        {promptError && <div className="error">{promptError}</div>}
        <button onClick={savePrompt}>
          {promptSaved
            ? "Uloženo ✓"
            : editorMode === "create"
            ? "Vytvořit prompt"
            : "Uložit změny"}
        </button>{" "}
        {editorMode === "edit" && (
          <button type="button" onClick={resetEditor}>
            Zrušit úpravy
          </button>
        )}
        {customVersions.length === 0 && (
          <div className="notice" style={{ marginTop: 8 }}>
            Zatím nejsou žádné vlastní verze. Vytvořte novou nebo naklonujte vestavěnou.
          </div>
        )}
      </div>
    </div>
  );
}
