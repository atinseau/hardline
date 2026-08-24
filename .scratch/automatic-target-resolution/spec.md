# Automatic Target Resolution and Direct Link Recovery

Status: ready-for-agent

## Problem Statement

Hardline currently compiles the identity and topology of one personal Mac and Windows PC directly into the executable. It assumes specific network names, addresses, Windows and SMB users, SSH key paths, shares, disks, Moonlight paths, and hardware facts. A change of machine, Ethernet adapter, account, route, or address therefore requires source changes and a rebuild. The same assumptions spread through installation, preflight, bootstrap, SSH, network convergence, diagnostics, streaming, and uninstall.

The current Bootstrap Rendezvous also requires the Mac to know the Windows interface alias and target address before Windows can report them. Its initial HTTP delivery is unauthenticated, and the first SSH connection accepts an unknown host key. The generated installation is consequently tied to known machines rather than safely discovering an arbitrary pair.

Hardline must become installable from scratch on one arbitrary supported Mac and one arbitrary supported Windows PC while preserving its existing reversibility guarantees. The operator should connect the physical Ethernet cable, run `hardline install`, and paste one PowerShell command on Windows. Hardline should discover the pair, choose collision-free addressing, establish its own SSH identity, persist the resulting Target Profile, and reuse or repair the Direct Link for later Command Runs.

This improvement must not weaken the existing transactional Step module, restoration manifest, write-before-mutation rule, reverse restoration ordering, or honest treatment of unobservable detached cleanup. It must not introduce a Windows VM testing stack or require Windows end-to-end automation.

## Solution

Introduce a deep Target Resolution module at one seam immediately inside every Command Run. Its external interface is `TargetResolution.during`: the caller supplies the Command Run intent and a callback, and receives a temporary resolved target only after Hardline has acquired the shared lock, validated the Target Profile, proved the paired identities, and validated or recovered the Direct Link.

On a clean installation, the module generates a dedicated Hardline Identity and runs a two-phase Bootstrap Rendezvous over ephemeral HTTPS. The one pasted PowerShell command tries every viable path to the Mac, validates an ephemeral certificate fingerprint, and presents a one-use token. Before any Windows mutation, the PC reports its identity, physical Ethernet candidates, routes, addresses, current administrator, OpenSSH state, and SSH host key. The Mac combines those facts with its own physical Ethernet and route observations, automatically selects the unique free adapter pair, chooses an unused private `/30`, and atomically persists an incomplete Target Profile. Only then does it authorize Windows mutation.

The Bootstrap Rendezvous captures original Windows state before changing it, installs or enables OpenSSH as required, adds the Hardline Identity, configures the Direct Link, and returns completion evidence. The first SSH connection uses the host key delivered through the pinned HTTPS rendezvous and strict verification, never trust-on-first-use. Existing Step modules then converge the product state using a temporary Config projected from the Target Profile and fixed Installation Catalog.

Every later Command Run loads and revalidates the same Target Profile. If addressing drift or a new route collision breaks the Direct Link, Link Recovery identifies the paired PC, selects a new collision-free `/30` when needed, adds new addresses before removing old ones, proves SSH over the new Direct Link, and atomically updates the Target Profile. Other connectivity is a Recovery Channel: it may locate the PC and collect read-only diagnostics, but it never carries repair or any other machine mutation.

Uninstall restores observable Windows state first, removes the Hardline-managed Apollo completely, preserves a simple Apollo Rescue Backup for any Apollo found before installation, leaves the benign OpenSSH capability installed, launches one final self-contained Windows cleanup tail, and then cleans the Mac completely. The final Windows tail is reported as launched rather than verified because removing the Direct Link makes completion physically unobservable. The Mac then removes the Target Profile, restoration manifest, Hardline Identity, and all other Hardline-owned local state.

## User Stories

