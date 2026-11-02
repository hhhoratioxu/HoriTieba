import { forumFromUrl } from '../shared/forum-comments';
import { consumeSlot } from './send-slot';
import { forumUrl, normalizeForum, scanSchema } from '../shared/validation';
import { uid, type Scan, type Target, type Run, type Step, type Attempt } from '../domain/models';
import {
  observationSchema,
  preparedSchema,
  pageRequestSchema,
  documentTokenSchema,
} from '../shared/page-messages';
import { safePageUrl } from '../adapters/tieba/legacy';
import type { Repository } from '../storage/database';
import { sameTarget } from '../domain/policies';
import { PageNotReadyError, ThreadUnavailableError, BlockedError } from '../adapters/platform';
function pageDocumentToken(value: unknown) {
  const parsed = documentTokenSchema.safeParse(value);
  if (!parsed.success)
    throw Error('工作页仍使用旧版扩展脚本；请先保留草稿，再刷新该工作页，然后只读核实');
  return parsed.data;
}
const readStages: Record<string, string> = {
  HORITIEBA_READ: '读取贴吧列表',
  HORITIEBA_INSPECT: '读取主题与账号',
  HORITIEBA_PAGE_CONTEXT: '确认工作页与草稿',
  HORITIEBA_PREPARE: '准备用于发表的编辑器',
  HORITIEBA_EXPAND: '展开楼层核实评论',
};
export class WorkTabs {
  private generation = 0;
  private preparing?: { tabId: number; operationId: string };
  private ticket?: {
    token: string;
    operationId: string;
    tabId: number;
    runId: string;
    stepId: string;
    epoch: number;
    target: Target;
    used: boolean;
  };
  private async send(
    id: number,
    body: Record<string, unknown>,
    timeout = 8000,
    requestId = uid(),
  ): Promise<any> {
    const request = pageRequestSchema.parse({ ...body, requestId, context: 'background' });
    const stage = readStages[request.type];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(id, request, { frameId: 0 }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                stage
                  ? new PageNotReadyError(`${stage}时工作页面响应超时`)
                  : Error('工作页面响应超时'),
              ),
            timeout,
          );
        }),
      ]);
      if (response?.requestId !== requestId) throw Error('工作页面响应标识不一致');
      if (!response.ok) {
        if (response.code === 'thread-unavailable')
          throw new ThreadUnavailableError(response.error);
        if (response.code === 'page-blocked') throw new BlockedError(response.error);
        if (stage && response.code === 'page-not-ready')
          throw new PageNotReadyError(response.error);
        throw Error(response.error ?? '工作页面响应无效');
      }
      return response.data;
    } catch (error) {
      if (
        stage &&
        error instanceof Error &&
        /Receiving end does not exist|message port closed|message channel closed/i.test(
          error.message,
        )
      )
        throw new PageNotReadyError(`${stage}时页面接收端尚未就绪`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private async legacy(id: number) {
    // A response can be lost when the official switch navigates. Do not click a second time.
    try {
      return await this.send(id, { type: 'HORITIEBA_LEGACY' });
    } catch (e) {
      if (e instanceof Error && /草稿|未找到/.test(e.message)) throw e;
    }
  }
  private async read(id: number): Promise<{ draft: boolean; scan: Scan; documentToken: string }> {
    const response = await this.send(id, { type: 'HORITIEBA_READ' });
    if (typeof response?.draft !== 'boolean') throw Error('页面响应格式无效');
    return {
      draft: response.draft,
      scan: scanSchema.parse(response.scan),
      documentToken: pageDocumentToken(response.documentToken),
    };
  }
  async forumPage(tabId: number, forum: string) {
    if (forumFromUrl((await chrome.tabs.get(tabId)).url) !== forum) throw Error('已离开目标贴吧。');
    const result = await this.read(tabId);
    if (result.scan.forum !== forum) throw Error('当前页面的贴吧与目标不一致。');
    return result;
  }
  async scan(forum: string, useLegacy = false, refresh = true, ownerTab?: number) {
    let id =
      ownerTab ?? ((await chrome.storage.local.get('monitorTab')).monitorTab as number | undefined);
    let created = false;
    let previousDocument: string | undefined;
    if (id !== undefined) {
      let tab;
      try {
        tab = await chrome.tabs.get(id);
      } catch {
        if (ownerTab === undefined) await chrome.storage.local.remove('monitorTab');
        throw Error('监控标签页已关闭；继续后会创建一个新监控标签页');
      }
      if (!tab.url || !tab.url.startsWith('https://tieba.baidu.com/f'))
        throw Error('监控标签页已导航到其他页面，请关闭该工作标签页后继续');
      if (normalizeForum(tab.url) !== forum)
        throw Error('监控标签页的贴吧已改变，请关闭该工作标签页后继续');
      const before = await this.read(id);
      if (before.draft) throw new BlockedError('监控标签页存在草稿，已停止刷新以保护输入');
      if (before.scan.blocking?.includes('安全验证')) return before.scan;
      const params = new URL(tab.url).searchParams;
      const filtered =
        ownerTab !== undefined &&
        (Number(params.get('pn') || 0) !== 0 ||
          ['tab', 'cid', 'good', 'see_lz'].some((k) => params.has(k)));
      if (refresh || filtered) {
        previousDocument = before.documentToken;
        if (filtered) await chrome.tabs.update(id, { url: forumUrl(forum) });
        else await chrome.tabs.reload(id);
      }
    } else {
      const tab = await chrome.tabs.create({ url: forumUrl(forum), active: false });
      if (tab.id === undefined) throw Error('无法创建监控标签页');
      id = tab.id;
      created = true;
      await chrome.storage.local.set({ monitorTab: id });
    }
    let last: unknown;
    let switched = false;
    for (let n = 0; n < 6; n++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const value = await this.read(id);
        if (value.documentToken === previousDocument) {
          last = Error('列表刷新尚未完成，仍是旧页面');
          continue;
        }
        if (
          useLegacy &&
          !value.scan.reliable &&
          !value.scan.blocking?.includes('安全验证') &&
          !switched
        ) {
          switched = true;
          const change = await this.legacy(id);
          if (change?.legacy !== true) previousDocument = value.documentToken;
          continue;
        }
        if (useLegacy && !value.scan.account.confirmed && !value.scan.blocking && n < 5) {
          last = Error('账号标识仍在加载');
          continue;
        }
        if (value.scan.candidates.length || value.scan.blocking?.includes('安全验证'))
          return value.scan;
        last = Error(value.scan.blocking);
      } catch (e) {
        last = e;
      }
    }
    throw Error(
      `工作页面未就绪${created ? '（已创建一个监控标签页）' : ''}：${last instanceof Error ? last.message : '读取失败'}`,
    );
  }
  private async inspect(
    id: number,
    timeout = 8000,
    expectedThread?: string,
    previousDocument?: string,
  ) {
    const response = await this.send(
      id,
      { type: 'HORITIEBA_INSPECT', expectedThread, previousDocument },
      timeout,
    );
    if (typeof response?.draft !== 'boolean') throw Error('工作页草稿状态缺失');
    return {
      draft: response.draft as boolean,
      page: observationSchema.parse(response.page),
      documentToken: pageDocumentToken(response.documentToken),
    };
  }
  private async waitThread(id: number, previousDocument?: string, expectedThread?: string) {
    let last: unknown;
    let switched = false;
    // document_idle can arrive well after the visible thread body on the live site.
    // Budget the complete wait, rather than mistaking a four-second load for failure.
    const deadline = Date.now() + 20000;
    for (let n = 0; n < 40 && Date.now() < deadline; n++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const value = await this.inspect(
          id,
          Math.min(8000, remaining),
          expectedThread,
          previousDocument,
        );
        if (value.documentToken === previousDocument) {
          last = Error('主题页导航尚未完成，仍是旧页面');
          continue;
        }
        if (!value.page.account.confirmed) {
          last = Error('账号标识仍在加载');
          continue;
        }
        return { id, ...value };
      } catch (e) {
        last = e;
        if (
          e instanceof ThreadUnavailableError ||
          e instanceof BlockedError ||
          (e instanceof Error && /No tab with id|Invalid tab ID/i.test(e.message))
        )
          throw e;
        if (!switched && e instanceof Error && /主题旧版页面未就绪/.test(e.message)) {
          await this.legacy(id);
          switched = true;
        }
      }
    }
    const reason = last instanceof Error ? last.message : '读取失败';
    const transient =
      last instanceof PageNotReadyError ||
      /Receiving end does not exist|message port closed|旧页面|账号标识仍在加载|主题旧版页面未就绪|工作页面响应超时/.test(
        reason,
      );
    throw transient
      ? new PageNotReadyError(`主题页未就绪：${reason}`)
      : Error(`主题页未就绪：${reason}`);
  }
  private async refreshThread(id: number) {
    const current = await this.inspect(id);
    if (current.draft) throw Error('执行标签页有草稿，禁止刷新；请人工核实');
    await chrome.tabs.reload(id);
    return this.waitThread(id, current.documentToken);
  }
  async thread(url: string, recoverClosed = false): ReturnType<WorkTabs['waitThread']> {
    const tid = new URL(url).pathname.split('/').pop()!;
    const safe = safePageUrl(url, tid);
    if (!safe) throw Error('执行页主题链接无效');
    const { executionTab } = await chrome.storage.local.get('executionTab');
    let id = typeof executionTab === 'number' ? executionTab : undefined;
    let previousDocument: string | undefined;
    try {
      if (id !== undefined) {
        const tab = await chrome.tabs.get(id).catch(() => null);
        if (!tab) {
          await chrome.storage.local.remove('executionTab');
          if (!recoverClosed) throw new PageNotReadyError('执行标签页已关闭');
          id = undefined;
        } else if (!tab.url || !safePageUrl(tab.url, new URL(tab.url).pathname.split('/').pop()!)) {
          throw new BlockedError('执行标签页已离开主题页，请先核对是否需要登录或验证');
        } else if (safePageUrl(tab.url, tid) !== safe) {
          const context = await this.send(id, { type: 'HORITIEBA_PAGE_CONTEXT' });
          if (typeof context?.draft !== 'boolean') throw Error('缺少草稿状态，禁止导航');
          if (context.draft || context.blocking)
            throw new BlockedError(context.blocking || '执行标签页有草稿，禁止导航或刷新');
          previousDocument = pageDocumentToken(context.documentToken);
          await chrome.tabs.update(id, { url: safe });
        }
      }
      if (id === undefined) {
        const tab = await chrome.tabs.create({ url: safe, active: false });
        if (tab.id === undefined) throw Error('无法创建执行标签页');
        id = tab.id;
        await chrome.storage.local.set({ executionTab: id });
      }
      return await this.waitThread(id, previousDocument, tid);
    } catch (error) {
      // Repair a closure during navigation/wait once, and only before a send intent exists.
      if (
        recoverClosed &&
        id !== undefined &&
        !(error instanceof BlockedError) &&
        !(await chrome.tabs.get(id).catch(() => null))
      ) {
        if ((await chrome.storage.local.get('executionTab')).executionTab === id)
          await chrome.storage.local.remove('executionTab');
        return this.thread(safe, false);
      }
      throw error;
    }
  }
  async prepare(target: Target, run: Run, step: Step) {
    const generation = this.generation;
    const ensureCurrent = () => {
      if (generation !== this.generation) throw Error('准备已取消');
    };
    this.ticket = undefined;
    let view = await this.thread(
      target.pageUrl ?? `https://tieba.baidu.com/p/${target.threadId}`,
      run.forumTabId !== undefined,
    );
    if (target.relation === 'root' && view.page.lastPage)
      view = await this.thread(view.page.lastPage, run.forumTabId !== undefined);
    ensureCurrent();
    if (view.draft) throw Error('执行标签页存在草稿，禁止覆盖');
    if (target.relation === 'self-root' && step.preparationRetries) {
      // Tieba may render the reply editor only when the owned tab is displayed.
      await this.showForRendering(view.id, target.threadId);
      ensureCurrent();
    }
    // Freshly posted legacy rows may lack initialized reply handlers. Reload only an empty
    // owned tab before preparing a self-reply, and bind again to persisted server DOM.
    if (target.relation === 'self-root' || !view.page.rootEditorReady)
      view = await this.refreshThread(view.id);
    ensureCurrent();
    const operationId = uid();
    this.preparing = { tabId: view.id, operationId };
    try {
      const result = preparedSchema.parse(
        await this.send(
          view.id,
          {
            type: 'HORITIEBA_PREPARE',
            forum: run.config.forum,
            target,
            documentToken: view.documentToken,
            expiresAt: Date.now() + 15000,
          },
          18000,
          operationId,
        ),
      );
      ensureCurrent();
      this.ticket = {
        token: result.token,
        operationId,
        tabId: view.id,
        runId: run.id,
        stepId: step.id,
        epoch: run.epoch,
        target,
        used: false,
      };
      return result;
    } catch (error) {
      this.cancelOperation(view.id, operationId);
      throw error;
    } finally {
      if (this.preparing?.operationId === operationId) this.preparing = undefined;
    }
  }
  private async showForRendering(id: number, threadId: string) {
    const tab = await chrome.tabs.get(id);
    if (!tab.url || !safePageUrl(tab.url, threadId)) throw Error('执行页已离开指定主题');
    if (!tab.active) await chrome.tabs.update(id, { active: true });
  }
  private cancelOperation(tabId: number, operationId: string) {
    void this.send(tabId, { type: 'HORITIEBA_CANCEL', operationId }, 2000).catch(() => {});
  }
  async submit(a: Attempt) {
    const t = this.ticket;
    if (!t || t.stepId !== a.stepId || t.runId !== a.runId)
      throw Error('发送准备已丢失，请先核实记录');
    try {
      return await this.send(t.tabId, {
        type: 'HORITIEBA_SUBMIT',
        attemptId: a.id,
        token: t.token,
        target: t.target,
        text: a.text,
      });
    } catch (error) {
      const state = await this.send(
        t.tabId,
        {
          type: 'HORITIEBA_SUBMIT_STATE',
          attemptId: a.id,
        },
        2000,
      ).catch(() => undefined);
      const labels: Record<string, string> = {
        validating: '发送前校验',
        input: '编辑器输入',
        'awaiting-permit': '等待发送许可',
        'permit-received': '许可后的最终校验',
        clicking: '调用页面发表按钮',
        clicked: '点击后等待核实',
      };
      const detail = labels[state?.phase];
      throw Error(
        `${error instanceof Error ? error.message : '提交响应丢失'}${detail ? `；最后观察到：${detail}` : ''}`,
      );
    }
  }
  async permit(
    repo: Repository,
    sender: chrome.runtime.MessageSender,
    attemptId: string,
    token: string,
  ) {
    const ticket = this.ticket;
    if (
      !ticket ||
      ticket.used ||
      token !== ticket.token ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.tab?.id !== ticket.tabId ||
      !sender.url ||
      safePageUrl(sender.url, ticket.target.threadId) === undefined
    )
      return false;
    ticket.used = true;
    const owner = (await repo.db.get('runs', ticket.runId))?.forumTabId;
    if (owner !== undefined) {
      const tab = await chrome.tabs.get(owner).catch(() => null);
      const run = await repo.db.get('runs', ticket.runId);
      if (!tab || forumFromUrl(tab.url) !== run?.config.forum) return false;
    }
    return repo.atomic(async (tx) => {
      const a = await tx.objectStore('attempts').get(attemptId);
      const r = a ? await tx.objectStore('runs').get(a.runId) : undefined;
      const task = a ? await tx.objectStore('tasks').get(a.taskId) : undefined;
      const step = task?.steps.find((s) => s.id === a?.stepId);
      if (
        !a ||
        a.mode !== 'real' ||
        a.status !== 'submitted' ||
        a.stepId !== ticket.stepId ||
        a.runId !== ticket.runId ||
        !r ||
        r.status !== 'running' ||
        r.epoch !== ticket.epoch ||
        r.config.realAction !== 'auto' ||
        r.account.id !== a.accountId ||
        (r.forumTabId === undefined && r.sendCount > r.config.maxSends) ||
        step?.attemptId !== a.id ||
        step.status !== 'verifying' ||
        step.text !== a.text ||
        !sameTarget(a.target, ticket.target)
      )
        return false;
      if (await tx.objectStore('meta').get(`clicked:${a.id}`)) return false;
      if (r.forumTabId !== undefined && !(await consumeSlot(tx, a.accountId, a.id, Date.now())))
        return false;
      await tx
        .objectStore('meta')
        .put({ id: `clicked:${a.id}`, value: { at: Date.now(), documentId: sender.documentId } });
      return true;
    });
  }
  async observation(a: Attempt, refresh = false) {
    const { executionTab } = await chrome.storage.local.get('executionTab');
    let view;
    if (typeof executionTab === 'number') {
      try {
        await chrome.tabs.get(executionTab);
      } catch {
        await chrome.storage.local.remove('executionTab');
        throw Error('执行标签页已关闭；本次结果未知，请使用“重新核实”恢复只读检查');
      }
      // Inspect without navigation first: submission may have moved to a new last page.
      const current = await this.inspect(executionTab);
      if (current.page.threadId !== a.target.threadId)
        throw Error('执行页已换帖，不能据当前页面核实发送');
      view = { id: executionTab, ...current };
    } else
      view = await this.thread(
        a.target.pageUrl ?? `https://tieba.baidu.com/p/${a.target.threadId}`,
      );
    if (refresh) view = await this.refreshThread(view.id);
    if (a.stage === 'root' && view.page.lastPage && !view.draft)
      view = await this.thread(view.page.lastPage);
    if (a.stage !== 'root') {
      const own = view.page.comments.find(
        (c) => c.id === a.target.rootId && c.authorId === a.accountId,
      );
      if (!own) throw Error('原首评未加载或已删除，无法核实楼中楼');
      const expand = (documentToken: string) =>
        this.send(
          view.id,
          {
            type: 'HORITIEBA_EXPAND',
            rootId: a.target.rootId,
            documentToken,
            expiresAt: Date.now() + 10000,
          },
          13000,
        );
      let response;
      try {
        response = await expand(view.documentToken);
      } catch (error) {
        if (!(error instanceof PageNotReadyError)) throw error;
        // Read-only recovery: display and re-check the same owned floor, never submit.
        await this.showForRendering(view.id, a.target.threadId);
        const fresh = await this.inspect(view.id);
        if (
          fresh.draft ||
          fresh.page.threadId !== a.target.threadId ||
          fresh.page.account.id !== a.accountId ||
          !fresh.page.account.confirmed ||
          !fresh.page.comments.some((c) => c.id === a.target.rootId && c.authorId === a.accountId)
        )
          throw Error('回复核实上下文已变化，已停止展开');
        response = await expand(fresh.documentToken);
      }
      return observationSchema.parse(response.page);
    }
    return view.page;
  }
  cancel() {
    this.generation++;
    const active = this.preparing ?? this.ticket;
    this.preparing = undefined;
    this.ticket = undefined;
    if (active) this.cancelOperation(active.tabId, active.operationId);
  }
  async detectActiveForum() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.url) throw Error('请先切到已打开的贴吧列表页，再从扩展弹窗识别');
    return normalizeForum(tab.url);
  }
  async focus() {
    const { monitorTab, executionTab } = await chrome.storage.local.get([
      'monitorTab',
      'executionTab',
    ]);
    const id = executionTab ?? monitorTab;
    if (typeof id !== 'number') throw Error('尚无工作标签页');
    await chrome.tabs.update(id, { active: true });
  }
}
