import type {
  LifecycleOutcome,
  ResolvedTarget,
  TargetIntent,
  TargetLifecycle,
  ResolutionKind,
  TargetResolutionDependencies,
} from "./types";
import { DirectLinkUnavailableError } from "./link-recovery";

export type TargetResolutionRefusalReason =
  | "profile-absent"
  | "lifecycle-ineligible"
  | "invalid-lifecycle-outcome";

export class TargetResolutionRefusedError extends Error {
  constructor(
    readonly reason: TargetResolutionRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "TargetResolutionRefusedError";
  }
}

function isEligible(intent: TargetIntent, lifecycle: TargetLifecycle): boolean {
  if (lifecycle === "installed") return true;
  if (lifecycle === "uninstall-incomplete" || lifecycle === "retirement-incomplete") {
    return intent === "uninstall";
  }
  if (lifecycle === "installation-incomplete") {
    return intent === "install" || intent === "uninstall";
  }
  return false;
}

async function recordIncomplete<ProjectedConfig>(
  dependencies: TargetResolutionDependencies<ProjectedConfig>,
  profile: ResolvedTarget<ProjectedConfig>["profile"],
  intent: "install" | "uninstall",
): Promise<void> {
  if (profile.lifecycle === "retirement-incomplete") return;
  await dependencies.profiles.write(dependencies.paths.profile, {
    ...profile,
    revision: profile.revision + 1,
    lifecycle: intent === "install" ? "installation-incomplete" : "uninstall-incomplete",
  });
}

async function recordRetirementIncomplete<ProjectedConfig>(
  dependencies: TargetResolutionDependencies<ProjectedConfig>,
  profile: ResolvedTarget<ProjectedConfig>["profile"],
): Promise<ResolvedTarget<ProjectedConfig>["profile"]> {
  if (profile.lifecycle === "retirement-incomplete") return profile;
  const retiring = {
    ...profile,
    revision: profile.revision + 1,
    lifecycle: "retirement-incomplete" as const,
  };
  await dependencies.profiles.write(dependencies.paths.profile, retiring);
  return retiring;
}

export class TargetResolution<ProjectedConfig> {
  constructor(
    private readonly dependencies: TargetResolutionDependencies<ProjectedConfig>,
  ) {}

  async during<Result>(
    intent: TargetIntent,
    callback: (
      target: ResolvedTarget<ProjectedConfig>,
    ) => Promise<LifecycleOutcome<Result>>,
  ): Promise<LifecycleOutcome<Result>> {
    const { dependencies } = this;
    const lock = await dependencies.acquireLock(dependencies.paths.manifest);
    try {
      let stored = await dependencies.profiles.read(dependencies.paths.profile);
      let resolution: ResolutionKind = "validated";
      if (
        (intent === "install" ||
          (intent === "uninstall" && stored?.lifecycle === "bootstrap-incomplete")) &&
        (stored === null || stored.lifecycle === "bootstrap-incomplete") &&
        dependencies.bootstrapTarget
      ) {
        await dependencies.bootstrapTarget(stored);
        stored = await dependencies.profiles.read(dependencies.paths.profile);
        resolution = "bootstrapped";
      }
      if (!stored) {
        throw new TargetResolutionRefusedError(
          "profile-absent",
          `No Target Profile exists for ${intent}; bootstrap is required.`,
        );
      }
      if (!isEligible(intent, stored.lifecycle)) {
        throw new TargetResolutionRefusedError(
          "lifecycle-ineligible",
          `${intent} is not eligible while target is ${stored.lifecycle}.`,
        );
      }

      let profile = await dependencies.validateProfile(stored);
      if (profile.lifecycle !== "retirement-incomplete" && dependencies.recoverLink) {
        try {
          const recovered = await dependencies.recoverLink(profile);
          profile = recovered.profile;
          if (resolution !== "bootstrapped") resolution = recovered.resolution;
        } catch (error) {
          const wakeablePc =
            intent === "up" &&
            error instanceof DirectLinkUnavailableError &&
            error.diagnosis === "pc-inaccessible";
          if (!wakeablePc) throw error;
        }
      }
      if (profile.lifecycle !== "retirement-incomplete") {
        await dependencies.prepareOperation?.(profile, intent);
      }
      const target: ResolvedTarget<ProjectedConfig> = {
        config: dependencies.projectConfig(profile),
        profile,
        manifestPath: dependencies.paths.manifest,
        resolution,
      };
      let outcome: LifecycleOutcome<Result>;
      try {
        outcome = await callback(target);
      } catch (error) {
        if (intent === "install" || intent === "uninstall") {
          await recordIncomplete(dependencies, profile, intent);
        }
        throw error;
      }
      if (outcome.lifecycle === "installed" && intent === "install") {
        await dependencies.profiles.write(dependencies.paths.profile, {
          ...profile,
          revision: profile.revision + 1,
          lifecycle: "installed",
        });
      } else if (
        outcome.lifecycle === "incomplete" &&
        (intent === "install" || intent === "uninstall")
      ) {
        await recordIncomplete(dependencies, profile, intent);
      } else if (outcome.lifecycle === "terminal-incomplete" && intent === "uninstall") {
        await recordRetirementIncomplete(dependencies, profile);
      } else if (outcome.lifecycle === "ready-to-retire" && intent === "uninstall") {
        const retiring = await recordRetirementIncomplete(dependencies, profile);
        await dependencies.removeManifest(dependencies.paths.manifest);
        await dependencies.removeIdentity(retiring);
        await dependencies.profiles.remove(dependencies.paths.profile);
      } else if (outcome.lifecycle !== "unchanged") {
        throw new TargetResolutionRefusedError(
          "invalid-lifecycle-outcome",
          `Lifecycle outcome ${outcome.lifecycle} is not valid for ${intent}.`,
        );
      }
      return outcome;
    } finally {
      await lock.release();
    }
  }
}
