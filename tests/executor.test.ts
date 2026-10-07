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

  it('replace cancels queued work before the new task runs', async () => {
    const p = plugin();
    const reports: TaskReport[] = [];
    const ex = new Executor({ run: p.run, halt: p.halt, describe: s => s.do, report: r => reports.push(r) });
    await ex.submit([{ do: 'go' }], 'append');
    await ex.submit([{ do: 'chop' }], 'append');
    await tick();
    await ex.submit([{ do: 'wash' }], 'replace');
    await tick();
    expect(reports.map(r => r.kind)).toEqual(['cancelled', 'cancelled']);
    expect(p.calls).toEqual(['run go', 'halt', 'run wash']);
  });
});
