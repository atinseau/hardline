import type {
  Choice,
  ChoiceAnswer,
  CommandOutput,
  CommandStatus,
  PromptAnswer,
  SecretAnswer,
} from "./types";

export class TextOutput implements CommandOutput {
  readonly interactive = false;
  readonly #write: (line: string) => void;
  readonly #verbose: boolean;

  constructor(options: { write?: (line: string) => void; verbose: boolean }) {
    this.#write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.#verbose = options.verbose;
  }

  start(text: string): void {
    this.#write(text);
  }
  phaseStart(text: string): void {
    this.#write(`${text}...`);
  }
  phaseActivity(_text: string): void {}
  phaseDetail(text: string): void {
    if (this.#verbose) this.#write(`  ${text}`);
  }
  phaseEnd(text: string, state: "succeeded" | "failed"): void {
    this.#write(`${text} ${state === "succeeded" ? "complete" : "failed"}.`);
  }
  warning(text: string): void {
    this.#write(`Warning: ${text}`);
  }
  report(title: string, lines: string[]): void {
    this.#write(title);
    for (const line of lines) this.#write(`  ${line}`);
  }
  async confirm(text: string, destructive = false): Promise<PromptAnswer> {
    this.#write(
      destructive
        ? `Question unavailable without an interactive terminal: ${text}`
        : `Question unavailable; using the safe default for: ${text}`,
    );
    return destructive ? "unavailable" : "accepted";
  }
  async choice<Value extends string>(
    _text: string,
    _choices: readonly Choice<Value>[],
    initialValue: Value,
  ): Promise<ChoiceAnswer<Value>> {
    return { status: "selected", value: initialValue };
  }
  async secret(): Promise<SecretAnswer> {
    return { status: "unavailable" };
  }
  finish(text: string, _status: CommandStatus): void {
    this.#write(text);
  }
}
