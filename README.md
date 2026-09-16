# Hardline

Hardline turns a Windows PC into a reversible, one-command workstation for a Mac.

It finds a path between the two machines, bootstraps Windows through one pasted PowerShell command, installs and configures Apollo and Moonlight, and remembers the paired machines for later sessions.

A dedicated Ethernet cable is what it looks for first, and what it is built around. When there is one, Hardline owns that link end to end: it allocates a collision-free private `/30` and gives it back on uninstall.

```text
Mac  <========== dedicated Ethernet ==========>  Windows PC
     Hardline CLI + Moonlight                    Apollo + OpenSSH
```

When no free adapter is available at both ends, Hardline falls back to a network the two machines already share — Wi-Fi, the house LAN, a mix of both. There it changes no addressing at all: it reads where each machine already is and uses it. Read [Shared links](#shared-links) before relying on that mode; it is a convenience, not an equivalent.

```text
Mac  ---- Wi-Fi ----> router <---- Ethernet ---- Windows PC
```

> [!WARNING]
> Hardline is an early, hardware-oriented project. It currently builds for Apple Silicon macOS and targets Windows 11. Read the requirements and limitations before running it on machines you care about.

## What It Does

- Discovers the link without relying on adapter names, on a cable when there is one and on a shared network otherwise.
- Selects an unused private `/30` from observations on both machines, on a dedicated link only.
- Bootstraps Windows over ephemeral HTTPS with certificate pinning and a one-use token.
- Generates a dedicated Ed25519 SSH identity and strictly pins the Windows host key.
- Installs a fixed, integrity-checked Apollo and Moonlight toolchain.
- Opens the Windows desktop with `hardline up`, using the Mac's main display by default.
- Detects address drift and route collisions, then repairs the Direct Link make-before-break.
- Adopts a shared network on its own when the adapter its Target Profile names stops existing, and resumes the dedicated link as soon as the cable answers again.
- Records original state before mutation and restores it in reverse order during uninstall.

## Requirements

### Mac

- Apple Silicon Mac running macOS.
- A physical Ethernet port or USB/Thunderbolt Ethernet adapter for a dedicated link. Otherwise any adapter that already reaches the PC.
- [Homebrew](https://brew.sh/) available as `brew`.
- Administrator access for network configuration.
- [Bun 1.4+](https://bun.sh/) and the Swift compiler when building from source.

### Windows PC

- Windows 11.
- A physical Ethernet adapter connected directly to the Mac, or any adapter already on the same network as the Mac.
- An Administrator PowerShell for the one-time Bootstrap Rendezvous.
- Internet access during installation for Windows OpenSSH and Apollo artifacts.
- A GPU Apollo can encode with. Hardline's rendering defaults are proven on NVIDIA and it says so when it finds something else, but it no longer refuses to install: Apollo also encodes through AMD AMF and Intel QuickSync, and it picks its own encoder.

Hardline has been exercised end to end on one pair of machines. Nothing in it is bound to those machines — no address, adapter, hostname or drive letter is hardcoded — but treat anything beyond "Windows 11 with an NVIDIA GPU" as untested rather than unsupported.

No existing SSH key is required. Hardline creates and owns a separate identity under `~/Library/Application Support/Hardline`.

## Install the CLI

One command, nothing to install first:

```bash
curl -fsSL https://github.com/atinseau/hardline/releases/latest/download/hardline -o hardline &&
chmod +x hardline &&
sudo mv hardline /usr/local/bin/hardline
```

The release carries a standalone Apple Silicon executable. Bun, Git and Swift are needed only to build it yourself:

> [!NOTE]
> Downloading with `curl` as above leaves no quarantine flag, so the binary runs straight away. A browser download does flag it, and macOS then refuses to open it; clear the flag with `xattr -d com.apple.quarantine hardline`.

```bash
git clone https://github.com/atinseau/hardline.git
cd hardline
bun install --frozen-lockfile
bun run build
sudo install -m 0755 dist/hardline /usr/local/bin/hardline
```

The build compiles the macOS display probe and produces the executable at `dist/hardline`. Although the CLI is installed globally, its Target Profile, restoration manifest and SSH identity remain scoped to the macOS user who runs it.

For development, run the TypeScript entry point directly:

```bash
bun run dev -- --help
```

## Install

`hardline install` configures the Mac, the Windows PC, and their Direct Link. It does not install the Hardline CLI itself.

It stops before touching either machine if the Mac is missing something it needs, and says what to install.

1. Connect the Mac and Windows PC with an Ethernet cable, or put both on the same network.
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

If multiple free adapters remain, Hardline presents their hardware, MAC, speed, and link facts and asks which one to dedicate. If it falls back to a shared network and several would do, it lists each usable path — the adapter and address at both ends — and asks which one to use. With a single unambiguous answer, selection is automatic and nothing is asked.

### Shared links

A shared link is not a dedicated one, and Hardline does not pretend otherwise:

- **Hardline writes no addressing.** No address, no DHCP change, no network-category change on either machine. Nothing to restore, and nothing that can be left behind.
- **The firewall rule is scoped, not profiled.** On a dedicated link the OpenSSH rule rests on the Private profile that Hardline sets. On a shared one, Hardline must not reclassify the operator's own network, so the rule is opened on every profile but restricted to the subnet of the link. Hardline's rule alone leaves sshd closed on every other network the PC joins. Note that installing the Windows OpenSSH Server feature also creates its own `OpenSSH Server` rule, unrestricted on every profile and every remote address; where that rule is present, sshd is already reachable from the whole network regardless of what Hardline adds.
- **The Apollo web interface becomes reachable from the rest of the network.** On a cable, traffic never leaves the two machines. SSH stays as safe either way, since it only accepts the Hardline Identity against a pinned host key.
- **Addresses drift.** DHCP leases change; Link Recovery re-reads where both machines are and rewrites the Target Profile. It never repairs by writing.
- **Wake-on-LAN only works where the PC is wired.** A sleeping Wi-Fi card is unpowered and no magic packet reaches it. Hardline records whether the PC's side of the link is wireless and, when it is, says so immediately instead of waiting three minutes for a wake that cannot happen. Where the PC is wired to the same network, waking works normally, and Hardline prefers that pairing when both are available.
- **The stream bitrate drops to 80 Mbit/s**, against 500 on a dedicated gigabit link. That default is deliberately careful: sustained capacity, not peak throughput, is what keeps a stream from stuttering. A Wi-Fi 6E link measured at 357 Mbit/s with 4.65 ms latency and 0.62 ms jitter, so there is often room above it. Correct it with `hardline up --bitrate <kbps>` in either direction; no default can know your house.

### When the adapter disappears

A USB adapter gets unplugged, a port dies, a card is replaced. The Target Profile then names an adapter that no longer exists, and before, that stopped every command: install, uninstall, up and doctor all resolve the same target.

Hardline now treats an adapter as location rather than identity, exactly as it already treats an address. The two machine identities are what bind the pair, and they do not move. So when the named adapter is gone, Hardline reaches the PC under its known names, checks it is the same machine, and adopts a network the two already share.

That adoption is restricted to shared links, and the restriction is the point: adopting one requires no write on either machine. Building a dedicated link instead would mean addressing the PC through the Recovery Channel, which is read-only by design. If the machines share no network, Hardline says so and changes nothing.

### The cable is not forgotten

A dedicated link and a shared network are not two installations, and they are not exclusive. Apollo, Moonlight and the pairing are identical either way; only the path differs. What Hardline keeps is the path it can use right now, and it prefers the cable whenever the cable answers.

Stepping onto a shared network does not erase the dedicated link, because unplugging a cable does not erase anything: both interfaces keep the addressing Hardline wrote at install time. That description is remembered as a dormant link, and every command starts by looking for it. The check is free when the adapter is absent, since nothing is asked of the network until it is back. Plug the cable in, and the next command is on it again, with no address written anywhere.

The preference runs one way on purpose. Hardline returns to the cable on its own because that is the link it exists to provide; it leaves the cable only when the cable is gone.

## Usage

Open the Windows work session:

```bash
hardline up
```

Useful overrides:

```bash
hardline up --fullscreen
hardline up --resolution 2560x1440 --fps 120
hardline up --bitrate 60000
hardline up --monitor
```

### Choosing the link

Every command takes the best link that answers, preferring the cable. `--link` overrides that for one run, on any command:

```bash
hardline up --link direct    # refuse to run on anything but the dedicated link
hardline doctor --link shared
```

The point of the flag is the refusal. Asking for the dedicated link and silently getting the house network instead is the surprise it exists to remove, so `--link direct` never falls back. It fails saying which adapter to plug in, or that the adapter is connected but the PC does not answer over it, or that no dedicated link was ever established. Nothing is written when it refuses.

Shut down the Windows PC:

```bash
hardline down
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

`hardline uninstall` restores the managed environment but does not remove the global CLI binary. Remove that separately if needed:

```bash
sudo rm /usr/local/bin/hardline
```

## Safety Model

Hardline treats an IP address as location, never identity.

- The Target Profile binds Mac identity, Windows identity, Ethernet hardware identities, MAC addresses, and the Windows SSH host key.
- Every command enters through the same target-resolution seam and holds one shared lock through validation, execution, and lifecycle changes.
- The Bootstrap Rendezvous sends observations before authorizing mutation and persists an incomplete Target Profile first.
- SSH uses only the Hardline Identity, disables agent/default-key influence, and requires the pinned host key.
- Connectivity outside the Direct Link is a read-only Recovery Channel. Machine mutation remains confined to the Direct Link.
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
| `hardline down` | Validate or repair the link, then request a forced Windows shutdown |
| `hardline doctor` | Diagnose the link and managed services |
| `hardline uninstall` | Restore recorded state and retire the pair |

Use `hardline <command> --help` for command-specific flags.

## Development

```bash
bun test --isolate
bunx tsc --noEmit
bun run build
```

The same three commands run on every push and pull request, on macOS, in [.github/workflows/checks.yml](.github/workflows/checks.yml). They run on macOS because the deliverable is an Apple Silicon executable and the display probe is compiled with `swiftc`: verifying anywhere else would not verify what ships.

Pushing a `vX.Y.Z` tag runs the same checks and attaches the binary to a **draft** release. What becomes public stays a human gesture.

The central module is `src/target-resolution/`. Existing product convergence remains implemented as transactional `Step` modules under `src/steps/`.

The current architecture and acceptance criteria are documented in [the automatic target resolution spec](.scratch/automatic-target-resolution/spec.md).
