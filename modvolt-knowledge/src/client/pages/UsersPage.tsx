import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });

  const load = () =>
    api
      .adminUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e.message));
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
      <h1 className="page-title">Uživatelé</h1>
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
