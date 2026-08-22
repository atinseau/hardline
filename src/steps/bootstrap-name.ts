/**
 * Le nom de l'etape d'amorcage, isole de son implementation.
 *
 * `network-windows` doit savoir si l'amorcage passe apres lui a la
 * restauration, sans pour autant dependre du module qui le definit : ce nom est
 * une cle de manifeste, une donnee, pas un comportement.
 */
export const BOOTSTRAP_STEP_NAME = "bootstrap-windows";
