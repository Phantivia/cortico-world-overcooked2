using System.Collections.Generic;
using System.Reflection;
using System.Reflection.Emit;
using HarmonyLib;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// The game drops all pad input while its window is unfocused. These patches move that rule to
    /// the device: human devices (keyboard, real pads) still count only while the game has focus;
    /// the bot pad counts always, so the bot keeps playing while the operator works in OBS.
    /// </summary>
    internal static class Focus
    {
        public static bool Always() => true;

        private static readonly MethodInfo IsFocused = AccessTools.PropertyGetter(typeof(Application), nameof(Application.isFocused));

        private static IEnumerable<CodeInstruction> ReplaceFocus(IEnumerable<CodeInstruction> code)
        {
            foreach (var op in code)
            {
                if (op.Calls(IsFocused)) op.operand = AccessTools.Method(typeof(Focus), nameof(Always));
                yield return op;
            }
        }

        public static int Install(Harmony harmony)
        {
            var transpiler = new HarmonyMethod(typeof(Focus), nameof(ReplaceFocus));
            var gates = new[]
            {
                AccessTools.Method(typeof(LogicalButtonBase), "CanProcessInput"),
                AccessTools.Method(typeof(LogicalPadValue<PCPadInputProvider>), "CanProcessInput"),
                AccessTools.Method(typeof(LogicalPCEngagementButton), "IsDown"),
                AccessTools.Method(typeof(PlayerControls), "CanButtonBePressed"),
            };
            foreach (var gate in gates) harmony.Patch(gate, transpiler: transpiler);
            var provider = typeof(PCPadInputProvider);
            harmony.Patch(AccessTools.Method(provider, "IsEngagementDown"), postfix: new HarmonyMethod(typeof(Focus), nameof(GateBool)));
            harmony.Patch(AccessTools.Method(provider, "IsDown"), postfix: new HarmonyMethod(typeof(Focus), nameof(GateBool)));
            harmony.Patch(AccessTools.Method(provider, "GetValue"), postfix: new HarmonyMethod(typeof(Focus), nameof(GateFloat)));
            return gates.Length;
        }

        private static void GateBool(ControlPadInput.PadNum _pad, ref bool __result)
        {
            if (__result && !Application.isFocused && !Seat.IsVirtual(_pad)) __result = false;
        }

        private static void GateFloat(ControlPadInput.PadNum _pad, ref float __result)
        {
            if (__result != 0f && !Application.isFocused && !Seat.IsVirtual(_pad)) __result = 0f;
        }
    }
}
