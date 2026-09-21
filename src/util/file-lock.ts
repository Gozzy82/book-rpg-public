import fs from 'node:fs/promises';
import path from 'node:path';
/** Cross-process local-store exclusion; crash recovery uses the owning PID. */
export async function withFileLock<T>(filename: string, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filename), {recursive: true});
  const start = Date.now();
  let handle;
  while (!handle) {
    try { handle = await fs.open(filename, 'wx'); await handle.writeFile(String(process.pid)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(await fs.readFile(filename, 'utf8'));
        const stat = await fs.stat(filename);
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(filename); continue; } }
        } else if (Date.now() - stat.mtimeMs > 120_000) { await fs.unlink(filename); continue; }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      if (Date.now() - start > 10_000) throw new Error('Game storage is busy; please retry');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await run(); } finally { await handle.close(); await fs.unlink(filename); }
}
