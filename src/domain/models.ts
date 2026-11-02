export const stages = ['root', 'reply1', 'reply2', 'reply3', 'reply4'] as const;
export type Stage = (typeof stages)[number];
export type Mode = 'demo' | 'real';
export const stageNames: Record<Stage, string> = {
  root: '首评',
  reply1: '回复 1',
  reply2: '回复 2',
  reply3: '回复 3',
  reply4: '回复 4',
};
export type Status =
  | 'queued'
  | 'waiting'
  | 'running'
  | 'verifying'
  | 'unknown'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stopped'
  | 'skipped'
  | 'disabled';
export const statusNames: Record<Status, string> = {
  queued: '待处理',
  waiting: '等待执行时间',
  running: '执行中',
  verifying: '核实中',
  unknown: '结果未知',
  paused: '已暂停',
  blocked: '被阻断',
  failed: '失败',
  completed: '完成',
  stopped: '已停止',
  skipped: '已跳过',
  disabled: '未启用',
};
export interface Item {
  id: string;
  text: string;
}
export interface Library {
  id: string;
  mode: Mode;
  stage: Stage;
  version: number;
  enabled: boolean;
  loop: boolean;
  items: Item[];
}
export interface Config {
  id: Mode;
  version: number;
  forum: string;
  include: string[];
  exclude: string[];
  authors: string[];
  match: 'any' | 'all';
  selfReply: boolean;
  replyMode: 'root';
  maxPosts: number;
  maxSends: number;
  maxReplies: number;
  checkSeconds: number;
  sendSeconds: number;
  realAction?: 'read' | 'auto';
}
export interface Account {
  id: string | null;
  label: string;
  confirmed: boolean;
  reason?: string;
}
export interface Candidate {
  id: string;
  title: string;
  author: string;
  authorId?: string;
  url: string;
  publishedAt?: number;
  timePrecisionMs?: number;
  timeCheckPending?: boolean;
  timeLabel?: string;
  timeEvidence: 'verified' | 'relative' | 'unavailable';
  kind: 'thread' | 'pinned' | 'recommended' | 'ad';
  source: string;
}
export interface Thread extends Candidate {
  key: string;
  mode: Mode;
  forum: string;
  firstSeen: number;
  runId: string;
  decision: string;
  taskId?: string;
  skipped?: boolean;
}
export interface Step {
  id: string;
  stage: Stage;
  status: Status;
  libraryVersion: number;
  itemId?: string;
  text?: string;
  cursor?: number;
  cursorKey?: string;
  attemptId?: string;
  startedAt?: number;
  endedAt?: number;
  reason?: string;
  evidence?: Evidence;
  committed?: boolean;
  preparationRetries?: number;
}
export interface Task {
  id: string;
  mode: Mode;
  runId: string;
  thread: Candidate;
  account: Account;
  configVersion: number;
  dedupeKey: string;
  status: Status;
  steps: Step[];
  createdAt: number;
  updatedAt: number;
  plannedAt: number;
  root?: Target;
  reason?: string;
}
export interface Target {
  threadId: string;
  rootId: string;
  commentId: string;
  authorId: string;
  relation: 'root' | 'self-root';
  pageUrl?: string;
}
export interface Evidence {
  commentId: string;
  authorId: string;
  threadId: string;
  rootId: string;
  targetId: string | null;
  text: string;
  createdAt: number;
  timePrecisionMs?: number;
  pageUrl?: string;
  observedAt: number;
  source: 'demo-ledger' | 'dom' | 'manual';
  note?: string;
}
export interface Attempt {
  id: string;
  mode: Mode;
  runId: string;
  taskId: string;
  stepId: string;
  stage: Stage;
  accountId: string;
  target: Target;
  text: string;
  intendedAt: number;
  submittedAt?: number;
  status: 'intent' | 'submitted' | 'verified' | 'failed' | 'unknown';
  beforeIds: string[];
  evidence?: Evidence;
  reason?: string;
}
export interface Run {
  id: string;
  mode: Mode;
  status: 'running' | 'paused' | 'blocked' | 'stopped' | 'completed';
  config: Config;
  libraries: Library[];
  account: Account;
  startedAt: number;
  baseline: boolean;
  nextCheckAt: number;
  nextSendAt: number;
  lastCheckAt?: number;
  lastActivity: number;
  epoch: number;
  checks: number;
  readFailures: number;
  reason?: string;
  coverage: string;
  sendCount: number;
  taskCount: number;
  discovered: number;
  matched: number;
  rootSuccess: number;
  replySuccess: number;
  unknownCount: number;
  failedCount: number;
  demoSequence: number;
  scenario:
    | 'success'
    | 'failure'
    | 'captcha'
    | 'unknown'
    | 'account-change'
    | 'target-mismatch'
    | 'tab-closed';
}
export interface Cursor {
  id: string;
  position: number;
}
export interface Lease {
  id: string;
  owner: string;
  expiresAt: number;
}
export interface Log {
  id: string;
  mode: Mode;
  at: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  message: string;
  taskId?: string;
  runId?: string;
}
export interface Scan {
  candidates: Candidate[];
  reliable: boolean;
  coverage: string;
  account: Account;
  blocking?: string;
  forum: string;
}
export interface Prepared {
  target: Target;
  beforeIds: string[];
  account: Account;
}
export type Verification =
  | { kind: 'success'; evidence: Evidence }
  | { kind: 'failed' | 'unknown' | 'blocked'; reason: string };
export const uid = () => crypto.randomUUID();
export const libraryId = (mode: Mode, stage: Stage) => `${mode}:${stage}`;
export const cursorId = (library: Library) => `${library.id}:v${library.version}`;
export const defaultConfig = (mode: Mode): Config => ({
  id: mode,
  version: 1,
  forum: mode === 'demo' ? 'HoriTieba 演示' : '贴吧',
  include: [],
  exclude: [],
  authors: [],
  match: 'any',
  selfReply: true,
  replyMode: 'root',
  maxPosts: 3,
  maxSends: 10,
  maxReplies: 4,
  checkSeconds: 60,
  sendSeconds: 30,
});
export const enabledStages = (config: Config, libraries: Library[]) =>
  stages
    .filter(
      (s) => s === 'root' || (config.selfReply && libraries.find((l) => l.stage === s)?.enabled),
    )
    .filter((_, i) => i <= config.maxReplies);
