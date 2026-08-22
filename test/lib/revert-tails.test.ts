import { test, expect, describe, beforeEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../../src/config";
import type { Manifest } from "../../src/lib/manifest";

/**
 * L'invariant de cette suite : **une seule queue detachee coupante par
 * desinstallation, et elle appartient a la derniere restauration qui passe.**
 *
 * `revertSteps` enchaine les `restore` sans rien attendre. Une etape qui
 * delegue a un `Start-Process` rend la main avant que sa charge n'ait agi ;
 * celle-ci dort deux secondes puis retire l'adresse et repose le profil. Si une
 * autre etape doit encore ouvrir une session SSH — connexion plus demarrage de
 * powershell, souvent plus de deux secondes a froid — les deux comptes a
 * rebours se recouvrent et la seconde session meurt au milieu de son travail :
 * PC injoignable, adressage d'origine jamais repose.
 *
 * Les tests ci-dessous n'observent pas les etapes une a une mais l'ENCHAINEMENT
 * reel : ils comptent les queues emises sur une desinstallation entiere.
 */

const remoteScripts: string[] = [];

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => [],
  runRemoteChecked: async (_target: unknown, script: string) => {
    remoteScripts.push(script);
    return { exitCode: 0, stdout: "", stderr: "" };
  },
}));

mock.module("../../src/lib/shell", () => ({
  getServiceInfo: async () => ({ mode: "dhcp", ip: null, subnetMask: null, router: null }),
  setServiceManualIP: async () => 0,
  setServiceDHCP: async () => 0,
  setServiceIPv4Off: async () => 0,
}));

const { revertSteps } = await import("../../src/lib/orchestrator");
const { readManifest, writeManifest } = await import("../../src/lib/manifest");
const { ALL_STEPS } = await import("../../src/steps");

const CAPTURE = {
  version: 1,
  capturedAt: "2026-08-22T09:00:00",
  interfaceAlias: "Ethernet",
  capability: { name: "OpenSSH.Server", state: "NotPresent", changed: true },
  sshd: {
    present: false,
    startupType: null,
    status: null,
    startupChanged: true,
    statusChanged: true,
  },
  firewall: { name: "hardline-sshd", existed: false, changed: true },
  authorizedKeys: {
    path: "C:\\ProgramData\\ssh\\administrators_authorized_keys",
    publicKey: "ssh-ed25519 AAAA arthur@mac",
    fileExisted: false,
    keyPresent: false,
    aclSddl: null,
    changed: true,
    aclChanged: false,
  },
  network: {
    addresses: ["192.168.1.50/24"],
    manualAddresses: ["192.168.1.50/24"],
    dhcp: "Disabled",
    category: "Public",
    addressingChanged: true,
    categoryChanged: true,
  },
};

/** L'etat anterieur qu'enregistre network-windows : celui d'APRES amorcage. */
const RESEAU_APRES_AMORCAGE = {
  adapterPresent: true,
  adapterStatus: "Up",
  addresses: ["10.10.10.1/24"],
  manualAddresses: ["10.10.10.1/24"],
  dhcpEnabled: false,
  category: "Public",
};

const PREVIOUS: Record<string, unknown> = {
  "network-mac": { mode: "dhcp", ip: null, subnetMask: null, router: null },
  "bootstrap-windows": { capture: CAPTURE, acknowledged: true },
  "network-windows": RESEAU_APRES_AMORCAGE,
  "network-profile-task": { present: false, state: null },
};

/** Ce que la desinstallation a DIT, par opposition a ce qu'elle a envoye. */
const rapports: string[] = [];

const reporter = {
  skipped: () => {},
  applied: () => {},
  restored: ({ label }: { label: string }) => rapports.push(`restauré:${label}`),
  yielded: ({ label }: { label: string }) => rapports.push(`cédé:${label}`),
  detached: ({ label }: { label: string }) => rapports.push(`lancé:${label}`),
  failed: ({ label }: { label: string }) => rapports.push(`échec:${label}`),
};

const RESEAU_PC = "Adresse fixe et profil privé sur le lien direct (PC)";

function manifestOf(order: string[]): Manifest {
  const now = "2026-08-22T10:00:00.000Z";
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    order,
    steps: Object.fromEntries(
      order.map((n) => [n, { step: n, appliedAt: now, previous: PREVIOUS[n] }]),
    ),
  };
}

