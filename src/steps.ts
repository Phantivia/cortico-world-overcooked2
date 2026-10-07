/**
 * oc2_do 的步骤：参数校验、标签解析成对象 id、一步的称呼和完成时的说法。标签在排入时解析，之后
 * 指向同一个对象；对象被用掉或拿走时由插件在执行那一步时报原因。
 */
import type { Step, StepResult } from './executor.ts';
import type { GameState, Item } from './state.ts';
import { itemText, nameOf, type RenderCtx } from './render.ts';
import type { Reply } from './bridge.ts';

export const STEP_KINDS = ['take', 'put', 'serve', 'chop', 'wash', 'throw', 'go', 'wait', 'use', 'extinguish'] as const;
export const WAIT_UNTIL = ['cooked', 'chopped', 'item', 'empty', 'plates', 'seconds'] as const;

export const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    do: { enum: [...STEP_KINDS] },
    target: { type: 'string', description: '对象标签（如 B1、K2、P3），throw 也可写 partner' },
    x: { type: 'integer' },
    z: { type: 'integer' },
    until: { enum: [...WAIT_UNTIL] },
    seconds: { type: 'number', minimum: 0.1, maximum: 120 },
    plates: { type: 'integer', minimum: 1, maximum: 20 },
    dash: { type: 'boolean' },
  },
  required: ['do'],
};

export interface ParsedStep extends Step {
  do: (typeof STEP_KINDS)[number];
  target?: string;
  /** 解析后的对象 id，发给插件。 */
  id?: number;
  x?: number;
  z?: number;
  until?: (typeof WAIT_UNTIL)[number];
  seconds?: number;
  plates?: number;
  dash?: boolean;
}

const NEEDS_TARGET = new Set(['take', 'put', 'chop', 'wash', 'throw', 'use', 'extinguish']);

/** 校验并解析；有任何问题整个任务不排入，返回全部问题。 */
export function parseSteps(raw: unknown, state: GameState | null, ctx: RenderCtx): { steps: ParsedStep[]; problems: string[] } {
  const problems: string[] = [];
  const steps: ParsedStep[] = [];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 30) return { steps, problems: ['steps 要是 1 到 30 步的数组'] };
  raw.forEach((value, i) => {
    const n = `第 ${i + 1} 步`;
    if (!value || typeof value !== 'object') { problems.push(`${n}不是对象`); return; }
    const s = value as Record<string, unknown>;
    const kind = s.do as ParsedStep['do'];
    if (!STEP_KINDS.includes(kind)) { problems.push(`${n}：do 只能是 ${STEP_KINDS.join('/')}`); return; }
    const step: ParsedStep = { do: kind };
    for (const key of Object.keys(s)) if (!(key in STEP_SCHEMA.properties)) problems.push(`${n}：没有 ${key} 这个字段`);
    if (typeof s.dash === 'boolean') step.dash = s.dash;
    if (s.target !== undefined) {
      if (typeof s.target !== 'string') problems.push(`${n}：target 要是标签字符串`);
      else {
        const label = s.target.trim();
        step.target = label.toUpperCase();
        const id = /^partner$|^队友$/i.test(label) || label === ctx.partner ? state?.chefs.find(c => c.role === 'partner')?.id : ctx.labels.resolve(label);
        if (id === undefined) problems.push(`${n}：现在没有标签 ${label}`);
        else step.id = id;
      }
    }
    if (kind === 'serve' && step.id === undefined && s.target === undefined) {
      const pass = state?.stations.find(st => st.kind === 'pass');
      if (pass) { step.id = pass.id; step.target = ctx.labels.of(pass.id); }
      else problems.push(`${n}：这关找不到出餐口`);
    }
    if (NEEDS_TARGET.has(kind) && s.target === undefined) problems.push(`${n}：${kind} 要写 target`);
    if (kind === 'go') {
      const hasXZ = Number.isInteger(s.x) && Number.isInteger(s.z);
      if (hasXZ) { step.x = s.x as number; step.z = s.z as number; }
      else if (s.target === undefined) problems.push(`${n}：go 要写 target 或 x、z`);
    }
    if (kind === 'wait') {
      const until = (s.until ?? (s.target === undefined ? 'seconds' : undefined)) as ParsedStep['until'];
      if (!until || !WAIT_UNTIL.includes(until)) problems.push(`${n}：wait 要写 until（${WAIT_UNTIL.join('/')}）`);
      else step.until = until;
      if (until && until !== 'seconds' && s.target === undefined) problems.push(`${n}：等 ${until} 要写 target`);
      if (until === 'seconds' && typeof s.seconds !== 'number') problems.push(`${n}：等时间要写 seconds`);
    }
    if (typeof s.seconds === 'number') step.seconds = Math.min(120, Math.max(0.1, s.seconds));
    if (Number.isInteger(s.plates)) step.plates = s.plates as number;
    steps.push(step);
  });
  return { steps, problems };
}

