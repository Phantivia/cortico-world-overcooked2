using System;
using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using OrderController;
using Team17.Online;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// Reads the host-side kitchen into the state frame (docs/protocol.md). Cells are indices of
    /// the kitchen's main grid; x grows to the right and z toward the top of the screen.
    /// </summary>
    internal sealed class Kitchen
    {
        internal sealed class StationInfo
        {
            public ServerAttachStation Attach;
            public GameObject Go;
            public string Kind;
        }

        private static readonly AccessTools.FieldRef<ServerCookingStation, bool> IsCooking = AccessTools.FieldRefAccess<ServerCookingStation, bool>("m_isCooking");
        private static readonly AccessTools.FieldRef<ServerWashingStation, int> SinkPlates = AccessTools.FieldRefAccess<ServerWashingStation, int>("m_plateCount");
        private static readonly AccessTools.FieldRef<ServerWashingStation, float> SinkTimer = AccessTools.FieldRefAccess<ServerWashingStation, float>("m_cleaningTimer");
        private static readonly AccessTools.FieldRef<ServerWashingStation, GameObject> SinkWasher = AccessTools.FieldRefAccess<ServerWashingStation, GameObject>("m_interactor");
        private static readonly AccessTools.FieldRef<ServerCookingHandler, CookingStateMessage> CookData = AccessTools.FieldRefAccess<ServerCookingHandler, CookingStateMessage>("m_ServerData");
        private static readonly AccessTools.FieldRef<ServerOrderControllerBase, List<ServerOrderData>> ActiveOrders = AccessTools.FieldRefAccess<ServerOrderControllerBase, List<ServerOrderData>>("m_activeOrders");
        private static readonly AccessTools.FieldRef<IngredientPropertiesComponent, IngredientOrderNode> IngredientNode = AccessTools.FieldRefAccess<IngredientPropertiesComponent, IngredientOrderNode>("m_ingredientOrderNode");

        public static readonly int FloorMask = LayerMask.GetMask("Ground", "SlopedGround");

        private string _sceneKey;
        private readonly List<StationInfo> _stations = new List<StationInfo>();
        private readonly Dictionary<int, GameObject> _objects = new Dictionary<int, GameObject>();
        private float _nextRescan;
        private string _layoutJson;
        private float _nextLayout;

        public GridManager Grid { get; private set; }
        public ServerKitchenFlowControllerBase Flow { get; private set; }
        public List<StationInfo> Stations => _stations;

        /// <summary>Washers by sink and choppers by board, kept by the interaction hooks.</summary>
        public static readonly Dictionary<int, int> Users = new Dictionary<int, int>();

        public GameObject Find(int id)
        {
            if (_objects.TryGetValue(id, out var go) && go != null) return go;
            return null;
        }

        public StationInfo StationOf(GameObject go)
        {
            foreach (var s in _stations) if (s.Go == go) return s;
            return null;
        }

        /// <summary>The station an item currently sits on, or null.</summary>
        public StationInfo StationHolding(GameObject item)
        {
            if (item == null) return null;
            foreach (var s in _stations) if (s.Attach != null && s.Attach.InspectItem() == item) return s;
            return null;
        }

        public void Refresh()
        {
            string key = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name;
            if (key != _sceneKey || Time.unscaledTime >= _nextRescan)
            {
                Flow = UnityEngine.Object.FindObjectOfType<ServerKitchenFlowControllerBase>();
                if (key != _sceneKey) { Users.Clear(); _layoutJson = null; }
                _sceneKey = key;
                _nextRescan = Time.unscaledTime + 3f;
                Rescan();
            }
        }

        private void Rescan()
        {
            _stations.Clear();
            Grid = null;
            if (Flow == null) return;
            var any = PlayerIDProvider.s_AllProviders.Count > 0 ? PlayerIDProvider.s_AllProviders._items[0] : null;
            Grid = GameUtils.GetGridManager(any != null ? any.transform : Flow.transform);
            var drying = new HashSet<GameObject>();
            foreach (var sink in UnityEngine.Object.FindObjectsOfType<WashingStation>())
                if (sink.m_dryingStation != null) drying.Add(sink.m_dryingStation.gameObject);
            foreach (var attach in UnityEngine.Object.FindObjectsOfType<ServerAttachStation>())
            {
                var go = attach.gameObject;
                if (go.GetComponent<PlayerControls>() != null) continue;
                _stations.Add(new StationInfo { Attach = attach, Go = go, Kind = Classify(go, drying) });
            }
            foreach (var sink in UnityEngine.Object.FindObjectsOfType<ServerWashingStation>())
                if (_stations.All(s => s.Go != sink.gameObject)) _stations.Add(new StationInfo { Go = sink.gameObject, Kind = "sink" });
            // Corner pieces and other fixed counters that hold nothing but can burn: listed so a fire on
            // them has a name and a target.
            foreach (var flammable in UnityEngine.Object.FindObjectsOfType<ServerFlammable>())
            {
                var go = flammable.gameObject;
                if (go.GetComponent<ServerPhysicalAttachment>() != null || go.GetComponent<PlayerControls>() != null) continue;
                if (_stations.Any(s => s.Go == go)) continue;
                _stations.Add(new StationInfo { Go = go, Kind = "fixture" });
            }
        }

        private static string Classify(GameObject go, HashSet<GameObject> drying)
        {
            if (go.GetComponent<PlateStation>() != null) return "pass";
            if (go.GetComponent<WashingStation>() != null) return "sink";
            if (go.GetComponent<RubbishBin>() != null) return "bin";
            if (go.GetComponent<PlateReturnStation>() != null) return drying.Contains(go) ? "drying" : "return";
            if (go.GetComponent<PickupItemSpawner>() != null) return "crate";
            if (go.GetComponent<Workstation>() != null) return "board";
            var cooker = go.GetComponent<ServerCookingStation>();
            if (cooker != null)
            {
                switch (cooker.StationType)
                {
                    case CookingStationType.Oven: return "oven";
                    case CookingStationType.DeepFatFryer: return "fryer";
                    default: return "stove";
                }
            }
            if (go.GetComponent<MixingStation>() != null) return "mixer";
            if (go.GetComponent<ServerPlacementItemSpawner>() != null) return "dispenser";
            return "counter";
        }

        public static GameObject Held(GameObject chef)
        {
            var carrier = chef.GetComponent<ServerPlayerAttachmentCarrier>();
            return carrier != null ? carrier.InspectCarriedItem() : null;
        }

        public int[] Cell(Vector3 position)
        {
            if (Grid == null) return new[] { 0, 0 };
            var c = Grid.GetUnclampedGridLocationFromPos(position);
            return new[] { c.X, c.Z };
        }

        /// <summary>Continuous position in cell units.</summary>
        public float[] CellPos(Vector3 position)
        {
            if (Grid == null) return new[] { 0f, 0f };
            Vector3 zero = Grid.GetPosFromGridLocation(new GridIndex(0, 0, 0));
            Vector3 ax = Grid.GetPosFromGridLocation(new GridIndex(1, 0, 0)) - zero;
            Vector3 az = Grid.GetPosFromGridLocation(new GridIndex(0, 0, 1)) - zero;
            Vector3 d = position - zero;
            return new[] { Vector3.Dot(d, ax) / ax.sqrMagnitude, Vector3.Dot(d, az) / az.sqrMagnitude };
        }

        public Vector3 CellCenter(int x, int z) => Grid.GetPosFromGridLocation(new GridIndex(x, 0, z));

        /// <summary>
        /// Cells up to this far outside the placement grid count when there is floor: some kitchens
        /// have a walkway past the grid's edge (1-3's way round below the bin).
        /// </summary>
        public const int GridMargin = 3;

        public bool InGrid(int x, int z)
        {
            var h = Grid.GetGridHalfSize();
            return x >= -h.X && x <= h.X && z >= -h.Z && z <= h.Z;
        }

        public bool InReach(int x, int z)
        {
            var h = Grid.GetGridHalfSize();
            return x >= -h.X - GridMargin && x <= h.X + GridMargin && z >= -h.Z - GridMargin && z <= h.Z + GridMargin;
        }

        /// <summary>The grid's occupant of a cell; cells outside the grid have none.</summary>
        public GameObject Occupant(int x, int z) => InGrid(x, z) ? Grid.GetGridOccupant(new GridIndex(x, 0, z)) : null;

        // ---- chefs ---------------------------------------------------------------------

        public IEnumerable<PlayerControls> Chefs()
        {
            var all = PlayerIDProvider.s_AllProviders;
            for (int i = 0; i < all.Count; i++)
            {
                var p = all._items[i];
                if (p == null) continue;
                var pc = p.GetComponent<PlayerControls>();
                if (pc != null && pc.gameObject.activeInHierarchy) yield return pc;
            }
        }

        public static string Role(PlayerControls chef)
        {
            var id = chef.PlayerIDProvider != null ? chef.PlayerIDProvider.GetID() : PlayerInputLookup.Player.Count;
            if (id == PlayerInputLookup.Player.Count) return "other";
            var slot = Seat.Slot;
            if (slot != null && (int)PlayerInputLookup.GetPadForPlayer(id) == (int)slot.Value) return "bot";
            return "partner";
        }

        public PlayerControls BotChef() => ChefOf(Seat.Bot);

        public PlayerControls ChefOf(VirtualPad pad)
        {
            var slot = Seat.SlotOf(pad);
            if (slot == null) return null;
            foreach (var c in Chefs())
            {
                var id = c.PlayerIDProvider != null ? c.PlayerIDProvider.GetID() : PlayerInputLookup.Player.Count;
                if (id != PlayerInputLookup.Player.Count && (int)PlayerInputLookup.GetPadForPlayer(id) == (int)slot.Value) return c;
            }
            return null;
        }

        // ---- items ---------------------------------------------------------------------

        public string Item(GameObject go)
        {
            if (go == null) return null;
            _objects[go.GetInstanceID()] = go;
            var o = new JObj().Int("id", go.GetInstanceID());
            var name = CleanName(go.name);
            string kind = "other";
            var stack = go.GetComponent<ServerPlateStackBase>();
            if (stack != null)
            {
                kind = "plate";
                o.Bool("dirty", go.GetComponent<ServerDirtyPlateStack>() != null).Int("stack", stack.GetSize());
            }
            else if (go.GetComponent<ServerPlate>() != null) kind = "plate";
            else if (go.GetComponent<ServerCookableContainer>() != null) kind = ContainerKind(go.name);
            else if (go.GetComponent<ServerMixableContainer>() != null) kind = "mixingbowl";
            else if (go.GetComponent<FireExtinguishSpray>() != null) kind = "extinguisher";
            var ingredient = go.GetComponent<IngredientPropertiesComponent>();
            var work = go.GetComponent<ServerWorkableItem>();
            if (ingredient != null || work != null)
            {
                kind = "ingredient";
                var node = ingredient != null ? IngredientNode(ingredient) : null;
                if (node != null) name = node.name;
                if (work != null) o.Num("chop", work.HasFinished() ? 1 : work.GetProgress());
            }
            o.Str("kind", kind).Str("name", name);
            var cooking = go.GetComponent<ServerCookingHandler>();
            if (cooking != null)
            {
                var data = CookData(cooking);
                o.Str("cook", CookWord(data.m_cookingState, go)).Num("cookProgress", cooking.AccessCookingTime > 0 ? cooking.GetCookingProgress() / cooking.AccessCookingTime : 0).Num("cookTime", cooking.AccessCookingTime);
            }
            var mixing = go.GetComponent<ServerMixingHandler>();
            if (mixing != null && cooking == null)
            {
                var state = mixing.GetMixedOrderState();
                o.Str("cook", state == MixedCompositeOrderNode.MixingProgress.OverMixed ? "burnt" : state == MixedCompositeOrderNode.MixingProgress.Mixed ? "done" : "raw")
                 .Num("cookProgress", mixing.AccessMixingTime > 0 ? mixing.GetMixingProgress() / mixing.AccessMixingTime : 0);
            }
            var container = go.GetComponent<ServerIngredientContainer>();
            if (container != null)
            {
                var parts = new List<string>();
                foreach (var n in container.GetContents()) Flatten(n, null, parts);
                o.Raw("contents", JObj.Strings(parts));
            }
            return o.ToString();
        }

        private static string ContainerKind(string name)
        {
            var n = name.ToLowerInvariant();
            if (n.Contains("pan")) return "pan";
            if (n.Contains("basket") || n.Contains("fryer")) return "basket";
            if (n.Contains("tray")) return "tray";
            return "pot";
        }

        private static string CookWord(CookingUIController.State s, GameObject go)
        {
            switch (s)
            {
                case CookingUIController.State.Progressing:
                    var container = go.GetComponent<ServerIngredientContainer>();
                    return container != null && container.GetContentsCount() == 0 ? "raw" : "cooking";
                case CookingUIController.State.Completed: return "done";
                case CookingUIController.State.OverDoing: return "overdone";
                case CookingUIController.State.Ruined: return "burnt";
                default: return "raw";
            }
        }

        /// <summary>Ingredient names with a processing suffix, e.g. `SushiRice:done`.</summary>
        public static void Flatten(AssembledDefinitionNode node, string suffix, List<string> parts)
        {
            switch (node)
            {
                case IngredientAssembledNode ing:
                    if (ing.m_ingriedientOrderNode != null) parts.Add(ing.m_ingriedientOrderNode.name + (suffix != null ? ":" + suffix : ""));
                    break;
                case CookedCompositeAssembledNode cooked:
                    string s = cooked.m_progress == CookedCompositeOrderNode.CookingProgress.Burnt ? "burnt" : cooked.m_progress == CookedCompositeOrderNode.CookingProgress.Cooked ? "done" : "raw";
                    foreach (var c in cooked.m_composition) Flatten(c, s, parts);
                    break;
                case MixedCompositeAssembledNode mixed:
                    string m = mixed.m_progress == MixedCompositeOrderNode.MixingProgress.OverMixed ? "burnt" : mixed.m_progress == MixedCompositeOrderNode.MixingProgress.Mixed ? "mixed" : "raw";
                    foreach (var c in mixed.m_composition) Flatten(c, m, parts);
                    break;
                case CompositeAssembledNode comp:
                    foreach (var c in comp.m_composition) Flatten(c, suffix, parts);
                    break;
                case ItemAssembledNode item:
                    if (item.m_itemOrderNode != null) parts.Add(item.m_itemOrderNode.name);
                    break;
            }
        }

        public static void FlattenOrder(OrderDefinitionNode node, string suffix, List<string> parts)
        {
            switch (node)
            {
                case IngredientOrderNode ing:
                    parts.Add(ing.name + (suffix != null ? ":" + suffix : ""));
                    break;
                case CookedCompositeOrderNode cooked:
                    foreach (var c in cooked.m_composition) FlattenOrder(c, "done", parts);
                    break;
                case MixedCompositeOrderNode mixed:
                    foreach (var c in mixed.m_composition) FlattenOrder(c, "mixed", parts);
                    break;
                case CompositeOrderNode comp:
                    foreach (var c in comp.m_composition) FlattenOrder(c, suffix, parts);
                    break;
                default:
                    if (node != null) parts.Add(node.name);
                    break;
            }
        }

        public static string CleanName(string name)
        {
            int paren = name.IndexOf(" (", StringComparison.Ordinal);
            if (paren > 0) name = name.Substring(0, paren);
            return name.Replace("(Clone)", "").Trim();
        }

        // ---- state frame ---------------------------------------------------------------

        public string StateJson()
        {
            var o = new JObj().Int("frame", Time.frameCount).Num("at", Time.realtimeSinceStartup)
                .Str("scene", UnityEngine.SceneManagement.SceneManager.GetActiveScene().name)
                .Bool("joined", Seat.Slot != null)
                .Bool("paused", TimeManager.IsPaused(TimeManager.PauseLayer.Main));
            if (Flow == null || Grid == null)
            {
                return o.Str("phase", "other").Raw("orders", "[]").Raw("chefs", "[]").Raw("stations", "[]").Raw("loose", "[]").ToString();
            }
            var settings = GameUtils.GetGameSession()?.LevelSettings?.SceneDirectoryVarientEntry;
            if (settings != null && settings.LevelConfig != null) o.Str("level", settings.LevelConfig.name);
            o.Str("phase", Phase());
            var left = TimeLeft();
            if (left.HasValue) o.Num("timeLeft", left.Value);
            var monitor = Flow.GetMonitorForTeam(TeamID.One);
            if (monitor != null)
            {
                var sc = monitor.Score;
                o.Obj("score", new JObj().Int("total", sc.GetTotalScore()).Int("deliveries", sc.TotalSuccessfulDeliveries)
                    .Int("failed", Hooks.FailedDeliveries).Int("base", sc.TotalBaseScore).Int("tips", sc.TotalTipsScore)
                    .Int("expired", Hooks.ExpiredOrders));
                o.Raw("orders", JObj.Array(Orders(monitor)));
            }
            else o.Raw("orders", "[]");

            var held = new HashSet<GameObject>();
            var chefs = new List<string>();
            foreach (var c in Chefs())
            {
                _objects[c.gameObject.GetInstanceID()] = c.gameObject;
                var h = Held(c.gameObject);
                if (h != null) held.Add(h);
                var pos = CellPos(c.transform.position);
                var co = new JObj().Int("id", c.gameObject.GetInstanceID()).Str("role", Role(c)).Str("name", c.gameObject.name)
                    .Raw("cell", Pair(Cell(c.transform.position))).Raw("pos", "[" + Json.Num(pos[0]) + "," + Json.Num(pos[1]) + "]")
                    .Raw("facing", "[" + Json.Num(c.transform.forward.x) + "," + Json.Num(c.transform.forward.z) + "]")
                    .Raw("held", Item(h));
                foreach (var pair in Users) if (pair.Value == c.gameObject.GetInstanceID()) co.Int("using", pair.Key);
                if (c.IsDashing()) co.Bool("dashing", true);
                if (c.m_bRespawning) co.Num("respawnIn", 1);
                chefs.Add(co.ToString());
            }
            o.Raw("chefs", JObj.Array(chefs));

            var onStations = new HashSet<GameObject>();
            var stations = new List<string>();
            foreach (var s in _stations)
            {
                if (s.Go == null) continue;
                _objects[s.Go.GetInstanceID()] = s.Go;
                var so = new JObj().Int("id", s.Go.GetInstanceID()).Str("kind", s.Kind).Str("name", CleanName(s.Go.name)).Raw("cell", Pair(Cell(s.Go.transform.position)));
                var item = s.Attach != null ? s.Attach.InspectItem() : null;
                if (item != null) { onStations.Add(item); so.Raw("item", Item(item)); }
                if (s.Kind == "crate")
                {
                    var prefab = s.Go.GetComponent<PickupItemSpawner>().m_itemPrefab;
                    var ing = prefab != null ? prefab.GetComponent<IngredientPropertiesComponent>() : null;
                    var node = ing != null ? IngredientNode(ing) : null;
                    so.Str("gives", node != null ? node.name : prefab != null ? CleanName(prefab.name) : null);
                }
                var fire = s.Go.GetComponent<ServerFlammable>();
                if (fire != null && fire.OnFire()) so.Bool("onFire", true);
                var cooker = s.Go.GetComponent<ServerCookingStation>();
                if (cooker != null && IsCooking(cooker)) so.Bool("active", true);
                var sink = s.Go.GetComponent<ServerWashingStation>();
                if (sink != null)
                {
                    so.Int("plates", SinkPlates(sink));
                    var time = s.Go.GetComponent<WashingStation>().m_cleanPlateTime;
                    if (SinkPlates(sink) > 0 && time > 0) so.Num("progress", Mathf.Clamp01(SinkTimer(sink) / time));
                    var washer = SinkWasher(sink);
                    if (washer != null) Users[s.Go.GetInstanceID()] = washer.GetInstanceID();
                    else Users.Remove(s.Go.GetInstanceID());
                }
                stations.Add(so.ToString());
            }
            o.Raw("stations", JObj.Array(stations));

            var loose = new List<string>();
            foreach (var t in UnityEngine.Object.FindObjectsOfType<ServerPhysicalAttachment>())
            {
                var go = t.gameObject;
                if (held.Contains(go) || onStations.Contains(go) || go.transform.parent != null && go.transform.parent.GetComponentInParent<ServerIngredientContainer>() != null) continue;
                if (t.IsAttached()) continue;
                var json = Item(go);
                var throwable = go.GetComponent<ServerThrowableItem>();
                var lo = json.Substring(0, json.Length - 1) + ",\"cell\":" + Pair(Cell(go.transform.position)) + (throwable != null && throwable.IsFlying() ? ",\"flying\":true" : "") + "}";
                loose.Add(lo);
            }
            o.Raw("loose", JObj.Array(loose));
            if (_layoutJson == null || Time.unscaledTime >= _nextLayout)
            {
                _layoutJson = Layout();
                _nextLayout = Time.unscaledTime + 2f;
            }
            o.Raw("layout", _layoutJson);
            return o.ToString();
        }

        private static string Pair(int[] c) => "[" + c[0] + "," + c[1] + "]";

        public string Phase()
        {
            if (Flow == null || Grid == null) return "other";
            if (Flow.InRound) return "round";
            var left = TimeLeft();
            return left.HasValue && left.Value <= 0.05f ? "over" : "kitchen";
        }

        public float? TimeLeft()
        {
            if (Flow == null || Flow.RoundTimer == null) return null;
            var timer = Flow.RoundTimer;
            if (timer is ServerModifiableRoundTimer) return timer.TimeElapsed;
            if (timer is ServerRoundTimer && GameUtils.GetLevelConfig() is KitchenLevelConfigBase config)
                return Mathf.Max(0f, config.GetTimeLimit() - timer.TimeElapsed);
            return null;
        }

        private static IEnumerable<string> Orders(ServerTeamMonitor monitor)
        {
            var list = monitor.OrdersController != null ? ActiveOrders(monitor.OrdersController) : null;
            if (list == null) yield break;
            foreach (var order in list) yield return OrderJson(order);
        }

        public static string OrderJson(ServerOrderData order)
        {
            var parts = new List<string>();
            var node = order.RecipeListEntry != null ? order.RecipeListEntry.m_order : null;
            FlattenOrder(node, null, parts);
            return new JObj().Int("id", order.ID.m_id).Str("dish", node != null ? node.name : "?").Raw("parts", JObj.Strings(parts))
                .Num("remaining", order.Remaining).Num("lifetime", order.Lifetime).ToString();
        }

        /// <summary>
        /// Rows from top (max z) to bottom: `.` floor a chef can walk to, `#` an occupant next to such
        /// floor (station, wall piece), space for anything else. Bounds cover only those cells.
        /// `regions` has the same shape: floor cells that one chef can walk between share a letter
        /// (`a`, `b`…), so a kitchen split by counters shows which side each cell is on.
        /// </summary>
        private string Layout()
        {
            var cells = new Dictionary<long, char>();
            var region = new Dictionary<long, char>();
            PlayerControls reference = null;
            foreach (var c in Chefs()) { reference = c; break; }
            int[] dx = { 1, -1, 0, 0 }, dz = { 0, 0, 1, -1 };
            char next = 'a';
            foreach (var c in Chefs())
            {
                var start = Cell(c.transform.position);
                if (region.ContainsKey(Key(start[0], start[1]))) continue;
                char letter = next++;
                // The chef stands here, so it is floor even when the cell centre is not.
                char own = CellChar(start[0], start[1]);
                cells[Key(start[0], start[1])] = own == ' ' || own == '#' ? '.' : own;
                region[Key(start[0], start[1])] = letter;
                var queue = new Queue<int[]>();
                queue.Enqueue(start);
                while (queue.Count > 0)
                {
                    var at = queue.Dequeue();
                    for (int i = 0; i < 4; i++)
                    {
                        int x = at[0] + dx[i], z = at[1] + dz[i];
                        long key = Key(x, z);
                        if (!InReach(x, z) || region.ContainsKey(key)) continue;
                        char ch = cells.TryGetValue(key, out var known) ? known : CellChar(x, z);
                        if (ch == ' ') continue;
                        cells[key] = ch;
                        if (ch == '#') continue;
                        if (!Nav.EdgeClear(this, reference, new Nav.Cell(at[0], at[1]), new Nav.Cell(x, z))) continue;
                        region[key] = letter;
                        queue.Enqueue(new[] { x, z });
                    }
                }
            }
            // Floor met only across a blocked edge belongs to no chef's side and is not drawn.
            foreach (var key in new List<long>(cells.Keys))
                if (cells[key] != '#' && !region.ContainsKey(key)) cells.Remove(key);
            if (cells.Count == 0) return null;
            int minX = int.MaxValue, maxX = int.MinValue, minZ = int.MaxValue, maxZ = int.MinValue;
            foreach (var key in cells.Keys)
            {
                int x = (int)(key >> 32), z = (int)(uint)key;
                minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minZ = Math.Min(minZ, z); maxZ = Math.Max(maxZ, z);
            }
            var rows = new List<string>();
            var sides = new List<string>();
            for (int z = maxZ; z >= minZ; z--)
            {
                var row = new char[maxX - minX + 1];
                var side = new char[maxX - minX + 1];
                for (int x = minX; x <= maxX; x++)
                {
                    row[x - minX] = cells.TryGetValue(Key(x, z), out var c) ? c : ' ';
                    side[x - minX] = region.TryGetValue(Key(x, z), out var r) ? r : ' ';
                }
                rows.Add(new string(row));
                sides.Add(new string(side));
            }
            return new JObj().Int("minX", minX).Int("maxX", maxX).Int("minZ", minZ).Int("maxZ", maxZ)
                .Raw("rows", JObj.Strings(rows)).Raw("regions", JObj.Strings(sides)).ToString();
        }

        private static long Key(int x, int z) => ((long)x << 32) ^ (uint)z;

        /// <summary>
        /// `.` floor; `&lt;` `&gt;` `^` `v` a moving floor (travelator) by the way it carries a chef;
        /// `#` any other occupant; space for no floor.
        /// </summary>
        public char CellChar(int x, int z)
        {
            var index = new GridIndex(x, 0, z);
            var center = Grid.GetPosFromGridLocation(index);
            var occupant = Occupant(x, z);
            if (occupant != null)
            {
                var surface = MovingFloor(occupant);
                if (surface == null) return '#';
                var v = surface.CalculateVelocityAtPoint(center, null);
                var ax = Grid.GetPosFromGridLocation(new GridIndex(x + 1, 0, z)) - center;
                var az = Grid.GetPosFromGridLocation(new GridIndex(x, 0, z + 1)) - center;
                float vx = Vector3.Dot(v, ax.normalized), vz = Vector3.Dot(v, az.normalized);
                if (Mathf.Abs(vx) < 0.01f && Mathf.Abs(vz) < 0.01f) return '.';
                return Mathf.Abs(vx) >= Mathf.Abs(vz) ? (vx > 0 ? '>' : '<') : (vz > 0 ? '^' : 'v');
            }
            return IsFloor(center) ? '.' : ' ';
        }

        /// <summary>A grid occupant that is a floor chefs walk on (travelator), not a station.</summary>
        public static IMovingSurface MovingFloor(GameObject occupant)
        {
            if (occupant.GetComponent<ServerAttachStation>() != null) return null;
            return occupant.GetComponent<Travelator>();
        }

        private static readonly int PlayersLayer = LayerMask.NameToLayer("Players");

        /// <summary>
        /// Floor under a cell centre: the first surface below that faces up, among those a chef
        /// collides with. Chefs, items and colliders chefs pass through are looked through; kill
        /// planes and water are triggers and so are never floor. Levels use their own layers for
        /// floors, so no layer is assumed.
        /// </summary>
        public static bool IsFloor(Vector3 center)
        {
            var hits = Physics.RaycastAll(center + Vector3.up * 3f, Vector3.down, 8f, ~0, QueryTriggerInteraction.Ignore);
            Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance));
            foreach (var h in hits)
            {
                var go = h.collider.gameObject;
                if (go.GetComponentInParent<PlayerControls>() != null || go.GetComponentInParent<ServerPhysicalAttachment>() != null) continue;
                if (h.collider.attachedRigidbody != null && !h.collider.attachedRigidbody.isKinematic) continue;
                if (PlayersLayer >= 0 && Physics.GetIgnoreLayerCollision(PlayersLayer, go.layer)) continue;
                return h.normal.y > 0.7f;
            }
            return false;
        }

        /// <summary>Every hit straight down through a cell, for diagnosing floor detection.</summary>
        public string CellHits(int x, int z)
        {
            var center = Grid.GetPosFromGridLocation(new GridIndex(x, 0, z));
            var hits = Physics.RaycastAll(center + Vector3.up * 3f, Vector3.down, 8f, ~0, QueryTriggerInteraction.Collide);
            Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance));
            var items = new List<string>();
            foreach (var h in hits)
                items.Add(new JObj().Str("name", h.collider.gameObject.name).Str("layer", LayerMask.LayerToName(h.collider.gameObject.layer))
                    .Bool("trigger", h.collider.isTrigger).Num("y", h.point.y).Num("normalY", h.normal.y).ToString());
            var occupant = Occupant(x, z);
            var o = new JObj().Num("centerY", center.y).Str("occupant", occupant != null ? occupant.name : null).Bool("floor", IsFloor(center)).Raw("hits", JObj.Array(items));
            var chef = BotChef() ?? Chefs().FirstOrDefault();
            if (chef != null)
            {
                var blocker = Nav.BodyBlocker(chef, new Vector3(center.x, chef.transform.position.y, center.z));
                o.Bool("walkable", Nav.Walkable(this, chef, x, z)).Str("bodyBlocker", blocker != null ? blocker.gameObject.name + "/" + LayerMask.LayerToName(blocker.gameObject.layer) : null);
            }
            return o.ToString();
        }
    }
}
