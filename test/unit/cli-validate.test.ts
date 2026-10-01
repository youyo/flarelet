import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidate } from "../../src/cli/validate.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flareon-unit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
  };
};

describe("runValidate", () => {
  it("returns 0 and a summary for a valid file", async () => {
    const f = join(dir, "flareon.yaml");
    await writeFile(
      f,
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp: true\nstorage: { files: {} }\n",
    );
    const c = capture();
    expect(await runValidate(f, c.io)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("flareon.yaml is valid");
    expect(text).toMatch(/http\s+.*authenticated/i);
    expect(text).toContain("storage.files");
    expect(c.err).toEqual([]);
  });

  it("describes public http", async () => {
    const f = join(dir, "flareon.yaml");
    await writeFile(
      f,
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp: { auth: false }\n",
    );
    const c = capture();
    await runValidate(f, c.io);
    expect(c.out.join("\n")).toMatch(/public/i);
  });

  it("returns 1 with issues on stderr for an invalid file", async () => {
    const f = join(dir, "flareon.yaml");
    await writeFile(f, "version: 1\nname: X\nruntime: { language: python }\n");
    const c = capture();
    expect(await runValidate(f, c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("name:");
    expect(c.out).toEqual([]);
  });

  it("returns 1 when the file is missing", async () => {
    const c = capture();
    expect(await runValidate(join(dir, "flareon.yaml"), c.io)).toBe(1);
    expect(c.err.join("\n")).toMatch(/not found/);
  });
});
