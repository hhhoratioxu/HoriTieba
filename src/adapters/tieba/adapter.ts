import { BlockedError, ThreadUnavailableError, type PlatformAdapter } from '../platform';
import type {
  Account,
  Candidate,
  Config,
  Scan,
  Run,
  Task,
  Step,
  Attempt,
  Prepared,
  Verification,
  Target,
} from '../../domain/models';
import type { WorkTabs } from '../../background/work-tabs';
import type { Repository } from '../../storage/database';
import { filterThread } from '../../domain/policies';
import { evidenceFromPage } from './legacy';
import { listCreationWindow } from './creation-hint';
export const realCapability = {
  read: '新版只读；自动模式通过官方旧版入口读取列表与主题一楼',
  identity: '顶部个人中心、我的贴吧和侧栏头像/主页 ID 交叉核对；发送前再次确认',
  root: '正常编辑器输入、单次点击、独立评论 ID 核实；真实页面已验收 1 条，扩展自动链路已通过本地 fixture',
  selfReply: '旧版 pid/spid 关联；真实页面已验收 1 条且刷新后父编号匹配，只回复自己的首评',
  previousReply: '未开放，追评始终留在自己的首评下',
  creationTime: '主题一楼完整时间（UTC+8，精确到分钟）；与启动分钟重叠时保守跳过',
};
export class TiebaAdapter implements PlatformAdapter {
  readonly canSend = true;
  private generation = 0;
  constructor(
    private tabs: WorkTabs,
    private repo: Repository,
  ) {}
  async detectSession(config?: Config): Promise<Account> {
    if (!config || config.realAction !== 'auto')
      return { id: null, label: '身份未确认', confirmed: false };
    return (await this.tabs.scan(config.forum, config.realAction === 'auto', false)).account;
  }
  async readThreadCandidates(run: Run) {
    const generation = this.generation;
    const scan = await this.tabs.scan(
      run.config.forum,
      run.config.realAction === 'auto',
      run.forumTabId === undefined || run.baseline,
      run.forumTabId,
    );
    if (!run.baseline || scan.blocking || !scan.reliable || run.config.realAction !== 'auto')
      return scan;
    const forumRun = run.forumTabId !== undefined;
    if (
      scan.forum !== run.config.forum ||
      !scan.account.confirmed ||
      scan.account.id !== run.account.id
    )
      return { ...scan, blocking: '列表所属贴吧或登录账号已改变' };
    const selected = await this.planCreationChecks(run, scan, forumRun);
    for (const c of selected) {
      if (generation !== this.generation) throw new BlockedError('检查已取消');
      try {
        const view = await this.tabs.thread(c.url, forumRun);
        if (
          view.draft ||
          view.page.blocking ||
          view.page.forum !== run.config.forum ||
          view.page.threadId !== c.id ||
          !view.page.account.confirmed ||
          view.page.account.id !== run.account.id
        ) {
          throw new BlockedError(
            view.draft
              ? '执行标签页有草稿，已暂停'
              : view.page.blocking || '主题所属贴吧或登录身份不一致，已停止自动处理',
          );
        }
        if (view.page.publishedAt === undefined) {
          if (!forumRun) continue;
        } else {
          c.publishedAt = view.page.publishedAt;
          c.timePrecisionMs = 60000;
          c.timeEvidence = 'verified';
          c.timeCheckPending = false;
          delete c.creationCheck;
          c.timeLabel =
            new Date(c.publishedAt + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') +
            '（UTC+8，分钟）';
          c.source = '贴吧旧版主题一楼的楼层编号与完整创建时间';
          continue;
        }
      } catch (e) {
        if (e instanceof BlockedError) return { ...scan, blocking: e.message };
        if (!forumRun) throw e;
        if (e instanceof ThreadUnavailableError) {
          c.creationCheck = { kind: 'removed' };
          c.timeCheckPending = false;
          continue;
        }
      }
      const attempts = (c.creationCheck?.kind === 'later' ? c.creationCheck.attempts : 0) + 1;
      c.creationCheck = {
        kind: 'later',
        attempts,
        after: Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
      };
      c.timeCheckPending = true;
    }
    scan.coverage += `；本轮查阅 ${selected.length} 篇详情，暂未就绪的主题分开重查`;
    return scan;
  }
  private async planCreationChecks(run: Run, scan: Scan, forumRun: boolean) {
    const observedAt = Date.now();
    const visible = new Set(scan.candidates.map((c) => c.id));
    const pending = forumRun
      ? (await this.repo.db.getAllFromIndex('threads', 'runId', run.id)).filter(
          (t) => t.timeCheckPending && !t.taskId && !t.skipped,
        )
      : [];
    const pendingById = new Map(pending.map((t) => [t.id, t]));
    const candidates = [...scan.candidates];
    for (const t of pending) {
      if (!visible.has(t.id))
        candidates.push({
          id: t.id,
          title: t.title,
          author: t.author,
          authorId: t.authorId,
          url: t.url,
          kind: t.kind,
          timeLabel: t.timeLabel,
          timeEvidence: 'unavailable',
          timeCheckPending: true,
          source: t.source,
        });
    }
    const due: { candidate: Candidate; fresh: boolean; dueAt: number }[] = [];
    for (const c of candidates) {
      if (filterThread(c, run.config)) continue;
      const prior =
        pendingById.get(c.id) ??
        (await this.repo.db.get('threads', `real:${run.config.forum}:${c.id}`));
      if (
        prior &&
        !(prior.runId === run.id && prior.timeCheckPending && !prior.taskId && !prior.skipped)
      )
        continue;
      let fresh = false;
      if (forumRun) {
        const observedLabel = visible.has(c.id) && !!c.timeLabel;
        c.labelObservedAt = observedLabel
          ? observedAt
          : (prior?.labelObservedAt ?? prior?.firstSeen ?? observedAt);
        c.timeLabel ||= prior?.timeLabel;
        const window = listCreationWindow(c.timeLabel, c.labelObservedAt);
        if (window && window.end <= run.startedAt) {
          c.creationCheck = { kind: 'old' };
          c.timeCheckPending = false;
          // Leave two slots for off-list topics that actually need a detail check.
          if (!visible.has(c.id) && scan.candidates.length < 198) scan.candidates.push(c);
          continue;
        }
        fresh = !!window && window.start > run.startedAt;
        c.creationCheck = prior?.creationCheck;
        if (c.creationCheck?.kind === 'later' && c.creationCheck.after > observedAt) continue;
      }
      due.push({
        candidate: c,
        fresh,
        dueAt:
          c.creationCheck?.kind === 'later'
            ? c.creationCheck.after
            : (prior?.firstSeen ?? observedAt),
      });
    }
    // Give one slot to a likely new topic and one to the oldest other observation.
    // An off-list topic or a retry keeps its place even when the forum is busy.
    due.sort((a, b) => a.dueAt - b.dueAt);
    const preferred = due.findIndex((item) => item.fresh);
    if (preferred > 0) due.unshift(...due.splice(preferred, 1));
    return due.slice(0, 2).map(({ candidate }) => {
      if (!visible.has(candidate.id)) scan.candidates.push(candidate);
      return candidate;
    });
  }
  async prepare(task: Task, step: Step, run: Run): Promise<Prepared> {
    if (run.config.realAction !== 'auto' || task.mode !== 'real' || run.mode !== 'real')
      throw new BlockedError('该批次未授权真实自动发送');
    const target: Target =
      step.stage === 'root'
        ? {
            threadId: task.thread.id,
            rootId: '',
            commentId: '',
            authorId: task.account.id!,
            relation: 'root',
          }
        : {
            ...task.root!,
            threadId: task.thread.id,
            commentId: task.root?.rootId ?? '',
            authorId: task.account.id!,
            relation: 'self-root',
          };
    if (step.stage !== 'root' && !task.root) throw new BlockedError('自己的首评尚未核实，禁止追评');
    return this.tabs.prepare(target, run, step);
  }
  async submit(a: Attempt, run: Run): Promise<void> {
    if (a.mode !== 'real' || run.config.realAction !== 'auto')
      throw new BlockedError('真实发送范围不符');
    await this.tabs.submit(a);
  }
  async verifySubmission(a: Attempt): Promise<Verification> {
    if (a.mode !== 'real') return { kind: 'blocked', reason: '拒绝跨模式核实' };
    let reason = '暂未找到唯一的新评论证据；禁止自动重发';
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise((r) => setTimeout(r, 800));
      try {
        const page = await this.tabs.observation(a, i === 2);
        const evidence = evidenceFromPage(a, page);
        if (evidence) return { kind: 'success', evidence };
      } catch (e) {
        reason = e instanceof Error ? e.message : reason;
        break;
      }
    }
    return { kind: 'unknown', reason };
  }
  cancel() {
    this.generation++;
    this.tabs.cancel();
  }
}
