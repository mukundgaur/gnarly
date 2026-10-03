using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Stairwells are separate world maps from the floor that detected them.
/// Each stair zone is a linked-list node: prev is the floor below, next is the floor above.
/// floorIndex is the hash map from stair id and direction to the floor that exit lands on.
/// </summary>
public class StairsDocument
{
    [Serializable]
    public class File
    {
        public int schemaVersion;
        public string capturedAt;
        public StairZone[] stairs;
        public FloorIndexEntry[] floorIndex;
        public Connection[] connections;
        public string notes;
    }

    [Serializable]
    public class FloorPointer
    {
        public string floorId;
        public string zoneId;
        public int story;
    }

    [Serializable]
    public class StairZone
    {
        public string id;
        public string zoneId;
        public string roomPlanIdentifier;
        public string detectedOnFloorId;
        public string detectedOnZoneId;
        public float[] position;
        public FloorPointer prev;
        public FloorPointer next;
        public bool scanned;
        public float[] landingBelow;
        public float[] landingAbove;

        public FloorPointer Pointer(string direction) => direction == "up" ? next : prev;
    }

    [Serializable]
    public class FloorIndexEntry
    {
        public string stairId;
        public string direction;
        public string floorId;
        public string zoneId;
        public int story;
    }

    [Serializable]
    public class Connection
    {
        public string fromZoneId;
        public string fromFloorId;
        public string fromNodeId;
        public string toZoneId;
        public string toFloorId;
        public string kind;
    }

    /// <summary>Hash map: "stairId:up" or "stairId:down" to the floor that direction lands on.</summary>
    public class FloorIndex
    {
        readonly Dictionary<string, FloorPointer> floors = new Dictionary<string, FloorPointer>();

        public FloorIndex(StairZone[] stairs, FloorIndexEntry[] entries)
        {
            if (entries != null)
            {
                foreach (var entry in entries)
                {
                    if (entry == null || string.IsNullOrEmpty(entry.stairId) || string.IsNullOrEmpty(entry.direction))
                        continue;
                    floors[Key(entry.stairId, entry.direction)] = new FloorPointer
                    {
                        floorId = entry.floorId,
                        zoneId = entry.zoneId,
                        story = entry.story
                    };
                }
            }

            if (stairs == null) return;
            foreach (var stair in stairs)
            {
                if (stair == null) continue;
                if (stair.prev != null) floors[Key(stair.id, "down")] = stair.prev;
                if (stair.next != null) floors[Key(stair.id, "up")] = stair.next;
            }
        }

        public static string Key(string stairId, string direction) => stairId + ":" + direction;

        public FloorPointer Floor(string stairId, string direction)
        {
            if (string.IsNullOrEmpty(stairId)) return null;
            floors.TryGetValue(Key(stairId, direction), out var floor);
            return floor;
        }
    }

    public StairZone[] Stairs { get; private set; }
    public FloorIndex Index { get; private set; }

    public static StairsDocument Parse(string json)
    {
        var file = JsonUtility.FromJson<File>(json);
        if (file == null) throw new FormatException("stairs.json is empty or invalid.");
        if (file.schemaVersion != 1)
            throw new FormatException($"Unsupported stairs schemaVersion {file.schemaVersion}.");
        return new StairsDocument
        {
            Stairs = file.stairs ?? Array.Empty<StairZone>(),
            Index = new FloorIndex(file.stairs, file.floorIndex)
        };
    }

    public StairZone Find(string idOrZone)
    {
        if (Stairs == null || string.IsNullOrEmpty(idOrZone)) return null;
        foreach (var stair in Stairs)
        {
            if (stair == null) continue;
            if (stair.id == idOrZone || stair.zoneId == idOrZone) return stair;
        }
        return null;
    }

    /// <summary>Follow prev/next from a floor to the stair that leaves it in that direction.</summary>
    public StairZone StairFromFloor(string floorId, string direction)
    {
        if (Stairs == null || string.IsNullOrEmpty(floorId)) return null;
        foreach (var stair in Stairs)
        {
            if (stair == null) continue;
            if (direction == "up" && stair.prev != null && stair.prev.floorId == floorId) return stair;
            if (direction == "down" && stair.next != null && stair.next.floorId == floorId) return stair;
        }
        return null;
    }
}
