using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// RoomPlan/ARKit do not export a walkable graph. scan-features.json is walls, doors,
/// openings, and objects. This file turns those primitives into nodes, visibility edges,
/// and an A* path in ARKit world meters.
/// </summary>
public static class Pathfinding
{
    public const float MaxEdgeMeters = 18f;
    public const float PortalClearance = 0.45f;
    public const float ZoneTransferCost = 1f;
    public const string ZoneTransferKind = "zone-transfer";

    [Serializable]
    public class ScanFeatures
    {
        public int schemaVersion;
        public string zoneId;
        public string coordinateSystem;
        public int story;
        public Surface[] walls;
        public Surface[] doors;
        public Surface[] openings;
        public Surface[] windows;
        public Surface[] floors;
        public ScanObject[] objects;
        public Section[] sections;
    }

    [Serializable]
    public class Surface
    {
        public string identifier;
        public string category;
        public int story;
        public float[] dimensions;
        public float[] position;
        public float[] transformColumnMajor;
        public string parentIdentifier;
    }

    [Serializable]
    public class ScanObject
    {
        public string identifier;
        public string category;
        public int story;
        public float[] dimensions;
        public float[] position;
        public float[] transformColumnMajor;
    }

    [Serializable]
    public class Section
    {
        public string label;
        public int story;
        public float[] center;
    }

    [Serializable]
    public class BuildingDocument
    {
        public int schemaVersion;
        public string zoneId;
        public string coordinateSystem;
        public string heightReference;
        public Floor[] floors;
        public Node[] nodes;
        public Edge[] edges;
    }

    [Serializable]
    public class Floor
    {
        public string id;
        public int story;
        public float elevation;
    }

    [Serializable]
    public class Node
    {
        public string id;
        public string floor;
        public string type;
        public float[] position;
        public string source;
        public string label;
        public string roomPlanIdentifier;
        /// <summary>Set only in a combined multi-zone graph, where <see cref="id"/> is <see cref="ZoneKey"/>.</summary>
        public string zone;
        public string localId;
    }

    /// <summary>Mirrors shared/zone-connections.schema.json.</summary>
    [Serializable]
    public class ZoneConnections
    {
        public int schemaVersion;
        public ZoneConnection[] connections;
    }

    [Serializable]
    public class ZoneConnection
    {
        public NodeRef from;
        public NodeRef to;
    }

    [Serializable]
    public class NodeRef
    {
        public string zoneId;
        public string nodeId;
    }

    /// <summary>A contiguous run of path nodes inside one zone's ARKit coordinate system.</summary>
    public class RouteLeg
    {
        public string zoneId;
        public readonly List<string> nodeIds = new List<string>();
    }

    [Serializable]
    public class Edge
    {
        public string from;
        public string to;
        public string kind;
        public float meters;
        public string source;
    }

    public class Graph
    {
        public string zoneId;
        public string floorId = "ground";
        public readonly List<Node> Nodes = new List<Node>();
        public readonly List<Edge> Edges = new List<Edge>();
        readonly Dictionary<string, List<Edge>> adjacency = new Dictionary<string, List<Edge>>();
        readonly Dictionary<string, Node> nodesById = new Dictionary<string, Node>();

        public Node Node(string id) =>
            id != null && nodesById.TryGetValue(id, out var node) ? node : null;

        public IEnumerable<Edge> Neighbors(string id) =>
            adjacency.TryGetValue(id, out var list) ? list : Array.Empty<Edge>();

        public void AddNode(Node node)
        {
            if (Node(node.id) != null) return;
            Nodes.Add(node);
            nodesById[node.id] = node;
        }

        public void AddEdge(Edge edge)
        {
            foreach (var existing in Edges)
            {
                if (existing.from == edge.from && existing.to == edge.to) return;
                if (existing.from == edge.to && existing.to == edge.from) return;
            }

            Edges.Add(edge);
            AddAdjacency(edge.from, edge);
            AddAdjacency(edge.to, new Edge
            {
                from = edge.to,
                to = edge.from,
                kind = edge.kind,
                meters = edge.meters,
                source = edge.source
            });
        }

        void AddAdjacency(string from, Edge edge)
        {
            if (!adjacency.TryGetValue(from, out var list))
            {
                list = new List<Edge>();
                adjacency[from] = list;
            }
            list.Add(edge);
        }

        /// <summary>Positions are only comparable within one zone, so pass the zone the user is localized in.</summary>
        public string NearestNodeId(Vector3 arkitPosition, string zone = null)
        {
            string nearest = null;
            var best = float.MaxValue;
            foreach (var node in Nodes)
            {
                if (zone != null && node.zone != zone) continue;
                var p = Position(node);
                var d = Horizontal(arkitPosition, p);
                if (d < best)
                {
                    best = d;
                    nearest = node.id;
                }
            }
            return nearest;
        }

