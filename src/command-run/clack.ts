import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  select,
  spinner,
} from "@clack/prompts";
import type { Option } from "@clack/prompts";
import type {
  Choice,
  ChoiceAnswer,
  CommandOutput,
  CommandStatus,
  PromptAnswer,
  SecretAnswer,
} from "./types";

type Spinner = {
  start(text?: string): void;
  message(text?: string): void;
  stop(text?: string): void;
  error(text?: string): void;
};

export type ClackPrimitives = {
  intro(text: string): void;
  outro(text: string): void;
  cancel(text: string): void;
  note(text: string, title?: string): void;
  warn(text: string): void;
  info(text: string): void;
  confirm(text: string): Promise<unknown>;
  select<Value extends string>(
    text: string,
    choices: readonly Choice<Value>[],
    initialValue: Value,
  ): Promise<unknown>;
  password(text: string): Promise<unknown>;
  isCancel(value: unknown): boolean;
  spinner(): Spinner;
};

const clack: ClackPrimitives = {
  intro,
  outro,
  cancel,
  note,
  warn: log.warn,
  info: log.info,
  confirm: (message) => confirm({ message }),
  select: (message, options, initialValue) =>
    select({ message, options: [...options] as Option<string>[], initialValue }),
  password: (message) => password({ message }),
  isCancel,
  spinner,
};

export class ClackOutput implements CommandOutput {
  readonly interactive = true;
  readonly #clack: ClackPrimitives;
  readonly #verbose: boolean;
  #spinner: Spinner | null = null;

  constructor(primitives: ClackPrimitives = clack, options: { verbose: boolean }) {
    this.#clack = primitives;
    this.#verbose = options.verbose;
  }

  start(text: string): void {
    this.#clack.intro(text);
  }
  phaseStart(text: string): void {
    this.#spinner = this.#clack.spinner();
    this.#spinner.start(text);
  }
  phaseActivity(text: string): void {
    this.#spinner?.message(text);
  }
  phaseDetail(text: string): void {
    if (this.#verbose) this.#clack.info(text);
  }
  phaseEnd(text: string, state: "succeeded" | "failed"): void {
    if (state === "succeeded") this.#spinner?.stop(text);
    else this.#spinner?.error(`${text} failed`);
    this.#spinner = null;
  }
  warning(text: string): void {
    this.#clack.warn(text);
  }
  report(title: string, lines: string[]): void {
    this.#clack.note(lines.join("\n"), title);
  }
  async confirm(text: string): Promise<PromptAnswer> {
    const answer = await this.#clack.confirm(text);
    if (this.#clack.isCancel(answer)) return "cancelled";
    return answer ? "accepted" : "declined";
  }
  async choice<Value extends string>(
    text: string,
    choices: readonly Choice<Value>[],
    initialValue: Value,
  ): Promise<ChoiceAnswer<Value>> {
    const answer = await this.#clack.select(text, choices, initialValue);
    if (this.#clack.isCancel(answer)) return { status: "cancelled" };
    return { status: "selected", value: answer as Value };
  }
  async secret(text: string): Promise<SecretAnswer> {
    const answer = await this.#clack.password(text);
    if (this.#clack.isCancel(answer)) return { status: "cancelled" };
    return { status: "provided", value: String(answer) };
  }
  finish(text: string, _status: CommandStatus): void {
    if (_status === "cancelled") this.#clack.cancel(text);
    else this.#clack.outro(text);
  }
}
