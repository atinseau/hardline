export type WindowsObservations = {
  readonly computerName: string;
  readonly machineId: string;
  readonly capturedAt: string;
  readonly activeIpv4Addresses: readonly string[];
  readonly networkAdapters: readonly {
    readonly alias: string;
    readonly interfaceIndex: number;
    readonly macAddress: string;
    readonly ipv4Addresses: readonly string[];
  }[];
  readonly openSsh: {
    readonly capabilityState: string | null;
    readonly serviceStartType: string | null;
    readonly serviceStatus: string | null;
    readonly firewallRulePresent: boolean;
    readonly administratorsAuthorizedKeysPresent: boolean;
    readonly hostKey?: HostKeyObservation | null;
  };
};

export type MutationPlan = {
  readonly directLink: {
    readonly interfaceAlias: string;
    readonly address: string;
    readonly prefixLength: number;
    readonly networkCategory: "Private";
  };
  readonly ssh: {
    readonly installServer: boolean;
    readonly startService: boolean;
    readonly openFirewall: boolean;
    readonly administratorPublicKey: string;
  };
};

export class BootstrapReplayError extends Error {
  readonly code = "BOOTSTRAP_REPLAY";

  constructor() {
    super("The bootstrap token has already been claimed by another client nonce.");
    this.name = "BootstrapReplayError";
  }
}

export class InvalidBootstrapTokenError extends Error {
  readonly code = "INVALID_BOOTSTRAP_TOKEN";

  constructor() {
    super("The bootstrap token must be the provisioned 256-bit token.");
    this.name = "InvalidBootstrapTokenError";
  }
}

export class BootstrapExpiredError extends Error {
  readonly code = "BOOTSTRAP_EXPIRED";

  constructor() {
    super("The Bootstrap Rendezvous has expired.");
    this.name = "BootstrapExpiredError";
  }
}

export class BootstrapPhaseError extends Error {
  readonly code = "INVALID_BOOTSTRAP_PHASE";

  constructor(message: string) {
    super(message);
    this.name = "BootstrapPhaseError";
  }
}

export class BootstrapClosedError extends Error {
  readonly code = "BOOTSTRAP_CLOSED";

  constructor() {
    super("The Bootstrap Rendezvous is closed.");
    this.name = "BootstrapClosedError";
  }
}

export class BootstrapHostKeyConflictError extends Error {
  readonly code = "BOOTSTRAP_HOST_KEY_CONFLICT";

  constructor() {
    super("The observed SSH host key conflicts with the Bootstrap Rendezvous checkpoint.");
    this.name = "BootstrapHostKeyConflictError";
  }
}

export type ObservationResponse = Readonly<{
  kind: "observations-accepted";
}>;

export type BootstrapClaim = Readonly<{
  token: string;
  clientNonce: string;
  observations: WindowsObservations;
}>;

export type BootstrapAuthorizationRequest = Readonly<{
  token: string;
  clientNonce: string;
}>;

export type PlanAuthorization = Readonly<{
  kind: "plan-authorized";
  plan: MutationPlan;
}>;

export type HostKeyObservation = Readonly<{
  algorithm: "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ssh-rsa";
  fingerprint: string;
  publicKey: string;
}>;

export type HostKeyCheckpoint = HostKeyObservation &
  Readonly<{
    machineId: string;
  }>;

export type BootstrapCompletionRequest = BootstrapAuthorizationRequest &
  Readonly<{
    hostKey: HostKeyObservation;
  }>;

export type BootstrapCompletion = Readonly<{
  kind: "ssh-authorized";
  hostKey: HostKeyCheckpoint;
}>;

type ClaimState = Readonly<{
  clientNonce: string;
  observations: WindowsObservations;
  response: ObservationResponse;
}>;

export type BootstrapProtocolOptions = Readonly<{
  token: string;
  expiresAt: number;
  now: () => number;
  prepareTarget: (observations: WindowsObservations) => MutationPlan | Promise<MutationPlan>;
  persistHostKey: (checkpoint: HostKeyCheckpoint) => void | Promise<void>;
}>;

