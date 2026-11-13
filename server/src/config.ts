import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export type Visibility = "publico" | "privado";

export interface RepoConfig {
  name: string;
  visibility: Visibility;
  kind?: "disciplina" | "ecossistema";
  include?: string[];
}

export interface CorpusConfig {
  uefiRoot: string;
  repos: RepoConfig[];
  extensions: string[];
  exclude: string[];
  maxPdfPages: number;
}

export function loadCorpusConfig(): CorpusConfig {
  const raw = JSON.parse(readFileSync(path.join(ROOT, "corpus.config.json"), "utf8")) as CorpusConfig;
  const root = process.env.UEFI_ROOT ?? raw.uefiRoot;
  return { ...raw, uefiRoot: path.resolve(ROOT, root) };
}

export const settings = {
  databaseUrl: process.env.DATABASE_URL,
  pgliteDir: path.join(ROOT, "data", "pglite"),
  embed: {
    provider: (process.env.EMBED_PROVIDER ?? "ollama") as "ollama" | "openai",
    model: process.env.EMBED_MODEL ?? "bge-m3",
  },
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as "anthropic" | "openai" | "ollama",
    model: process.env.LLM_MODEL,
  },
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  port: Number(process.env.PORT ?? 8787),
  publicOnly: process.env.PUBLIC_ONLY === "1",
};
