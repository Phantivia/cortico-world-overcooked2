using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// Runs one step of the bot's task at a time on the bot pad (docs/protocol.md, `act`). A step
    /// walks the bot chef to a free cell next to its target, turns until the game itself selects
    /// that target, presses the game's button and confirms the result from game state. Failure
    /// reasons are Chinese clauses; `{item}` and `{by}` are filled in by the World from the
    /// reply's `item` and `by` fields.
    /// </summary>
    internal sealed class Actor
    {
        private sealed class Outcome
        {
            public bool Ok;
            public string Why;
            public string Item;
            public string By;
            public readonly JObj Extra = new JObj();
        }

        private readonly Kitchen _k;
        private IEnumerator _job;
        private Outcome _outcome;
        private Bridge.Client _client;
        private long _requestId;
        private string _kind;

        private readonly string _who;

        public Actor(Kitchen k, string who) { _k = k; _who = who; }

        private PlayerControls ChefNow() => _k.ChefOf(Pad);

        public bool Busy => _job != null;

        private VirtualPad Pad => Seat.Pad(_who);

        public string Start(Bridge.Client client, long id, Dictionary<string, object> step)
        {
            if (_job != null) return "上一步还没做完";
            _kind = Req.Str(step, "do");
            _outcome = new Outcome();
            _client = client;
            _requestId = id;
            _job = Run(step, _outcome);
            return null;
        }

        /// <summary>Stops the running step, releases every input and answers it as cancelled.</summary>
        public void Halt()
        {
            if (_job != null)
            {
                _outcome.Ok = false;
                _outcome.Why = "已取消";
                Finish();
            }
            Pad?.ReleaseAll();
        }

        /// <summary>
        /// Advances the step by one frame. A routine that yields another IEnumerator runs it to
        /// completion first, like a Unity coroutine; plain yields end the frame.
        /// </summary>
        public void Tick()
        {
            if (_job == null) return;
            if (_stack.Count == 0) _stack.Push(_job);
            for (int guard = 0; guard < 1000; guard++)
            {
                var top = _stack.Peek();
                bool more;
                try { more = top.MoveNext(); }
                catch (Exception err)
                {
                    Plugin.Log.LogError("[actor] " + err);
                    _outcome.Ok = false;
                    _outcome.Why = "插件出错：" + err.Message;
                    Finish();
                    return;
                }
                if (!more)
                {
                    _stack.Pop();
                    if (_stack.Count == 0) { Finish(); return; }
                    continue;
                }
                if (top.Current is IEnumerator child) { _stack.Push(child); continue; }
                return;
            }
        }

        private readonly Stack<IEnumerator> _stack = new Stack<IEnumerator>();

        private void Finish()
        {
            _stack.Clear();
            Pad?.ReleaseAll();
            var chef = ChefNow();
            var reply = new JObj().Str("t", "reply").Int("id", _requestId).Bool("ok", _outcome.Ok).Str("why", _outcome.Why)
                .Raw("item", _outcome.Item).Str("by", _outcome.By)
                .Raw("held", chef != null ? _k.Item(Kitchen.Held(chef.gameObject)) : null);
            var extra = _outcome.Extra.ToString();
            var json = reply.ToString();
            if (extra != "{}") json = json.Substring(0, json.Length - 1) + "," + extra.Substring(1);
            Plugin.Bridge.Send(_client, json);
            _job = null;
            _client = null;
        }

        // ---- helpers -------------------------------------------------------------------

        private static bool Fail(Outcome o, string why, string item = null, string by = null)
        {
            o.Ok = false;
            o.Why = why;
            o.Item = item;
            o.By = by;
            return false;
        }

        /// <summary>Why the bot chef cannot act right now, or null.</summary>
        private string Blocked(out PlayerControls chef)
        {
            chef = ChefNow();
            if (Seat.SlotOf(Pad) == null) return "还没作为玩家加入（要在主菜单加入）";
            if (chef == null) return "现在没有厨师（不在关卡里）";
            if (_k.Flow == null || !_k.Flow.InRound) return "回合没在进行";
            if (chef.m_bRespawning) return "厨师掉下去了，正在等重生";
            return null;
        }

        /// <summary>Waits while the game blocks chef input (pause menu, dialogs); fails when the round ends.</summary>
        private IEnumerator Ready(Outcome o)
        {
            while (true)
            {
                var why = Blocked(out var chef);
                if (why == null && chef.CanButtonBePressed()) yield break;
                if (why != null && !(chef != null && chef.m_bRespawning))
                {
                    Fail(o, why);
                    yield break;
                }
                yield return null;
            }
        }

        private IEnumerator Press(PlayerInputLookup.LogicalButtonID id, int frames = 3)
        {
            Pad.Press(id, true);
            for (int i = 0; i < frames; i++) yield return null;
            Pad.Press(id, false);
            yield return null;
            yield return null;
        }

        private static string Owner(GameObject item, Kitchen k, out PlayerControls holder)
        {
            holder = null;
            foreach (var c in k.Chefs())
                if (Kitchen.Held(c.gameObject) == item) { holder = c; return Kitchen.Role(c); }
            return null;
        }

        private struct TargetInfo
        {
            public GameObject Go;
            public Kitchen.StationInfo Station;
            public GameObject Item;
        }

        private bool Resolve(Dictionary<string, object> step, Outcome o, out TargetInfo t)
        {
            t = default(TargetInfo);
            var raw = Req.Num(step, "target");
            if (raw == null) return Fail(o, "缺少目标");
            var go = _k.Find((int)raw.Value);
            if (go == null || !go.activeInHierarchy) return Fail(o, "目标已经不在了（被用掉或场景变了）");
            t.Go = go;
            t.Station = _k.StationOf(go);
            if (t.Station != null)
            {
                t.Item = t.Station.Attach != null ? t.Station.Attach.InspectItem() : null;
                return true;
            }
            if (go.GetComponent<PlayerControls>() != null) { t.Item = null; return true; }
            t.Item = go;
            var holder = Owner(go, _k, out _);
            if (holder != null) return Fail(o, "{item} 在{by}手里", _k.Item(go), holder);
            t.Station = _k.StationHolding(go);
            return true;
        }

        private Vector3 Position(TargetInfo t) => t.Station != null ? t.Station.Go.transform.position : t.Go.transform.position;

        private enum Aim { Pickup, Place, Interact }

        private static bool Matches(GameObject obj, TargetInfo t) =>
            obj != null && (obj == t.Go || (t.Station != null && obj == t.Station.Go) || (t.Item != null && obj == t.Item));

        /// <summary>
        /// The game has the target among its current interaction objects (pickup, placement,
        /// interactable or faced grid cell). Validated in play; the per-use check rejected boards.
        /// </summary>
        private static bool AnySelected(PlayerControls chef, TargetInfo t)
        {
            var near = chef.CurrentInteractionObjects;
            if (near == null) return false;
            return Matches(near.m_TheOriginalHandlePickup, t)
                || (near.m_iHandlePlacement is MonoBehaviour p && p != null && Matches(p.gameObject, t))
                || (near.m_interactable != null && Matches(near.m_interactable.gameObject, t))
                || (near.m_gridLocation is MonoBehaviour g && g != null && Matches(g.gameObject, t));
        }

        /// <summary>What the game would act on if the button for this use were pressed now.</summary>
        private static GameObject Selection(PlayerControls chef, Aim use)
        {
            var near = chef.CurrentInteractionObjects;
            if (near == null) return null;
            switch (use)
            {
                case Aim.Pickup: return near.m_TheOriginalHandlePickup;
                case Aim.Place: return near.m_iHandlePlacement is MonoBehaviour p && p != null ? p.gameObject : null;
                default:
                    if (near.m_interactable != null) return near.m_interactable.gameObject;
                    return near.m_gridLocation is MonoBehaviour g && g != null ? g.gameObject : null;
            }
        }

        // ---- movement ------------------------------------------------------------------

        private Nav.Cell ChefCell(PlayerControls chef)
        {
            var c = _k.Cell(chef.transform.position);
            return new Nav.Cell(c[0], c[1]);
        }

        private HashSet<long> OtherChefCells(PlayerControls self)
        {
            var blocked = new HashSet<long>();
            foreach (var c in _k.Chefs())
            {
                if (c == self) continue;
                var cell = _k.Cell(c.transform.position);
                blocked.Add(Nav.Key(cell[0], cell[1]));
            }
            return blocked;
        }

        private void Steer(PlayerControls chef, Vector3 toward, float magnitude)
        {
            var d = toward - chef.transform.position;
            d.y = 0;
            if (d.sqrMagnitude < 1e-6f) { Pad.Stop(); return; }
            d.Normalize();
            Pad.Move(chef, d.x * magnitude, d.z * magnitude);
        }

        /// <summary>How long a walk waits for the other chef to leave the only way or spot.</summary>
        private const float ChefWaitSec = 10f;

        private float CellSize => _k.Grid != null ? Vector3.Distance(_k.CellCenter(0, 0), _k.CellCenter(1, 0)) : 1.2f;

        /// <summary>
        /// Walks to one of the goal cells. Routes are tried strict, then by the rule the layout map
        /// is drawn with. When the map has no way even with the other chef ignored, the goal is on
        /// another side: one loose route is tried for props both physics checks reject and given up
        /// at its first stall, so a split kitchen costs no long walk into the counters.
        /// </summary>
        private IEnumerator Walk(Outcome o, HashSet<long> goals, bool dash, float timeoutSec)
        {
            float deadline = Time.realtimeSinceStartup + timeoutSec;
            int replans = 0, looks = 0;
            float nextDash = 0f;
            float waitingForChefSince = -1f;
            bool loose = false;
            while (true)
            {
                yield return Ready(o);
                if (o.Why != null) yield break;
                var chef = ChefNow();
                var start = ChefCell(chef);
                if (goals.Contains(Nav.Key(start)) && (chef.transform.position - _k.CellCenter(start.X, start.Z)).XZ().magnitude < CellSize * 0.3f)
                {
                    Pad.Stop();
                    yield break;
                }
                var others = OtherChefCells(chef);
                var route = Nav.Route(_k, chef, start, goals, others) ?? Nav.Route(_k, chef, start, goals, others, Nav.Mode.Edges);
                loose = false;
                if (route == null && Nav.Route(_k, chef, start, goals, new HashSet<long>(), Nav.Mode.Edges) != null)
                {
                    // Only the other chef in the way (standing on the one free cell next to a crate,
                    // or in a one-cell gap): wait for them to step away, up to ChefWaitSec.
                    if (waitingForChefSince < 0) waitingForChefSince = Time.realtimeSinceStartup;
                    if (Time.realtimeSinceStartup - waitingForChefSince < ChefWaitSec && Time.realtimeSinceStartup < deadline)
                    {
                        Pad.Stop();
                        for (float until = Time.realtimeSinceStartup + 0.3f; Time.realtimeSinceStartup < until;) yield return null;
                        continue;
                    }
                    Fail(o, $"要站的位置或必经的路被{{by}}占着，等了 {ChefWaitSec:0} 秒还没让开", null, "partner");
                    yield break;
                }
                if (route == null)
                {
                    // Not on the map from here. Physics readings can drop a cell for a moment, so look
                    // again shortly before deciding; in a kitchen that moves, keep looking until the
                    // walk's deadline, since the way opens when the part comes round.
                    if ((looks++ < 3 || _k.Moving) && Time.realtimeSinceStartup < deadline)
                    {
                        Pad.Stop();
                        for (float until = Time.realtimeSinceStartup + 0.4f; Time.realtimeSinceStartup < until;) yield return null;
                        continue;
                    }
                    route = Nav.Route(_k, chef, start, goals, others, Nav.Mode.Loose);
                    if (route == null)
                    {
                        Fail(o, _k.Moving ? $"走不到：这关厨房会动，等了 {timeoutSec:0} 秒路还没通（中间隔着台面或墙）" : "走不到：按地图从我站的地方没有路通到那里（中间隔着台面或墙）");
                        yield break;
                    }
                    loose = true;
                }
                waitingForChefSince = -1f;
                if (route.Count == 0) route.Add(start);
                bool replan = false;
                float lastProgressAt = Time.realtimeSinceStartup, best = float.MaxValue;
                for (int i = 0; i < route.Count && !replan; i++)
                {
                    var cell = route[i];
                    // Into a portal: walk at the entry portal and count the step done once the chef is in the exit's cell.
                    bool hop = _k.IsHop(i == 0 ? start : route[i - 1], cell, out var portal);
                    var center = hop ? _k.CellCenter(portal.X, portal.Z) : _k.CellCenter(cell.X, cell.Z);
                    bool last = i == route.Count - 1;
                    if (hop) { best = float.MaxValue; lastProgressAt = Time.realtimeSinceStartup; }
                    while (true)
                    {
                        yield return Ready(o);
                        if (o.Why != null) yield break;
                        chef = ChefNow();
                        if (Time.realtimeSinceStartup > deadline) { Fail(o, "走了太久还没到"); yield break; }
                        if (hop)
                        {
                            var now = ChefCell(chef);
                            if (now.X == cell.X && now.Z == cell.Z) break;
                            var teleportable = chef.GetComponent<ServerTeleportablePlayer>();
                            if (teleportable != null && teleportable.IsTeleporting())
                            {
                                Pad.Stop();
                                lastProgressAt = Time.realtimeSinceStartup;
                                yield return null;
                                continue;
                            }
                        }
                        var offset = (center - chef.transform.position).XZ();
                        float dist = offset.magnitude;
                        if (!hop && dist < CellSize * (last ? 0.18f : 0.35f)) break;
                        if (dist < best - 0.02f) { best = dist; lastProgressAt = Time.realtimeSinceStartup; }
                        if (Time.realtimeSinceStartup - lastProgressAt > 0.8f) { replan = true; replans++; break; }
                        Steer(chef, center, last && !hop ? Mathf.Clamp(dist / CellSize * 1.5f, 0.45f, 1f) : 1f);
                        if (dash && !hop && Time.realtimeSinceStartup >= nextDash && route.Count - i >= 4 && Straight(route, i) && Vector3.Dot(chef.transform.forward.XZ().normalized, offset.normalized) > 0.95f)
                        {
                            nextDash = Time.realtimeSinceStartup + 1.2f;
                            Pad.Press(PlayerInputLookup.LogicalButtonID.Dash, true);
                            yield return null;
                            yield return null;
                            Pad.Press(PlayerInputLookup.LogicalButtonID.Dash, false);
                        }
                        yield return null;
                    }
                }
                Pad.Stop();
                if (!replan) yield break;
                if (loose && _k.Moving && Time.realtimeSinceStartup < deadline) continue;
                if (loose) { Fail(o, "走不到：按地图从我站的地方没有路通到那里，硬走也被挡住了"); yield break; }
                if (replans > 8) { Fail(o, "路上一直被挡住，换了几次路线都走不动"); yield break; }
            }
        }

        private static bool Straight(List<Nav.Cell> route, int from)
        {
            if (from + 4 >= route.Count) return false;
            int dx = route[from + 1].X - route[from].X, dz = route[from + 1].Z - route[from].Z;
            for (int j = from + 1; j < from + 4; j++)
                if (route[j + 1].X - route[j].X != dx || route[j + 1].Z - route[j].Z != dz) return false;
            return true;
        }

        /// <summary>
        /// Walks next to the target and turns until the game selects it for this use. When the game
        /// keeps selecting something else from one side (a neighbouring station), tries another side.
        /// </summary>
        private IEnumerator Approach(Outcome o, TargetInfo t, bool dash, Aim use)
        {
            var tc = _k.Cell(Position(t));
            var goals = new HashSet<long>();
            foreach (var n in Nav.Neighbours(tc[0], tc[1])) goals.Add(Nav.Key(n));
            if (t.Station == null) goals.Add(Nav.Key(tc[0], tc[1]));
            GameObject wrong = null;
            for (int side = 0; side < 3 && goals.Count > 0; side++)
            {
                yield return Walk(o, goals, dash, 20f);
                if (o.Why != null) yield break;
                float until = Time.realtimeSinceStartup + 1.2f;
                while (Time.realtimeSinceStartup < until)
                {
                    yield return Ready(o);
                    if (o.Why != null) yield break;
                    var chef = ChefNow();
                    var facing = (Position(t) - chef.transform.position).XZ().normalized;
                    bool aligned = Vector3.Dot(chef.transform.forward.XZ().normalized, facing) > 0.9f;
                    var selected = Selection(chef, use);
                    if (aligned && AnySelected(chef, t)) { Pad.Stop(); yield break; }
                    if (selected != null) wrong = selected;
                    Steer(chef, Position(t), 0.3f);
                    yield return null;
                }
                Pad.Stop();
                goals.Remove(Nav.Key(ChefCell(ChefNow())));
                // Another side only helps when one is reachable; otherwise report what the game selects.
                if (goals.Count == 0 || Nav.Route(_k, ChefNow(), ChefCell(ChefNow()), goals, new HashSet<long>(), Nav.Mode.Edges) == null) break;
            }
            Fail(o, wrong != null ? "站到旁边了，但游戏选中的是旁边别的东西" : "站到旁边了，但游戏没有选中它");
            var st = wrong != null ? (_k.StationOf(wrong) ?? _k.StationHolding(wrong)) : null;
            if (st != null) o.Extra.Int("station", st.Go.GetInstanceID());
        }

        // ---- steps ---------------------------------------------------------------------

        private IEnumerator Run(Dictionary<string, object> step, Outcome o)
        {
            yield return Ready(o);
            if (o.Why != null) yield break;
            bool dash = Req.Bool(step, "dash");
            switch (_kind)
            {
                case "take": yield return Take(step, o, dash); break;
                case "put": yield return Put(step, o, dash, false); break;
                case "serve": yield return Put(step, o, dash, true); break;
                case "chop": yield return Work(step, o, dash, "chop"); break;
                case "wash": yield return Work(step, o, dash, "wash"); break;
                case "throw": yield return ThrowAt(step, o); break;
                case "go": yield return Go(step, o, dash); break;
                case "wait": yield return Wait(step, o); break;
                case "use": yield return Use(step, o, dash); break;
                case "extinguish": yield return Spray(step, o, dash); break;
                default: Fail(o, "不认识的动作：" + _kind); break;
            }
            if (o.Why == null) o.Ok = true;
        }

        private IEnumerator Take(Dictionary<string, object> step, Outcome o, bool dash)
        {
            var chef = ChefNow();
            var held = Kitchen.Held(chef.gameObject);
            if (held != null) { Fail(o, "手里已经拿着{item}，要先放下", _k.Item(held)); yield break; }
            if (!Resolve(step, o, out var t)) yield break;
            if (t.Station != null && t.Go == t.Station.Go)
            {
                if (t.Station.Kind == "crate")
                {
                    var fire = t.Go.GetComponent<ServerFlammable>();
                    if (fire != null && fire.OnFire()) { Fail(o, "食材箱着火了，拿不了"); yield break; }
                }
                else if (t.Item == null) { Fail(o, "上面是空的"); yield break; }
            }
            yield return Approach(o, t, dash, Aim.Pickup);
            if (o.Why != null) yield break;
            if (t.Item != null && t.Station != null && Kitchen.Users.ContainsKey(t.Station.Go.GetInstanceID()) && t.Item.GetComponent<ServerWorkableItem>() != null && !t.Item.GetComponent<ServerWorkableItem>().HasFinished())
            { Fail(o, "{item} 正在被切，切完才能拿", _k.Item(t.Item)); yield break; }
            // A press right after the previous step's press is sometimes not taken; one more try after re-aiming.
            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (attempt > 0)
                {
                    var got = Kitchen.Held(ChefNow().gameObject);
                    if (got != null) { o.Item = _k.Item(got); yield break; }
                    yield return Approach(o, t, false, Aim.Pickup);
                    if (o.Why != null) yield break;
                }
                yield return Press(PlayerInputLookup.LogicalButtonID.PickupAndDrop);
                for (float until = Time.realtimeSinceStartup + 0.5f; Time.realtimeSinceStartup < until;)
                {
                    held = Kitchen.Held(ChefNow().gameObject);
                    if (held != null) { o.Item = _k.Item(held); yield break; }
                    yield return null;
                }
            }
            Fail(o, "按了两次拿取，手里还是空的（游戏没接受）", t.Item != null ? _k.Item(t.Item) : null);
        }

        private IEnumerator Put(Dictionary<string, object> step, Outcome o, bool dash, bool serve)
        {
            var chef = ChefNow();
            var held = Kitchen.Held(chef.gameObject);
            if (held == null) { Fail(o, "手里是空的"); yield break; }
            if (!Resolve(step, o, out var t)) yield break;
            if (serve && (t.Station == null || t.Station.Kind != "pass")) { Fail(o, "上菜的目标要是出餐口"); yield break; }
            yield return Approach(o, t, dash, Aim.Place);
            if (o.Why != null) yield break;
            chef = ChefNow();
            var carrier = chef.GetComponent<ServerPlayerAttachmentCarrier>();
            var handler = PlayerControlsHelper.GetControllingPlacementHandler_Server(t.Station != null ? (t.Item ?? t.Station.Go) : t.Go);
            if (handler == null && t.Station != null) handler = PlayerControlsHelper.GetControllingPlacementHandler_Server(t.Station.Go);
            var dir = (Position(t) - chef.transform.position).XZ();
            if (handler != null && !handler.CanHandlePlacement(carrier, new Vector2(dir.x, dir.z).normalized, new PlacementContext(PlacementContext.Source.Player)))
            {
                if (t.Item != null && t.Item != held) Fail(o, "游戏不让把手里的东西放上去，上面有{item}", _k.Item(t.Item));
                else Fail(o, "游戏不让把{item}放到这里", _k.Item(held));
                yield break;
            }
            string heldBefore = _k.Item(held);
            string targetBefore = t.Item != null ? _k.Item(t.Item) : null;
            int deliveries = Hooks.Deliveries, failed = Hooks.FailedDeliveries;
            // By id: a held item the game destroys on placement (dirty plates into the sink, an
            // ingredient into a pot) compares equal to null afterwards under Unity's rules.
            int heldId = held.GetInstanceID();
            int targetItemId = t.Item != null ? t.Item.GetInstanceID() : 0;
            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (attempt > 0) { yield return Approach(o, t, false, Aim.Place); if (o.Why != null) yield break; }
                yield return Press(PlayerInputLookup.LogicalButtonID.PickupAndDrop);
                for (float until = Time.realtimeSinceStartup + 0.6f; Time.realtimeSinceStartup < until;)
                {
                    chef = ChefNow();
                    var now = Kitchen.Held(chef.gameObject);
                    bool handChanged = now == null || now.GetInstanceID() != heldId || _k.Item(now) != heldBefore;
                    bool targetChanged = t.Item != null && targetItemId != heldId && _k.Item(t.Item) != targetBefore;
                    bool changed = handChanged || targetChanged;
                    if (serve)
                    {
                        if (Hooks.Deliveries > deliveries) { o.Extra.Bool("delivered", true); yield break; }
                        if (Hooks.FailedDeliveries > failed) { Fail(o, "出餐口没收：盘里的菜不符合任何订单", heldBefore); yield break; }
                    }
                    else if (changed)
                    {
                        o.Item = heldBefore;
                        if (t.Item != null && targetItemId != heldId) o.Extra.Raw("into", _k.Item(t.Item));
                        yield break;
                    }
                    yield return null;
                }
                if (serve && Kitchen.Held(ChefNow().gameObject) == null) { o.Extra.Bool("delivered", false); yield break; }
            }
            Fail(o, "按了两次放下，东西还在手里（游戏没接受）", heldBefore);
        }

        private IEnumerator Work(Dictionary<string, object> step, Outcome o, bool dash, string what)
        {
            var chef = ChefNow();
            var held = Kitchen.Held(chef.gameObject);
            if (held != null) { Fail(o, (what == "chop" ? "切菜" : "洗碗") + "要空手，手里有{item}", _k.Item(held)); yield break; }
            if (!Resolve(step, o, out var t)) yield break;
            if (t.Station == null) { Fail(o, "目标不是站点"); yield break; }
            var sink = t.Station.Go.GetComponent<ServerWashingStation>();
            if (what == "chop")
            {
                if (t.Station.Kind != "board") { Fail(o, "这不是砧板"); yield break; }
                if (t.Item == null) { Fail(o, "砧板上没东西"); yield break; }
                var w = t.Item.GetComponent<ServerWorkableItem>();
                if (w == null) { Fail(o, "{item} 不用切", _k.Item(t.Item)); yield break; }
                if (w.HasFinished()) { Fail(o, "{item} 已经切好了", _k.Item(t.Item)); yield break; }
            }
            else
            {
                if (sink == null) { Fail(o, "这不是水槽"); yield break; }
                if (Plates(sink) == 0) { Fail(o, "水槽里没有脏盘子"); yield break; }
            }
            yield return Approach(o, t, dash, Aim.Interact);
            if (o.Why != null) yield break;
            int target = what == "wash" ? Math.Max(0, Plates(sink) - (int)(Req.Num(step, "plates") ?? 99)) : 0;
            int startPlates = sink != null ? Plates(sink) : 0;
            int presses = 0;
            float deadline = Time.realtimeSinceStartup + (what == "chop" ? 20f : 40f);
            float idleSince = -1f;
            int stationId = t.Station.Go.GetInstanceID();
            while (true)
            {
                yield return Ready(o);
                if (o.Why != null) yield break;
                chef = ChefNow();
                if (what == "chop")
                {
                    var item = t.Station.Attach.InspectItem();
                    if (item == null) { Fail(o, "砧板上的东西被拿走了"); yield break; }
                    var w = item.GetComponent<ServerWorkableItem>();
                    if (w == null || w.HasFinished()) { o.Item = _k.Item(item); yield break; }
                }
                else
                {
                    int left = Plates(sink);
                    if (left <= target) { o.Extra.Int("washed", startPlates - left).Int("left", left); yield break; }
                }
                bool working = Kitchen.Users.TryGetValue(stationId, out var user) && user == chef.gameObject.GetInstanceID();
                if (!working)
                {
                    if (idleSince < 0) idleSince = Time.realtimeSinceStartup;
                    if (presses == 0 || Time.realtimeSinceStartup - idleSince > 0.4f)
                    {
                        if (presses++ >= 4) { Fail(o, what == "chop" ? "按了切菜但厨师没开始切" : "按了洗碗但厨师没开始洗"); yield break; }
                        if (!AnySelected(chef, t)) { yield return Approach(o, t, false, Aim.Interact); if (o.Why != null) yield break; }
                        yield return Press(PlayerInputLookup.LogicalButtonID.WorkstationInteract);
                        idleSince = -1f;
                        continue;
                    }
                }
                else idleSince = -1f;
                if (Time.realtimeSinceStartup > deadline) { Fail(o, "做了太久还没完成"); yield break; }
                yield return null;
            }
        }

        private static readonly HarmonyLib.AccessTools.FieldRef<ServerWashingStation, int> SinkPlates = HarmonyLib.AccessTools.FieldRefAccess<ServerWashingStation, int>("m_plateCount");
        private static int Plates(ServerWashingStation sink) => SinkPlates(sink);

        private IEnumerator ThrowAt(Dictionary<string, object> step, Outcome o)
        {
            var chef = ChefNow();
            var held = Kitchen.Held(chef.gameObject);
            if (held == null) { Fail(o, "手里是空的"); yield break; }
            if (held.GetComponent<ServerThrowableItem>() == null) { Fail(o, "{item} 不能扔（只有食材能扔）", _k.Item(held)); yield break; }
            if (!Resolve(step, o, out var t)) yield break;
            string item = _k.Item(held);
            float until = Time.realtimeSinceStartup + 0.5f;
            while (Time.realtimeSinceStartup < until)
            {
                chef = ChefNow();
                var facing = (Position(t) - chef.transform.position).XZ().normalized;
                if (Vector3.Dot(chef.transform.forward.XZ().normalized, facing) > 0.97f) break;
                Steer(chef, Position(t), 0.25f);
                yield return null;
            }
            Pad.Stop();
            yield return Press(PlayerInputLookup.LogicalButtonID.WorkstationInteract, 2);
            for (until = Time.realtimeSinceStartup + 0.6f; Time.realtimeSinceStartup < until;)
            {
                if (Kitchen.Held(ChefNow().gameObject) == null) { o.Item = item; yield break; }
                yield return null;
            }
            Fail(o, "按了扔，{item} 还在手里", item);
        }

        private IEnumerator Go(Dictionary<string, object> step, Outcome o, bool dash)
        {
            var x = Req.Num(step, "x");
            var z = Req.Num(step, "z");
            if (x != null && z != null)
            {
                int gx = (int)x.Value, gz = (int)z.Value;
                if (!Nav.Walkable(_k, ChefNow(), gx, gz))
                {
                    var occupant = _k.Occupant(gx, gz);
                    var station = occupant != null ? _k.StationOf(occupant) : null;
                    if (station != null) Fail(o, $"({gx},{gz}) 站不了人，那一格是站点", null);
                    else Fail(o, occupant != null ? $"({gx},{gz}) 站不了人，那一格被占着" : $"({gx},{gz}) 站不了人，那里没有地面或放不下厨师");
                    if (station != null) o.Extra.Int("station", station.Go.GetInstanceID());
                    yield break;
                }
                yield return Walk(o, new HashSet<long> { Nav.Key(gx, gz) }, dash, 20f);
                yield break;
            }
            if (!Resolve(step, o, out var t)) yield break;
            var tc = _k.Cell(Position(t));
            var goals = new HashSet<long>();
            foreach (var n in Nav.Neighbours(tc[0], tc[1])) goals.Add(Nav.Key(n));
            yield return Walk(o, goals, dash, 20f);
        }

        private IEnumerator Use(Dictionary<string, object> step, Outcome o, bool dash)
        {
            if (!Resolve(step, o, out var t)) yield break;
            // Space 6-5: using a terminal starts piloting it with the stick for as long as the session lasts.
            if (t.Station != null && t.Station.Kind == "terminal") { Fail(o, "控制台要一直用摇杆驾驶，我开不了，要交给队友"); yield break; }
            yield return Approach(o, t, dash, Aim.Interact);
            if (o.Why != null) yield break;
            var interactable = ChefNow().CurrentInteractionObjects.m_interactable;
            var button = interactable != null && interactable.UsePlacementButton ? PlayerInputLookup.LogicalButtonID.PickupAndDrop : PlayerInputLookup.LogicalButtonID.WorkstationInteract;
            yield return Press(button);
        }

        private IEnumerator Spray(Dictionary<string, object> step, Outcome o, bool dash)
        {
            var chef = ChefNow();
            var held = Kitchen.Held(chef.gameObject);
            if (held == null || held.GetComponent<ServerFireExtinguishSpray>() == null) { Fail(o, "要先拿着灭火器"); yield break; }
            if (!Resolve(step, o, out var t)) yield break;
            var fire = (t.Station != null ? t.Station.Go : t.Go).GetComponent<ServerFlammable>();
            if (fire == null || !fire.OnFire()) { Fail(o, "目标没着火"); yield break; }
            var tc = _k.Cell(Position(t));
            var goals = new HashSet<long>();
            foreach (var n in Nav.Neighbours(tc[0], tc[1])) goals.Add(Nav.Key(n));
            yield return Walk(o, goals, dash, 15f);
            if (o.Why != null) yield break;
            float deadline = Time.realtimeSinceStartup + 12f;
            Pad.Press(PlayerInputLookup.LogicalButtonID.WorkstationInteract, true);
            while (fire.OnFire())
            {
                yield return Ready(o);
                if (o.Why != null) yield break;
                if (Time.realtimeSinceStartup > deadline) { Fail(o, "喷了很久火还没灭"); yield break; }
                chef = ChefNow();
                var facing = (Position(t) - chef.transform.position).XZ().normalized;
                if (Vector3.Dot(chef.transform.forward.XZ().normalized, facing) < 0.97f) Steer(chef, Position(t), 0.25f);
                else Pad.Stop();
                yield return null;
            }
            Pad.Press(PlayerInputLookup.LogicalButtonID.WorkstationInteract, false);
        }

        private IEnumerator Wait(Dictionary<string, object> step, Outcome o)
        {
            string until = Req.Str(step, "until") ?? "seconds";
            float seconds = (float)(Req.Num(step, "seconds") ?? 30);
            float deadline = Time.realtimeSinceStartup + Mathf.Clamp(seconds, 0.1f, 120f);
            TargetInfo t = default(TargetInfo);
            if (until != "seconds" && !Resolve(step, o, out t)) yield break;
            while (true)
            {
                if (_k.Flow == null || !_k.Flow.InRound) { Fail(o, "回合没在进行"); yield break; }
                if (until == "seconds")
                {
                    if (Time.realtimeSinceStartup >= deadline) yield break;
                }
                else
                {
                    var holder = t.Station != null ? t.Station.Go : null;
                    var item = holder != null && t.Station.Attach != null ? t.Station.Attach.InspectItem() : t.Item;
                    if (holder == null && (t.Item == null || !t.Item.activeInHierarchy)) { Fail(o, "等的东西不在了"); yield break; }
                    string state = Condition(until, holder, item, out bool met, out string bad);
                    if (bad != null) { Fail(o, bad, item != null ? _k.Item(item) : null); yield break; }
                    if (met) { o.Item = item != null ? _k.Item(item) : null; o.Extra.Str("state", state); yield break; }
                    if (Time.realtimeSinceStartup >= deadline) { Fail(o, "等到超时还没好（" + state + "）", item != null ? _k.Item(item) : null); yield break; }
                }
                yield return null;
            }
        }

        private static string Condition(string until, GameObject station, GameObject item, out bool met, out string bad)
        {
            met = false;
            bad = null;
            switch (until)
            {
                case "cooked":
                {
                    var cooking = item != null ? item.GetComponent<ServerCookingHandler>() : null;
                    var mixing = item != null ? item.GetComponent<ServerMixingHandler>() : null;
                    if (cooking == null && mixing == null) { bad = "那里没有在加热或搅拌的容器"; return ""; }
                    if (cooking != null)
                    {
                        var state = cooking.GetCookedOrderState();
                        met = cooking.IsCooked();
                        if (cooking.IsBurning()) { bad = "等不到了，{item}"; return "糊了"; }
                        return met ? "熟了" : state.ToString();
                    }
                    met = mixing.IsMixed();
                    return met ? "搅好了" : "还在搅";
                }
                case "chopped":
                {
                    var w = item != null ? item.GetComponent<ServerWorkableItem>() : null;
                    met = item != null && (w == null || w.HasFinished());
                    if (item == null) { bad = "上面没东西"; return ""; }
                    return met ? "切好了" : "还没切完";
                }
                case "item":
                    met = item != null;
                    return met ? "有东西了" : "还是空的";
                case "empty":
                    met = item == null;
                    return met ? "空了" : "上面还有东西";
                case "plates":
                {
                    var stack = item != null ? item.GetComponent<ServerPlateStackBase>() : null;
                    met = stack != null && stack.GetSize() > 0 || item != null && item.GetComponent<ServerPlate>() != null;
                    return met ? "有盘子了" : "还没有盘子";
                }
                default:
                    bad = "不认识的等待条件：" + until;
                    return "";
            }
        }
    }

    internal static class VectorXZ
    {
        public static Vector3 XZ(this Vector3 v) => new Vector3(v.x, 0f, v.z);
    }
}
