/**
 * 状态到文字。所有文字以 bot 第一人称（我）叙述，队友用配置的称呼；对象一律带标签（B1、P2…），
 * 同一对象在场景描述、事件、回执里写法一致。
 */
import type { Chef, GameState, Item, Order, Station } from './state.ts';
import type { Labels } from './labels.ts';
import { dishName, ingredientName, itemKindName, stationKindName } from './names.ts';

export interface RenderCtx {
  labels: Labels;
  partner: string;
}

function pct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 100)));
}

function contentsText(parts: string[]): string {
  return parts.map(ingredientName).join('+');
}

function heatWord(kind: string): string {
  return kind === 'pan' ? '煎' : kind === 'basket' ? '炸' : kind === 'mixingbowl' ? '搅' : '煮';
}

function cookText(item: Item): string {
  switch (item.cook) {
    case 'cooking':
      return `${heatWord(item.kind)}着 ${pct(item.cookProgress ?? 0)}%`;
    case 'done':
      return `${heatWord(item.kind)}好了${burnIn(item)}`;
    case 'overdone':
      return `快糊了${burnIn(item)}`;
    case 'burnt':
      return '糊了';
    default:
      return '';
  }
}

/** 熟了之后离糊还有几秒（糊在加热进度 2）。 */
function burnIn(item: Item): string {
  if (item.cookTime === undefined || item.cookProgress === undefined) return '';
  const sec = Math.max(0, Math.round((2 - item.cookProgress) * item.cookTime));
  return `，约 ${sec} 秒后糊`;
}

export function itemText(item: Item, ctx: RenderCtx): string {
  const label = ctx.labels.of(item.id) ?? '';
  switch (item.kind) {
    case 'ingredient': {
      const name = ingredientName(item.name);
      if (item.chop !== undefined && item.chop < 1) return item.chop > 0 ? `生${name}（切了 ${pct(item.chop)}%）` : `生${name}`;
      const cooked = cookText(item);
      const on = item.contents?.length ? `[${contentsText(item.contents)}]` : '';
      return cooked ? `${name}${on}（${cooked}）` : `${name}${on}`;
    }
    case 'plate': {
      if (item.stack !== undefined) return `${item.dirty ? '脏' : '干净'}盘子×${item.stack}`;
      const inside = item.contents?.length ? `[${contentsText(item.contents)}]` : '（空）';
      return `${item.dirty ? '脏' : ''}盘子${label}${inside}`;
    }
    case 'pot':
    case 'pan':
    case 'basket':
    case 'mixingbowl':
    case 'tray': {
      const parts = (item.contents ?? []).map(p => ingredientName(p.split(':')[0]));
      if (!parts.length) return `${itemKindName(item.kind)}${label}（空）`;
      const state = cookText(item);
      return `${itemKindName(item.kind)}${label}[${parts.join('+')}]${state ? ` ${state}` : ''}`;
    }
    case 'extinguisher':
      return `灭火器${label}`;
    default:
      return label ? `${item.name}${label}` : item.name;
  }
}

/** 站点的称呼：标签加类别；食材箱写成「K2 虾箱」。 */
export function stationName(st: Station, ctx: RenderCtx): string {
  const label = ctx.labels.of(st.id) ?? '?';
  if (st.kind === 'crate') return `${label} ${st.gives ? ingredientName(st.gives) : '食材'}箱`;
  return `${label} ${stationKindName(st.kind)}`;
}

/** 任何对象 id 的称呼：站点、物品或厨师。 */
export function nameOf(id: number | undefined, state: GameState | null, ctx: RenderCtx): string {
  if (id === undefined || !state) return '?';
  const st = state.stations.find(s => s.id === id);
  if (st) return stationName(st, ctx);
  const chef = state.chefs.find(c => c.id === id);
  if (chef) return chefName(chef, ctx);
  return ctx.labels.of(id) ?? '?';
}

export function chefName(chef: Chef | undefined, ctx: RenderCtx): string {
  if (!chef) return '有人';
  return chef.role === 'bot' ? '我' : chef.role === 'partner' ? ctx.partner : chef.name;
}

