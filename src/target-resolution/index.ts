export {
  CorruptTargetProfileError,
  defaultTargetStatePaths,
  readTargetProfile,
  removeTargetProfile,
  UnsupportedTargetProfileVersionError,
  writeTargetProfile,
} from "./target-profile";
export {
  TargetResolution,
  TargetResolutionRefusedError,
} from "./resolution";
export { createTargetResolution } from "./factory";
export { projectTargetConfig } from "./project-config";
export type { TargetResolutionRefusalReason } from "./resolution";
export type {
  LifecycleOutcome,
  ResolvedTarget,
  TargetIntent,
  TargetLifecycle,
  TargetLock,
  TargetProfile,
  TargetProfileStore,
  TargetResolutionDependencies,
  TargetStatePaths,
} from "./types";
