using System;
using System.Collections.Generic;
using HarmonyLib;
using OrderController;
using Team17.Online;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// Host-side game hooks turned into `ev` frames. Every chef-initiated server action runs inside
    /// one ServerPlayerControlsImpl_Default.Receive*Event call; the prefix records that chef as
    /// the actor, so hooks further down the same call (delivery, merging, binning) know who acted.
    /// Hooks outside such a call have no actor: the game did it (timers, conveyors, catches).
    /// </summary>
    internal static class Hooks
    {
        [ThreadStatic] public static GameObject Actor;
        public static int Deliveries;
        public static int FailedDeliveries;
        public static int ExpiredOrders;

        private static readonly List<string> Pending = new List<string>();

        public static List<string> Drain()
        {
            lock (Pending)
            {
                var copy = new List<string>(Pending);
                Pending.Clear();
                return copy;
            }
        }

        public static void ResetLevel()
        {
            FailedDeliveries = 0;
            ExpiredOrders = 0;
        }

        public static JObj Ev(string kind)
        {
            return new JObj().Str("t", "ev").Str("k", kind).Int("frame", Time.frameCount);
        }

        public static void Emit(JObj frame)
        {
            lock (Pending)
            {
                if (Pending.Count < 500) Pending.Add(frame.ToString());
            }
        }

        private static Kitchen K => Plugin.Kitchen;
        private static int Id(GameObject go) => go != null ? go.GetInstanceID() : 0;

        /// <summary>The station an object belongs to: itself, or the station it sits on.</summary>
        private static GameObject StationFor(GameObject go)
        {
            if (go == null) return null;
            if (K.StationOf(go) != null) return go;
            var holder = K.StationHolding(go);
            return holder != null ? holder.Go : null;
        }

        private static string ContentsKey(GameObject container)
        {
            var c = container != null ? container.GetComponent<ServerIngredientContainer>() : null;
            if (c == null) return "";
            var parts = new List<string>();
            foreach (var n in c.GetContents()) Kitchen.Flatten(n, null, parts);
            return string.Join(",", parts.ToArray());
        }

        // ---- carrying ------------------------------------------------------------------

        private sealed class CarryState
        {
            public GameObject Held;
            public string HeldJson;
            public string HeldContents;
            public GameObject Target;
            public GameObject TargetStation;
            public GameObject TargetItem;
            public string TargetContents;
        }

        private static CarryState Before(ServerPlayerControlsImpl_Default chef, GameObject target)
        {
            Actor = chef.gameObject;
            var held = Kitchen.Held(chef.gameObject);
            var station = StationFor(target);
            var targetItem = station != null ? K.StationOf(station)?.Attach?.InspectItem() : target;
            return new CarryState
            {
                Held = held,
                HeldJson = K.Item(held),
                HeldContents = ContentsKey(held),
                Target = target,
                TargetStation = station,
                TargetItem = targetItem,
                TargetContents = ContentsKey(targetItem),
            };
        }

        [HarmonyPatch(typeof(ServerPlayerControlsImpl_Default), nameof(ServerPlayerControlsImpl_Default.ReceivePickUpEvent))]
        private static class PickUp
        {
            private static void Prefix(ServerPlayerControlsImpl_Default __instance, GameObject _target, out CarryState __state) => __state = Before(__instance, _target);

            private static void Postfix(ServerPlayerControlsImpl_Default __instance, CarryState __state)
            {
                var now = Kitchen.Held(__instance.gameObject);
                if (now != null && now != __state.Held)
                {
                    var e = Ev("pickup").Int("chef", Id(__instance.gameObject)).Raw("item", K.Item(now));
                    if (__state.TargetStation != null) e.Int("from", Id(__state.TargetStation));
                    Emit(e);
                }
            }

            private static void Finalizer() => Actor = null;
        }

        [HarmonyPatch(typeof(ServerPlayerControlsImpl_Default), nameof(ServerPlayerControlsImpl_Default.ReceivePlaceEvent))]
        private static class Place
        {
            private static void Prefix(ServerPlayerControlsImpl_Default __instance, GameObject _target, out CarryState __state) => __state = Before(__instance, _target);

            private static void Postfix(ServerPlayerControlsImpl_Default __instance, CarryState __state)
            {
                if (__state.Held == null) return;
                var now = Kitchen.Held(__instance.gameObject);
                int chef = Id(__instance.gameObject);
                int to = Id(__state.TargetStation ?? __state.Target);
                if (now == null)
                {
                    // Into a container on the target (ingredient into a plate or pot) or onto the station.
                    var into = __state.TargetItem != null && __state.TargetItem != __state.Held && ContentsKey(__state.TargetItem) != __state.TargetContents ? __state.TargetItem : null;
                    var e = Ev("place").Int("chef", chef).Raw("item", __state.HeldJson).Int("to", to);
                    if (into != null) e.Int("into", Id(into)).Raw("result", K.Item(into));
                    if (__state.TargetStation == null && __state.Target == null) e.Bool("floor", true);
                    Emit(e);
                }
                else if (now == __state.Held && (ContentsKey(now) != __state.HeldContents || (__state.TargetItem != null && ContentsKey(__state.TargetItem) != __state.TargetContents)))
                {
                    // Contents moved between the held container and the target's container.
                    Emit(Ev("transfer").Int("chef", chef).Raw("item", K.Item(now)).Int("to", to)
                        .Raw("other", __state.TargetItem != null ? K.Item(__state.TargetItem) : null));
                }
                else if (now != __state.Held)
                {
                    Emit(Ev("swap").Int("chef", chef).Raw("item", __state.HeldJson).Raw("took", K.Item(now)).Int("to", to));
                }
            }

            private static void Finalizer() => Actor = null;
        }

        [HarmonyPatch(typeof(ServerPlayerControlsImpl_Default), nameof(ServerPlayerControlsImpl_Default.ReceiveTakeEvent))]
        private static class Drop
        {
            private static void Prefix(ServerPlayerControlsImpl_Default __instance, out GameObject __state)
            {
                Actor = __instance.gameObject;
                __state = Kitchen.Held(__instance.gameObject);
            }

            private static void Postfix(ServerPlayerControlsImpl_Default __instance, GameObject __state)
            {
                if (__state != null && Kitchen.Held(__instance.gameObject) == null)
                    Emit(Ev("drop").Int("chef", Id(__instance.gameObject)).Raw("item", K.Item(__state)));
            }

            private static void Finalizer() => Actor = null;
        }

        [HarmonyPatch(typeof(ServerPlayerControlsImpl_Default), nameof(ServerPlayerControlsImpl_Default.ReceiveThrowEvent))]
        private static class Throw
        {
            private static void Prefix(ServerPlayerControlsImpl_Default __instance, out string __state)
            {
                Actor = __instance.gameObject;
                __state = K.Item(Kitchen.Held(__instance.gameObject));
            }

            private static void Postfix(ServerPlayerControlsImpl_Default __instance, string __state)
            {
                if (__state != null && Kitchen.Held(__instance.gameObject) == null)
                    Emit(Ev("throw").Int("chef", Id(__instance.gameObject)).Raw("item", __state));
            }

            private static void Finalizer() => Actor = null;
        }

        [HarmonyPatch(typeof(ServerPlayerControlsImpl_Default), nameof(ServerPlayerControlsImpl_Default.ReceiveInteractEvent))]
        private static class Interact
        {
            private static void Prefix(ServerPlayerControlsImpl_Default __instance) => Actor = __instance.gameObject;
            private static void Finalizer() => Actor = null;
        }

        [HarmonyPatch(typeof(ServerPlayerControlsImpl_Default), nameof(ServerPlayerControlsImpl_Default.ReceiveTriggerInteractEvent))]
        private static class TriggerInteract
        {
            private static void Prefix(ServerPlayerControlsImpl_Default __instance) => Actor = __instance.gameObject;
            private static void Finalizer() => Actor = null;
        }

        private static GameObject ThrowerOf(GameObject item)
        {
            var throwable = item != null ? item.GetComponent<ServerThrowableItem>() : null;
            var thrower = throwable != null ? (throwable.GetThrower() ?? throwable.GetPreviousThrower()) : null;
            return thrower is MonoBehaviour mb ? mb.gameObject : null;
        }

        [HarmonyPatch(typeof(ServerAttachmentCatcher), nameof(ServerAttachmentCatcher.HandleCatch))]
        private static class ChefCatch
        {
            private static void Prefix(ICatchable _object, out GameObject __state) => __state = ThrowerOf(_object.AccessGameObject());

            private static void Postfix(ServerAttachmentCatcher __instance, ICatchable _object, GameObject __state)
            {
                var item = _object.AccessGameObject();
                var e = Ev("catch").Int("chef", Id(__instance.gameObject)).Raw("item", K.Item(item));
                if (__state != null) e.Int("from", Id(__state));
                Emit(e);
            }
        }

        [HarmonyPatch(typeof(ServerIngredientCatcher), nameof(ServerIngredientCatcher.HandleCatch))]
        private static class ContainerCatch
        {
            private static void Prefix(ICatchable _object, out string[] __state)
            {
                var item = _object.AccessGameObject();
                __state = new[] { K.Item(item), Id(ThrowerOf(item)).ToString() };
            }

            private static void Postfix(ServerIngredientCatcher __instance, string[] __state)
            {
                var container = __instance.gameObject;
                var station = K.StationHolding(container);
                var e = Ev("land").Raw("item", __state[0]).Int("into", Id(container)).Raw("result", K.Item(container));
                if (station != null) e.Int("to", Id(station.Go));
                if (__state[1] != "0") e.Int("chef", int.Parse(__state[1]));
                Emit(e);
            }
        }

        [HarmonyPatch(typeof(ServerAttachStation), nameof(ServerAttachStation.HandleCatch))]
        private static class StationCatch
        {
            private static void Prefix(ICatchable _object, out GameObject __state) => __state = ThrowerOf(_object.AccessGameObject());

            private static void Postfix(ServerAttachStation __instance, ICatchable _object, GameObject __state)
            {
                var e = Ev("land").Raw("item", K.Item(_object.AccessGameObject())).Int("to", Id(__instance.gameObject));
                if (__state != null) e.Int("chef", Id(__state));
                Emit(e);
            }
        }

        // ---- chopping and washing ------------------------------------------------------

        [HarmonyPatch(typeof(ServerWorkstation), "OnInteracterAdded")]
        private static class ChopStart
        {
            private static void Postfix(ServerWorkstation __instance, GameObject _interacter)
            {
                Kitchen.Users[Id(__instance.gameObject)] = Id(_interacter);
                Emit(Ev("chop.start").Int("chef", Id(_interacter)).Int("station", Id(__instance.gameObject)));
            }
        }

        [HarmonyPatch(typeof(ServerWorkstation), nameof(ServerWorkstation.OnInteracterRemoved))]
        private static class ChopStop
        {
            private static void Postfix(ServerWorkstation __instance) => Kitchen.Users.Remove(Id(__instance.gameObject));
        }

        [HarmonyPatch(typeof(ServerWorkableItem), nameof(ServerWorkableItem.DoWork), new[] { typeof(ServerAttachStation), typeof(GameObject), typeof(int) })]
        private static class ChopDone
        {
            private static void Prefix(ServerWorkableItem __instance, out bool __state) => __state = __instance.HasFinished();

            private static void Postfix(ServerWorkableItem __instance, ServerAttachStation _station, GameObject _worker, bool __state)
            {
                if (__state || !__instance.HasFinished()) return;
                Emit(Ev("chop.done").Int("chef", Id(_worker)).Int("station", Id(_station.gameObject)).Raw("item", K.Item(_station.InspectItem())));
            }
        }

        [HarmonyPatch(typeof(ServerWashingStation), "OnInteracterAdded")]
        private static class WashStart
        {
            private static void Postfix(ServerWashingStation __instance, GameObject _interacter) =>
                Emit(Ev("wash.start").Int("chef", Id(_interacter)).Int("station", Id(__instance.gameObject)));
        }

        private static readonly AccessTools.FieldRef<ServerWashingStation, GameObject> Washer = AccessTools.FieldRefAccess<ServerWashingStation, GameObject>("m_interactor");
        private static readonly AccessTools.FieldRef<ServerWashingStation, int> SinkPlates = AccessTools.FieldRefAccess<ServerWashingStation, int>("m_plateCount");

        [HarmonyPatch(typeof(ServerWashingStation), "SendCleanedPlate")]
        private static class WashPlate
        {
            private static void Postfix(ServerWashingStation __instance) =>
                Emit(Ev("wash.plate").Int("chef", Id(Washer(__instance))).Int("station", Id(__instance.gameObject)).Int("left", SinkPlates(__instance)));
        }

        // ---- cooking and fire ----------------------------------------------------------

        private static readonly AccessTools.FieldRef<ServerCookingHandler, CookingStateMessage> CookData = AccessTools.FieldRefAccess<ServerCookingHandler, CookingStateMessage>("m_ServerData");

        [HarmonyPatch(typeof(ServerCookingHandler), nameof(ServerCookingHandler.SetCookingProgress))]
        private static class Cook
        {
            private static void Prefix(ServerCookingHandler __instance, out CookingUIController.State __state) => __state = CookData(__instance).m_cookingState;

            private static void Postfix(ServerCookingHandler __instance, CookingUIController.State __state)
            {
                var now = CookData(__instance).m_cookingState;
                if (now == __state) return;
                string word = now == CookingUIController.State.Completed ? "done" : now == CookingUIController.State.OverDoing ? "overdone" : now == CookingUIController.State.Ruined ? "burnt" : null;
                if (word == null) return;
                var container = __instance.gameObject;
                var station = K.StationHolding(container);
                var e = Ev("cook").Str("state", word).Raw("item", K.Item(container));
                if (station != null) e.Int("station", Id(station.Go));
                Emit(e);
            }
        }

        [HarmonyPatch(typeof(ServerFlammable), nameof(ServerFlammable.Ignite))]
        private static class Ignite
        {
            private static void Prefix(ServerFlammable __instance, out bool __state) => __state = __instance.OnFire();

            private static void Postfix(ServerFlammable __instance, bool __state)
            {
                if (!__state && __instance.OnFire()) Emit(Ev("fire").Int("station", Id(__instance.gameObject)));
            }
        }

        [HarmonyPatch(typeof(ServerFlammable), nameof(ServerFlammable._Extinguish))]
        private static class Extinguish
        {
            private static void Prefix(ServerFlammable __instance, bool _shutdown, out bool __state) => __state = !_shutdown && __instance.OnFire();

            private static void Postfix(ServerFlammable __instance, bool __state)
            {
                if (__state && !__instance.OnFire()) Emit(Ev("fire.out").Int("station", Id(__instance.gameObject)));
            }
        }

        // ---- orders and delivery -------------------------------------------------------

        private static ServerOrderData FindOrder(ServerKitchenFlowControllerBase flow, OrderID id)
        {
            var monitor = flow.GetMonitorForTeam(TeamID.One);
            var list = monitor != null && monitor.OrdersController != null ? Traverse.Create(monitor.OrdersController).Field<List<ServerOrderData>>("m_activeOrders").Value : null;
            return list?.Find(o => o.ID == id);
        }

        [HarmonyPatch(typeof(ServerKitchenFlowControllerBase), "OnOrderAdded")]
        private static class OrderAdded
        {
            private static void Postfix(ServerKitchenFlowControllerBase __instance, OrderID _orderID)
            {
                var order = FindOrder(__instance, _orderID);
                if (order != null) Emit(Ev("order.new").Raw("order", Kitchen.OrderJson(order)));
            }
        }

        [HarmonyPatch(typeof(ServerKitchenFlowControllerBase), "OnOrderExpired")]
        private static class OrderExpired
        {
            private static void Prefix(ServerKitchenFlowControllerBase __instance, OrderID _orderID)
            {
                ExpiredOrders++;
                var order = FindOrder(__instance, _orderID);
                if (order != null) Emit(Ev("order.expire").Raw("order", Kitchen.OrderJson(order)));
            }
        }

        [HarmonyPatch(typeof(ServerKitchenFlowControllerBase), "OnSuccessfulDelivery")]
        private static class DeliverOk
        {
            private static void Postfix(OrderID _orderID, RecipeList.Entry _entry)
            {
                Deliveries++;
                var e = Ev("deliver").Bool("ok", true).Int("order", _orderID.m_id).Str("dish", _entry != null && _entry.m_order != null ? _entry.m_order.name : null);
                if (Actor != null) e.Int("chef", Id(Actor));
                Emit(e);
            }
        }

        [HarmonyPatch(typeof(ServerKitchenFlowControllerBase), "SendDeliverySuccess")]
        private static class DeliverTip
        {
            private static void Postfix(OrderID _orderID, int _tip) => Emit(Ev("tip").Int("order", _orderID.m_id).Int("tip", _tip));
        }

        [HarmonyPatch(typeof(ServerKitchenFlowControllerBase), "OnFailedDelivery")]
        private static class DeliverFail
        {
            private static void Postfix()
            {
                FailedDeliveries++;
                var e = Ev("deliver").Bool("ok", false);
                if (Actor != null) e.Int("chef", Id(Actor));
                Emit(e);
            }
        }

        // ---- hazards -------------------------------------------------------------------

        [HarmonyPatch(typeof(ServerPlayerRespawnManager), nameof(ServerPlayerRespawnManager.KillOrRespawn))]
        private static class Fall
        {
            private static void Prefix(GameObject _gameObject)
            {
                if (_gameObject == null) return;
                if (_gameObject.GetComponent<PlayerControls>() != null) Emit(Ev("fell").Int("chef", Id(_gameObject)));
                else if (_gameObject.GetComponent<ServerPhysicalAttachment>() != null) Emit(Ev("lost").Raw("item", K.Item(_gameObject)));
            }
        }
    }
}
