# Graph Report - src  (2026-08-23)

## Corpus Check
- Corpus is ~37,833 words - fits in a single context window. You may not need a graph.

## Summary
- 373 nodes · 941 edges · 11 communities (10 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- CLI et diagnostics
- Contrats et étapes
- État distant PowerShell
- Session et affichage
- Manifeste et restauration
- Apollo et secrets
- SSH et débit
- Réseau macOS
- Installation Apollo
- Réseau Windows
- Ressources embarquées

## God Nodes (most connected - your core abstractions)
1. `psQuote()` - 26 edges
2. `Config` - 25 edges
3. `errorMessage()` - 22 edges
4. `Step` - 16 edges
5. `runRemoteJson()` - 15 edges
6. `runRemoteChecked()` - 14 edges
7. `acquireManifestLock()` - 13 edges
8. `install()` - 12 edges
9. `runUp()` - 12 edges
10. `doctorCommand()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `buildProgram()` --indirect_call--> `upCommand()`  [INFERRED]
  cli.ts → commands/up.ts
- `upCommand()` --indirect_call--> `withSpinner()`  [INFERRED]
  commands/up.ts → lib/ui.ts
- `installScript()` --calls--> `psQuote()`  [EXTRACTED]
  steps/apollo-install.ts → lib/powershell.ts
- `INSPECT()` --calls--> `psQuote()`  [EXTRACTED]
  steps/apollo-service.ts → lib/powershell.ts
- `APPLY()` --calls--> `psQuote()`  [EXTRACTED]
  steps/smb-shares.ts → lib/powershell.ts

## Import Cycles
- None detected.

## Communities (11 total, 1 thin omitted)

### Community 0 - "CLI et diagnostics"
Cohesion: 0.08
Nodes (54): buildProgram(), VERSION, columnWidth(), Diagnostic, doctorCommand(), FIXED_LABELS, formatDiagnostic(), marker() (+46 more)

### Community 1 - "Contrats et étapes"
Cohesion: 0.07
Nodes (44): ApolloConfig, Config, MoonlightConfig, SMBConfig, SMBShare, caskInfo(), CaskInfoJson, installCask() (+36 more)

### Community 2 - "État distant PowerShell"
Cohesion: 0.08
Nodes (43): confConforms(), parseConf(), patchConf(), REQUIRED_CONF, BOOLEAN_DEVICE_FIELDS, isObject(), JsonObject, normalizeRemoteState() (+35 more)

### Community 3 - "Session et affichage"
Cohesion: 0.08
Nodes (41): APOLLO_STATUS(), broadcastAddress(), buildStreamOptions(), chooseDisplay(), displayChoiceLabel(), ensureApolloRunning(), NO_HOOKS, parseFps() (+33 more)

### Community 4 - "Manifeste et restauration"
Cohesion: 0.09
Nodes (40): bootstrapCaveats(), recordedLabels(), scopeLabel(), uninstall(), acquireManifestLock(), bootInstantMs(), claim(), contendedMessage() (+32 more)

### Community 5 - "Apollo et secrets"
Cohesion: 0.08
Nodes (38): apiReachable(), ApolloClient, ApolloCredentials, apolloFetch(), ApolloRequestInit, apolloUrl(), listClients(), login() (+30 more)

### Community 6 - "SSH et débit"
Cohesion: 0.19
Nodes (15): buildSSHArgs(), encodePowerShell(), parseRemoteJson(), RemoteError, RemoteResult, runRemote(), runRemoteJson(), SSHTarget (+7 more)

### Community 7 - "Réseau macOS"
Cohesion: 0.18
Nodes (14): fieldValue(), getServiceInfo(), listNetworkServices(), NetworkService, parseNetworkServices(), parsePingOutput(), parseServiceInfo(), ping() (+6 more)

### Community 8 - "Installation Apollo"
Cohesion: 0.15
Nodes (14): ApolloInstallState, apolloInstallStep, backupApolloConfig(), CONFIG_PATH_EXPR(), ForeignApolloError, INSPECT(), installScript(), MARKER_FILE (+6 more)

### Community 9 - "Réseau Windows"
Cohesion: 0.19
Nodes (10): BOOTSTRAP_STEP_NAME, ASSIGNABLE_CATEGORIES, DETACHED_MARK, INLINE_MARK, removeStatement(), RESTORE(), restoreAddressing(), setProfileStatement() (+2 more)

## Knowledge Gaps
- **69 isolated node(s):** `VERSION`, `StepSummary`, `Diagnostic`, `FIXED_LABELS`, `ResolutionOption` (+64 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Config` connect `Contrats et étapes` to `CLI et diagnostics`, `État distant PowerShell`, `Session et affichage`, `Manifeste et restauration`, `Apollo et secrets`, `SSH et débit`, `Réseau macOS`, `Installation Apollo`, `Réseau Windows`?**
  _High betweenness centrality (0.133) - this node is a cross-community bridge._
- **Why does `errorMessage()` connect `CLI et diagnostics` to `Session et affichage`, `Manifeste et restauration`, `Apollo et secrets`, `SSH et débit`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `Step` connect `Contrats et étapes` to `CLI et diagnostics`, `État distant PowerShell`, `Manifeste et restauration`, `Apollo et secrets`, `Réseau macOS`, `Installation Apollo`, `Réseau Windows`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `VERSION`, `StepSummary`, `Diagnostic` to the rest of the system?**
  _69 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CLI et diagnostics` be split into smaller, more focused modules?**
  _Cohesion score 0.07885304659498207 - nodes in this community are weakly interconnected._
- **Should `Contrats et étapes` be split into smaller, more focused modules?**
  _Cohesion score 0.06516290726817042 - nodes in this community are weakly interconnected._
- **Should `État distant PowerShell` be split into smaller, more focused modules?**
  _Cohesion score 0.08163265306122448 - nodes in this community are weakly interconnected._