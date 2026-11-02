import { reserveSlot, releaseSlot } from '../send-slot';
import { threadRunKey, type ThreadReplyRun } from '../../shared/thread-reply';
import { Repository, type Transaction } from '../../storage/database';
import {
  uid,
  stages,
  stageNames,
  enabledStages,
  cursorId,
  defaultConfig,
  type Account,
  type Library,
  type Scan,
  type Mode,
  type Run,
  type Task,
  type Step,
  type Attempt,
  type Verification,
  type Evidence,
  type Config,
} from '../../domain/models';
import { assertPrepared, filterThread, validEvidence } from '../../domain/policies';
import { configSchema, normalizeForum } from '../../shared/validation';
import type { PlatformAdapter } from '../../adapters/platform';
import { PageNotReadyError } from '../../adapters/platform';

const terminal = new Set(['completed', 'stopped', 'skipped']);
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');
export class Engine {
  private owner = uid();
  private busy = new Set<Mode>();
  private fault: string | null = null;
  private cancellationVersion: Record<Mode, number> = { demo: 0, real: 0 };
  constructor(
    public repo: Repository,
    private adapters: Record<Mode, PlatformAdapter>,
    private now = () => Date.now(),
  ) {}
  get storageFault() {
    return this.fault;
  }
  private sends(mode: Mode, config: Config) {
    return this.adapters[mode].canSend && (mode === 'demo' || config.realAction === 'auto');
  }
  async currentTx(tx: Transaction, mode: Mode) {
    const id = (await tx.objectStore('meta').get(`active:${mode}`))?.value as string | undefined;
    return id ? tx.objectStore('runs').get(id) : undefined;
  }
  async preflight(mode: Mode) {
    const config = await this.repo.db.get('configs', mode);
    return this.adapters[mode].detectSession(config);
  }
  async start(
    mode: Mode,
    expected?: { configVersion: number; libraryVersions: number[]; accountId?: string },
    page?: { tabId: number; forum: string; text: string; account: Account },
  ) {
    if (this.fault) throw Error(this.fault);
    if (page && mode !== 'real') throw Error('贴吧页面只能启动真实模式。');
    const instance = uid();
    const config = page
      ? {
          ...defaultConfig('real'),
          forum: page.forum,
          realAction: 'auto' as const,
          selfReply: false,
          maxReplies: 0,
          checkSeconds: 30,
        }
      : configSchema.parse(await this.repo.db.get('configs', mode));
    config.forum = normalizeForum(config.forum);
    const libraries: Library[] = page
      ? stages.map((stage) => ({
          id: 'forum:' + instance + ':' + stage,
          mode,
          stage,
          version: 1,
          enabled: stage === 'root',
          loop: stage === 'root',
          items: stage === 'root' ? [{ id: instance, text: page.text }] : [],
        }))
      : await this.repo.libraries(mode);
    if (
      expected &&
      (expected.configVersion !== config.version ||
        libraries.some((l, i) => l.version !== expected.libraryVersions[i]))
    )
      throw Error('启动摘要已过期：配置或内容库已变更，请重新确认');
    const adapter = this.adapters[mode];
    const account = page?.account ?? (await adapter.detectSession(config));
    const canSend = this.sends(mode, config);
    if (canSend) {
      if (!account.confirmed || !account.id) throw Error('身份未确认');
      if (mode === 'real' && !page && expected?.accountId !== account.id)
        throw Error('启动摘要账号缺失或已改变，请重新核对');
      for (const s of enabledStages(config, libraries)) {
        if (!libraries.find((l) => l.stage === s)?.items.length)
          throw Error(`${s === 'root' ? '首评' : '追评'}内容库为空`);
      }
    }
    const now = this.now();
    const run: Run = {
      id: instance,
      ...(page ? { forumTabId: page.tabId } : {}),
      mode,
      status: 'running',
      config,
      libraries,
      account,
      startedAt: now,
      baseline: false,
      nextCheckAt: now,
      nextSendAt: now,
      lastActivity: now,
      epoch: 1,
      checks: 0,
      readFailures: 0,
      coverage: canSend ? '等待建立初始基线' : '只读监控，不会自动发送',
      sendCount: 0,
      taskCount: 0,
      discovered: 0,
      matched: 0,
      rootSuccess: 0,
      replySuccess: 0,
      unknownCount: 0,
      failedCount: 0,
      demoSequence: 0,
      scenario: 'success',
    };
    await this.repo.atomic(async (tx) => {
      if (!page) {
        const storedConfig = await tx.objectStore('configs').get(mode);
        if (storedConfig?.version !== config.version) throw Error('启动期间配置已变更，请重新确认');
        for (const lib of libraries) {
          if ((await tx.objectStore('libraries').get(lib.id))?.version !== lib.version)
            throw Error('启动期间内容库已变更，请重新确认');
        }
      }
      if (!page && canSend && mode === 'real') {
        const simple = (await tx.objectStore('meta').get(threadRunKey))?.value as
          ThreadReplyRun | undefined;
        if (simple?.running) throw Error('请先在帖子底部停止本帖自动回复。');
      }
      const old = await this.currentTx(tx, mode);
      if (old && !['stopped', 'completed'].includes(old.status))
        throw Error('已有运行批次，请先继续或停止');
      const tasks = await tx.objectStore('tasks').index('mode').getAll(mode);
      if (
        tasks.some((t) =>
          t.steps.some((s) => ['running', 'verifying', 'unknown'].includes(s.status)),
        )
      )
        throw Error('仍有未核实的发送，不能新建运行');
      await tx.objectStore('runs').add(run);
      await tx.objectStore('meta').put({ id: `active:${mode}`, value: run.id });
    });
    await this.repo.log(
      mode,
      'run.start',
      canSend
        ? `已按确认范围启动${mode === 'demo' ? '演示' : '真实'}自动流程`
        : '已启动真实只读监控；本批次不会发送',
      'info',
      undefined,
      run.id,
    );
    return run;
  }
  async control(
    mode: Mode,
    action: 'pause' | 'resume' | 'stop' | 'emergency',
    expectedRunId?: string,
  ) {
    if (action !== 'resume' && !expectedRunId) {
      this.cancellationVersion[mode]++;
      this.adapters[mode].cancel();
    }
    await this.repo.atomic(async (tx) => {
      const run = await this.currentTx(tx, mode);
      if (!run) throw Error('尚未启动');
      if (expectedRunId && run.id !== expectedRunId) throw Error('任务已切换，请重新查看。');
      if (expectedRunId && action !== 'resume' && !['stopped', 'completed'].includes(run.status)) {
        this.cancellationVersion[mode]++;
        this.adapters[mode].cancel();
      }
      const tasks = await tx.objectStore('tasks').index('runId').getAll(run.id);
      if (action === 'resume') {
        if (!['paused', 'blocked'].includes(run.status)) throw Error('当前状态不能继续');
        if (
          tasks.some((t) =>
            t.steps.some((s) => ['unknown', 'verifying', 'running', 'failed'].includes(s.status)),
          )
        )
          throw Error('请先核实未知结果或明确处理失败步骤');
        run.status = 'running';
        run.reason = undefined;
        run.nextCheckAt = Math.max(run.nextCheckAt, this.now() + 1000);
        run.nextSendAt = Math.max(run.nextSendAt, this.now() + run.config.sendSeconds * 1000);
        for (const t of tasks) {
          if (['paused', 'blocked'].includes(t.status)) {
            t.status = 'waiting';
            t.reason = undefined;
            for (const s of t.steps)
              if (['paused', 'blocked'].includes(s.status)) s.status = 'queued';
            await tx.objectStore('tasks').put(t);
          }
        }
      } else {
        if (['stopped', 'completed'].includes(run.status)) return;
        run.status = action === 'pause' ? 'paused' : 'stopped';
        run.reason =
          action === 'pause'
            ? '用户暂停：已提交的操作仍会核实'
            : action === 'emergency'
              ? '紧急停止：已禁止新发送；已提交操作可能无法撤回'
              : '用户停止当前批次';
        for (const t of tasks) {
          if (terminal.has(t.status)) continue;
          const inflight = t.steps.some((s) =>
            ['running', 'verifying', 'unknown'].includes(s.status),
          );
          if (!inflight) t.status = action === 'pause' ? 'paused' : 'stopped';
          for (const s of t.steps) {
            if (['queued', 'waiting', 'blocked', 'paused'].includes(s.status))
              s.status = action === 'pause' ? 'paused' : 'stopped';
          }
          await tx.objectStore('tasks').put(t);
        }
      }
      run.epoch++;
      run.lastActivity = this.now();
      await tx.objectStore('runs').put(run);
    });
    await this.repo.log(
      mode,
      `run.${action}`,
      action === 'emergency'
        ? '紧急停止已生效；不会把已提交内容标记为已撤回'
        : `运行控制：${{ pause: '暂停', resume: '继续', stop: '停止' }[action]}`,
    );
  }
  async recover() {
    await this.repo.atomic(async (tx) => {
      for (const mode of ['demo', 'real'] as const) {
        const run = await this.currentTx(tx, mode);
        if (!run) continue;
        let uncertain = false;
        for (const task of await tx.objectStore('tasks').index('runId').getAll(run.id)) {
          for (const step of task.steps) {
            if (!['running', 'verifying'].includes(step.status)) continue;
            const a = step.attemptId
              ? await tx.objectStore('attempts').get(step.attemptId)
              : undefined;
            if (a && ['intent', 'submitted', 'unknown'].includes(a.status)) {
              if (a.status !== 'unknown') run.unknownCount++;
              a.status = 'unknown';
              a.reason = '后台中断：不能确认发送是否发生，必须先核实';
              await tx.objectStore('attempts').put(a);
              step.status = 'unknown';
              task.status = 'unknown';
              uncertain = true;
            } else {
              step.status = run.status === 'stopped' ? 'stopped' : 'queued';
              task.status = run.status === 'stopped' ? 'stopped' : 'waiting';
            }
          }
          await tx.objectStore('tasks').put(task);
        }
        if (run.status === 'running' || uncertain) {
          if (uncertain && run.status !== 'stopped') run.status = 'paused';
          run.reason = uncertain
            ? '恢复发现未核实发送；禁止自动重发'
            : '后台已恢复，将重新核对页面和账号，不补发错过的计划';
          run.epoch++;
          run.nextCheckAt = uncertain
            ? this.now() + run.config.checkSeconds * 1000
            : Math.max(run.nextCheckAt, this.now());
          run.nextSendAt = uncertain
            ? this.now() + run.config.sendSeconds * 1000
            : Math.max(run.nextSendAt, this.now());
        }
        await tx.objectStore('runs').put(run);
        await tx.objectStore('leases').delete(`engine:${mode}`);
      }
    });
  }
  async tick(mode: Mode) {
    if (this.fault || this.busy.has(mode)) return;
    this.busy.add(mode);
    let acquired = false;
    try {
      acquired = await this.repo.lease(`engine:${mode}`, this.owner, this.now(), 120000);
      if (!acquired) return;
      let run = await this.repo.current(mode);
      if (!run || run.status !== 'running') return;
      if (run.lastActivity > this.now() + 5000) {
        await this.blockRun(mode, '检测到系统时钟回退，请检查后继续');
        return;
      }
      // Expired leases never imply an earlier external send did not happen.
      const unresolved = (await this.repo.db.getAllFromIndex('tasks', 'runId', run.id)).some((t) =>
        t.steps.some((s) => ['running', 'verifying', 'unknown'].includes(s.status)),
      );
      if (unresolved) {
        await this.blockRun(mode, '存在未核实的发送，先恢复核实');
        return;
      }
      if (this.now() >= run.nextCheckAt) await this.scan(run);
      run = await this.repo.current(mode);
      if (run?.status === 'running' && this.now() >= run.nextSendAt && this.sends(mode, run.config))
        await this.advance(run);
    } catch (e) {
      this.fault = `本地状态写入或调度失败，已禁止新发送：${errorText(e)}`;
      this.adapters[mode].cancel();
    } finally {
      if (acquired)
        await this.repo.release(`engine:${mode}`, this.owner).catch(() => {
          this.fault = '无法保存执行锁，已禁止新发送，请检查存储空间';
        });
      this.busy.delete(mode);
    }
  }
  private async blockRun(mode: Mode, reason: string) {
    await this.repo.atomic(async (tx) => {
      const run = await this.currentTx(tx, mode);
      if (run && run.status !== 'stopped') {
        run.status = 'blocked';
        run.reason = reason;
        run.epoch++;
        await tx.objectStore('runs').put(run);
      }
    });
  }
  async scan(snapshot: Run, initial?: Scan) {
    const now = this.now();
    const allowed = await this.repo.atomic(async (tx) => {
      const r = await this.currentTx(tx, snapshot.mode);
      if (!r || r.id !== snapshot.id || r.status !== 'running' || r.nextCheckAt > now) return false;
      r.nextCheckAt = now + r.config.checkSeconds * 1000;
      r.checks++;
      r.lastActivity = now;
      await tx.objectStore('runs').put(r);
      return true;
    });
    if (!allowed) return;
    let result;
    try {
      result = initial ?? (await this.adapters[snapshot.mode].readThreadCandidates(snapshot));
    } catch (e) {
      await this.repo.atomic(async (tx) => {
        const r = await tx.objectStore('runs').get(snapshot.id);
        if (!r) return;
        r.readFailures++;
        r.reason = `读取失败，已退避：${errorText(e)}`;
        r.nextCheckAt =
          this.now() +
          Math.min(3600, r.config.checkSeconds * 2 ** Math.min(5, r.readFailures)) * 1000;
        await tx.objectStore('runs').put(r);
      });
      return;
    }
    await this.repo.atomic(async (tx) => {
      const r = await this.currentTx(tx, snapshot.mode);
      if (!r || r.id !== snapshot.id || r.status !== 'running' || r.epoch !== snapshot.epoch)
        return;
      if (result.forum !== r.config.forum) {
        r.status = 'blocked';
        r.reason = '工作页面已切换到其他贴吧';
        r.epoch++;
        await tx.objectStore('runs').put(r);
        return;
      }
      r.coverage = result.coverage;
      if (!result.blocking) r.lastCheckAt = this.now();
      r.lastActivity = this.now();
      r.readFailures = 0;
      r.reason = result.blocking;
      const identityOK =
        (!this.sends(r.mode, r.config) && !r.account.confirmed) ||
        (result.account.confirmed && result.account.id === r.account.id);
      if (!this.sends(r.mode, r.config) && !r.account.confirmed) r.account = result.account;
      if (result.blocking) {
        r.status = 'blocked';
        r.epoch++;
      }
      if (!identityOK) {
        r.status = 'blocked';
        r.reason = '账号已变化或身份未确认';
        r.epoch++;
      }
      const baseline = !r.baseline;
      for (const c of result.candidates.slice(0, r.forumTabId === undefined ? 100 : 102)) {
        const key = `${r.mode}:${r.config.forum}:${c.id}`;
        const prior = await tx.objectStore('threads').get(key);
        const recheck =
          prior?.runId === r.id && prior.timeCheckPending && !prior.taskId && !prior.skipped;
        if (prior && !recheck) {
          await tx.objectStore('threads').put({ ...prior, title: c.title });
          continue;
        }
        if (!prior) r.discovered++;
        let decision = baseline ? '启动前基线，仅展示' : filterThread(c, r.config);
        if (!decision && (!result.reliable || c.timeEvidence !== 'verified' || !c.publishedAt))
          decision = '发布时间无法可靠核实，仅展示';
        if (!decision && c.publishedAt! <= r.startedAt)
          decision =
            c.publishedAt! + (c.timePrecisionMs ?? 1) > r.startedAt
              ? '创建时间与启动分钟重叠，保守跳过'
              : '历史主题上浮，不自动处理';
        if (!decision && c.publishedAt! > this.now() + 2000)
          decision = '创建时间晚于当前时间，禁止入队';
        if (!decision && (!identityOK || result.blocking))
          decision = result.blocking || '身份未确认';
        if (!decision && !this.sends(r.mode, r.config)) decision = '本批次只读，仅展示';
        const dedupeKey = `${r.mode}:${r.account.id}:${c.id}`;
        if (!decision && (await tx.objectStore('dedupe').get(dedupeKey)))
          decision = '该账号已处理，跨批次去重';
        if (!decision && r.forumTabId === undefined && r.taskCount >= r.config.maxPosts)
          decision = '已达本次帖子上限';
        let taskId: string | undefined;
        if (!decision) {
          r.matched++;
          r.taskCount++;
          taskId = uid();
          const enabled = enabledStages(r.config, r.libraries);
          const task: Task = {
            id: taskId,
            mode: r.mode,
            runId: r.id,
            thread: c,
            account: r.account,
            configVersion: r.config.version,
            dedupeKey,
            status: 'queued',
            steps: stages.map((stage) => ({
              id: uid(),
              stage,
              status: enabled.includes(stage) ? 'queued' : 'disabled',
              libraryVersion: r.libraries.find((l) => l.stage === stage)!.version,
            })),
            createdAt: this.now(),
            updatedAt: this.now(),
            plannedAt: Math.max(this.now(), r.nextSendAt),
          };
          await tx.objectStore('tasks').add(task);
          await tx.objectStore('dedupe').add({ id: dedupeKey, taskId });
          decision = '符合规则，已入队';
        }
        await tx.objectStore('threads').put({
          ...c,
          key,
          mode: r.mode,
          forum: r.config.forum,
          firstSeen: prior?.firstSeen ?? this.now(),
          runId: r.id,
          decision: decision!,
          taskId,
          timeCheckPending:
            !baseline &&
            !taskId &&
            c.timeEvidence !== 'verified' &&
            c.timeCheckPending === true &&
            !filterThread(c, r.config),
        });
      }
      if (!result.blocking) r.baseline = true;
      await tx.objectStore('runs').put(r);
      // Bounded observed-thread cache. Task dedupe persists separately forever.
      const all = await tx.objectStore('threads').index('mode').getAll(r.mode);
      if (all.length > 10000) {
        const old = all.filter((t) => !t.taskId).sort((a, b) => a.firstSeen - b.firstSeen);
        for (const t of old.slice(0, all.length - 10000))
          await tx.objectStore('threads').delete(t.key);
      }
    });
  }
  private async advance(run: Run) {
    const cancellationVersion = this.cancellationVersion[run.mode];
    const tasks = (await this.repo.db.getAllFromIndex('tasks', 'runId', run.id))
      .filter((t) => !terminal.has(t.status))
      .sort((a, b) => a.createdAt - b.createdAt);
    const task = tasks[0];
    if (!task) {
      if (run.forumTabId === undefined && run.taskCount >= run.config.maxPosts)
        await this.finishRun(run.id, '已达到本次帖子上限，流程结束');
      return;
    }
    if (!['queued', 'waiting'].includes(task.status)) return;
    const step = task.steps.find((s) => s.status !== 'completed' && s.status !== 'disabled');
    if (!step) return;
    const lib = run.libraries.find((l) => l.stage === step.stage)!;
    const key = cursorId(lib);
    const cursor = (await this.repo.db.get('cursors', key))?.position ?? 0;
    const position = lib.loop && lib.items.length ? cursor % lib.items.length : cursor;
    const item = lib.items[position];
    if (!item) {
      await this.blockRun(
        run.mode,
        `${step.stage === 'root' ? '首评' : step.stage.replace('reply', '回复 ')}内容已用尽；可停止后配置新批次`,
      );
      return;
    }
    if (run.forumTabId === undefined && run.sendCount >= run.config.maxSends) {
      await this.finishRun(run.id, '达到本次评论总量上限（包含首评、追评与未知尝试）');
      return;
    }
    const startAllowed = await this.repo.atomic(async (tx) => {
      const r = await tx.objectStore('runs').get(run.id);
      const t = await tx.objectStore('tasks').get(task.id);
      if (!r || !t || r.status !== 'running' || r.epoch !== run.epoch) return false;
      const s = t.steps.find((s) => s.id === step.id)!;
      if (!['queued', 'waiting'].includes(s.status)) return false;
      Object.assign(s, {
        text: item.text,
        itemId: item.id,
        cursor,
        cursorKey: key,
        startedAt: this.now(),
        status: 'running',
      });
      t.status = 'running';
      t.updatedAt = this.now();
      await tx.objectStore('tasks').put(t);
      return true;
    });
    if (!startAllowed) return;
    Object.assign(step, {
      text: item.text,
      itemId: item.id,
      cursor,
      cursorKey: key,
      startedAt: this.now(),
      status: 'running',
    });
    const adapter = this.adapters[run.mode];
    let prepared;
    try {
      prepared = await adapter.prepare(task, step, run);
      assertPrepared(task, step.stage, prepared);
    } catch (e) {
      await this.preparationFailed(run, task, step, errorText(e), e instanceof PageNotReadyError);
      return;
    }
    const attempt: Attempt = {
      id: uid(),
      mode: run.mode,
      runId: run.id,
      taskId: task.id,
      stepId: step.id,
      stage: step.stage,
      accountId: run.account.id!,
      target: prepared.target,
      text: item.text,
      intendedAt: this.now(),
      status: 'intent',
      beforeIds: prepared.beforeIds,
    };
    const permit = await this.repo.atomic(async (tx) => {
      const r = await tx.objectStore('runs').get(run.id);
      const t = await tx.objectStore('tasks').get(task.id);
      if (!r || !t) return false;
      const s = t.steps.find((s) => s.id === step.id)!;
      if (
        r.status !== 'running' ||
        r.epoch !== run.epoch ||
        (r.forumTabId === undefined && r.sendCount >= r.config.maxSends)
      ) {
        s.status = r.status === 'stopped' ? 'stopped' : 'paused';
        t.status = s.status;
        await tx.objectStore('tasks').put(t);
        return false;
      }
      if (r.forumTabId !== undefined) {
        const due = await reserveSlot(tx, attempt.accountId, attempt.id, this.now());
        if (due) {
          r.nextSendAt = Math.max(r.nextSendAt, Math.min(due, this.now() + 30000));
          s.status = 'waiting';
          t.status = 'waiting';
          await tx.objectStore('runs').put(r);
          await tx.objectStore('tasks').put(t);
          return false;
        }
      }
      s.attemptId = attempt.id;
      await tx.objectStore('attempts').add(attempt);
      await tx.objectStore('tasks').put(t);
      return true;
    });
    if (!permit) return;
    // Durable permission marker precedes the external action. A crash here is unknown, never auto-retried.
    const finalPermit = await this.repo.atomic(async (tx) => {
      const r = await tx.objectStore('runs').get(run.id);
      const t = await tx.objectStore('tasks').get(task.id);
      const a = await tx.objectStore('attempts').get(attempt.id);
      if (!r || !t || !a) return false;
      const s = t.steps.find((s) => s.id === step.id)!;
      if (r.status !== 'running' || r.epoch !== run.epoch) {
        a.status = 'failed';
        a.reason = '取消发生在提交前，未发送';
        if (r.forumTabId !== undefined) await releaseSlot(tx, a.accountId, a.id);
        s.status = r.status === 'stopped' ? 'stopped' : 'paused';
        t.status = s.status;
        await tx.objectStore('attempts').put(a);
        await tx.objectStore('tasks').put(t);
        return false;
      }
      r.sendCount++;
      r.nextSendAt = this.now() + r.config.sendSeconds * 1000;
      r.lastActivity = this.now();
      a.submittedAt = this.now();
      a.status = 'submitted';
      s.status = 'verifying';
      t.status = 'verifying';
      await tx.objectStore('runs').put(r);
      await tx.objectStore('attempts').put(a);
      await tx.objectStore('tasks').put(t);
      return true;
    });
    if (!finalPermit) return;
    if (cancellationVersion !== this.cancellationVersion[run.mode]) {
      await this.repo.atomic(async (tx) => {
        const r = await tx.objectStore('runs').get(run.id);
        const t = await tx.objectStore('tasks').get(task.id);
        const a = await tx.objectStore('attempts').get(attempt.id);
        if (!r || !t || !a) throw Error('取消时发送记录不完整');
        a.status = 'failed';
        a.reason = '发送许可后收到停止信号，实际提交前取消；保守保留占用额度';
        if (r.forumTabId !== undefined) await releaseSlot(tx, a.accountId, a.id);
        const s = t.steps.find((s) => s.id === step.id)!;
        s.status = r.status === 'stopped' ? 'stopped' : 'paused';
        s.reason = a.reason;
        t.status = s.status;
        await tx.objectStore('attempts').put(a);
        await tx.objectStore('tasks').put(t);
      });
      return;
    }
    attempt.status = 'submitted';
    attempt.submittedAt = this.now();
    try {
      await adapter.submit(attempt, run);
    } catch (e) {
      adapter.cancel();
      await this.settle(attempt, { kind: 'unknown', reason: errorText(e) });
      // A response may be lost even after the platform accepted the click. Read only;
      // never submit again, and keep the batch paused even when evidence is recovered.
      if (run.mode === 'real') {
        try {
          const verified = await adapter.verifySubmission(attempt);
          if (verified.kind === 'success') await this.settle(attempt, verified);
        } catch {
          /* Preserve the original submission failure and its unknown record. */
        }
      }
      return;
    }
    let result: Verification;
    try {
      result = await adapter.verifySubmission(attempt);
    } catch (e) {
      result = { kind: 'unknown', reason: errorText(e) };
    }
    await this.settle(attempt, result);
  }
  private async preparationFailed(
    run: Run,
    task: Task,
    step: Step,
    reason: string,
    retryable = false,
  ) {
    const deferred = await this.repo.atomic(async (tx) => {
      const r = await tx.objectStore('runs').get(run.id);
      const t = await tx.objectStore('tasks').get(task.id);
      if (!r || !t) return;
      const s = t.steps.find((s) => s.id === step.id)!;
      if (s.status !== 'running') return false;
      if (r.status !== 'running' || r.epoch !== run.epoch) {
        s.status =
          r.status === 'running' ? 'queued' : r.status === 'completed' ? 'stopped' : r.status;
        t.status = s.status === 'queued' ? 'waiting' : s.status;
        await tx.objectStore('tasks').put(t);
        return false;
      }
      // Preparation can open an editor but cannot enter text, create an intent or submit.
      // Retrying page preparation is never permission to retry a submission.
      if (retryable && run.mode === 'real' && !s.attemptId && (s.preparationRetries ?? 0) < 2) {
        s.preparationRetries = (s.preparationRetries ?? 0) + 1;
        s.status = 'waiting';
        s.reason = `${reason}。稍后自动重新准备（${s.preparationRetries}/2），尚未发送`;
        t.status = 'waiting';
        t.reason = s.reason;
        t.updatedAt = this.now();
        r.nextSendAt = this.now() + 30000 * s.preparationRetries;
        r.lastActivity = this.now();
        await tx.objectStore('tasks').put(t);
        await tx.objectStore('runs').put(r);
        return s.preparationRetries;
      }
      s.status = 'blocked';
      s.reason = reason;
      t.status = s.status;
      t.reason = reason;
      r.status = 'blocked';
      r.reason = reason;
      r.epoch++;
      await tx.objectStore('tasks').put(t);
      await tx.objectStore('runs').put(r);
    });
    if (deferred)
      await this.repo.log(
        run.mode,
        'prepare.retry',
        `${stageNames[step.stage]}准备延期（${deferred}/2）：${reason}`,
        'warn',
        task.id,
        run.id,
      );
  }
  async settle(attempt: Attempt, result: Verification) {
    if (result.kind === 'success' && !validEvidence(attempt, result.evidence))
      result = { kind: 'unknown', reason: '证据不满足新评论、账号、文本、时间和回复关系校验' };
    const finalResult = result;
    await this.repo.atomic(async (tx) => {
      const a = await tx.objectStore('attempts').get(attempt.id);
      const t = await tx.objectStore('tasks').get(attempt.taskId);
      const r = await tx.objectStore('runs').get(attempt.runId);
      if (!a || !t || !r) throw Error('发送记录不完整，禁止推进游标');
      if (r.forumTabId !== undefined) await releaseSlot(tx, a.accountId, a.id);
      const s = t.steps.find((s) => s.id === a.stepId)!;
      if (a.status === 'verified' || s.committed) return;
      if (s.attemptId !== a.id) throw Error('旧发送尝试的证据晚于人工重试，不能提交当前步骤游标');
      if (a.status === 'failed' && finalResult.kind === 'failed') return;
      const wasUnknown = a.status === 'unknown';
      if (finalResult.kind === 'success') {
        const c = await tx.objectStore('cursors').get(s.cursorKey!);
        if ((c?.position ?? 0) !== s.cursor) throw Error('游标冲突，保留发送记录等待人工核实');
        a.status = 'verified';
        a.evidence = finalResult.evidence;
        a.reason = undefined;
        s.status = 'completed';
        s.committed = true;
        s.evidence = finalResult.evidence;
        s.endedAt = this.now();
        s.reason = undefined;
        await tx.objectStore('cursors').put({ id: s.cursorKey!, position: s.cursor! + 1 });
        if (s.stage === 'root') {
          r.rootSuccess++;
          t.root = {
            threadId: t.thread.id,
            rootId: finalResult.evidence.commentId,
            pageUrl: finalResult.evidence.pageUrl,
            commentId: finalResult.evidence.commentId,
            authorId: a.accountId,
            relation: 'self-root',
          };
        } else r.replySuccess++;
        if (wasUnknown) r.unknownCount = Math.max(0, r.unknownCount - 1);
        t.status = t.steps.every((s) => ['completed', 'disabled'].includes(s.status))
          ? 'completed'
          : r.status === 'stopped'
            ? 'stopped'
            : r.status === 'running'
              ? 'waiting'
              : 'paused';
        t.reason = undefined;
        t.plannedAt = this.now() + r.config.sendSeconds * 1000;
      } else {
        a.status = finalResult.kind === 'failed' ? 'failed' : 'unknown';
        a.reason = finalResult.reason;
        s.status = a.status;
        s.reason = finalResult.reason;
        t.status = s.status;
        t.reason = finalResult.reason;
        if (a.status === 'unknown' && !wasUnknown) r.unknownCount++;
        if (a.status === 'failed') {
          r.failedCount++;
          if (wasUnknown) r.unknownCount = Math.max(0, r.unknownCount - 1);
        }
        if (r.status !== 'stopped') r.status = 'paused';
        r.reason = finalResult.reason;
        r.epoch++;
      }
      r.lastActivity = this.now();
      r.nextSendAt = this.now() + r.config.sendSeconds * 1000;
      t.updatedAt = this.now();
      await tx.objectStore('attempts').put(a);
      await tx.objectStore('tasks').put(t);
      await tx.objectStore('runs').put(r);
      await tx.objectStore('logs').add({
        id: uid(),
        mode: r.mode,
        runId: r.id,
        taskId: t.id,
        at: this.now(),
        level: finalResult.kind === 'success' ? 'info' : 'warn',
        event: `send.${a.status}`,
        message:
          finalResult.kind === 'success'
            ? `${stageNames[s.stage]} 已核实；游标提交一次${finalResult.evidence.source === 'manual' ? '（用户确认）' : ''}`
            : finalResult.reason,
      });
      await this.repo.trimLogs(tx);
    });
  }
  private async finishRun(id: string, reason: string) {
    await this.repo.atomic(async (tx) => {
      const r = await tx.objectStore('runs').get(id);
      if (!r) return;
      r.status = 'completed';
      r.reason = reason;
      r.epoch++;
      for (const t of await tx.objectStore('tasks').index('runId').getAll(id)) {
        if (!terminal.has(t.status)) {
          t.status = 'stopped';
          for (const s of t.steps)
            if (['queued', 'waiting'].includes(s.status)) s.status = 'stopped';
          await tx.objectStore('tasks').put(t);
        }
      }
      await tx.objectStore('runs').put(r);
    });
  }
  async verify(taskId: string) {
    const t = await this.repo.db.get('tasks', taskId);
    if (!t) throw Error('任务不存在');
    const s = t.steps.find((s) => s.status === 'unknown');
    if (!s?.attemptId) throw Error('没有需要核实的步骤');
    const a = (await this.repo.db.get('attempts', s.attemptId))!;
    let result: Verification;
    try {
      result = await this.adapters[t.mode].verifySubmission(a);
    } catch (e) {
      result = { kind: 'unknown', reason: errorText(e) };
    }
    await this.settle(a, result);
  }
  async confirmPublished(taskId: string, commentId: string, note: string) {
    const t = await this.repo.db.get('tasks', taskId);
    const s = t?.steps.find((s) => s.status === 'unknown');
    if (!t || !s?.attemptId) throw Error('没有未知步骤');
    if (!commentId.trim() || !note.trim()) throw Error('请填写评论标识及确认依据');
    const a = (await this.repo.db.get('attempts', s.attemptId))!;
    const evidence: Evidence = {
      commentId,
      authorId: a.accountId,
      threadId: a.target.threadId,
      rootId: a.stage === 'root' ? commentId : a.target.rootId,
      targetId: a.stage === 'root' ? null : a.target.commentId,
      text: a.text,
      createdAt: a.submittedAt ?? a.intendedAt,
      observedAt: this.now(),
      source: 'manual',
      note,
    };
    await this.settle(a, { kind: 'success', evidence });
  }
  async retry(taskId: string, acknowledged: boolean) {
    if (!acknowledged) throw Error('重试可能重复发布，必须明确确认');
    await this.repo.atomic(async (tx) => {
      const t = await tx.objectStore('tasks').get(taskId);
      if (!t) throw Error('任务不存在');
      const r = await tx.objectStore('runs').get(t.runId);
      if (!r || !['paused', 'blocked'].includes(r.status))
        throw Error('只能在暂停的当前运行中明确重试');
      const s = t.steps.find((s) => ['unknown', 'failed'].includes(s.status));
      if (!s?.attemptId) throw Error('没有可重试的步骤');
      if (s.status === 'unknown') r.unknownCount = Math.max(0, r.unknownCount - 1);
      const a = await tx.objectStore('attempts').get(s.attemptId);
      if (a) {
        a.reason = `${a.reason ?? ''}；用户明确决定承担重复风险并重新尝试`;
        await tx.objectStore('attempts').put(a);
      }
      s.status = 'queued';
      s.attemptId = undefined;
      s.reason = undefined;
      t.status = 'paused';
      t.reason = undefined;
      await tx.objectStore('tasks').put(t);
      await tx.objectStore('runs').put(r);
    });
  }
  async skip(mode: Mode, threadKey: string) {
    await this.repo.atomic(async (tx) => {
      const th = await tx.objectStore('threads').get(threadKey);
      if (!th || th.mode !== mode) throw Error('帖子不存在');
      if (th.taskId) {
        const t = await tx.objectStore('tasks').get(th.taskId);
        if (t) {
          if (t.steps.some((s) => ['running', 'verifying', 'unknown'].includes(s.status)))
            throw Error('发送结果未明，不能跳过证据');
          t.status = 'skipped';
          for (const s of t.steps)
            if (['queued', 'waiting', 'paused', 'blocked', 'failed'].includes(s.status))
              s.status = 'skipped';
          await tx.objectStore('tasks').put(t);
        }
      }
      th.skipped = true;
      th.decision = '用户手动跳过';
      await tx.objectStore('threads').put(th);
      await tx.objectStore('dedupe').put({
        id: `${mode}:${(await this.currentTx(tx, mode))?.account.id}:${th.id}`,
        taskId: th.taskId ?? 'skipped',
      });
    });
  }
  async scenario(value: Run['scenario']) {
    await this.repo.atomic(async (tx) => {
      const r = await this.currentTx(tx, 'demo');
      if (!r) throw Error('请先启动演示');
      r.scenario = value;
      await tx.objectStore('runs').put(r);
    });
  }
}
