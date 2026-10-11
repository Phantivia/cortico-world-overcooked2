/**
 * oc2_do 的步骤：参数校验、标签解析成对象 id、一步的称呼和完成时的说法。标签在排入时解析，之后
 * 指向同一个对象；对象被用掉或拿走时由插件在执行那一步时报原因。不写 target 而写 find（可带 near、
 * shared）时，执行到这一步才按当时的厨房挑对象（resolveFind）。字段平铺不用联合类型，因为有的
 * provider 会把 oneOf 收成第一个分支。
 */
import type { Step, StepResult } from './executor.ts';
import type { GameState, Item, Station } from './state.ts';
import { ingredientName } from './names.ts';
import { itemText, nameOf, type RenderCtx } from './render.ts';
import type { Reply } from './bridge.ts';
import { cellReachable, chefOf, sideOf } from './sides.ts';

export const STEP_KINDS = ['take', 'put', 'serve', 'chop', 'wash', 'throw', 'go', 'wait', 'use', 'extinguish'] as const;
export const WAIT_UNTIL = ['cooked', 'chopped', 'item', 'empty', 'plates', 'seconds'] as const;
export const FIND_KINDS = ['empty_counter', 'empty_board', 'clean_plate', 'cooked', 'empty_pot', 'chopped'] as const;
export type FindKind = (typeof FIND_KINDS)[number];
/** 能用 of 按食材挑的那几种。 */
const FIND_OF: readonly FindKind[] = ['cooked', 'chopped'];

/** 执行时才挑的目标。near 是标签或 partner；shared 只挑两边都够得着的；of 是食材的中文名。 */
export interface Find {
  find: FindKind;
  near?: string;
  /** near 解析成的对象 id；near 是 partner 时不填，执行时取队友当时的位置。 */
  nearId?: number;
  shared?: boolean;
  of?: string;
}

const FIND_TEXT: Record<FindKind, string> = {
  empty_counter: '空台面',
  empty_board: '空砧板',
  clean_plate: '干净的空盘子',
  cooked: '煮好的锅所在的站点',
  empty_pot: '放着空锅的炉灶',
  chopped: '放着切好的食材的站点',
};

function whatText(f: Find): string {
  if (f.of && f.find === 'cooked') return `煮好${f.of}的锅所在的站点`;
  if (f.of && f.find === 'chopped') return `放着切好的${f.of}的站点`;
  return FIND_TEXT[f.find];
}

export const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    do: { enum: [...STEP_KINDS] },
    target: { type: 'string', description: '对象标签（如 B1、K2、P3），throw 也可写 partner' },
    find: {
      enum: [...FIND_KINDS],
      description: '不写 target 时，执行到这一步再从我够得着的里面挑最近的：empty_counter 空台面，empty_board 空砧板，clean_plate 干净的空盘子，cooked 锅里东西煮好了的站点，empty_pot 放着空锅的炉灶，chopped 放着切好的食材的站点。wait 写 find 不写 until：等到有这样的站点为止',
    },
    of: { type: 'string', description: '配合 find 的 cooked、chopped：只挑这种食材，写中文名，如 鱼、米' },
    near: { type: 'string', description: '配合 find：挑离这个标签（或 partner）最近的；不写就挑离我最近的' },
    shared: { type: 'boolean', description: '配合 find：只挑我和队友两边都够得着的，交接用' },
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
  /** 执行时再挑的目标；挑出来之前没有 id。 */
  find?: Find;
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
    if (s.find !== undefined) {
      if (s.target !== undefined) problems.push(`${n}：target 和 find 只写一个`);
      const f = parseFind(s, state, ctx);
      if (typeof f === 'string') problems.push(`${n}：${f}`);
      else step.find = f;
    } else if (s.near !== undefined || s.shared !== undefined || s.of !== undefined) {
      problems.push(`${n}：near、shared、of 要和 find 一起写`);
    }
    if (s.target !== undefined && s.find === undefined) {
      if (typeof s.target !== 'string') problems.push(`${n}：target 要是标签`);
      else {
        const label = s.target.trim();
        step.target = label.toUpperCase();
        const id = /^partner$|^队友$/i.test(label) || label === ctx.partner ? state?.chefs.find(c => c.role === 'partner')?.id : ctx.labels.resolve(label);
        if (id === undefined) problems.push(`${n}：现在没有标签 ${label}`);
        else step.id = id;
      }
    }
    const aimed = s.target !== undefined || s.find !== undefined;
    if (kind === 'serve' && step.id === undefined && !aimed) {
      const pass = state?.stations.find(st => st.kind === 'pass');
      if (pass) { step.id = pass.id; step.target = ctx.labels.of(pass.id); }
      else problems.push(`${n}：这关找不到出餐口`);
    }
    if (NEEDS_TARGET.has(kind) && !aimed) problems.push(`${n}：${kind} 要写 target 或 find`);
    if (kind === 'go') {
      const hasXZ = Number.isInteger(s.x) && Number.isInteger(s.z);
      if (hasXZ) { step.x = s.x as number; step.z = s.z as number; }
      else if (!aimed) problems.push(`${n}：go 要写 target、find 或 x、z`);
    }
    if (kind === 'wait' && s.find !== undefined && s.until === undefined) {
      // 等到有这样的站点：执行时每帧挑一次，挑到了这一步就算完。
    } else if (kind === 'wait') {
      const until = (s.until ?? (aimed ? undefined : 'seconds')) as ParsedStep['until'];
      if (!until || !WAIT_UNTIL.includes(until)) problems.push(`${n}：wait 要写 until（${WAIT_UNTIL.join('/')}）`);
      else step.until = until;
      if (until && until !== 'seconds' && !aimed) problems.push(`${n}：等 ${until} 要写 target 或 find`);
      if (until === 'seconds' && typeof s.seconds !== 'number') problems.push(`${n}：等时间要写 seconds`);
    }
    if (typeof s.seconds === 'number') step.seconds = Math.min(120, Math.max(0.1, s.seconds));
    if (Number.isInteger(s.plates)) step.plates = s.plates as number;
    steps.push(step);
  });
  return { steps, problems };
}

