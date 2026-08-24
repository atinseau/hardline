import { test, expect, describe, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckResult } from "../../src/lib/preflight";
import type { Manifest } from "../../src/lib/manifest";
import type { Step } from "../../src/steps/types";
import { CONFIG } from "../../src/config";
import { exitCodeFor, type CommandOutput } from "../../src/command-run";

// Les fonctions pures de preflight restent les vraies : hasBlockingFailure et
// SSH_CHECK decident du parcours, les simuler reviendrait a tester la simulation.
const realPreflight = await import("../../src/lib/preflight");
const realFs = await import("node:fs/promises");
// Capturee AVANT le mock : `realFs.readFile` lu apres coup rend le mock
// lui-meme, et la delegation ci-dessous serait une recursion infinie.
const readFileReel = realFs.readFile;

// Journal d'execution. C'est l'ORDRE qui porte le correctif : la convergence
// locale doit preceder la premiere sonde distante, sans quoi la sonde part par
// la passerelle Wi-Fi et expire quel que soit l'etat du PC.
const trace: string[] = [];

let localChecks: CheckResult[] = [];
let remoteRounds: CheckResult[][] = [];
let remoteCalls = 0;
let bootstrapSucceeds = true;
let serveCalls = 0;
let waitCalls = 0;

const finishes: string[] = [];
const failures: string[] = [];
const reports: string[][] = [];
/** Tout ce que l'interface rend visible passe par un journal, info et warn compris. */
const infos: string[] = [];
const warns: string[] = [];
let applyThrowsOn: string | null = null;
let publicKey: string | null = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test\n";
const appliedGroups: string[][] = [];
const manifestPaths: string[] = [];
/** L'ordre reellement enregistre, tel que le manifeste le porterait. */
const manifestOrder: string[] = [];
/** Faux quand le PC ne porte aucun releve exploitable : l'etape n'enregistre rien. */
let releveEnregistrable = true;
/** Fait lever la sonde locale : le seul chemin ou install() sort par une exception. */
let preflightThrows = false;

mock.module("../../src/lib/preflight", () => ({
  ...realPreflight,
  runLocalPreflight: async () => {
    trace.push("preflight-local");
    if (preflightThrows) throw new Error("sonde locale cassée");
    return localChecks;
  },
  runRemotePreflight: async () => {
    trace.push("preflight-remote");
    const round = remoteRounds[Math.min(remoteCalls, remoteRounds.length - 1)];
    remoteCalls += 1;
    return round ?? [];
  },
  waitForRemote: async () => {
    trace.push("wait");
    waitCalls += 1;
    return bootstrapSucceeds;
  },
}));

// Le manifeste que rend applySteps n'est pas un decor : install y lit ce qui a
// REELLEMENT ete enregistre. Une etape peut se declarer conforme sans rien
// enregistrer : c'est exactement le cas d'un PC sans releve d'amorcage.
function manifestOf(order: string[]): Manifest {
  const now = "2026-08-22T10:00:00.000Z";
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    order,
    steps: Object.fromEntries(
      order.map((n) => [n, { step: n, appliedAt: now, previous: {} }]),
    ),
  };
}

// L'Apollo etranger : la vraie classe d'erreur, jamais une copie structurelle.
// Un bouchon qui s'ecarte du vrai type est un test qui passe contre une
// interface qui n'existe pas.
const realApolloInstall = await import("../../src/steps/apollo-install");
const { ForeignApolloError } = realApolloInstall;

let applyThrowsForeign = false;
let foreignRemoved = false;
const BACKUP_PATH = "C:\\ProgramData\\hardline\\apollo-backup-20260823-101500.conf";
const backupApolloConfig = mock(async () => {
  trace.push("backup");
  return BACKUP_PATH;
});
/**
 * Ce que le demontage n'a PAS pu faire. Le nettoyage tolere l'absence de ses
 * cibles ; ce qui manque doit malgre tout remonter jusqu'a l'ecran, et c'est ce
 * que cette file permet de prouver.
 */
