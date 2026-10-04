import type { BuildingLayout, ZoneConnections, ZoneLayout, ZoneView } from './data.ts';

/** Display height between stacked floors, in meters. */
export const FLOOR_GAP = 4;
export type Vec3 = [number, number, number];
/** Places a zone's ARKit coordinates in its floor's shared frame. y lifts the zone's ground to its floor level. */
export type ZoneTransform = ZoneLayout & { y: number };

const radians = (degrees: number) => degrees * Math.PI / 180;
/** Same convention as a three.js group rotated about Y. */
export function toWorld(t: Pick<ZoneTransform, 'x' | 'z' | 'rotationDegrees'> & { y?: number }, p: Vec3): Vec3 {
  const r = radians(t.rotationDegrees), c = Math.cos(r), s = Math.sin(r);
  return [p[0] * c + p[2] * s + t.x, p[1] + (t.y || 0), -p[0] * s + p[2] * c + t.z];
}
export function toLocal(t: Pick<ZoneTransform, 'x' | 'z' | 'rotationDegrees'> & { y?: number }, w: Vec3): Vec3 {
  const r = radians(t.rotationDegrees), c = Math.cos(r), s = Math.sin(r), dx = w[0] - t.x, dz = w[2] - t.z;
  return [dx * c - dz * s, w[1] - (t.y || 0), dx * s + dz * c];
}

function continuationPairs(connections?: ZoneConnections) {
  return (connections?.connections || []).filter(link => link.kind === 'continuation' || link.kind === undefined);
}
const nodeOf = (zones: ZoneView[], zoneId: string, nodeId: string) => zones.find(zone => zone.id === zoneId)?.graph.nodes.find(node => node.id === nodeId);
function isContinuationLink(zones: ZoneView[], link: ZoneConnections['connections'][number]) {
  return nodeOf(zones, link.from.zoneId, link.from.nodeId)?.type === 'continuation' && nodeOf(zones, link.to.zoneId, link.to.nodeId)?.type === 'continuation';
}

/** Zones joined by continuation links, which always share a floor. */
export function continuationGroups(zones: ZoneView[], connections?: ZoneConnections): string[][] {
  const parent = new Map(zones.map(zone => [zone.id, zone.id]));
  const find = (id: string): string => parent.get(id) === id ? id : find(parent.get(id)!);
  for (const link of continuationPairs(connections)) {
    if (!parent.has(link.from.zoneId) || !parent.has(link.to.zoneId) || !isContinuationLink(zones, link)) continue;
    parent.set(find(link.from.zoneId), find(link.to.zoneId));
  }
  const groups = new Map<string, string[]>();
  for (const zone of zones) groups.set(find(zone.id), [...(groups.get(find(zone.id)) || []), zone.id]);
  return [...groups.values()];
}

const nameNumber = (zone: ZoneView) => { const value = Number((zone.floorId + ' ' + zone.name + ' ' + zone.id).match(/-?\d+/)?.[0]); return Number.isFinite(value) ? value : undefined; };
const baseFloor = (zone: ZoneView) => zone.graph.floors.find(floor => floor.id === zone.floorId) || zone.graph.floors[0];

/**
 * RoomPlan reports story 0 for every separate scan, so graph stories are used only when they differ
 * between floors. Otherwise a number in the zone's floor id or name is used, then capture order.
 */
export function guessFloors(zones: ZoneView[], connections?: ZoneConnections): Map<string, number> {
  const groups = continuationGroups(zones, connections);
  const byId = new Map(zones.map(zone => [zone.id, zone]));
  const pick = (value: (zone: ZoneView) => number | undefined) => groups.map(group => {
    const values = group.map(id => value(byId.get(id)!)).filter((item): item is number => Number.isFinite(item));
    return values.length ? Math.min(...values) : undefined;
  });
  const distinct = (values: (number | undefined)[]) => values.every(value => value !== undefined) && new Set(values).size === values.length;
  const stories = pick(zone => baseFloor(zone)?.story), named = pick(nameNumber);
  const chosen = distinct(stories) ? stories : distinct(named) ? named : groups.map((_, index) => index);
  const result = new Map<string, number>();
  groups.forEach((group, index) => group.forEach(id => result.set(id, chosen[index]!)));
  return result;
}

/** ARKit y of a zone's walking surface, so floors line up when stacked. */
export function zoneGround(zone: ZoneView): number {
  const scanned = (zone.scan?.floors || []).map(floor => floor.position?.[1]).filter(Number.isFinite);
  return scanned.length ? Math.min(...scanned) : baseFloor(zone)?.elevation || 0;
}

export type Pair = { local: Vec3; target: Vec3 };
function pairsFor(zoneId: string, zones: ZoneView[], connections: ZoneConnections | undefined, placed: Map<string, ZoneLayout>): Pair[] {
  const pairs: Pair[] = [];
  for (const link of continuationPairs(connections)) {
    if (!isContinuationLink(zones, link)) continue;
    for (const [mine, other] of [[link.from, link.to], [link.to, link.from]]) {
      if (mine.zoneId !== zoneId || other.zoneId === zoneId || !placed.has(other.zoneId)) continue;
      const a = nodeOf(zones, mine.zoneId, mine.nodeId), b = nodeOf(zones, other.zoneId, other.nodeId);
      if (a && b) pairs.push({ local: a.position, target: toWorld(placed.get(other.zoneId)!, b.position) });
    }
  }
  return pairs;
}

