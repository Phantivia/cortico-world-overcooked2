using System;
using System.Collections.Generic;
using HarmonyLib;
using InControl;

namespace CorticoOvercooked2
{
    /// <summary>
    /// The virtual pads and their engagement as local players. `bot` is the bot's pad. `test`
    /// stands in for the human in unattended tests and is never attached unless asked for; its
    /// chef reports as `partner` like a human's. The game creates a user (and later a chef) for an
    /// engaged pad only on the front end, where engagement is unlocked.
    /// </summary>
    internal static class Seat
    {
        public static VirtualPad Bot;
        public static VirtualPad Test;

        private static readonly AccessTools.FieldRef<Dictionary<ControlPadInput.PadNum, StandardActionSet>> EngagedPads =
            AccessTools.StaticFieldRefAccess<Dictionary<ControlPadInput.PadNum, StandardActionSet>>(AccessTools.Field(typeof(PCPadInputProvider), "s_engagedPads"));

        private static readonly Func<ControlPadInput.PadNum, StandardActionSet> GetActionSet =
            AccessTools.MethodDelegate<Func<ControlPadInput.PadNum, StandardActionSet>>(AccessTools.Method(typeof(PCPadInputProvider), "GetActionSet"));

        public static VirtualPad Pad(string who) => who == "test" ? Test : Bot;

        public static VirtualPad Attach(string who)
        {
            if (!InputManager.IsSetup || !Plugin.Ready) return null;
            if (who == "test")
            {
                if (Test == null) { Test = new VirtualPad("Cortico Test Pad"); InputManager.AttachDevice(Test); }
                return Test;
            }
            if (Bot == null) { Bot = new VirtualPad("Cortico Bot Pad"); InputManager.AttachDevice(Bot); }
            return Bot;
        }

        /// <summary>The engagement slot a pad holds, or null.</summary>
        public static EngagementSlot? SlotOf(VirtualPad pad)
        {
            if (pad == null || !Plugin.Ready) return null;
            foreach (var pair in EngagedPads())
                if (pair.Value != null && pair.Value.Device == pad) return (EngagementSlot)pair.Key;
            return null;
        }

        public static EngagementSlot? Slot => SlotOf(Bot);

        public static bool IsVirtual(ControlPadInput.PadNum pad)
        {
            if (Bot == null && Test == null) return false;
            var set = GetActionSet(pad);
            return set != null && set.Device != null && (set.Device == Bot || set.Device == Test);
        }

        /// <summary>Starts engagement of a pad; null on success, otherwise why not.</summary>
        public static string Join(string who)
        {
            var pad = Attach(who);
            if (pad == null) return "游戏输入系统还没初始化";
            if (SlotOf(pad) != null) return null;
            if (Team17.Online.ServerUserSystem.EngagementsLocked || UnityEngine.Object.FindObjectOfType<T17FrontendFlow>() == null)
                return "只能在主菜单加入；大地图和关卡里游戏不接受新玩家";
            var manager = GameUtils.RequireManager<PlayerManager>();
            if (manager.GetUser(EngagementSlot.One) == null) return "等一号玩家先在标题画面按键进入";
            if (manager.IsBusy()) return "游戏正在处理另一个玩家的加入";
            if (!manager.HasFreeEngagementSlot()) return "本地玩家位已满";
            for (int i = 0; i < 12; i++)
            {
                var num = (ControlPadInput.PadNum)i;
                if (EngagedPads().ContainsKey(num)) continue;
                var set = GetActionSet(num);
                if (set == null || set.Device != pad) continue;
                manager.StartPadEngagement(num, null, null);
                return null;
            }
            return "游戏的手柄列表里找不到虚拟手柄";
        }

        public static string Leave(string who)
        {
            var slot = SlotOf(Pad(who));
            if (slot == null) return null;
            if (Team17.Online.ServerUserSystem.EngagementsLocked) return "只能在主菜单退出";
            GameUtils.RequireManager<PlayerManager>().DisengagePad(slot.Value);
            return null;
        }
    }
}