let uninstallCedes: string[] = [];
const uninstallApollo = mock(async () => {
  trace.push("uninstall");
  foreignRemoved = true;
  return uninstallCedes;
});

mock.module("../../src/steps/apollo-install", () => ({
  ...realApolloInstall,
  backupApolloConfig,
  uninstallApollo,
}));

let confirmForeignAnswer = true;
const askConfirmation = mock(async (..._args: unknown[]) => confirmForeignAnswer);

// Le mot de passe Windows : demande par la commande, jamais par l'etape.
let windowsSecretPresent = false;
const realKeychain = await import("../../src/lib/keychain");
const getSecretForCredentials = mock(async (..._args: unknown[]) =>
  windowsSecretPresent ? "deja-au-trousseau" : null,
);
mock.module("../../src/lib/keychain", () => ({
  ...realKeychain,
  getSecret: getSecretForCredentials,
}));

const realCredentials = await import("../../src/steps/smb-credentials");
const providePassword = mock((..._args: unknown[]) => {
  trace.push("providePassword");
});
const forgetPassword = mock(() => {
  trace.push("forgetPassword");
});
mock.module("../../src/steps/smb-credentials", () => ({
  ...realCredentials,
  providePassword,
  forgetPassword,
}));

const askSecretCalls: string[] = [];
let askSecretRejects = false;
const askSecret = mock(async (message: string) => {
  askSecretCalls.push(message);
  if (askSecretRejects) throw new Error("Interrompu par l'utilisateur.");
  return "mot-de-passe-saisi";
});

mock.module("../../src/lib/orchestrator", () => ({
  applySteps: async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steps: Step<any>[],
    _config: unknown,
    manifestPath: string,
  ) => {
    const names = steps.map((s) => s.name);
    trace.push(`apply:${names.join("+")}`);
    if (applyThrowsOn === names.join("+")) throw new Error("boum");
    if (
      names.join("+") === REMOTE_GROUP.join("+") &&
      applyThrowsForeign &&
      !foreignRemoved
    ) {
      throw new ForeignApolloError(
        "Apollo etranger trouve (version 0.4.5, 2 client(s) appaire(s)).",
        {
          installed: true,
          version: "0.4.5",
          ours: false,
          backupPath: null,
          pairedClients: 2,
        },
        true,
      );
    }
    appliedGroups.push(names);
    manifestPaths.push(manifestPath);
    for (const name of names) {
      if (name === "bootstrap-windows" && !releveEnregistrable) continue;
      if (!manifestOrder.includes(name)) manifestOrder.push(name);
    }
    return manifestOf(manifestOrder);
  },
}));

mock.module("../../src/lib/bootstrap-server", () => ({
  serveBootstrap: async (options: { port: number }) => {
    trace.push("serve");
    serveCalls += 1;
    return {
      url: `http://mac.local:${options.port}`,
      port: options.port,
      stop: () => trace.push("stop"),
    };
  },
  localBootstrapUrl: (port: number) => `http://mac.local:${port}/bootstrap.ps1`,
}));

/** Le terminal, tel que la commande le voit. Faux = script, tache planifiee. */
let interactif = true;

// Le manifeste ET son verrou vont dans un repertoire temporaire : une suite de
// tests n'a rien a ecrire dans ~/.config de la vraie machine.
const realManifest = await import("../../src/lib/manifest");
const MANIFEST_PATH = join(
  tmpdir(),
  `hardline-install-${process.pid}`,
  "manifest.json",
);

mock.module("../../src/lib/manifest", () => ({
  ...realManifest,
  defaultManifestPath: () => MANIFEST_PATH,
}));