function who(state: GameState, chefId: number | undefined, ctx: RenderCtx): string {
  return chefName(state.chefs.find(c => c.id === chefId), ctx);
}

export function stationText(st: Station, state: GameState, ctx: RenderCtx): string {
  const parts: string[] = [];
  if (st.kind === 'sink') {
    parts.push(st.plates ? `脏盘子 ${st.plates} 只` : '空');
    const washer = state.chefs.find(c => c.using === st.id);
    if (washer && st.plates) parts.push(`${chefName(washer, ctx)}在洗（这只 ${pct(st.progress ?? 0)}%）`);
  } else if (st.item) {
    parts.push(itemText(st.item, ctx));
    const user = state.chefs.find(c => c.using === st.id);
    if (user && st.kind === 'board') parts.push(`${chefName(user, ctx)}在切`);
  } else if (st.kind !== 'crate' && st.kind !== 'pass' && st.kind !== 'bin' && st.kind !== 'fixture') {
    parts.push('空');
  }
  if (st.kind === 'stove' && st.item && st.active === false && st.item.contents?.length) parts.push('没在加热');
  const fire = st.onFire ? '（着火了！）' : '';
  return `${stationName(st, ctx)}${fire}${parts.length ? `：${parts.join('，')}` : ''}`;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `Sushi_1_3_2P` → 寿司 1-3。 */
export function levelName(level: string | undefined): string {
  if (!level) return '未知关卡';
  const m = /^([A-Za-z]+)_(\d+)_(\d+)/.exec(level);
  if (!m) return level;
  return `${dishName(m[1])} ${m[2]}-${m[3]}`;
}

export function scoreText(state: GameState): string {
  const s = state.score;
  if (!s) return '';
  return `得分 ${s.total}（出餐 ${s.deliveries}，上错 ${s.failed}，超时 ${s.expired} 次）`;
}

export function orderText(o: Order): string {
  return `${dishName(o.dish)}[${contentsText(o.parts)}] 剩 ${Math.max(0, Math.ceil(o.remaining))} 秒`;
}

export function chefText(chef: Chef, state: GameState, ctx: RenderCtx): string {
  const name = chefName(chef, ctx);
  if (chef.respawnIn) return `${name}掉下去了，在等重生`;
  const hand = chef.held ? `手里拿着${itemText(chef.held, ctx)}` : '手里空着';
  const using = chef.using !== undefined ? `，正在用 ${nameOf(chef.using, state, ctx)}` : '';
  return `${name}在 (${chef.cell[0]},${chef.cell[1]})，${hand}${using}`;
}

/**
 * 俯视地图：每格 3 个字符，行从上（z 大）到下，列标 x、行标 z。站点写标签，`#` 是墙和装饰台，
 * `.` 是能走的地面，`< > ^ v` 是传送带和它带人走的方向。厨师写在所站的格上。
 */
export function mapText(state: GameState, ctx: RenderCtx): string {
  const L = state.layout;
  if (!L) return '';
  const at = new Map<string, string>();
  for (const st of state.stations) {
    const label = ctx.labels.of(st.id);
    if (label) at.set(`${st.cell[0]},${st.cell[1]}`, label);
  }
  for (const c of state.chefs) {
    const mark = c.role === 'bot' ? '我' : c.role === 'partner' ? ctx.partner.slice(0, 1) : '人';
    at.set(`${c.cell[0]},${c.cell[1]}`, mark);
  }
  const cell = (s: string) => {
    const width = [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    return s + ' '.repeat(Math.max(0, 3 - width));
  };
  const lines: string[] = [];
  let header = '   ';
  for (let x = L.minX; x <= L.maxX; x++) header += cell(String(x));
  lines.push(header.trimEnd());
  L.rows.forEach((row, i) => {
    const z = L.maxZ - i;
    let line = cell(String(z));
    for (let x = L.minX; x <= L.maxX; x++) {
      const mark = at.get(`${x},${z}`);
      const ch = row[x - L.minX];
      line += cell(mark ?? (ch === undefined || ch === ' ' ? '' : ch));
    }
    lines.push(line.trimEnd());
  });
  return lines.join('\n');
}

export interface Segment {
  key: string;
  text: string;
  /** 比较键：只有它变了这一段才重发。 */
  cmp: string;
  /** 这一段变空（text 为空）时改说的话。 */
  cleared?: string;
}

export interface SnapshotInput {
  /** 队友自上次场景描述以来做的事。 */
  trail: string[];
  /** 任务队列一句话。 */
  queue: string;
}

/** 场景描述的全部分段；调用方按比较键挑出变化的段。 */
export function segments(state: GameState, ctx: RenderCtx, input: SnapshotInput): Segment[] {
  const segs: Segment[] = [];
  const paused = state.paused ? '（游戏暂停中）' : '';
  if (state.phase === 'other') {
    const join = state.joined ? '我已作为本地玩家加入' : '我还没作为本地玩家加入（要在主菜单加入）';
    segs.push({ key: 'round', text: `不在厨房里（菜单、大地图或加载中）。${join}。`, cmp: `other|${state.joined}` });
    return segs;
  }
  const level = levelName(state.level);
  const left = state.timeLeft !== undefined ? clock(state.timeLeft) : '?';
  const phaseText =
    state.phase === 'round' ? `回合中，剩 ${left}` : state.phase === 'over' ? '回合已结束' : '回合还没开始';
  segs.push({
    key: 'round',
    text: `${level}：${phaseText}${paused}；${scoreText(state)}`,
    cmp: [state.phase, state.level, state.paused, state.score?.total, state.score?.deliveries, state.score?.failed, state.score?.expired, Math.ceil((state.timeLeft ?? 0) / 30)].join('|'),
  });
  segs.push({
    key: 'orders',
    text: state.orders.length ? `订单：${state.orders.map((o, i) => `${i + 1}. ${orderText(o)}`).join('；')}` : '订单：没有',
    cmp: state.orders.map(o => `${o.id}:${Math.ceil(o.remaining / 20)}`).join(','),
  });
  const me = state.chefs.find(c => c.role === 'bot');
  if (me) segs.push({ key: 'me', text: chefText(me, state, ctx), cmp: `${me.cell}|${me.held ? itemText(me.held, ctx) : ''}|${me.using}|${me.respawnIn ? 1 : 0}` });
  else segs.push({ key: 'me', text: state.joined ? '我在这关没有厨师' : '我没有加入这一局（只有队友在玩）', cmp: `none|${state.joined}` });
  for (const p of state.chefs.filter(c => c.role !== 'bot')) {
    const trail = p.role === 'partner' && input.trail.length ? `。刚才：${input.trail.join(' → ')}` : '';
    segs.push({ key: `chef:${p.id}`, text: chefText(p, state, ctx) + trail, cmp: `${p.cell}|${p.held ? itemText(p.held, ctx) : ''}|${p.using}|${trail}` });
  }
  for (const st of state.stations) {
    const text = stationText(st, state, ctx);
    const boring = (st.kind === 'counter' || st.kind === 'fixture') && !st.item && !st.onFire;
    segs.push({ key: `st:${st.id}`, text: boring ? '' : text, cmp: boring ? '' : text, cleared: `${stationName(st, ctx)}：空了` });
  }
  for (const item of state.loose) {
    // 食材的称呼不带标签（台面上的靠站点标签拿）；地上的只能按物品标签拿，补上。
    const label = item.kind === 'ingredient' ? ctx.labels.of(item.id) : undefined;
    const what = `${label ? `${label} ` : ''}${itemText(item, ctx)}`;
    segs.push({ key: `loose:${item.id}`, text: `地上 (${item.cell?.[0]},${item.cell?.[1]})：${what}${item.flying ? '（飞行中）' : ''}`, cmp: `${item.cell}|${what}` });
  }
  segs.push({ key: 'queue', text: `[队列] ${input.queue}`, cmp: input.queue });
  return segs;
}
