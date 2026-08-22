import { test, expect, mock } from "bun:test";

const calls: string[] = [];

mock.module("node:fs/promises", () => ({
  mkdir: async () => undefined,
  writeFile: async (path: string) => {
    calls.push(`writeFile:${path}`);
  },
  rename: async (from: string, to: string) => {
    calls.push(`rename:${from} -> ${to}`);
  },
}));

const { writeManifest, emptyManifest } = await import("../../src/lib/manifest");

const TARGET = "/tmp/hardline-atomicity/manifest.json";

test("l'ecriture passe par un fichier temporaire puis un rename", async () => {
  calls.length = 0;
  await writeManifest(TARGET, emptyManifest("2026-08-22T10:00:00.000Z"));

  expect(calls).toHaveLength(2);
  const [written, renamed] = calls;

  // Le contenu n'est jamais ecrit directement sur le chemin final : c'est ce
  // qui garantit qu'une interruption ne laisse pas un manifeste tronque.
  expect(written).not.toBe(`writeFile:${TARGET}`);
  expect(written).toContain(`writeFile:${TARGET}.`);
  expect(written).toContain(".tmp");

  // Et c'est le rename, atomique sur un meme volume, qui publie le fichier.
  expect(renamed).toContain(`-> ${TARGET}`);
});

test("le fichier temporaire est distinct du fichier final", async () => {
  calls.length = 0;
  await writeManifest(TARGET, emptyManifest("2026-08-22T10:00:00.000Z"));

  const source = calls[1]?.split(" -> ")[0]?.replace("rename:", "");
  expect(source).not.toBe(TARGET);
  expect(source?.startsWith(TARGET)).toBe(true);
});
