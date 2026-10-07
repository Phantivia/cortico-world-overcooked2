/**
 * 厨房被台面隔开时谁够得着什么，按插件的 layout.regions 算：同一个字母的地面格互相走得通。
 * 站点或台面上的物品，旁边四格里有某个厨师那一边的地面就算他够得着。没有分区数据（插件
 * 旧版本）时一律当作够得着。
 */
import type { Chef, GameState } from './state.ts';

function regionAt(state: GameState, x: number, z: number): string | undefined {
  const L = state.layout;
  if (!L?.regions) return undefined;
  const ch = L.regions[L.maxZ - z]?.[x - L.minX];
  return ch && ch !== ' ' ? ch : undefined;
}

/** 厨师所在那一边；站在格边上时看相邻格。没有分区数据时为 undefined。 */
export function sideOf(state: GameState, chef: Chef | undefined): string | undefined {
  if (!chef || !state.layout?.regions) return undefined;
  const [x, z] = chef.cell;
  return regionAt(state, x, z) ?? [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => regionAt(state, x + dx, z + dz)).find(Boolean);
}

/** 这一格本身或旁边四格有这一边的地面。side 为 undefined 时为 true。 */
export function cellReachable(state: GameState, cell: [number, number], side: string | undefined): boolean {
  if (side === undefined) return true;
  const [x, z] = cell;
  if (regionAt(state, x, z) === side) return true;
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => regionAt(state, x + dx, z + dz) === side);
}

export function chefOf(state: GameState, role: 'bot' | 'partner'): Chef | undefined {
  return state.chefs.find(c => c.role === role);
}

/** 两个厨师各自在哪一边；不在不同的两边时 split 为 false。 */
export function sides(state: GameState): { mine?: string; theirs?: string; split: boolean } {
  const mine = sideOf(state, chefOf(state, 'bot'));
  const theirs = sideOf(state, chefOf(state, 'partner'));
  return { mine, theirs, split: mine !== undefined && theirs !== undefined && mine !== theirs };
}