        public List<Node> Destinations() =>
            Nodes.FindAll(n => n.type == "destination");
    }

    public static ScanFeatures ParseScan(string json)
    {
        var scan = JsonUtility.FromJson<ScanFeatures>(json);
        if (scan == null) throw new FormatException("scan-features.json is empty or invalid.");
        return scan;
    }

    public static BuildingDocument ParseBuilding(string json)
    {
        var building = JsonUtility.FromJson<BuildingDocument>(json);
        if (building == null) throw new FormatException("building.json is empty or invalid.");
        return building;
    }

    public static ZoneConnections ParseConnections(string json)
    {
        var document = JsonUtility.FromJson<ZoneConnections>(json);
        if (document == null) throw new FormatException("zone-connections.json is empty or invalid.");
        if (document.schemaVersion != 1)
            throw new FormatException($"Unsupported zone-connections.json schemaVersion {document.schemaVersion}.");
        if (document.connections == null) throw new FormatException("zone-connections.json must contain a connections array.");
        foreach (var connection in document.connections)
        {
            if (string.IsNullOrEmpty(connection?.from?.zoneId) || string.IsNullOrEmpty(connection.from.nodeId) ||
                string.IsNullOrEmpty(connection.to?.zoneId) || string.IsNullOrEmpty(connection.to.nodeId))
                throw new FormatException("Every zone connection needs from/to zoneId and nodeId.");
        }
        return document;
    }

    public static string ZoneKey(string zoneId, string nodeId) => zoneId + "/" + nodeId;

    /// <summary>
    /// Merges per-zone graphs into one graph keyed by <see cref="ZoneKey"/>. Each zone keeps its own
    /// ARKit coordinates; zone connections become bidirectional edges with weight <see cref="ZoneTransferCost"/>.
    /// </summary>
    public static Graph Combine(IReadOnlyDictionary<string, Graph> zoneGraphs, ZoneConnections connections)
    {
        var combined = new Graph { floorId = null };
        foreach (var pair in zoneGraphs)
        {
            var zone = pair.Key;
            foreach (var node in pair.Value.Nodes)
            {
                combined.AddNode(new Node
                {
                    id = ZoneKey(zone, node.id),
                    localId = node.id,
                    zone = zone,
                    floor = node.floor,
                    type = node.type,
                    position = node.position,
                    source = node.source,
                    label = node.label,
                    roomPlanIdentifier = node.roomPlanIdentifier
                });
            }
            foreach (var edge in pair.Value.Edges)
            {
                combined.AddEdge(new Edge
                {
                    from = ZoneKey(zone, edge.from),
                    to = ZoneKey(zone, edge.to),
                    kind = edge.kind,
                    meters = edge.meters,
                    source = edge.source
                });
            }
        }

        if (connections?.connections == null) return combined;
        foreach (var connection in connections.connections)
        {
            var from = ZoneKey(connection.from.zoneId, connection.from.nodeId);
            var to = ZoneKey(connection.to.zoneId, connection.to.nodeId);
            if (combined.Node(from) == null || combined.Node(to) == null)
            {
                Debug.LogWarning($"[Gnarly] Skipping zone connection {from} <-> {to}: a node or zone package is missing.");
                continue;
            }
            combined.AddEdge(new Edge
            {
                from = from,
                to = to,
                kind = ZoneTransferKind,
                meters = ZoneTransferCost,
                source = "manual"
            });
        }
        return combined;
    }

    /// <summary>Splits an A* path wherever it crosses a zone connection.</summary>
    public static List<RouteLeg> SplitByZone(Graph graph, List<string> nodeIds)
    {
        var legs = new List<RouteLeg>();
        foreach (var id in nodeIds)
        {
            var zone = graph.Node(id).zone;
            if (legs.Count == 0 || legs[legs.Count - 1].zoneId != zone)
                legs.Add(new RouteLeg { zoneId = zone });
            legs[legs.Count - 1].nodeIds.Add(id);
        }
        return legs;
    }

