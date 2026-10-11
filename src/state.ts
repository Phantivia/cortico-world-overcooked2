/**
 * 插件发来的状态与事件（docs/protocol.md）。坐标是厨房网格格子 [x, z]：x 向右，z 向画面上方。
 * 名称是游戏内部名（预制体或食材定义名），中文由 names.ts 翻译。
 */

export type ChefRole = 'bot' | 'partner' | 'other';

export interface Item {
  id: number;
  /** ingredient/plate/pot/pan/basket/extinguisher/other */
  kind: string;
  name: string;
  /** 切菜进度 0..1；1 表示已切好。不可切的物品没有这个字段。 */
  chop?: number;
  /** 加热：raw 生的、cooking 加热中、done 熟了、overdone 快糊、burnt 糊了。 */
  cook?: 'raw' | 'cooking' | 'done' | 'overdone' | 'burnt';
  /** 加热进度，到 1 为熟，继续加热到 2 为糊。 */
  cookProgress?: number;
  /** 从生到熟要加热的秒数；从熟到糊再要这么久。 */
  cookTime?: number;
  /** 盘、锅、篮里的食材，每项是内部名，附加工态后缀如 `Rice:done`、`Fish:chopped`。 */
  contents?: string[];
  /** 面包、玉米饼、面团这类上面能再放食材的底料（游戏里的 PreparationContainer），contents 是放在上面的。 */
  base?: boolean;
  dirty?: boolean;
  /** 叠起来的盘子数。 */
  stack?: number;
  /** 不在台面和手里时的格子（地上、飞行中）。 */
  cell?: [number, number];
  flying?: boolean;
}

export interface Chef {
  id: number;
  role: ChefRole;
  /** 游戏里的玩家名（本地玩家为 Player 1/2…）。 */
  name: string;
  cell: [number, number];
  /** 连续坐标，单位是格。 */
  pos: [number, number];
  /** 朝向的单位向量 [x, z]。 */
  facing: [number, number];
  held?: Item;
  /** 正在操作的站点 id（切菜、洗碗）。 */
  using?: number;
  dashing?: boolean;
  /** 掉下去后等待重生的剩余秒数。 */
  respawnIn?: number;
}

export interface Station {
  id: number;
  /** counter/board/stove/crate/pass/sink/drying/return/bin/mixer/fryer/oven/dispenser/other */
  kind: string;
  /** 场景里的对象名，用来区分同类站点和翻译出餐口等变体。 */
  name: string;
  cell: [number, number];
  item?: Item;
  /** 食材箱发的食材内部名。 */
  gives?: string;
  onFire?: boolean;
  /** 炉灶在加热、搅拌机在转。 */
  active?: boolean;
  /** 水槽里的脏盘数、沥水架或回盘口的盘数。 */
  plates?: number;
  /** 传送门：出口那个传送门的 id。 */
  to?: number;
  /** 水槽当前这只盘子的洗涤进度 0..1。 */
  progress?: number;
}

export interface Order {
  id: number;
  /** 菜名（订单定义名）。 */
  dish: string;
  /** 成品需要的食材，内部名带加工态后缀。 */
  parts: string[];
  remaining: number;
  lifetime: number;
}

export interface Score {
  total: number;
  deliveries: number;
  failed: number;
  base: number;
  tips: number;
  expired: number;
}

/** kitchen：关卡已加载；round：回合计时中；over：回合结束；other：菜单、大地图、加载中。 */
export type Phase = 'other' | 'kitchen' | 'round' | 'over';

export interface Layout {
  /** 网格范围（含端点）。 */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 行优先、z 从大到小（画面上方在前）；`.` 厨师走得到的地面，`< > ^ v` 传送带（带人走的方向），`#` 站点或障碍，空格其他。 */
  rows: string[];
  /** 与 rows 同形状：同一个厨师走得到的地面格同一个字母（a、b…），其他格是空格。 */
  regions?: string[];
}

export interface GameState {
  frame: number;
  /** 游戏启动后的秒数。 */
  at: number;
  scene: string;
  /** 关卡配置名，如 `Sushi_1_3_2P`。 */
  level?: string;
  phase: Phase;
  paused: boolean;
  timeLeft?: number;
  score?: Score;
  orders: Order[];
  chefs: Chef[];
  stations: Station[];
  /** 不在台面上也不在手里的物品。 */
  loose: Item[];
  layout?: Layout;
  /** bot 的虚拟手柄是否已作为本地玩家加入。 */
  joined: boolean;
}

/** 插件的一次离散事件。`k` 见 docs/protocol.md；chef 为执行者，没有执行者的事件不带。 */
export interface GameEvent {
  k: string;
  frame: number;
  chef?: number;
  item?: Item;
  /** 站点 id 或容器物品 id。 */
  from?: number;
  to?: number;
  station?: number;
  /** order.new/order.expire 带订单本身；deliver/tip 带订单号。 */
  order?: Order | number;
  ok?: boolean;
  tip?: number;
  state?: string;
  /** place/land 时被放进的容器 id 与放进后的样子。 */
  into?: number;
  result?: Item;
  /** swap 时换走的物品。 */
  took?: Item;
  /** transfer 时目标容器倒腾之后的样子。 */
  other?: Item;
  floor?: boolean;
  dish?: string;
  level?: string;
  timeLeft?: number;
  left?: number;
  /** board：开场黑板的贴图名、本地化后的标题和说明、黑板上的小标签（「新食谱」这类），以及截图（base64 PNG，黑板已经关掉时没有）。 */
  sprite?: string;
  title?: string;
  body?: string;
  label?: string;
  png?: string;
}
