export interface ImportCliOptions {
  filePath: string;
  reanalyze: boolean;
}

const usage = "Usage: npm run import -- path/to/book.epub [--reanalyze]";

export function parseImportArguments(args: string[]): ImportCliOptions {
  const unknownOptions = args.filter(
    (argument) => argument.startsWith("--") && argument !== "--reanalyze",
  );
  if (unknownOptions.length > 0) {
    throw new Error(`${usage}\nUnknown option: ${unknownOptions[0]}`);
  }

  const filePaths = args.filter((argument) => !argument.startsWith("--"));
  if (filePaths.length !== 1) {
    throw new Error(usage);
  }

  return {
    filePath: filePaths[0]!,
    reanalyze: args.includes("--reanalyze"),
  };
}
