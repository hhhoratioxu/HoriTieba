import type { Target, Prepared } from '../../domain/models';
import { legacyThread, rootElement, field, plainText } from './legacy';
import { hasDraft, hasEditableContent, hasEditorMedia, detectBlockingState } from './read-page';
import { sameTarget } from '../../domain/policies';
import { PageNotReadyError } from '../platform';

export type PageWait = { signal: AbortSignal; deadline: number };

export function visible(el: HTMLElement) {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}
export function control(root: ParentNode, selector: string): HTMLElement | undefined {
  const items = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(visible);
  if (items.length > 1) throw Error('页面控件不唯一，无法安全确定目标');
  return items[0];
}
export function checkWait(wait: PageWait, phase: string) {
  if (wait.signal.aborted) throw Error('准备已取消');
  if (Date.now() >= wait.deadline) throw new PageNotReadyError(`${phase}未在期限内就绪`);
}
// The site inserts the panel, its parent ID and the editor in separate DOM updates.
// A short-lived observer wakes on those updates, even when page timers run infrequently.
export async function whenReady<T>(
  scope: Node,
  wait: PageWait,
  phase: string,
  read: () => T | undefined,
): Promise<T> {
  const inspect = () => {
    checkWait(wait, phase);
    if (!scope.isConnected) throw new PageNotReadyError(`${phase}所在的页面节点已更换`);
    return read();
  };
  const initial = inspect();
  if (initial !== undefined) return initial;
  return new Promise<T>((resolve, reject) => {
    const observer = new MutationObserver(probe);
    const timer = setTimeout(() => {
      cleanup();
      reject(new PageNotReadyError(`${phase}未在期限内就绪`));
    }, wait.deadline - Date.now());
    function cleanup() {
      observer.disconnect();
      clearTimeout(timer);
      wait.signal.removeEventListener('abort', probe);
    }
    function probe() {
      try {
        const value = inspect();
        if (value === undefined) return;
        cleanup();
        resolve(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    }
    observer.observe(scope, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'data-field',
        'contenteditable',
        'disabled',
        'aria-disabled',
      ],
    });
    wait.signal.addEventListener('abort', probe, { once: true });
    probe();
  });
}
export async function openReplyPanel(doc: Document, rootId: string, wait: PageWait) {
  const root = rootElement(doc, rootId);
  root.scrollIntoView?.({ block: 'center', behavior: 'instant' });
  const panel = () => root.querySelector<HTMLElement>('.j_lzl_container');
  const opened = (el: HTMLElement | null) => el && visible(el) && !el.classList.contains('hideLzl');
  const action = await whenReady(root, wait, '楼层回复入口', () => {
    if (detectBlockingState(doc)) throw Error('贴吧要求安全验证，请人工处理');
    const el = panel();
    if (el?.querySelector('.loading_reply')) return undefined;
    if (opened(el)) return null;
    return control(root, '.core_reply_tail .lzl_link_unfold, .core_reply_tail a.p_reply');
  });
  checkWait(wait, '楼层回复入口');
  action?.click();
  return whenReady(root, wait, '楼中楼父编号', () => {
    if (detectBlockingState(doc)) throw Error('贴吧要求安全验证，请人工处理');
    const el = panel();
    if (!el || !opened(el) || el.querySelector('.loading_reply')) return undefined;
    const pid = field(el)?.pid;
    if (pid == null) return undefined;
    if (String(pid) !== rootId) throw Error('楼中楼父评论编号与目标楼层不一致');
    return el;
  });
}

export function writeReplyText(editor: HTMLElement, text: string, append = false) {
  const doc = editor.ownerDocument;
  const input = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  });
  if (!editor.dispatchEvent(input)) throw Error('平台编辑器拒绝输入');
  const nodes: Node[] = [];
  text.split('\n').forEach((line, i) => {
    if (i) nodes.push(doc.createElement('br'));
    nodes.push(doc.createTextNode(line));
  });
  if (append) editor.append(...nodes);
  else editor.replaceChildren(...nodes);
  editor.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
  );
}

