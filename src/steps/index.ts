import { macNetworkStep } from "./network-mac";
import { windowsNetworkStep } from "./network-windows";
import { windowsProfileTaskStep } from "./network-profile-task";
import type { Step } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_STEPS: Step<any>[] = [
  macNetworkStep,
  windowsNetworkStep,
  windowsProfileTaskStep,
];
