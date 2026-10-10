# cortico-world-overcooked2

Owner: `src/definition.ts`, `plugin/`.

Cortico World for *Overcooked! 2* local co-op. The bot joins as the second local player through a virtual gamepad and plays its own chef next to the operator. A BepInEx 5 plugin inside the game hooks the game's own methods with Harmony and serves state and events over `127.0.0.1` TCP ([docs/protocol.md](docs/protocol.md)).

## Install into the game

The Steam build is a 32-bit Unity 2017.4 Mono player; it needs the **x86** BepInEx.

1. Extract BepInEx 5.4.23.x (`BepInEx_win_x86`) into the game directory, next to `Overcooked2.exe`.
2. `pnpm build:plugin` (needs a .NET SDK; `GameDir` in `plugin/Overcooked2Plugin.csproj` points at the install and supplies the game's assemblies to compile against).
3. Copy `dist/plugin/CorticoOvercooked2.dll` to `<game>/BepInEx/plugins/`.
4. Start the game (from Steam as usual). `BepInEx/LogOutput.log` shows `listening on 127.0.0.1:47640` and, once the title screen is up, `patched; focus gates: 4`.

Removing `winhttp.dll`, `doorstop_config.ini` and `BepInEx/` restores the unmodified game. The plugin never writes to the game's files or save data; the levels played write the game's own save as usual.

## Playing

1. Enable the World (`worlds.overcooked2.enabled`) and set `partnerName` to the name the operator goes by (the same name the ASR World uses for the microphone).
2. Start the game and press A / Space on the title screen; the operator is player 1 and drives all menus.
3. On the main menu the World joins the bot's pad as player 2 (`autoJoin`). The game accepts new local players only on the main menu; joining later needs a return to it.
4. Pick a level as usual. With two players each gets one chef.

The bot's pad works while the game window is unfocused; the operator's keyboard and pads work only while the game has focus, as in the unmodified game.

## What the bot gets

- Tools: `oc2_do` (queue a task of steps on labelled objects), `oc2_arm` (watch a condition and queue steps the moment it turns true), `oc2_stop` (one task, one watch, or everything), `oc2_look` (screenshot plus full scene), `oc2_join`.
- With `endTurnOnDo` (default on) `oc2_do` ends the turn once it runs, so the model is not asked again only to call `end_turn`; speech and watches go in the same reply, and the receipt is read with the next batch. A rejected `oc2_do` also wakes the bot with an event, since no task result follows it.
- `oc2_do` queue modes: `replace` (default) drops tasks not yet started and lets the running one finish; `append` adds to the end; `now` halts the running task and goes first; `cancel` drops tasks by number. A step names its target by label, or by `find` (with optional `near` and `shared`) resolved when the step runs to the nearest empty counter, empty board, clean plate or station with a cooked pot that the bot can reach. The receipt carries `[现在]`: what the bot holds and what each target holds at that moment, and which targets are on the partner's side.
- `oc2_arm` conditions: a label `until` cooked/overdone/burnt/fire/chopped/item/empty/plates, an order for a dish (optionally with at most N seconds left), or `all`/`any` of these. A watch queues its steps when the condition goes from false to true, up to `maxFirings`; it is dropped on expiry, a new level or leaving the kitchen, and each outcome is reported as an `overcooked2.watch` event.
- One deferred scene event, rendered when the bot reads it: round, orders, both chefs, stations, the bot's queue and watches; only the parts that changed since the last one, in full with a map on a new level, a new round, a new context window, every `anchorSec`, and when the map has changed and held still for 6 seconds. In a kitchen split by counters the full scene names the stations the bot cannot reach and the counters both sides can. The operator's actions since the last scene ride along as a 刚才 trail.
- Wakes for task results, watches firing, fire, pots done or about to burn, catches, orders about to expire, round start and end, and `idleNudgeSec` without a task (repeated every three times that while the queue stays empty).

## Development

`pnpm test`, `pnpm typecheck`. `tests/fixtures/` holds a state frame and events recorded in level 1-3.
