import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { OVERCOOKED2_DEFAULTS, type Overcooked2ConfigSection } from './config.ts';
import { OVERCOOKED2_TOOL_DECLS, Overcooked2World } from './world.ts';

export const OVERCOOKED2: WorldDefinition<Overcooked2ConfigSection> = {
  id: 'overcooked2',
  label: '胡闹厨房 2',
  defaults: () => structuredClone(OVERCOOKED2_DEFAULTS),
  create: ctx => new Overcooked2World({ cfg: ctx.cfg, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(OVERCOOKED2_TOOL_DECLS, {
      oc2_do: {
        zh: '让 bot 的厨师按顺序做一串动作（拿、放、切、洗、上菜、灭火等），在后台执行，做完或卡住时回报。',
        en: "Queues a sequence of actions for the bot's chef (pick up, put down, chop, wash, serve, put out fires and more), runs them in the background and reports when they finish or get stuck.",
      },
      oc2_arm: {
        zh: '设一个条件，成立时自动把一串动作排进任务队列，不等 bot 下一轮。',
        en: "Sets a condition that queues a sequence of actions as soon as it holds, without waiting for the bot's next turn.",
      },
      oc2_stop: {
        zh: '撤掉一个任务或一个条件；不写参数时厨师停下，任务和条件全部撤掉。',
        en: 'Cancels one task or one condition; with no arguments the chef stops and every task and condition is cancelled.',
      },
      oc2_look: {
        zh: '截一张游戏画面，并给出带地图的完整厨房现状。',
        en: 'Takes a screenshot of the game and returns the full kitchen state with the map.',
      },
      oc2_join: {
        zh: '在主菜单让 bot 作为第二个本地玩家加入。',
        en: 'Joins the game as the second local player from the main menu.',
      },
    }),
    events: [
      {
        type: 'overcooked2.snapshot',
        description: {
          zh: '厨房现状：bot 读到时按最新一帧渲染，平时只写变了的部分，换关、回合开始和每隔一段时间写带地图的完整版。',
          en: 'Kitchen state, rendered from the latest frame when the bot reads it: only the changed parts, with a full version including the map on level change, round start and at a set interval.',
        },
        trigger: 'piggyback',
        tags: ['snapshot'],
      },
      {
        type: 'overcooked2.connection',
        description: { zh: '游戏插件连上或断开。', en: 'The game plugin connected or disconnected.' },
        trigger: 'flush',
      },
      {
        type: 'overcooked2.join',
        description: { zh: 'bot 作为本地玩家加入了游戏。', en: 'The bot joined the game as a local player.' },
        trigger: 'piggyback',
      },
      {
        type: 'overcooked2.board',
        description: { zh: '关卡开场黑板上的说明，附黑板截图。', en: "The level's opening board text, with a screenshot of the board." },
        trigger: 'flush',
      },
      {
        type: 'overcooked2.level',
        description: { zh: '进入关卡或离开厨房。', en: 'A level was entered or the kitchen was left.' },
      },
      {
        type: 'overcooked2.round',
        description: { zh: '回合开始（带限时）或结束（带得分）。', en: 'A round started (with its time limit) or ended (with the score).' },
        trigger: 'flush',
      },
      {
        type: 'overcooked2.task',
        description: {
          zh: '任务队列里的任务做完、卡住或被撤掉；oc2_do 调用后结束本轮时，没排进去的那次也在这里回报。',
          en: 'A task in the queue finished, got stuck or was cancelled; when oc2_do ends the turn, a call that queued nothing is reported here too.',
        },
      },
      {
        type: 'overcooked2.watch',
        description: { zh: 'oc2_arm 设的条件成立、到期或被撤掉。', en: 'A condition set with oc2_arm fired, expired or was cancelled.' },
      },
      {
        type: 'overcooked2.idle',
        description: { zh: 'bot 的厨师有一段时间没有任务。', en: "The bot's chef has had no task for a while." },
        trigger: 'flush',
      },
      {
        type: 'overcooked2.order',
        description: { zh: '订单快到期，或订单超时扣分。', en: 'An order is about to expire, or one expired and cost points.' },
      },
      {
        type: 'overcooked2.deliver',
        description: { zh: '有人上菜成功（带小费）或失败。', en: 'Someone served a dish (with the tip) or served one that matches no order.' },
      },
      {
        type: 'overcooked2.cook',
        description: { zh: '锅里的东西煮好、快糊或已经糊了。', en: 'Food on the stove is cooked, about to burn, or burnt.' },
        trigger: 'flush',
      },
      {
        type: 'overcooked2.fire',
        description: { zh: '有地方着火，或火灭了。', en: 'Something caught fire, or a fire went out.' },
      },
      {
        type: 'overcooked2.catch',
        description: { zh: 'bot 的厨师接住了扔来的食材。', en: "The bot's chef caught a thrown ingredient." },
        trigger: 'flush',
      },
      {
        type: 'overcooked2.fell',
        description: { zh: 'bot 的厨师掉出场外，手里的东西丢了。', en: "The bot's chef fell off the level and lost what it was holding." },
        trigger: 'flush',
      },
      {
        type: 'overcooked2.lost',
        description: { zh: '有东西掉出场外没了。', en: 'An item fell off the level.' },
        trigger: 'piggyback',
      },
    ],
  },
};
