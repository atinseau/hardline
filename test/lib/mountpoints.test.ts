import { test, expect, describe } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../fixtures/config";
import { createMountPoints, removeMountPoints } from "../../src/lib/smb";

/**
 * Fichier separe de smb.test.ts, qui simule node:fs/promises : ces cas-ci
 * touchent le VRAI disque, puisque c'est justement le privilege necessaire
 * pour y ecrire qui est en cause.
 *
 * Les points de montage vivaient sous /Volumes : root:wheel en drwxr-xr-x, et
 * surtout macOS y efface les repertoires vides (diskarbitrationd, au
 * demontage comme au redemarrage). Ceux que l'installation creait
 * disparaissaient donc a la premiere fermeture de session, et `up` echouait
 * ensuite en EACCES sans pouvoir les recreer.
 */
describe("points de montage sans privilège", () => {
  test("createMountPoints crée les répertoires manquants, sans élévation", async () => {
    const base = await mkdtemp(join(tmpdir(), "hardline-mp-"));
    const cible = join(base, "PC", "d");

    await createMountPoints([cible]);

    expect((await stat(cible)).isDirectory()).toBe(true);
  });

  test("removeMountPoints retire ce qui a été créé", async () => {
    const base = await mkdtemp(join(tmpdir(), "hardline-mp-"));
    const cible = join(base, "PC", "e");

    await createMountPoints([cible]);
    await removeMountPoints([cible]);

    await expect(stat(cible)).rejects.toThrow();
  });

  test("un répertoire déjà présent ne fait pas échouer la création", async () => {
    const base = await mkdtemp(join(tmpdir(), "hardline-mp-"));
    const cible = join(base, "PC", "arthur");

    await createMountPoints([cible]);
    await createMountPoints([cible]);

    expect((await stat(cible)).isDirectory()).toBe(true);
  });

  test("les points de montage configurés sont sous le dossier personnel", () => {
    for (const share of CONFIG.smb.shares) {
      expect(share.mountPoint.startsWith(homedir())).toBe(true);
      expect(share.mountPoint.startsWith("/Volumes")).toBe(false);
    }
  });
});

/**
 * Les anciens points sous /Volumes figurent encore au manifeste des
 * installations existantes, et macOS les a effaces : une desinstallation
 * buterait dessus alors qu'il n'y a plus rien a rendre.
 */
test("un point de montage déjà disparu ne fait pas échouer la restauration", async () => {
  const base = await mkdtemp(join(tmpdir(), "hardline-mp-"));
  await expect(removeMountPoints([join(base, "jamais-cree")])).resolves.toBeUndefined();
});

test("un répertoire non vide fait bien échouer la restauration", async () => {
  const { writeFile } = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "hardline-mp-"));
  const cible = join(base, "PC", "plein");
  await createMountPoints([cible]);
  await writeFile(join(cible, "fichier.txt"), "contenu");

  await expect(removeMountPoints([cible])).rejects.toThrow();
});
