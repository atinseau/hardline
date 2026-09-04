# Graph Report - hardline  (2026-08-24)

## Corpus Check
- 112 files · ~144,262 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 781 nodes · 1621 edges · 40 communities (27 shown, 13 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.85)
- Token cost: 147,124 input · 7,673 output

## Community Hubs (Navigation)
- Manifest Orchestration
- Apollo State Inspection
- CLI Diagnostics and Facts
- Streaming Display Selection
- Command Workflows
- SSH Remote Execution
- Credentials and Configuration
- Command Run Recording
- Apollo API and Pairing
- Network Service Management
- Windows Network Scripts
- TypeScript Configuration
- Package and Build Metadata
- Application Configuration
- Moonlight Package Management
- Pairing State Tests
- Bootstrap Script Delivery
- SMB Mountpoint Orchestration
- Interactive Prompt Primitives
- Command Output Interface
- Clack Output Adapter
- Command Result Model
- Text Output Adapter
- SMB Share Mounting
- Apollo Installer Tests
- macOS Display Probe
- Command Runner Tests
- Output Adapter Tests
- SMB Share Tests
- Agent and Domain Docs
- Preflight Health Tests
- Apollo Service Tests
- Build Script
- Asset Type Declarations
- Architecture Quality Report
- Transport Foundation Plan
- Session Rendering Plan
- Command Output Specification
- Confirmation Prompt
- Secret Prompt

## God Nodes (most connected - your core abstractions)
1. `Config` - 51 edges
2. `CommandOutput` - 28 edges
3. `psQuote()` - 27 edges
4. `errorMessage()` - 23 edges
5. `Step` - 19 edges
6. `runInstall()` - 17 edges
7. `ClackOutput` - 16 edges
8. `TextOutput` - 16 edges
9. `acquireManifestLock()` - 16 edges
10. `CommandRun` - 15 edges

## Surprising Connections (you probably didn't know these)
- `scenario()` --calls--> `runCommand()`  [EXTRACTED]
  test/command-run/adapters.test.ts → src/command-run/run.ts
- `doctorCommand()` --calls--> `exitCodeFor()`  [EXTRACTED]
  test/commands/doctor-run.test.ts → src/command-run/run.ts
- `installCommand()` --calls--> `exitCodeFor()`  [EXTRACTED]
  test/commands/install.test.ts → src/command-run/run.ts
- `uninstallCommand()` --calls--> `exitCodeFor()`  [EXTRACTED]
  test/commands/uninstall.test.ts → src/command-run/run.ts
- `upCommand()` --calls--> `exitCodeFor()`  [EXTRACTED]
  test/commands/up.test.ts → src/command-run/run.ts

## Import Cycles
- None detected.

## Communities (40 total, 13 thin omitted)

### Community 0 - "Manifest Orchestration"
Cohesion: 0.05
Nodes (55): acquireManifestLock(), bootInstantMs(), claim(), contendedMessage(), emptyManifest(), forget(), forgetStep(), heldMessage() (+47 more)

### Community 1 - "Apollo State Inspection"
Cohesion: 0.05
Nodes (60): BOOLEAN_DEVICE_FIELDS, isObject(), JsonObject, normalizeRemoteState(), normalizeState(), readRemoteState(), STATE_PATH_EXPR(), assertNoApostrophe() (+52 more)

### Community 2 - "CLI Diagnostics and Facts"
Cohesion: 0.07
Nodes (63): buildProgram(), CliDependencies, defaults, VERSION, CHECK_NAMES, englishCheckName(), englishStepLabel(), STEP_LABELS (+55 more)

### Community 3 - "Streaming Display Selection"
Cohesion: 0.07
Nodes (45): APOLLO_STATUS(), broadcastAddress(), buildStreamOptions(), chooseDisplay(), displayChoiceLabel(), ensureApolloRunning(), fact(), parseFps() (+37 more)

### Community 4 - "Command Workflows"
Cohesion: 0.04
Nodes (43): exitCodeFor(), doctorCommand(), appliedGroups, askConfirmation, askSecret, askSecretCalls, backupApolloConfig, CAPTURE_GROUP (+35 more)

### Community 5 - "SSH Remote Execution"
Cohesion: 0.07
Nodes (34): buildSSHArgs(), encodePowerShell(), parseRemoteJson(), RemoteError, RemoteResult, runRemote(), runRemoteJson(), SSHTarget (+26 more)

### Community 6 - "Credentials and Configuration"
Cohesion: 0.08
Nodes (33): confConforms(), parseConf(), patchConf(), REQUIRED_CONF, deleteSecret(), generatePassword(), generatePin(), getSecret() (+25 more)

### Community 7 - "Command Run Recording"
Cohesion: 0.05
Nodes (28): CommandRun, apolloStatusRounds, captureSortie(), choicePrompts, displays, failures, finishes, getSecret (+20 more)

### Community 8 - "Apollo API and Pairing"
Cohesion: 0.10
Nodes (33): apiReachable(), ApolloClient, ApolloCredentials, apolloFetch(), ApolloRequestInit, apolloUrl(), listClients(), login() (+25 more)

### Community 9 - "Network Service Management"
Cohesion: 0.14
Nodes (19): fieldValue(), getServiceInfo(), listNetworkServices(), NetworkService, parseNetworkServices(), parsePingOutput(), parseServiceInfo(), ping() (+11 more)

