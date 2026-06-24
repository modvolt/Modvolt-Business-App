/**
 * Převede chybu od OpenAI na srozumitelnou, uživatelsky bezpečnou hlášku
 * podle HTTP statusu / kódu. Cílem je, aby admin hned viděl pravou příčinu
 * (špatný klíč, neexistující model, vyčerpaný kredit, timeout) místo obecné
 * chyby. Používá ji jak chatová cesta (převod na 503), tak živá diagnostika.
 *
 * `envVar` určuje, na který konfigurační klíč hláška odkáže u neexistujícího
 * modelu (chat vs. embedding model jsou oddělené konfigurace).
 */
export function describeOpenAiError(
  e: { status?: number; code?: string; message?: string },
  model: string,
  envVar = "OPENAI_CHAT_MODEL",
): string {
  if (e?.status === 401 || e?.status === 403) {
    return "AI služba není dostupná: neplatný nebo chybějící OPENAI_API_KEY.";
  }
  if (e?.status === 404 || e?.code === "model_not_found") {
    return `AI služba není dostupná: model „${model}" neexistuje – zkontrolujte ${envVar}.`;
  }
  if (e?.status === 429) {
    return "AI služba není dostupná: překročen limit požadavků nebo vyčerpaný kredit u poskytovatele AI.";
  }
  const msg = (e?.message ?? "").toLowerCase();
  if (
    e?.code === "ETIMEDOUT" ||
    e?.code === "ECONNRESET" ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("premature close")
  ) {
    return "AI služba není dostupná: vypršel časový limit nebo bylo přerušeno spojení s poskytovatelem AI.";
  }
  return `AI služba není dostupná: chyba poskytovatele AI${
    e?.status ? ` (HTTP ${e.status})` : ""
  }.`;
}