1. As a Hardline operator, I want to install Hardline on a different Mac without editing source code, so that the executable is portable across supported Macs.
2. As a Hardline operator, I want to install Hardline on a different Windows PC without editing source code, so that machine replacement does not require a fork.
3. As a Hardline operator, I want to connect one physical Ethernet cable and let Hardline discover the link, so that adapter names do not become setup instructions.
4. As a Hardline operator, I want Hardline to select the only eligible free Ethernet adapter automatically, so that the common installation path requires no choice.
5. As a Hardline operator, I want Hardline to ask only when multiple Ethernet adapters remain genuinely ambiguous, so that automation never becomes unsafe guessing.
6. As a Hardline operator, I want ambiguous adapters described by useful hardware and link facts, so that I can choose without knowing operating-system aliases.
7. As a Hardline operator, I want adapter identity persisted by stable hardware identity rather than localized alias, so that renaming an adapter does not break the pair.
8. As a Hardline operator, I want Wi-Fi, VPN, Bluetooth, loopback, bridges, and virtual adapters excluded from Direct Link selection, so that Hardline acts only on the physical Ethernet cable.
9. As a Hardline operator, I want an active Ethernet adapter without a default gateway preferred automatically, so that an unused direct-link adapter wins over ordinary network access.
10. As a Hardline operator, I want Hardline to select a private subnet that does not overlap either machine's routes or addresses, so that installation does not break an existing LAN or VPN.
11. As a Hardline operator, I want the Direct Link to use a `/30`, so that the subnet contains only the paired Mac and Windows PC.
12. As a Hardline operator, I want the selected `/30` persisted in the Target Profile, so that later commands use the same Direct Link deterministically.
13. As a Hardline operator, I want Hardline to detect a newly introduced route collision, so that a later VPN or LAN cannot silently capture Direct Link traffic.
14. As a Hardline operator, I want Link Recovery to migrate both machines to a new free `/30`, so that the Direct Link survives changing network conditions.
15. As a Hardline operator, I want a new address added before an old one is removed, so that Link Recovery does not cut its own repair channel midway.
16. As a Hardline operator, I want the new Direct Link proved through SSH before old Hardline addresses are removed, so that migration is make-before-break.
17. As a Hardline operator, I want every Command Run to validate the Direct Link first, so that install, up, doctor, and uninstall share the same safety rule.
18. As a Hardline operator, I want `up` to recover address drift before starting Moonlight, so that daily use remains one command.
19. As a Hardline operator, I want `doctor` to diagnose the persisted pair rather than a compiled address, so that its result describes the actual installation.
20. As a Hardline operator, I want `uninstall` to recover the Direct Link before restoration, so that network drift does not strand Hardline-owned state.
21. As a Hardline operator, I want other connectivity used only for read-only diagnostics, so that Wi-Fi or LAN never becomes an unnoticed mutation path.
22. As a Hardline operator, I want Hardline to report that the paired PC is alive while the Direct Link is broken, so that diagnosis distinguishes machine failure from cable failure.
23. As a Hardline operator, I want Hardline to report the PC as inaccessible when neither Direct Link nor Recovery Channel can identify it, so that it does not invent a diagnosis.
24. As a security-conscious operator, I want Hardline to generate its own SSH key, so that it never reuses or depends on my existing SSH identities.
25. As a security-conscious operator, I want the Hardline Identity stored with owner-only permissions, so that the private key is not exposed to other local users.
26. As a security-conscious operator, I want Hardline to use only its dedicated identity for Windows access, so that SSH agents and default keys cannot change behavior.
27. As a security-conscious operator, I want the Windows SSH host key delivered through the authenticated Bootstrap Rendezvous, so that the first SSH connection is not trust-on-first-use.
28. As a security-conscious operator, I want every SSH connection to verify the persisted host key strictly, so that a different machine at the same IP is rejected.
29. As a security-conscious operator, I want Windows machine identity, SSH host identity, Ethernet hardware identity, and MAC address checked together, so that an IP address never acts as identity.
30. As a security-conscious operator, I want a host-key or machine-identity mismatch to stop before mutation, so that a reinstalled or substituted PC cannot inherit trust silently.
31. As a Hardline operator, I want a Windows reinstall to require a new Bootstrap Rendezvous, so that changed machine trust is explicit.
32. As a Hardline operator, I want the first Windows action to remain one pasted PowerShell command, so that fresh Windows setup stays practical.
33. As a Hardline operator, I want that command to try mDNS, link-local, Wi-Fi, LAN, and other viable Mac paths itself, so that I paste only once.
34. As a security-conscious operator, I want the Bootstrap Rendezvous to use HTTPS, so that its observations and plan are encrypted.
35. As a security-conscious operator, I want PowerShell to pin the exact ephemeral certificate fingerprint, so that HTTPS does not rely on disabling certificate validation.
36. As a security-conscious operator, I want the Bootstrap Rendezvous protected by a random one-use token, so that another machine cannot claim the pending installation.
37. As a Hardline operator, I want the temporary certificate, private key, and token removed when the rendezvous ends, so that bootstrap credentials do not become persistent state.
38. As a Hardline operator, I want Windows observations sent before any mutation, so that selection and collision checks use facts from both machines.
39. As a Hardline operator, I want the Target Profile persisted before Windows mutation is authorized, so that the Mac records the target before the PC changes.
40. As a Hardline operator, I want Windows original state captured before its first mutation, so that uninstall can restore what existed before Hardline.
41. As a Hardline operator, I want an interrupted Bootstrap Rendezvous to resume safely, so that a timeout or process failure does not require guessing what happened.
42. As a Hardline operator, I want a later `install` to try strict SSH resume before asking for another PowerShell paste, so that a successful partial bootstrap is reused.
43. As a Hardline operator, I want incomplete installation represented explicitly, so that Hardline never equates process completion with installed state.
44. As a Hardline operator, I want `install` to resume an incomplete Target Profile, so that convergence remains idempotent.
45. As a Hardline operator, I want `uninstall` available for an incomplete installation, so that captured changes remain reversible.
46. As a Hardline operator, I want `up` and `doctor` to refuse an incomplete installation, so that ordinary operation cannot run against a half-configured pair.
47. As a Hardline operator, I want all commands except `install` to refuse when no Target Profile exists, so that no command guesses a target.
48. As a Hardline operator, I want a missing installation reported plainly by `uninstall`, so that absence is not treated as a machine failure.
49. As a Hardline operator, I want the Target Profile generated automatically, so that no manual configuration file is required.
50. As a Hardline operator, I want manual edits to the Target Profile rejected, so that generated machine facts have one source of truth.
51. As a Hardline operator, I want Target Profile writes atomic and versioned, so that interruption cannot leave accepted partial JSON.
52. As a Hardline operator, I want the Target Profile separate from the restoration manifest, so that current identity is not confused with previous machine state.
53. As a Hardline operator, I want both durable files protected by one Command Run lock, so that concurrent commands cannot diverge them.
54. As a Hardline operator, I want exactly one active Mac and Windows pair, so that normal commands need no target selector.
55. As a Hardline operator, I want a fixed Installation Catalog, so that a Hardline version installs reproducible Apollo and Moonlight artifacts.
56. As a security-conscious operator, I want artifact integrity proofs fixed with the Installation Catalog, so that installation does not trust an unauthenticated latest release.
57. As a Hardline operator, I want the Target Profile to record what was actually installed, so that diagnostics can compare desired and observed state.
58. As a Hardline operator, I want Hardline to detect the administrator who ran the PowerShell command, so that no Windows username is compiled into the executable.
59. As a Hardline operator, I want the Windows SSH account persisted in the Target Profile, so that later Command Runs remain deterministic.
60. As a Hardline operator, I want SMB identity handled separately from SSH identity, so that file access does not redefine machine control.
61. As a Hardline operator, I want any pre-existing Apollo configuration backed up before replacement, so that user configuration remains available for manual recovery.
62. As a Hardline operator, I want the Apollo Rescue Backup kept simple, so that it is understandable without Hardline.
63. As a Hardline operator, I want the Apollo Rescue Backup to include configuration, detected version, and a short explanation, so that its origin is clear.
64. As a Hardline operator, I want Hardline to remove its Apollo installation completely during uninstall, so that drivers, certificates, files, credentials, and related state do not remain.
65. As a Hardline operator, I want Hardline not to reinstall a previous Apollo automatically, so that uninstall does not pretend it can reproduce a foreign installation.
66. As a Hardline operator, I want the Apollo Rescue Backup intentionally left on Windows after uninstall, so that the only retained artifact is under my custody.
67. As a Hardline operator, I want OpenSSH left installed after uninstall, so that removing a benign Windows capability does not force a reboot.
68. As a Hardline operator, I want pre-existing sshd, firewall, authorized-key, network, and ACL state restored, so that Hardline removes only what it changed.
69. As a Hardline operator, I want observable Windows cleanup completed before Mac cleanup starts, so that the Direct Link remains available while Windows still needs it.
70. As a Hardline operator, I want one final self-contained Windows tail to remove the key and restore channel-cutting network state, so that cleanup order cannot cut itself off early.
71. As a Hardline operator, I want the final Windows cleanup described as launched rather than verified, so that Hardline reports the physical limit honestly.
72. As a Hardline operator, I want Mac cleanup to continue after the final Windows tail is launched, so that uninstall leaves no Hardline-owned state on the Mac.
73. As a Hardline operator, I want the Hardline Identity deleted after the Windows tail launch, so that uninstall is total on the Mac.
74. As a Hardline operator, I want the Target Profile and restoration manifest deleted at the end of uninstall, so that a future installation starts from zero.
75. As a Hardline operator, I want the old fixed-target version uninstalled before adopting this architecture, so that no migration guesses at historical identity.
76. As a maintainer, I want one Target Resolution interface for all commands, so that target safety fixes have leverage across every Command Run.
77. As a maintainer, I want target resolution to return a temporary Config projection, so that the existing Step module and orchestrator remain reusable.
78. As a maintainer, I want commands unable to construct arbitrary SSH targets, so that operational access always follows Target Profile validation.
79. As a maintainer, I want Recovery Channel details hidden from commands, so that commands cannot accidentally mutate through alternate connectivity.
80. As a maintainer, I want lifecycle outcomes explicit at the Target Resolution seam, so that install activation and uninstall retirement remain atomic.
81. As a maintainer, I want existing restoration state kept solely in the manifest, so that the Target Profile does not duplicate rollback knowledge.
82. As a maintainer, I want the existing write-before-mutation rule preserved, so that interruption remains recoverable.
83. As a maintainer, I want the existing reverse restoration rule preserved, so that Windows is restored while the Mac still carries the Direct Link.
84. As a maintainer, I want target behavior tested through the same interface commands use, so that tests survive internal refactors.
85. As a maintainer, I want Bootstrap Rendezvous protocol tests without a real Windows PC, so that authentication, ordering, and resume behavior remain fast to verify.
86. As a maintainer, I want no Windows VM test stack added, so that architecture work does not acquire an operational testing platform.
87. As a maintainer, I want old shallow target tests replaced after the new test surface passes, so that duplicate implementation-shaped tests do not remain.

