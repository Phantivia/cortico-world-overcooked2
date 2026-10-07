/**
 * bot 厨师的任务队列：任务按序执行，每步交给插件做完再回执。一步失败即整个任务受阻，后面的任务
 * 照常继续（下一个任务的第一步会基于新状态重新判断）。
 *
 * 排法：replace 撤掉还没开始的任务，正在做的做完；append 排到最后；now 叫停正在做的并排到最前。
 * 另可按任务号撤掉指定任务。叫停正在做的任务要等插件确认按键已松开、那一步已回复。
 */

export interface StepResult {
  ok: boolean;
  /** 成功时是这一步的结果，失败时是原因；插件写成一句中文。 */
  detail: string;
}

export interface TaskReport {
  id: number;
  kind: 'done' | 'blocked' | 'cancelled';
  text: string;
}

export type QueueMode = 'replace' | 'append' | 'now';

export interface Submitted {
  id: number;
  /** 这次排入顺带撤掉或叫停了什么、正在做的任务怎么处理，每项一句。 */
  notes: string[];
}

export interface Step {
  do: string;
  [key: string]: unknown;
}

interface Task {
  id: number;
  steps: Step[];
  /** 已完成的步数。 */
  done: number;
  results: string[];
  queuedAt: number;
  startedAt?: number;
}

export interface ExecutorDeps {
  run: (step: Step, signal: AbortSignal) => Promise<StepResult>;
  /** 让插件停下当前动作并松开所有按键；resolve 表示插件已确认。 */
  halt: () => Promise<void>;
  describe: (step: Step) => string;
  report: (r: TaskReport) => void;
  now?: () => number;
}

