using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// RoomPlan/ARKit do not export a walkable graph. scan-features.json is walls, doors,
/// openings, and objects. This file turns those primitives into nodes, visibility edges,
/// and an A* path in ARKit world meters. Two nodes are neighbors only when they are on
/// the same floor, within <see cref="MaxEdgeMeters"/>, and the straight line does not
/// cross a wall except through a door or opening.
/// </summary>
public static class Pathfinding
{
    public const float MaxEdgeMeters = 18f;
    public const float MinEdgeMeters = 0.2f;
    /// <summary>How far past a door or opening a line may cross that opening's wall.</summary>
    public const float PortalMatchMeters = 0.15f;
    /// <summary>Walking-meter equivalent of calling and boarding an elevator (about 25 s at 1.2 m/s).</summary>
    public const float ElevatorBoardCost = 30f;
    /// <summary>Walking-meter equivalent of riding one story (about 5 s at 1.2 m/s).</summary>
    public const float ElevatorStoryCost = 6f;
    public const string ElevatorKind = "elevator";
    public const string ElevatorType = "elevator";

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
        /// <summary>building.json story of this zone's floor, when known.</summary>
        public int? story;
        /// <summary>In a combined graph: story per zone, only when every zone has a distinct one.</summary>
        public readonly Dictionary<string, int> ZoneStories = new Dictionary<string, int>();
        public readonly List<Node> Nodes = new List<Node>();
        public readonly List<Edge> Edges = new List<Edge>();
        /// <summary>RoomPlan walls (plus windows and short corner seals) that neighbor tests cannot cross.</summary>
        public readonly List<Wall> Walls = new List<Wall>();
        /// <summary>
        /// Floor surface height (ARKit y) keyed by floor id, or <see cref="AnyFloor"/> for the zone's default.
        /// In a combined graph the keys are <see cref="ZoneKey"/>(zone, floor).
        /// </summary>
        public readonly Dictionary<string, float> FloorHeights = new Dictionary<string, float>();
        /// <summary>Zones whose building.json places nodes at phone height and has no known floor height.</summary>
        public readonly HashSet<string> DeviceHeightZones = new HashSet<string>();
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

        /// <summary>
        /// Returns the two nodes at the ends of the recorded path segment nearest to the user.
        /// They are candidates for an automatic route start; A* decides which direction reaches
        /// the selected destination without first sending the user back along the segment.
        /// </summary>
        public List<string> NearestRecordedWalkEndpoints(Vector3 arkitPosition, string zone)
        {
            Edge closestEdge = null;
            var closestDistanceSquared = float.MaxValue;
            var flatPosition = new Vector2(arkitPosition.x, arkitPosition.z);

            foreach (var edge in Edges)
            {
                var from = Node(edge.from);
                var to = Node(edge.to);
                if (from == null || to == null || from.zone != zone || to.zone != zone) continue;
                if (!IsRecordedWalkEdge(edge, from, to)) continue;

                var a = Xz(from.position);
                var b = Xz(to.position);
                var segment = b - a;
                var lengthSquared = segment.sqrMagnitude;
                if (lengthSquared < 1e-6f) continue;
                var t = Mathf.Clamp01(Vector2.Dot(flatPosition - a, segment) / lengthSquared);
                var distanceSquared = (flatPosition - (a + segment * t)).sqrMagnitude;
                if (distanceSquared >= closestDistanceSquared) continue;
                closestDistanceSquared = distanceSquared;
                closestEdge = edge;
            }

            return closestEdge == null
                ? new List<string>()
                : new List<string> { closestEdge.from, closestEdge.to };
        }

        public List<Node> Destinations() =>
            Nodes.FindAll(n => n.type == "destination");

