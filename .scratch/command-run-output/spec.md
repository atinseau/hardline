# Deep Command Run and Concise English Output

Status: ready-for-agent

## Problem Statement

Hardline's commands currently mix operator interaction, terminal rendering, command policy, recovery guidance, error handling, and process exit behavior. The resulting output is verbose, French-only, difficult to use in redirected execution, and expensive to change safely. The installation path is especially dense, but the same presentation concerns are repeated across install, uninstall, doctor, and up.

The product logic is valuable and well tested. In particular, Hardline protects ordering, captures recoverable state before changes, requires explicit authorization for destructive non-interactive work, preserves secrets, and reports uncertainty honestly. The architecture must improve without weakening those invariants.

Hardline also needs a stable seam that can later receive a generic machine profile. This change prepares that seam but does not solve machine-profile portability yet.

## Solution

Introduce a deep Command Run module that owns the shared lifecycle of every Hardline command while leaving command-specific policy with each command. A Command Run starts with accepted operator intent and ends with one operator-visible result and one centrally mapped exit code.

Commands will produce typed semantic facts, progressive phase activity, questions, warnings, recovery facts, and one of four results: succeeded, failed, cancelled, or incomplete. Commands will not know about Clack, terminal detection, verbosity, English formatting, or process-global exit state.

Two real output adapters will sit at the Command Run seam. The interactive adapter will preserve Clack as the foundation of the shell experience. The deterministic text adapter will produce stable, fully human-readable English when output is redirected. Both adapters will use the same command-specific English renderer so wording does not diverge.

Normal output will show a short title, one live spinner per phase, necessary questions, actionable warnings, and a final sentence. The spinner will replace its current activity as work progresses. A global `--verbose` option will preserve completed semantic details progressively while the current activity continues to update. Verbosity will never alter command behavior or reveal raw subprocess output.

## User Stories

1. As a Hardline operator, I want concise command output, so that I can understand progress without reading every internal step.
2. As a Hardline operator, I want all executable output in English, so that the shell has one consistent language.
3. As a Hardline operator, I want Clack to remain the interactive experience, so that prompts and progress remain polished and familiar.
4. As a Hardline operator, I want one spinner per meaningful phase, so that long work remains observable without flooding the terminal.
5. As a Hardline operator, I want the spinner message to update with current activity, so that I know what Hardline is doing now.
6. As a Hardline operator, I want completed phases to leave only a short conclusion in normal mode, so that the final transcript remains compact.
7. As a Hardline operator, I want `--verbose` to preserve completed details progressively, so that I can investigate a run without changing its behavior.
8. As a Hardline operator, I want warnings and required actions to remain visible in normal mode, so that concision never hides risk.
9. As a Hardline operator, I want recovery instructions to reflect the actual recorded state, so that I can safely resume or restore after partial work.
10. As a Hardline operator, I want install to show Mac checks, Mac configuration, PC checks, optional bootstrap, recovery capture, and PC configuration as clear phases, so that the cross-machine sequence is understandable.
11. As a Hardline operator, I want uninstall to show recorded-state inspection and restoration as clear phases, so that I understand what is being restored.
12. As a Hardline operator, I want doctor to summarize overall health, failed checks, and recommended actions by default, so that healthy detail does not obscure problems.
13. As a Hardline operator, I want verbose doctor output to include successful checks and measurements, so that I can inspect the complete diagnostic.
14. As a Hardline operator, I want up to show one preparation phase and then release the terminal to Moonlight without a spinner, so that terminal output does not interleave.
15. As a Hardline operator, I want interactive questions to use Clack, so that confirmations, choices, and secret entry remain consistent.
16. As a Hardline operator, I want redirected output to contain stable human-readable lines without cursor control, so that logs remain readable.
17. As a Hardline operator, I want the same English meaning in interactive and redirected output, so that execution mode does not change guidance.
18. As an automation author, I want success to exit with zero and every non-success result to exit with one, so that scripts can reliably detect completion.
19. As an automation author, I want a remotely launched but unconfirmed restoration to exit nonzero, so that automation does not treat uncertainty as observed success.
20. As an automation author, I want destructive non-interactive work to require explicit authorization, so that redirection never implies consent.
21. As an automation author, I want global `--verbose` accepted without changing policy, so that diagnostics are safe to enable.
22. As a security-conscious operator, I want secrets excluded from progress, results, errors, and verbose output, so that terminal transcripts cannot expose credentials.
23. As a security-conscious operator, I want raw subprocess output excluded even in verbose mode, so that unstable or sensitive native output does not leak.
24. As a maintainer, I want command policy expressed as semantic facts rather than formatted prose, so that safety decisions remain independent from presentation.
25. As a maintainer, I want each command to retain its own policy and recovery rules, so that a shared lifecycle does not become a universal workflow language.
26. As a maintainer, I want one Command Run interface for all commands, so that lifecycle fixes have leverage across the shell.
27. As a maintainer, I want output adapters to own terminal behavior, so that Clack and non-interactive rendering remain local to their implementations.
28. As a maintainer, I want command-specific English renderers shared by both adapters, so that wording is defined once without entering policy.
29. As a maintainer, I want commands to return results rather than mutate process-global exit state, so that tests observe behavior through the Command Run interface.
30. As a maintainer, I want configuration injected into command policy, so that a generic machine profile can be introduced later without redesigning the Command Run seam.
31. As a maintainer, I want the orchestrator to stream semantic step facts without presentation knowledge, so that verbose progress remains live while orchestration stays reusable.
32. As a maintainer, I want existing state-capture and restoration ordering preserved, so that architectural cleanup does not weaken reversibility.
33. As a maintainer, I want obsolete UI-shaped tests replaced rather than retained, so that the test suite follows the new interface instead of duplicating old structure.
34. As a future command author, I want a small direct authoring interface for phases, warnings, confirmations, choices, and secrets, so that adding a command does not require learning an event bus.
35. As a future maintainer, I want the result vocabulary to distinguish failure, cancellation, and incomplete work, so that recovery guidance remains honest.

