import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OVERCOOKED2_DEFAULTS } from '../src/config.ts';
import { Labels } from '../src/labels.ts';
import type { GameState } from '../src/state.ts';
import { Overcooked2World } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const fixture = (): GameState => JSON.parse(readFileSync(new URL('./fixtures/sushi-1-3-round.json', import.meta.url), 'utf8')) as GameState;

/** 插件替身：真实 TCP 端口，按 docs/protocol.md 的帧格式收发。 */
class FakePlugin {
  server!: Server;
  socket: Socket | null = null;
  requests: Array<Record<string, unknown>> = [];
  onRequest: (r: Record<string, unknown>) => Record<string, unknown> | null = () => ({ ok: true });

  async listen(): Promise<number> {
    this.server = createServer(socket => {
      this.socket = socket;
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (d: string) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const r = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
          buf = buf.slice(i + 1);
          this.requests.push(r);
          const reply = this.onRequest(r);
          if (reply) this.send({ t: 'reply', id: r.id, ...reply });
        }
      });
      this.send({ t: 'hello', protocol: 1, version: 'test' });
    });
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    return (this.server.address() as AddressInfo).port;
  }

  send(frame: Record<string, unknown>): void {
    this.socket?.write(`${JSON.stringify(frame)}\n`);
  }

  close(): void {
    this.socket?.destroy();
    this.server.close();
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function setup() {
  const plugin = new FakePlugin();
  const port = await plugin.listen();
  const host = new FakeHost();
  const world = new Overcooked2World({ cfg: { ...OVERCOOKED2_DEFAULTS, enabled: true, port, partnerName: 'Phant', idleNudgeSec: 0 }, timezone: 'Asia/Shanghai' });
  await world.start(host);
  cleanup.push(() => world.stop(), () => plugin.close());
  await until(() => host.events.some(e => e.type === 'overcooked2.connection'));
  const state = fixture();
  plugin.send({ t: 'state', ...state });
  await until(() => host.deferred.length > 0);
  const labels = new Labels();
  labels.update(state);
  return { plugin, host, world, state, labels };
}

const tool = (world: Overcooked2World, name: string) => world.tools().find(t => t.name === name)!;

describe('Overcooked2World', () => {
  // 操作员 1010 定:一定会卡的那步之前照常排,只丢后面的,回执里说明。
  it('queues the steps before one that must fail on what the hands hold, and says where it stopped', async () => {
    const { plugin, host, world, state, labels } = await setup();
    const crates = state.stations.filter(s => s.kind === 'crate');
    plugin.onRequest = r => (r.op === 'act' ? { ok: true, item: { id: 77, kind: 'ingredient', name: 'Cucumber', chop: 0 } } : { ok: true });
    const receipt = await tool(world, 'oc2_do').handler({ steps: [{ do: 'take', target: labels.of(crates[0].id) }, { do: 'take', target: labels.of(crates[1].id) }] }, { role: 'main', log: host.log });
    expect(typeof receipt === 'string' ? receipt : receipt.text).toMatch(/^\[执行器\] 任务#1 收下了：拿 K\d [^→]*。\n只排了前 1 步，第 2 步起没排：第 2 步「拿 K\d [^」]*」时手里还拿着第 1 步拿起的/);
    await until(() => host.events.some(e => e.type === 'overcooked2.task'));
    expect(plugin.requests.filter(r => r.op === 'act').map(r => r.step)).toEqual([{ do: 'take', target: crates[0].id }]);
  });

  it('sends labelled steps to the plugin as object ids and reports the finished task with a wake', async () => {
    const { plugin, host, world, state, labels } = await setup();
    const crate = state.stations.find(s => s.kind === 'crate' && s.gives === 'Cucumber')!;
    const counter = state.stations.find(s => s.kind === 'counter' && s.cell[0] === 0 && s.cell[1] === -1)!;
    plugin.onRequest = r => {
      const step = r.step as { do: string; target: number } | undefined;
      if (step?.do === 'take') return { ok: true, item: { id: 77, kind: 'ingredient', name: 'Cucumber', chop: 0 } };
      if (step?.do === 'put') return { ok: true, item: { id: 77, kind: 'ingredient', name: 'Cucumber', chop: 0 } };
      return { ok: true };
    };
    const receipt = await tool(world, 'oc2_do').handler({ steps: [{ do: 'take', target: labels.of(crate.id) }, { do: 'put', target: labels.of(counter.id)!.toLowerCase() }] }, { role: 'main', log: host.log });
    expect(typeof receipt === 'string' ? receipt : receipt.text).toMatch(/^\[执行器\] 任务#1 收下了：拿 K\d 黄瓜箱 → 放到 C\d+ 台面。/);
    await until(() => host.events.some(e => e.type === 'overcooked2.task'));
    const acts = plugin.requests.filter(r => r.op === 'act').map(r => r.step);
    expect(acts).toEqual([{ do: 'take', target: crate.id }, { do: 'put', target: counter.id }]);
    const i = host.events.findIndex(e => e.type === 'overcooked2.task');
    expect(host.events[i].text).toMatch(/任务#1 完成（[\d.]+s）：拿到生黄瓜；把生黄瓜放到 C\d+ 台面。\n\[队列\] 空$/);
    expect(host.pushOpts[i]?.trigger).toBe('flush');
  });

  it('refuses the whole task when a label does not exist, and queues nothing', async () => {
    const { plugin, host, world } = await setup();
    const out = await tool(world, 'oc2_do').handler({ steps: [{ do: 'take', target: 'K1' }, { do: 'put', target: 'Q9' }] }, { role: 'main', log: host.log });
    expect(out).toEqual({ text: '没有排入：第 2 步：现在没有标签 Q9', failed: true });
    expect(plugin.requests.some(r => r.op === 'act')).toBe(false);
  });

  it('renders the scene when read: in full first, then only what changed, nothing when nothing changed', async () => {
    const { plugin, host, state } = await setup();
    const first = await host.deferred[0].render();
    expect(String(first)).toContain('完整现状');
    expect(String(first)).toContain('地图（x 向右，z 向上');
    plugin.send({ t: 'state', ...state });
    await until(() => host.deferred.length > 1);
    expect(await host.deferred[1].render()).toBeNull();
    const counter = state.stations.find(s => s.kind === 'counter' && s.item?.kind === 'ingredient')!;
    plugin.send({ t: 'state', ...state, stations: state.stations.map(s => (s.id === counter.id ? { ...s, item: undefined } : s)) });
    await until(() => host.deferred.length > 2);
    expect(await host.deferred[2].render()).toMatch(/^\[厨房\] C\d+ 台面：空了$/);
  });

  it("carries the partner's actions into the next scene text", async () => {
    const { plugin, host, state } = await setup();
    await host.deferred[0].render();
    const partner = state.chefs.find(c => c.role === 'partner')!;
    const crate = state.stations.find(s => s.kind === 'crate' && s.gives === 'SushiPrawn')!;
    const held = { ...partner, held: { id: 88, kind: 'ingredient', name: 'SushiPrawn', chop: 0 } };
    plugin.send({ t: 'ev', k: 'pickup', frame: 1, chef: partner.id, item: held.held, from: crate.id });
    plugin.send({ t: 'state', ...state, chefs: state.chefs.map(c => (c.id === partner.id ? held : c)) });
    await until(() => host.deferred.length > 1);
    const text = String(await host.deferred[1].render());
    expect(text).toMatch(/Phant在 \(-2,0\)，手里拿着生虾。刚才：拿起生虾（K\d 虾箱）/);
  });

  it('says, when a task is queued, what each target holds now and which ones only the partner can reach', async () => {
    const { plugin, host, world, state, labels } = await setup();
    await host.deferred[0].render();
    plugin.send({ t: 'state', ...splitAtX0(state) });
    await until(() => host.deferred.length > 1);
    const crate = state.stations.find(s => s.kind === 'crate' && s.cell[0] < 0)!;
    const counter = state.stations.find(s => s.kind === 'counter' && s.cell[0] === 0 && s.cell[1] === -1)!;
    plugin.onRequest = () => null;
    const out = await tool(world, 'oc2_do').handler({ steps: [{ do: 'take', target: labels.of(crate.id) }, { do: 'put', target: labels.of(counter.id) }] }, { role: 'main', log: host.log });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toMatch(new RegExp(`\\n\\[现在\\] 我手里空着；${labels.of(crate.id)} \\S+箱，在我走不到的那一边，Phant那边够得着；${labels.of(counter.id)} 台面：空\\n`));
  });

  it('picks a find target when the step runs, among counters both sides can reach', async () => {
    const { plugin, host, world, state } = await setup();
    await host.deferred[0].render();
    const cucumber = { id: 77, kind: 'ingredient', name: 'Cucumber', chop: 1 };
    const split = splitAtX0(state);
    plugin.send({ t: 'state', ...split, chefs: split.chefs.map(c => (c.role === 'bot' ? { ...c, held: cucumber } : c)) });
    await until(() => host.deferred.length > 1);
    plugin.onRequest = r => (r.op === 'act' ? { ok: true, item: cucumber } : { ok: true });
    await tool(world, 'oc2_do').handler({ steps: [{ do: 'put', find: 'empty_counter', shared: true, near: 'partner' }] }, { role: 'main', log: host.log });
    await until(() => host.events.some(e => e.type === 'overcooked2.task'));
    // 中间一列都是两边够得着的空台面；离队友 (-2,0) 最近的有 (0,1) 和 (0,-1)，同距离取 id 小的。
    const middle = state.stations.filter(s => s.kind === 'counter' && s.cell[0] === 0 && !s.item && Math.abs(s.cell[1]) === 1).map(s => s.id);
    expect(plugin.requests.find(r => r.op === 'act')?.step).toEqual({ do: 'put', target: Math.min(...middle) });
  });

  it('queues the watched steps once when the condition turns true, and drops the watch on a new level', async () => {
    const { plugin, host, world, state, labels } = await setup();
    const stove = state.stations.find(s => s.kind === 'stove' && s.cell[0] === 4)!;
    const plate = state.stations.find(s => s.kind === 'counter' && s.cell[0] === 7 && s.cell[1] === 1)!;
    const armed = await tool(world, 'oc2_arm').handler({ when: { target: labels.of(stove.id), until: 'cooked' }, steps: [{ do: 'take', target: labels.of(plate.id) }] }, { role: 'main', log: host.log });
    expect(typeof armed === 'string' ? armed : armed.text).toMatch(/^盯着#1 盯上了：S\d 炉灶 煮好了 → 拿 C\d+ 台面 上的盘子P\d（空）。排一次就撤，盯到这一关结束。/);
    const cooked = { ...state, stations: state.stations.map(s => (s.id === stove.id ? { ...s, item: { ...s.item!, cook: 'done' as const, contents: ['SushiRice:done'] } } : s)) };
    plugin.send({ t: 'state', ...state });
    plugin.send({ t: 'state', ...cooked });
    plugin.send({ t: 'state', ...cooked });
    await until(() => plugin.requests.some(r => r.op === 'act'));
    await until(() => host.events.some(e => e.type === 'overcooked2.watch'));
    const fired = host.events.find(e => e.type === 'overcooked2.watch')!;
    expect(fired.text).toMatch(/^\[厨房\] 盯着#1 的条件到了（S\d 炉灶 煮好了），这是最后一次，已撤掉。排上了任务#1：/);
    expect(host.pushOpts[host.events.indexOf(fired)]?.trigger).toBe('flush');
    expect(plugin.requests.filter(r => r.op === 'act')).toHaveLength(1);

    await tool(world, 'oc2_arm').handler({ when: { target: labels.of(stove.id), until: 'burnt' }, steps: [{ do: 'go', x: 1, z: 0 }] }, { role: 'main', log: host.log });
    plugin.send({ t: 'state', ...state, level: 'Sushi_1_4_2P' });
    await until(() => host.events.some(e => e.type === 'overcooked2.watch' && e.text.includes('换关了')));
  });
});

/** 1-3 的厨房被 x=0 这一列台面隔开：队友在左边（a），我在右边（b）。 */
function splitAtX0(state: GameState): GameState {
  const L = state.layout!;
  const regions = L.rows.map(row => [...row].map((ch, i) => {
    const x = L.minX + i;
    return ch === '#' || ch === ' ' || x === 0 ? ' ' : x < 0 ? 'a' : 'b';
  }).join(''));
  return { ...state, layout: { ...L, regions } };
}
