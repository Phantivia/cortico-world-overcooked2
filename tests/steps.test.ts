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
  const s = fixture();
  const labels = new Labels();
  labels.update(s);
  const ctx: RenderCtx = { labels, partner: 'Phant' };
  const of = (kind: string) => labels.of(s.stations.find(st => st.kind === kind)!.id)!;
  const counter = labels.of(s.stations.find(st => st.kind === 'counter' && !st.item)!.id)!;
  const check = (steps: object[]) => handsProblem(parseSteps(steps, s, ctx).steps, null, s, ctx);

  // 1010 双人局里卡住最多的写法：盛完饭盘子还在手上，接着去拿食材箱。
  it('stops a take that comes while the plate is still in hand after scooping from a stove', () => {
    const why = check([{ do: 'take', find: 'clean_plate' }, { do: 'put', target: of('stove') }, { do: 'take', target: of('crate') }]);
    expect(why).toMatch(/^第 3 步「拿 K\d .*」时手里还拿着第 2 步对炉灶放完还在手上的盘子/);
  });

  it('lets the same plan through once the plate is put down first', () => {
    expect(check([{ do: 'take', find: 'clean_plate' }, { do: 'put', target: of('stove') }, { do: 'put', target: counter }, { do: 'take', target: of('crate') }, { do: 'put', target: counter }])).toBeNull();
  });
});
