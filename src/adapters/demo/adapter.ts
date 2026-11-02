import type { PlatformAdapter } from '../platform';
import { BlockedError } from '../platform';
import type { Repository } from '../../storage/database';
import type {
  Run,
  Task,
  Step,
  Attempt,
  Prepared,
  Candidate,
  Verification,
  Account,
} from '../../domain/models';
export const demoAccount: Account = {
  id: 'demo-account-001',
  label: '演示账号 · Hori',
  confirmed: true,
};
export class DemoAdapter implements PlatformAdapter {
  readonly canSend = true;
  constructor(
    private repo: Repository,
    private now = () => Date.now(),
  ) {}
  async detectSession() {
    return demoAccount;
  }
  async readThreadCandidates(run: Run) {
    const base: Candidate = {
      id: 'demo-baseline',
      title: '欢迎来到 HoriTieba：这是启动前的历史主题',
      author: '演示吧友',
      url: '',
      publishedAt: run.startedAt - 86400000,
      timeEvidence: 'verified',
      kind: 'thread',
      source: '本地演示数据',
    };
    const candidates = [base];
    if (run.baseline)
      candidates.unshift({
        ...base,
        id: `demo-${run.id}-${run.checks}`,
        title: `新主题 ${run.checks} · 一次有序的交流`,
        publishedAt: this.now(),
        author: `演示吧友 ${run.checks}`,
      });
    return {
      candidates,
      reliable: true,
      coverage: '本地确定性演示列表；不连接贴吧',
      account: demoAccount,
      forum: run.config.forum,
    };
  }
  async prepare(task: Task, step: Step, run: Run): Promise<Prepared> {
    if (run.scenario === 'captcha') throw new BlockedError('演示：检测到验证码，请人工处理后继续');
    if (run.scenario === 'tab-closed') throw new BlockedError('演示：工作标签页已关闭；未执行发送');
    const account =
      run.scenario === 'account-change'
        ? { ...demoAccount, id: 'another-demo-account' }
        : demoAccount;
    const target =
      step.stage === 'root'
        ? {
            threadId: task.thread.id,
            rootId: '',
            commentId: '',
            authorId: demoAccount.id!,
            relation: 'root' as const,
          }
        : {
            threadId: task.thread.id,
            rootId: task.root?.rootId ?? '',
            commentId: task.root?.rootId ?? '',
            authorId: run.scenario === 'target-mismatch' ? 'other-author' : demoAccount.id!,
            relation: 'self-root' as const,
          };
    const beforeIds = (await this.repo.db.getAll('demoLedger'))
      .filter((x) => x.evidence.threadId === task.thread.id)
      .map((x) => x.id);
    return { account, target, beforeIds };
  }
  async submit(attempt: Attempt, run: Run) {
    if (run.mode !== 'demo' || attempt.mode !== 'demo')
      throw new BlockedError('演示适配器拒绝真实数据');
    if (run.scenario === 'failure') return;
    const id = `demo-comment-${attempt.id}`;
    await this.repo.db.put('demoLedger', {
      id,
      attemptId: attempt.id,
      evidence: {
        commentId: id,
        threadId: attempt.target.threadId,
        rootId: attempt.stage === 'root' ? id : attempt.target.rootId,
        targetId: attempt.stage === 'root' ? null : attempt.target.commentId,
        authorId: attempt.accountId,
        text: attempt.text,
        createdAt: this.now(),
        observedAt: this.now(),
        source: 'demo-ledger',
      },
    });
    if (run.scenario === 'unknown')
      throw Error('演示：发送后连接中断；模拟平台已经接收，但当前结果未知');
  }
  async verifySubmission(a: Attempt): Promise<Verification> {
    const e = await this.repo.db.getFromIndex('demoLedger', 'attemptId', a.id);
    return e
      ? { kind: 'success', evidence: { ...e.evidence, observedAt: this.now() } }
      : { kind: 'failed', reason: '演示平台明确拒绝；没有生成评论' };
  }
  cancel() {}
}