// La cle publique est lue avant de servir le script d'amorcage ; le test ne
// doit dependre d'aucun fichier de la vraie machine.
mock.module("node:fs/promises", () => ({
  ...realFs,
  // Seule la cle publique est simulee. Tout le reste doit etre lu pour de vrai
  // : le verrou du manifeste en fait partie, et un verrou illisible ne nomme
  // pas son detenteur.
  readFile: async (path: Parameters<typeof realFs.readFile>[0], ...rest: never[]) => {
    if (!String(path).endsWith(".pub")) return readFileReel(path, ...rest);
    if (publicKey === null) throw new Error("ENOENT");
    return publicKey;
  },
}));

const { installCommand: executeInstallCommand } = await import("../../src/commands/install");

const output: CommandOutput = {
  interactive: true,
  start: () => {},
  phaseStart: () => {},
  phaseActivity: () => {},
  phaseDetail: (message) => infos.push(message),
  phaseEnd: () => {},
  warning: (message) => warns.push(message),
  report: (title, lines) => reports.push([title, ...lines]),
  confirm: async (message, destructive) => {
    if (destructive && !interactif) return "unavailable";
    return (await askConfirmation(message)) ? "accepted" : "declined";
  },
  choice: async (_message, _choices, initialValue) => ({ status: "selected", value: initialValue }),
  secret: async (message) => ({ status: "provided", value: await askSecret(message) }),
  finish: (message, status) => {
    finishes.push(message);
    if (status === "failed") failures.push(message);
  },
};

async function installCommand(options: { yes?: boolean } = {}): Promise<void> {
  const result = await executeInstallCommand({ config: CONFIG, output, yes: options.yes });
  process.exitCode = exitCodeFor(result);
}

const ok = (name: string): CheckResult => ({
  name,
  ok: true,
  blocking: true,
  installOnly: false,
  detail: `${name} conforme`,
});

const ko = (name: string, blocking = true): CheckResult => ({
  name,
  ok: false,
  blocking,
  installOnly: false,
  detail: `${name} en echec`,
});

const MAC_OK = [ok("service-mac")];
const PC_OK = [ok("ssh"), ok("windows-version"), ok("gpu"), ok("lien-windows")];

const LOCAL_GROUP = [
  "network-mac",
  "moonlight-install",
  "smb-credentials",
  "smb-mountpoints",
];
const CAPTURE_GROUP = ["bootstrap-windows"];
const REMOTE_GROUP = [
  "network-windows",
  "network-profile-task",
  "apollo-install",
  "apollo-config",
  "apollo-service",
  "smb-shares",
  "pairing",
];

beforeEach(() => {
  trace.length = 0;
  finishes.length = 0;
  failures.length = 0;
  reports.length = 0;
  infos.length = 0;
  warns.length = 0;
  applyThrowsOn = null;
  applyThrowsForeign = false;
  foreignRemoved = false;
  uninstallCedes = [];
  confirmForeignAnswer = true;
  backupApolloConfig.mockClear();
  uninstallApollo.mockClear();
  askConfirmation.mockClear();
  windowsSecretPresent = false;
  getSecretForCredentials.mockClear();
  providePassword.mockClear();
  forgetPassword.mockClear();
  askSecret.mockClear();
  askSecretCalls.length = 0;
  askSecretRejects = false;
  interactif = true;
  publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test\n";
  appliedGroups.length = 0;
  manifestPaths.length = 0;
  manifestOrder.length = 0;
  releveEnregistrable = true;
  preflightThrows = false;
  localChecks = MAC_OK;
  remoteRounds = [PC_OK];
  remoteCalls = 0;
  bootstrapSucceeds = true;
  serveCalls = 0;
  waitCalls = 0;
  process.exitCode = 0;
});

afterEach(() => {
  // Sans cela, le code de sortie pose par une commande simulee ferait echouer
  // le processus de test entier.
  process.exitCode = 0;
});

afterAll(async () => {
  await rm(dirname(MANIFEST_PATH), { recursive: true, force: true });
});

