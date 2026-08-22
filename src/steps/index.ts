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

/** Etapes cote PC, atteignables seulement une fois LOCAL_STEPS appliquees. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REMOTE_STEPS: Step<any>[] = [windowsNetworkStep, windowsProfileTaskStep];

/**
 * L'ordre local puis distant est une contrainte de surete : uninstall defait
 * dans l'ordre inverse, donc le PC est restaure tant que le Mac porte encore
 * son adresse et que la session SSH tient.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_STEPS: Step<any>[] = [...LOCAL_STEPS, ...REMOTE_STEPS];
