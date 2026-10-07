/**
 * 胡闹厨房 2 World：bot 作为第二个本地玩家和操作员一起玩。游戏内 BepInEx 插件给 bot 一个虚拟
 * 手柄，并把游戏状态（每秒 5 帧）与带执行者的游戏事件送来。
 *
 * 现状描述是一条延迟渲染的场景事件（piggyback）：bot 读到它的那一刻才按最新一帧渲染，只写比上次
 * 变了的段；换关卡、回合开始、新的上下文窗口和每隔 anchorSec 写一次带地图的完整版。队友的动作攒成
 * 「刚才」轨迹放进这条描述；需要 bot 立刻反应的事（火、锅快糊、任务结果、空闲）单独唤醒。
 *
 * bot 的手：oc2_do 把一串步骤排进任务队列（executor.ts），回执带上排的那一刻手里和各目标的样子；
 * oc2_arm 盯着一个条件，成立时自动排上一串步骤（triggers.ts），反应不用等 bot 再想一轮。
 */
import { fileURLToPath } from 'node:url';
import type { BlobInput, ToolDef, ToolOutcome, TriggerMode, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { GameBridge, type Reply } from './bridge.ts';
import { OVERCOOKED2_CONFIG_GROUP, type Overcooked2ConfigSection } from './config.ts';
import { Executor, type QueueMode, type TaskReport } from './executor.ts';
import { burningNow, extinguisherWhere, pushTrail, translate } from './events.ts';
import { Labels, locate } from './labels.ts';
import { chefName, clock, itemText, mapText, nameOf, orderText, segments, stationName, stationText, type RenderCtx } from './render.ts';
import { cellReachable, chefOf, sides } from './sides.ts';
import type { GameEvent, GameState } from './state.ts';
import { describe, parseSteps, pluginStep, resolveFind, stepResult, STEP_SCHEMA, type ParsedStep } from './steps.ts';
import { CONDITION_SCHEMA, describeCondition, evaluate, parseCondition, Watches, type Watch, type WatchEnd } from './triggers.ts';

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
/** 布局要这么久没再变才算真变了，才补一条带地图的完整现状。 */
const LAYOUT_STABLE_MS = 6000;
const QUEUE_MODES = ['replace', 'append', 'now'] as const;
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
  private layoutSince = 0;
  /** 最近一条完整现状里画的那张地图。 */
  private anchoredLayout = '';
  private kitchenKey = '';
  private readonly watches: Watches;

  constructor(private readonly opts: WorldOptions) {
    this.executor = new Executor({
      run: (step, signal) => this.runStep(step as ParsedStep, signal),
      halt: async () => {
        await this.bridge.request({ op: 'halt' }, REQUEST_TIMEOUT_MS);
      },
      describe: step => describe(step as ParsedStep, this.state, this.ctx()),
      report: r => this.onTaskReport(r),
    });
    this.watches = new Watches({
      fire: w => this.fireWatch(w),
      report: (w, end, text) => this.onWatchReport(w, end, text),
      describe: w => describeCondition(w.when, this.state, this.ctx()),
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
      this.watches.clear('游戏连接断开了');
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
          '让我的厨师按顺序做一串动作，排进任务队列，在后台做，做完或卡住时回报。' +
          '动作：take 拿起（食材箱、台面、炉灶上的锅、物品）；put 把手里的东西放到或装进目标；serve 上菜到出餐口；chop 切砧板上的东西直到切好；' +
          'wash 洗水槽里的脏盘子（plates 只数，不写就洗完）；throw 把手里的食材扔向目标；go 走到目标旁或 x,z 格；' +
          'wait 等 target 到 until（cooked 煮好、chopped 切好、item 上面有东西、empty 空出来、plates 有盘子），或者 until=seconds 等 seconds 秒；' +
          'use 操作开关；extinguish 拿着灭火器灭目标的火。dash=true 路上冲刺。' +
          'target 写场景描述里的标签，或者写 {find,near?,shared?} 让执行到这一步时再从我够得着的里面挑。' +
          'queue：replace（不写就是它）撤掉还没开始的任务，正在做的做完；append 排到最后；now 叫停正在做的，先做这个。cancel 写任务号，顺带撤掉那几个。',
        tags: ['act'],
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            steps: { type: 'array', minItems: 1, maxItems: 30, items: STEP_SCHEMA },
            queue: { enum: [...QUEUE_MODES], default: 'replace' },
            cancel: { type: 'array', maxItems: 30, items: { type: 'integer', minimum: 1 } },
          },
          required: ['steps'],
        },
        handler: async args => this.doTool(args),
      },
      {
        name: 'oc2_arm',
        description:
          '盯着一件事：条件成立的那一刻，自动把一串动作排进任务队列，不用等我再想一轮。条件先不成立、再成立才算一次；' +
          'maxFirings 写最多排几次（不写是 1 次），expiresInSec 写盯多久（不写就盯到这一关结束）。' +
          'queue 是排上时的排法，不写就是 now：叫停正在做的，先做这串。换关、离开厨房时自动撤掉。steps 的写法和 oc2_do 一样。',
        tags: ['act'],
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            when: CONDITION_SCHEMA,
            steps: { type: 'array', minItems: 1, maxItems: 30, items: STEP_SCHEMA },
            queue: { enum: [...QUEUE_MODES], default: 'now' },
            maxFirings: { type: 'integer', minimum: 1, maximum: 16 },
            expiresInSec: { type: 'integer', minimum: 1, maximum: 600 },
          },
          required: ['when', 'steps'],
        },
        handler: async args => this.armTool(args),
      },
      {
        name: 'oc2_stop',
        description: '写 taskId 只撤掉那个任务（正在做的就叫停）；写 watchId 撤掉那件盯着的事；都不写就叫停全部任务、撤掉全部盯着的事，厨师停下、松开所有按键。',
        tags: ['act'],
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { taskId: { type: 'integer', minimum: 1 }, watchId: { type: 'integer', minimum: 1 } },
        },
        handler: async args => this.stopTool(args),
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
    const queue = parseQueue(args.queue, 'replace');
    if (typeof queue !== 'string') problems.push(queue.problem);
    const cancel = args.cancel ?? [];
    if (!Array.isArray(cancel) || cancel.some(n => !Number.isInteger(n))) problems.push('cancel 要写任务号数组');
    if (problems.length || typeof queue !== 'string') return { text: `没有排入：${problems.join('；')}`, failed: true };
    const { id, notes } = await this.executor.submit(steps, queue, cancel as number[]);
    this.idleSince = 0;
    this.nudgedAt = 0;
    const chain = steps.map(st => describe(st, this.state, this.ctx())).join(' → ');
    return { text: `[执行器] 任务#${id} 收下了：${chain}。${notes.length ? `${notes.join('；')}。` : ''}\n${this.nowFacts(steps)}\n[队列] ${this.executor.describeQueue()}` };
  }

  private async armTool(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.bridge.connected) return { text: '游戏没连上。', failed: true };
    const s = this.state;
    if (!s || s.phase === 'other') return { text: '不在厨房里，没有可盯的东西。', failed: true };
    const ctx = this.ctx();
    const problems: string[] = [];
    const when = parseCondition(args.when, label => ctx.labels.resolve(label));
    if (typeof when === 'string') problems.push(when);
    const { steps, problems: stepProblems } = parseSteps(args.steps, s, ctx);
    problems.push(...stepProblems);
    const queue = parseQueue(args.queue, 'now');
    if (typeof queue !== 'string') problems.push(queue.problem);
    const max = args.maxFirings ?? 1;
    if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 16) problems.push('maxFirings 要是 1 到 16 的整数');
    const sec = args.expiresInSec;
    if (sec !== undefined && (!Number.isInteger(sec) || (sec as number) < 1 || (sec as number) > 600)) problems.push('expiresInSec 要是 1 到 600 的整数');
    if (problems.length || typeof when === 'string' || typeof queue !== 'string') return { text: `没有盯上：${problems.join('；')}`, failed: true };
    const w = this.watches.arm(when, steps, queue, max as number, sec === undefined ? null : (sec as number) * 1000);
    const until = sec === undefined ? '盯到这一关结束' : `盯 ${sec} 秒`;
    const times = (max as number) > 1 ? `最多排 ${max} 次` : '排一次就撤';
    const already = evaluate(when, s) ? '条件现在就成立，马上排上。' : '';
    return { text: `盯着#${w.id} 盯上了：${this.watchText(w)}。${times}，${until}。${already}\n${this.watchesLine()}` };
  }

  private async stopTool(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (args.taskId !== undefined || args.watchId !== undefined) {
      const out: string[] = [];
      if (Number.isInteger(args.taskId)) out.push(await this.executor.cancelTask(args.taskId as number, '我叫停了'));
      if (Number.isInteger(args.watchId)) out.push(this.watches.cancel(args.watchId as number, '我撤掉了') ? `撤掉了盯着#${args.watchId}` : `盯着#${args.watchId} 已经没了`);
      return { text: `${out.join('；')}。[队列] ${this.executor.describeQueue()}` };
    }
    const n = await this.executor.cancel('我叫停了');
    const w = this.watches.clear('我叫停了全部', 'cancelled');
    return { text: `${n ? `取消了 ${n} 个任务` : '本来就没有任务'}${w ? `，撤掉了 ${w} 件盯着的事` : ''}。[队列] ${this.executor.describeQueue()}` };
  }

  /** 排上的那一刻：我手里有什么、这串动作碰到的每个对象现在是什么样、我够不够得着。 */
  private nowFacts(steps: ParsedStep[]): string {
    const s = this.state;
    if (!s) return '[现在] 还没收到游戏状态';
    const ctx = this.ctx();
    const me = chefOf(s, 'bot');
    const facts = [me?.held ? `我手里拿着${itemText(me.held, ctx)}` : '我手里空着'];
    const seen = new Set<number>();
    for (const step of steps) {
      if (step.id === undefined || seen.has(step.id)) continue;
      seen.add(step.id);
      const fact = this.objectFact(step.id);
      if (fact) facts.push(fact);
    }
    return `[现在] ${facts.join('；')}`;
  }

  /** 一个对象此刻在哪、是什么样，够不着时说哪一边够得着。食材箱、出餐口这类够得着时不写。 */
  private objectFact(id: number): string | null {
    const s = this.state;
    if (!s) return null;
    const ctx = this.ctx();
    const { mine, theirs, split } = sides(s);
    const reach = (cell: [number, number]) => {
      if (cellReachable(s, cell, mine)) return '';
      return split && cellReachable(s, cell, theirs) ? `，在我走不到的那一边，${ctx.partner}那边够得着` : '，我走不到';
    };
    const st = s.stations.find(x => x.id === id);
    if (st) {
      const far = reach(st.cell);
      const plain = ['crate', 'pass', 'bin', 'fixture'].includes(st.kind);
      return plain && !far ? null : `${stationText(st, s, ctx)}${far}`;
    }
    if (s.chefs.some(c => c.id === id)) return null;
    const label = ctx.labels.of(id) ?? '';
    const place = locate(s, id);
    if (!place) return `${label} 已经不在场上了`;
    if ('station' in place) return `${label} 在 ${stationName(place.station, ctx)} 上${reach(place.station.cell)}`;
    if ('chef' in place) return `${label} 在${chefName(s.chefs.find(c => c.id === place.chef), ctx)}手里`;
    return `${label} 在地上 (${place.cell[0]},${place.cell[1]})${reach(place.cell)}`;
  }

  private async fireWatch(w: Watch): Promise<string> {
    const steps = w.steps.map(st => ({ ...st }));
    const { id, notes } = await this.executor.submit(steps, w.queue);
    this.idleSince = 0;
    this.nudgedAt = 0;
    const chain = steps.map(st => describe(st, this.state, this.ctx())).join(' → ');
    return `排上了任务#${id}：${chain}。${notes.length ? `${notes.join('；')}。` : ''}`;
  }

  private onWatchReport(_w: Watch, end: WatchEnd, text: string): void {
    void this.push('watch', `${text}\n[队列] ${this.executor.describeQueue()}`, end === 'fired' ? 'flush' : 'debounce');
  }

  private watchText(w: Watch): string {
    const ctx = this.ctx();
    return `${describeCondition(w.when, this.state, ctx)} → ${w.steps.map(st => describe(st, this.state, ctx)).join(' → ')}`;
  }

  /** 场景描述里的队列一句，有盯着的事时接在后面。 */
  private queueText(): string {
    const all = this.watches.all;
    const queue = this.executor.describeQueue();
    if (!all.length) return queue;
    return `${queue}；盯着 ${all.map(w => `#${w.id} ${describeCondition(w.when, this.state, this.ctx())}`).join('、')}`;
  }

  /** 还在盯着的事，一行。 */
  private watchesLine(): string {
    const all = this.watches.all;
    if (!all.length) return '[盯着] 没有';
    return `[盯着] ${all.map(w => `#${w.id} ${describeCondition(w.when, this.state, this.ctx())}（还能排 ${w.left} 次）`).join('；')}`;
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

  private async runStep(queued: ParsedStep, signal: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    if (signal.aborted) return { ok: false, detail: '已取消' };
    let step = queued;
    if (queued.find) {
      const picked = resolveFind(queued.find, this.state, this.ctx());
      if ('why' in picked) return { ok: false, detail: picked.why };
      step = { ...queued, id: picked.id, target: this.ctx().labels.of(picked.id) };
    }
    let reply: Reply;
    try {
      reply = await this.bridge.request({ op: 'act', step: pluginStep(step) }, STEP_TIMEOUT_MS);
    } catch (err) {
      // 超时的那一步可能还在插件里跑（比如游戏一直暂停着），停下它，下一步才能开始。
      await this.bridge.request({ op: 'halt' }, REQUEST_TIMEOUT_MS).catch(() => undefined);
      throw err;
    }
    const result = stepResult(step, reply, this.state, this.ctx());
    if (!result.ok && reply.why !== '已取消' && step.id !== undefined) {
      const fact = this.objectFact(step.id);
      if (fact) result.detail += `。现在 ${fact}`;
    }
    return result;
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
    const kitchen = s.phase === 'other' ? '' : `${s.scene}|${s.level ?? ''}`;
    if (kitchen !== this.kitchenKey) {
      // 标签换关重编，盯着的事里的标签跟着失效。
      if (this.kitchenKey) this.watches.clear(kitchen ? '换关了' : '离开厨房了');
      this.kitchenKey = kitchen;
    }
    this.checkLayout(s);
    if (s.phase === 'other' && prev?.phase !== 'other') this.baseline.clear();
    this.autoJoin(s);
    this.checkOrders(s);
    this.checkIdle(s);
    if (s.phase === 'round') void this.watches.tick(s);
    this.arm();
  }

  /**
   * 地图真变了（新的样子保持了 LAYOUT_STABLE_MS）且和上一条完整现状里画的不同，才补一条带地图的
   * 完整现状，至多每 LAYOUT_ANCHOR_MS 一次。来回闪的格子不触发。
   */
  private checkLayout(s: GameState): void {
    const key = s.layout ? [...s.layout.rows, ...(s.layout.regions ?? [])].join('|') : '';
    const now = Date.now();
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layoutSince = now;
    }
    if (key && this.anchoredLayout && key !== this.anchoredLayout && now - this.layoutSince >= LAYOUT_STABLE_MS && now - this.lastAnchorAt > LAYOUT_ANCHOR_MS) {
      this.anchorPending = true;
    }
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
    const segs = segments(s, this.ctx(), { trail: this.trail, queue: this.queueText() });
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
    this.anchoredLayout = this.layoutKey;
    const ctx = this.ctx();
    const segs = segments(s, ctx, { trail: this.trail, queue: this.queueText() });
    this.baseline.clear();
    for (const g of segs) this.baseline.set(g.key, g.cmp);
    this.trail = [];
    const head = segs.filter(g => !g.key.startsWith('st:') && g.text).map(g => g.text);
    if (s.phase === 'other') return `${TAG} ${head.join('\n')}`;
    const stations = s.stations.filter(st => !(st.kind === 'counter' && !st.item && !st.onFire)).map(st => stationText(st, s, ctx));
    const map = mapText(s, ctx);
    const legend = `地图（x 向右，z 向上；「我」是我，「${ctx.partner.slice(0, 1)}」是${ctx.partner}；. 地面，< > ^ v 传送带（站上去会被往箭头方向带），# 墙或障碍，其余是站点标签；没列出的 C、Z 台面是空的）：`;
    const split = this.splitText(s);
    return `${TAG} 完整现状\n${head.join('\n')}\n站点：\n${stations.join('\n')}${map ? `\n${legend}\n${map}` : ''}${split ? `\n${split}` : ''}`;
  }

  /** 厨房被台面隔成两边、我和队友各在一边时：我够不着哪些站点，哪些台面两边都够得着。 */
  private splitText(s: GameState): string {
    const { mine, theirs, split } = sides(s);
    if (!split) return '';
    const ctx = this.ctx();
    const label = (id: number) => ctx.labels.of(id) ?? '?';
    const far = s.stations.filter(st => st.kind !== 'counter' && st.kind !== 'fixture' && !cellReachable(s, st.cell, mine)).map(st => label(st.id));
    const shared = s.stations.filter(st => st.kind === 'counter' && cellReachable(s, st.cell, mine) && cellReachable(s, st.cell, theirs)).map(st => label(st.id));
    return `厨房被台面隔成两边，我和${ctx.partner}各在一边。我够不着的站点：${far.join('、') || '没有'}。两边都够得着、能用来交接的台面：${shared.join('、') || '没有，只能扔过去'}。`;
  }
}

function parseQueue(raw: unknown, fallback: QueueMode): QueueMode | { problem: string } {
  if (raw === undefined) return fallback;
  return QUEUE_MODES.includes(raw as QueueMode) ? (raw as QueueMode) : { problem: `queue 只能是 ${QUEUE_MODES.join('/')}` };
}