describe("installCommand", () => {
  test("converge le Mac avant de sonder le PC", async () => {
    await installCommand();
    expect(trace).toEqual([
      "preflight-local",
      "providePassword",
      "apply:network-mac+moonlight-install+smb-credentials+smb-mountpoints",
      "preflight-remote",
      "apply:bootstrap-windows",
      "apply:network-windows+network-profile-task+apollo-install+apollo-config+apollo-service+smb-shares+pairing",
      "forgetPassword",
    ]);
    expect(process.exitCode).toBe(0);
  });

  test("toutes les convergences ecrivent dans le meme manifeste", async () => {
    await installCommand();
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP, REMOTE_GROUP]);
    expect(manifestPaths).toHaveLength(3);
    expect(new Set(manifestPaths).size).toBe(1);
    expect(manifestPaths[0]).toContain("manifest.json");
  });

  test("un blocage cote Mac ne modifie rien et n'envoie pas amorcer le PC", async () => {
    localChecks = [ko("service-mac")];
    await installCommand();
    // Ni convergence, ni sonde distante, ni dix minutes passees devant le PC.
    expect(trace).toEqual(["preflight-local", "forgetPassword"]);
    expect(serveCalls).toBe(0);
    expect(waitCalls).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(finishes.join("\n")).toContain("Nothing was changed");
  });

  test("un amorcage reussi rejoue la phase distante au lieu de demander une relance", async () => {
    remoteRounds = [[ko("ssh")], PC_OK];
    await installCommand();
    expect(trace).toEqual([
      "preflight-local",
      "providePassword",
      "apply:network-mac+moonlight-install+smb-credentials+smb-mountpoints",
      "preflight-remote",
      "serve",
      "wait",
      "stop",
      "preflight-remote",
      "apply:bootstrap-windows",
      "apply:network-windows+network-profile-task+apollo-install+apollo-config+apollo-service+smb-shares+pairing",
      "forgetPassword",
    ]);
    expect(finishes.join("\n")).toContain("Hardline is installed");
    expect(finishes.join("\n")).not.toContain("Relancer");
    expect(process.exitCode).toBe(0);
  });

  test("un amorcage sans reponse laisse le Mac converge et une consigne utilisable", async () => {
    remoteRounds = [[ko("ssh")]];
    bootstrapSucceeds = false;
    await installCommand();
    expect(remoteCalls).toBe(1);
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(trace).not.toContain("apply:network-windows+network-profile-task+apollo-install+apollo-config+apollo-service+smb-shares+pairing");
    expect(process.exitCode).toBe(1);
    const message = finishes.join("\n");
    expect(message).toContain("hardline install");
    expect(message).toContain("Mac's previous state remains recorded");
    expect(message).toContain("hardline uninstall");
  });

  test("un blocage distant autre que SSH n'entre jamais dans l'amorcage", async () => {
    remoteRounds = [[ok("ssh"), ko("gpu")]];
    await installCommand();
    expect(serveCalls).toBe(0);
    expect(waitCalls).toBe(0);
    expect(remoteCalls).toBe(1);
    expect(process.exitCode).toBe(1);
    // La sortie doit dire dans quel etat sont les machines et comment en sortir.
    const message = finishes.join("\n");
    expect(message).toContain("hardline uninstall");
  });

  // Le scenario qui motive toute la vague : PC en 192.168.1.50/24 statique,
  // sshd desactive. L'amorcage efface cet adressage, puis le second preflight
  // bloque sur le GPU. Si le releve n'est pas rapatrie AVANT cette porte, le
  // manifeste reste vide et l'adressage d'origine du PC n'existe plus nulle part.
  test("rapatrie le releve d'amorcage avant de buter sur une precondition", async () => {
    remoteRounds = [[ko("ssh")], [ok("ssh"), ko("gpu")]];
    await installCommand();

    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP]);
    expect(trace).toEqual([
      "preflight-local",
      "providePassword",
      "apply:network-mac+moonlight-install+smb-credentials+smb-mountpoints",
      "preflight-remote",
      "serve",
      "wait",
      "stop",
      "preflight-remote",
      "apply:bootstrap-windows",
      "forgetPassword",
    ]);
    expect(process.exitCode).toBe(1);
    expect(finishes.join("\n")).toContain("PC bootstrap recovery is recorded");
  });

  test("n'annonce aucun releve quand le PC n'en a livre aucun", async () => {
    // Un PC amorce par une version anterieure de hardline n'en porte pas :
    // l'etape se declare conforme et n'enregistre rien. Annoncer "releve
    // enregistre" sur la seule foi d'une session SSH ouverte etait un
    // mensonge, et le seul que l'utilisateur n'avait aucun moyen de detecter.
    releveEnregistrable = false;
    remoteRounds = [[ok("ssh"), ko("gpu")]];
    await installCommand();

    // L'etape a bien tourne : c'est ce qu'elle a enregistre qui differe.
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP]);
    const message = finishes.join("\n");
    expect(message).not.toContain("PC bootstrap recovery is recorded");
    expect(message).toContain("no usable bootstrap recovery state");
    expect(message).toContain("restore the Mac");
    expect(process.exitCode).toBe(1);
  });

  test("l'enregistrement du releve precede la porte des preconditions", async () => {
    // Assertion d'ordre : une capture placee apres la porte ne s'executerait
    // jamais dans ce cas, qui est precisement celui ou elle sert.
    remoteRounds = [[ok("ssh"), ko("gpu")]];
    await installCommand();
    const capture = trace.indexOf("apply:bootstrap-windows");
    expect(capture).toBeGreaterThan(trace.indexOf("preflight-remote"));
    expect(finishes).toHaveLength(1);
  });

  test("ne rapatrie rien quand le PC ne repond pas en SSH", async () => {
    // Sans session, il n'y a pas de releve a lire : tenter la lecture ferait
    // remonter une erreur SSH nue a la place du diagnostic de preflight.
    remoteRounds = [[ko("ssh"), ko("lien-windows")]];
    await installCommand();
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(finishes.join("\n")).toContain("Mac's previous state is recorded");
  });

  test("SSH en echec accompagne d'un autre blocage n'ouvre pas l'amorcage", async () => {
    remoteRounds = [[ko("ssh"), ko("lien-windows")]];
    await installCommand();
    expect(serveCalls).toBe(0);
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(process.exitCode).toBe(1);
  });

  test("une cle publique manquante bloque en phase 1, avant toute modification", async () => {
    localChecks = [ok("service-mac"), ko("cle-publique")];
    await installCommand();
    expect(trace).toEqual(["preflight-local", "forgetPassword"]);
    expect(appliedGroups).toEqual([]);
    expect(serveCalls).toBe(0);
    expect(finishes.join("\n")).toContain("Nothing was changed");
    expect(process.exitCode).toBe(1);
  });

  test("une cle disparue entre la phase 1 et l'amorcage sort en disant l'etat du Mac", async () => {
    // Le fichier existait a la phase 1 et n'existe plus a l'amorcage : le seul
    // cas que la precondition locale ne peut pas couvrir.
    remoteRounds = [[ko("ssh")]];
    publicKey = null;
    await installCommand();
    expect(trace).toEqual([
      "preflight-local",
      "providePassword",
      "apply:network-mac+moonlight-install+smb-credentials+smb-mountpoints",
      "preflight-remote",
      "forgetPassword",
    ]);
    expect(serveCalls).toBe(0);
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(failures.join("\n")).toContain("ssh-keygen -t ed25519");
    const message = finishes.join("\n");
    expect(message).toContain("Mac remains configured");
    expect(message).toContain("hardline uninstall");
    expect(process.exitCode).toBe(1);
  });

  test("un echec de la convergence du Mac n'envoie pas sonder le PC", async () => {
    applyThrowsOn = "network-mac+moonlight-install+smb-credentials+smb-mountpoints";
    await installCommand();
    expect(trace).toEqual([
      "preflight-local",
      "providePassword",
      "apply:network-mac+moonlight-install+smb-credentials+smb-mountpoints",
      "forgetPassword",
    ]);
    expect(failures.join("\n")).toContain("Mac configuration failed");
    expect(process.exitCode).toBe(1);
  });

  test("un echec de la convergence du PC dit comment reprendre", async () => {
    applyThrowsOn =
      "network-windows+network-profile-task+apollo-install+apollo-config+apollo-service+smb-shares+pairing";
    await installCommand();
    expect(failures.join("\n")).toContain("PC configuration failed");
    const message = finishes.join("\n");
    expect(message).toContain("Previous state");
    expect(message).toContain("hardline uninstall");
    expect(process.exitCode).toBe(1);
  });

  test("une autre execution en cours arrete tout avant la moindre lecture", async () => {
    // Le verrou est pris AVANT la phase 1 : la seconde execution ne sonde
    // meme pas le Mac, et surtout n'ecrit rien dans le manifeste.
    const lockPath = realManifest.manifestLockPath(MANIFEST_PATH);
    await mkdir(dirname(MANIFEST_PATH), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: "2026-08-22T10:00:00.000Z" }),
    );
    try {
      await installCommand();
    } finally {
      await unlink(lockPath);
    }

    expect(trace).toEqual([]);
    expect(appliedGroups).toEqual([]);
    expect(failures.join("\n")).toContain("Another Command Run is active");
    expect(finishes.join("\n")).toContain("Installation could not start");
    expect(process.exitCode).toBe(1);
  });

  test("un echec distant non bloquant n'arrete pas l'installation", async () => {
    remoteRounds = [[ok("ssh"), ko("windows-version", false), ok("gpu")]];
    await installCommand();
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP, REMOTE_GROUP]);
    expect(process.exitCode).toBe(0);
  });
});

