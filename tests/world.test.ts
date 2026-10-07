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
});