## Implementation Decisions

- The canonical domain terms are Command Run, Target Profile, Bootstrap Rendezvous, Hardline Identity, Direct Link, Link Recovery, Recovery Channel, Apollo Rescue Backup, and Installation Catalog.
- The selected architecture is a deep Target Resolution module with one external seam immediately inside every Command Run.
- The external interface has one operational entry point named `during`. It receives the intent `install`, `up`, `doctor`, or `uninstall`, and executes a callback only after target eligibility and Direct Link safety are established.
- The callback receives a Command Run-scoped target containing an immutable Config projection, the restoration manifest location, and whether resolution was validated, recovered, or bootstrapped.
- Config ceases to be an editable or compiled source of machine truth. It becomes a temporary projection from the validated Target Profile and fixed Installation Catalog.
- The callback returns a lifecycle outcome of unchanged, installed, incomplete, or ready-to-retire together with its command result.
- The `ready-to-retire` outcome is valid only for uninstall after all observable Windows and Mac-independent restoration work is ready for terminal cleanup.
- Target Resolution owns lock acquisition, Target Profile lifecycle, Bootstrap Rendezvous, Hardline Identity, SSH host verification, Direct Link validation, Link Recovery, lifecycle transitions, and terminal target retirement.
- Commands own command-specific policy, presentation facts, consent, product convergence, diagnostics, streaming, and result wording.
- The existing Step interface remains the convergence and restoration interface for product state.
- The existing orchestrator remains responsible for write-before-mutation, idempotent apply, reverse restoration, yielded restoration, detached launch tracking, and retention of failed restoration records.
- The Target Profile and restoration manifest remain separate durable documents because current target identity and previous machine state have different meanings.
- One shared Command Run lock protects both documents and remains held through resolution, callback execution, lifecycle transition, and terminal cleanup.
- The Target Profile is generated, schema-versioned, owner-readable, atomically replaced, and not manually editable.
- The Target Profile persists one pair only. Multi-target selection is not introduced.
- The Target Profile includes stable Mac identity, stable Windows identity, selected Ethernet hardware identities, observed aliases for reporting, Windows administrator identity, private `/30`, Direct Link addresses, Hardline Identity references, pinned SSH host key, Installation Catalog version, revision, and lifecycle state.
- Operating-system aliases are observations rather than identity and are re-resolved from stable hardware identifiers on every Command Run.
- Lifecycle distinguishes at least bootstrap incomplete, installation incomplete, installed, and uninstall incomplete. Absence of the Target Profile means fully uninstalled.
- All commands except install refuse when the Target Profile is absent. Install starts clean. Incomplete installation permits install resume and uninstall restoration while up and doctor refuse.
- No migration from the old compiled configuration or old manifest is implemented. The operator must uninstall with the old version and reinstall from zero.
- Physical Ethernet selection excludes Wi-Fi, VPN, Bluetooth, loopback, bridges, tunnels, and virtual adapters.
- A unique active free Ethernet candidate without a default gateway is selected automatically. The operator chooses only when multiple candidates remain genuinely equivalent.
- Candidate presentation includes enough hardware, MAC, speed, link, and gateway evidence for an informed choice, but the choice is persisted by stable identifier.
- The Direct Link uses an automatically selected private `/30` with no gateway.
- `/30` selection rejects overlap with routes, assigned addresses, and observed active use on both machines.
- The selected `/30` is persisted before either machine is authorized to receive its address.
- Link Recovery runs before every Command Run callback and uses make-before-break migration when addressing must change.
- Link Recovery adds new addresses, proves strict SSH over the new Direct Link, updates the Target Profile atomically, and only then removes obsolete Hardline addresses.
- All operational SSH and all machine mutation use the physical Direct Link.
- A Recovery Channel may use any existing alternate connectivity to identify the paired PC and collect read-only observations.
- Recovery Channel read-only behavior is an implementation rule enforced by exposing only predefined observations internally. No extra Windows diagnostic account or secondary SSH identity is created.
- Hardline does not open additional firewall access for a Recovery Channel. If existing connectivity does not permit observation, the PC is inaccessible.
- A Recovery Channel may describe why the Direct Link failed, but repair waits until a physical Ethernet path is available.
- The Hardline Identity is a dedicated Ed25519 SSH identity generated automatically under the current Mac user's Application Support directory with owner-only permissions.
- Hardline never reuses an operator key, default SSH key, SSH agent identity, or password for operational SSH.
- The Hardline public key is added without removing or replacing pre-existing authorized keys.
- The Bootstrap Rendezvous is initiated by exactly one PowerShell command pasted into an elevated Windows shell.
- That command contains multiple candidate Mac paths and tries them automatically until one authenticated rendezvous succeeds.
- The Bootstrap Rendezvous uses an ephemeral HTTPS certificate generated for that rendezvous.
- The pasted command includes the expected certificate fingerprint and accepts only that certificate. TLS verification is pinned, not disabled.
- The pasted command also contains a random one-use token. The rendezvous expires and rejects missing, invalid, reused, or late tokens.
- Temporary certificate material and tokens are removed when the rendezvous closes.
- Bootstrap is two phase. Phase one is read-only and reports Windows machine identity, current administrator, physical Ethernet candidates, routes, addresses, OpenSSH state, and SSH host key.
- The Mac combines phase-one facts with Mac observations, selects the adapter pair and `/30`, generates the Hardline Identity, and persists an incomplete Target Profile atomically.
- Windows receives mutation authorization only after the Target Profile has been persisted.
- Before the first Windows mutation, the bootstrap captures original state in a durable, immutable recovery record.
- Phase two installs or enables OpenSSH, starts sshd as needed, establishes the Hardline authorized key, configures the selected Direct Link adapter, and returns completion evidence.
- OpenSSH host keys are reported through the pinned HTTPS rendezvous and persisted before the first SSH connection.
- SSH uses strict host-key checking with a Hardline-owned known-hosts file. Trust-on-first-use and `accept-new` are prohibited.
- A host-key mismatch or composite Windows identity mismatch stops before mutation and requires a new Bootstrap Rendezvous after explicit cleanup.
- Install resume tries strict SSH with the incomplete Target Profile before requesting another PowerShell paste.
- The Installation Catalog is fixed and embedded with each Hardline version. It contains artifact versions, locations, and integrity proofs and cannot be overridden by Target Profile, environment, or command flags.
- Machine facts are never hardcoded. Product artifact versions remain intentionally fixed and reproducible through the Installation Catalog.
- The Windows administrator that runs bootstrap is detected and persisted for SSH. No additional Windows account is created.
- SMB identity remains separate from SSH identity and may still require operator secret entry.
- A foreign Apollo is backed up before removal and then replaced by the Hardline-managed installation.
- The Apollo Rescue Backup is deliberately simple: configuration, detected version, and a short explanation in an operator-visible Windows location.
- Uninstall never reinstalls the foreign Apollo. The Apollo Rescue Backup remains on Windows under operator custody.
- Hardline removes its Apollo installation completely during uninstall, including Hardline-managed files, drivers, certificates, credentials, and related state.
- OpenSSH Server remains installed after uninstall even when Hardline originally added the capability.
- Other pre-existing Windows state is restored exactly. Hardline removes its key, rules, addresses, tasks, and files without removing user-owned equivalents.
- Uninstall completes observable Windows work before local terminal cleanup.
- One self-contained final Windows tail performs channel-cutting work, removes the Hardline authorization, restores remaining Windows network and sshd state, removes its own transient files, and then becomes unobservable.
- Acceptance of the final tail launch is observable; its completion is not. Operator output says launched rather than verified.
- After the final Windows tail is launched, Hardline restores all remaining Mac state and deletes the Hardline Identity, Target Profile, restoration manifest, and local Hardline-owned state.
- No backward-compatibility module preserves the old fixed Config or bootstrap flow.