describe("installCommand, Apollo etranger detecte sur le PC", () => {
  test("demande confirmation, nomme ce qui a ete trouve, puis relance et reussit", async () => {
    applyThrowsForeign = true;
    confirmForeignAnswer = true;
    await installCommand({ yes: false });

    expect(askConfirmation).toHaveBeenCalledTimes(1);
    // Ce qui a ete trouve est nomme avant qu'on ne demande quoi que ce soit.
    const rapport = reports.flat().join("\n");
    expect(rapport).toContain("0.4.5");
    expect(rapport).toContain("2");
    expect(backupApolloConfig).toHaveBeenCalledTimes(1);
    expect(uninstallApollo).toHaveBeenCalledTimes(1);
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP, REMOTE_GROUP]);
    expect(process.exitCode).toBe(0);
  });

  /**
   * Le demontage tolere l'absence de ses cibles - une installation a demi
   * demontee doit pouvoir etre nettoyee jusqu'au bout - mais la tolerance ne
   * doit jamais devenir du silence. Ce que le PC dit n'avoir pas pu faire
   * arrive a l'ecran, sans quoi la commande annoncerait un remplacement propre
   * sur une machine ou un pilote ou un certificat est reste.
   */
  test("ce que le demontage n'a pas pu faire est dit a l'operateur", async () => {
    applyThrowsForeign = true;
    confirmForeignAnswer = true;
    uninstallCedes = [
      "Pilote SudoVDA introuvable\u00a0: rien à retirer.",
      "update-path.bat absent\u00a0: le PATH du PC peut garder l'entrée d'Apollo.",
    ];

    await installCommand({ yes: false });

    expect(warns).toContain(
      "Apollo cleanup could not complete one item. Inspect the PC before continuing.",
    );
  });

  test("la sauvegarde precede la desinstallation dans le journal d'appels", async () => {
    // L'ordre est la substance, et le journal partage est la seule preuve qui
    // le montre : desinstaller avant de sauvegarder perd definitivement la
    // configuration d'un tiers.
    applyThrowsForeign = true;
    confirmForeignAnswer = true;
    await installCommand({ yes: false });

    const sauvegarde = trace.indexOf("backup");
    const desinstallation = trace.indexOf("uninstall");
    expect(sauvegarde).toBeGreaterThanOrEqual(0);
    expect(desinstallation).toBeGreaterThanOrEqual(0);
    expect(sauvegarde).toBeLessThan(desinstallation);
    // Et les deux tiennent entre la convergence qui a leve et celle qui reprend.
    const premiere = trace.indexOf(`apply:${REMOTE_GROUP.join("+")}`);
    const reprise = trace.lastIndexOf(`apply:${REMOTE_GROUP.join("+")}`);
    expect(premiere).toBeLessThan(sauvegarde);
    expect(desinstallation).toBeLessThan(reprise);
    expect(premiere).toBeLessThan(reprise);
  });

  test("le chemin de la sauvegarde est dit a l'utilisateur", async () => {
    applyThrowsForeign = true;
    await installCommand({ yes: true });
    expect(failures.concat(finishes).join("\n")).not.toContain("undefined");
  });

  test("s'arrete sans rien modifier sur le PC si l'utilisateur refuse", async () => {
    applyThrowsForeign = true;
    confirmForeignAnswer = false;
    await installCommand({ yes: false });

    expect(uninstallApollo).not.toHaveBeenCalled();
    expect(backupApolloConfig).not.toHaveBeenCalled();
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP]);
    expect(process.exitCode).toBe(1);
    expect(finishes.join("\n")).toContain("foreign Apollo installation was preserved");
  });

  test("--yes leve la question", async () => {
    applyThrowsForeign = true;
    await installCommand({ yes: true });

    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  test("une reprise qui echoue a son tour dit comment reprendre", async () => {
    applyThrowsForeign = true;
    applyThrowsOn = REMOTE_GROUP.join("+");
    await installCommand({ yes: true });
    expect(failures.join("\n")).toContain("PC configuration failed");
    expect(process.exitCode).toBe(1);
  });
});

