/**
 * 给站点和可移动物品起短标签（B1、P2…），bot 的工具参数和所有文字都用同一套标签。站点按地图
 * 阅读顺序（上到下、左到右）在关卡第一帧编号；物品按首次出现编号。换关卡清空。
 */
import type { GameState, Item, Station } from './state.ts';

const STATION_PREFIX: Record<string, string> = {
  counter: 'C',
  board: 'B',
  stove: 'S',
  crate: 'K',
  pass: 'D',
  sink: 'W',
  drying: 'Y',
  return: 'R',
  bin: 'X',
  mixer: 'M',
  fryer: 'F',
  oven: 'O',
  dispenser: 'Q',
  fixture: 'Z',
  switch: 'L',
  portal: 'H',
  terminal: 'A',
  other: 'Z',
};

const ITEM_PREFIX: Record<string, string> = {
  plate: 'P',
  pot: 'G',
  pan: 'N',
  basket: 'J',
  extinguisher: 'E',
  tray: 'T',
  mixingbowl: 'U',
  ingredient: 'I',
  other: 'V',
};

export class Labels {
  private level: string | undefined;
  private byId = new Map<number, string>();
  private byLabel = new Map<string, number>();
  private counters = new Map<string, number>();

  /** 每帧调用：换关卡时重编，新出现的站点和物品补标签。 */
  update(state: GameState): void {
    const level = state.phase === 'other' ? undefined : `${state.scene}|${state.level ?? ''}`;
    if (level !== this.level) {
      this.level = level;
      this.byId.clear();
      this.byLabel.clear();
      this.counters.clear();
    }
    if (!level) return;
    const fresh = state.stations.filter(s => !this.byId.has(s.id));
    fresh.sort((a, b) => b.cell[1] - a.cell[1] || a.cell[0] - b.cell[0] || a.id - b.id);
    for (const s of fresh) this.assign(s.id, STATION_PREFIX[s.kind] ?? 'Z');
    for (const item of allItems(state)) if (!this.byId.has(item.id)) this.assign(item.id, ITEM_PREFIX[item.kind] ?? 'V');
  }

  private assign(id: number, prefix: string): void {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const label = `${prefix}${n}`;
    this.byId.set(id, label);
    this.byLabel.set(label, id);
  }

  of(id: number): string | undefined {
    return this.byId.get(id);
  }

  /** 标签转对象 id；大小写不敏感。 */
  resolve(label: string): number | undefined {
    return this.byLabel.get(label.trim().toUpperCase());
  }
}

/** 状态里所有物品：台面上的、手里的、地上的，以及盘锅里嵌套的不单列。 */
export function allItems(state: GameState): Item[] {
  const items: Item[] = [];
  for (const s of state.stations) if (s.item) items.push(s.item);
  for (const c of state.chefs) if (c.held) items.push(c.held);
  items.push(...state.loose);
  return items;
}

/** 物品现在在哪：站点、厨师手里或地上。 */
export type Place = { station: Station } | { chef: number } | { cell: [number, number] };

export function locate(state: GameState, itemId: number): Place | undefined {
  for (const s of state.stations) if (s.item?.id === itemId) return { station: s };
  for (const c of state.chefs) if (c.held?.id === itemId) return { chef: c.id };
  const loose = state.loose.find(i => i.id === itemId);
  if (loose?.cell) return { cell: loose.cell };
  return undefined;
}