## Testing Decisions

- A good test observes behavior through a stable interface and survives internal implementation changes. Tests should assert accepted or refused Command Runs, callback entry, lifecycle outcome, persisted observable state, safety ordering, and operator-visible facts rather than private helper calls or generated command fragments.
- The primary and highest test seam is `TargetResolution.during`. Target Resolution tests drive complete install, resume, validation, Link Recovery, refusal, and retirement scenarios through this one interface.
- Commands and tests use the same Target Resolution seam. A command callback must never run when target eligibility, identity, lifecycle, or Direct Link validation fails.
- Target Resolution tests cover absent, incomplete, installed, corrupt, unsupported, and uninstall-incomplete Target Profile states.
- Target Resolution tests cover shared lock lifetime across profile read, Direct Link work, command callback, lifecycle transition, and cleanup.
- Target Resolution tests cover atomic Target Profile creation, replacement, revision changes, rejection of manual corruption, and separation from the restoration manifest.
- Target Resolution tests cover automatic unique Mac and Windows Ethernet selection and explicit ambiguity without relying on localized aliases.
- Target Resolution tests cover exclusion of Wi-Fi, VPN, Bluetooth, loopback, bridged, tunneled, and virtual adapters.
- Target Resolution tests cover `/30` overlap rejection against routes and assigned addresses on both machines.
- Target Resolution tests cover deterministic selection, persistence before mutation, and exhaustion without unsafe fallback.
- Target Resolution tests cover normal Direct Link validation, address drift, route collision, make-before-break migration, strict revalidation, and atomic profile update.
- Target Resolution tests cover Recovery Channel observations without any mutation call and refusal when no physical repair path exists.
- Target Resolution tests cover the PC-alive/Direct-Link-broken diagnosis and the fully inaccessible result.
- Target Resolution tests cover dedicated Hardline Identity generation, owner-only custody, explicit identity use, and removal after terminal uninstall launch.
- Target Resolution tests cover strict SSH host-key verification, mismatch refusal, composite machine-identity mismatch, and prohibition of trust-on-first-use.
- The Bootstrap Rendezvous is the principal internal seam because it is an owned cross-machine protocol. Its production HTTPS adapter and in-memory protocol adapter exercise the same two-phase behavior.
- Bootstrap Rendezvous tests cover ephemeral certificate pinning, one-use token redemption, expiry, replay rejection, wrong certificate, wrong token, and cleanup of temporary material.
- Bootstrap Rendezvous tests cover one pasted command trying multiple Mac paths without exposing path selection to command policy.
- Bootstrap Rendezvous tests cover phase-one read-only observations, Target Profile persistence before authorization, immutable Windows recovery capture before mutation, phase-two completion, and SSH host-key delivery before connection.
- Bootstrap resume tests cover interruption before observation, after observation, after profile persistence, during Windows mutation, after SSH availability, and before installation completion.
- Lifecycle tests cover install resume, uninstall from incomplete installation, refusal of up and doctor while incomplete, and idempotent install against an installed Target Profile.
- Uninstall tests cover observable Windows-first ordering, complete managed Apollo removal, Apollo Rescue Backup retention, OpenSSH capability retention, restoration of other pre-existing state, final-tail launch, honest unobservable reporting, Mac cleanup, and deletion of local durable state.
- Existing Step and orchestrator tests remain the prior art for write-before-mutation, reverse order, yielded restoration, detached launch, continuation after failure, and manifest record retention. Those guarantees are not retested through private Target Resolution helpers.
- Existing bootstrap, SSH, shell, network-step, install, up, doctor, uninstall, manifest-lock, and orchestrator tests provide captured outputs and safety scenarios to migrate toward the new seam.
- Pure parsing tests remain where malformed operating-system output has meaningful behavior, but tests that only mirror internal target helper decomposition should be deleted after equivalent Target Resolution tests pass.
- Command tests become narrow around intent selection, target events rendered through Command Run, callback outcomes, and refusal wording. They do not mock every internal target dependency.
- No automated Windows VM, UTM stack, snapshot lifecycle, or new Windows end-to-end test lane is introduced.
- No test in this spec requires a real Windows machine. Physical Apollo, NVIDIA, display-driver, Moonlight, and rendering verification remains manual or future work.
- The completed implementation must preserve the existing isolated unit-test suite and type safety while replacing obsolete fixed-target expectations.

