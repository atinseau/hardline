import type {
  BootstrapServer,
  BootstrapServerOptions,
} from "../lib/bootstrap-server";
import {
  prepareBootstrapTarget,
  type AskLink,
  type MacBootstrapObservations,
} from "./bootstrap-target";
import {
  BootstrapHostKeyConflictError,
  type HostKeyCheckpoint,
  type HostKeyObservation,
} from "./bootstrap-protocol";
import type { HardlineIdentityPaths } from "./hardline-identity";
import { canonicalEthernetHardwareId } from "./network";
import type { TargetProfile, TargetProfileStore } from "./types";

export type BootstrapWorkflowDependencies = Readonly<{
  observeMac: () => MacBootstrapObservations | Promise<MacBootstrapObservations>;
  ensureIdentity: () => HardlineIdentityPaths | Promise<HardlineIdentityPaths>;
  readPublicKey: (publicKeyPath: string) => string | Promise<string>;
  serve: (options: BootstrapServerOptions) => Promise<BootstrapServer>;
  profiles: TargetProfileStore;
  profilePath: string;
  installationCatalogVersion: string;
  now: () => number;
  deadline: number;
  /**
   * Rend, s'il y a lieu, de quoi defaire ce que le rapport a installe. Le
   * rapport reste vivant tant que le PC n'a pas repondu : c'est la fenetre
   * pendant laquelle l'operateur peut encore demander la commande.
   */
  reportCommand: (command: string) => void | (() => void) | Promise<void | (() => void)>;
  ask: AskLink;
}>;

export class BootstrapIdentityPathMismatchError extends Error {
  readonly code = "BOOTSTRAP_IDENTITY_PATH_MISMATCH";

  constructor() {
    super("The Target Profile references a different Hardline Identity.");
    this.name = "BootstrapIdentityPathMismatchError";
  }
}

export class BootstrapResumeMismatchError extends Error {
  readonly code = "BOOTSTRAP_RESUME_MISMATCH";

  constructor(
    readonly machine: "mac" | "windows",
    readonly fact: "machine-id" | "hardware-id",
  ) {
    super(
      `this ${machine} is not the one the existing pairing describes (${fact === "machine-id" ? "machine identity" : "selected hardware"} differs). ` +
        "Run 'hardline uninstall' to retire that pairing before starting another.",
    );
    this.name = "BootstrapResumeMismatchError";
  }
}

export class BootstrapWorkflowTimeoutError extends Error {
  readonly code = "BOOTSTRAP_WORKFLOW_TIMEOUT";

  constructor() {
    super(
      "the PC never answered. Run 'hardline install' again when you are at its keyboard, and paste the command into an Administrator PowerShell.",
    );
    this.name = "BootstrapWorkflowTimeoutError";
  }
}

export class BootstrapWorkflow {
  constructor(private readonly dependencies: BootstrapWorkflowDependencies) {}

