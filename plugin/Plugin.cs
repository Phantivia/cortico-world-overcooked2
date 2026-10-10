using System;
using System.Collections;
using System.Collections.Generic;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// In-game end of the Cortico overcooked2 World (docs/protocol.md). Requests carry `op` and
    /// `id` and get one `reply`; `state` frames go out five times a second and right after any
    /// game event; `ev` frames go out as the hooks fire.
    /// </summary>
    [BepInPlugin("ai.cortico.overcooked2", "Cortico Overcooked 2", Version)]
    public sealed class Plugin : BaseUnityPlugin
    {
        public const string Version = "0.1.0";
        public const int Protocol = 1;
        private const float StateInterval = 0.2f;

        internal static ManualLogSource Log;
        internal static Bridge Bridge;
        internal static Kitchen Kitchen;

        private ConfigEntry<int> _port;
        private readonly Dictionary<string, Actor> _actors = new Dictionary<string, Actor>();
        private float _nextState;
        private bool _stateDue;
        private string _lastPhase = "other";
        private string _lastLevel;

        private void Awake()
        {
            Log = Logger;
            Application.runInBackground = true;
            _port = Config.Bind("Bridge", "Port", 47640, "127.0.0.1 TCP port the Cortico World connects to.");
            Kitchen = new Kitchen();
            _actors["bot"] = new Actor(Kitchen, "bot");
            _actors["test"] = new Actor(Kitchen, "test");
            Bridge = new Bridge(_port.Value);
            Log.LogInfo($"[overcooked2] listening on 127.0.0.1:{_port.Value}");
        }

        /// <summary>True once the patches are in. Touching PCPadInputProvider before the game
        /// has its debug config fails its static constructor for the rest of the session, so
        /// patching waits for the game's managers and InControl.</summary>
        internal static bool Ready;
        private float _nextReadyCheck;
        private float _nextIdentity;

        private void Install()
        {
            if (Ready || Time.realtimeSinceStartup < _nextReadyCheck) return;
            _nextReadyCheck = Time.realtimeSinceStartup + 0.5f;
            if (!InControl.InputManager.IsSetup || FindObjectOfType<GameDebugManager>() == null || FindObjectOfType<PlayerInputLookup>() == null) return;
            var harmony = new Harmony("ai.cortico.overcooked2");
            harmony.PatchAll(typeof(Plugin).Assembly);
            int gates = Focus.Install(harmony);
            Ready = true;
            Log.LogInfo($"[overcooked2] patched; focus gates: {gates}");
        }

        private void OnDestroy()
        {
            Bridge?.Dispose();
        }

        private void Update()
        {
            if (!Application.runInBackground) Application.runInBackground = true;
            Install();
            if (!Ready) { while (Bridge.TryDequeue(out var early)) if (Req.Str(early.Frame, "op") == "_connected") Bridge.Send(early.From, new JObj().Str("t", "hello").Int("protocol", Protocol).Str("version", Version).ToString()); else if (Req.Num(early.Frame, "id") is double rid) Reply(early.From, (long)rid, false, "游戏还在启动"); return; }
            try { Kitchen.Refresh(); }
            catch (Exception err) { Log.LogError("[overcooked2] refresh: " + err); }
            while (Bridge.TryDequeue(out var request))
            {
                try { Handle(request); }
                catch (Exception err)
                {
                    Log.LogError("[overcooked2] request failed: " + err);
                    var id = Req.Num(request.Frame, "id");
                    if (id != null) Reply(request.From, (long)id.Value, false, err.GetType().Name + ": " + err.Message);
                }
            }
            foreach (var actor in _actors.Values) actor.Tick();
            if (Time.realtimeSinceStartup >= _nextIdentity)
            {
                _nextIdentity = Time.realtimeSinceStartup + 0.5f;
                Identity.Apply();
            }
            Lifecycle();
            foreach (var ev in Hooks.Drain())
            {
                Bridge.Broadcast(ev);
                _stateDue = true;
            }
            if (Bridge.ClientCount > 0 && (_stateDue || Time.unscaledTime >= _nextState))
            {
                _stateDue = false;
                _nextState = Time.unscaledTime + StateInterval;
                try { Bridge.BroadcastState(StateFrame()); }
                catch (Exception err) { Log.LogError("[overcooked2] state: " + err); }
            }
        }

        private static string StateFrame()
        {
            var json = Kitchen.StateJson();
            return "{\"t\":\"state\"," + json.Substring(1);
        }

        /// <summary>Level, round start and round end as events; counters reset per level.</summary>
        private void Lifecycle()
        {
            string phase = Kitchen.Phase();
            string level = null;
            if (phase != "other")
            {
                var entry = GameUtils.GetGameSession()?.LevelSettings?.SceneDirectoryVarientEntry;
                level = entry != null && entry.LevelConfig != null ? entry.LevelConfig.name : UnityEngine.SceneManagement.SceneManager.GetActiveScene().name;
            }
            if (level != null && level != _lastLevel)
            {
                Hooks.ResetLevel();
                Hooks.Emit(Hooks.Ev("level").Str("level", level));
            }
            if (phase == "round" && _lastPhase != "round") Hooks.Emit(Hooks.Ev("round.start").Num("timeLeft", Kitchen.TimeLeft() ?? 0));
            if (phase != "round" && _lastPhase == "round") Hooks.Emit(Hooks.Ev("round.end").Str("phase", phase));
            if (phase == "other" && _lastPhase != "other") Hooks.Emit(Hooks.Ev("level.exit"));
            _lastPhase = phase;
            _lastLevel = level ?? (phase == "other" ? null : _lastLevel);
        }

        private void Reply(Bridge.Client to, long id, bool ok, string why, string extra = null)
        {
            var json = new JObj().Str("t", "reply").Int("id", id).Bool("ok", ok).Str("why", why).ToString();
            if (extra != null) json = json.Substring(0, json.Length - 1) + "," + extra + "}";
            Bridge.Send(to, json);
        }

        private void Handle(Bridge.Request request)
        {
            var f = request.Frame;
            string op = Req.Str(f, "op");
            long id = (long)(Req.Num(f, "id") ?? 0);
            string who = Req.Str(f, "who") == "test" ? "test" : "bot";
            switch (op)
            {
                case "_connected":
                    Bridge.Send(request.From, new JObj().Str("t", "hello").Int("protocol", Protocol).Str("version", Version).ToString());
                    _stateDue = true;
                    return;
                case "_disconnected":
                    if (Bridge.ClientCount == 0) foreach (var a in _actors.Values) a.Halt();
                    return;
                case "join":
                {
                    var why = Seat.Join(who);
                    Reply(request.From, id, why == null, why);
                    return;
                }
                case "leave":
                {
                    _actors[who].Halt();
                    var why = Seat.Leave(who);
                    Reply(request.From, id, why == null, why);
                    return;
                }
                case "act":
                {
                    var step = f.TryGetValue("step", out var s) ? s as Dictionary<string, object> : null;
                    if (step == null) { Reply(request.From, id, false, "缺少 step"); return; }
                    var why = _actors[who].Start(request.From, id, step);
                    if (why != null) Reply(request.From, id, false, why);
                    return;
                }
                case "identity":
                    Identity.Set(Req.Str(f, "botName"), Req.Str(f, "partnerName"), Req.Bool(f, "botFirstColour"));
                    Reply(request.From, id, true, null);
                    return;
                case "halt":
                    _actors[who].Halt();
                    Reply(request.From, id, true, null);
                    return;
                case "press":
                {
                    // Raw pad input for tests: menus listen to the first player's pad only.
                    if (_actors[who].Busy) { Reply(request.From, id, false, "动作进行中"); return; }
                    var pad = Seat.Attach(who);
                    if (pad == null) { Reply(request.From, id, false, "虚拟手柄不可用"); return; }
                    StartCoroutine(PressRaw(request.From, id, pad, Req.Str(f, "button"), (float)(Req.Num(f, "x") ?? 0), (float)(Req.Num(f, "y") ?? 0), (float)(Req.Num(f, "seconds") ?? 0.1)));
                    return;
                }
                case "cell":
                    if (Kitchen.Grid == null) { Reply(request.From, id, false, "不在厨房里"); return; }
                    Reply(request.From, id, true, null, "\"cell\":" + Kitchen.CellHits((int)(Req.Num(f, "x") ?? 0), (int)(Req.Num(f, "z") ?? 0)));
                    return;
                case "look":
                    StartCoroutine(Capture(request.From, id, (int)(Req.Num(f, "width") ?? 768)));
                    return;
                default:
                    Reply(request.From, id, false, "不认识的请求：" + op);
                    return;
            }
        }

        private IEnumerator PressRaw(Bridge.Client to, long id, VirtualPad pad, string button, float x, float y, float seconds)
        {
            InControl.InputControlType type = InControl.InputControlType.None;
            if (!string.IsNullOrEmpty(button))
            {
                try { type = (InControl.InputControlType)Enum.Parse(typeof(InControl.InputControlType), button); }
                catch { Reply(to, id, false, "不认识的按键：" + button); yield break; }
                pad.Press(type, true);
            }
            pad.Stick(x, y);
            float until = Time.realtimeSinceStartup + Mathf.Clamp(seconds, 0.02f, 5f);
            while (Time.realtimeSinceStartup < until) yield return null;
            pad.ReleaseAll();
            yield return null;
            yield return null;
            Reply(to, id, true, null);
        }

        private IEnumerator Capture(Bridge.Client to, long id, int width)
        {
            yield return new WaitForEndOfFrame();
            Texture2D full = null, scaled = null;
            try
            {
                full = new Texture2D(Screen.width, Screen.height, TextureFormat.RGB24, false);
                full.ReadPixels(new Rect(0, 0, Screen.width, Screen.height), 0, 0);
                full.Apply();
                byte[] png;
                if (width > 0 && width < Screen.width)
                {
                    int height = Mathf.RoundToInt(Screen.height * (width / (float)Screen.width));
                    var rt = RenderTexture.GetTemporary(width, height);
                    Graphics.Blit(full, rt);
                    var previous = RenderTexture.active;
                    RenderTexture.active = rt;
                    scaled = new Texture2D(width, height, TextureFormat.RGB24, false);
                    scaled.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                    scaled.Apply();
                    RenderTexture.active = previous;
                    RenderTexture.ReleaseTemporary(rt);
                    png = scaled.EncodeToPNG();
                }
                else png = full.EncodeToPNG();
                Reply(to, id, true, null, "\"png\":" + Json.Quote(Convert.ToBase64String(png)));
            }
            catch (Exception err) { Reply(to, id, false, "截图失败：" + err.Message); }
            finally
            {
                if (full != null) Destroy(full);
                if (scaled != null) Destroy(scaled);
            }
        }
    }
}