        public bool TryFloorHeight(Node node, out float height)
        {
            var prefix = node.zone == null ? "" : node.zone + "/";
            return (node.floor != null && FloorHeights.TryGetValue(prefix + node.floor, out height)) ||
                   FloorHeights.TryGetValue(prefix + AnyFloor, out height);
        }
    }

    public const string AnyFloor = "*";

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

    public static bool IsElevator(Node node) => node?.type == ElevatorType;

    /// <summary>
    /// Merges per-zone graphs into one graph keyed by <see cref="ZoneKey"/>. Each zone keeps its own
    /// ARKit coordinates. Floors connect only through elevator waypoints: a link between two elevator
    /// nodes becomes a ride (see <see cref="AddElevatorRides"/>) whose A* weight is
    /// <see cref="ElevatorBoardCost"/> plus <see cref="ElevatorStoryCost"/> for every story travelled.
    /// </summary>
    public static Graph Combine(IReadOnlyDictionary<string, Graph> zoneGraphs, ZoneConnections connections)
    {
        var combined = new Graph { floorId = null };
        foreach (var story in ZoneStories(zoneGraphs))
            combined.ZoneStories[story.Key] = story.Value;
        foreach (var pair in zoneGraphs)
        {
            var zone = pair.Key;
            foreach (var height in pair.Value.FloorHeights)
                combined.FloorHeights[ZoneKey(zone, height.Key)] = height.Value;
            if (pair.Value.DeviceHeightZones.Count > 0) combined.DeviceHeightZones.Add(zone);
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
        var elevatorLinks = new Dictionary<string, List<string>>();
        foreach (var connection in connections.connections)
        {
            var from = ZoneKey(connection.from.zoneId, connection.from.nodeId);
            var to = ZoneKey(connection.to.zoneId, connection.to.nodeId);
            if (combined.Node(from) == null || combined.Node(to) == null)
            {
                Debug.LogWarning($"[Gnarly] Skipping zone connection {from} <-> {to}: a node or zone package is missing.");
                continue;
            }
            if (IsElevator(combined.Node(from)) && IsElevator(combined.Node(to)))
            {
                Link(elevatorLinks, from, to);
                Link(elevatorLinks, to, from);
                continue;
            }
            Debug.LogWarning($"[Gnarly] Skipping zone connection {from} <-> {to}: floors connect through elevator waypoints.");
        }
        AddElevatorRides(combined, elevatorLinks);
        return combined;
    }

    static void Link(Dictionary<string, List<string>> links, string from, string to)
    {
        if (!links.TryGetValue(from, out var list)) links[from] = list = new List<string>();
        if (!list.Contains(to)) list.Add(to);
    }

    /// <summary>
    /// The web editor links an elevator on adjacent floors only. Linked elevator nodes form one shaft,
    /// and every pair of floors in a shaft gets a direct ride edge, so floor 1 to floor 3 is one ride
    /// instead of a stop (and a relocalization) on floor 2. A ride costs <see cref="ElevatorBoardCost"/>
    /// plus <see cref="ElevatorStoryCost"/> per story travelled.
    /// </summary>
    static void AddElevatorRides(Graph graph, Dictionary<string, List<string>> links)
    {
        foreach (var start in links.Keys)
        {
            var hops = new Dictionary<string, int> { [start] = 0 };
            var queue = new Queue<string>();
            queue.Enqueue(start);
            while (queue.Count > 0)
            {
                var id = queue.Dequeue();
                foreach (var next in links[id])
                {
                    if (hops.ContainsKey(next)) continue;
                    hops[next] = hops[id] + 1;
                    queue.Enqueue(next);
                }
            }

            var from = graph.Node(start);
            foreach (var stop in hops)
            {
                if (string.CompareOrdinal(start, stop.Key) >= 0) continue;
                var to = graph.Node(stop.Key);
                if (from.zone == to.zone) continue;
                graph.AddEdge(new Edge
                {
                    from = start,
                    to = stop.Key,
                    kind = ElevatorKind,
                    meters = ElevatorBoardCost + ElevatorStoryCost * StoriesBetween(graph, from.zone, to.zone, stop.Value),
                    source = "manual"
                });
            }
        }
    }

    /// <summary>Story difference when every floor's story is known; otherwise the number of linked floors between them.</summary>
    public static int StoriesBetween(Graph graph, string zoneA, string zoneB, int linkedHops)
    {
        if (graph.ZoneStories.TryGetValue(zoneA, out var a) && graph.ZoneStories.TryGetValue(zoneB, out var b) && a != b)
            return Math.Abs(a - b);
        return Math.Max(1, linkedHops);
    }

    /// <summary>
    /// RoomPlan reports story 0 for every separate floor scan, so building.json stories are only trusted
    /// when they differ for every zone. Otherwise a floor number in the floor or zone id ("floor-3") is used.
    /// </summary>
    static Dictionary<string, int> ZoneStories(IReadOnlyDictionary<string, Graph> zoneGraphs)
    {
        var fromFloors = new Dictionary<string, int>();
        var fromNames = new Dictionary<string, int>();
        foreach (var pair in zoneGraphs)
        {
            if (pair.Value.story.HasValue) fromFloors[pair.Key] = pair.Value.story.Value;
            if (TryFloorNumber(pair.Value.floorId, out var number) || TryFloorNumber(pair.Key, out number))
                fromNames[pair.Key] = number;
        }
        if (AllDistinct(fromFloors, zoneGraphs.Count)) return fromFloors;
        if (AllDistinct(fromNames, zoneGraphs.Count)) return fromNames;
        return new Dictionary<string, int>();
    }

    static bool AllDistinct(Dictionary<string, int> stories, int zoneCount) =>
        stories.Count == zoneCount && new HashSet<int>(stories.Values).Count == zoneCount;

    static readonly System.Text.RegularExpressions.Regex FloorNumber =
        new System.Text.RegularExpressions.Regex(@"(?<![A-Za-z0-9])-?\d+|\d+");

    static bool TryFloorNumber(string name, out int number)
    {
        number = 0;
        if (string.IsNullOrEmpty(name)) return false;
        var match = FloorNumber.Match(name);
        return match.Success && int.TryParse(match.Value, out number);
    }

    /// <summary>
    /// Elevator on <paramref name="legIndex"/> that the path uses to leave that floor.
    /// It is the waypoint connecting this floor to the next. Null when the leg is the last,
    /// or when the crossing is not an elevator ride.
    /// </summary>
    public static string ElevatorWaypoint(Graph graph, List<RouteLeg> legs, int legIndex)
    {
        if (graph == null || legs == null || legIndex < 0 || legIndex >= legs.Count - 1) return null;
        var leg = legs[legIndex];
        if (leg.nodeIds.Count == 0 || legs[legIndex + 1].nodeIds.Count == 0) return null;
        var id = leg.nodeIds[leg.nodeIds.Count - 1];
        var next = legs[legIndex + 1].nodeIds[0];
        if (!IsElevator(graph.Node(id)) || !IsElevator(graph.Node(next))) return null;
        return id;
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
    /// Same-floor edges, including ones copied from building.json, must be shorter than
    /// <see cref="MaxEdgeMeters"/> and clear of <see cref="Wall"/> obstacles.
    /// </summary>
    public static Graph Build(ScanFeatures scan, BuildingDocument building, string floorId)
    {
        var graph = new Graph
        {
            zoneId = scan?.zoneId ?? building?.zoneId,
            floorId = floorId,
            story = FloorStory(building, floorId)
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

        AddFloorHeights(graph, scan, building);

        var walls = BuildWalls(scan?.walls);
        // A window is a hole in its parent wall, not a way through. Keep it solid.
        if (scan?.windows != null) walls.AddRange(BuildWalls(scan.windows));
        var portals = BuildPortals(scan?.doors, scan?.openings);
        CloseCornerGaps(walls, portals);
        graph.Walls.AddRange(walls);
        ConnectVisibility(graph, walls, portals);

        var dropped = 0;
        if (building?.edges != null)
        {
            foreach (var edge in building.edges)
            {
                var from = graph.Node(edge.from);
                var to = graph.Node(edge.to);
                if (from == null || to == null) continue;
                // Stair flights change floors and are not a line across this floor's walls.
                if (IsCrossFloorStair(from, to, edge))
                {
                    graph.AddEdge(edge);
                    continue;
                }
                if (!CanConnect(from, to, walls, portals))
                {
                    dropped++;
                    continue;
                }
                graph.AddEdge(edge);
            }
        }

        if (scan?.walls != null && scan.walls.Length > 0 && graph.Walls.Count == 0)
            Debug.LogWarning($"[Gnarly] Zone '{graph.zoneId}' listed {scan.walls.Length} walls but none became obstacles.");
        else if (graph.Walls.Count == 0)
            Debug.LogWarning($"[Gnarly] Zone '{graph.zoneId}' has no walls. Neighbors are limited to {MaxEdgeMeters:0} m and are not blocked by geometry.");
        Debug.Log($"[Gnarly] Zone '{graph.zoneId}': {graph.Nodes.Count} nodes, {graph.Edges.Count} edges, {graph.Walls.Count} walls. Dropped {dropped} blocked edge(s).");

        return graph;
    }

    static int? FloorStory(BuildingDocument building, string floorId)
    {
        if (building?.floors == null || building.floors.Length == 0) return null;
        foreach (var floor in building.floors)
            if (floor.id == floorId) return floor.story;
        return building.floors[0].story;
    }

    /// <summary>
    /// Node heights are not floor heights: walked nodes are at phone height and RoomPlan doors,
    /// openings, objects and sections are at their centers. A zone with several floors (a stairwell)
    /// uses building.json's per-floor elevations; otherwise the scanned floor surface is preferred,
    /// then the lowest wall bottom, then building.json's single floor elevation.
    /// </summary>
    static void AddFloorHeights(Graph graph, ScanFeatures scan, BuildingDocument building)
    {
        var floors = building?.floors;
        if (floors != null && floors.Length > 1)
        {
            foreach (var floor in floors)
                if (!string.IsNullOrEmpty(floor.id)) graph.FloorHeights[floor.id] = floor.elevation;
        }

        var scanned = ScannedFloorHeight(scan);
        if (scanned.HasValue)
            graph.FloorHeights[AnyFloor] = scanned.Value;
        else if (floors != null && floors.Length == 1)
            graph.FloorHeights[AnyFloor] = floors[0].elevation;

        if (graph.FloorHeights.Count == 0 && building?.heightReference == "device")
            graph.DeviceHeightZones.Add(graph.zoneId ?? "");
    }

    static float? ScannedFloorHeight(ScanFeatures scan)
    {
        float? lowest = null;
        if (scan?.floors != null)
        {
            foreach (var floor in scan.floors)
            {
                if (floor.position == null || floor.position.Length != 3) continue;
                lowest = Mathf.Min(lowest ?? float.MaxValue, floor.position[1]);
            }
        }
        if (lowest.HasValue || scan?.walls == null) return lowest;

        foreach (var wall in scan.walls)
        {
            if (wall.position == null || wall.position.Length != 3) continue;
            var height = wall.dimensions != null && wall.dimensions.Length > 1 ? wall.dimensions[1] : 2.4f;
            lowest = Mathf.Min(lowest ?? float.MaxValue, wall.position[1] - height * 0.5f);
        }
        return lowest;
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

    static void ConnectVisibility(Graph graph, List<Wall> walls, List<Portal> portals)
    {
        for (var i = 0; i < graph.Nodes.Count; i++)
        {
            for (var j = i + 1; j < graph.Nodes.Count; j++)
            {
                var a = graph.Nodes[i];
                var b = graph.Nodes[j];
                // The mapper's sequential walk edges are the proven, traversable route. Adding a
                // cheaper line-of-sight edge between two of those samples lets A* shortcut across
                // a room and creates the backwards triangles seen in AR guidance.
                if (IsRecordedWalkEdge(null, a, b)) continue;
                if (!CanConnect(a, b, walls, portals)) continue;
                graph.AddEdge(new Edge
                {
                    from = a.id,
                    to = b.id,
                    kind = a.type == "stairs" && b.type == "stairs" ? "stairs" : "hallway",
                    meters = Vector3.Distance(Position(a), Position(b)),
                    source = "visibility"
                });
            }
        }
    }

    // Older Firebase packages label samples only by id (walk-1, walk-2, …), while newer mapper
    // packages also use source: "walked-path". Treat both as the recorded walk network.
    static bool IsRecordedWalkNode(Node node) =>
        node != null && (node.source == "walked-path" ||
                         node.type == "waypoint" ||
                         (!string.IsNullOrEmpty(node.id) && node.id.StartsWith("walk-", StringComparison.Ordinal)) ||
                         (!string.IsNullOrEmpty(node.localId) && node.localId.StartsWith("walk-", StringComparison.Ordinal)));

    static bool IsRecordedWalkEdge(Edge edge, Node from, Node to) =>
        edge?.source == "walked-path" || (IsRecordedWalkNode(from) && IsRecordedWalkNode(to));

    /// <summary>
    /// Same floor, not too close, not farther than <see cref="MaxEdgeMeters"/>, and the
    /// floor-plane line does not pass through a wall except at a door or opening.
    /// </summary>
    static bool CanConnect(Node a, Node b, List<Wall> walls, List<Portal> portals)
    {
        if (a?.position == null || b?.position == null || a.position.Length != 3 || b.position.Length != 3)
            return false;
        if (a.floor != b.floor) return false;
        var meters = Vector3.Distance(Position(a), Position(b));
        if (meters < MinEdgeMeters || meters > MaxEdgeMeters) return false;
        return IsClear(Xz(a.position), Xz(b.position), walls, portals);
    }

    static bool IsCrossFloorStair(Node a, Node b, Edge edge) =>
        a.floor != b.floor &&
        edge.kind == "stairs" &&
        a.type == "stairs" &&
        b.type == "stairs";

    public static bool IsClear(Vector2 start, Vector2 end, List<Wall> walls, List<Portal> portals)
    {
        if (walls == null) return true;
        foreach (var wall in walls)
        {
            if (WallBlocks(start, end, wall, portals)) return false;
        }
        return true;
    }

    /// <summary>
    /// A crossing near a node is not a doorway. Recorded points often sit beside a wall,
    /// and treating that proximity as an opening lets the route walk through the wall.
    /// </summary>
    static bool WallBlocks(Vector2 start, Vector2 end, Wall wall, List<Portal> portals)
    {
        if (wall.Segment.Length < 1e-4f) return false;
        if (RunsAlongWall(start, end, wall) && !OpeningCovers(start, end, wall, portals))
            return true;

        var extended = wall.Extended();
        if (extended.TryIntersect(start, end, out var hit) && !PortalOpens(hit, wall, portals))
            return true;
        return false;
    }

    static bool RunsAlongWall(Vector2 start, Vector2 end, Wall wall)
    {
        var direction = end - start;
        var span = wall.Segment.B - wall.Segment.A;
        var directionLength = direction.magnitude;
        var spanLength = span.magnitude;
        if (directionLength < 1e-4f || spanLength < 1e-4f) return false;
        var cross = direction.x * span.y - direction.y * span.x;
        if (Mathf.Abs(cross) > 0.08f * directionLength * spanLength) return false;
        if (wall.Segment.DistanceTo(start) > wall.HalfThickness && wall.Segment.DistanceTo(end) > wall.HalfThickness)
            return false;

        var axis = span / spanLength;
        var s0 = Vector2.Dot(start - wall.Segment.A, axis);
        var s1 = Vector2.Dot(end - wall.Segment.A, axis);
        var low = Mathf.Max(0f, Mathf.Min(s0, s1));
        var high = Mathf.Min(spanLength, Mathf.Max(s0, s1));
        return high - low > 0.02f;
    }

    static bool OpeningCovers(Vector2 start, Vector2 end, Wall wall, List<Portal> portals)
    {
        var mid = wall.Segment.ClosestPoint((start + end) * 0.5f);
        return PortalOpens(mid, wall, portals)
            && PortalOpens(wall.Segment.ClosestPoint(start), wall, portals)
            && PortalOpens(wall.Segment.ClosestPoint(end), wall, portals);
    }

    static bool PortalOpens(Vector2 hit, Wall wall, List<Portal> portals)
    {
        if (portals == null) return false;
        foreach (var portal in portals)
        {
            if (!string.IsNullOrEmpty(portal.ParentId))
            {
                if (portal.ParentId != wall.Id) continue;
            }
            else if (wall.Segment.DistanceTo(portal.Segment.Midpoint) > wall.HalfThickness + 0.3f)
            {
                continue;
            }
            if (portal.Segment.DistanceTo(hit) <= PortalMatchMeters) return true;
        }
        return false;
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
        var fScore = new Dictionary<string, float> { [startId] = Heuristic(graph, start, goal) };

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
                fScore[edge.to] = tentative + Heuristic(graph, graph.Node(edge.to), goal);
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
            var position = node.position;
            if (graph.TryFloorHeight(node, out var floorHeight))
                position = new[] { position[0], floorHeight, position[2] };
            waypoints[i] = new Route.Waypoint { id = node.id, position = position };
        }

        return new Route
        {
            schemaVersion = 1,
            zoneId = zoneId,
            coordinateSystem = "arkit-world-meters",
            heightReference = graph.DeviceHeightZones.Contains(zoneId ?? "") ? "device" : "floor",
            waypoints = waypoints
        };
    }

    /// <summary>
    /// Adds runtime-only points between graph nodes so AR guidance progresses in small, reliable
    /// steps. This deliberately does not change the navigation graph or selectable map places.
    /// </summary>
    public static Route DensifyRoute(Route route, float maximumSpacingMeters)
    {
        if (route?.waypoints == null || route.waypoints.Length < 2) return route;

        var spacing = Mathf.Max(0.1f, maximumSpacingMeters);
        var dense = new List<Route.Waypoint> { CloneWaypoint(route.waypoints[0]) };

        for (var i = 1; i < route.waypoints.Length; i++)
        {
            var from = route.waypoints[i - 1];
            var to = route.waypoints[i];
            var fromPosition = Position(from);
            var toPosition = Position(to);
            var steps = Mathf.Max(1, Mathf.CeilToInt(Vector3.Distance(fromPosition, toPosition) / spacing));

            for (var step = 1; step <= steps; step++)
            {
                if (step == steps)
                {
                    dense.Add(CloneWaypoint(to));
                    continue;
                }

                var position = Vector3.Lerp(fromPosition, toPosition, step / (float)steps);
                dense.Add(new Route.Waypoint
                {
                    id = Route.GuidanceWaypointPrefix + i + "-" + step,
                    position = new[] { position.x, position.y, position.z }
                });
            }
        }

        return new Route
        {
            schemaVersion = route.schemaVersion,
            zoneId = route.zoneId,
            coordinateSystem = route.coordinateSystem,
            heightReference = route.heightReference,
            waypoints = dense.ToArray()
        };
    }

    static Route.Waypoint CloneWaypoint(Route.Waypoint waypoint) => new Route.Waypoint
    {
        id = waypoint.id,
        position = new[] { waypoint.position[0], waypoint.position[1], waypoint.position[2] }
    };

    static Vector3 Position(Route.Waypoint waypoint) =>
        new Vector3(waypoint.position[0], waypoint.position[1], waypoint.position[2]);

    /// <summary>Puts a route.json polyline on the zone's floor when the floor height is known.</summary>
    public static void SnapToFloor(Route route, Graph zoneGraph)
    {
        if (route?.waypoints == null || zoneGraph == null) return;
        if (!zoneGraph.FloorHeights.TryGetValue(AnyFloor, out var floorHeight)) return;
        foreach (var waypoint in route.waypoints)
            waypoint.position = new[] { waypoint.position[0], floorHeight, waypoint.position[2] };
        route.heightReference = "floor";
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

    /// <summary>
    /// Same-floor cost is straight-line distance. A different floor costs at least one elevator boarding
    /// plus <see cref="ElevatorStoryCost"/> per story, which matches the ride edges and never exceeds them.
    /// Positions from different world maps are not comparable, so they are not used across zones.
    /// </summary>
    static float Heuristic(Graph graph, Node a, Node b)
    {
        if (a == null || b == null) return 0f;
        if (a.zone == b.zone) return Vector3.Distance(Position(a), Position(b));
        var stories = 1;
        if (a.zone != null && b.zone != null &&
            graph.ZoneStories.TryGetValue(a.zone, out var from) &&
            graph.ZoneStories.TryGetValue(b.zone, out var to) &&
            from != to)
            stories = Math.Abs(from - to);
        return ElevatorBoardCost + ElevatorStoryCost * stories;
    }

    public static Vector3 Position(Node node) => new Vector3(node.position[0], node.position[1], node.position[2]);

    static Vector2 Xz(float[] position) => new Vector2(position[0], position[2]);

    static string ShortId(string identifier)
    {
        if (string.IsNullOrEmpty(identifier)) return Guid.NewGuid().ToString("N").Substring(0, 8);
        return identifier.Substring(0, Math.Min(8, identifier.Length)).ToLowerInvariant();
    }

    static List<Wall> BuildWalls(Surface[] surfaces)
    {
        var list = new List<Wall>();
        if (surfaces == null) return list;
        foreach (var surface in surfaces)
        {
            if (!TrySurfaceSegment(surface, out var segment)) continue;
            var depth = surface.dimensions != null && surface.dimensions.Length > 2
                ? Mathf.Abs(surface.dimensions[2])
                : 0.1f;
            list.Add(new Wall(surface.identifier, segment, Mathf.Clamp(depth * 0.5f, 0.04f, 0.2f)));
        }
        return list;
    }

    static List<Portal> BuildPortals(Surface[] doors, Surface[] openings)
    {
        var list = new List<Portal>();
        CollectPortals(list, doors);
        CollectPortals(list, openings);
        return list;
    }

    static void CollectPortals(List<Portal> list, Surface[] surfaces)
    {
        if (surfaces == null) return;
        foreach (var surface in surfaces)
        {
            if (!TrySurfaceSegment(surface, out var segment)) continue;
            list.Add(new Portal(surface.identifier, surface.parentIdentifier, segment));
        }
    }

    /// <summary>
    /// RoomPlan walls often stop a few centimeters short of a corner or a T-junction.
    /// Seal that gap so a long edge cannot slip between two segments. Leave doorways open,
    /// and don't tie two parallel walls together.
    /// </summary>
    static void CloseCornerGaps(List<Wall> walls, List<Portal> portals)
    {
        const float maxGap = 0.3f;
        var added = new List<Wall>();
        for (var i = 0; i < walls.Count; i++)
        {
            for (var j = 0; j < walls.Count; j++)
            {
                if (i == j) continue;
                SealEnd(walls[i].Segment.A, walls[i], walls[j], portals, maxGap, added);
                SealEnd(walls[i].Segment.B, walls[i], walls[j], portals, maxGap, added);
            }
        }
        walls.AddRange(added);
    }

    static void SealEnd(Vector2 end, Wall from, Wall other, List<Portal> portals, float maxGap, List<Wall> added)
    {
        var closest = other.Segment.ClosestPoint(end);
        var gap = Vector2.Distance(end, closest);
        if (gap < 0.02f || gap > maxGap) return;
        var atEnd = Vector2.Distance(closest, other.Segment.A) <= 0.05f
            || Vector2.Distance(closest, other.Segment.B) <= 0.05f;
        if (!atEnd && RoughlyParallel(from, other)) return;
        if (NearPortal(end, portals, 0.4f) || NearPortal(closest, portals, 0.4f)) return;
        added.Add(new Wall(
            "corner-seal",
            new Segment(end, closest),
            Mathf.Min(from.HalfThickness, other.HalfThickness)));
    }

    static bool RoughlyParallel(Wall a, Wall b)
    {
        var da = a.Segment.B - a.Segment.A;
        var db = b.Segment.B - b.Segment.A;
        var la = da.magnitude;
        var lb = db.magnitude;
        if (la < 1e-4f || lb < 1e-4f) return false;
        var cross = da.x * db.y - da.y * db.x;
        return Mathf.Abs(cross) <= 0.25f * la * lb;
    }

    static bool NearPortal(Vector2 point, List<Portal> portals, float radius)
    {
        foreach (var portal in portals)
        {
            if (portal.Segment.DistanceTo(point) <= radius) return true;
        }
        return false;
    }

    static bool TrySurfaceSegment(Surface surface, out Segment segment)
    {
        segment = default;
        if (surface?.dimensions == null || surface.dimensions.Length < 1) return false;
        var half = Mathf.Abs(surface.dimensions[0]) * 0.5f;
        if (half < 0.01f) return false;

        Vector3 a;
        Vector3 b;
        if (surface.transformColumnMajor != null && surface.transformColumnMajor.Length == 16)
        {
            a = TransformPoint(surface.transformColumnMajor, new Vector3(-half, 0f, 0f));
            b = TransformPoint(surface.transformColumnMajor, new Vector3(half, 0f, 0f));
        }
        else if (surface.position != null && surface.position.Length == 3)
        {
            // The minimap draws a missing transform as identity, so the wall runs along X.
            a = new Vector3(surface.position[0] - half, surface.position[1], surface.position[2]);
            b = new Vector3(surface.position[0] + half, surface.position[1], surface.position[2]);
        }
        else
        {
            return false;
        }

        segment = new Segment(new Vector2(a.x, a.z), new Vector2(b.x, b.z));
        return segment.Length > 0.05f;
    }

    static Vector3 TransformPoint(float[] m, Vector3 local)
    {
        return new Vector3(
            m[0] * local.x + m[4] * local.y + m[8] * local.z + m[12],
            m[1] * local.x + m[5] * local.y + m[9] * local.z + m[13],
            m[2] * local.x + m[6] * local.y + m[10] * local.z + m[14]
        );
    }

    /// <summary>A RoomPlan wall in the floor plane. <see cref="HalfThickness"/> matches the drawn slab.</summary>
    public readonly struct Wall
    {
        public readonly string Id;
        public readonly Segment Segment;
        public readonly float HalfThickness;

        public Wall(string id, Segment segment, float halfThickness)
        {
            Id = id;
            Segment = segment;
            HalfThickness = halfThickness;
        }

        /// <summary>Lengthens the centerline by the slab thickness so a route cannot clip the square end.</summary>
        public Segment Extended()
        {
            var delta = Segment.B - Segment.A;
            var length = delta.magnitude;
            if (length < 1e-4f) return Segment;
            var extra = delta / length * HalfThickness;
            return new Segment(Segment.A - extra, Segment.B + extra);
        }
    }

    /// <summary>A door or opening that is the only place a neighbor line may cross its wall.</summary>
    public readonly struct Portal
    {
        public readonly string Id;
        public readonly string ParentId;
        public readonly Segment Segment;

        public Portal(string id, string parentId, Segment segment)
        {
            Id = id;
            ParentId = parentId;
            Segment = segment;
        }
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

        public float Length => Vector2.Distance(A, B);

        public Vector2 Midpoint => (A + B) * 0.5f;

        public bool TryIntersect(Vector2 p, Vector2 q, out Vector2 hit)
        {
            hit = default;
            var r = B - A;
            var s = q - p;
            var den = r.x * s.y - r.y * s.x;
            if (Mathf.Abs(den) < 1e-5f) return false;
            var qp = p - A;
            var t = (qp.x * s.y - qp.y * s.x) / den;
            // u is along the route. The previous cross(r, qp) flipped its sign, so real
            // crossings were ignored and walls never blocked a neighbor.
            var u = (qp.x * r.y - qp.y * r.x) / den;
            // Keep hits at the ends. Ignoring the last 2% of a wall let routes slip through corners.
            const float end = 1e-4f;
            if (t < -end || t > 1f + end || u < -end || u > 1f + end) return false;
            hit = A + r * t;
            return true;
        }

        public Vector2 ClosestPoint(Vector2 point)
        {
            var ab = B - A;
            var lengthSq = ab.sqrMagnitude;
            if (lengthSq < 1e-10f) return A;
            var t = Mathf.Clamp01(Vector2.Dot(point - A, ab) / lengthSq);
            return A + ab * t;
        }

        public float DistanceTo(Vector2 point) => Vector2.Distance(point, ClosestPoint(point));
    }

    static float Horizontal(Vector3 a, Vector3 b)
    {
        a.y = 0;
        b.y = 0;
        return Vector3.Distance(a, b);
    }
}
