import { readFile } from "node:fs/promises";
import { CONFIG } from "../config";
import { CAPTURE_STEPS, LOCAL_STEPS, REMOTE_STEPS } from "../steps";
import { applySteps } from "../lib/orchestrator";
import { defaultManifestPath } from "../lib/manifest";
import type { CheckResult } from "../lib/preflight";
import {
  SSH_CHECK,
  hasBlockingFailure,
  missingPublicKeyMessage,
  publicKeyPath,
  runLocalPreflight,
  runRemotePreflight,
  waitForRemote,
} from "../lib/preflight";
import { localBootstrapUrl, serveBootstrap } from "../lib/bootstrap-server";
import { errorMessage } from "../lib/errors";
import type { Step } from "../steps/types";
import { configureOutput, ui, withSpinner } from "../lib/ui";

const BOOTSTRAP_DEADLINE_MS = 10 * 60_000;

function reportChecks(checks: CheckResult[]): void {
  for (const check of checks) {
    if (check.ok) ui.info(`${check.name} — ${check.detail}`);
    else if (check.blocking) ui.failed({ label: check.name, detail: check.detail });
    else ui.warn(`${check.name} — ${check.detail}`);
  }
}

/**
 * La presence de la cle est deja une precondition de la phase 1. Ce second
 * controle couvre le seul cas qu'elle ne peut pas couvrir : le fichier efface
 * entre la phase 1 et l'amorcage.
 */
async function readPublicKey(): Promise<string> {
  let key = "";
  try {
    key = (await readFile(publicKeyPath(CONFIG), "utf8")).trim();
  } catch {
    key = "";
  }
  if (key.length === 0) throw new Error(missingPublicKeyMessage(CONFIG));
  return key;
}

/**
 * Sert le script d'amorcage et attend que le PC reponde. C'est le seul geste
 * manuel du projet : une ligne a coller une fois par PC.
 */
async function bootstrapRemote(): Promise<boolean> {
  const publicKey = await readPublicKey();
  const server = await serveBootstrap({
    port: CONFIG.bootstrapPort,
    publicKey,
    interfaceAlias: CONFIG.windows.interfaceAlias,
    windowsIp: CONFIG.windows.ip,
    prefixLength: CONFIG.windows.prefixLength,
  });

  // Tout ce qui suit la creation du serveur est dans le try : une exception
  // avant le finally laisserait un ecouteur ouvert et figerait la commande.
  try {
    ui.report("Amorçage du PC", [
      "Le PC n'est pas encore joignable. Sur le PC, dans un",
      "PowerShell lancé en administrateur, coller cette ligne\u00a0:",
      "",
      `  irm ${localBootstrapUrl(server.port)} | iex`,
      "",
      "L'installation reprendra d'elle-même dès que le PC répondra.",
    ]);

    return await withSpinner("Attente du PC (10 minutes au plus)", () =>
      waitForRemote(CONFIG, BOOTSTRAP_DEADLINE_MS),
    );
  } finally {
    server.stop();
  }
}

/**
 * Applique une phase de convergence. Une etape qui echoue ne doit pas remonter
 * nue jusqu'au CLI : l'etat anterieur de tout ce qui a ete touche est sur
 * disque, et l'utilisateur doit savoir qu'il peut reprendre ou tout rendre.
 * Rend false quand la phase a echoue.
 */
async function converge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  label: string,
  manifestPath: string,
): Promise<boolean> {
  try {
    await applySteps(steps, CONFIG, manifestPath, ui);
    return true;
  } catch (error) {
    ui.failed({ label, detail: errorMessage(error) });
    ui.finish(
      "Installation interrompue\u00a0: l'état antérieur de chaque étape touchée est " +
        "sur disque. Corriger, puis «\u00a0hardline install\u00a0» pour reprendre " +
        "ou «\u00a0hardline uninstall\u00a0» pour tout rendre.",
    );
    process.exitCode = 1;
    return false;
  }
}

