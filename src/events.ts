/**
 * 插件事件到 bot 读的文字。队友的动作记进「刚才」轨迹，随下一次场景描述送达；需要 bot 马上反应的
 * （火、糊锅、自己手里突然多了东西、回合起止）立即唤醒。bot 自己任务里的动作由执行器回执汇报，这里
 * 不重复。
 */
import type { TriggerMode } from 'cortico/core/types.ts';
import type { GameEvent, GameState } from './state.ts';
import { chefName, clock, itemText, levelName, nameOf, scoreText, stationName, type RenderCtx } from './render.ts';
import { dishName } from './names.ts';

export interface WorldEvent {
  /** 事件类型后缀：overcooked2.<kind>。 */
  kind: string;
  text: string;
  trigger: TriggerMode;
  /** 换关卡、回合开始后下一次场景描述带完整地图。 */
  anchor?: boolean;
}

export interface Translation {
  /** 队友轨迹里的一步。 */
  trail?: string;
  event?: WorldEvent;
}

function role(state: GameState | null, chefId: number | undefined): string | undefined {
  return state?.chefs.find(c => c.id === chefId)?.role;
}

/** state 是事件发生时最近一帧，用来找标签和厨师身份。 */
export function translate(e: GameEvent, state: GameState | null, ctx: RenderCtx, tips: Map<number, number>): Translation {
  const actor = role(state, e.chef);
  const name = (id: number | undefined) => nameOf(id, state, ctx);
  const item = e.item ? itemText(e.item, ctx) : '东西';
  const doer = state ? chefName(state.chefs.find(c => c.id === e.chef), ctx) : '有人';
  const partner = actor === 'partner';
  switch (e.k) {
    case 'pickup':
      return partner ? { trail: `拿起${item}${e.from ? `（${name(e.from)}）` : ''}` } : {};
    case 'place': {
      if (!partner) return {};
      if (e.to !== undefined && state?.stations.find(s => s.id === e.to)?.kind === 'pass') return {};
      if (e.result) return { trail: `把${item}放进${itemText(e.result, ctx)}（${name(e.to)}）` };
      return { trail: e.floor ? `把${item}丢在地上` : `把${item}放到 ${name(e.to)}` };
    }
    case 'transfer':
      if (!partner || !e.item) return {};
      if (!e.other) return { trail: `在 ${name(e.to)} 倒腾，手里现在是${item}` };
      // 事件只带倒腾之后的两边：手里的有东西、目标空了就是盛出来。
      return { trail: (e.item.contents?.length ?? 0) > 0 && !(e.other.contents?.length) ? `用${item}从${itemText(e.other, ctx)}盛了出来` : `把手里的东西倒进${itemText(e.other, ctx)}` };
    case 'swap': {
      return partner ? { trail: `在 ${name(e.to)} 用${item}换走了${e.took ? itemText(e.took, ctx) : '东西'}` } : {};
    }
    case 'drop':
      return partner ? { trail: `把${item}丢在地上` } : {};
    case 'throw':
      return partner ? { trail: `扔出${item}` } : {};
    case 'catch': {
      const from = e.from !== undefined ? chefName(state?.chefs.find(c => c.id === e.from), ctx) : undefined;
      if (actor === 'bot') return { event: { kind: 'catch', text: `我接住了${from ? `${from}扔来的` : ''}${item}，现在拿在手里。`, trigger: 'flush' } };
      return partner ? { trail: `接住${item}` } : {};
    }
    case 'land': {
      const where = e.result ? itemText(e.result, ctx) : name(e.to);
      const text = `${partner ? '' : `${doer}扔的`}${item}落进了${where}`;
      return partner ? { trail: `扔出的${item}落进了${where}` } : actor === 'bot' ? {} : { trail: text };
    }
    case 'chop.done':
      return partner ? { trail: `切好了${item}（${name(e.station)}）` } : {};
    case 'wash.start':
      return partner ? { trail: `开始洗盘子（${name(e.station)}）` } : {};
    case 'wash.plate':
      return partner ? { trail: '洗好 1 只盘子' } : {};
    case 'cook': {
      const where = e.station !== undefined ? `（${name(e.station)}）` : '';
      if (e.state === 'done') return { event: { kind: 'cook', text: `${item}${where}。熟了不拿走会继续加热到糊。`, trigger: 'flush' } };
      if (e.state === 'overdone') return { event: { kind: 'cook', text: `${item}${where}，再不拿走就糊了！`, trigger: 'flush' } };
      if (e.state === 'burnt') return { event: { kind: 'cook', text: `${item}${where}，可能起火；糊的东西只能倒进垃圾桶。`, trigger: 'flush' } };
      return {};
    }
    case 'fire': {
      const ext = state ? extinguisherWhere(state, ctx) : '';
      return { event: { kind: 'fire', text: `${name(e.station)} 着火了！${ext}`, trigger: 'flush' } };
    }
    case 'fire.out':
      return { event: { kind: 'fire', text: `${name(e.station)} 的火灭了。`, trigger: 'piggyback' } };
    case 'order.new':
      return {};
    case 'order.expire':
      return typeof e.order === 'object' ? { event: { kind: 'order', text: `订单 ${dishName(e.order.dish)} 超时了，扣了分，这单重新计时。`, trigger: 'piggyback' } } : {};
    case 'tip':
      if (e.order !== undefined && typeof e.tip === 'number') tips.set(Number(e.order), e.tip);
      return {};
    case 'deliver': {
      const orderId = typeof e.order === 'number' ? e.order : undefined;
      const tip = orderId !== undefined ? tips.get(orderId) : undefined;
      if (orderId !== undefined) tips.delete(orderId);
      const by = e.chef !== undefined ? doer : '有人';
      if (e.ok) {
        return { event: { kind: 'deliver', text: `${by}上菜：${e.dish ? dishName(e.dish) : '一道菜'}${tip ? `，小费 ${tip}` : ''}。`, trigger: 'piggyback' } };
      }
      return { event: { kind: 'deliver', text: `${by}上菜失败：盘里的东西不符合任何订单。`, trigger: actor === 'bot' ? 'piggyback' : 'debounce' } };
    }
    case 'fell':
      if (actor === 'bot') return { event: { kind: 'fell', text: '我掉出场外了，手里的东西丢了，几秒后在场边重生。', trigger: 'flush' } };
      return partner ? { trail: '掉出场外了' } : {};
    case 'lost':
      return { event: { kind: 'lost', text: `${item}掉出场外没了。`, trigger: 'piggyback' } };
    case 'level':
      return { event: { kind: 'level', text: `进入关卡 ${levelName(e.level)}。`, trigger: 'flush', anchor: true } };
    case 'round.start':
      return { event: { kind: 'round', text: `回合开始，限时 ${clock(e.timeLeft ?? 0)}。`, trigger: 'flush', anchor: true } };
    case 'round.end':
      return { event: { kind: 'round', text: `回合结束。${state ? scoreText(state) : ''}`, trigger: 'flush' } };
    case 'level.exit':
      return { event: { kind: 'level', text: '离开了厨房。', trigger: 'piggyback' } };
    default:
      return {};
  }
}

