// Obrana proti prompt injection z webových stránek. Obsah webu se do kontextu
// modelu vkládá jen jako DATA, nikdy jako instrukce. Tato vrstva navíc
// neutralizuje typické injektážní fráze a omezí délku.

const INJECTION_PATTERNS: RegExp[] = [
  /ignor(e|uj)[^\n]{0,40}(instruction|instrukc|prompt|pravidl)/gi,
  /disregard[^\n]{0,40}(previous|above|instruction)/gi,
  /(you are now|jsi nyní|od ted'? jsi|act as|chovej se jako)/gi,
  /(system\s*prompt|systémov[ýé]\s*prompt|developer\s*message)/gi,
  /(reveal|vypiš|ukaž)[^\n]{0,30}(prompt|instrukc|systém)/gi,
  /(odpověz|answer)[^\n]{0,30}(bez citac|without citation)/gi,
  /<\s*\/?\s*(system|assistant|user)\s*>/gi,
];

const MAX_SNIPPET_CHARS = 1200;

/** Neutralizuje injektážní pokyny ve webovém textu a zkrátí jej. */
export function sanitizeWebText(text: string): string {
  if (!text) return "";
  let out = text;
  for (const re of INJECTION_PATTERNS) {
    out = out.replace(re, "[odstraněný pokyn]");
  }
  // Sjednoť bílé znaky a omez délku.
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_SNIPPET_CHARS) {
    out = out.slice(0, MAX_SNIPPET_CHARS) + "…";
  }
  return out;
}
