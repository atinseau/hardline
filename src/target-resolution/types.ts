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
};

export type TargetProfile = {
  readonly version: 1;
  readonly revision: number;
  readonly lifecycle: TargetLifecycle;
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