export function parseFind(raw: Record<string, unknown>, state: GameState | null, ctx: RenderCtx): Find | string {
  if (!FIND_KINDS.includes(raw.find as FindKind)) return `find 只能是 ${FIND_KINDS.join('/')}`;
  const out: Find = { find: raw.find as FindKind };
  if (raw.shared !== undefined) {
    if (typeof raw.shared !== 'boolean') return 'shared 要是 true 或 false';
    out.shared = raw.shared;
  }
  if (raw.of !== undefined) {
    if (!FIND_OF.includes(out.find)) return `of 只能配 ${FIND_OF.join('、')}`;
    if (typeof raw.of !== 'string' || !raw.of.trim()) return 'of 要写食材的中文名';
    out.of = raw.of.trim();
  }
  if (raw.near !== undefined) {
    if (typeof raw.near !== 'string') return 'near 要是标签或 partner';
    const label = raw.near.trim();
    if (/^partner$|^队友$/i.test(label) || label === ctx.partner) out.near = 'partner';
    else {
      const id = ctx.labels.resolve(label);
      if (id === undefined || !state) return `现在没有标签 ${label}`;
      out.near = label.toUpperCase();
      out.nearId = id;
    }
  }
  return out;
}

/** 「离 Phant 最近的空台面（两边都够得着）」这样的称呼。 */
export function findText(f: Find, ctx: RenderCtx): string {
  const near = f.near === 'partner' ? `离${ctx.partner}最近的` : f.near ? `离 ${f.near} 最近的` : '最近的';
  return `${near}${whatText(f)}${f.shared ? '（两边都够得着）' : ''}`;
}

/** 条件里的说法：「我够得着的切好的鱼」，不带「最近的」。 */
export function findCondText(f: Find): string {
  return `我够得着的${whatText(f)}${f.shared ? '（两边都够得着）' : ''}`;
}

function cellOf(id: number, state: GameState): [number, number] | undefined {
  const st = state.stations.find(s => s.id === id);
  if (st) return st.cell;
  for (const s of state.stations) if (s.item?.id === id) return s.cell;
  for (const c of state.chefs) if (c.id === id || c.held?.id === id) return c.cell;
  return state.loose.find(i => i.id === id)?.cell;
}

/** 内部名（可带 `:加工态`）是不是 of 说的那种食材；of 可以带「切好的」「熟」这类前缀。 */
function isIngredient(raw: string, of: string): boolean {
  const base = ingredientName(raw.split(':')[0]);
  return of === base || of.endsWith(base);
}

