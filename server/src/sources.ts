import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CorpusConfig, RepoConfig, Visibility } from "./config.js";

export interface SourceFile {
  id: string;
  repo: string;
  /** Caminho relativo ao repositório, com barras normais. */
  path: string;
  absPath: string;
  section: string;
  subject: string;
  course: string | null;
  visibility: Visibility;
  format: "pdf" | "md" | "txt";
}

export interface RepoInfo {
  name: string;
  visibility: Visibility;
  subject: string;
  course: string | null;
  found: boolean;
  /** Entrou por `discover`, não por uma entrada em `repos`. */
  discovered: boolean;
}

/** Converte um glob simples (`**`, `*`) em RegExp sobre caminhos com barras normais. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else {
      re += /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv", "venv"]);

/**
 * Pasta fixa de cada glob (`content/**` → `content`, `README.md` → `README.md`). A busca começa
 * nelas: os repositórios de disciplina têm `.venv` com dezenas de milhares de arquivos fora de `content/`.
 */
export function globRoots(globs: string[]): string[] {
  const roots = globs.map((g) => {
    const parts = g.split("/");
    const wild = parts.findIndex((p) => p.includes("*"));
    return (wild === -1 ? parts : parts.slice(0, wild)).join("/");
  });
  // "" (glob que começa com curinga) cobre o repositório inteiro; raízes dentro de outras são redundantes.
  if (roots.includes("")) return [""];
  return [...new Set(roots)].filter((r, _, all) => !all.some((o) => o !== r && r.toLowerCase().startsWith(`${o.toLowerCase()}/`)));
}

function walkFrom(repoDir: string, roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const abs = path.join(repoDir, root);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, repoDir));
    else out.push(root);
  }
  return out;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".git") && entry.isDirectory()) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

function readSubject(repoDir: string, repo: RepoConfig): { subject: string; course: string | null } {
  const file = path.join(repoDir, "config", "subject.json");
  if (repo.kind !== "ecossistema" && existsSync(file)) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as { subject_name?: string; course_name?: string };
      if (json.subject_name) return { subject: json.subject_name, course: json.course_name ?? null };
    } catch {
      // subject.json malformado: cai no nome do repositório
    }
  }
  return { subject: repo.kind === "ecossistema" ? "Ecossistema UÉFIabecê" : repo.name, course: null };
}

/**
 * Repositórios declarados em `repos` mais as pastas de `uefiRoot` que casam `discover`.
 * Descobertos são sempre `privado`: tornar um repositório público exige declará-lo, porque
 * público × privado é uma fronteira de direitos autorais e não pode depender de um padrão de nome.
 */
export function resolveRepos(config: Pick<CorpusConfig, "repos" | "discover">, dirNames: string[]): (RepoConfig & { discovered: boolean })[] {
  const declared = new Set(config.repos.map((r) => r.name.toLowerCase()));
  const patterns = (config.discover ?? []).map(globToRegExp);
  const discovered = dirNames
    .filter((name) => !declared.has(name.toLowerCase()) && patterns.some((re) => re.test(name)))
    .sort()
    .map((name) => ({ name, visibility: "privado" as const, discovered: true }));
  return [...config.repos.map((r) => ({ ...r, discovered: false })), ...discovered];
}

function listDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function discoverSources(config: CorpusConfig): { repos: RepoInfo[]; files: SourceFile[] } {
  const exclude = config.exclude.map(globToRegExp);
  const repos: RepoInfo[] = [];
  const files: SourceFile[] = [];

  for (const repo of resolveRepos(config, config.discover?.length ? listDirs(config.uefiRoot) : [])) {
    const repoDir = path.join(config.uefiRoot, repo.name);
    if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
      repos.push({ name: repo.name, visibility: repo.visibility, subject: repo.name, course: null, found: false, discovered: repo.discovered });
      continue;
    }
    const { subject, course } = readSubject(repoDir, repo);
    repos.push({ name: repo.name, visibility: repo.visibility, subject, course, found: true, discovered: repo.discovered });

    const globs = repo.include ?? ["content/**"];
    const include = globs.map(globToRegExp);
    for (const rel of walkFrom(repoDir, globRoots(globs))) {
      const ext = path.extname(rel).toLowerCase();
      if (!config.extensions.includes(ext)) continue;
      if (!include.some((re) => re.test(rel))) continue;
      if (exclude.some((re) => re.test(rel))) continue;
      const parts = rel.split("/");
      const section =
        repo.kind === "ecossistema" ? "ecossistema" : parts[0] === "content" && parts.length > 2 ? parts[1]! : "outros";
      files.push({
        id: `${repo.name}/${rel}`,
        repo: repo.name,
        path: rel,
        absPath: path.join(repoDir, rel),
        section,
        subject,
        course,
        visibility: repo.visibility,
        format: ext.slice(1) as SourceFile["format"],
      });
    }
  }
  return { repos, files };
}