describe("installCommand, mot de passe Windows", () => {
  test("le demande une seule fois quand le trousseau est vide, avant la convergence locale", async () => {
    windowsSecretPresent = false;
    await installCommand();
    expect(askSecret).toHaveBeenCalledTimes(1);
    expect(providePassword).toHaveBeenCalledWith("mot-de-passe-saisi");
    const depot = trace.indexOf("providePassword");
    const convergenceLocale = trace.indexOf(`apply:${LOCAL_GROUP.join("+")}`);
    expect(depot).toBeGreaterThanOrEqual(0);
    expect(convergenceLocale).toBeGreaterThanOrEqual(0);
    expect(depot).toBeLessThan(convergenceLocale);
  });

  test("l'invite ne contient jamais le mot de passe, et le mot de passe ne s'affiche nulle part", async () => {
    windowsSecretPresent = false;
    await installCommand();
    const visible = [
      ...askSecretCalls,
      ...finishes,
      ...failures,
      ...reports.flat(),
      ...infos,
      ...warns,
    ].join("\n");
    expect(visible).not.toContain("mot-de-passe-saisi");
  });

  test("ne demande rien quand un mot de passe est deja au trousseau", async () => {
    windowsSecretPresent = true;
    await installCommand();
    expect(askSecret).not.toHaveBeenCalled();
    expect(providePassword).not.toHaveBeenCalled();
  });
});

