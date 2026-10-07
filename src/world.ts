/**
 * 胡闹厨房 2 World：bot 作为第二个本地玩家和操作员一起玩。游戏内 BepInEx 插件给 bot 一个虚拟
 * 手柄，并把游戏状态（每秒 5 帧）与带执行者的游戏事件送来。
 *
 * 现状描述是一条延迟渲染的场景事件（piggyback）：bot 读到它的那一刻才按最新一帧渲染，只写比上次
 * 变了的段；换关卡、回合开始、新的上下文窗口和每隔 anchorSec 写一次带地图的完整版。队友的动作攒成
 * 「刚才」轨迹放进这条描述；需要 bot 立刻反应的事（火、锅快糊、任务结果、空闲）单独唤醒。
 */
import { fileURLToPath } from 'node:url';
import type { BlobInput, ToolDef, ToolOutcome, TriggerMode, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { GameBridge, type Reply } from './bridge.ts';
import { OVERCOOKED2_CONFIG_GROUP, type Overcooked2ConfigSection } from './config.ts';
import { Executor, type TaskReport } from './executor.ts';
import { burningNow, extinguisherWhere, pushTrail, translate } from './events.ts';
import { Labels } from './labels.ts';
import { clock, mapText, nameOf, orderText, segments, stationText, type RenderCtx } from './render.ts';
import type { GameEvent, GameState } from './state.ts';
import { describe, parseSteps, pluginStep, stepResult, STEP_SCHEMA, type ParsedStep } from './steps.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const TAG = '[厨房]';
/** 一步最长：走位 20 秒加洗碗 40 秒，留出余量。 */
const STEP_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 10_000;
const JOIN_RETRY_MS = 3000;
/** 这么短时间内再次 oc2_look 只补变化。 */
const LOOK_REPEAT_MS = 15_000;
const FIRE_GROUP_MS = 800;
const LAYOUT_ANCHOR_MS = 20_000;
/** 空闲提醒的重复间隔是首次间隔的这么多倍。 */
const IDLE_REPEAT = 3;

export interface WorldOptions {
  cfg: Overcooked2ConfigSection;
  timezone: string;
}

export class Overcooked2World implements World {
  readonly id = 'overcooked2';
  private host: WorldHost | null = null;
  private readonly bridge = new GameBridge();
  private readonly labels = new Labels();
  private readonly executor: Executor;
  private state: GameState | null = null;
  private lamp: 'online' | 'loading' | 'error' | 'offline' = 'offline';
  private detail = '';

  private baseline = new Map<string, string>();
  private anchorPending = true;
  private lastAnchorAt = 0;
  private armed = false;
  private trail: string[] = [];
  private tips = new Map<number, number>();
  private warned = new Set<number>();
  private idleSince = 0;
  private nudgedAt = 0;
  private joinTried = 0;
  private joinError = '';
  private layoutKey = '';

  constructor(private readonly opts: WorldOptions) {
    this.executor = new Executor({
      run: (step, signal) => this.runStep(step as ParsedStep, signal),
      halt: async () => {
        await this.bridge.request({ op: 'halt' }, REQUEST_TIMEOUT_MS);
      },
      describe: step => describe(step as ParsedStep, this.state, this.ctx()),
      report: r => this.onTaskReport(r),
    });
    this.bridge.on('hello', () => {
      this.lamp = 'online';
      this.detail = '';
      this.executor.resume();
      this.anchorPending = true;
      void this.push('connection', '游戏插件已连接。', 'flush');
    });
    this.bridge.on('mismatch', (f: { protocol?: number }) => {
      this.lamp = 'error';
      this.detail = `插件协议 ${String(f.protocol)} 与 World 不一致，要更新游戏里的插件`;
    });
    this.bridge.on('disconnect', () => {
      this.lamp = 'loading';
      this.detail = '等待游戏';
      this.state = null;
      void this.executor.stop();
      void this.push('connection', '游戏连接断开了；游戏重新开起来后自动重连。', 'flush');
    });
    this.bridge.on('state', (s: GameState) => this.onState(s));
    this.bridge.on('ev', (e: GameEvent) => this.onGameEvent(e));
  }

  private get cfg(): Overcooked2ConfigSection {
    return this.opts.cfg;
  }

  private ctx(): RenderCtx {
    return { labels: this.labels, partner: this.cfg.partnerName || '队友' };
  }

  envPromptVars(): Record<string, string> {
    // 新的上下文窗口读不到之前的场景描述，下一次写完整版。
    this.anchorPending = true;
    return { 'overcooked2.partner': this.cfg.partnerName || '队友', 'overcooked2.status': this.statusLine() };
  }

  private statusLine(): string {
    // 这一句进环境提示词，那里以「你」称呼 bot。
    if (!this.bridge.connected) return '游戏现在没连上（没开或插件没装）。';
    const s = this.state;
    if (!s) return '游戏已连接。';
    return s.joined ? '游戏已连接，你已作为本地玩家加入。' : '游戏已连接，你还没作为本地玩家加入（主菜单时会自动加入）。';
  }

  console(): WorldConsoleDecl {
    const s = this.state;
    return {
      label: '胡闹厨房 2',
      lamps: [
        { label: '游戏插件', state: this.lamp, hint: this.detail || undefined },
        { label: '本地玩家', state: s?.joined ? 'online' : this.bridge.connected ? 'loading' : 'offline', hint: s?.joined ? undefined : this.joinError || '主菜单时加入' },
      ],
      badges: s && s.phase !== 'other' ? [{ label: '关卡', value: s.level ?? s.scene }] : [],
      config: [OVERCOOKED2_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.overcooked2.envPrompt',
        title: '胡闹厨房 2 · 环境提示词',
        description: '标签、地图、任务队列和与队友配合的约定。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'overcooked2.partner', description: '队友称呼（配置 partnerName）。' },
          { name: 'overcooked2.status', description: '游戏连接与加入状态。' },
        ],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.lamp = 'loading';
    this.detail = '等待游戏';
    this.bridge.open(this.cfg.port);
  }

  async stop(): Promise<void> {
    this.host = null;
    if (this.fires.timer) clearTimeout(this.fires.timer);
    await this.executor.stop().catch(() => undefined);
    this.bridge.close();
    this.lamp = 'offline';
  }

  // ---- 工具 ----------------------------------------------------------------------

  tools(): ToolDef[] {
    return [
      {
        name: 'oc2_do',
        description:
          '让我的厨师按顺序做一串动作（排进任务队列，后台执行，做完或卡住时回报）。append 排在已有任务后面；replace 先取消全部再做这个。' +
          '动作：take 拿起（食材箱、台面、炉灶上的锅、物品）；put 把手里的东西放到/装进目标；serve 上菜到出餐口；chop 切砧板上的东西直到切好；' +
          'wash 洗水槽里的脏盘子（plates 只数，不写洗完为止）；throw 把手里的食材扔向目标；go 走到目标旁或 x,z 格；' +
          'wait 等 target 满足 until（cooked 加热好/chopped 切好/item 有东西/empty 空出来/plates 有盘子）或 until=seconds 等 seconds 秒；' +
          'use 操作开关；extinguish 拿着灭火器灭目标的火。dash=true 路上冲刺。target 写场景描述里的标签。',
        tags: ['act'],
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            steps: { type: 'array', minItems: 1, maxItems: 30, items: STEP_SCHEMA },
            mode: { enum: ['append', 'replace'], default: 'append' },
          },
          required: ['steps'],
        },
        handler: async args => this.doTool(args),
      },
      {
        name: 'oc2_stop',
        description: '取消正在做和排着的全部任务，厨师停下、松开所有按键。',
        tags: ['act'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => {
          const n = await this.executor.cancel('我叫停了');
          return `${n ? `取消了 ${n} 个任务` : '本来就没有任务'}。[队列] ${this.executor.describeQueue()}`;
        },
      },
      {
        name: 'oc2_look',
        description: '看一眼游戏画面（截图）和完整的厨房现状（含地图）。',
        tags: ['read', 'snapshot'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => this.lookTool(),
      },
      {
        name: 'oc2_join',
        description: '让我作为本地玩家加入（只能在主菜单）；已加入时什么也不做。',
        tags: ['act'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => {
          const r = await this.bridge.request({ op: 'join' }, REQUEST_TIMEOUT_MS);
          return r.ok ? { text: '已加入（或本来就在）。' } : { text: `没能加入：${r.why}`, failed: true };
        },
      },
    ];
  }

  private async doTool(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.bridge.connected) return { text: '游戏没连上。', failed: true };
    const { steps, problems } = parseSteps(args.steps, this.state, this.ctx());
    if (problems.length) return { text: `没有排入：${problems.join('；')}`, failed: true };
    const mode = args.mode === 'replace' ? 'replace' : 'append';
    const id = await this.executor.submit(steps, mode);
    this.idleSince = 0;
    this.nudgedAt = 0;
    const chain = steps.map(s => describe(s, this.state, this.ctx())).join(' → ');
    return { text: `[执行器] 任务#${id} 收下了：${chain}。[队列] ${this.executor.describeQueue()}` };
  }

  private async lookTool(): Promise<ToolOutcome> {
    if (!this.bridge.connected || !this.state) return { text: '游戏没连上。', failed: true };
    // 刚写过同一个厨房的完整现状时只补之后的变化，截图照给。
    const sinceFull = Date.now() - this.lastAnchorAt;
    const sameKitchen = [...this.baseline.keys()].some(k => k.startsWith('st:'));
    const text = sinceFull < LOOK_REPEAT_MS && !this.anchorPending && sameKitchen
      ? this.renderChanges(this.state) ?? `${TAG} 距上一条完整现状 ${Math.round(sinceFull / 1000)} 秒，之后没有变化。`
      : this.renderFull(this.state);
    const blobs: BlobInput[] = [];
    try {
      const r = await this.bridge.request({ op: 'look', width: this.cfg.lookWidth }, REQUEST_TIMEOUT_MS);
      if (r.ok && typeof r.png === 'string') blobs.push({ bytes: Buffer.from(r.png, 'base64'), mime: 'image/png', name: 'overcooked2.png', fallbackText: '（游戏截图）' });
    } catch {
      // 截图失败时只给文字现状。
    }
    return { text, blobs };
  }

  private async runStep(step: ParsedStep, signal: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    if (signal.aborted) return { ok: false, detail: '已取消' };
    let reply: Reply;
    try {
      reply = await this.bridge.request({ op: 'act', step: pluginStep(step) }, STEP_TIMEOUT_MS);
    } catch (err) {
      // 超时的那一步可能还在插件里跑（比如游戏一直暂停着），停下它，下一步才能开始。
      await this.bridge.request({ op: 'halt' }, REQUEST_TIMEOUT_MS).catch(() => undefined);
      throw err;
    }
    return stepResult(step, reply, this.state, this.ctx());
  }

  private onTaskReport(r: TaskReport): void {
    const queue = `\n[队列] ${this.executor.describeQueue()}`;
    const trigger: TriggerMode = r.kind === 'cancelled' ? 'piggyback' : 'flush';
    if (this.executor.idle) this.idleSince = Date.now();
    void this.push('task', `[执行器] ${r.text}${queue}`, trigger);
  }

  // ---- 状态与事件 ----------------------------------------------------------------

  private onState(s: GameState): void {
    const prev = this.state;
    this.state = s;
    this.labels.update(s);
    const layoutKey = s.layout ? s.layout.rows.join('|') : '';
    if (layoutKey && layoutKey !== this.layoutKey) {
      // 地形会变的关卡里地图可能一直在变，带地图的完整版至多每 LAYOUT_ANCHOR_MS 一次。
      if (this.layoutKey && Date.now() - this.lastAnchorAt > LAYOUT_ANCHOR_MS) this.anchorPending = true;
      this.layoutKey = layoutKey;
    }
    if (s.phase === 'other' && prev?.phase !== 'other') this.baseline.clear();
    this.autoJoin(s);
    this.checkOrders(s);
    this.checkIdle(s);
    this.arm();
  }

  private autoJoin(s: GameState): void {
    if (!this.cfg.autoJoin || s.joined || s.phase !== 'other') return;
    if (Date.now() - this.joinTried < JOIN_RETRY_MS) return;
    this.joinTried = Date.now();
    this.bridge.request({ op: 'join' }, REQUEST_TIMEOUT_MS).then(
      r => {
        if (r.ok) {
          this.joinError = '';
          void this.push('join', '我已作为本地玩家加入，进关卡后会有自己的厨师。', 'piggyback');
        } else this.joinError = r.why ?? '';
      },
      () => undefined,
    );
  }

  private checkOrders(s: GameState): void {
    if (s.phase !== 'round' || !this.cfg.orderWarnSec) return;
    const due: string[] = [];
    for (const o of s.orders) {
      if (o.remaining > this.cfg.orderWarnSec) this.warned.delete(o.id);
      else if (!this.warned.has(o.id) && o.remaining > 0) {
        this.warned.add(o.id);
        due.push(orderText(o));
      }
    }
    if (due.length) void this.push('order', `订单快过期了：${due.join('；')}。`, 'flush');
  }

  private checkIdle(s: GameState): void {
    const me = s.chefs.find(c => c.role === 'bot');
    if (s.phase !== 'round' || !me || !this.cfg.idleNudgeSec || !this.executor.idle) {
      this.idleSince = 0;
      this.nudgedAt = 0;
      return;
    }
    const now = Date.now();
    if (!this.idleSince) this.idleSince = now;
    // 第一次在空闲 idleNudgeSec 后，之后每 IDLE_REPEAT 倍再提醒；一次唤醒被轮数上限截断后靠它接上。
    const due = this.nudgedAt ? this.nudgedAt + this.cfg.idleNudgeSec * 1000 * IDLE_REPEAT : this.idleSince + this.cfg.idleNudgeSec * 1000;
    if (now >= due) {
      this.nudgedAt = now;
      const left = s.timeLeft !== undefined ? `，回合还剩 ${clock(s.timeLeft)}` : '';
      void this.push('idle', `我已经 ${Math.round((now - this.idleSince) / 1000)} 秒没有任务了${left}。`, 'flush');
    }
  }

  /** 火会连着烧开，同一阵起火或灭火合成一条。 */
  private fires: { start: string[]; out: string[]; timer: NodeJS.Timeout | null } = { start: [], out: [], timer: null };

  private onFire(e: GameEvent): void {
    const name = nameOf(e.station, this.state, this.ctx());
    const list = e.k === 'fire' ? this.fires.start : this.fires.out;
    if (!list.includes(name)) list.push(name);
    if (this.fires.timer) return;
    this.fires.timer = setTimeout(() => {
      const { start, out } = this.fires;
      this.fires = { start: [], out: [], timer: null };
      if (start.length) void this.push('fire', `${start.join('、')} 着火了！${this.state ? burningNow(this.state, this.ctx()) + extinguisherWhere(this.state, this.ctx()) : ''}`, 'flush');
      const stillOut = out.filter(n => !start.includes(n));
      if (stillOut.length) void this.push('fire', `${stillOut.join('、')} 的火灭了。`, 'piggyback');
    }, FIRE_GROUP_MS);
  }

  private onGameEvent(e: GameEvent): void {
    if (e.k === 'fire' || e.k === 'fire.out') {
      this.onFire(e);
      this.arm();
      return;
    }
    const t = translate(e, this.state, this.ctx(), this.tips);
    if (t.trail) pushTrail(this.trail, t.trail);
    if (t.event) {
      if (t.event.anchor) this.anchorPending = true;
      if (e.k === 'level' || e.k === 'level.exit') {
        this.trail = [];
        this.warned.clear();
      }
      void this.push(t.event.kind, t.event.text, t.event.trigger);
    }
    this.arm();
  }

  private async push(kind: string, text: string, trigger: TriggerMode): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({ type: `overcooked2.${kind}`, ts: nowIso(this.opts.timezone), source: this.id, senderKey: this.id, text: `${TAG} ${text}` }, { trigger });
    } catch (err) {
      host.log.warn(`overcooked2 event: ${String(err)}`);
    }
  }

  // ---- 场景描述 ------------------------------------------------------------------

  /** 有连接就保持一条待渲染的场景描述；渲染时没有变化就不送。 */
  private arm(): void {
    if (this.armed || !this.host || !this.bridge.connected) return;
    this.armed = true;
    this.host.pushDeferred(
      { type: 'overcooked2.snapshot', senderKey: this.id, tags: ['snapshot'], render: () => this.renderSnapshot() },
      { trigger: 'piggyback' },
    );
  }

  private renderSnapshot(): string | null {
    this.armed = false;
    const s = this.state;
    if (!s) return null;
    const anchor = this.anchorPending || (s.phase !== 'other' && Date.now() - this.lastAnchorAt > this.cfg.anchorSec * 1000);
    if (anchor) return this.renderFull(s);
    return this.renderChanges(s);
  }

  /** 比基线变了的段；没有变化（或只有队列一句）时返回 null。 */
  private renderChanges(s: GameState): string | null {
    const segs = segments(s, this.ctx(), { trail: this.trail, queue: this.executor.describeQueue() });
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const g of segs) {
      seen.add(g.key);
      if (this.baseline.get(g.key) === g.cmp) continue;
      const before = this.baseline.get(g.key);
      this.baseline.set(g.key, g.cmp);
      if (g.text) lines.push(g.text);
      else if (before && g.cleared) lines.push(g.cleared);
    }
    for (const key of [...this.baseline.keys()]) if (!seen.has(key)) this.baseline.delete(key);
    this.trail = [];
    // 只有队列一句变化时不单独送（任务回执已经带着队列）。
    const meaningful = lines.filter(l => !l.startsWith('[队列]'));
    if (!meaningful.length) return null;
    return `${TAG} ${lines.join('\n')}`;
  }

  /** 完整现状：所有段、全部有东西的站点和地图；同时更新基线。 */
  private renderFull(s: GameState): string {
    this.anchorPending = false;
    this.lastAnchorAt = Date.now();
    const ctx = this.ctx();
    const segs = segments(s, ctx, { trail: this.trail, queue: this.executor.describeQueue() });
    this.baseline.clear();
    for (const g of segs) this.baseline.set(g.key, g.cmp);
    this.trail = [];
    const head = segs.filter(g => !g.key.startsWith('st:') && g.text).map(g => g.text);
    if (s.phase === 'other') return `${TAG} ${head.join('\n')}`;
    const stations = s.stations.filter(st => !(st.kind === 'counter' && !st.item && !st.onFire)).map(st => stationText(st, s, ctx));
    const map = mapText(s, ctx);
    const legend = `地图（x 向右，z 向上；「我」是我，「${ctx.partner.slice(0, 1)}」是${ctx.partner}；. 地面，< > ^ v 传送带（站上去会被往箭头方向带），# 墙或障碍，其余是站点标签；没列出的 C、Z 台面是空的）：`;
    return `${TAG} 完整现状\n${head.join('\n')}\n站点：\n${stations.join('\n')}${map ? `\n${legend}\n${map}` : ''}`;
  }
}
