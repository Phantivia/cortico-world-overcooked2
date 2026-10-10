import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Labels } from '../src/labels.ts';
import type { RenderCtx } from '../src/render.ts';
import type { GameState } from '../src/state.ts';
import { handsProblem, parseSteps } from '../src/steps.ts';

/** 寿司 1-3 双人回合中的一帧，从游戏里录下。 */
function fixture(): GameState {
  return JSON.parse(readFileSync(new URL('./fixtures/sushi-1-3-round.json', import.meta.url), 'utf8')) as GameState;
}

describe('hands', () => {
  const base = fixture();
  const empty = base.stations.filter(st => st.kind === 'counter' && !st.item);
  // 一个空台面上放一份海苔：拿着盘子对它放，游戏把盘子垫在海苔下面（UnderOccupant），手里空了。
  const s: GameState = { ...base, stations: base.stations.map(st => (st.id === empty[1].id ? { ...st, item: { id: 990001, kind: 'ingredient', name: 'Seaweed' } } : st)) };
  const labels = new Labels();
  labels.update(s);
  const ctx: RenderCtx = { labels, partner: 'Phant' };
  const of = (kind: string) => labels.of(s.stations.find(st => st.kind === kind)!.id)!;
  const counter = labels.of(empty[0].id)!;
  const seaweed = labels.of(empty[1].id)!;
  const check = (steps: object[]) => handsProblem(parseSteps(steps, s, ctx).steps, null, s, ctx);

  // 1010 双人局里卡住最多的写法：盛完饭盘子还在手上，接着去拿食材箱。
  it('stops a take that comes while the plate is still in hand after scooping from a stove', () => {
    const why = check([{ do: 'take', find: 'clean_plate' }, { do: 'put', target: of('stove') }, { do: 'take', target: of('crate') }]);
    expect(why).toMatch(/^第 3 步「拿 K\d .*」时手里还拿着第 2 步「放到 S\d 炉灶」之后还在手上的盘子/);
  });

  it('lets the plan through once the plate is put down, on an empty counter or under a loose ingredient', () => {
    expect(check([{ do: 'take', find: 'clean_plate' }, { do: 'put', target: of('stove') }, { do: 'put', target: counter }, { do: 'take', target: of('crate') }, { do: 'put', target: counter }])).toBeNull();
    expect(check([{ do: 'take', find: 'clean_plate' }, { do: 'put', target: of('stove') }, { do: 'put', target: seaweed }, { do: 'take', target: of('crate') }])).toBeNull();
  });
});
