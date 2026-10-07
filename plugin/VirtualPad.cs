using System;
using System.Collections.Generic;
using HarmonyLib;
using InControl;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// The bot's gamepad: an InControl device the game treats like any attached controller, so the
    /// game itself engages it as a local player and gives it its own chef. Buttons are addressed by
    /// the game's logical ids and mapped to physical pad buttons through the runtime controls mapping.
    /// </summary>
    internal sealed class VirtualPad : InputDevice
    {
        private readonly HashSet<InputControlType> _down = new HashSet<InputControlType>();
        private Vector2 _stick;

        public VirtualPad(string name) : base(name)
        {
            Meta = name;
            AddControl(InputControlType.LeftStickLeft, "Left Stick Left");
            AddControl(InputControlType.LeftStickRight, "Left Stick Right");
            AddControl(InputControlType.LeftStickUp, "Left Stick Up");
            AddControl(InputControlType.LeftStickDown, "Left Stick Down");
            AddControl(InputControlType.RightStickLeft, "Right Stick Left");
            AddControl(InputControlType.RightStickRight, "Right Stick Right");
            AddControl(InputControlType.RightStickUp, "Right Stick Up");
            AddControl(InputControlType.RightStickDown, "Right Stick Down");
            AddControl(InputControlType.LeftTrigger, "Left Trigger");
            AddControl(InputControlType.RightTrigger, "Right Trigger");
            AddControl(InputControlType.DPadUp, "DPad Up");
            AddControl(InputControlType.DPadDown, "DPad Down");
            AddControl(InputControlType.DPadLeft, "DPad Left");
            AddControl(InputControlType.DPadRight, "DPad Right");
            AddControl(InputControlType.Action1, "A");
            AddControl(InputControlType.Action2, "B");
            AddControl(InputControlType.Action3, "X");
            AddControl(InputControlType.Action4, "Y");
            AddControl(InputControlType.LeftBumper, "Left Bumper");
            AddControl(InputControlType.RightBumper, "Right Bumper");
            AddControl(InputControlType.LeftStickButton, "Left Stick Button");
            AddControl(InputControlType.RightStickButton, "Right Stick Button");
            AddControl(InputControlType.Start, "Start");
            AddControl(InputControlType.Back, "Back");
        }

        public override void Update(ulong updateTick, float deltaTime)
        {
            float x = _stick.x, y = _stick.y;
            GetControl(InputControlType.LeftStickLeft).UpdateWithValue(Mathf.Max(0f, -x), updateTick, deltaTime);
            GetControl(InputControlType.LeftStickRight).UpdateWithValue(Mathf.Max(0f, x), updateTick, deltaTime);
            float up = InputManager.InvertYAxis ? -y : y;
            GetControl(InputControlType.LeftStickUp).UpdateWithValue(Mathf.Max(0f, up), updateTick, deltaTime);
            GetControl(InputControlType.LeftStickDown).UpdateWithValue(Mathf.Max(0f, -up), updateTick, deltaTime);
            foreach (var type in Buttons) GetControl(type).UpdateWithState(_down.Contains(type), updateTick, deltaTime);
            Commit(updateTick, deltaTime);
        }

        private static readonly InputControlType[] Buttons =
        {
            InputControlType.Action1, InputControlType.Action2, InputControlType.Action3, InputControlType.Action4,
            InputControlType.LeftBumper, InputControlType.RightBumper, InputControlType.LeftStickButton,
            InputControlType.RightStickButton, InputControlType.Start, InputControlType.Back,
            InputControlType.DPadUp, InputControlType.DPadDown, InputControlType.DPadLeft, InputControlType.DPadRight,
        };

        /// <summary>Stick in the chef's world frame: x toward +X, y toward +Z; length 0..1.</summary>
        public void Move(PlayerControls chef, float worldX, float worldZ)
        {
            float sx = chef.Movement.XAxisAllignment != 0 ? -1f : 1f;
            float sz = chef.Movement.YAxisAllignment != 0 ? -1f : 1f;
            _stick = Vector2.ClampMagnitude(new Vector2(sx * worldX, sz * worldZ), 1f);
        }

        public void Stop() => _stick = Vector2.zero;

        /// <summary>Stick in the pad frame (menus, world map): x right, y up.</summary>
        public void Stick(float x, float y) => _stick = Vector2.ClampMagnitude(new Vector2(x, y), 1f);

        public void Press(PlayerInputLookup.LogicalButtonID id, bool down)
        {
            foreach (var type in Physical(id))
            {
                if (down) _down.Add(type);
                else _down.Remove(type);
            }
        }

        public void Press(InputControlType type, bool down)
        {
            if (down) _down.Add(type);
            else _down.Remove(type);
        }

        public bool AnyInput => _down.Count > 0 || _stick != Vector2.zero;

        public void ReleaseAll()
        {
            _down.Clear();
            _stick = Vector2.zero;
        }

        private readonly Dictionary<PlayerInputLookup.LogicalButtonID, InputControlType[]> _mapping = new Dictionary<PlayerInputLookup.LogicalButtonID, InputControlType[]>();

        private InputControlType[] Physical(PlayerInputLookup.LogicalButtonID id)
        {
            if (_mapping.TryGetValue(id, out var cached)) return cached;
            var types = new List<InputControlType>();
            foreach (var b in PlayerInputLookup.GetRealButtons(id, PadSide.Both))
            {
                var t = ToControl(b);
                if (t != InputControlType.None) types.Add(t);
            }
            if (types.Count == 0) throw new InvalidOperationException("游戏没有给 " + id + " 绑定手柄按键");
            var result = types.ToArray();
            _mapping[id] = result;
            return result;
        }

        /// <summary>Same table as StandardActionSet.CreateForJoystick.</summary>
        private static InputControlType ToControl(ControlPadInput.Button b)
        {
            switch (b)
            {
                case ControlPadInput.Button.A: return InputControlType.Action1;
                case ControlPadInput.Button.B: return InputControlType.Action2;
                case ControlPadInput.Button.X: return InputControlType.Action3;
                case ControlPadInput.Button.Y: return InputControlType.Action4;
                case ControlPadInput.Button.LB: return InputControlType.LeftBumper;
                case ControlPadInput.Button.RB: return InputControlType.RightBumper;
                case ControlPadInput.Button.LTrigger: return InputControlType.LeftTrigger;
                case ControlPadInput.Button.RTrigger: return InputControlType.RightTrigger;
                case ControlPadInput.Button.DPadLeft: return InputControlType.DPadLeft;
                case ControlPadInput.Button.DPadRight: return InputControlType.DPadRight;
                case ControlPadInput.Button.DPadUp: return InputControlType.DPadUp;
                case ControlPadInput.Button.DPadDown: return InputControlType.DPadDown;
                case ControlPadInput.Button.Back: return InputControlType.Back;
                case ControlPadInput.Button.Start: return InputControlType.Start;
                case ControlPadInput.Button.LeftAnalog: return InputControlType.LeftStickButton;
                case ControlPadInput.Button.RightAnalog: return InputControlType.RightStickButton;
                default: return InputControlType.None;
            }
        }
    }

}