export function extinguisherWhere(state: GameState, ctx: RenderCtx): string {
  for (const st of state.stations) if (st.item?.kind === 'extinguisher') return `灭火器在 ${stationName(st, ctx)} 上。`;
  for (const c of state.chefs) if (c.held?.kind === 'extinguisher') return `灭火器在${chefName(c, ctx)}手里。`;
  const loose = state.loose.find(i => i.kind === 'extinguisher');
  if (loose?.cell) return `灭火器在地上 (${loose.cell[0]},${loose.cell[1]})。`;
  return '';
}

/** 火会烧到相邻格，没灭干净的会把灭掉的邻格重新点着；列出此刻全部在烧的。 */
export function burningNow(state: GameState, ctx: RenderCtx): string {
  const burning = state.stations.filter(st => st.onFire).map(st => ctx.labels.of(st.id) ?? '?');
  return burning.length > 1 ? `现在一共在烧：${burning.join('、')}。` : '';
}

/** 连续的同类轨迹合并（洗好 1 只盘子 ×3 → 洗好 3 只盘子），最多保留最近 n 条。 */
export function pushTrail(trail: string[], entry: string, max = 10): void {
  const last = trail[trail.length - 1];
  const washed = /^洗好 (\d+) 只盘子$/;
  if (last && washed.test(last) && washed.test(entry)) {
    trail[trail.length - 1] = `洗好 ${Number(washed.exec(last)![1]) + Number(washed.exec(entry)![1])} 只盘子`;
    return;
  }
  trail.push(entry);
  if (trail.length > max) trail.splice(0, trail.length - max + 1, '…');
}