### Community 10 - "Windows Network Scripts"
Cohesion: 0.11
Nodes (14): BOOTSTRAP_STEP_NAME, SSH_LOCAL_ADDRESS, ASSIGNABLE_CATEGORIES, DETACHED_MARK, INLINE_MARK, removeStatement(), RESTORE(), restoreAddressing() (+6 more)

### Community 11 - "TypeScript Configuration"
Cohesion: 0.11
Nodes (17): bun-types, ESNext, scripts, src, test, compilerOptions, lib, module (+9 more)

### Community 12 - "Package and Build Metadata"
Cohesion: 0.12
Nodes (16): @clack/prompts, commander, dependencies, @clack/prompts, commander, devDependencies, @types/bun, name (+8 more)

### Community 13 - "Application Configuration"
Cohesion: 0.15
Nodes (12): ApolloConfig, Config, MoonlightConfig, SMBConfig, SMBShare, CONFIG, SHARE_D, SpawnCall (+4 more)

### Community 14 - "Moonlight Package Management"
Cohesion: 0.21
Nodes (10): caskInfo(), CaskInfoJson, installCask(), MoonlightState, parseCaskInfo(), uninstallCask(), ABSENT, INSTALLED (+2 more)

### Community 15 - "Pairing State Tests"
Cohesion: 0.13
Nodes (13): clientList, forgetHost, isPairedFromMac, listClients, NO_PENDING, order, plistHosts, remoteWrites (+5 more)

### Community 16 - "Bootstrap Script Delivery"
Cohesion: 0.20
Nodes (9): BootstrapVars, loadBootstrapTemplate(), MARKERS, renderBootstrapScript(), serveBootstrap(), MODIFICATIONS, SCRIPT, VARS (+1 more)

### Community 17 - "SMB Mountpoint Orchestration"
Cohesion: 0.16
Nodes (12): mountPointExists(), MountPointState, smbMountPointsStep, survey(), RestoreContext, [ARTHUR, PC_D, PC_E], createMountPoints, mountPointExists (+4 more)

### Community 18 - "Interactive Prompt Primitives"
Cohesion: 0.23
Nodes (6): clack, ClackPrimitives, Spinner, Choice, ChoiceAnswer, SecretAnswer

### Community 21 - "Command Result Model"
Cohesion: 0.24
Nodes (8): CommandDefinition, PromptCancelled, CancelledResult, CommandResult, CommandStatus, FailedResult, IncompleteResult, SucceededResult

### Community 23 - "SMB Share Mounting"
Cohesion: 0.33
Nodes (7): createMountPoints(), isMounted(), isResponsive(), mountShare(), removeMountPoints(), smbUrl(), unmountShare()

### Community 24 - "Apollo Installer Tests"
Cohesion: 0.22
Nodes (6): expectAwaitedLauncher(), jsonQueue, launchLine(), runRemoteChecked, runRemoteJson, scriptLog

### Community 25 - "macOS Display Probe"
Cohesion: 0.25
Nodes (7): Bool, CGDirectDisplayID, ColorSync, CoreGraphics, Foundation, String, colorProfile()

### Community 27 - "Output Adapter Tests"
Cohesion: 0.38
Nodes (4): createCommandOutput(), Fact, render(), scenario()

### Community 28 - "SMB Share Tests"
Cohesion: 0.29
Nodes (5): ShareState, order, runRemoteChecked, runRemoteJson, unmountShare

### Community 29 - "Agent and Domain Docs"
Cohesion: 0.40
Nodes (5): Agent skills, Hardline Context, Domain Docs, Issue tracker: Local Markdown, Triage Labels

### Community 31 - "Apollo Service Tests"
Cohesion: 0.40
Nodes (3): jsonQueue, runRemoteChecked, runRemoteJson

## Knowledge Gaps
- **274 isolated node(s):** `name`, `version`, `type`, `private`, `dev` (+269 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Config` connect `Application Configuration` to `Manifest Orchestration`, `Apollo State Inspection`, `CLI Diagnostics and Facts`, `Streaming Display Selection`, `Command Workflows`, `SSH Remote Execution`, `Credentials and Configuration`, `Command Run Recording`, `Apollo API and Pairing`, `Network Service Management`, `Windows Network Scripts`, `Moonlight Package Management`, `Pairing State Tests`, `SMB Mountpoint Orchestration`, `SMB Share Mounting`, `Apollo Installer Tests`, `SMB Share Tests`, `Preflight Health Tests`, `Apollo Service Tests`?**
  _High betweenness centrality (0.191) - this node is a cross-community bridge._
- **Why does `CommandOutput` connect `Command Output Interface` to `CLI Diagnostics and Facts`, `Streaming Display Selection`, `Command Workflows`, `SSH Remote Execution`, `Command Run Recording`, `Interactive Prompt Primitives`, `Clack Output Adapter`, `Command Result Model`, `Text Output Adapter`, `Command Runner Tests`, `Output Adapter Tests`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `ClackOutput` connect `Clack Output Adapter` to `Command Output Interface`, `Output Adapter Tests`, `Interactive Prompt Primitives`, `Command Runner Tests`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `name`, `version`, `type` to the rest of the system?**
  _274 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Manifest Orchestration` be split into smaller, more focused modules?**
  _Cohesion score 0.05189189189189189 - nodes in this community are weakly interconnected._
- **Should `Apollo State Inspection` be split into smaller, more focused modules?**
  _Cohesion score 0.05045045045045045 - nodes in this community are weakly interconnected._
- **Should `CLI Diagnostics and Facts` be split into smaller, more focused modules?**
  _Cohesion score 0.06773211567732115 - nodes in this community are weakly interconnected._