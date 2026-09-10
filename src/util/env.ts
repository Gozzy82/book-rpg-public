import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadDotEnv(file = ".env"): void {
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) return;

  const text = fs.readFileSync(fullPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function defaultDataDir(cwd = process.cwd()): string {
  const dotGit = path.join(cwd, ".git");
  if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isFile()) {
    return path.join(cwd, "data");
  }

  const gitDirMatch = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(dotGit, "utf8"));
  if (!gitDirMatch?.[1]) return path.join(cwd, "data");
  const gitDir = path.resolve(cwd, gitDirMatch[1].trim());
  const commonDirFile = path.join(gitDir, "commondir");
  if (!fs.existsSync(commonDirFile)) return path.join(cwd, "data");

  const commonGitDir = path.resolve(
    gitDir,
    fs.readFileSync(commonDirFile, "utf8").trim(),
  );
  return path.join(path.dirname(commonGitDir), "data");
}

export function dataDir(): string {
  const configuredDataDir = process.env.BOOKRPG_DATA_DIR?.trim();
  return configuredDataDir
    ? path.resolve(configuredDataDir)
    : defaultDataDir();
}

function loadProtectedApiKey(
  environmentVariable: "OPENAI_API_KEY" | "XAI_API_KEY",
  configuredFileVariable:
    | "BOOKRPG_OPENAI_CREDENTIAL_FILE"
    | "BOOKRPG_XAI_CREDENTIAL_FILE",
  defaultFilename: string,
): void {
  if (process.env[environmentVariable]?.trim()) return;
  if (process.platform !== "win32") return;

  const credentialFile = path.resolve(
    process.env[configuredFileVariable]
      || path.join(os.homedir(), defaultFilename),
  );
  if (!fs.existsSync(credentialFile)) return;

  const script = [
    "$credential = Import-Clixml -LiteralPath $env:BOOKRPG_CREDENTIAL_PATH",
    "if ($credential -isnot [System.Management.Automation.PSCredential]) {",
    "  throw 'Credential file must contain a PSCredential'",
    "}",
    "[Console]::Out.Write($credential.GetNetworkCredential().Password)",
  ].join("\n");

  let apiKey: string;
  try {
    apiKey = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, BOOKRPG_CREDENTIAL_PATH: credentialFile },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load ${environmentVariable} credential from ${credentialFile}: ${message}`);
  }

  if (!apiKey.trim()) {
    throw new Error(`${environmentVariable} credential in ${credentialFile} is empty`);
  }
  process.env[environmentVariable] = apiKey;
}

export function loadAiApiKey(): void {
  if (process.env.BOOKRPG_FAKE_AI === "1") return;
  const provider = (process.env.BOOKRPG_AI_PROVIDER || "openai").trim().toLowerCase();
  if (provider === "xai") {
    loadProtectedApiKey(
      "XAI_API_KEY",
      "BOOKRPG_XAI_CREDENTIAL_FILE",
      ".bookrpg-xai-key.clixml",
    );
    return;
  }
  loadProtectedApiKey(
    "OPENAI_API_KEY",
    "BOOKRPG_OPENAI_CREDENTIAL_FILE",
    ".bookrpg-openai-key.clixml",
  );
}


// Load local development settings before repositories/services read them.
loadDotEnv();