/** 发给插件的形状。 */
export function pluginStep(step: ParsedStep): Record<string, unknown> {
  const out: Record<string, unknown> = { do: step.do };
  if (step.id !== undefined) out.target = step.id;
  for (const k of ['x', 'z', 'until', 'seconds', 'plates', 'dash'] as const) if (step[k] !== undefined) out[k] = step[k];
  return out;
}

const UNTIL_TEXT: Record<string, string> = { cooked: '加热好', chopped: '切好', item: '上面有东西', empty: '空出来', plates: '有盘子' };

export function describe(step: ParsedStep, state: GameState | null, ctx: RenderCtx): string {
  const t = step.id !== undefined ? nameOf(step.id, state, ctx) : step.target ?? '';
  switch (step.do) {
    case 'take': {
      const on = state?.stations.find(st => st.id === step.id)?.item;
      return on ? `拿 ${t} 上的${itemText(on, ctx)}` : `拿 ${t}`;
    }
    case 'put':
      return `放到 ${t}`;
    case 'serve':
      return `上菜到 ${t}`;
    case 'chop':
      return `切 ${t}`;
    case 'wash':
      return `洗 ${t}${step.plates ? ` ${step.plates} 只` : ''}`;
    case 'throw':
      return `扔向 ${t}`;
    case 'go':
      return step.x !== undefined ? `走到 (${step.x},${step.z})` : `走到 ${t} 旁`;
    case 'wait':
      return step.until === 'seconds' ? `等 ${step.seconds} 秒` : `等 ${t} ${UNTIL_TEXT[step.until ?? ''] ?? step.until}`;
    case 'use':
      return `操作 ${t}`;
    case 'extinguish':
      return `灭 ${t} 的火`;
  }
}

function fill(why: string, reply: Reply, ctx: RenderCtx): string {
  const item = reply.item;
  const by = reply.by === 'partner' ? ctx.partner : reply.by === 'bot' ? '我' : '别人';
  return why.replace('{item}', item ? itemText(item, ctx) : '东西').replace('{by}', by);
}

/**
 * 手里的容器对目标容器放：游戏把东西从一个倒进另一个，两边都还在原处。按手里容器多了还是少了
 * 东西说方向。
 */
export function transferText(before: Item | undefined, after: Item, other: Item, ctx: RenderCtx): string {
  const label = (i: Item) => ctx.labels.of(i.id) ?? '';
  const gained = (after.contents?.length ?? 0) > (before?.contents?.length ?? 0);
  return gained
    ? `用${label(after) || '手里的容器'}从${label(other) || '目标'}盛出来，手里现在是${itemText(after, ctx)}，${itemText(other, ctx)}`
    : `把${label(after) || '手里的容器'}里的东西倒进${itemText(other, ctx)}，手里现在是${itemText(after, ctx)}`;
}

/** 插件回复转成执行器的一步结果。 */
export function stepResult(step: ParsedStep, reply: Reply, state: GameState | null, ctx: RenderCtx): StepResult {
  const where = step.id !== undefined ? nameOf(step.id, state, ctx) : '';
  if (!reply.ok) {
    const at = reply.station !== undefined ? `（${nameOf(reply.station, state, ctx)}）` : '';
    return { ok: false, detail: fill(reply.why ?? '游戏没有执行', reply, ctx) + at };
  }
  const item = reply.item;
  const held = reply.held;
  const into = reply.into;
  const it = item ? itemText(item, ctx) : '东西';
  switch (step.do) {
    case 'take':
      return { ok: true, detail: `拿到${it}` };
    case 'put':
      if (into && held && held.id === item?.id) return { ok: true, detail: transferText(item, held, into, ctx) };
      if (into) return { ok: true, detail: `把${it}放进${itemText(into, ctx)}` };
      // 拿着盘子或锅对垃圾桶放：游戏倒掉里面的东西，容器还在手里。
      if (held && held.id === item?.id && state?.stations.find(s => s.id === step.id)?.kind === 'bin') return { ok: true, detail: `把${it}里的东西倒进 ${where}，手里还是${itemText(held, ctx)}` };
      return { ok: true, detail: `把${it}放到 ${where}` };
    case 'serve':
      return reply.delivered === false ? { ok: false, detail: '盘子放上出餐口了，但没有算作出餐' } : { ok: true, detail: '上菜成功' };
    case 'chop':
      return { ok: true, detail: `切好了${it}` };
    case 'wash':
      return { ok: true, detail: `洗了 ${reply.washed ?? '?'} 只盘子（水槽还剩 ${reply.left ?? '?'} 只）` };
    case 'throw':
      return { ok: true, detail: `扔出了${it}` };
    case 'go':
      return { ok: true, detail: `到了${step.x !== undefined ? ` (${step.x},${step.z})` : ` ${where} 旁`}` };
    case 'wait':
      return { ok: true, detail: step.until === 'seconds' ? `等了 ${step.seconds} 秒` : `${where} ${reply.state ?? UNTIL_TEXT[step.until ?? '']}` };
    case 'use':
      return { ok: true, detail: `操作了 ${where}` };
    case 'extinguish':
      return { ok: true, detail: `${where} 的火灭了` };
  }
}