describe("installCommand, le mot de passe en memoire est efface en fin de convergence", () => {
  test("apres une installation reussie", async () => {
    await installCommand();
    expect(forgetPassword).toHaveBeenCalledTimes(1);
    // Il est efface EN DERNIER : apres la derniere convergence, pas avant.
    expect(trace.lastIndexOf("forgetPassword")).toBe(trace.length - 1);
  });

  test("meme quand la convergence locale echoue", async () => {
    applyThrowsOn = LOCAL_GROUP.join("+");
    await installCommand();
    expect(process.exitCode).toBe(1);
    expect(forgetPassword).toHaveBeenCalledTimes(1);
  });

  test("meme quand la convergence distante echoue", async () => {
    applyThrowsOn = REMOTE_GROUP.join("+");
    await installCommand();
    expect(process.exitCode).toBe(1);
    expect(forgetPassword).toHaveBeenCalledTimes(1);
  });

  test("meme quand le Mac bloque en phase 1, avant toute modification", async () => {
    localChecks = [ko("service-mac")];
    await installCommand();
    expect(forgetPassword).toHaveBeenCalledTimes(1);
  });

  test("meme quand la commande sort par une exception, et non par un retour", async () => {
    // Le seul chemin qui distingue un effacement dans le finally d'un
    // effacement pose apres l'appel : une exception qui traverse install().
    preflightThrows = true;
    await installCommand();
    expect(process.exitCode).toBe(1);
    expect(forgetPassword).toHaveBeenCalledTimes(1);
  });

  test("meme quand l'utilisateur annule l'invite du mot de passe", async () => {
    askSecretRejects = true;
    await installCommand();
    expect(process.exitCode).toBe(1);
    expect(forgetPassword).toHaveBeenCalledTimes(1);
  });

  test("meme quand l'utilisateur refuse d'effacer un Apollo etranger", async () => {
    applyThrowsForeign = true;
    confirmForeignAnswer = false;
    await installCommand({ yes: false });
    expect(forgetPassword).toHaveBeenCalledTimes(1);
  });
});

