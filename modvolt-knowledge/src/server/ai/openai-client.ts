import OpenAI from "openai";
import { env, isOpenAiUsable } from "../env.js";

let client: OpenAI | null = null;

export function getOpenAi(): OpenAI {
  if (!isOpenAiUsable()) {
    throw new Error(
      "OpenAI není dostupné (OPENAI_ENABLED=false nebo chybí OPENAI_API_KEY).",
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: env.openai.apiKey,
      timeout: env.openai.requestTimeoutMs,
    });
  }
  return client;
}
