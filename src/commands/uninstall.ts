import { CONFIG } from "../config";
import { ALL_STEPS, LOCAL_STEPS, WINDOWS_STEPS } from "../steps";
import { bootstrapWindowsStep } from "../steps/bootstrap-windows";
import { revertSteps } from "../lib/orchestrator";
import {
  acquireManifestLock,
  defaultManifestPath,
  ManifestLockedError,
  type ManifestLock,
  readManifest,
} from "../lib/manifest";
import { errorMessage } from "../lib/errors";
import { askConfirmation, configureOutput, ui } from "../lib/ui";

/**
 * Ce que la question doit nommer, deduit du manifeste et non affirme : un
 * arret en phase distante n'enregistre que le Mac, et demander a l'utilisateur
 * de tout restaurer sur les deux machines lui promettrait ce qui n'aura pas lieu.
 */
export function scopeLabel(recorded: string[]): string {
  const touches = (steps: { name: string }[]) =>
    recorded.some((name) => steps.some((s) => s.name === name));
  const mac = touches(LOCAL_STEPS);
  const pc = touches(WINDOWS_STEPS);

  if (mac && pc) return "des deux machines";
  if (mac) return "du Mac";
  if (pc) return "du PC";
  // Une etape enregistree par une version ulterieure de hardline : on ne sait
  // pas de quelle machine elle vient, on ne le pretend pas.
  return "des machines concernées";
}

/** Le libelle lisible d'une etape enregistree, ou son nom brut si inconnue. */
export function recordedLabels(recorded: string[]): string[] {
  return recorded.map(
    (name) => ALL_STEPS.find((s) => s.name === name)?.label ?? name,
  );
}

/**
 * Ce que la restauration ne rendra pas, et ce qu'elle coutera. Une restauration
 * qui tait ses propres limites est exactement la malhonnetete que le manifeste
 * existe pour eviter — et cela se dit AVANT la question, pas apres la reponse.
 *
 * Rend null quand l'amorcage n'est pas enregistre : il n'y a alors ni capacite
 * Windows ni acces SSH pose par hardline, donc rien a nuancer.
 */
export function bootstrapCaveats(recorded: string[]): string[] | null {
  if (!recorded.includes(bootstrapWindowsStep.name)) return null;

  return [
    "La fonctionnalité Windows «\u00a0OpenSSH Server\u00a0» reste installée\u00a0: la retirer",
    "exigerait un redémarrage, et un serveur SSH peut vous servir par ailleurs.",
    "Seul le service sshd est rendu à son démarrage d'origine — désactivé et",
    "arrêté s'il n'existait pas avant hardline.",
    "",
    "Tout le reste part\u00a0: clé publique du Mac, règle de pare-feu, adressage et",
    "profil réseau du lien direct. Le PC ne sera donc plus joignable en SSH, et",
    "une nouvelle installation redemandera le geste manuel d'amorçage sur le PC.",
    "",
    "Les sauvegardes de la configuration d'Apollo restent sur le PC, dans",
    "C:\\ProgramData\\hardline\\\u00a0: hardline ne les efface jamais.",
  ];
}

export async function uninstallCommand(options: { yes: boolean }): Promise<void> {
  configureOutput();
  ui.start("hardline — désinstallation");

  // Meme verrou que install, et pour la meme raison : la restauration lit et
  // reecrit le manifeste a chaque etape rendue. Une install concurrente y
  // ajouterait une entree entre deux, ou effacerait celle qu'on vient de
  // rendre.
  const manifestPath = defaultManifestPath();
  let lock: ManifestLock;
  try {
    lock = await acquireManifestLock(manifestPath);
  } catch (error) {
    if (!(error instanceof ManifestLockedError)) throw error;
    ui.failed({ label: "Manifeste", detail: errorMessage(error) });
    ui.finish("Désinstallation abandonnée.");
    process.exitCode = 1;
    return;
  }

  try {
    await uninstall(manifestPath, options);
  } finally {
    await lock.release();
  }
}

