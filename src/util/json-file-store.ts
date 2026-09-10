import fs from "node:fs/promises";
import path from "node:path";

export class JsonFileStore<T extends object> {
  constructor(private readonly directory: string) {}

  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid store id");
    return path.join(this.directory, `${id}.json`);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
  }

  async put(id: string, value: T): Promise<void> {
    await this.ensure();
    const filename = this.file(id);
    const temp = `${filename}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temp, filename);
  }

  async get(id: string): Promise<T | undefined> {
    try {
      const text = await fs.readFile(this.file(id), "utf8");
      return JSON.parse(text) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<T[]> {
    await this.ensure();
    const names = (await fs.readdir(this.directory)).filter((name) => name.endsWith(".json"));
    const values = await Promise.all(names.map(async (name) => {
      const text = await fs.readFile(path.join(this.directory, name), "utf8");
      return JSON.parse(text) as T;
    }));
    return values;
  }
}
