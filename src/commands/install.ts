import { readFile } from "node:fs/promises";
import { CONFIG } from "../config";
import { ALL_STEPS } from "../steps";
import { applySteps } from "../lib/orchestrator";
import { defaultManifestPath } from "../lib/manifest";
import type { CheckResult } from "../lib/preflight";
import {
  SSH_CHECK,
  hasBlockingFailure,
  runPreflight,
  waitForRemote,
} from "../lib/preflight";
import { localBootstrapUrl, serveBootstrap } from "../lib/bootstrap-server";
import { configureOutput, ui, withSpinner } from "../lib/ui";

const BOOTSTRAP_DEADLINE_MS = 10 * 60_000;

function reportChecks(checks: CheckResult[]): void {
  for (const check of checks) {
    if (check.ok) ui.info(`${check.name} — ${check.detail}`);
    else if (check.blocking) ui.failed({ label: check.name, detail: check.detail });
    else ui.warn(`${check.name} — ${check.detail}`);
  }
}

async function readPublicKey(): Promise<string> {
  const path = `${CONFIG.ssh.identityFile}.pub`;
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    throw new Error(
      `Clé publique introuvable\u00a0: ${path}. La créer avec ` +
        `«\u00a0ssh-keygen -t ed25519 -f ${CONFIG.ssh.identityFile}\u00a0».`,
    );
  }
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

export async function installCommand(): Promise<void> {
  configureOutput();
  ui.start("hardline — installation");

  let checks = await withSpinner("Vérification des préconditions", () =>
    runPreflight(CONFIG),
  );
  reportChecks(checks);

  // Un echec bloquant cote Mac n'a rien a faire sur le PC : envoyer
  // l'utilisateur amorcer une machine pour dix minutes ne le reglerait pas.
  const blocking = checks.filter((c) => !c.ok && c.blocking);
  const sshSeulBloque = blocking.length === 1 && blocking[0]?.name === SSH_CHECK;

  if (sshSeulBloque) {
    if (!(await bootstrapRemote())) {
      ui.finish(
        "Le PC n'a pas répondu. Relancer «\u00a0hardline install\u00a0» une fois amorcé.",
      );
      process.exitCode = 1;
      return;
    }
    checks = await withSpinner("Nouvelle vérification des préconditions", () =>
      runPreflight(CONFIG),
    );
    reportChecks(checks);
  }

  if (hasBlockingFailure(checks)) {
    ui.finish("Installation interrompue\u00a0: une précondition n'est pas satisfaite.");
    process.exitCode = 1;
    return;
  }

  await applySteps(ALL_STEPS, CONFIG, defaultManifestPath(), ui);
  ui.finish("Liaison établie. Vérifier avec «\u00a0hardline doctor\u00a0».");
}
