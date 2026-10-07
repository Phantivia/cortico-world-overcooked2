/**
 * bot 厨师的任务队列：任务按序执行，每步交给插件做完再回执。一步失败即整个任务受阻，后面的任务
 * 照常继续（下一个任务的第一步会基于新状态重新判断）。replace 先取消全部再排入；取消要等插件确认
 * 按键已松开、正在执行的那一步已回复。
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

  /** 排入任务，返回任务号。replace 先取消正在做的和排着的。 */
  async submit(steps: Step[], mode: 'append' | 'replace'): Promise<number> {
    if (this.stopped) throw new Error('游戏未连接');
    if (mode === 'replace') await this.cancel('被新任务替换');
    const task: Task = { id: this.nextId++, steps, done: 0, results: [], queuedAt: this.now() };
    this.queue.push(task);
    this.kick();
    return task.id;
  }

  /** 取消全部任务；每个被取消的任务各报一次。 */
  async cancel(reason: string): Promise<number> {
    const dropped = this.queue.splice(0);
    for (const t of dropped) this.deps.report({ id: t.id, kind: 'cancelled', text: this.cancelText(t, reason) });
    const running = this.running;
    if (running) {
      this.cancelReason = reason;
      this.controller?.abort();
      // 插件收到 halt 才会回复正在执行的那一步，执行循环随之结束。
      try {
        await this.deps.halt();
      } catch {
        // 连接已断时插件在断线处理里自行松开按键，那一步的请求随断线失败。
      }
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
