import { BlockedError, type PlatformAdapter } from '../platform';
import type {
  Account,
  Candidate,
  Config,
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
    let checked = 0;
    // Bound work per alarm. Pending observations remain eligible for later verification.
    // Keep checking observed new posts even after they drop off the first list page.
    const visible = new Map(scan.candidates.map((c) => [c.id, c]));
    const pending =
      run.forumTabId === undefined
        ? []
        : (await this.repo.db.getAllFromIndex('threads', 'runId', run.id))
            .filter((t) => t.timeCheckPending && !t.taskId && !t.skipped)
            .sort((a, b) => a.firstSeen - b.firstSeen);
    const order = new Map<string, Candidate>();
    for (const t of pending)
      order.set(
        t.id,
        visible.get(t.id) ?? {
          id: t.id,
          title: t.title,
          author: t.author,
          authorId: t.authorId,
          url: t.url,
          kind: t.kind,
          timeEvidence: 'unavailable',
          timeCheckPending: true,
          source: t.source,
        },
      );
    for (const c of scan.candidates) order.set(c.id, c);
    for (const c of order.values()) {
      if (generation !== this.generation) throw new BlockedError('检查已取消');
      if (filterThread(c, run.config)) continue;
      const prior = await this.repo.db.get('threads', `real:${run.config.forum}:${c.id}`);
      if (
        prior &&
        !(prior.runId === run.id && prior.timeCheckPending && !prior.taskId && !prior.skipped)
      )
        continue;
      if (checked >= 2) break;
      checked++;
      const view = await this.tabs.thread(c.url);
      if (
        view.page.forum !== run.config.forum ||
        view.page.threadId !== c.id ||
        !view.page.account.confirmed ||
        view.page.account.id !== run.account.id
      )
        return { ...scan, blocking: '主题所属贴吧或登录身份不一致，已停止自动处理' };
      if (view.page.publishedAt !== undefined) {
        if (!visible.has(c.id)) scan.candidates.push(c);
        c.publishedAt = view.page.publishedAt;
        c.timePrecisionMs = 60000;
        c.timeEvidence = 'verified';
        c.timeCheckPending = false;
        c.timeLabel =
          new Date(c.publishedAt + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') +
          '（UTC+8，分钟）';
        c.source = '贴吧旧版主题一楼的楼层编号与完整创建时间';
      }
    }
    scan.coverage += `；本次核实 ${checked} 个主题，待核实项保留到后续检查`;
    return scan;
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
