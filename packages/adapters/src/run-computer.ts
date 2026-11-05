import type { ComputerRef } from "@rakazo/adapter-kit";

/** Told back to the model when the tool that needed the computer could not start it. */
export const COMPUTER_START_RETRY_ERROR = "The computer did not start. Try again.";

/**
 * How many times one turn hands a failed computer start back to the model. The next failure
 * ends the turn so the run can start the computer again, instead of calling tools forever.
 */
export const MODEL_COMPUTER_START_TRIES = 3;

const START_FAILURE_KEPT_FROM_MODEL = new Set([
  "AbortError",
  "ComputerBusyError",
  "SandboxRateLimitError",
  "SandboxAllowanceUsedError",
  "SandboxUnresponsiveError",
]);

/** A pod that never became ready. The name is the provider's, so it is not matched loosely. */
const COMPUTER_POD_START_FAILURE =
  /^Kubernetes pod \S+ (?:entered phase \S+|disappeared while starting|did not become ready within \d+ ms)$/;

/**
 * A computer that failed to start is the model's to retry. A busy computer, a provider outage,
 * an account limit, and an abort stay with the run, which already has a wait or a stop for them.
 */
export function modelRetriesComputerStart(error: unknown): boolean {
  if (!(error instanceof Error) || START_FAILURE_KEPT_FROM_MODEL.has(error.name)) return false;
  return (
    error.name === "SandboxDamagedError" ||
    error.name === "SandboxUnavailableError" ||
    /^could not prepare\b/i.test(error.message) ||
    COMPUTER_POD_START_FAILURE.test(error.message)
  );
}

/**
 * A run's computer, started the first time a tool needs it.
 *
 * Remote computers bill while they run, so a run that never touches its computer must not
 * create or resume one. A start the model can retry is forgotten, so the next tool tries
 * again. Any other failed start is kept and rethrown as a setup failure.
 */
export function lazyRunComputer(start: () => Promise<ComputerRef>, onFailure?: () => void) {
  let started: Promise<ComputerRef> | undefined;
  let ready: ComputerRef | undefined;
  let failed = false;
  let failure: unknown;
  let startAttempts = 0;
  let yielded = false;
  return {
    get(): Promise<ComputerRef> {
      started ??= start().then(
        (computer) => {
          ready = computer;
          failed = false;
          failure = undefined;
          startAttempts = 0;
          yielded = false;
          return computer;
        },
        (error: unknown) => {
          startAttempts += 1;
          yielded =
            modelRetriesComputerStart(error) && startAttempts <= MODEL_COMPUTER_START_TRIES;
          if (yielded) {
            started = undefined;
            throw error;
          }
          yielded = false;
          failed = true;
          failure = error;
          onFailure?.();
          throw error;
        },
      );
      return started;
    },
    /** The computer if a tool already started it. */
    get ready(): ComputerRef | undefined {
      return ready;
    },
    /** The latest start failure was thrown for the model to retry, not to end the turn. */
    yieldsToModel(): boolean {
      return yielded;
    },
    acknowledgeYield(): void {
      yielded = false;
    },
    throwIfFailed(): void {
      if (failed) throw failure;
    },
  };
}
