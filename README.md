# Hardline

Hardline turns a Windows PC into a reversible, one-command workstation for a Mac over a dedicated Ethernet cable.

It discovers the two physical adapters, allocates a collision-free private `/30`, bootstraps Windows through one pasted PowerShell command, installs and configures Apollo and Moonlight, and remembers the paired machines for later sessions.

```text
Mac  <========== dedicated Ethernet ==========>  Windows PC
     Hardline CLI + Moonlight                    Apollo + OpenSSH
```

> [!WARNING]
> Hardline is an early, hardware-oriented project. It currently builds for Apple Silicon macOS and targets Windows 11. Read the requirements and limitations before running it on machines you care about.

## What It Does

- Discovers the physical Ethernet link without relying on adapter names.
- Selects an unused private `/30` from observations on both machines.
- Bootstraps Windows over ephemeral HTTPS with certificate pinning and a one-use token.
- Generates a dedicated Ed25519 SSH identity and strictly pins the Windows host key.
- Installs a fixed, integrity-checked Apollo and Moonlight toolchain.
- Opens the Windows desktop with `hardline up`, using the Mac's main display by default.
- Detects address drift and route collisions, then repairs the Direct Link make-before-break.
- Records original state before mutation and restores it in reverse order during uninstall.

## Requirements

### Mac

- Apple Silicon Mac running macOS.
- A physical Ethernet port or USB/Thunderbolt Ethernet adapter.
- [Homebrew](https://brew.sh/) available as `brew`.
- Administrator access for network configuration.
- [Bun 1.4+](https://bun.sh/) and the Swift compiler when building from source.

### Windows PC

- Windows 11.
- A physical Ethernet adapter connected directly to the Mac.
- An Administrator PowerShell for the one-time Bootstrap Rendezvous.
- Internet access during installation for Windows OpenSSH and Apollo artifacts.
- A GPU and Apollo-compatible rendering setup. Current rendering behavior is primarily tested with NVIDIA hardware.

No existing SSH key is required. Hardline creates and owns a separate identity under `~/Library/Application Support/Hardline`.

## Build

There are no published binaries yet. Build the current source on the Mac:

```bash
git clone https://github.com/atinseau/hardline.git
cd hardline
bun install
bun run build
sudo install -m 0755 dist/hardline /usr/local/bin/hardline
```

The build compiles the macOS display probe and produces an Apple Silicon executable at `dist/hardline`.

For development, run the TypeScript entry point directly:

```bash
bun run dev -- --help
```

## Install

1. Connect the Mac and Windows PC with an Ethernet cable.
2. On the Mac, start installation:

   ```bash
   hardline install
   ```

3. Hardline prints one command. Paste it into an **Administrator PowerShell** on Windows.
4. Leave both terminals open. Installation resumes automatically after the PC authenticates with the Bootstrap Rendezvous.
5. Verify the result:

   ```bash
   hardline doctor
   ```

If multiple equivalent physical adapters remain, Hardline presents their hardware, MAC, speed, and link facts and asks which one to use. Otherwise selection is automatic.

## Usage

Open the Windows work session:

```bash
hardline up
```

Useful overrides:

```bash
hardline up --fullscreen
hardline up --resolution 2560x1440 --fps 120
hardline up --monitor
```

Diagnose the paired machines and Direct Link:

```bash
hardline doctor
```

Re-run convergence after an interrupted or partial installation:

```bash
hardline install
```

Show completed operation details with any command:

```bash
hardline --verbose doctor
```

## Uninstall

```bash
hardline uninstall
```

Uninstall restores observable Windows state before cutting the control channel, launches one final self-contained Windows cleanup tail, and then removes Hardline-owned local state from the Mac.

Two deliberate exceptions remain:

- Windows OpenSSH Server stays installed because removing the capability can require a restart.
- An Apollo Rescue Backup created for a pre-existing Apollo installation remains under `C:\ProgramData\hardline\` for the operator.

The final Windows tail becomes physically unobservable after it removes the Direct Link. Hardline reports that cleanup as **launched**, not falsely as verified.

## Safety Model

Hardline treats an IP address as location, never identity.

- The Target Profile binds Mac identity, Windows identity, Ethernet hardware identities, MAC addresses, and the Windows SSH host key.
- Every command enters through the same target-resolution seam and holds one shared lock through validation, execution, and lifecycle changes.
- The Bootstrap Rendezvous sends observations before authorizing mutation and persists an incomplete Target Profile first.
- SSH uses only the Hardline Identity, disables agent/default-key influence, and requires the pinned host key.
- Alternate Wi-Fi or LAN connectivity is a read-only Recovery Channel. Machine mutation remains confined to the physical Direct Link.
- Link Recovery journals its intent before mutation, adds new addresses before removing old ones, and proves strict SSH on the new link first.
- Step state is written to the restoration manifest before each mutation.

Generated state lives under:

```text
~/.config/hardline/
~/Library/Application Support/Hardline/
```

The Target Profile is generated, atomically replaced, owner-readable, and tamper-evident. Manual edits are rejected.

## Commands

| Command | Purpose |
|---|---|
| `hardline install` | Discover, bootstrap, and converge both machines |
| `hardline up` | Validate or repair the link, then open the Windows session |
| `hardline doctor` | Diagnose the link and managed services |
| `hardline uninstall` | Restore recorded state and retire the pair |

Use `hardline <command> --help` for command-specific flags.

## Development

```bash
bun test --isolate
bunx tsc --noEmit
bun run build
```

The central module is `src/target-resolution/`. Existing product convergence remains implemented as transactional `Step` modules under `src/steps/`.

The current architecture and acceptance criteria are documented in [the automatic target resolution spec](.scratch/automatic-target-resolution/spec.md).
