Owner: `plugin/Plugin.cs`, `src/bridge.ts`, `src/state.ts`.

# 插件协议

游戏内插件在 `127.0.0.1:<port>`（默认 47640，`BepInEx/config/ai.cortico.overcooked2.cfg`）监听 TCP，UTF-8 JSON 一行一帧。可以同时有多个客户端：广播帧发给所有客户端，回复只发给提问的那个。协议版本 1。

## 插件 → 客户端

- `{"t":"hello","protocol":1,"version":"0.1.0"}`：连上后第一帧。
- `{"t":"state", ...GameState}`：每 0.2 秒一帧，有事件时下一帧立即补发。客户端写得慢时只保留最新一帧。字段见 `src/state.ts`。坐标是厨房主网格的格子 `[x, z]`，x 向右，z 向画面上方；`layout.rows` 从上到下，`.` 是厨师走得到的地面，`< > ^ v` 是传送带（游戏把它登记为网格占用格，人能站上去，箭头是它带人的方向），`#` 是挨着这些地面的其他占用格（站点、墙、装饰台）。走得到＝从厨师所在格出发，相邻两格之间厨师的身体能通过。
- `{"t":"ev","k":…,"frame":…}`：游戏事件。`chef` 是执行者，只有厨师主动做的事才带。

| k | 字段 | 含义 |
|---|---|---|
| `pickup` | chef, item, from? | 拿起；from 是站点（食材箱、台面…） |
| `place` | chef, item, to, into?, result?, floor? | 放下；into/result 是被放进的容器和放进后的样子 |
| `transfer` | chef, item, to, other? | 手里的容器和目标容器之间倒腾（拿着盘子对锅盛饭） |
| `swap` | chef, item, took, to | 放下手里的同时拿走了别的 |
| `drop` | chef, item | 丢在地上 |
| `throw` / `catch` | chef, item, from? | 扔出 / 接住；catch 的 from 是扔的人 |
| `land` | item, to?, into?, result?, chef? | 扔出的东西落到站点或容器里；chef 是扔的人 |
| `chop.start` / `chop.done` | chef, station, item? | 开始切 / 切好（item 是切好后的） |
| `wash.start` / `wash.plate` | chef, station, left? | 开始洗 / 洗好一只（left 是水槽剩下的） |
| `cook` | item, station?, state | 容器加热状态变成 done / overdone / burnt |
| `fire` / `fire.out` | station | 起火 / 熄灭 |
| `order.new` / `order.expire` | order | 新订单 / 超时（订单重新计时） |
| `tip` | order, tip | 紧接着 deliver 之前到 |
| `deliver` | ok, order?, dish?, chef? | 上菜成功或被拒 |
| `fell` / `lost` | chef / item | 厨师掉出场外 / 物品掉出场外 |
| `level` / `level.exit` | level | 进入关卡 / 离开厨房 |
| `round.start` / `round.end` | timeLeft / phase | 回合开始 / 结束 |

## 客户端 → 插件

每帧带 `op` 和 `id`，插件回 `{"t":"reply","id":…,"ok":…,"why"?}`。`who` 缺省是 `bot`；`test` 是测试用的第二个虚拟手柄，代替操作员。

| op | 字段 | 说明 |
|---|---|---|
| `join` / `leave` | who? | 虚拟手柄作为本地玩家加入 / 退出；只在主菜单有效，一号玩家要先进入 |
| `act` | step, who? | 执行一步，做完才回复；字段见下 |
| `halt` | who? | 停下当前一步（它以「已取消」回复）、松开所有按键 |
| `look` | width? | 回复带 `png`（base64） |
| `press` | button?, x?, y?, seconds?, who? | 测试用：按住手柄原始按键（InControl 名称，如 `Action1`）和摇杆 |
| `cell` | x, z | 诊断：这一格的网格占用、地面判定和向下射线的全部命中 |

`act.step`：`{do, target?, x?, z?, until?, seconds?, plates?, dash?}`，target 是对象 id。`do` 取 `take put serve chop wash throw go wait use extinguish`，含义见 `src/steps.ts`。回复字段：`item`（这一步处理的物品）、`held`（结束时手里的东西）、`into`（放进去的容器）、`delivered`、`washed`/`left`、`state`。失败时 `why` 是一句中文，其中 `{item}` 指 `item`，`{by}` 指 `by`（`bot` 或 `partner`）。
