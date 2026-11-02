import type {
  Run,
  Scan,
  Task,
  Step,
  Prepared,
  Attempt,
  Verification,
  Account,
  Config,
} from '../domain/models';
export interface PlatformAdapter {
  readonly canSend: boolean;
  detectSession(config?: Config): Promise<Account>;
  readThreadCandidates(run: Run): Promise<Scan>;
  prepare(task: Task, step: Step, run: Run): Promise<Prepared>;
  submit(attempt: Attempt, run: Run): Promise<void>;
  verifySubmission(attempt: Attempt): Promise<Verification>;
  cancel(): void;
}
export class BlockedError extends Error {
  name = 'BlockedError';
}
export class PageNotReadyError extends Error {
  name = 'PageNotReadyError';
}