## Implementation Decisions

- **Command Run** is the canonical term for one command invocation from accepted operator intent to its final operator-visible result.
- All four commands migrate in one cutover: install, uninstall, doctor, and up.
- The selected architecture is Design C: a direct command-authoring interface rather than a central event bus or one union containing every command policy.
- The Command Run module owns lifecycle ordering, phase state, prompt routing, cancellation normalization, unexpected-error normalization, final rendering, and result-to-exit mapping.
- Each command owns its policy, typed semantic facts, known-error classification, recovery facts, and final result classification.
- The command-authoring interface provides direct operations for phases, progressive detail, warnings, confirmations, choices, and secrets.
- Command policy cannot inspect or branch on verbosity.
- Command policy cannot import Clack, inspect terminal state, write directly to standard streams, or mutate process-global exit state.
- Command policy receives configuration as an injected value rather than reading the compiled global directly.
- The result vocabulary is succeeded, failed, cancelled, and incomplete.
- Succeeded maps to exit code zero. Failed, cancelled, and incomplete map to exit code one.
- Incomplete means the requested result was not fully reached or could not be observed, including detached remote restoration.
- The move from zero to nonzero for unconfirmed remote restoration is an intentional behavior correction.
- Recovery truth belongs to command policy. English phrasing belongs to presentation.
- Questions return semantic answers such as accepted, declined, cancelled, or unavailable. Command policy selects the result because only policy knows whether prior work requires recovery.
- The interactive output adapter uses Clack for titles, spinners, warnings, reports, confirmations, choices, passwords, cancellation, and final output.
- The deterministic text adapter is selected for redirected execution and emits plain human-readable English without ANSI sequences, cursor control, timing-dependent animation, or pseudo-protocol tokens.
- Both output adapters use the same command-specific English renderer.
- Normal mode shows a short title, one spinner per phase, required questions, actionable warnings, and one final sentence.
- Normal-mode activity replaces the previous spinner message instead of preserving every detail.
- Verbose mode preserves completed semantic details progressively while current activity continues to update.
- Verbose mode does not expose raw stdout, raw stderr, stack traces, secrets, or arbitrary debug text.
- A global `--verbose` option applies consistently to all commands. Its placement should not be intentionally restricted when the command parser can support both common positions.
- No JSON output mode is introduced.
- Install phases are Check Mac, Configure Mac, Check PC, conditional Bootstrap PC, conditional Record Recovery State, and Configure PC.
- Uninstall phases are Inspect Recorded State and Restore Previous State.
- Doctor phases are Check Machines, Inspect Configuration, and Measure Link.
- Up has one Prepare Session phase. Moonlight then owns the terminal without an active spinner.
- The orchestrator streams semantic facts for conforming, applied, restored, yielded, detached, and failed steps without importing output concerns or English rendering.
- Previous state remains persisted before any step mutation.
- Restoration remains reverse ordered, continues after individual failures, and retains records for failed, unknown, or unconfirmed work.
- Foreign Apollo state remains visible before consent, backup remains before removal, and non-interactive replacement still requires explicit `--yes` authorization.
- Secret acquisition remains outside step policy, secrets remain memory-scoped, and cleanup remains guaranteed on every exit path.
- Up still validates options before machine work, completes its spinner before Moonlight starts, and performs cleanup after every post-mount outcome.
- Doctor retains its current health rules: installation-only findings remain visible but do not make the link unhealthy; unavailable optional throughput is not a link failure; an attempted measurement failure is a link failure; measured speed alone does not determine health.
- All executable user-facing text becomes English. Comments and test names are translated when their files are directly modified; unrelated documentation-only translation is deferred.
- No backward-compatibility module preserves the old UI interface after migration.

