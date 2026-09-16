import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config";
import { INSTALLATION_CATALOG } from "../../src/installation-catalog";

export type { Config };

export const CONFIG: Config = {
  linkKind: "direct",
  mac: {
    serviceName: "AX88179A",
    ip: "10.10.10.2",
    subnetMask: "255.255.255.0",
  },
  windows: {
    interfaceAlias: "Ethernet",
    ip: "10.10.10.1",
    prefixLength: 24,
    macAddress: "E8-9C-25-2A-70-E1",
    wireless: false,
  },
  ssh: {
    host: "10.10.10.1",
    user: "arthur",
    identityFile: join(homedir(), ".ssh", "id_ed25519_winpc"),
    knownHostsFile: join(homedir(), ".ssh", "known_hosts"),
    hostKeyAlias: "hardline-test-windows",
    connectTimeoutSec: 8,
  },
  bootstrapPort: 8080,
  apollo: INSTALLATION_CATALOG.apollo,
  moonlight: INSTALLATION_CATALOG.moonlight,
};