    /// <summary>
    /// Nodes come from RoomPlan doors, openings, stairs, and room sections.
    /// Recorded mapper taps are only merged when they add a label (entrance/destination).
    /// Edges are visibility connections that do not cross walls except at portals.
    /// </summary>
    public static Graph Build(ScanFeatures scan, BuildingDocument building, string floorId)
    {
        var graph = new Graph
        {
            zoneId = scan?.zoneId ?? building?.zoneId,
            floorId = floorId
        };

        if (scan != null)
        {
            AddPortals(graph, scan.doors, "door", floorId);
            AddPortals(graph, scan.openings, "opening", floorId);
            if (scan.objects != null)
            {
                foreach (var obj in scan.objects)
                {
                    if (obj.category != "stairs" || obj.position == null || obj.position.Length != 3) continue;
                    graph.AddNode(new Node
                    {
                        id = "stairs-" + ShortId(obj.identifier),
                        floor = floorId,
                        type = "stairs",
                        position = obj.position,
                        source = "roomplan",
                        label = "stairs",
                        roomPlanIdentifier = obj.identifier
                    });
                }
            }

            if (scan.sections != null)
            {
                foreach (var section in scan.sections)
                {
                    if (section.center == null || section.center.Length != 3) continue;
                    if (section.label == "unidentified") continue;
                    graph.AddNode(new Node
                    {
                        id = "section-" + section.label,
                        floor = floorId,
                        type = "hallway",
                        position = section.center,
                        source = "roomplan",
                        label = section.label
                    });
                }
            }
        }

        if (building?.nodes != null)
        {
            foreach (var node in building.nodes)
                graph.AddNode(node);
        }

        var walls = Segments(scan?.walls);
        var portals = Concat(Segments(scan?.doors), Segments(scan?.openings));
        ConnectVisibility(graph, walls, portals);

        if (building?.edges != null)
        {
            foreach (var edge in building.edges)
            {
                if (graph.Node(edge.from) != null && graph.Node(edge.to) != null)
                    graph.AddEdge(edge);
            }
        }

        return graph;
    }

    static void AddPortals(Graph graph, Surface[] surfaces, string type, string floorId)
    {
        if (surfaces == null) return;
        foreach (var surface in surfaces)
        {
            if (surface.position == null || surface.position.Length != 3) continue;
            graph.AddNode(new Node
            {
                id = type + "-" + ShortId(surface.identifier),
                floor = floorId,
                type = type,
                position = surface.position,
                source = "roomplan",
                label = surface.category,
                roomPlanIdentifier = surface.identifier
            });
        }
    }

    static void ConnectVisibility(Graph graph, List<Segment> walls, List<Segment> portals)
    {
        for (var i = 0; i < graph.Nodes.Count; i++)
        {
            for (var j = i + 1; j < graph.Nodes.Count; j++)
            {
                var a = graph.Nodes[i];
                var b = graph.Nodes[j];
                if (a.floor != b.floor) continue;
                var meters = Vector3.Distance(Position(a), Position(b));
                if (meters < 0.2f || meters > MaxEdgeMeters) continue;
                if (!IsClear(Xz(a.position), Xz(b.position), walls, portals)) continue;
                graph.AddEdge(new Edge
                {
                    from = a.id,
                    to = b.id,
                    kind = a.type == "stairs" && b.type == "stairs" ? "stairs" : "hallway",
                    meters = meters,
                    source = "visibility"
                });
            }
        }
    }

    public static bool IsClear(Vector2 start, Vector2 end, List<Segment> walls, List<Segment> portals)
    {
        foreach (var wall in walls)
        {
            if (!wall.TryIntersect(start, end, out var hit)) continue;
            var nearEndpoint = Vector2.Distance(hit, start) < PortalClearance || Vector2.Distance(hit, end) < PortalClearance;
            var throughPortal = false;
            foreach (var portal in portals)
            {
                if (portal.DistanceTo(hit) <= PortalClearance)
                {
                    throughPortal = true;
                    break;
                }
            }
            if (nearEndpoint || throughPortal) continue;
            return false;
        }
        return true;
    }

    public static List<string> AStar(Graph graph, string startId, string goalId)
    {
        if (startId == goalId) return new List<string> { startId };
        var start = graph.Node(startId);
        var goal = graph.Node(goalId);
        if (start == null || goal == null) return null;

        var open = new List<string> { startId };
        var cameFrom = new Dictionary<string, string>();
        var gScore = new Dictionary<string, float> { [startId] = 0f };
        var fScore = new Dictionary<string, float> { [startId] = Heuristic(start, goal) };

        while (open.Count > 0)
        {
            var current = open[0];
            var best = fScore[current];
            for (var i = 1; i < open.Count; i++)
            {
                var id = open[i];
                var score = fScore[id];
                if (score < best)
                {
                    best = score;
                    current = id;
                }
            }

            if (current == goalId)
                return Reconstruct(cameFrom, current);

            open.Remove(current);
            foreach (var edge in graph.Neighbors(current))
            {
                var tentative = gScore[current] + edge.meters;
                if (gScore.TryGetValue(edge.to, out var existing) && tentative >= existing)
                    continue;

                cameFrom[edge.to] = current;
                gScore[edge.to] = tentative;
                fScore[edge.to] = tentative + Heuristic(graph.Node(edge.to), goal);
                if (!open.Contains(edge.to))
                    open.Add(edge.to);
            }
        }

        return null;
    }

