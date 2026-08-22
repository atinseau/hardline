import { homedir } from "node:os";
import { join } from "node:path";
import type { SSHTarget } from "./lib/ssh";

export type Config = {
  mac: { serviceName: string; ip: string; subnetMask: string };
  windows: { interfaceAlias: string; ip: string; prefixLength: number };
  ssh: SSHTarget;
  bootstrapPort: number;
};

export const CONFIG: Config = {
  mac: {
    serviceName: "AX88179A",
    ip: "10.10.10.2",
    subnetMask: "255.255.255.0",
  },
  windows: {
    interfaceAlias: "Ethernet",
    ip: "10.10.10.1",
    prefixLength: 24,
  },
  ssh: {
    host: "10.10.10.1",
    user: "arthur",
    identityFile: join(homedir(), ".ssh", "id_ed25519_winpc"),
    connectTimeoutSec: 8,
  },
  bootstrapPort: 8080,
};