  async run(existing: TargetProfile | null): Promise<TargetProfile> {
    const identityPaths = await this.dependencies.ensureIdentity();
    if (
      existing !== null &&
      (existing.hardlineIdentity.privateKeyPath !== identityPaths.privateKeyPath ||
        existing.hardlineIdentity.publicKeyPath !== identityPaths.publicKeyPath)
    ) {
      throw new BootstrapIdentityPathMismatchError();
    }
    const [mac, publicKey] = await Promise.all([
      this.dependencies.observeMac(),
      this.dependencies.readPublicKey(identityPaths.publicKeyPath),
    ]);
    if (existing !== null) {
      assertResumeFact("mac", "machine-id", existing.mac.machineId, mac.machineId);
      const selectedMac = mac.adapters.find(
        (adapter) =>
          canonicalEthernetHardwareId(adapter.macAddress) === existing.mac.ethernet.hardwareId &&
          normalizedMacAddress(adapter.macAddress) ===
            normalizedMacAddress(existing.mac.ethernet.macAddress),
      );
      if (!selectedMac) {
        throw new BootstrapResumeMismatchError("mac", "hardware-id");
      }
      if (
        normalizedMacAddress(selectedMac.macAddress) !==
        normalizedMacAddress(existing.mac.ethernet.macAddress)
      ) {
        throw new BootstrapResumeMismatchError("mac", "hardware-id");
      }
    }
    const checkpoint = Promise.withResolvers<TargetProfile>();
    let pendingProfile: TargetProfile | undefined;
    const server = await this.dependencies.serve({
      expiresAt: this.dependencies.deadline,
      now: this.dependencies.now,
      prepareTarget: async (windows) => {
        try {
          if (existing !== null) {
            assertResumeFact(
              "windows",
              "machine-id",
              existing.windows.machineId,
              windows.machineId,
            );
            const adapter = windows.networkAdapters.find(
              (candidate) => candidate.hardwareId === existing.windows.ethernet.hardwareId,
            );
            if (!adapter) {
              throw new BootstrapResumeMismatchError("windows", "hardware-id");
            }
            assertResumeHardware("windows", existing.windows.ethernet, adapter);
            const observedHostKey = windows.openSsh.hostKey;
            if (existing.sshHostKey !== null) {
              if (!observedHostKey) throw new BootstrapHostKeyConflictError();
              const publicKey = normalizedHostPublicKey(observedHostKey);
              if (
                existing.sshHostKey.algorithm !== observedHostKey.algorithm ||
                existing.sshHostKey.publicKey !== publicKey
              ) {
                throw new BootstrapHostKeyConflictError();
              }
            }
            const selectedMac = mac.adapters.find(
              (candidate) =>
                canonicalEthernetHardwareId(candidate.macAddress) ===
                  existing.mac.ethernet.hardwareId &&
                normalizedMacAddress(candidate.macAddress) ===
                  normalizedMacAddress(existing.mac.ethernet.macAddress),
            )!;
            pendingProfile = {
              ...existing,
              revision: existing.revision + 1,
              mac: {
                ...existing.mac,
                hostAliases: mac.hostAliases,
                ethernet: {
                  ...existing.mac.ethernet,
                  interfaceId: selectedMac.stableId,
                  serviceName: selectedMac.alias,
                },
              },
              windows: {
                ...existing.windows,
                hostAliases: [windows.computerName].filter(Boolean),
                ethernet: {
                  ...existing.windows.ethernet,
                  interfaceAlias: adapter.alias,
                },
              },
            };
            await this.dependencies.profiles.write(
              this.dependencies.profilePath,
              pendingProfile,
            );
            const shared = (existing.linkKind ?? "direct") === "shared";
            return {
              directLink: {
                interfaceAlias: adapter.alias,
                address: shared ? null : existing.directLink.windowsAddress,
                prefixLength: existing.directLink.prefixLength ?? 30,
                networkCategory: shared ? null : ("Private" as const),
              },
              ssh: {
                installServer: windows.openSsh.capabilityState !== "Installed",
                startService:
                  windows.openSsh.serviceStartType !== "Automatic" ||
                  windows.openSsh.serviceStatus !== "Running",
                openFirewall: !windows.openSsh.firewallRulePresent,
                firewallRemoteAddress: shared ? existing.directLink.subnet : null,
                administratorPublicKey: publicKey,
              },
            };
          }
          const prepared = await prepareBootstrapTarget({
            mac,
            windows,
            identity: { ...identityPaths, publicKey },
            installationCatalogVersion: this.dependencies.installationCatalogVersion,
            ask: this.dependencies.ask,
          });
          pendingProfile = {
            ...prepared.profile,
            revision: 1,
          };
          await this.dependencies.profiles.write(this.dependencies.profilePath, pendingProfile);
          return prepared.plan;
        } catch (error) {
          checkpoint.reject(error);
          throw error;
        }
      },
      persistHostKey: async (hostKey) => {
        try {
          const profile = this.completedProfile(pendingProfile, hostKey);
          await this.dependencies.profiles.write(this.dependencies.profilePath, profile);
          checkpoint.resolve(profile);
        } catch (error) {
          checkpoint.reject(error);
          throw error;
        }
      },
    });

    try {
      const endReport = await this.dependencies.reportCommand(server.command);
      return await waitForCheckpoint(
        checkpoint.promise,
        this.dependencies.deadline - this.dependencies.now(),
      ).finally(() => endReport?.());
    } finally {
      await server.stop();
    }
  }

  private completedProfile(
    pendingProfile: TargetProfile | undefined,
    hostKey: HostKeyCheckpoint,
  ): TargetProfile {
    if (!pendingProfile) throw new Error("The Bootstrap Rendezvous has no prepared Target Profile.");
    if (hostKey.machineId !== pendingProfile.windows.machineId) {
      throw new BootstrapResumeMismatchError("windows", "machine-id");
    }
    const publicKey = normalizedHostPublicKey(hostKey);
    if (
      pendingProfile.sshHostKey !== null &&
      (pendingProfile.sshHostKey.algorithm !== hostKey.algorithm ||
        pendingProfile.sshHostKey.publicKey !== publicKey)
    ) {
      throw new BootstrapHostKeyConflictError();
    }
    return {
      ...pendingProfile,
      revision: pendingProfile.revision + 1,
      lifecycle: "installation-incomplete",
      sshHostKey: { algorithm: hostKey.algorithm, publicKey },
    };
  }
}

function normalizedHostPublicKey(hostKey: HostKeyObservation): string {
  const fields = hostKey.publicKey.trim().split(/\s+/);
  const publicKey = fields[0] === hostKey.algorithm ? fields[1] : fields[0];
  if (!publicKey) throw new Error("The Bootstrap Rendezvous returned an invalid SSH host key.");
  return publicKey;
}

function normalizedMacAddress(value: string): string {
  return value.toLowerCase().replaceAll("-", ":");
}

function assertResumeFact(
  machine: "mac" | "windows",
  fact: "machine-id" | "hardware-id",
  expected: string,
  actual: string,
): void {
  if (expected !== actual) throw new BootstrapResumeMismatchError(machine, fact);
}

function assertResumeHardware(
  machine: "mac" | "windows",
  expected: { readonly hardwareId: string; readonly macAddress: string },
  actual: { readonly hardwareId: string; readonly macAddress: string },
): void {
  if (
    expected.hardwareId !== actual.hardwareId ||
    expected.macAddress !== actual.macAddress
  ) {
    throw new BootstrapResumeMismatchError(machine, "hardware-id");
  }
}

function waitForCheckpoint<T>(checkpoint: Promise<T>, delayMs: number): Promise<T> {
  if (delayMs <= 0) return Promise.reject(new BootstrapWorkflowTimeoutError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BootstrapWorkflowTimeoutError()),
      Math.max(0, delayMs),
    );
    void checkpoint.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
