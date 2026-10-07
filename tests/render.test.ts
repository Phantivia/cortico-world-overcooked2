import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Labels } from '../src/labels.ts';
import { itemText, mapText, segments, stationText, type RenderCtx } from '../src/render.ts';
import type { GameState } from '../src/state.ts';

/** 寿司 1-3 双人回合中的一帧，从游戏里录下。 */
function fixture(): GameState {
  return JSON.parse(readFileSync(new URL('./fixtures/sushi-1-3-round.json', import.meta.url), 'utf8')) as GameState;
}

function ctxFor(s: GameState): RenderCtx {
  const labels = new Labels();
  labels.update(s);
  return { labels, partner: 'Phant' };
}

describe('labels', () => {
  it('numbers each kind of station in map reading order, top row first', () => {
    const s = fixture();
    const ctx = ctxFor(s);
    const boards = s.stations.filter(st => st.kind === 'board').sort((a, b) => b.cell[1] - a.cell[1] || a.cell[0] - b.cell[0]);
    expect(boards.map(b => ctx.labels.of(b.id))).toEqual(['B1', 'B2', 'B3']);
  });

  it('keeps labels while the level stays and renumbers on a new level', () => {
    const s = fixture();
    const labels = new Labels();
    labels.update(s);
    const pass = s.stations.find(st => st.kind === 'pass')!;
    const before = labels.of(pass.id);
    labels.update({ ...s, stations: [...s.stations].reverse() });
    expect(labels.of(pass.id)).toBe(before);
    labels.update({ ...s, level: 'Sushi_1_4_2P', stations: [] });
    expect(labels.of(pass.id)).toBeUndefined();
  });
});

describe('scene text', () => {
  it('writes chefs, labelled stations and the map from the same frame', () => {
    const s = fixture();
    const ctx = ctxFor(s);
    const map = mapText(s, ctx);
    const pass = s.stations.find(st => st.kind === 'pass')!;
    const row = map.split('\n').find(line => line.startsWith(String(pass.cell[1]).padEnd(3)))!;
    const column = 3 + (pass.cell[0] - s.layout!.minX) * 3;
    expect(row.slice(column, column + 3).trim()).toBe(ctx.labels.of(pass.id));
    expect(map).toContain('我');
    const texts = segments(s, ctx, { trail: [], queue: '空' }).map(g => g.text);
    expect(texts.some(t => t.startsWith('Phant在 (-2,0)'))).toBe(true);
  });

  it('marks unchopped ingredients and plate contents', () => {
    const s = fixture();
    const ctx = ctxFor(s);
    expect(itemText({ id: 1, kind: 'ingredient', name: 'Cucumber', chop: 0.43 }, ctx)).toBe('生黄瓜（切了 43%）');
    expect(itemText({ id: 1, kind: 'ingredient', name: 'Cucumber' }, ctx)).toBe('黄瓜');
    const plate = s.stations.find(st => st.item?.kind === 'plate')!.item!;
    expect(itemText({ ...plate, contents: ['SushiRice:done', 'Seaweed'] }, ctx)).toMatch(/^盘子P\d+\[熟米\+海苔\]$/);
  });

  it('says how long a cooked pot has before it burns', () => {
    const ctx = ctxFor(fixture());
    const pot = { id: 9, kind: 'pot', name: 'utensil_pot_01', contents: ['SushiRice'], cook: 'done' as const, cookProgress: 1.25, cookTime: 10 };
    expect(itemText(pot, ctx)).toContain('约 8 秒后糊');
  });

  it('changes only the segment of the station whose item changed', () => {
    const s = fixture();
    const ctx = ctxFor(s);
    const before = new Map(segments(s, ctx, { trail: [], queue: '空' }).map(g => [g.key, g.cmp]));
    const counter = s.stations.find(st => st.kind === 'counter' && st.item?.kind === 'ingredient')!;
    const next: GameState = { ...s, stations: s.stations.map(st => (st.id === counter.id ? { ...st, item: undefined } : st)) };
    const after = segments(next, ctx, { trail: [], queue: '空' });
    const dirty = after.filter(g => before.get(g.key) !== g.cmp);
    expect(dirty.map(g => g.key)).toEqual([`st:${counter.id}`]);
    expect(dirty[0].text).toBe('');
    expect(dirty[0].cleared).toBe(`${ctx.labels.of(counter.id)} 台面：空了`);
  });

  it('puts a fire on a station before its contents', () => {
    const s = fixture();
    const ctx = ctxFor(s);
    const stove = s.stations.find(st => st.kind === 'stove')!;
    expect(stationText({ ...stove, onFire: true }, s, ctx)).toMatch(/^S\d 炉灶（着火了！）：锅G\d（空）$/);
  });
});
