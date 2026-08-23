import { readFile } from "node:fs/promises";
import { CONFIG } from "../config";
import { CAPTURE_STEPS, LOCAL_STEPS, REMOTE_STEPS } from "../steps";
import { BOOTSTRAP_STEP_NAME } from "../steps/bootstrap-name";
import { applySteps } from "../lib/orchestrator";
import {
  acquireManifestLock,
  defaultManifestPath,
  ManifestLockedError,
  type Manifest,
  type ManifestLock,
} from "../lib/manifest";
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
import {
  backupApolloConfig,
  ForeignApolloError,
  uninstallApollo,
} from "../steps/apollo-install";
import { getSecret } from "../lib/keychain";
import { forgetPassword, providePassword } from "../steps/smb-credentials";
import type { Step } from "../steps/types";
import {
  askConfirmation,
  askSecret,
  configureOutput,
  isInteractive,
  ui,
  withSpinner,
} from "../lib/ui";

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
 * Le mot de passe Windows n'est jamais recueilli par l'etape elle-meme : les
 * etapes ne dialoguent jamais. Il est demande ici, une seule fois, avant que
 * la convergence locale ne commence, et depose dans smb-credentials par ce
 * pont.
 */
async function ensureWindowsPassword(): Promise<void> {
  if ((await getSecret("windows-account")) !== null) return;
  const password = await askSecret(
    `Mot de passe du compte Windows «\u00a0${CONFIG.smb.user}\u00a0», pour les partages\u00a0:`,
  );
  providePassword(password);
}

/**
 * Applique une phase de convergence. Une etape qui echoue ne doit pas remonter
 * nue jusqu'au CLI : l'etat anterieur de tout ce qui a ete touche est sur
 * disque, et l'utilisateur doit savoir qu'il peut reprendre ou tout rendre.
 *
 * Rend le manifeste tel qu'il est apres la phase, ou null si elle a echoue.
 * L'appelant y lit ce qui est reellement enregistre : une phase qui se termine
 * sans exception n'a pas forcement enregistre quoi que ce soit.
 */
async function converge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  label: string,
  manifestPath: string,
): Promise<Manifest | null> {
  try {
    return await applySteps(steps, CONFIG, manifestPath, ui);
  } catch (error) {
    ui.failed({ label, detail: errorMessage(error) });
    ui.finish(REPRENDRE);
    process.exitCode = 1;
    return null;
  }
}

const REPRENDRE =
  "Installation interrompue\u00a0: l'état antérieur de chaque étape touchée est " +
  "sur disque. Corriger, puis «\u00a0hardline install\u00a0» pour reprendre " +
  "ou «\u00a0hardline uninstall\u00a0» pour tout rendre.";

/**
 * La convergence distante peut buter sur un Apollo etranger : l'installation
 * s'arrete et demande, plutot que d'effacer en silence le travail de
 * quelqu'un. --yes leve la question.
 */
async function convergeRemote(
  manifestPath: string,
  options: { yes: boolean },
): Promise<boolean> {
  try {
    await applySteps(REMOTE_STEPS, CONFIG, manifestPath, ui);
    return true;
  } catch (error) {
    if (error instanceof ForeignApolloError) {
      return await handleForeignApollo(error, manifestPath, options);
    }
    ui.failed({ label: "Convergence du PC", detail: errorMessage(error) });
    ui.finish(REPRENDRE);
    process.exitCode = 1;
    return false;
  }
}

/**
 * L'etape leve et n'agit pas ; c'est la COMMANDE qui obtient le consentement,
 * puis qui efface. Aucun consentement ne transite par un drapeau global : le
 * contrat Step n'a pas de canal pour cela, et lui en inventer un pour un seul
 * cas deformerait le contrat de toutes les autres etapes.
 */
