const STEP_LABELS: Record<string, string> = {
  "network-mac": "Static address on the direct link (Mac)",
  "moonlight-install": "Moonlight client installed (Mac)",
  "smb-credentials": "Share credentials in Keychain (Mac)",
  "smb-mountpoints": "Share mount points in the home folder (Mac)",
  "bootstrap-windows": "PC bootstrap: OpenSSH, firewall, key, and addressing (PC)",
  "network-windows": "Static address and private direct-link profile (PC)",
  "network-profile-task": "Private profile at startup (PC)",
  "apollo-install": "Apollo server installed (PC)",
  "apollo-config": "Apollo configuration and credentials (PC)",
  "apollo-service": "Apollo service at startup (PC)",
  "smb-shares": "D: and E: drive shares (PC)",
  pairing: "Mac paired with server (Mac)",
};

const CHECK_NAMES: Record<string, string> = {
  "service-mac": "Mac network service",
  "cle-publique": "Public key",
  ssh: "SSH connectivity",
  "windows-version": "Windows version",
  gpu: "NVIDIA GPU",
  "lien-windows": "Windows direct-link interface",
};

export function englishStepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

export function englishCheckName(name: string): string {
  return CHECK_NAMES[name] ?? name;
}
