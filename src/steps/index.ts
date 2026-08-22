import { bootstrapWindowsStep } from "./bootstrap-windows";
import { macNetworkStep } from "./network-mac";
import { windowsNetworkStep } from "./network-windows";
import { windowsProfileTaskStep } from "./network-profile-task";
import type { Step } from "./types";

/**
 * Etapes cote Mac. Elles convergent sans qu'aucune precondition distante ne
 * soit observable : ce sont elles qui rendent le lien routable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LOCAL_STEPS: Step<any>[] = [macNetworkStep];

/**
 * Ce qui doit entrer au manifeste des que la session SSH repond, AVANT toute
 * porte de precondition. L'amorcage a deja modifie le PC quand cette session
 * s'ouvre ; attendre la convergence distante pour rapatrier son releve, c'est
 * accepter qu'un blocage sur le GPU laisse un manifeste vide et un PC dont
 * l'adressage d'origine n'existe plus nulle part. On enregistre ce qu'on peut
 * perdre des l'instant ou on ne peut plus le perdre.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CAPTURE_STEPS: Step<any>[] = [bootstrapWindowsStep];

/** Etapes de convergence cote PC, une fois toutes les preconditions passees. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REMOTE_STEPS: Step<any>[] = [
  windowsNetworkStep,
  windowsProfileTaskStep,
];

/**
 * L'ordre local, puis rapatriement, puis distant est une contrainte de surete :
 * uninstall defait dans l'ordre inverse, donc le PC est restaure tant que le
 * Mac porte encore son adresse et que la session SSH tient.
 *
 * L'amorcage vient avant les etapes de convergence, donc il est restaure APRES
 * elles : c'est la couche la plus profonde, et son releve est le seul a decrire
 * le PC d'avant hardline. Sur l'adressage, il doit avoir le dernier mot — ce
 * que windowsNetworkStep a enregistre comme « etat anterieur » n'est que l'etat
 * d'apres amorcage, puisque cette etape ne peut observer le PC qu'une fois SSH
 * ouvert, c'est-a-dire une fois l'amorcage passe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_STEPS: Step<any>[] = [
  ...LOCAL_STEPS,
  ...CAPTURE_STEPS,
  ...REMOTE_STEPS,
];

/** Tout ce qui touche au PC, quelle que soit la phase qui l'applique. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WINDOWS_STEPS: Step<any>[] = [...CAPTURE_STEPS, ...REMOTE_STEPS];
