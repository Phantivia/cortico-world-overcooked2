import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pushTrail, translate } from '../src/events.ts';
import { Labels } from '../src/labels.ts';
import type { GameEvent, GameState } from '../src/state.ts';

const state = JSON.parse(readFileSync(new URL('./fixtures/sushi-1-3-round.json', import.meta.url), 'utf8')) as GameState;
/** 同一关里录下的事件：bot 递黄瓜、队友切好、bot 煮米盛饭、队友加料上菜。 */
const events = readFileSync(new URL('./fixtures/events-sushi-1-3.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map(l => JSON.parse(l) as GameEvent);
const labels = new Labels();
labels.update(state);
const ctx = { labels, partner: 'Phant' };
const bot = state.chefs.find(c => c.role === 'bot')!.id;
const partner = state.chefs.find(c => c.role === 'partner')!.id;

describe('translate', () => {
  it("puts the partner's actions in the trail and leaves the bot's own actions to task reports", () => {
    const tips = new Map<number, number>();
    const trail: string[] = [];
    for (const e of events.filter(e => e.k !== 'deliver' && e.k !== 'tip' && e.k !== 'cook')) {
      const t = translate(e, state, ctx, tips);
      if (e.chef === bot) expect(t).toEqual({});
      if (t.trail) trail.push(t.trail);
    }
    expect(trail).toContain('切好了黄瓜（B3 砧板）');
    // 放上出餐口不进轨迹：上菜由 deliver 事件说。
    expect(trail.some(t => t.includes('出餐口'))).toBe(false);
    expect(events.some(e => e.chef === partner && e.k === 'place')).toBe(true);
  });

  it('names who delivered and merges the tip that arrives just before', () => {
    const tips = new Map<number, number>();
    const tip = events.find(e => e.k === 'tip')!;
    const deliver = events.find(e => e.k === 'deliver')!;
    expect(translate(tip, state, ctx, tips)).toEqual({});
    const t = translate(deliver, state, ctx, tips);
    expect(t.event?.text).toBe(`Phant上菜：黄瓜寿司，小费 ${tip.tip}。`);
    expect(t.event?.trigger).toBe('piggyback');
  });

  it('wakes the bot when a pot is done', () => {
    const cook = events.find(e => e.k === 'cook' && e.state === 'done')!;
    const t = translate(cook, state, ctx, new Map());
    expect(t.event?.trigger).toBe('flush');
    expect(t.event?.text).toMatch(/^锅G\d\[米\] 煮好了.*（S\d 炉灶）/);
  });

  it('wakes the bot when something lands in its own hands', () => {
    const e: GameEvent = { k: 'catch', frame: 1, chef: bot, from: partner, item: { id: 5, kind: 'ingredient', name: 'SushiPrawn', chop: 0 } };
    const t = translate(e, state, ctx, new Map());
    expect(t.event).toEqual({ kind: 'catch', text: '我接住了Phant扔来的生虾，现在拿在手里。', trigger: 'flush' });
  });
});

describe('pushTrail', () => {
  it('folds consecutive washed plates and keeps the latest entries', () => {
    const trail: string[] = [];
    pushTrail(trail, '洗好 1 只盘子');
    pushTrail(trail, '洗好 1 只盘子');
    expect(trail).toEqual(['洗好 2 只盘子']);
    for (let i = 0; i < 12; i++) pushTrail(trail, `第 ${i} 步`, 5);
    expect(trail).toHaveLength(5);
    expect(trail[0]).toBe('…');
    expect(trail.at(-1)).toBe('第 11 步');
  });
});