async function revertWith(
  order: string[],
  steps: typeof ALL_STEPS = ALL_STEPS,
): Promise<{ scripts: string[]; unrestored: string[]; unconfirmed: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "hardline-tails-"));
  const path = join(dir, "manifest.json");
  try {
    await writeManifest(path, manifestOf(order));
    const { unrestored, unconfirmed } = await revertSteps(
      steps,
      CONFIG,
      path,
      reporter,
    );
    return { scripts: [...remoteScripts], unrestored, unconfirmed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function revert(order: string[]): Promise<string[]> {
  const { scripts, unrestored } = await revertWith(order);
  expect(unrestored).toEqual([]);
  return scripts;
}

const withTail = (scripts: string[]): string[] =>
  scripts.filter((s) => s.includes("Start-Process powershell"));

beforeEach(() => {
  remoteScripts.length = 0;
  rapports.length = 0;
});

describe("ceder n'est pas restaurer", () => {
  test("l'etape reseau se declare cedante quand l'amorcage suit", async () => {
    await revert(["bootstrap-windows", "network-windows"]);
    expect(rapports).toContain(`cédé:${RESEAU_PC}`);
    expect(rapports).not.toContain(`restauré:${RESEAU_PC}`);
  });

  test("elle se declare restauree quand la queue lui appartient", async () => {
    // Le controle : sans lui, une etape declarant toujours "cede"
    // satisferait aussi le test precedent.
    await revert(["network-windows", "network-profile-task"]);
    expect(rapports).toContain(`restauré:${RESEAU_PC}`);
    expect(rapports).not.toContain(`cédé:${RESEAU_PC}`);
  });

  test("elle ne cede rien a une etape que cette version ignore", async () => {
    // Le manifeste nomme l'amorcage, le registre ne le connait plus : ceder ici
    // serait ceder a personne. Zero script, zero queue, PC intact, et le
    // manifeste debarrasse de l'etape qui aurait du agir.
    const amputé = ALL_STEPS.filter((s) => s.name !== "bootstrap-windows");
    const { scripts, unrestored } = await revertWith(
      ["bootstrap-windows", "network-windows"],
      amputé,
    );

    expect(unrestored).toEqual(["bootstrap-windows"]);
    expect(withTail(scripts)).toHaveLength(1);
    expect(rapports).toContain(`restauré:${RESEAU_PC}`);
    expect(rapports).not.toContain(`cédé:${RESEAU_PC}`);
  });
});

describe("lancer n'est pas restaurer", () => {
  test("l'amorcage se declare lance, jamais restaure", async () => {
    // Sa queue part toujours detachee : elle rend la main avant d'avoir agi, et
    // ce qu'elle fait ensuite coupe le seul canal qui permettrait de le voir.
    const { unrestored, unconfirmed } = await revertWith([
      "network-mac",
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
    ]);

    expect(unrestored).toEqual([]);
    expect(unconfirmed).toEqual(["bootstrap-windows"]);
    expect(rapports).toContain(
      "lancé:Amorçage du PC\u00a0: OpenSSH, pare-feu, clé et adressage (PC)",
    );
    expect(rapports).not.toContain(
      "restauré:Amorçage du PC\u00a0: OpenSSH, pare-feu, clé et adressage (PC)",
    );
    // Et le Mac, lui, est bel et bien restaure : la distinction porte sur ce
    // qui est observable, pas sur l'etape.
    expect(rapports).toContain("restauré:Adresse fixe sur le lien direct (Mac)");
  });

  test("l'enregistrement de ce qui n'est pas confirme reste au manifeste", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-tails-"));
    const path = join(dir, "manifest.json");
    try {
      await writeManifest(path, manifestOf(["network-mac", "bootstrap-windows"]));
      await revertSteps(ALL_STEPS, CONFIG, path, reporter);

      const manifest = await readManifest(path);
      expect(manifest.order).toEqual(["bootstrap-windows"]);
      expect(manifest.steps["bootstrap-windows"]?.previous).toEqual(
        PREVIOUS["bootstrap-windows"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("une charge que le second saut ne saurait pas transmettre", () => {
  test("est un ECHEC, rien n'est envoye, et l'enregistrement reste", async () => {
    // Un guillemet dans la cle publique relevee traverse psQuote sans encombre
    // et casserait la ligne de commande du processus detache. Refuser est sur
    // precisement parce que l'enregistrement est conserve : rien n'est perdu,
    // et une version ulterieure ou un nouvel essai pourra encore s'en servir.
    const abimee = {
      ...CAPTURE,
      authorizedKeys: {
        ...CAPTURE.authorizedKeys,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 "arthur@mac"',
      },
    };
    const now = "2026-08-22T10:00:00.000Z";
    const dir = await mkdtemp(join(tmpdir(), "hardline-tails-"));
    const path = join(dir, "manifest.json");
    try {
      await writeManifest(path, {
        version: 1,
        createdAt: now,
        updatedAt: now,
        order: ["bootstrap-windows"],
        steps: {
          "bootstrap-windows": {
            step: "bootstrap-windows",
            appliedAt: now,
            previous: { capture: abimee, acknowledged: true },
          },
        },
      });

      const { unrestored, unconfirmed } = await revertSteps(
        ALL_STEPS,
        CONFIG,
        path,
        reporter,
      );

      expect(unrestored).toEqual(["bootstrap-windows"]);
      expect(unconfirmed).toEqual([]);
      // Rien n'est parti sur le PC : mieux vaut ne rien envoyer qu'une ligne de
      // commande dont personne ne sait ce qu'elle fera.
      expect(remoteScripts).toEqual([]);
      // Et l'etat anterieur est toujours la, entier.
      const manifest = await readManifest(path);
      expect(manifest.order).toEqual(["bootstrap-windows"]);
      expect(manifest.steps["bootstrap-windows"]?.previous).toEqual({
        capture: abimee,
        acknowledged: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("une seule queue detachee par desinstallation", () => {
  test("le manifeste complet n'emet qu'une queue, celle de l'amorcage", async () => {
    const scripts = await revert([
      "network-mac",
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
    ]);
    const tails = withTail(scripts);

    expect(tails).toHaveLength(1);
    // Et c'est bien celle de l'amorcage : elle rend l'adressage d'AVANT
    // amorcage, que network-windows ne connait pas.
    expect(tails[0]).toContain("-IPAddress '192.168.1.50'");
    expect(tails[0]).toContain("Stop-Service -Name sshd");
  });

  test("l'unique queue est emise par la DERNIERE restauration distante", async () => {
    const scripts = await revert([
      "network-mac",
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
    ]);
    // Restauration = ordre inverse : profil, reseau, amorcage, Mac. La queue
    // doit donc etre dans le dernier script distant emis, pas avant.
    const index = scripts.findIndex((s) => s.includes("Start-Process powershell"));
    expect(index).toBe(scripts.length - 1);
  });

  test("network-windows ne parle meme pas au PC quand l'amorcage suit", async () => {
    // Son « etat anterieur » est l'etat d'apres amorcage : le releve le
    // supplante entierement. Emettre sa moitie non coupante reposerait des
    // adresses que l'amorcage s'apprete a defaire.
    const scripts = await revert(["bootstrap-windows", "network-windows"]);
    expect(scripts.some((s) => s.includes("-IPAddress '10.10.10.1'"))).toBe(true);
    // Un seul script distant : celui de l'amorcage.
    expect(scripts).toHaveLength(1);
  });

  test("network-windows garde sa queue quand l'amorcage n'est pas au manifeste", async () => {
    // Un PC amorce par une version anterieure : personne ne restaure apres
    // elle, elle est la derniere, la queue lui appartient.
    const scripts = await revert(["network-windows", "network-profile-task"]);
    const tails = withTail(scripts);

    expect(tails).toHaveLength(1);
    expect(tails[0]).toContain("-NetworkCategory Public");
    // C'est bien la sienne : elle ignore tout du PC d'avant amorcage.
    expect(tails[0]).not.toContain("192.168.1.50");
    expect(tails[0]).not.toContain("Stop-Service");
  });

  test("aucun ordre enregistre ne produit deux queues", async () => {
    // Contre-epreuve generale : toutes les combinaisons d'etapes distantes.
    const distantes = ["bootstrap-windows", "network-windows", "network-profile-task"];
    for (let masque = 1; masque < 1 << distantes.length; masque++) {
      const order = distantes.filter((_, i) => masque & (1 << i));
      remoteScripts.length = 0;
      const tails = withTail(await revert(order));
      expect(tails.length).toBeLessThanOrEqual(1);
    }
  });
});
