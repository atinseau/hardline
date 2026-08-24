export * from "./types";
export * from "./run";
export * from "./text";
export * from "./clack";

import { ClackOutput } from "./clack";
import { TextOutput } from "./text";
import type { CommandOutput } from "./types";

export function createCommandOutput(options: {
  verbose: boolean;
  interactive?: boolean;
}): CommandOutput {
  const interactive =
    options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return interactive
    ? new ClackOutput(undefined, { verbose: options.verbose })
    : new TextOutput({ verbose: options.verbose });
}
