import React, { useEffect, useState } from "react";
import { api, type TagRow } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

export function TagsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [tags, setTags] = useState<TagRow[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = () =>
    api
      .tags()
      .then((r) => setTags(r.tags))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.createTag(name);
      setName("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Smazat štítek? Odebere se ze všech dokumentů.")) return;
    await api.deleteTag(id);
    load();
  };

  return (
    <div>
      <h1 className="page-title">Štítky</h1>

      {isAdmin && (
        <form className="card" onSubmit={create}>
          <h3 style={{ marginTop: 0 }}>Nový štítek</h3>
          <div className="field">
            <label>Název</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          {error && <div className="error">{error}</div>}
          <button type="submit">Vytvořit</button>
        </form>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Název</th>
              <th>Počet dokumentů</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="tag">{t.documentCount}</td>
                {isAdmin && (
                  <td style={{ textAlign: "right" }}>
                    <button className="ghost" onClick={() => remove(t.id)}>
                      Smazat
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {tags.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 3 : 2} className="tag">
                  Žádné štítky.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