export async function installCommand(): Promise<void> {
  configureOutput();
  ui.start("hardline — installation");

  // Phase 1 - preconditions locales. Rien n'est encore modifie.
  const local = await withSpinner("Vérification du Mac", () =>
    runLocalPreflight(CONFIG),
  );
  reportChecks(local);

  if (hasBlockingFailure(local)) {
    // Un blocage cote Mac n'a rien a faire sur le PC : envoyer l'utilisateur
    // amorcer une machine pendant dix minutes ne le reglerait pas.
    ui.finish(
      "Installation interrompue\u00a0: le Mac n'est pas prêt. Rien n'a été modifié.",
    );
    process.exitCode = 1;
    return;
  }

  // Phase 2 - convergence locale. C'est elle qui cree la route vers le
  // lien direct : sans elle, aucune precondition distante n'est observable.
  // Elle passe par applySteps, qui ecrit l'etat anterieur avant de modifier.
  const manifestPath = defaultManifestPath();
  if (!(await converge(LOCAL_STEPS, "Convergence du Mac", manifestPath))) return;

  // Phase 3 - preconditions distantes, desormais observables.
  let remote = await withSpinner("Vérification du PC", () =>
    runRemotePreflight(CONFIG),
  );
  reportChecks(remote);

  const blocking = remote.filter((c) => !c.ok && c.blocking);
  const sshSeulBloque = blocking.length === 1 && blocking[0]?.name === SSH_CHECK;

  if (sshSeulBloque) {
    let amorce: boolean;
    try {
      amorce = await bootstrapRemote();
    } catch (error) {
      // Apres la phase 2, aucune sortie ne doit laisser l'utilisateur ignorer
      // que le Mac a change et qu'on sait le lui rendre.
      ui.failed({ label: "Amorçage du PC", detail: errorMessage(error) });
      ui.finish(
        "Amorçage impossible. Le Mac reste configuré et son état antérieur " +
          "enregistré\u00a0: «\u00a0hardline uninstall\u00a0» le rend.",
      );
      process.exitCode = 1;
      return;
    }

    if (!amorce) {
      ui.finish(
        "Le PC n'a pas répondu. Relancer «\u00a0hardline install\u00a0» une fois amorcé\u00a0; " +
          "le Mac reste configuré et son état antérieur enregistré\u00a0: " +
          "«\u00a0hardline uninstall\u00a0» le rend.",
      );
      process.exitCode = 1;
      return;
    }
    remote = await withSpinner("Nouvelle vérification du PC", () =>
      runRemotePreflight(CONFIG),
    );
    reportChecks(remote);
  }

  // Phase 3bis - rapatriement du relevé d'amorçage, AVANT la porte des
  // préconditions restantes. Quand cette session s'ouvre, l'amorçage a déjà
  // modifié le PC ; s'arrêter ici sur un GPU absent laissait un manifeste vide
  // et un PC dont l'adressage d'origine n'existait plus nulle part. On
  // enregistre ce qu'on peut perdre dès l'instant où on ne peut plus le perdre.
  const joignable = remote.some((c) => c.name === SSH_CHECK && c.ok);
  if (
    joignable &&
    !(await converge(CAPTURE_STEPS, "Relevé d'amorçage du PC", manifestPath))
  ) {
    return;
  }

  if (hasBlockingFailure(remote)) {
    ui.finish(
      "Installation interrompue\u00a0: le PC n'est pas prêt. " +
        (joignable
          ? "Le Mac est configuré et le relevé d'amorçage du PC enregistré\u00a0: " +
            "«\u00a0hardline install\u00a0» reprendra ici, «\u00a0hardline uninstall\u00a0» " +
            "rend les deux machines à leur état d'origine."
          : "Le Mac est configuré et son état antérieur enregistré\u00a0: " +
            "«\u00a0hardline install\u00a0» reprendra ici, «\u00a0hardline uninstall\u00a0» " +
            "rend le Mac à son état d'origine."),
    );
    process.exitCode = 1;
    return;
  }

  // Phase 4 - convergence distante.
  if (!(await converge(REMOTE_STEPS, "Convergence du PC", manifestPath))) return;
  ui.finish("Liaison établie. Vérifier avec «\u00a0hardline doctor\u00a0».");
}
