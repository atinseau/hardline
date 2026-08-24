import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../fixtures/config";
import type { MountPointState } from "../../src/steps/smb-mountpoints";

const NO_PENDING = { pending: [] as string[] };

/** Les points de montage que le disque simule porte deja. */
let presents: Set<string>;
let creationLeve: Error | null;
let retraitLeve: Error | null;

const mountPointExists = mock(async (path: string) => presents.has(path));
const createMountPoints = mock(async (paths: string[]) => {
  if (creationLeve) throw creationLeve;
  for (const path of paths) presents.add(path);
});
const removeMountPoints = mock(async (paths: string[]) => {
  if (retraitLeve) throw retraitLeve;
  for (const path of paths) presents.delete(path);
});
/** Presente au bouchon EXPRES : cette etape ne doit jamais l'appeler. */
const unmountShare = mock(async (..._args: unknown[]) => {});

mock.module("../../src/lib/smb", () => ({
  mountPointExists,
  createMountPoints,
  removeMountPoints,
  unmountShare,
}));

const { smbMountPointsStep } = await import("../../src/steps/smb-mountpoints");

const TOUS = CONFIG.smb.shares.map((s) => s.mountPoint);
const [ARTHUR, PC_D, PC_E] = TOUS as [string, string, string];

beforeEach(() => {
  presents = new Set();
  creationLeve = null;
  retraitLeve = null;
  mountPointExists.mockClear();
  createMountPoints.mockClear();
  removeMountPoints.mockClear();
  unmountShare.mockClear();
});

describe("contrat d'etape", () => {
  test("porte un nom stable et un libelle qui nomme le Mac", () => {
    expect(smbMountPointsStep.name).toBe("smb-mountpoints");
    expect(smbMountPointsStep.label).toContain("(Mac)");
  });

  test("restore accepte les trois parametres du contrat Step", () => {
    expect(smbMountPointsStep.restore.length).toBe(3);
  });
});

describe("inspect", () => {
  test("declare non conforme quand aucun point de montage n'existe", async () => {
    const state = await smbMountPointsStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current).toEqual(TOUS.map((m) => ({ mountPoint: m, existed: false })));
  });

  test("declare conforme quand tous existent deja", async () => {
    presents = new Set(TOUS);
    const state = await smbMountPointsStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("releve exactement lesquels preexistaient, un par un", async () => {
    presents = new Set([PC_D]);
    const state = await smbMountPointsStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.filter((s) => s.existed).map((s) => s.mountPoint)).toEqual([
      PC_D,
    ]);
  });

  test("nomme les manquants dans le detail", async () => {
    presents = new Set([ARTHUR]);
    const state = await smbMountPointsStep.inspect(CONFIG);
    expect(state.detail).toContain(PC_D);
    expect(state.detail).not.toContain(ARTHUR);
  });
});

describe("apply", () => {
  test("cree tous les points de montage manquants", async () => {
    await smbMountPointsStep.apply(CONFIG);

    expect(createMountPoints).toHaveBeenCalledTimes(1);
    expect((createMountPoints.mock.calls[0] as unknown[])[0]).toEqual(TOUS);
    for (const mountPoint of TOUS) {
      expect(presents.has(mountPoint)).toBe(true);
    }
  });

  test("ne recree jamais un point de montage deja present", async () => {
    presents = new Set([ARTHUR, PC_E]);
    await smbMountPointsStep.apply(CONFIG);
    expect((createMountPoints.mock.calls[0] as unknown[])[0]).toEqual([PC_D]);
  });

  test("relit le disque plutot que de se fier au releve d'inspect", async () => {
    // Le manifeste est ecrit AVANT apply : un passage precedent interrompu
    // entre les deux a pu creer une partie des repertoires.
    await smbMountPointsStep.inspect(CONFIG);
    presents = new Set(TOUS);
    await smbMountPointsStep.apply(CONFIG);
    expect((createMountPoints.mock.calls[0] as unknown[])[0]).toEqual([]);
  });

  test("propage l'echec de la creation, sans le traduire en silence", async () => {
    creationLeve = new Error("Operation not permitted");
    await expect(smbMountPointsStep.apply(CONFIG)).rejects.toThrow(
      "Operation not permitted",
    );
  });
});

describe("restore", () => {
  test("retire les points de montage que hardline avait crees", async () => {
    presents = new Set(TOUS);
    const previous: MountPointState[] = TOUS.map((m) => ({
      mountPoint: m,
      existed: false,
    }));

    await smbMountPointsStep.restore(CONFIG, previous, NO_PENDING);

    expect((removeMountPoints.mock.calls[0] as unknown[])[0]).toEqual(TOUS);
    expect(presents.size).toBe(0);
  });

  test("ne retire JAMAIS un point de montage qui preexistait a hardline", async () => {
    // Le coeur de la garantie : un repertoire trouve en place n'est pas le
    // notre, et une restauration qui l'emporterait detruirait le travail de
    // quelqu'un d'autre sans qu'aucun releve ne sache le rendre.
    presents = new Set(TOUS);
    const previous: MountPointState[] = [
      { mountPoint: ARTHUR, existed: true },
      { mountPoint: PC_D, existed: false },
      { mountPoint: PC_E, existed: true },
    ];

    await smbMountPointsStep.restore(CONFIG, previous, NO_PENDING);

    expect((removeMountPoints.mock.calls[0] as unknown[])[0]).toEqual([PC_D]);
    expect(presents.has(ARTHUR)).toBe(true);
    expect(presents.has(PC_E)).toBe(true);
  });

  test("ne retire rien quand tous les points de montage preexistaient", async () => {
    const previous: MountPointState[] = TOUS.map((m) => ({
      mountPoint: m,
      existed: true,
    }));

    await smbMountPointsStep.restore(CONFIG, previous, NO_PENDING);

    expect((removeMountPoints.mock.calls[0] as unknown[])[0]).toEqual([]);
  });

  test("laisse l'echec se dire quand un repertoire refuse de partir", async () => {
    // Un montage qui subsiste, un fichier depose : rien n'est force, et
    // l'orchestrateur conserve alors l'enregistrement au manifeste.
    retraitLeve = new Error("Directory not empty");
    const previous: MountPointState[] = [
      { mountPoint: ARTHUR, existed: false },
    ];

    await expect(
      smbMountPointsStep.restore(CONFIG, previous, NO_PENDING),
    ).rejects.toThrow("Directory not empty");
  });

  test("ne demonte rien lui-meme : smb-shares.restore l'a deja fait", async () => {
    // Le demontage appartient a smb-shares.restore, qui passe AVANT celle-ci
    // (voir le test d'ordre dans test/steps/index.test.ts). unmountShare est
    // offerte par le bouchon : si un demontage en double etait ajoute ici, il
    // l'appellerait, et ce test le verrait.
    presents = new Set(TOUS);
    const previous: MountPointState[] = TOUS.map((m) => ({
      mountPoint: m,
      existed: false,
    }));

    await smbMountPointsStep.restore(CONFIG, previous, NO_PENDING);

    expect(unmountShare).not.toHaveBeenCalled();
  });
});