function matches(f: Find, st: Station): boolean {
  const item = st.item;
  switch (f.find) {
    case 'empty_counter':
      return st.kind === 'counter' && !item && !st.onFire;
    case 'empty_board':
      return st.kind === 'board' && !item && !st.onFire;
    case 'clean_plate':
      return item?.kind === 'plate' && !item.dirty && (item.stack !== undefined ? item.stack > 0 : !item.contents?.length);
    case 'cooked':
      return !!item && (item.cook === 'done' || item.cook === 'overdone') && !!item.contents?.length && (!f.of || item.contents.some(p => isIngredient(p, f.of!)));
    case 'empty_pot':
      return st.kind === 'stove' && (item?.kind === 'pot' || item?.kind === 'pan') && !item.contents?.length && !st.onFire;
    case 'chopped':
      return item?.kind === 'ingredient' && item.chop !== undefined && item.chop >= 1 && (!f.of || isIngredient(item.name, f.of));
  }
}

/** 此刻我够得着的、符合 find 的站点（shared 时两边都要够得着），离 origin 由近到远。 */
function candidates(f: Find, state: GameState, origin: [number, number]): Station[] {
  const mine = sideOf(state, chefOf(state, 'bot'));
  const theirs = sideOf(state, chefOf(state, 'partner'));
  return state.stations
    .filter(st => matches(f, st) && cellReachable(state, st.cell, mine) && (!f.shared || cellReachable(state, st.cell, theirs)))
    .map(st => ({ st, d: Math.abs(st.cell[0] - origin[0]) + Math.abs(st.cell[1] - origin[1]) }))
    .sort((a, b) => a.d - b.d || a.st.id - b.st.id)
    .map(x => x.st);
}

/** oc2_arm 的 find 条件：现在有没有这样的站点。 */
export function findExists(f: Find, state: GameState): boolean {
  const me = chefOf(state, 'bot');
  return !!me && candidates(f, state, me.cell).length > 0;
}

/** 按此刻的厨房给 find 挑一个站点：只挑我够得着的（shared 时两边都要够得着），取离起点最近的。 */
export function resolveFind(f: Find, state: GameState | null, ctx: RenderCtx): { id: number } | { why: string } {
  const what = findText(f, ctx);
  if (!state) return { why: `没有游戏状态，挑不了${what}` };
  const me = chefOf(state, 'bot');
  const partner = chefOf(state, 'partner');
  const origin = f.near === 'partner' ? partner?.cell : f.nearId !== undefined ? cellOf(f.nearId, state) : me?.cell;
  if (!origin) return { why: f.near ? `${f.near === 'partner' ? ctx.partner : f.near} 现在不在场上，挑不了${what}` : `我现在没有厨师，挑不了${what}` };
  const found = candidates(f, state, origin);
  if (!found.length) return { why: `现在没有${findCondText(f)}` };
  return { id: found[0].id };
}

/** 推演手里的东西：empty 空着；held 拿着 what（kind 是物品类别，不知道时为 undefined）；unknown 推不出来。 */
type Hand = { s: 'empty' } | { s: 'held'; what: string; kind?: string } | { s: 'unknown' };

/** take 之后手里是什么：目标站点上的物品、食材箱发的食材，或 find 挑出来的那类。 */
function takenThing(step: ParsedStep, state: GameState | null, ctx: RenderCtx): { what: string; kind?: string } {
  if (step.find) {
    const kind = step.find.find === 'clean_plate' ? 'plate' : step.find.find === 'chopped' ? 'ingredient' : step.find.find === 'cooked' || step.find.find === 'empty_pot' ? 'pot' : undefined;
    return { what: `从${findText(step.find, ctx)}拿起的东西`, kind };
  }
  const st = state?.stations.find(s => s.id === step.id);
  if (st?.item) return { what: itemText(st.item, ctx), kind: st.item.kind };
  if (st?.kind === 'crate') return { what: st.gives ? ingredientName(st.gives) : '食材', kind: 'ingredient' };
  if (st && (st.kind === 'drying' || st.kind === 'return')) return { what: '盘子', kind: 'plate' };
  const on = state?.stations.find(s => s.item?.id === step.id)?.item ?? state?.loose.find(i => i.id === step.id);
  if (on) return { what: itemText(on, ctx), kind: on.kind };
  return { what: nameOf(step.id, state, ctx) };
}