export class Executor {
  private nextId = 1;
  private queue: Task[] = [];
  private running: Task | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: ExecutorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get idle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  /** 排入任务。cancel 里的任务号先撤掉；撤不到的号（已结束）不算错。 */
  async submit(steps: Step[], mode: QueueMode, cancel: readonly number[] = []): Promise<Submitted> {
    if (this.stopped) throw new Error('游戏未连接');
    const task: Task = { id: this.nextId++, steps, done: 0, results: [], queuedAt: this.now() };
    const notes: string[] = [];
    const ids = new Set(cancel);
    const dropped = this.queue.filter(t => ids.has(t.id) || mode === 'replace');
    this.queue = this.queue.filter(t => !dropped.includes(t));
    for (const t of dropped) this.deps.report({ id: t.id, kind: 'cancelled', text: this.cancelText(t, ids.has(t.id) ? `被任务#${task.id}撤掉` : `被任务#${task.id}替换`) });
    if (dropped.length) notes.push(`撤掉了还没开始的${dropped.map(t => `任务#${t.id}`).join('、')}`);
    if (mode === 'now') this.queue.unshift(task);
    else this.queue.push(task);
    const running = this.running;
    if (running && (mode === 'now' || ids.has(running.id))) {
      notes.push(`叫停了正在做的任务#${running.id}`);
      await this.interrupt(mode === 'now' ? `被插队的任务#${task.id}叫停` : `被任务#${task.id}撤掉`);
    } else if (running) {
      notes.push(`正在做的任务#${running.id}会做完（现在第 ${running.done + 1}/${running.steps.length} 步），任务#${task.id}排在它后面；要马上换成新的就用 now`);
    }
    this.kick();
    return { id: task.id, notes };
  }

  /** 撤掉一个任务；正在做的就叫停。返回一句结果。 */
  async cancelTask(id: number, reason: string): Promise<string> {
    if (this.running?.id === id) {
      await this.interrupt(reason);
      return `叫停了任务#${id}`;
    }
    const task = this.queue.find(t => t.id === id);
    if (!task) return `任务#${id} 已经结束或不在队列里`;
    this.queue = this.queue.filter(t => t !== task);
    this.deps.report({ id, kind: 'cancelled', text: this.cancelText(task, reason) });
    return `撤掉了任务#${id}`;
  }

  /** 叫停正在做的那一步；执行循环报告取消后接着做队列里的下一个。 */
  private async interrupt(reason: string): Promise<void> {
    this.cancelReason = reason;
    this.controller?.abort();
    try {
      // 插件收到 halt 才会回复正在执行的那一步。
      await this.deps.halt();
    } catch {
      // 连接已断时插件在断线处理里自行松开按键，那一步的请求随断线失败。
    }
  }

  /** 取消全部任务；每个被取消的任务各报一次。 */
  async cancel(reason: string): Promise<number> {
    const dropped = this.queue.splice(0);
    for (const t of dropped) this.deps.report({ id: t.id, kind: 'cancelled', text: this.cancelText(t, reason) });
    const running = this.running;
    if (running) {
      await this.interrupt(reason);
      await this.loop;
    }
    return dropped.length + (running ? 1 : 0);
  }

  private cancelReason = '';

  async stop(): Promise<void> {
    await this.cancel('游戏连接断开');
    this.stopped = true;
  }

  resume(): void {
    this.stopped = false;
  }

  /** 一句话说清队列，回执、快照和结果都用这一句。 */
  describeQueue(): string {
    const parts: string[] = [];
    const r = this.running;
    if (r) {
      const step = r.steps[r.done];
      parts.push(`正在做任务#${r.id}（第 ${r.done + 1}/${r.steps.length} 步：${step ? this.deps.describe(step) : '收尾'}）`);
    }
    if (this.queue.length) parts.push(`后面排着 ${this.queue.map(t => `任务#${t.id}（${t.steps.length} 步）`).join('、')}`);
    return parts.length ? parts.join('；') : '空';
  }

  private kick(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.drain().finally(() => {
      this.loop = null;
      if (this.queue.length && !this.stopped) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.stopped) {
      const task = this.queue.shift()!;
      this.running = task;
      task.startedAt = this.now();
      const controller = new AbortController();
      this.controller = controller;
      let failure: string | null = null;
      try {
        while (task.done < task.steps.length) {
          const result = await this.deps.run(task.steps[task.done], controller.signal);
          if (controller.signal.aborted) break;
          if (!result.ok) {
            failure = result.detail;
            break;
          }
          task.results.push(result.detail);
          task.done++;
        }
      } catch (e) {
        if (!controller.signal.aborted) failure = e instanceof Error ? e.message : String(e);
      }
      this.running = null;
      this.controller = null;
      if (controller.signal.aborted) this.deps.report({ id: task.id, kind: 'cancelled', text: this.cancelText(task, this.cancelReason) });
      else if (failure !== null) this.deps.report({ id: task.id, kind: 'blocked', text: this.blockedText(task, failure) });
      else this.deps.report({ id: task.id, kind: 'done', text: this.doneText(task) });
    }
  }

  private seconds(task: Task): string {
    const s = (this.now() - (task.startedAt ?? task.queuedAt)) / 1000;
    return `${s.toFixed(1)}s`;
  }

  private ledger(task: Task): string {
    return task.results.filter(Boolean).join('；');
  }

  private doneText(task: Task): string {
    return `任务#${task.id} 完成（${this.seconds(task)}）：${this.ledger(task) || task.steps.map(s => this.deps.describe(s)).join('→')}。`;
  }

  private blockedText(task: Task, reason: string): string {
    const step = task.steps[task.done];
    const head = `任务#${task.id} 卡在第 ${task.done + 1}/${task.steps.length} 步「${this.deps.describe(step)}」：${reason}`;
    const done = task.done ? `已做：${this.ledger(task)}。` : '';
    const left = task.steps.length - task.done - 1;
    return `${head}${/[。！？]$/.test(reason) ? '' : '。'}${done}${left ? `后面 ${left} 步没做。` : ''}`;
  }

  private cancelText(task: Task, reason: string): string {
    if (task.startedAt === undefined) return `任务#${task.id} 还没开始就取消了（${reason}）。`;
    return `任务#${task.id} 做到第 ${task.done + 1}/${task.steps.length} 步时取消（${reason}）。${task.done ? `已做：${this.ledger(task)}。` : ''}`;
  }
}