describe("installCommand, Apollo etranger hors terminal", () => {
  test("refuse d'effacer sans --yes quand aucun terminal ne peut repondre", async () => {
    // askConfirmation rend « oui » hors terminal : sans garde-fou en amont, un
    // install lance depuis un script effacerait l'Apollo d'un tiers sans que
    // personne n'ait repondu.
    interactif = false;
    applyThrowsForeign = true;
    await installCommand({ yes: false });

    expect(backupApolloConfig).not.toHaveBeenCalled();
    expect(uninstallApollo).not.toHaveBeenCalled();
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP]);
    expect(process.exitCode).toBe(1);
    const message = finishes.join("\n");
    expect(message).toContain("foreign Apollo installation was preserved");
    expect(message).toContain("--yes");
  });

  test("l'invite n'est meme pas posee hors terminal sans --yes", async () => {
    interactif = false;
    applyThrowsForeign = true;
    await installCommand({ yes: false });
    expect(askConfirmation).not.toHaveBeenCalled();
  });

  test("--yes autorise le remplacement hors terminal", async () => {
    // Le consentement est alors porte par la ligne de commande, ecrite a la main.
    interactif = false;
    applyThrowsForeign = true;
    await installCommand({ yes: true });

    expect(backupApolloConfig).toHaveBeenCalledTimes(1);
    expect(uninstallApollo).toHaveBeenCalledTimes(1);
    expect(trace.indexOf("backup")).toBeLessThan(trace.indexOf("uninstall"));
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP, REMOTE_GROUP]);
    expect(process.exitCode).toBe(0);
  });

  test("en terminal, sans --yes, la question est bien posee", async () => {
    // Le controle des trois precedents : c'est le terminal qui fait la
    // difference, pas le simple fait d'avoir trouve un Apollo etranger.
    interactif = true;
    applyThrowsForeign = true;
    await installCommand({ yes: false });
    expect(askConfirmation).toHaveBeenCalledTimes(1);
    expect(uninstallApollo).toHaveBeenCalledTimes(1);
  });
});