/**
 * put 的目标是不是炉灶或另一只盘子、锅：拿着盘子对它放，游戏在两边的 PlacementContainer 之间倒内容
 * （从锅里盛出来，或者手里盘子里的倒进对面的盘子），手里的盘子不动；炉灶上没锅时放不上。
 */
function aimsAtContainer(step: ParsedStep, state: GameState | null): boolean {
  // 盘子堆（回盘口、沥水架）由 CleanPlateStack 处理，不算在内。
  if (step.find) return step.find.find === 'cooked' || step.find.find === 'empty_pot';
  const st = state?.stations.find(s => s.id === step.id);
  const item = st?.item;
  return st?.kind === 'stove' || (item?.kind === 'plate' && item.stack === undefined) || item?.kind === 'pot' || item?.kind === 'pan';
}

/**
 * put 的目标上此刻是不是一份食材：拿着盘子对它放，游戏走 AttachStation 的 UnderOccupant（海苔、米、
 * 切好的鱼带 IngredientToContainerBehaviour），盘子落到那个站点上、食材装进盘子，手里空了。
 */
function aimsAtIngredient(step: ParsedStep, state: GameState | null): boolean {
  if (step.find) return step.find.find === 'chopped';
  // 面包、玉米饼这类底料有自己的放置处理器，盘子对它放不走垫在下面那一路。
  const item = state?.stations.find(s => s.id === step.id)?.item;
  return item?.kind === 'ingredient' && !item.base;
}

/**
 * 按游戏规则推演一串步骤里手上的东西，找出一定会卡住的第一步（index 从 0 起）：拿、切、洗时手里还有东西（游戏里手上
 * 有东西时按键只会是放），或者放、上菜、扔时手里是空的。start 是开始时手里的东西（null 空着，
 * undefined 不知道，比如排在别的任务后面）。只认推得准的：拿起之后是拿着；拿着盘子对炉灶、盘子、锅
 * 放之后还拿着；拿着盘子对放着食材的站点放、拿着食材放、上菜、扔之后是空的；其余的放推不准，之后不再判。
 */
export function handsProblem(steps: ParsedStep[], start: Item | null | undefined, state: GameState | null, ctx: RenderCtx): { index: number; why: string } | null {
  let hand: Hand = start === undefined ? { s: 'unknown' } : start === null ? { s: 'empty' } : { s: 'held', what: `${itemText(start, ctx)}（排的这一刻就在手里）`, kind: start.kind };
  for (const [i, step] of steps.entries()) {
    const n = `第 ${i + 1} 步「${describe(step, state, ctx)}」`;
    if (step.do === 'take' && hand.s === 'held') return { index: i, why: `${n}时手里还拿着${hand.what}。手里有东西时按键只会是放：要把台面或砧板上的食材装进手里的盘子，就对那里 put（盘子会落在那里）；不然先 put 放下再拿` };
    if ((step.do === 'chop' || step.do === 'wash') && hand.s === 'held') return { index: i, why: `${n}时手里还拿着${hand.what}，切、洗都要空手，先 put 放下` };
    if ((step.do === 'put' || step.do === 'serve' || step.do === 'throw') && hand.s === 'empty') return { index: i, why: `${n}时手里是空的，先 take 拿起要放的东西` };
    switch (step.do) {
      case 'take': {
        const got = takenThing(step, state, ctx);
        hand = { s: 'held', what: `第 ${i + 1} 步拿起的${got.what}`, kind: got.kind };
        break;
      }
      case 'put':
        if (hand.s === 'held' && hand.kind === 'plate' && aimsAtContainer(step, state)) hand = { s: 'held', what: `第 ${i + 1} 步「${describe(step, state, ctx)}」之后还在手上的盘子`, kind: 'plate' };
        else if (hand.s === 'held' && hand.kind === 'plate' && aimsAtIngredient(step, state)) hand = { s: 'empty' };
        else if (hand.s === 'held' && hand.kind === 'ingredient') hand = { s: 'empty' };
        else hand = { s: 'unknown' };
        break;
      case 'serve':
      case 'throw':
        hand = { s: 'empty' };
        break;
    }
  }
  return null;
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
  const t = step.id !== undefined ? nameOf(step.id, state, ctx) : step.find ? findText(step.find, ctx) : step.target ?? '';
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
      if (step.until === undefined && step.find) return `等到有${findCondText(step.find)}`;
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