async function handleForeignApollo(
  error: ForeignApolloError,
  manifestPath: string,
  options: { yes: boolean },
): Promise<boolean> {
  const { state, hasConfig } = error;
  ui.report("Apollo étranger détecté sur le PC", [
    `Version\u00a0: ${state.version ?? "inconnue"}`,
    `Clients déjà appairés\u00a0: ${state.pairedClients}`,
    hasConfig
      ? "Sa configuration sera sauvegardée sur le PC avant d'être remplacée."
      : "Aucune configuration existante à sauvegarder.",
  ]);

  // askConfirmation rend "oui" hors terminal, ce qui est le bon defaut pour une
  // question benigne mais jamais pour celle-ci : sans ce garde-fou, un install
  // lance depuis un script effacerait l'Apollo d'un tiers sans que personne
  // n'ait repondu. Le consentement doit alors etre porte par --yes, ecrit a la
  // main dans la ligne de commande.
  if (!options.yes && !isInteractive()) {
    ui.finish(
      "Installation interrompue\u00a0: Apollo étranger conservé, rien n'a été modifié sur le PC. " +
        "Hors terminal, son remplacement doit être autorisé explicitement par " +
        "«\u00a0hardline install --yes\u00a0».",
    );
    process.exitCode = 1;
    return false;
  }

  const confirmed = await askConfirmation(
    "Remplacer cette installation d'Apollo par celle de hardline\u00a0?",
    { assumeYes: options.yes },
  );
  if (!confirmed) {
    ui.finish(
      "Installation interrompue\u00a0: Apollo étranger conservé, rien n'a été modifié sur le PC.",
    );
    process.exitCode = 1;
    return false;
  }

  // La sauvegarde precede TOUJOURS la desinstallation : l'inverse perd
  // definitivement la configuration d'un tiers, et aucun message ne la
  // rendrait.
  const backupPath = await backupApolloConfig(CONFIG);
  if (backupPath !== null) {
    ui.info(`Configuration de l'Apollo étranger sauvegardée dans ${backupPath}`);
  }
  // Le demontage tolere l'absence de ses cibles, mais ce qu'il n'a pas pu
  // faire ne se perd pas : c'est la seule occasion de le dire a l'operateur.
  for (const cede of await uninstallApollo(CONFIG)) {
    ui.warn(cede);
  }

  try {
    await applySteps(REMOTE_STEPS, CONFIG, manifestPath, ui);
    return true;
  } catch (retryError) {
    ui.failed({ label: "Convergence du PC", detail: errorMessage(retryError) });
    ui.finish(REPRENDRE);
    process.exitCode = 1;
    return false;
  }
}

/**
 * Le verrou est pris pour TOUTE l'execution, et non par phase : install ecrit
 * le manifeste trois fois, et trois verrous successifs laisseraient entre eux
 * exactement les fenetres qu'un verrou existe pour fermer.
 */
export async function installCommand(options: { yes?: boolean } = {}): Promise<void> {
  configureOutput();
  ui.start("hardline — installation");

  const manifestPath = defaultManifestPath();
  let lock: ManifestLock;
  try {
    lock = await acquireManifestLock(manifestPath);
  } catch (error) {
    if (!(error instanceof ManifestLockedError)) throw error;
    ui.failed({ label: "Manifeste", detail: errorMessage(error) });
    ui.finish("Installation abandonnée.");
    process.exitCode = 1;
    return;
  }

  try {
    await install(manifestPath, { yes: options.yes ?? false });
  } finally {
    // Quel que soit le chemin de sortie, echec compris : l'orchestrateur saute
    // apply() quand smb-credentials est deja conforme, et le mot de passe garde
    // en memoire de module survivrait alors jusqu'a la fin du processus.
    forgetPassword();
    await lock.release();
  }
}

async function install(manifestPath: string, options: { yes: boolean }): Promise<void> {
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
  await ensureWindowsPassword();
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

  // Joignable ne veut pas dire releve. Un PC amorce par une version anterieure
  // de hardline n'en porte aucun : l'etape le dit et se declare conforme sans
  // rien enregistrer, et le message ci-dessous annoncait pourtant un releve qui
  // n'existe nulle part. Le manifeste rendu par la convergence est la seule
  // source qui sache la difference : on la lui demande.
  let releveEnregistre = false;
  if (joignable) {
    const manifest = await converge(
      CAPTURE_STEPS,
      "Relevé d'amorçage du PC",
      manifestPath,
    );
    if (!manifest) return;
    releveEnregistre = BOOTSTRAP_STEP_NAME in manifest.steps;
  }

  if (hasBlockingFailure(remote)) {
    ui.finish(
      "Installation interrompue\u00a0: le PC n'est pas prêt. " +
        (releveEnregistre
          ? "Le Mac est configuré et le relevé d'amorçage du PC enregistré\u00a0: " +
            "«\u00a0hardline install\u00a0» reprendra ici, «\u00a0hardline uninstall\u00a0» " +
            "rend les deux machines à leur état d'origine."
          : joignable
            ? "Le Mac est configuré et son état antérieur enregistré, mais le PC " +
              "n'a livré aucun relevé d'amorçage exploitable\u00a0: ce que l'amorçage " +
              "a modifié ne pourra pas être défait. «\u00a0hardline install\u00a0» " +
              "reprendra ici, «\u00a0hardline uninstall\u00a0» rend le Mac à son état " +
              "d'origine."
            : "Le Mac est configuré et son état antérieur enregistré\u00a0: " +
              "«\u00a0hardline install\u00a0» reprendra ici, «\u00a0hardline uninstall\u00a0» " +
              "rend le Mac à son état d'origine."),
    );
    process.exitCode = 1;
    return;
  }

  // Phase 4 - convergence distante.
  if (!(await convergeRemote(manifestPath, options))) return;
  ui.finish("Liaison établie. Vérifier avec «\u00a0hardline doctor\u00a0».");
}
