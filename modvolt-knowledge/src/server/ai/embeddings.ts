import { getOpenAi } from "./openai-client.js";
import { env, isOpenAiUsable } from "../env.js";

export function embeddingsAvailable(): boolean {
  return isOpenAiUsable();
}

/** Vytvoří embeddingy pro dávku textů. */
export async function createEmbeddings(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getOpenAi().embeddings.create({
    model: env.openai.embeddingModel,
    input: texts,
  });
  return res.data.map((d) => d.embedding as number[]);
}

export async function createEmbedding(text: string): Promise<number[]> {
  const [vec] = await createEmbeddings([text]);
  return vec;
}

/** Převod number[] na pgvector literál: "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
