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

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".git") && entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
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

export function discoverSources(config: CorpusConfig): { repos: RepoInfo[]; files: SourceFile[] } {
  const exclude = config.exclude.map(globToRegExp);
  const repos: RepoInfo[] = [];
  const files: SourceFile[] = [];

  for (const repo of config.repos) {
    const repoDir = path.join(config.uefiRoot, repo.name);
    if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
      repos.push({ name: repo.name, visibility: repo.visibility, subject: repo.name, course: null, found: false });
      continue;
    }
    const { subject, course } = readSubject(repoDir, repo);
    repos.push({ name: repo.name, visibility: repo.visibility, subject, course, found: true });

    const include = (repo.include ?? ["content/**"]).map(globToRegExp);
    for (const rel of walk(repoDir)) {
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
