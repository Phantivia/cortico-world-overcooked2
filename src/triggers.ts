/**
 * oc2_arm：盯着一个条件，成立的那一刻把一串动作排进任务队列。条件在每一帧状态上重判；从不成立
 * 变成成立才算一次，一直成立不会连着排。用满次数、到期、换关或离开厨房时撤掉，每种结局都回报。
 */
import type { QueueMode } from './executor.ts';
import { dishName } from './names.ts';
import { nameOf, type RenderCtx } from './render.ts';
import type { GameState, Item } from './state.ts';
import type { ParsedStep } from './steps.ts';

export const ARM_UNTIL = ['cooked', 'overdone', 'burnt', 'fire', 'chopped', 'item', 'empty', 'plates'] as const;
type Until = (typeof ARM_UNTIL)[number];

export type Condition =
  | { kind: 'target'; id: number; until: Until }
  | { kind: 'order'; dish?: string; maxSeconds?: number }
  | { kind: 'all' | 'any'; of: Condition[] };

const UNTIL_TEXT: Record<Until, string> = {
  cooked: '煮好了',
  overdone: '快糊了',
  burnt: '糊了',
  fire: '着火了',
  chopped: '切好了',
  item: '上面有东西了',
  empty: '空了',
  plates: '有干净盘子了',
};

const LEAF_PROPERTIES = {
  target: { type: 'string' },
  until: { enum: [...ARM_UNTIL], description: 'cooked 煮好 overdone 快糊 burnt 糊了 fire 着火 chopped 切好 item 上面有东西 empty 空了 plates 有干净盘子' },
  order: {
    type: 'object',
    additionalProperties: false,
    properties: { dish: { type: 'string' }, maxSeconds: { type: 'number', minimum: 0 } },
  },
};

/** 组合里的每一项只写一个单独的条件；all、any 不再往下套。 */
const LEAF_SCHEMA = { type: 'object', additionalProperties: false, properties: LEAF_PROPERTIES };

export const CONDITION_SCHEMA = {
  type: 'object',
  description:
    '三种写法选一种：{target:标签, until:…}；{order:{dish?:菜名, maxSeconds?:秒}} 有这道菜的订单（剩下不超过 maxSeconds 秒）；{all:[…]} 全部成立或 {any:[…]} 有一个成立，里面每项是前两种之一。',
  properties: {
    ...LEAF_PROPERTIES,
    all: { type: 'array', minItems: 1, maxItems: 6, items: LEAF_SCHEMA },
    any: { type: 'array', minItems: 1, maxItems: 6, items: LEAF_SCHEMA },
  },
  additionalProperties: false,
};

export function parseCondition(raw: unknown, resolve: (label: string) => number | undefined, depth = 0): Condition | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'when 要是对象';
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  for (const k of keys) if (!['target', 'until', 'order', 'all', 'any'].includes(k)) return `when 里没有 ${k} 这个字段`;
  if (r.all !== undefined || r.any !== undefined) {
    if (keys.length !== 1) return 'all、any 要单独写';
    if (depth >= 1) return 'all、any 里面不能再套 all、any';
    const list = (r.all ?? r.any) as unknown;
    if (!Array.isArray(list) || !list.length || list.length > 6) return 'all、any 要写 1 到 6 个条件';
    const of: Condition[] = [];
    for (const item of list) {
      const c = parseCondition(item, resolve, depth + 1);
      if (typeof c === 'string') return c;
      of.push(c);
    }
    return { kind: r.all !== undefined ? 'all' : 'any', of };
  }
  if (r.order !== undefined) {
    if (keys.length !== 1) return 'order 要单独写';
    const o = r.order as Record<string, unknown>;
    if (!o || typeof o !== 'object') return 'order 要是对象';
    if (o.dish !== undefined && typeof o.dish !== 'string') return 'order.dish 要是菜名';
    if (o.maxSeconds !== undefined && typeof o.maxSeconds !== 'number') return 'order.maxSeconds 要是秒数';
    return { kind: 'order', dish: o.dish as string | undefined, maxSeconds: o.maxSeconds as number | undefined };
  }
  if (typeof r.target !== 'string') return 'when 要写 target 和 until，或者 order、all、any';
  if (!ARM_UNTIL.includes(r.until as Until)) return `until 只能是 ${ARM_UNTIL.join('/')}`;
  const id = resolve(r.target);
  if (id === undefined) return `现在没有标签 ${r.target}`;
  return { kind: 'target', id, until: r.until as Until };
}

export function describeCondition(c: Condition, state: GameState | null, ctx: RenderCtx): string {
  switch (c.kind) {
    case 'target':
      return `${nameOf(c.id, state, ctx)} ${UNTIL_TEXT[c.until]}`;
    case 'order':
      return `有${c.dish ?? '任意一道菜'}的订单${c.maxSeconds !== undefined ? `剩下不超过 ${c.maxSeconds} 秒` : ''}`;
    case 'all':
      return c.of.map(x => describeCondition(x, state, ctx)).join('，而且');
    case 'any':
      return c.of.map(x => describeCondition(x, state, ctx)).join('，或者');
  }
}

