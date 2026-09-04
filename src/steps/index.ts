import { bootstrapWindowsStep } from "./bootstrap-windows";
import { macNetworkStep } from "./network-mac";
import { windowsNetworkStep } from "./network-windows";
import { windowsProfileTaskStep } from "./network-profile-task";
import { windowsFastStartupStep } from "./windows-fast-startup";
import { apolloInstallStep } from "./apollo-install";
import { apolloConfigStep } from "./apollo-config";
import { apolloServiceStep } from "./apollo-service";
import { smbSharesStep } from "./smb-shares";
import { moonlightInstallStep } from "./moonlight-install";
import { pairingStep } from "./pairing";
import { smbCredentialsStep } from "./smb-credentials";
import { smbMountPointsStep } from "./smb-mountpoints";
import type { Step } from "./types";

/**
 * Etapes cote Mac. Elles convergent sans qu'aucune precondition distante ne
 * soit observable : ce sont elles qui rendent le lien routable, posent le
 * client de streaming, deposent au trousseau le mot de passe des partages, et
 * creent sous sudo les points de montage que /Volumes interdit a l'utilisateur.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LOCAL_STEPS: Step<any>[] = [
  macNetworkStep,
  moonlightInstallStep,
  smbCredentialsStep,
  smbMountPointsStep,
];

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

/**
 * Convergence cote PC, une fois toutes les preconditions passees. L'ordre
 * porte des dependances reelles : apollo-config ecrit dans un repertoire que
 * seul apollo-install cree, apollo-service demarre un service qui doit lire
 * une conf deja ecrite, et smb-shares suppose le compte Windows joignable.
 *
 * pairing est en DERNIER bien qu'elle agisse aussi cote Mac : elle exige
 * qu'Apollo tourne, donc elle ne peut pas passer avant apolloServiceStep. A la
 * restauration, qui se fait en ordre inverse, elle se defait donc EN PREMIER —
 * ce qui est egalement correct : on depaire tant que le serveur repond.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REMOTE_STEPS: Step<any>[] = [
  windowsNetworkStep,
  windowsProfileTaskStep,
  windowsFastStartupStep,
  apolloInstallStep,
  apolloConfigStep,
  apolloServiceStep,
  smbSharesStep,
  pairingStep,
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
