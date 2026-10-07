import { describe, expect, it } from 'vitest';
import { Executor, type Step, type StepResult, type TaskReport } from '../src/executor.ts';

/** 插件的替身：每一步在 resolve 前一直挂着，halt 让挂着的那一步以「已取消」回复。 */
function plugin() {
  const calls: string[] = [];
  let pending: ((r: StepResult) => void) | null = null;
  const results = new Map<string, StepResult>();
  return {
    calls,
    results,
    run: (step: Step) =>
      new Promise<StepResult>(resolve => {
        calls.push(`run ${step.do}`);
        const fixed = results.get(step.do);
        if (fixed) resolve(fixed);
        else pending = resolve;
      }),
    finish: (r: StepResult) => {
      const p = pending;
      pending = null;
      p?.(r);
    },
    halt: async () => {
      calls.push('halt');
      const p = pending;
      pending = null;
      p?.({ ok: false, detail: '已取消' });
    },
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('Executor', () => {
  it('halts the plugin before waiting for the step that is running, and reports the cancel once', async () => {
    const p = plugin();
    const reports: TaskReport[] = [];
    const ex = new Executor({ run: p.run, halt: p.halt, describe: s => s.do, report: r => reports.push(r) });
    await ex.submit([{ do: 'take' }, { do: 'put' }], 'append');
    await tick();
    expect(p.calls).toEqual(['run take']);
    await ex.cancel('叫停');
    expect(p.calls).toEqual(['run take', 'halt']);
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('cancelled');
    expect(ex.idle).toBe(true);
  });

  it('stops a task at the failing step with its reason and goes on with the next task', async () => {
    const p = plugin();
    p.results.set('take', { ok: true, detail: '拿到生鱼' });
    p.results.set('put', { ok: false, detail: '游戏不让把生鱼放到这里' });
    p.results.set('wash', { ok: true, detail: '洗了 1 只盘子' });
    const reports: TaskReport[] = [];
    const ex = new Executor({ run: p.run, halt: p.halt, describe: s => s.do, report: r => reports.push(r) });
    await ex.submit([{ do: 'take' }, { do: 'put' }, { do: 'chop' }], 'append');
    await ex.submit([{ do: 'wash' }], 'append');
    for (let i = 0; i < 10 && reports.length < 2; i++) await tick();
    expect(reports.map(r => r.kind)).toEqual(['blocked', 'done']);
    expect(reports[0].text).toContain('卡在第 2/3 步「put」：游戏不让把生鱼放到这里');
    expect(reports[0].text).toContain('已做：拿到生鱼。');
    expect(reports[0].text).toContain('后面 1 步没做。');
    expect(p.calls).not.toContain('run chop');
  });

  it('replace drops queued work and lets the running task finish first', async () => {
    const p = plugin();
    const reports: TaskReport[] = [];
    const ex = new Executor({ run: p.run, halt: p.halt, describe: s => s.do, report: r => reports.push(r) });
    await ex.submit([{ do: 'go' }], 'append');
    await ex.submit([{ do: 'chop' }], 'append');
    await tick();
    const { notes } = await ex.submit([{ do: 'wash' }], 'replace');
    expect(reports.map(r => [r.id, r.kind])).toEqual([[2, 'cancelled']]);
    expect(notes.join('；')).toContain('正在做的任务#1会做完');
    p.finish({ ok: true, detail: '到了' });
    for (let i = 0; i < 5; i++) await tick();
    expect(p.calls).toEqual(['run go', 'run wash']);
  });

  it('now halts the running task and runs the new one before what was queued', async () => {
    const p = plugin();
    const reports: TaskReport[] = [];
    const ex = new Executor({ run: p.run, halt: p.halt, describe: s => s.do, report: r => reports.push(r) });
    await ex.submit([{ do: 'go' }], 'append');
    await ex.submit([{ do: 'chop' }], 'append');
    await tick();
    await ex.submit([{ do: 'extinguish' }], 'now');
    for (let i = 0; i < 5; i++) await tick();
    expect(reports.map(r => [r.id, r.kind])).toEqual([[1, 'cancelled']]);
    expect(p.calls).toEqual(['run go', 'halt', 'run extinguish']);
    p.finish({ ok: true, detail: '火灭了' });
    for (let i = 0; i < 5; i++) await tick();
    expect(p.calls.at(-1)).toBe('run chop');
  });

  it('cancels only the tasks named by number', async () => {
    const p = plugin();
    const reports: TaskReport[] = [];
    const ex = new Executor({ run: p.run, halt: p.halt, describe: s => s.do, report: r => reports.push(r) });
    await ex.submit([{ do: 'go' }], 'append');
    await ex.submit([{ do: 'chop' }], 'append');
    await ex.submit([{ do: 'wash' }], 'append');
    await tick();
    await ex.submit([{ do: 'take' }], 'append', [2]);
    expect(reports.map(r => [r.id, r.kind])).toEqual([[2, 'cancelled']]);
    expect(ex.describeQueue()).toBe('正在做任务#1（第 1/1 步：go）；后面排着 任务#3（1 步）、任务#4（1 步）');
  });
});