## Out of Scope

- Supporting more than one active Target Profile or adding target selection to commands.
- Migrating the old compiled Config, old manifest, old SSH identity, or old bootstrap state into the new architecture.
- Preserving backward compatibility with the old target-resolution interface.
- Removing OpenSSH Server during uninstall.
- Automatically restoring or reinstalling a foreign Apollo after uninstall.
- Deleting the Apollo Rescue Backup during uninstall.
- Making the Target Profile manually editable or adding configuration overrides for discovered machine facts.
- Selecting the latest Apollo, Moonlight, or other artifact dynamically at runtime.
- Fetching a mutable remote Installation Catalog.
- Mutating Windows through Wi-Fi, LAN, VPN, or any Recovery Channel.
- Creating an additional Windows diagnostic account or a separate read-only SSH identity.
- Guaranteeing diagnosis when no existing alternate connectivity can reach the PC.
- Eliminating the one pasted elevated PowerShell command required by a fresh Windows installation.
- Adding Windows VM orchestration, UTM automation, snapshots, or a `test:e2e` Windows lane.
- Emulating NVIDIA hardware, NVENC, SudoVDA, or production Apollo rendering behavior.
- Generalizing Apollo or rendering across arbitrary GPU families in this spec.
- Completing universal Mac binary distribution, Intel Mac packaging, direct Moonlight installation, or fresh-Mac software provisioning beyond target discovery.
- Supporting operating systems other than macOS and Windows.
- Replacing the transactional Step module, orchestrator, restoration manifest semantics, or Command Run architecture.
- Claiming that the final detached Windows cleanup completed after the Direct Link disappeared.