export class BootstrapProtocol {
  readonly #options: BootstrapProtocolOptions;
  #claim?: ClaimState;
  #authorization?: Promise<PlanAuthorization>;
  #planAuthorized = false;
  #completion?: Promise<BootstrapCompletion>;
  #completionCheckpoint?: HostKeyCheckpoint;
  #closed = false;

  constructor(options: BootstrapProtocolOptions) {
    if (!/^[0-9a-f]{64}$/i.test(options.token)) {
      throw new InvalidBootstrapTokenError();
    }
    this.#options = options;
  }

  claim(request: BootstrapClaim): ObservationResponse {
    this.#assertAvailable(request.token);
    if (this.#claim) {
      if (request.clientNonce !== this.#claim.clientNonce) {
        throw new BootstrapReplayError();
      }
      return this.#claim.response;
    }

    const response: ObservationResponse = { kind: "observations-accepted" };
    this.#claim = {
      clientNonce: request.clientNonce,
      observations: request.observations,
      response,
    };
    return response;
  }

  authorizePlan(request: BootstrapAuthorizationRequest): Promise<PlanAuthorization> {
    this.#assertAvailable(request.token);
    const claim = this.#assertClaim(request.clientNonce);
    if (this.#authorization) return this.#authorization;

    let authorization: Promise<PlanAuthorization>;
    authorization = Promise.resolve()
      .then(() => this.#options.prepareTarget(claim.observations))
      .then((plan) => ({
        kind: "plan-authorized" as const,
        plan,
      }))
      .then((response) => {
        this.#planAuthorized = true;
        return response;
      })
      .catch((error: unknown) => {
        if (this.#authorization === authorization) this.#authorization = undefined;
        throw error;
      });
    this.#authorization = authorization;
    return authorization;
  }

  complete(request: BootstrapCompletionRequest): Promise<BootstrapCompletion> {
    this.#assertAvailable(request.token);
    const claim = this.#assertClaim(request.clientNonce);
    if (!this.#planAuthorized) {
      throw new BootstrapPhaseError("The mutation plan has not been authorized.");
    }
    const checkpoint: HostKeyCheckpoint = {
      ...request.hostKey,
      machineId: claim.observations.machineId,
    };
    if (this.#completion) {
      if (!sameHostKey(checkpoint, this.#completionCheckpoint)) {
        throw new BootstrapHostKeyConflictError();
      }
      return this.#completion;
    }

    let completion: Promise<BootstrapCompletion>;
    completion = Promise.resolve()
      .then(() => this.#options.persistHostKey(checkpoint))
      .then(() => ({ kind: "ssh-authorized" as const, hostKey: checkpoint }))
      .catch((error: unknown) => {
        if (this.#completion === completion) {
          this.#completion = undefined;
          this.#completionCheckpoint = undefined;
        }
        throw error;
      });
    this.#completionCheckpoint = checkpoint;
    this.#completion = completion;
    return completion;
  }

  close(): void {
    this.#closed = true;
  }

  #assertAvailable(token: string): void {
    if (this.#closed) throw new BootstrapClosedError();
    if (token !== this.#options.token) throw new InvalidBootstrapTokenError();
    if (this.#options.now() >= this.#options.expiresAt) {
      throw new BootstrapExpiredError();
    }
  }

  #assertClaim(clientNonce: string): ClaimState {
    if (!this.#claim) {
      throw new BootstrapPhaseError("The Bootstrap Rendezvous has not been claimed.");
    }
    if (clientNonce !== this.#claim.clientNonce) throw new BootstrapReplayError();
    return this.#claim;
  }
}

function sameHostKey(
  left: HostKeyCheckpoint,
  right: HostKeyCheckpoint | undefined,
): boolean {
  return (
    right !== undefined &&
    left.machineId === right.machineId &&
    left.algorithm === right.algorithm &&
    left.fingerprint === right.fingerprint &&
    left.publicKey === right.publicKey
  );
}
