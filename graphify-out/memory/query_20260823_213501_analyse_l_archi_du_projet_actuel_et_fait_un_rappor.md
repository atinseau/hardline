---
type: "query"
date: "2026-08-23T21:35:01.616575+00:00"
question: "Analyse l'archi du projet actuel et fait un rapport de qualité, ne lit pas toute la codebase"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Config", "Step", "applySteps()", "revertSteps()", "Manifest", "install()"]
---

# Q: Analyse l'archi du projet actuel et fait un rapport de qualité, ne lit pas toute la codebase

## Answer

Expanded from original query via graph vocab: [command, orchestrator, step, config, manifest, apply, restore, install, uninstall, doctor, remote, preflight]. Architecture en couches CLI -> commandes -> orchestrateur transactionnel -> étapes idempotentes -> adaptateurs système. Les forces sont les invariants de manifeste/restauration, l'ordre explicite et les tests; les risques sont la configuration codée en dur, les frontières système moins couvertes, les gros modules et l'absence de CI/lint/README.

## Outcome

- Signal: useful

## Source Nodes

- Config
- Step
- applySteps()
- revertSteps()
- Manifest
- install()