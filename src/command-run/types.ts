export type CommandStatus = "succeeded" | "failed" | "cancelled" | "incomplete";

export type SucceededResult<Fact> = {
  status: "succeeded";
  summary: Fact;
};

export type FailedResult<Fact> = { status: "failed"; summary: Fact };
export type CancelledResult<Fact> = { status: "cancelled"; summary: Fact };
export type IncompleteResult<Fact> = { status: "incomplete"; summary: Fact };

export type CommandResult<Fact> =
  | SucceededResult<Fact>
  | FailedResult<Fact>
  | CancelledResult<Fact>
  | IncompleteResult<Fact>;

export type PromptAnswer = "accepted" | "declined" | "cancelled" | "unavailable";

export type ChoiceAnswer<Value extends string> =
  | { status: "selected"; value: Value }
  | { status: "cancelled" | "unavailable" };

export type SecretAnswer =
  | { status: "provided"; value: string }
  | { status: "cancelled" | "unavailable" };

export type Choice<Value extends string> = {
  value: Value;
  label: string;
  hint?: string;
};

export interface CommandOutput {
  readonly interactive: boolean;
  start(text: string): void;
  phaseStart(text: string): void;
  phaseActivity(text: string): void;
  phaseDetail(text: string): void;
  phaseEnd(text: string, state: "succeeded" | "failed"): void;
  warning(text: string): void;
  report(title: string, lines: string[]): void;
  confirm(text: string, destructive?: boolean): Promise<PromptAnswer>;
  choice<Value extends string>(
    text: string,
    choices: readonly Choice<Value>[],
    initialValue: Value,
  ): Promise<ChoiceAnswer<Value>>;
  secret(text: string): Promise<SecretAnswer>;
  finish(text: string, status: CommandStatus): void;
}

export interface CommandRun<Fact> {
  phase<T>(label: Fact, operation: () => Promise<T>): Promise<T>;
  activity(fact: Fact): void;
  detail(fact: Fact): void;
  warning(fact: Fact): void;
  report(title: Fact, lines: Fact[]): void;
  confirm(
    question: Fact,
    options: { assumeYes: boolean; destructive?: boolean },
  ): Promise<Exclude<PromptAnswer, "cancelled">>;
  choice<Value extends string>(
    question: Fact,
    choices: readonly { value: Value; label: Fact; hint?: Fact }[],
    initialValue: Value,
  ): Promise<Exclude<ChoiceAnswer<Value>, { status: "cancelled" }>>;
  secret(question: Fact): Promise<Exclude<SecretAnswer, { status: "cancelled" }>>;
}