/**
 * Fits a zone onto already placed neighbors through matching continuation points. One pair fixes the
 * position and keeps the current rotation; two or more spread-out pairs also solve the rotation.
 */
export function fitZone(zoneId: string, zones: ZoneView[], connections: ZoneConnections | undefined, placed: Map<string, ZoneLayout>, rotationDegrees = 0): Pick<ZoneLayout, 'x' | 'z' | 'rotationDegrees'> | null {
  return rigidFit(pairsFor(zoneId, zones, connections, placed), rotationDegrees);
}

/** Transform with toWorld(t, local) ≈ target for every pair; rotation is solved only from two or more spread-out pairs. */
export function rigidFit(pairs: Pair[], rotationDegrees = 0): Pick<ZoneLayout, 'x' | 'z' | 'rotationDegrees'> | null {
  if (!pairs.length) return null;
  const mean = (points: Vec3[]) => [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[2], 0) / points.length];
  const [lx, lz] = mean(pairs.map(pair => pair.local)), [tx, tz] = mean(pairs.map(pair => pair.target));
  const spread = Math.max(...pairs.map(pair => Math.hypot(pair.local[0] - lx, pair.local[2] - lz)));
  let rotation = rotationDegrees;
  if (pairs.length > 1 && spread > .3) {
    let dot = 0, cross = 0;
    for (const { local, target } of pairs) {
      const px = local[0] - lx, pz = local[2] - lz, qx = target[0] - tx, qz = target[2] - tz;
      dot += qx * px + qz * pz;
      cross += qx * pz - qz * px;
    }
    rotation = Math.atan2(cross, dot) * 180 / Math.PI;
  }
  const rotated = toWorld({ x: 0, z: 0, rotationDegrees: rotation }, [lx, 0, lz]);
  return { x: tx - rotated[0], z: tz - rotated[2], rotationDegrees: Math.round(rotation * 1000) / 1000 };
}

/** Every zone's placement: authored entries win; others are fitted through continuation links or left at the origin. */
export function resolveLayout(zones: ZoneView[], connections?: ZoneConnections, layout?: BuildingLayout): ZoneLayout[] {
  const authored = new Map((layout?.zones || []).filter(item => zones.some(zone => zone.id === item.zoneId)).map(item => [item.zoneId, item]));
  const guessed = guessFloors(zones, connections);
  const placed = new Map<string, ZoneLayout>(authored);
  for (const group of continuationGroups(zones, connections)) {
    const floor = group.map(id => authored.get(id)?.floor).find(Number.isFinite) ?? guessed.get(group[0])!;
    if (!group.some(id => placed.has(id))) placed.set(group[0], { zoneId: group[0], floor, x: 0, z: 0, rotationDegrees: 0 });
    for (let changed = true; changed;) {
      changed = false;
      for (const id of group) {
        if (placed.has(id)) continue;
        const fit = fitZone(id, zones, connections, placed);
        if (fit) { placed.set(id, { zoneId: id, floor, ...fit }); changed = true; }
      }
    }
    for (const id of group) if (!placed.has(id)) placed.set(id, { zoneId: id, floor, x: 0, z: 0, rotationDegrees: 0 });
  }
  return zones.map(zone => placed.get(zone.id)!);
}

export function zoneTransforms(zones: ZoneView[], layout: ZoneLayout[]): Map<string, ZoneTransform> {
  const byId = new Map(layout.map(item => [item.zoneId, item]));
  return new Map(zones.map(zone => {
    const item = byId.get(zone.id) || { zoneId: zone.id, floor: 0, x: 0, z: 0, rotationDegrees: 0 };
    return [zone.id, { ...item, y: item.floor * FLOOR_GAP - zoneGround(zone) }];
  }));
}

/**
 * Moves every zone on a floor as one rigid piece: rotates by move.rotationDegrees about pivot, then shifts
 * by move.x / move.z. Zones keep their positions relative to each other.
 */
export function moveFloor(layout: ZoneLayout[], floor: number, move: Pick<ZoneLayout, 'x' | 'z' | 'rotationDegrees'>, pivot: [number, number] = [0, 0]): ZoneLayout[] {
  const frame = { x: pivot[0] + move.x, z: pivot[1] + move.z, rotationDegrees: move.rotationDegrees };
  return layout.map(item => {
    if (item.floor !== floor) return item;
    const [x, , z] = toWorld(frame, [item.x - pivot[0], 0, item.z - pivot[1]]);
    const rotation = ((item.rotationDegrees + move.rotationDegrees) % 360 + 540) % 360 - 180;
    return { ...item, x, z, rotationDegrees: Math.round(rotation * 1000) / 1000 };
  });
}

export function upsertZoneLayout(layout: BuildingLayout | undefined, entry: ZoneLayout): BuildingLayout {
  const current = layout || { schemaVersion: 1, zones: [] };
  return { ...current, zones: [...current.zones.filter(item => item.zoneId !== entry.zoneId), entry] };
}