export class PageDriver {
  private generation = 0;
  private operation?: { id: string; controller: AbortController };
  private submission?: { attemptId: string; phase: string; at: number };
  submissionState(attemptId: string) {
    return this.submission?.attemptId === attemptId ? this.submission : { phase: 'unobserved' };
  }
  private ready?: {
    target: Target;
    token: string;
    beforeIds: string[];
    editor: HTMLElement;
    button: HTMLElement;
    generation: number;
    used: boolean;
    forum: string;
  };
  constructor(
    private doc: Document,
    private url: () => string,
    private permit: (attemptId: string, token: string) => Promise<boolean>,
  ) {}
  cancel(operationId?: string) {
    if (operationId && operationId !== this.operation?.id) return;
    this.operation?.controller.abort();
    this.operation = undefined;
    this.generation++;
    this.ready = undefined;
  }
  private validate(target: Target, forum?: string) {
    const page = legacyThread(this.doc, this.url());
    if (page.blocking) throw Error(page.blocking);
    if (
      page.threadId !== target.threadId ||
      !page.account.confirmed ||
      page.account.id !== target.authorId ||
      (forum && page.forum !== forum)
    )
      throw Error('账号、主题或所属贴吧发生变化');
    if (target.relation === 'root') {
      if (target.rootId || target.commentId) throw Error('首评目标包含楼中楼编号');
    } else {
      if (!target.rootId || target.commentId !== target.rootId) throw Error('只能回复自己的首评');
      const root = page.comments.find(
        (c) =>
          c.id === target.rootId &&
          c.id === c.rootId &&
          c.authorId === target.authorId &&
          (c.floor ?? 0) > 1,
      );
      if (!root) throw Error('未找到属于当前账号的首评，不能回复其他楼层');
    }
    return page;
  }
  private startWait(id: string, expiresAt: number): PageWait {
    if (Date.now() >= expiresAt) throw new PageNotReadyError('准备请求在到达页面前已过期');
    this.cancel();
    const controller = new AbortController();
    this.operation = { id, controller };
    return { signal: controller.signal, deadline: Math.min(expiresAt, Date.now() + 15000) };
  }
  async expand(
    rootId: string,
    operationId: string = crypto.randomUUID(),
    expiresAt = Date.now() + 12000,
  ) {
    return openReplyPanel(this.doc, rootId, this.startWait(operationId, expiresAt));
  }
  async prepare(
    target: Target,
    forum: string,
    operationId: string = crypto.randomUUID(),
    expiresAt = Date.now() + 15000,
  ): Promise<Prepared & { token: string }> {
    const wait = this.startWait(operationId, expiresAt);
    const generation = this.generation;
    this.validate(target, forum);
    if (hasDraft(this.doc)) throw Error('工作页面存在草稿，请先人工处理');
    const nested = target.relation === 'self-root';
    const root = nested ? await openReplyPanel(this.doc, target.rootId, wait) : this.doc;
    const editorSelector = nested
      ? '.j_lzl_e_c [contenteditable="true"]'
      : '#tb_rich_poster #ueditor_replace[contenteditable="true"]';
    const buttonSelector = nested ? '.j_lzl_e_c .j_lzl_p_sb' : '#tb_rich_poster .j_submit';
    if (nested) {
      const action = await whenReady(root, wait, '楼中楼输入入口', () => {
        if (control(root, editorSelector)) return null;
        return control(root, '.j_lzl_p');
      });
      checkWait(wait, '楼中楼输入入口');
      action?.click();
    }
    const { editor, button } = await whenReady(
      root,
      wait,
      nested ? '楼中楼编辑器和发表按钮' : '一级评论编辑器和发表按钮',
      () => {
        if (detectBlockingState(this.doc)) throw Error('贴吧要求安全验证，请人工处理');
        const editor = control(root, editorSelector),
          button = control(root, buttonSelector);
        return editor && button ? { editor, button } : undefined;
      },
    );
    checkWait(wait, '发送准备');
    const page = this.validate(target, forum);
    if (page.invalidComments) throw Error('评论编号、作者或时间有缺失，无法建立可靠的发送前快照');
    if (target.relation === 'self-root') {
      const expected = Number(field(root as Element)?.total_num);
      const loaded = page.comments.filter(
        (c) => c.rootId === target.rootId && c.id !== c.rootId,
      ).length;
      if (!Number.isSafeInteger(expected) || expected !== loaded)
        throw Error('楼中楼尚未完整加载；禁止按不完整快照发送');
    } else if (page.lastPage && page.lastPage !== page.pageUrl)
      throw Error('首评前需要读取当前尾页快照');
    if (hasDraft(this.doc) || generation !== this.generation)
      throw Error('草稿或运行状态在准备期间变化');
    const token = crypto.randomUUID(),
      beforeIds = page.comments.map((c) => c.id);
    this.ready = { target, token, beforeIds, editor, button, generation, used: false, forum };
    return { target, account: page.account, beforeIds, token };
  }
  async submit(attemptId: string, token: string, target: Target, text: string) {
    const mark = (phase: string) => {
      this.submission = { attemptId, phase, at: Date.now() };
    };
    const ready = this.ready;
    if (!ready || ready.used || token !== ready.token || !sameTarget(target, ready.target))
      throw Error('发送准备已失效或已使用');
    ready.used = true;
    mark('validating');
    const check = () => {
      if (
        ready.generation !== this.generation ||
        !ready.editor.isConnected ||
        !ready.button.isConnected
      )
        throw Error('发送已取消或页面发生变化');
      const page = this.validate(target, ready.forum);
      const current = page.comments.map((c) => c.id);
      if (
        page.invalidComments ||
        current.length !== ready.beforeIds.length ||
        current.some((id) => !ready.beforeIds.includes(id))
      )
        throw Error('发送前评论集合发生变化，请重新准备');
    };
    check();
    if (hasDraft(this.doc)) throw Error('工作页面存在草稿，拒绝覆盖');
    mark('input');
    ready.editor.focus();
    // Native DOM nodes keep line breaks stable and never interpret library text as HTML.
    // execCommand(insertText) creates browser-dependent P/DIV structures and can double breaks.
    writeReplyText(ready.editor, text);
    if (plainText(ready.editor) !== text) throw Error('编辑器未接受完整原文；保留草稿供人工检查');
    mark('awaiting-permit');
    const deadline = Date.now() + 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let allowed: boolean;
    try {
      allowed = await Promise.race([
        this.permit(attemptId, token),
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(() => reject(Error('发送许可响应超时，未点击；草稿已保留')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!allowed) throw Error('后台撤销发送许可，草稿已保留');
    if (Date.now() >= deadline) throw Error('发送许可已过期，未点击；草稿已保留');
    mark('permit-received');
    check();
    const drafts = Array.from(
      this.doc.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"]'),
    ).filter(hasEditableContent);
    if (
      plainText(ready.editor) !== text ||
      hasEditorMedia(ready.editor) ||
      drafts.some((e) => e !== ready.editor) ||
      !visible(ready.button) ||
      ready.button.matches('[disabled],[aria-disabled="true"],.disabled')
    )
      throw Error('编辑器内容或按钮状态变化，取消发送');
    if (
      target.relation === 'self-root' &&
      ready.editor.closest('.l_post') !== rootElement(this.doc, target.rootId)
    )
      throw Error('编辑器移到了其他楼层');
    if (target.relation === 'root' && ready.editor.closest('.l_post'))
      throw Error('首评编辑器层级错误');
    mark('clicking');
    ready.button.click(); // One normal DOM click; never retry after this point.
    mark('clicked');
    return { clicked: true };
  }
}
