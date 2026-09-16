import type { Config } from "../config";

export type TargetLifecycle =
  | "bootstrap-incomplete"
  | "installation-incomplete"
  | "installed"
  | "uninstall-incomplete"
  | "retirement-incomplete";

export type DirectLink = {
  readonly subnet: string;
  readonly macAddress: string;
  readonly windowsAddress: string;
  /**
   * Absent sur un lien direct, ou le /30 est impose par hardline. Present sur
   * un lien partage, ou le prefixe appartient au reseau deja en place.
   */
  readonly prefixLength?: number;
};

/**
 * La nature du chemin par lequel hardline opere le PC.
 *
 * `direct` : un adaptateur libre a chaque bout, dont hardline possede
 * l'adressage. Il alloue le /30, le pose, et le rend a la desinstallation.
 *
 * `shared` : un reseau qui existait avant hardline et qui lui survivra. Les
 * deux machines s'y voient deja ; hardline OBSERVE cet adressage et n'y touche
 * jamais. Rien a poser, donc rien a rendre.
 */
export type LinkKind = "direct" | "shared";

/** Les deux bouts d'un lien, et l'adressage qui les relie. */
export type LinkEndpoints = {
  readonly mac: {
    readonly hardwareId: string;
    readonly macAddress: string;
    readonly interfaceId: string;
    readonly serviceName: string;
  };
  readonly windows: {
    readonly hardwareId: string;
    readonly macAddress: string;
    readonly interfaceAlias: string;
    readonly wireless?: boolean;
  };
  readonly directLink: DirectLink;
};

export type TargetProfile = {
  readonly version: 1;
  readonly revision: number;
  readonly lifecycle: TargetLifecycle;
  /** Absent vaut `direct` : les profils anterieurs decrivent tous un cable. */
  readonly linkKind?: LinkKind;
  /**
   * Le lien dedie que hardline connait mais n'emprunte pas en ce moment.
   *
   * L'asymetrie avec le lien partage est voulue, et elle dit quelque chose de
   * vrai : un lien partage se RETROUVE par simple observation, les deux machines
   * y portant deja leurs adresses. Un lien dedie, non — son adressage, hardline
   * l'a ecrit, et personne d'autre ne sait le decrire. Debrancher le cable ne
   * l'efface pas : les deux interfaces gardent leurs adresses, le lien attend.
   * Ce champ est cette memoire, et il n'existe que pendant qu'un lien partage
   * tient la place.
   */
  readonly dormantLink?: LinkEndpoints;
  readonly mac: {
    readonly machineId: string;
    readonly hostAliases: readonly string[];
    readonly ethernet: {
      readonly hardwareId: string;
      readonly macAddress: string;
      readonly interfaceId: string;
      readonly serviceName: string;
    };
  };
  readonly windows: {
    readonly machineId: string;
    readonly hostAliases: readonly string[];
    readonly administrator: string;
    readonly smbUser: string;
    readonly ethernet: {
      readonly hardwareId: string;
      readonly macAddress: string;
      readonly interfaceAlias: string;
      /**
       * Vrai quand le PC est relie par radio. Un paquet magique ne traverse pas
       * le Wi-Fi depuis une machine eteinte : la carte n'est plus alimentee. Le
       * fait est releve ici pour que le reveil le DISE au lieu d'attendre trois
       * minutes un PC qui ne peut pas repondre. Absent des profils anterieurs,
       * ecrits quand le lien etait toujours un cable.
       */
      readonly wireless?: boolean;
    };
  };
  readonly directLink: DirectLink;
  readonly pendingMigration?: {
    readonly operation: "initial-link" | "migration";
    readonly oldLink: DirectLink;
    readonly proposedLink: DirectLink;
  };
  readonly hardlineIdentity: {
    readonly privateKeyPath: string;
    readonly publicKeyPath: string;
  };
  readonly sshHostKey: {
    readonly algorithm: string;
    readonly publicKey: string;
  } | null;
  readonly installationCatalogVersion: string;
};

export type TargetStatePaths = {
  readonly profile: string;
  readonly manifest: string;
};

export type TargetIntent = "install" | "up" | "down" | "doctor" | "uninstall";
export type ResolutionKind = "validated" | "recovered" | "bootstrapped";

export type ResolvedTarget<ProjectedConfig = Config> = {
  readonly config: ProjectedConfig;
  readonly profile: TargetProfile;
  readonly manifestPath: string;
  readonly resolution: ResolutionKind;
};

export type LifecycleOutcome<Result> =
  | { readonly lifecycle: "unchanged"; readonly result: Result }
  | { readonly lifecycle: "installed"; readonly result: Result }
  | { readonly lifecycle: "incomplete"; readonly result: Result }
  | { readonly lifecycle: "terminal-incomplete"; readonly result: Result }
  | { readonly lifecycle: "ready-to-retire"; readonly result: Result };

export type TargetProfileStore = {
  read(path: string): Promise<TargetProfile | null>;
  write(path: string, profile: TargetProfile): Promise<void>;
  remove(path: string): Promise<void>;
};

export type TargetLock = { release(): Promise<void> };

export type TargetResolutionDependencies<ProjectedConfig = Config> = {
  readonly paths: TargetStatePaths;
  readonly profiles: TargetProfileStore;
  readonly acquireLock: (manifestPath: string) => Promise<TargetLock>;
  readonly validateProfile: (profile: TargetProfile) => Promise<TargetProfile>;
  readonly projectConfig: (profile: TargetProfile) => ProjectedConfig;
  readonly removeManifest: (manifestPath: string) => Promise<void>;
  readonly removeIdentity: (profile: TargetProfile) => Promise<void>;
  readonly bootstrapTarget?: (profile: TargetProfile | null) => Promise<void>;
  readonly recoverLink?: (
    profile: TargetProfile,
  ) => Promise<{
    readonly profile: TargetProfile;
    readonly resolution: "validated" | "recovered";
  }>;
  readonly prepareOperation?: (
    profile: TargetProfile,
    intent: TargetIntent,
  ) => Promise<void>;
};
