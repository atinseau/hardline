import { createMountPoints, mountPointExists, removeMountPoints } from "../lib/smb";
import type { Config } from "../config";
import type { RestoreContext, Step } from "./types";

export type MountPointState = { mountPoint: string; existed: boolean };

/** Le releve de tous les points de montage configures, existants ou non. */
async function survey(config: Config): Promise<MountPointState[]> {
  const current: MountPointState[] = [];
  for (const share of config.smb.shares) {
    current.push({
      mountPoint: share.mountPoint,
      existed: await mountPointExists(share.mountPoint),
    });
  }
  return current;
}

/**
 * Les points de montage, dans le dossier personnel de l'utilisateur.
 *
 * Ils vivaient sous /Volumes, et c'etait un cul-de-sac mesure sur la machine :
 * /Volumes appartient a root:wheel en drwxr-xr-x, donc un mkdir lance par
 * l'utilisateur y echoue en EACCES — mais surtout macOS y EFFACE les
 * repertoires vides, diskarbitrationd s'en chargeant au demontage comme au
 * redemarrage. Les repertoires crees a l'installation disparaissaient donc a
 * la premiere fermeture de session, et `up` echouait ensuite sur EACCES sans
 * pouvoir les recreer : une installation qui se defaisait toute seule.
 *
 * Sous le dossier personnel, mkdir n'a besoin d'aucun privilege, personne
 * n'efface rien, et `up` reste sans mot de passe — ce que l'exigence de
 * transparence du projet demande. Le prix est que le Finder les montre comme
 * des dossiers et non comme des volumes.
 */
export const smbMountPointsStep: Step<MountPointState[]> = {
  name: "smb-mountpoints",
  label: "Points de montage dans le dossier personnel (Mac)",

  async inspect(config: Config) {
    const current = await survey(config);
    const manquants = current.filter((s) => !s.existed).map((s) => s.mountPoint);
    const conforming = manquants.length === 0;

    return {
      conforming,
      current,
      detail: conforming
        ? `${current.length} point(s) de montage déjà en place`
        : `manquants\u00a0: ${manquants.join(", ")}`,
    };
  },

  /**
   * Relit l'etat du disque plutot que de se fier au releve d'inspect : le
   * manifeste est ecrit AVANT apply, et un passage precedent interrompu entre
   * les deux a pu creer une partie des repertoires.
   */
  async apply(config: Config) {
    const current = await survey(config);
    const manquants = current.filter((s) => !s.existed).map((s) => s.mountPoint);
    await createMountPoints(manquants);
  },

  /**
   * Retire les repertoires que hardline a crees, et SEULEMENT ceux-la : un
   * point de montage qui existait avant l'installation n'est pas le notre.
   *
   * Cette etape ne demonte rien, et ce n'est pas un oubli. smb-shares.restore
   * demonte deja TOUS les partages configures avant sa premiere instruction
   * distante (src/steps/smb-shares.ts), et cet ordre est garanti par la
   * mecanique de restauration, pas par une convention : applySteps enregistre
   * au manifeste dans l'ordre d'application et recordStep ajoute en queue,
   * tandis que revertSteps parcourt ce meme ordre INVERSE. smb-shares est
   * distante donc appliquee apres cette etape-ci, qui est locale : elle se
   * restaure donc AVANT elle. Quand ce restore passe, les repertoires sont
   * deja demontes. Un demontage ajoute ici ferait double emploi, et le test
   * d'ordre de test/steps/index.test.ts verrouille cette garantie.
   *
   * Si un rmdir echoue malgre tout — un montage qui subsiste, un fichier
   * depose dans le repertoire — l'echec se dit. Rien n'est force.
   */
  async restore(config: Config, previous: MountPointState[], _context: RestoreContext) {
    const aRetirer = previous.filter((s) => !s.existed).map((s) => s.mountPoint);
    await removeMountPoints(aRetirer);
  },
};
