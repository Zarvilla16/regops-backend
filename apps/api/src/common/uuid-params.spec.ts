import * as fs from "fs";
import * as path from "path";

function controllerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return controllerFiles(p);
    return e.name.endsWith(".controller.ts") ? [p] : [];
  });
}

/**
 * A malformed id in a URL must come back as 400, not reach Postgres and surface as a 500 (which also pages the error
 * monitor). Every id-style route parameter therefore has to go through ParseUUIDPipe.
 */
describe("controller id parameters", () => {
  const files = controllerFiles(path.resolve(__dirname, ".."));

  it("finds the controllers", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [path.relative(path.resolve(__dirname, ".."), f), f]))("%s validates ids as UUIDs", (_name, file) => {
    const source = fs.readFileSync(file, "utf8");
    const unvalidated = [...source.matchAll(/@Param\("(\w*[iI]d)"\)/g)].map((m) => m[1]);
    expect(unvalidated).toEqual([]);
  });
});