/** 标签指向的东西此刻的样子：站点（连同上面的物品）或在别处的物品。 */
function lookup(state: GameState, id: number): { station?: GameState['stations'][number]; item?: Item } | null {
  const st = state.stations.find(s => s.id === id);
  if (st) return { station: st, item: st.item };
  for (const s of state.stations) if (s.item?.id === id) return { station: s, item: s.item };
  for (const ch of state.chefs) if (ch.held?.id === id) return { item: ch.held };
  const loose = state.loose.find(i => i.id === id);
  return loose ? { item: loose } : null;
}

export function evaluate(c: Condition, state: GameState): boolean {
  switch (c.kind) {
    case 'all':
      return c.of.every(x => evaluate(x, state));
    case 'any':
      return c.of.some(x => evaluate(x, state));
    case 'order':
      return state.orders.some(o =>
        (c.dish === undefined || o.dish === c.dish || dishName(o.dish) === c.dish) && (c.maxSeconds === undefined || o.remaining <= c.maxSeconds));
    case 'target': {
      const at = lookup(state, c.id);
      if (!at) return false;
      const { station, item } = at;
      switch (c.until) {
        case 'cooked':
          return (item?.cook === 'done' || item?.cook === 'overdone') && !!item.contents?.length;
        case 'overdone':
          return item?.cook === 'overdone';
        case 'burnt':
          return item?.cook === 'burnt';
        case 'fire':
          return !!station?.onFire;
        case 'chopped':
          return item?.kind === 'ingredient' && item.chop !== undefined && item.chop >= 1;
        case 'item':
          return station?.kind === 'sink' ? (station.plates ?? 0) > 0 : !!item;
        case 'empty':
          return station?.kind === 'sink' ? !station.plates : !item;
        case 'plates':
          return item?.kind === 'plate' && !item.dirty && (item.stack !== undefined ? item.stack > 0 : !item.contents?.length);
      }
    }
  }
}

export interface Watch {
  id: number;
  when: Condition;
  steps: ParsedStep[];
  queue: QueueMode;
  left: number;
  max: number;
  expiresAt: number | null;
  /** 上一次判定时条件成立；要先看到不成立才会再排。 */
  active: boolean;
}

export type WatchEnd = 'fired' | 'expired' | 'invalidated' | 'cancelled';

export interface WatchesOptions {
  /** 条件成立：把步骤排进队列，返回执行器的回执。 */
  fire: (w: Watch) => Promise<string>;
  /** 每次排上和每种撤掉都报一句。 */
  report: (w: Watch, end: WatchEnd, text: string) => void;
  /** 条件写成一句，回报里用。 */
  describe: (w: Watch) => string;
  now?: () => number;
}

export class Watches {
  private nextId = 1;
  private list: Watch[] = [];
  private firing = false;

  constructor(private readonly opts: WatchesOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get all(): readonly Watch[] {
    return this.list;
  }

  arm(when: Condition, steps: ParsedStep[], queue: QueueMode, max: number, expiresInMs: number | null): Watch {
    const w: Watch = { id: this.nextId++, when, steps, queue, left: max, max, expiresAt: expiresInMs ? this.now() + expiresInMs : null, active: false };
    this.list.push(w);
    return w;
  }

  /** 每帧调用：到期的撤掉，条件刚成立的排上。一次只排一个，排完下一帧再看别的。 */
  async tick(state: GameState): Promise<void> {
    if (this.firing) return;
    const now = this.now();
    for (const w of [...this.list]) {
      if (w.expiresAt !== null && now >= w.expiresAt) {
        this.remove(w);
        this.opts.report(w, 'expired', `盯着#${w.id} 到时间撤掉了（${this.opts.describe(w)}），一共排过 ${w.max - w.left} 次。`);
      }
    }
    for (const w of this.list) {
      const met = evaluate(w.when, state);
      const edge = met && !w.active;
      w.active = met;
      if (!edge) continue;
      w.left--;
      if (w.left <= 0) this.remove(w);
      this.firing = true;
      try {
        const receipt = await this.opts.fire(w);
        const last = w.left <= 0 ? '这是最后一次，已撤掉。' : `还能排 ${w.left} 次。`;
        this.opts.report(w, 'fired', `盯着#${w.id} 的条件到了（${this.opts.describe(w)}），${last}${receipt}`);
      } catch (err) {
        this.opts.report(w, 'fired', `盯着#${w.id} 的条件到了，但没排上：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.firing = false;
      }
      return;
    }
  }

  cancel(id: number, reason: string): boolean {
    const w = this.list.find(x => x.id === id);
    if (!w) return false;
    this.remove(w);
    this.opts.report(w, 'cancelled', `盯着#${w.id} 撤掉了（${reason}）。`);
    return true;
  }

  /** 全部撤掉，比如换关；返回撤掉几个。 */
  clear(reason: string, end: WatchEnd = 'invalidated'): number {
    const all = this.list.splice(0);
    for (const w of all) this.opts.report(w, end, `盯着#${w.id} 撤掉了（${reason}）：${this.opts.describe(w)}。`);
    return all.length;
  }

  private remove(w: Watch): void {
    this.list = this.list.filter(x => x !== w);
  }
}

/** 一个盯着的事写成一句：条件 → 步骤。 */
export function watchText(w: Watch, state: GameState | null, ctx: RenderCtx, step: (s: ParsedStep) => string): string {
  return `${describeCondition(w.when, state, ctx)} → ${w.steps.map(step).join(' → ')}`;
}

