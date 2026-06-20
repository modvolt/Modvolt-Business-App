import { getOpenAi } from "./openai-client.js";
import { env, isOpenAiUsable } from "../env.js";
import {
  getPrompt,
  DEFAULT_PROMPT_VERSION,
} from "./prompts/index.js";
import { searchChunks, type SearchHit } from "../search/search-service.js";
import { resolveSourceMode, sourceModeAllowsWeb } from "../search/source-mode.js";
import { webSearch, webSearchAvailable, type WebSearchResult } from "../search/web-search-service.js";
import { describeImage, visionAvailable } from "./vision-analysis.js";
import type { AiAnswer, SourceMode } from "../../shared/types.js";
import { logger } from "../lib/logger.js";

export interface AskOptions {
  query: string;
  requestedSourceMode: SourceMode;
  includeAdminOnly: boolean;
  imageBuffers?: Buffer[];
  promptVersion?: string;
}

export interface AskResult {
  answer: AiAnswer;
  usedChunkIds: string[];
  usedWebSearch: boolean;
  promptVersion: string;
  model: string;
}

export function aiChatAvailable(): boolean {
  return isOpenAiUsable();
}

export async function ask(opts: AskOptions): Promise<AskResult> {
  if (!aiChatAvailable()) {
    throw new Error("AI chat není dostupný (OpenAI je vypnuto).");
  }

  const decision = resolveSourceMode(opts.query, opts.requestedSourceMode);
  const promptVersion = opts.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const prompt = getPrompt(promptVersion);

  // 1) Vize: popiš fotografie (pokud jsou a vize je dostupná).
  const imageObservations: string[] = [];
  const hasImages = Boolean(opts.imageBuffers && opts.imageBuffers.length > 0);
  if (hasImages && visionAvailable()) {
    for (const buf of opts.imageBuffers!) {
      try {
        const desc = await describeImage(buf);
        if (desc) imageObservations.push(desc);
      } catch (err) {
        logger.warn("Popis fotografie selhal", String(err));
      }
    }
  }

  // 2) Interní vyhledávání.
  const searchQuery = [opts.query, ...imageObservations].join("\n");
  const hits = await searchChunks(searchQuery, {
    limit: env.openai.maxContextChunks,
    sourceMode: decision.sourceMode,
    includeAdminOnly: opts.includeAdminOnly,
  });

  // 3) Web search jen pokud režim povolí a je dostupný.
  let webResults: WebSearchResult[] = [];
  const wantWeb = sourceModeAllowsWeb(decision.sourceMode);
  if (wantWeb && webSearchAvailable()) {
    // internal_then_web: web jen pokud interní zdroje nestačí.
    const internalInsufficient =
      decision.sourceMode === "web_allowed" || hits.length < 2;
    if (internalInsufficient) {
      webResults = await webSearch(opts.query);
    }
  }

  // 4) Sestavení kontextu a volání modelu.
  const systemPrompt = prompt.buildSystemPrompt({
    sourceMode: decision.sourceMode,
    sourceModeLocked: decision.locked,
    webSearchAvailable: webSearchAvailable(),
    hasImages,
  });

  const contextBlock = buildContextBlock(hits, webResults);
  const userContent = `DOTAZ:\n${opts.query}\n\n${
    imageObservations.length
      ? `POZOROVÁNÍ Z FOTOGRAFIÍ:\n${imageObservations.join("\n---\n")}\n\n`
      : ""
  }DOSTUPNÉ ZDROJE:\n${contextBlock}`;

  const completion = await getOpenAi().chat.completions.create({
    model: env.openai.chatModel,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const answer = parseAnswer(raw, decision.sourceMode, decision);
  if (imageObservations.length && answer.imageObservations?.length === 0) {
    answer.imageObservations = imageObservations;
  }

  // Vynucení povinných citací na straně serveru: pokud byly k dispozici
  // interní/webové zdroje, ale model neuvedl žádnou citaci, odpověď
  // nepovažujeme za dostatečně podloženou a upozorníme uživatele.
  const validChunkIds = new Set(hits.map((h) => h.chunkId));
  answer.citations = (answer.citations ?? []).filter(
    (c) => c.chunkId && validChunkIds.has(c.chunkId),
  );
  const hadSources = hits.length > 0 || webResults.length > 0;
  const hasAnyCitation =
    answer.citations.length > 0 || (answer.webCitations?.length ?? 0) > 0;
  if (answer.answer.trim().length > 0 && hadSources && !hasAnyCitation) {
    answer.hasSufficientSources = false;
    answer.confidence = "low";
    answer.warnings = [
      "Odpověď neobsahuje ověřitelné citace zdrojů, proto ji nelze považovat za podloženou. Ověřte informace v původních dokumentech.",
      ...(answer.warnings ?? []),
    ];
  }

  return {
    answer,
    usedChunkIds: hits.map((h) => h.chunkId),
    usedWebSearch: webResults.length > 0,
    promptVersion,
    model: env.openai.chatModel,
  };
}

function buildContextBlock(
  hits: SearchHit[],
  webResults: WebSearchResult[],
): string {
  const parts: string[] = [];
  if (hits.length === 0) {
    parts.push("(Žádné relevantní interní dokumenty nenalezeny.)");
  }
  hits.forEach((h) => {
    parts.push(
      `[INTERNÍ | documentId=${h.documentId} | chunkId=${h.chunkId} | title="${h.title}"${
        h.pageNumber ? ` | strana=${h.pageNumber}` : ""
      }${h.sectionTitle ? ` | sekce="${h.sectionTitle}"` : ""}]\n${h.content}`,
    );
  });
  webResults.forEach((w) => {
    parts.push(
      `[WEB | url=${w.url} | domain=${w.domain} | oficiální=${w.isOfficialSource} | typ=${w.sourceType}]\n${w.title}\n${w.snippet}`,
    );
  });
  return parts.join("\n\n");
}

function parseAnswer(
  raw: string,
  sourceMode: SourceMode,
  decision: { locked: boolean; reason: string },
): AiAnswer {
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { answer: raw };
  }
  const warnings: string[] = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  if (decision.locked) {
    warnings.unshift(decision.reason);
  }
  return {
    answer: String(parsed.answer ?? ""),
    imageObservations: Array.isArray(parsed.imageObservations)
      ? parsed.imageObservations
      : [],
    requiredMeasurements: Array.isArray(parsed.requiredMeasurements)
      ? parsed.requiredMeasurements
      : [],
    confidence: ["low", "medium", "high"].includes(parsed.confidence)
      ? parsed.confidence
      : "low",
    hasSufficientSources: Boolean(parsed.hasSufficientSources),
    sourceMode,
    citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    webCitations: Array.isArray(parsed.webCitations) ? parsed.webCitations : [],
    warnings,
  };
}
