import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Storage-Seam (ADR-0004): heute Shared Volume, später ggf. Objekt-Storage.
// Alle Dateizugriffe laufen über dieses Interface — nie direkt über fs.
export interface Storage {
  write(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /** Löscht Dateien älter als ageMs; gibt Anzahl gelöschter Dateien zurück. */
  purgeOlderThan(ageMs: number): Promise<number>;
}

export function createVolumeStorage(baseDir: string): Storage {
  const resolve = (key: string) => {
    const path = join(baseDir, key);
    if (!path.startsWith(baseDir)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path;
  };
  return {
    async write(key, data) {
      const path = resolve(key);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, data);
    },
    async read(key) {
      return readFile(resolve(key));
    },
    async remove(key) {
      await rm(resolve(key), { force: true });
    },
    async purgeOlderThan(ageMs) {
      const cutoff = Date.now() - ageMs;
      let removed = 0;
      const entries = await readdir(baseDir).catch(() => [] as string[]);
      for (const entry of entries) {
        const path = join(baseDir, entry);
        const info = await stat(path).catch(() => null);
        if (info?.isFile() && info.mtimeMs < cutoff) {
          await rm(path, { force: true });
          removed++;
        }
      }
      return removed;
    },
  };
}