## Further Notes

- This spec is a successor to the earlier fixed-machine design for target identity, bootstrap, addressing, and Direct Link operation. The earlier explicit non-goal of supporting another Mac or Windows PC no longer applies to this transport and target-resolution scope.
- Existing hardware-specific rendering decisions remain in force until separately generalized. A portable Direct Link does not imply that every GPU or Apollo driver combination is supported.
- No ADRs currently govern this area. The older validated specs contain the decisions being superseded.
- The deletion test supports the Target Resolution module: removing it would redistribute target identity, profile lifecycle, HTTPS bootstrap, SSH trust, adapter selection, subnet allocation, Link Recovery, and retirement ordering across all four commands.
- The interface is the test surface. `TargetResolution.during` provides high leverage to callers and strong locality for target bugs and verification.
- Bootstrap HTTPS and its in-memory protocol implementation justify an internal seam because the owned cross-machine protocol has two concrete adapters.
- Recovery Channel mechanisms should remain private implementation until multiple concrete observation paths make an adapter seam real. One adapter is a hypothetical seam; two are real.
- The current static Config, alias-based preflight, unauthenticated HTTP bootstrap, and trust-on-first-use SSH behavior are replaced rather than wrapped in compatibility code.
- The current worktree contains unrelated ongoing changes. Implementation must preserve them and must not revert or rewrite unrelated work.
