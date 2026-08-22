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
const { writeManifest } = await import("../../src/lib/manifest");
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

const reporter = {
  skipped: () => {},
  applied: () => {},
  restored: () => {},
  failed: () => {},
};

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

async function revert(order: string[]): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "hardline-tails-"));
  const path = join(dir, "manifest.json");
  try {
    await writeManifest(path, manifestOf(order));
    const unrestored = await revertSteps(ALL_STEPS, CONFIG, path, reporter);
    expect(unrestored).toEqual([]);
    return [...remoteScripts];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const withTail = (scripts: string[]): string[] =>
  scripts.filter((s) => s.includes("Start-Process powershell"));

beforeEach(() => {
  remoteScripts.length = 0;
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
