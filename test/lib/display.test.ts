import { test, expect, describe, mock, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mock.module("bun", ...) ne peut pas intercepter le `import { $ } from "bun"`
// statique de src/lib/display.ts : "bun" est un module natif, pas un module
// utilisateur, et $ y echappe au registre que mock.module patche (verifie
// empiriquement : le $ reel s'execute quoi qu'on mette dans le mock). La
// frontiere simulee est donc le binaire de la sonde lui-meme : un petit
// script shell qu'on ecrit nous-memes, execute reellement en local (aucune
// machine distante, aucun materiel), dont la sortie et le code de retour sont
// pilotes par des fichiers de controle que chaque test recrit avant d'appeler
// listDisplays.
const controlBase = join(tmpdir(), `hardline-display-probe-test-${randomUUID()}`);
const stdoutFile = `${controlBase}.stdout`;
const stderrFile = `${controlBase}.stderr`;
const exitFile = `${controlBase}.exit`;
const dispatcherPath = join(tmpdir(), `hardline-display-probe-dispatcher-${randomUUID()}`);

const dispatcherScript = `#!/bin/sh
cat "${stdoutFile}"
cat "${stderrFile}" 1>&2
exit "$(cat "${exitFile}")"
`;

await Bun.write(dispatcherPath, dispatcherScript);
await Bun.write(exitFile, "0");
await Bun.write(stdoutFile, "");
await Bun.write(stderrFile, "");
await Bun.$`chmod +x ${dispatcherPath}`.quiet();

async function setProbeOutcome(outcome: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}): Promise<void> {
  await Bun.write(exitFile, String(outcome.exitCode));
  await Bun.write(stdoutFile, outcome.stdout ?? "");
  await Bun.write(stderrFile, outcome.stderr ?? "");
}

afterAll(async () => {
  await Bun.$`rm -f ${dispatcherPath} ${stdoutFile} ${stderrFile} ${exitFile}`
    .quiet()
    .nothrow();
});

// Le module ne depend jamais de src/assets/display-probe.bin lui-meme : il
// pointe vers le script ci-dessus, donc le test ne depend pas non plus de
// `bun run build`.
mock.module("../../src/assets/display-probe.bin", () => ({
  default: dispatcherPath,
}));

const { parseDisplays, mainDisplay, colorProfileIssue, listDisplays, DisplayProbeError } =
  await import("../../src/lib/display");

const TWO_SCREENS =
  "3456\t2234\t120.0\t1728\t1117\t1\tColor LCD\t1\n" +
  "2560\t1440\t144.0\t2560\t1440\t0\tASUS PG329\t1\n";

const NO_MAIN_FLAGGED =
  "3456\t2234\t120.0\t1728\t1117\t0\tColor LCD\t1\n" +
  "2560\t1440\t144.0\t2560\t1440\t0\tASUS PG329\t1\n";

describe("parseDisplays", () => {
  test("lit les deux écrans de la machine de référence", () => {
    expect(parseDisplays(TWO_SCREENS)).toEqual([
      {
        widthPx: 3456,
        heightPx: 2234,
        refreshHz: 120.0,
        widthPt: 1728,
        heightPt: 1117,
        main: true,
        colorProfile: "Color LCD",
        colorProfileValid: true,
      },
      {
        widthPx: 2560,
        heightPx: 1440,
        refreshHz: 144.0,
        widthPt: 2560,
        heightPt: 1440,
        main: false,
        colorProfile: "ASUS PG329",
        colorProfileValid: true,
      },
    ]);
  });

  test("rend un tableau vide sur une sortie vide", () => {
    expect(parseDisplays("")).toEqual([]);
  });

  test("ignore une ligne à qui il manque un champ, sans lever", () => {
    const malformed =
      "3456\t2234\t120.0\t1728\t1117\t1\n" +
      "2560\t1440\t144.0\t2560\t1440\t0\tASUS PG329\t1\n";
    expect(parseDisplays(malformed)).toEqual([
      {
        widthPx: 2560,
        heightPx: 1440,
        refreshHz: 144.0,
        widthPt: 2560,
        heightPt: 1440,
        main: false,
        colorProfile: "ASUS PG329",
        colorProfileValid: true,
      },
    ]);
  });

  test("distingue 0 et 1 pour le drapeau principal", () => {
    const [first, second] = parseDisplays(TWO_SCREENS);
    expect(first?.main).toBe(true);
    expect(second?.main).toBe(false);
  });
});

describe("mainDisplay", () => {
  test("rend l'écran marqué principal", () => {
    const displays = parseDisplays(TWO_SCREENS);
    expect(mainDisplay(displays)?.widthPx).toBe(3456);
  });

  test("rend le premier écran si aucun n'est marqué principal", () => {
    const displays = parseDisplays(NO_MAIN_FLAGGED);
    expect(mainDisplay(displays)?.widthPx).toBe(3456);
  });

  test("rend null pour un tableau vide", () => {
    expect(mainDisplay([])).toBeNull();
  });
});

describe("colorProfileIssue", () => {
  test("valide le profil RGB de l'ecran choisi", () => {
    expect(colorProfileIssue(parseDisplays(TWO_SCREENS)[1]!)).toBeNull();
  });

  test("signale un profil absent", () => {
    const display = parseDisplays(TWO_SCREENS)[1]!;
    expect(colorProfileIssue({ ...display, colorProfile: null })).toMatch(/no active color profile/i);
  });

  test("signale un profil qui n'est pas un profil RGB d'ecran", () => {
    const display = parseDisplays(TWO_SCREENS)[1]!;
    expect(colorProfileIssue({ ...display, colorProfileValid: false })).toContain("unsuitable");
  });
});

describe("listDisplays", () => {
  test("sonde en échec (code de sortie non nul) lève, avec le stderr repris dans le message", async () => {
    await setProbeOutcome({
      exitCode: 1,
      stderr: "display-probe: CGGetActiveDisplayList a echoue\n",
    });

    await expect(listDisplays()).rejects.toThrow(DisplayProbeError);
    await expect(listDisplays()).rejects.toThrow(/Display probe failed with exit code 1/);
  });

  test("sonde en succès avec sortie vide rend un tableau vide, sans lever", async () => {
    await setProbeOutcome({ exitCode: 0, stdout: "" });

    await expect(listDisplays()).resolves.toEqual([]);
  });
});
