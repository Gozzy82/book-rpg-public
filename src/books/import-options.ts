export interface ImportCliOptions {
  filePath: string;
  reanalyze: boolean;
  characters?: string[];
  sourceReview?: string;
}

const usage = 'Usage: npm run import -- path/to/book.epub [--reanalyze] [--character "Name"] [--source-review "result.json"]';

export function parseImportArguments(args: string[]): ImportCliOptions {
  const paths: string[] = [];
  const characters: string[] = [];
  let reanalyze = false;
  let sourceReview: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--reanalyze") { reanalyze = true; continue; }
    if (arg === "--source-review") {
      const value = args[++i];
      if (sourceReview || !value?.trim() || value.startsWith("--")) throw new Error("Specify one --source-review result.json path");
      sourceReview = value;
    } else if (arg === "--character") {
      const name = args[++i];
      if (!name?.trim() || name.startsWith("--")) throw new Error(`${usage}\nMissing character name`);
      characters.push(name.trim());
    } else if (arg.startsWith("--")) throw new Error(`${usage}\nUnknown option: ${arg}`);
    else paths.push(arg);
  }
  if (paths.length !== 1) throw new Error(usage);
  if (reanalyze && sourceReview) throw new Error("--source-review resumes analysis and cannot be combined with --reanalyze");
  return {filePath: paths[0]!, reanalyze, ...(characters.length ? {characters} : {}), ...(sourceReview ? {sourceReview} : {})};
}