## Testing Decisions

- A good test observes behavior through a confirmed interface and survives changes to internal implementation. Tests must not assert private phase machinery, duplicate production calculations, or retain old presentation mocks after the old interface is removed.
- The primary test seam is the Command Run interface. Command policy tests invoke complete Command Runs and assert semantic progression, returned results, recovery facts, cleanup, and safety ordering.
- The secondary test seam is the shared output-adapter contract. The same semantic scenarios run against Clack and deterministic text adapters to prove equivalent meaning and different presentation.
- Command Run tests cover exactly one start and final, sequential non-nested phases, progressive detail ordering, final output after cleanup, cancellation normalization, unexpected errors, and status-to-exit mapping.
- Adapter tests cover concise detail suppression, verbose detail preservation, spinner cleanup, warning-before-question ordering, deterministic text without control sequences, and shared English wording.
- Prompt tests cover interactive acceptance, decline, cancellation, unavailable non-interactive input, explicit destructive authorization, deterministic non-interactive defaults, and secret non-disclosure.
- Install tests preserve local-before-remote ordering, bootstrap only when SSH is the sole blocker, capture before remaining remote gates, backup before foreign Apollo removal, recovery based on actual manifest state, lock lifetime, and password cleanup.
- Uninstall tests preserve caveats before consent, reverse restoration, continuation after failure, retention of unknown and unconfirmed entries, and the new nonzero incomplete result for unobservable restoration.
- Doctor tests preserve complete collection when the PC is unavailable, installation-only warning semantics, throughput availability semantics, health classification, and concise versus verbose presentation.
- Up tests preserve option validation before machine changes, display selection, preparation progress, spinner completion before Moonlight, stream exit handling, and cleanup after partial mounts or failures.
- Orchestrator tests preserve write-before-mutation, reverse order, immediate removal after observed restoration, retention after failure, yielded restoration behavior, detached launch timestamps, and continued restoration after individual errors.
- CLI tests remain narrow: command registration, existing options, global verbose parsing, adapter selection, injected configuration, English help, and central status-to-exit mapping.
- Existing tests that verify product safety remain and are adapted to the Command Run seam.
- Existing tests that only verify the shape or French wording of the old UI interface are replaced once equivalent adapter tests pass.
- The current baseline is 765 passing tests. The completed migration must finish with the focused suites and the full isolated suite passing.

## Out of Scope

- Designing or implementing the generic machine profile.
- Discovering arbitrary Mac or Windows hardware automatically.
- Supporting additional operating systems.
- Adding a JSON output mode.
- Adding raw subprocess logging to verbose output.
- Adding a generic event bus, replay log, subscriber model, or workflow language.
- Adding hypothetical output adapters without a real consumer.
- Replacing Clack.
- Redesigning the existing manifest model or step lifecycle beyond removing presentation knowledge.
- Changing installation, restoration, diagnostic, streaming, or cleanup policy except for the explicitly approved nonzero incomplete restoration result.
- Translating unrelated comments, tests, or historical design documents solely for language consistency.
- Preserving the old UI interface through a compatibility module.

## Further Notes

- The worktree already contains unrelated in-progress changes, particularly around up, display selection, stream monitoring, and Moonlight cleanup. Implementation must preserve and integrate those changes rather than reverting them.
- The architecture review found no existing ADRs governing this area.
- The direct Design C interface was selected after comparing minimal event-stream, extensible policy-object, caller-first direct, and intent-port designs.
- The deletion test supports the Command Run module: removing it would redistribute phase lifecycle, prompt safety, output modes, cancellation, final ordering, and exit mapping across all four commands.
- The two production adapters make the presentation seam real: Clack for interactive terminals and deterministic text for redirected execution.
