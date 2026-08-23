import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type { ShareState } from "../../src/steps/smb-shares";

let remoteState: ShareState[];
/** Journal d'appels partage : c'est l'ORDRE qui porte la garantie du demontage. */
const order: string[] = [];

const runRemoteJson = mock(async (..._args: unknown[]) => remoteState);
const runRemoteChecked = mock(async (..._args: unknown[]) => {
  order.push("runRemoteChecked");
  return { exitCode: 0, stdout: "", stderr: "" };
});

mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const unmountShare = mock(async (share: { name: string }) => {
  order.push(`unmount:${share.name}`);
});
mock.module("../../src/lib/smb", () => ({ unmountShare }));

const { smbSharesStep } = await import("../../src/steps/smb-shares");

function scriptOf(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

beforeEach(() => {
  order.length = 0;
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
  unmountShare.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand D: et E: existent deja", async () => {
    remoteState = [
      { name: "hardline-d", existed: true },
      { name: "hardline-e", existed: true },
    ];
    const state = await smbSharesStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("declare non conforme quand un partage manque", async () => {
    remoteState = [
      { name: "hardline-d", existed: false },
      { name: "hardline-e", existed: true },
    ];
    const state = await smbSharesStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current).toEqual([
      { name: "hardline-d", existed: false },
      { name: "hardline-e", existed: true },
    ]);
  });

  test("n'interroge jamais le partage arthur, qui preexiste", async () => {
    remoteState = [
      { name: "hardline-d", existed: false },
      { name: "hardline-e", existed: false },
    ];
    await smbSharesStep.inspect(CONFIG);
    const script = String((runRemoteJson.mock.calls[0] as unknown[])[1]);
    expect(script).not.toContain("'arthur'");
    expect(script).toContain("'hardline-d'");
    expect(script).toContain("'hardline-e'");
  });
});

describe("apply", () => {
  test("cree les partages manquants, avec l'acces complet au compte configure", async () => {
    await smbSharesStep.apply(CONFIG);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    const script = scriptOf(0);
    expect(script).toContain("New-SmbShare");
    expect(script).toContain("-Path 'D:\\'");
    expect(script).toContain("-Path 'E:\\'");
    expect(script).toContain("-FullAccess 'arthur'");
  });

  test("garde une garde d'existence avant de creer, pour rester idempotent", async () => {
    await smbSharesStep.apply(CONFIG);
    const script = scriptOf(0);
    expect(script).toContain("Get-SmbShare -Name 'hardline-d'");
    expect(script).toContain("if (-not $s)");
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    await expect(smbSharesStep.apply(CONFIG)).rejects.toThrow("acces refuse");
  });
});

describe("restore", () => {
  const NO_PENDING = { pending: [] as string[] };

  test("ne retire que les partages que l'etape avait crees", async () => {
    await smbSharesStep.restore(
      CONFIG,
      [
        { name: "hardline-d", existed: false },
        { name: "hardline-e", existed: true },
      ],
      NO_PENDING,
    );
    const script = scriptOf(0);
    expect(script).toContain("Remove-SmbShare -Name 'hardline-d'");
    expect(script).not.toContain("hardline-e");
  });

  test("ne touche a rien quand tous les partages geres preexistaient", async () => {
    await smbSharesStep.restore(
      CONFIG,
      [
        { name: "hardline-d", existed: true },
        { name: "hardline-e", existed: true },
      ],
      NO_PENDING,
    );
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("retire les deux partages quand aucun n'existait avant", async () => {
    // Le cas ou tout le releve porte existed: false : restore doit rendre
    // exactement cet etat, c'est-a-dire ne rien laisser en place.
    await smbSharesStep.restore(
      CONFIG,
      [
        { name: "hardline-d", existed: false },
        { name: "hardline-e", existed: false },
      ],
      NO_PENDING,
    );
    const script = scriptOf(0);
    expect(script).toContain("Remove-SmbShare -Name 'hardline-d'");
    expect(script).toContain("Remove-SmbShare -Name 'hardline-e'");
  });

  test("ne mentionne jamais arthur, absent du releve gere par cette etape", async () => {
    await smbSharesStep.restore(
      CONFIG,
      [{ name: "hardline-d", existed: false }],
      NO_PENDING,
    );
    expect(scriptOf(0)).not.toContain("arthur");
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    await expect(
      smbSharesStep.restore(
        CONFIG,
        [{ name: "hardline-d", existed: false }],
        NO_PENDING,
      ),
    ).rejects.toThrow("acces refuse");
  });

  test("demonte cote Mac AVANT de retirer les partages cote PC", async () => {
    // Un montage dont le serveur vient de disparaitre est le Finder fige que
    // le projet promet d'eviter : l'ordre est la garantie, pas le geste.
    await smbSharesStep.restore(
      CONFIG,
      [
        { name: "hardline-d", existed: false },
        { name: "hardline-e", existed: false },
      ],
      NO_PENDING,
    );

    expect(order).toEqual([
      "unmount:arthur",
      "unmount:hardline-d",
      "unmount:hardline-e",
      "runRemoteChecked",
    ]);
  });

  test("demonte tous les partages configures, y compris celui qu'elle n'a pas cree", async () => {
    // Une session tuee peut avoir laisse n'importe lequel monte, « arthur »
    // compris : le releve de cette etape ne dit rien des montages du Mac.
    await smbSharesStep.restore(
      CONFIG,
      [
        { name: "hardline-d", existed: true },
        { name: "hardline-e", existed: true },
      ],
      NO_PENDING,
    );

    expect(order).toEqual([
      "unmount:arthur",
      "unmount:hardline-d",
      "unmount:hardline-e",
    ]);
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });
});