    public static Route ToRoute(Graph graph, List<string> nodeIds, string zoneId)
    {
        var waypoints = new Route.Waypoint[nodeIds.Count];
        for (var i = 0; i < nodeIds.Count; i++)
        {
            var node = graph.Node(nodeIds[i]);
            waypoints[i] = new Route.Waypoint { id = node.id, position = node.position };
        }

        return new Route
        {
            schemaVersion = 1,
            zoneId = zoneId,
            coordinateSystem = "arkit-world-meters",
            heightReference = "floor",
            waypoints = waypoints
        };
    }

    static List<string> Reconstruct(Dictionary<string, string> cameFrom, string current)
    {
        var path = new List<string> { current };
        while (cameFrom.TryGetValue(current, out var previous))
        {
            current = previous;
            path.Add(current);
        }
        path.Reverse();
        return path;
    }

    /// <summary>Straight-line distance is meaningless between two zones' coordinate systems, so it is 0 there.</summary>
    static float Heuristic(Node a, Node b) =>
        a.zone == b.zone ? Vector3.Distance(Position(a), Position(b)) : 0f;

    public static Vector3 Position(Node node) => new Vector3(node.position[0], node.position[1], node.position[2]);

    static Vector2 Xz(float[] position) => new Vector2(position[0], position[2]);

    static string ShortId(string identifier)
    {
        if (string.IsNullOrEmpty(identifier)) return Guid.NewGuid().ToString("N").Substring(0, 8);
        return identifier.Substring(0, Math.Min(8, identifier.Length)).ToLowerInvariant();
    }

    static List<Segment> Segments(Surface[] surfaces)
    {
        var list = new List<Segment>();
        if (surfaces == null) return list;
        foreach (var surface in surfaces)
        {
            if (surface.transformColumnMajor == null || surface.transformColumnMajor.Length != 16) continue;
            if (surface.dimensions == null || surface.dimensions.Length < 1) continue;
            var half = surface.dimensions[0] * 0.5f;
            var a = TransformPoint(surface.transformColumnMajor, new Vector3(-half, 0f, 0f));
            var b = TransformPoint(surface.transformColumnMajor, new Vector3(half, 0f, 0f));
            list.Add(new Segment(new Vector2(a.x, a.z), new Vector2(b.x, b.z)));
        }
        return list;
    }

    static List<Segment> Concat(List<Segment> a, List<Segment> b)
    {
        var list = new List<Segment>(a);
        list.AddRange(b);
        return list;
    }

    static Vector3 TransformPoint(float[] m, Vector3 local)
    {
        return new Vector3(
            m[0] * local.x + m[4] * local.y + m[8] * local.z + m[12],
            m[1] * local.x + m[5] * local.y + m[9] * local.z + m[13],
            m[2] * local.x + m[6] * local.y + m[10] * local.z + m[14]
        );
    }

    public readonly struct Segment
    {
        public readonly Vector2 A;
        public readonly Vector2 B;

        public Segment(Vector2 a, Vector2 b)
        {
            A = a;
            B = b;
        }

        public bool TryIntersect(Vector2 p, Vector2 q, out Vector2 hit)
        {
            hit = default;
            var r = B - A;
            var s = q - p;
            var den = r.x * s.y - r.y * s.x;
            if (Mathf.Abs(den) < 1e-5f) return false;
            var qp = p - A;
            var t = (qp.x * s.y - qp.y * s.x) / den;
            var u = (r.x * qp.y - r.y * qp.x) / den;
            if (t <= 0.02f || t >= 0.98f || u <= 0.02f || u >= 0.98f) return false;
            hit = A + r * t;
            return true;
        }

        public float DistanceTo(Vector2 point)
        {
            var ab = B - A;
            var length = ab.magnitude;
            if (length < 1e-5f) return Vector2.Distance(point, A);
            var t = Mathf.Clamp01(Vector2.Dot(point - A, ab) / (length * length));
            return Vector2.Distance(point, A + ab * t);
        }
    }

    static float Horizontal(Vector3 a, Vector3 b)
    {
        a.y = 0;
        b.y = 0;
        return Vector3.Distance(a, b);
    }
}
