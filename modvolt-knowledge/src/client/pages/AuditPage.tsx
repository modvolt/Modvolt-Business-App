import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export function AuditPage() {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => {
    api
      .audit()
      .then((r) => setLogs(r.logs))
      .catch(() => {});
  }, []);
  return (
    <div>
      <h1 className="page-title">Audit log</h1>
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
    </div>
  );
}
