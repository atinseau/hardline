import { access, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../config";
import { INSTALLATION_CATALOG, getInstallationCatalog } from "../installation-catalog";
import { serveBootstrap } from "../lib/bootstrap-server";
import { acquireManifestLock } from "../lib/manifest";
import { applySteps } from "../lib/orchestrator";
import { CAPTURE_STEPS } from "../steps";
import {
  BootstrapWorkflow,
  type BootstrapWorkflowDependencies,
} from "./bootstrap-workflow";
import {
  ensureHardlineIdentity,
  hardlineKnownHostsSettings,
  materializeKnownHosts,
  removeHardlineIdentity,
} from "./hardline-identity";
import { observeMacBootstrap } from "./mac-observations";
import { DirectLinkUnavailableError, LinkRecovery } from "./link-recovery";
import { createLinkRecoveryAdapters } from "./link-recovery-adapter";
import { projectTargetConfig } from "./project-config";
import { TargetResolution } from "./resolution";
import {
  defaultTargetStatePaths,
  readTargetProfile,
  removeTargetProfile,
  writeTargetProfile,
} from "./target-profile";
import type { TargetProfile, TargetStatePaths } from "./types";

const BOOTSTRAP_DEADLINE_MS = 10 * 60_000;
export type ProductionTargetResolutionOptions = {
  readonly paths?: TargetStatePaths;
  readonly reportBootstrapCommand: (command: string) => void | Promise<void>;
  readonly chooseEthernetCandidate: BootstrapWorkflowDependencies["chooseEthernetCandidate"];
  readonly now?: () => number;
};

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function validateTargetProfile(profile: TargetProfile): Promise<TargetProfile> {
  getInstallationCatalog(profile.installationCatalogVersion);
  if (profile.sshHostKey === null) {
    throw new Error("The Target Profile has no SSH host-key checkpoint.");
  }
  if (profile.lifecycle === "retirement-incomplete") return profile;

  // An installed target must never silently replace a lost private key.
  await Promise.all([
    access(profile.hardlineIdentity.privateKeyPath),
    access(profile.hardlineIdentity.publicKeyPath),
  ]);
  const identity = await ensureHardlineIdentity({
    directory: dirname(profile.hardlineIdentity.privateKeyPath),
  });
  if (
    identity.privateKeyPath !== profile.hardlineIdentity.privateKeyPath ||
    identity.publicKeyPath !== profile.hardlineIdentity.publicKeyPath
  ) {
    throw new Error("The Target Profile references a non-canonical Hardline Identity.");
  }
  const sshTrust = hardlineKnownHostsSettings(identity.privateKeyPath);
  await materializeKnownHosts({ sshHostKey: profile.sshHostKey }, sshTrust.materialization);
  return profile;
}

export function createTargetResolution(
  options: ProductionTargetResolutionOptions,
): TargetResolution<Config> {
  const paths = options.paths ?? defaultTargetStatePaths();
  const now = options.now ?? Date.now;
  const profiles = {
    read: readTargetProfile,
    write: writeTargetProfile,
    remove: removeTargetProfile,
  };

  return new TargetResolution<Config>({
    paths,
    profiles,
    acquireLock: acquireManifestLock,
    validateProfile: validateTargetProfile,
    projectConfig: projectTargetConfig,
    recoverLink: async (profile) =>
      new LinkRecovery(
        createLinkRecoveryAdapters({ profile, profilePath: paths.profile }),
      ).recover(profile),
    prepareOperation: async (profile, intent) => {
      if (intent === "install" || intent === "uninstall") {
        await applySteps(
          CAPTURE_STEPS,
          projectTargetConfig(profile),
          paths.manifest,
          () => {},
        );
      }
    },
    removeManifest: unlinkIfPresent,
    removeIdentity: async (profile) => {
      await removeHardlineIdentity(profile.hardlineIdentity);
      await unlinkIfPresent(
        hardlineKnownHostsSettings(profile.hardlineIdentity.privateKeyPath).target.knownHostsFile,
      );
    },
    bootstrapTarget: async (existing) => {
      if (existing?.sshHostKey) {
        try {
          const validated = await validateTargetProfile(existing);
          const resumed = await new LinkRecovery(
            createLinkRecoveryAdapters({ profile: validated, profilePath: paths.profile }),
          ).recover(validated);
          await profiles.write(paths.profile, {
            ...resumed.profile,
            revision: resumed.profile.revision + 1,
            lifecycle: "installation-incomplete",
          });
          return;
        } catch (error) {
          if (!(error instanceof DirectLinkUnavailableError)) throw error;
        }
      }
      const workflow = new BootstrapWorkflow({
        observeMac: observeMacBootstrap,
        ensureIdentity: ensureHardlineIdentity,
        readPublicKey: async (path) => (await readFile(path, "utf8")).trim(),
        serve: serveBootstrap,
        profiles,
        profilePath: paths.profile,
        installationCatalogVersion: INSTALLATION_CATALOG.version,
        now,
        deadline: now() + BOOTSTRAP_DEADLINE_MS,
        reportCommand: options.reportBootstrapCommand,
        chooseEthernetCandidate: options.chooseEthernetCandidate,
      });
      try {
        await workflow.run(existing);
      } catch (error) {
        if (existing === null && (await profiles.read(paths.profile)) === null) {
          await removeHardlineIdentity(await ensureHardlineIdentity());
        }
        throw error;
      }
    },
  });
}