async function uninstall(
  manifestPath: string,
  options: { yes: boolean },
): Promise<void> {
  const manifest = await readManifest(manifestPath);
  const recorded = manifest.order;

  if (recorded.length === 0) {
    ui.finish("Aucune étape enregistrée\u00a0: rien à restaurer.");
    return;
  }

  ui.report("État antérieur enregistré", recordedLabels(recorded));

  const caveats = bootstrapCaveats(recorded);
  if (caveats) ui.report("Ce qui ne sera pas défait", caveats);

  const confirmed = await askConfirmation(
    `Restaurer la configuration réseau antérieure ${scopeLabel(recorded)}\u00a0?`,
    { assumeYes: options.yes },
  );
  if (!confirmed) {
    ui.finish("Rien n'a été modifié.");
    return;
  }

  const { unrestored, unconfirmed } = await revertSteps(
    ALL_STEPS,
    CONFIG,
    manifestPath,
    ui,
  );

  if (unrestored.length > 0) {
    // Leur etat anterieur reste sur disque : une version ulterieure de
    // hardline, ou un nouvel essai, pourra encore s'en servir.
    ui.warn(
      `Étapes non restaurées, conservées dans le manifeste\u00a0: ${unrestored.join(", ")}`,
    );
    ui.finish("Restauration incomplète.");
    process.exitCode = 1;
    return;
  }

  // Le seul endroit du programme ou il serait tentant d'affirmer ce qu'on ne
  // peut pas savoir. Les dernieres instructions cote PC retirent l'adresse qui
  // porte la session SSH : elles sont confiees a un processus detache, qui rend
  // la main avant d'avoir agi, et le Mac ne reverra jamais ce PC. Annoncer
  // "etat anterieur restaure" sur la foi d'un lancement, apres avoir efface
  // l'enregistrement qui decrit cet etat, serait exactement la malhonnetete que
  // le manifeste existe pour eviter.
  //
  // Le code de sortie reste 0, et la raison qui tient n'est pas seulement qu'on
  // n'a rien vu echouer : une queue detachee est la fin NORMALE d'une
  // desinstallation complete. Sortir en 1 ferait echouer toutes les
  // desinstallations reussies, et un code qui vaut toujours 1 n'apprend rien et
  // entraine l'utilisateur a l'ignorer. C'est le meme contrat que celui de
  // doctor : le code de sortie rapporte ce qui a ete OBSERVE, jamais ce qui est
  // suppose. Un echec observe prime donc et sort en 1 ; l'incertitude, elle,
  // est portee par le message, et le manifeste garde de quoi recommencer.
  if (unconfirmed.length > 0) {
    ui.warn(
      "Étapes lancées sur le PC sans confirmation possible, conservées dans " +
        `le manifeste\u00a0: ${unconfirmed.join(", ")}`,
    );
    // Le signal a nommer est celui qui DISTINGUE les deux issues. Une liaison
    // qui ne revient pas ne distingue rien : c'est ce que l'utilisateur vient
    // de demander, et c'est aussi a quoi ressemble un echec. Ce qui separe les
    // deux se lit au clavier du PC, sur son adressage et son profil reseau.
    ui.finish(
      "Restauration lancée sur le PC. Sa fin ne peut pas être observée depuis le " +
        "Mac\u00a0: les dernières instructions retirent l'adresse qui porte la session " +
        "SSH, et le PC n'y répond plus ensuite — c'est aussi ce à quoi ressemble une " +
        "réussite. Vérifier au clavier du PC qu'il a retrouvé son adressage et son " +
        "profil réseau d'origine. L'état antérieur du PC reste enregistré tant qu'il " +
        "n'est pas confirmé\u00a0: rien n'a été oublié.",
    );
    return;
  }

  ui.finish("État antérieur restauré.");
}
