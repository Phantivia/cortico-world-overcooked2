import type { ConfigGroup } from 'cortico/core/types.ts';

export interface Overcooked2ConfigSection {
  enabled: boolean;
  /** 游戏内插件监听的端口，与 BepInEx/config/ai.cortico.overcooked2.cfg 一致。 */
  port: number;
  /** 一起玩的人在事件和场景描述里的称呼。 */
  partnerName: string;
  /** 游戏里 bot 那位玩家显示的名字；空着就用游戏给的。 */
  botGameName: string;
  /** 游戏里一号玩家（一起玩的人）显示的名字；空着就用游戏给的。 */
  partnerGameName: string;
  /** bot 用一号玩家的蓝色，一起玩的人用红色；关掉就按加入顺序（一号蓝、二号红）。 */
  botFirstColour: boolean;
  /** 游戏停在主菜单且 bot 还没加入时自动加入为本地玩家。 */
  autoJoin: boolean;
  /** 回合进行中 bot 的任务队列空了这么久就唤醒提醒，仍空着时每隔三倍时长再提醒；0 关闭。 */
  idleNudgeSec: number;
  /** 订单剩余秒数降到这个值时提醒一次。 */
  orderWarnSec: number;
  /** 两次完整场景描述（含地图）之间的最长间隔。 */
  anchorSec: number;
  /** 截图宽度（像素）。 */
  lookWidth: number;
  /** oc2_do 执行完就结束这一轮，不再为调 end_turn 多请求一次模型；回执留在上下文里，下一批消息到了一起读。 */
  endTurnOnDo: boolean;
}

export const OVERCOOKED2_DEFAULTS: Overcooked2ConfigSection = {
  enabled: false,
  port: 47640,
  partnerName: '队友',
  botGameName: '',
  partnerGameName: '',
  botFirstColour: true,
  autoJoin: true,
  idleNudgeSec: 10,
  orderWarnSec: 20,
  anchorSec: 120,
  lookWidth: 768,
  endTurnOnDo: true,
};

export const OVERCOOKED2_CONFIG_GROUP: ConfigGroup = {
  id: 'world:overcooked2',
  owner: 'world:overcooked2',
  schema: {
    type: 'object',
    title: '胡闹厨房 2',
    properties: {
      'worlds.overcooked2.port': { type: 'integer', minimum: 1, maximum: 65535, title: '插件端口' },
      'worlds.overcooked2.partnerName': { type: 'string', title: '队友称呼', 'x-hot': true },
      'worlds.overcooked2.botGameName': { type: 'string', title: '游戏里 bot 的名字' },
      'worlds.overcooked2.partnerGameName': { type: 'string', title: '游戏里队友的名字' },
      'worlds.overcooked2.botFirstColour': { type: 'boolean', title: 'bot 用蓝色、队友用红色' },
      'worlds.overcooked2.autoJoin': { type: 'boolean', title: '主菜单自动加入', 'x-hot': true },
      'worlds.overcooked2.idleNudgeSec': { type: 'integer', minimum: 0, maximum: 120, title: '空闲提醒（秒）', 'x-hot': true },
      'worlds.overcooked2.orderWarnSec': { type: 'integer', minimum: 0, maximum: 120, title: '订单临期提醒（秒）', 'x-hot': true },
      'worlds.overcooked2.anchorSec': { type: 'integer', minimum: 30, maximum: 1800, title: '完整场景描述间隔（秒）', 'x-hot': true },
      'worlds.overcooked2.lookWidth': { type: 'integer', minimum: 320, maximum: 1920, title: '截图宽度', 'x-hot': true },
      'worlds.overcooked2.endTurnOnDo': { type: 'boolean', title: '派完任务就结束这一轮' },
    },
  },
};
