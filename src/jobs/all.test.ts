import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const jobsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(jobsDir, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

// Regression #26: API und Worker müssen dieselben Job-Typen registrieren, sonst
// liefert POST /jobs "Unknown job type". Beide Entry-Points laden nur ./all.js.
describe("job registration", () => {
  const jobFiles = walk(jobsDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => readFileSync(f, "utf8").includes("registerJobType("))
    .map((f) => "./" + relative(jobsDir, f).replace(/\.ts$/, ".js"));

  it("all.ts importiert jede Job-Datei", () => {
    const all = readFileSync(join(jobsDir, "all.ts"), "utf8");
    for (const f of jobFiles) expect(all, f).toContain(`import "${f}"`);
  });

  for (const entry of ["api/index.ts", "worker/index.ts"]) {
    it(`${entry} lädt alle Job-Typen über all.js`, () => {
      expect(readFileSync(join(srcDir, entry), "utf8")).toContain('import "../jobs/all.js"');
    });
  }
});
