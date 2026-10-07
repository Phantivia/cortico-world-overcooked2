using System.Collections.Generic;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// Four-neighbour routes on the kitchen grid. A cell is walkable when the grid has no occupant
    /// there, floor lies under its centre and the chef's capsule fits without touching level
    /// geometry. Chefs and items do not count as geometry; the other chefs' cells are passed in as
    /// blocked.
    /// </summary>
    internal static class Nav
    {
        /// <summary>
        /// How much a route trusts physics. Strict: the body fits each cell and passes each edge.
        /// Edges: standable cells joined by clear edges, the rule the layout map is drawn with.
        /// Loose: standable cells only, for props the chef walks over that both checks reject.
        /// </summary>
        public enum Mode { Strict, Edges, Loose }

        private static readonly Collider[] Overlaps = new Collider[32];
        /// <summary>Capsules are lifted this far so floor and travelator tops under the feet do not count.</summary>
        private const float Lift = 0.1f;
        private static readonly int[] Dx = { 1, -1, 0, 0 };
        private static readonly int[] Dz = { 0, 0, 1, -1 };

        public struct Cell
        {
            public int X, Z;
            public Cell(int x, int z) { X = x; Z = z; }
            public override string ToString() => X + "," + Z;
        }

        public static bool Walkable(Kitchen k, PlayerControls chef, int x, int z)
        {
            var g = k.Grid;
            var h = g.GetGridHalfSize();
            if (x < -h.X || x > h.X || z < -h.Z || z > h.Z) return false;
            var index = new GridIndex(x, 0, z);
            var occupant = g.GetGridOccupant(index);
            if (occupant != null && Kitchen.MovingFloor(occupant) == null) return false;
            var center = g.GetPosFromGridLocation(index);
            if (occupant == null && !Kitchen.IsFloor(center)) return false;
            return BodyClear(chef, new Vector3(center.x, chef.transform.position.y, center.z));
        }

        private static bool BodyClear(PlayerControls chef, Vector3 at) => BodyBlocker(chef, at) == null;

        /// <summary>The first collider the chef's body would overlap standing at this point, or null.</summary>
        public static Collider BodyBlocker(PlayerControls chef, Vector3 at)
        {
            var body = chef.GetComponent<Collider>();
            if (body == null) return null;
            var b = body.bounds;
            float skin = Physics.defaultContactOffset;
            float radius = Mathf.Max(skin, Mathf.Min(b.extents.x, b.extents.z) - skin) * 0.9f;
            Vector3 center = at + (b.center - chef.transform.position) + Vector3.up * Lift;
            float height = Mathf.Max(0f, b.extents.y - skin - radius - Lift);
            int n = Physics.OverlapCapsuleNonAlloc(center + Vector3.up * height, center - Vector3.up * height, radius, Overlaps, ~0, QueryTriggerInteraction.Ignore);
            Collider blocker = null;
            for (int i = 0; i < n; i++)
            {
                var other = Overlaps[i];
                Overlaps[i] = null;
                if (blocker != null || other == null || other.transform.IsChildOf(chef.transform)) continue;
                if (Passable(other)) continue;
                if (Physics.GetIgnoreLayerCollision(body.gameObject.layer, other.gameObject.layer)) continue;
                blocker = other;
            }
            return blocker;
        }

        /// <summary>
        /// Chefs, travelators, items (held, on counters or on the floor, which chefs push aside) and
        /// anything physics moves never block a route.
        /// </summary>
        private static bool Passable(Collider other)
        {
            if (other.GetComponentInParent<PlayerControls>() != null || other.GetComponentInParent<Travelator>() != null) return true;
            if (other.GetComponentInParent<ServerPhysicalAttachment>() != null) return true;
            return other.attachedRigidbody != null && !other.attachedRigidbody.isKinematic;
        }

        private static readonly RaycastHit[] Hits = new RaycastHit[32];

        /// <summary>The chef's capsule can travel from one cell centre to the next without hitting level geometry.</summary>
        public static bool EdgeClear(Kitchen k, PlayerControls chef, Cell from, Cell to)
        {
            var body = chef.GetComponent<Collider>();
            if (body == null) return true;
            var a3 = k.CellCenter(from.X, from.Z);
            var b3 = k.CellCenter(to.X, to.Z);
            var origin = new Vector3(a3.x, chef.transform.position.y, a3.z);
            var diff = new Vector3(b3.x - a3.x, 0f, b3.z - a3.z);
            var b = body.bounds;
            float skin = Physics.defaultContactOffset;
            float radius = Mathf.Max(skin, Mathf.Min(b.extents.x, b.extents.z) - skin) * 0.9f;
            Vector3 center = origin + (b.center - chef.transform.position) + Vector3.up * Lift;
            float height = Mathf.Max(0f, b.extents.y - skin - radius - Lift);
            int n = Physics.CapsuleCastNonAlloc(center + Vector3.up * height, center - Vector3.up * height, radius, diff.normalized, Hits, diff.magnitude, ~0, QueryTriggerInteraction.Ignore);
            bool clear = true;
            for (int i = 0; i < n; i++)
            {
                var other = Hits[i].collider;
                float normalY = Hits[i].normal.y, distance = Hits[i].distance;
                Hits[i] = default(RaycastHit);
                // Colliders the capsule already overlaps at the start (the floor or travelator it stands on).
                if (distance <= 0f) continue;
                if (!clear || other == null || other.transform.IsChildOf(chef.transform)) continue;
                if (Passable(other)) continue;
                if (Physics.GetIgnoreLayerCollision(body.gameObject.layer, other.gameObject.layer)) continue;
                // Floor under the path: hits that start at the path's own height are ground contacts.
                if (normalY > 0.7f) continue;
                clear = false;
            }
            return clear;
        }

        /// <summary>Floor or moving floor with no other grid occupant; no body or edge check.</summary>
        public static bool Standable(Kitchen k, int x, int z)
        {
            var g = k.Grid;
            var h = g.GetGridHalfSize();
            if (x < -h.X || x > h.X || z < -h.Z || z > h.Z) return false;
            var occupant = g.GetGridOccupant(new GridIndex(x, 0, z));
            if (occupant != null) return Kitchen.MovingFloor(occupant) != null;
            return Kitchen.IsFloor(g.GetPosFromGridLocation(new GridIndex(x, 0, z)));
        }

        /// <summary>Shortest route from start to any goal cell, excluding start; null if none.</summary>
        public static List<Cell> Route(Kitchen k, PlayerControls chef, Cell start, HashSet<long> goals, HashSet<long> blocked, Mode mode = Mode.Strict)
        {
            var previous = new Dictionary<long, long>();
            var queue = new Queue<Cell>();
            queue.Enqueue(start);
            previous[Key(start)] = Key(start);
            var walkable = new Dictionary<long, bool>();
            while (queue.Count > 0)
            {
                var at = queue.Dequeue();
                if (goals.Contains(Key(at)))
                {
                    var path = new List<Cell>();
                    for (long c = Key(at); c != Key(start); c = previous[c]) path.Add(FromKey(c));
                    path.Reverse();
                    return path;
                }
                for (int i = 0; i < 4; i++)
                {
                    var next = new Cell(at.X + Dx[i], at.Z + Dz[i]);
                    long key = Key(next);
                    if (previous.ContainsKey(key) || blocked.Contains(key)) continue;
                    if (!walkable.TryGetValue(key, out var ok)) walkable[key] = ok = mode == Mode.Strict ? Walkable(k, chef, next.X, next.Z) : Standable(k, next.X, next.Z);
                    if (!ok || (mode != Mode.Loose && !EdgeClear(k, chef, at, next))) continue;
                    previous[key] = Key(at);
                    queue.Enqueue(next);
                }
            }
            return null;
        }

        public static long Key(Cell c) => ((long)c.X << 32) ^ (uint)c.Z;
        public static long Key(int x, int z) => ((long)x << 32) ^ (uint)z;
        public static Cell FromKey(long key) => new Cell((int)(key >> 32), (int)(uint)key);

        public static IEnumerable<Cell> Neighbours(int x, int z)
        {
            for (int i = 0; i < 4; i++) yield return new Cell(x + Dx[i], z + Dz[i]);
        }
    }
}
