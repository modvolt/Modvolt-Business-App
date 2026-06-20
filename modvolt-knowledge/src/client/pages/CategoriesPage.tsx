import React, { useEffect, useState } from "react";
import { api, type CategoryRow } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

export function CategoriesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  const load = () =>
    api
      .categories()
      .then((r) => setCategories(r.categories))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.createCategory({ name, description: description || undefined });
      setName("");
      setDescription("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Smazat kategorii? Dokumenty zůstanou bez kategorie.")) return;
    await api.deleteCategory(id);
    load();
  };

  return (
    <div>
      <h1 className="page-title">Kategorie</h1>

      {isAdmin && (
        <form className="card" onSubmit={create}>
          <h3 style={{ marginTop: 0 }}>Nová kategorie</h3>
          <div className="row">
            <div className="field">
              <label>Název</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label>Popis (volitelný)</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
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
              <th>Popis</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="tag">{c.description || "—"}</td>
                {isAdmin && (
                  <td style={{ textAlign: "right" }}>
                    <button className="ghost" onClick={() => remove(c.id)}>
                      Smazat
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 3 : 2} className="tag">
                  Žádné kategorie.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
