import type { Graph, Node, ScanFeatures, ZoneLayout, ZoneView } from './data.ts';
import { floorPolygon, pointOnFloor, surfaceSegment, wallBetween } from './geometry.ts';
import { addWaypoint, connectWaypoints } from './graphEdit.ts';
import { toLocal, toWorld, type Vec3 } from './zoneAlign.ts';

/** A point on the floor plane: [x, z]. */
export type P2 = [number, number];
export type Segment = [P2, P2];
export type Placement = Pick<ZoneLayout, 'x' | 'z' | 'rotationDegrees'>;

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const length = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => { const l = length(a) || 1; return [a[0] / l, a[1] / l]; };

export function normalizeDegrees(degrees: number): number {
  return Math.round((((degrees % 360) + 540) % 360 - 180) * 1000) / 1000;
}
/** Angle of a floor direction, counter-clockwise seen from above (the same sense as the zone rotation). */
const heading = (d: P2) => Math.atan2(-d[1], d[0]) * 180 / Math.PI;
const wrap = (degrees: number) => ((degrees % 360) + 540) % 360 - 180;

function baseFloor(zone: ZoneView) {
  return zone.graph.floors.find(floor => floor.id === zone.floorId) || zone.graph.floors[0];
}
/** The rectangle the viewer draws for a zone without a scan. */
function graphRectangle(graph: Graph, floorId: string): P2[] {
  const nodes = graph.nodes.filter(node => node.floor === floorId);
  const xs = nodes.map(node => node.position[0]), zs = nodes.map(node => node.position[2]);
  const minX = Math.min(0, ...xs) - 2, maxX = Math.max(0, ...xs) + 2, minZ = Math.min(0, ...zs) - 2, maxZ = Math.max(0, ...zs) + 2;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, hw = Math.max(4, maxX - minX) / 2, hd = Math.max(4, maxZ - minZ) / 2;
  return [[cx - hw, cz - hd], [cx + hw, cz - hd], [cx + hw, cz + hd], [cx - hw, cz + hd]];
}
const ring = (polygon: P2[]): Segment[] => polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);

/** The zone's ground-floor walls in its own coordinates. Without walls, the floor outline is used. */
export function zoneSegments(zone: ZoneView): Segment[] {
  const floor = baseFloor(zone);
  const story = floor?.story;
  const onStory = (item: { story?: number }) => story == null || item.story == null || item.story === story;
  const walls = (zone.scan?.walls || []).filter(onStory).map(surfaceSegment).filter(([a, b]) => length(sub(a, b)) > .05);
  if (walls.length) return walls;
  const floors = (zone.scan?.floors || []).filter(onStory);
  if (floors.length) return floors.flatMap(item => ring(floorPolygon(item)));
  return floor ? ring(graphRectangle(zone.graph, floor.id)) : [];
}

export function placeSegments(segments: Segment[], placement: Placement): Segment[] {
  return segments.map(([a, b]) => {
    const p = toWorld(placement, [a[0], 0, a[1]]), q = toWorld(placement, [b[0], 0, b[1]]);
    return [[p[0], p[2]], [q[0], q[2]]];
  });
}

/** Middle of the zone's outline in its own coordinates; rotations turn about this point. */
export function zoneCenter(zone: ZoneView): P2 {
  const points = zoneSegments(zone).flat();
  if (!points.length) return zone.graph.nodes.length
    ? [zone.graph.nodes.reduce((sum, node) => sum + node.position[0], 0) / zone.graph.nodes.length, zone.graph.nodes.reduce((sum, node) => sum + node.position[2], 0) / zone.graph.nodes.length]
    : [0, 0];
  const xs = points.map(point => point[0]), zs = points.map(point => point[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
}

/** The placement after turning by `degrees` about the zone's own `center`, which stays where it is. */
export function rotateAbout(placement: Placement, center: P2, degrees: number): Placement {
  const pivot = toWorld(placement, [center[0], 0, center[1]]);
  const rotationDegrees = normalizeDegrees(placement.rotationDegrees + degrees);
  const turned = toWorld({ x: 0, z: 0, rotationDegrees }, [center[0], 0, center[1]]);
  return { x: pivot[0] - turned[0], z: pivot[2] - turned[2], rotationDegrees };
}

export function segmentBounds(segments: Segment[]): { min: P2; max: P2 } | null {
  const points = segments.flat();
  if (!points.length) return null;
  return {
    min: [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
    max: [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))],
  };
}

/** Whether two placed zones' outlines come within `margin` meters of each other. */
export function zonesNear(a: ZoneView, ta: Placement, b: ZoneView, tb: Placement, margin = 1): boolean {
  const first = segmentBounds(placeSegments(zoneSegments(a), ta)), second = segmentBounds(placeSegments(zoneSegments(b), tb));
  if (!first || !second) return false;
  return first.min[0] <= second.max[0] + margin && second.min[0] <= first.max[0] + margin
    && first.min[1] <= second.max[1] + margin && second.min[1] <= first.max[1] + margin;
}

/**
 * Dominant wall direction, folded into a 90° range. Buildings are mostly rectilinear, so walls are
 * averaged on a 4× angle; undefined when the walls point every which way.
 */
export function dominantAngle(segments: Segment[]): number | undefined {
  let c = 0, s = 0, total = 0;
  for (const [a, b] of segments) {
    const d = sub(b, a), weight = length(d), angle = heading(d) * Math.PI / 180 * 4;
    c += Math.cos(angle) * weight; s += Math.sin(angle) * weight; total += weight;
  }
  if (!total || Math.hypot(c, s) / total < .15) return undefined;
  return Math.atan2(s, c) * 180 / Math.PI / 4;
}

export type RotationSnap = { rotationDegrees: number; kind: 'walls' | 'increment' | null };
/**
 * Snaps a free rotation so the moving zone's walls run parallel to a neighbor's (within `wallTolerance`),
 * otherwise to a multiple of `increment` (within `incrementTolerance`).
 */
export function snapRotation(free: number, movingLocalAngle: number | undefined, targetAngles: number[], increment = 15, wallTolerance = 8, incrementTolerance = 3): RotationSnap {
  let best: RotationSnap = { rotationDegrees: free, kind: null }, bestError = Infinity;
  if (movingLocalAngle !== undefined) for (const target of targetAngles) {
    const base = target - movingLocalAngle;
    const candidate = base + 90 * Math.round((free - base) / 90);
    const error = Math.abs(wrap(free - candidate));
    if (error < wallTolerance && error < bestError) { best = { rotationDegrees: candidate, kind: 'walls' }; bestError = error; }
  }
  if (best.kind) return best;
  const stepped = increment * Math.round(free / increment);
  return Math.abs(free - stepped) < incrementTolerance ? { rotationDegrees: stepped, kind: 'increment' } : best;
}

export type TranslationSnap = { delta: P2; kind: 'corner' | 'walls' | 'wall-end' | 'wall'; targets: number[]; point?: P2 };
type Constraint = { normal: P2; offset: number; moving: Segment; target: Segment; index: number };
const PARALLEL = Math.sin(2 * Math.PI / 180);

/**
 * The smallest shift that lands the moving outline on the target outline: a corner on a corner, a wall
 * flush against two non-parallel walls, or a wall flush against one wall with matching ends. Falls back
 * to sliding flush against a single wall. Distances are in meters; `tolerance` is the snap reach.
 */
export function snapTranslation(moving: Segment[], targets: Segment[], tolerance: number): TranslationSnap | null {
  if (!moving.length || !targets.length || !(tolerance > 0)) return null;
  const options: TranslationSnap[] = [];

  let corner: TranslationSnap | null = null, cornerDistance = tolerance;
  targets.forEach((target, index) => {
    for (const t of target) for (const m of moving.flat()) {
      const distance = length(sub(t, m));
      if (distance < cornerDistance) { cornerDistance = distance; corner = { delta: sub(t, m), kind: 'corner', targets: [index], point: t }; }
    }
  });
  if (corner) options.push(corner);

  const constraints: Constraint[] = [];
  targets.forEach((target, index) => {
    const along = sub(target[1], target[0]), span = length(along);
    if (span < .05) return;
    const u = unit(along), normal: P2 = [-u[1], u[0]];
    for (const segment of moving) {
      const direction = sub(segment[1], segment[0]);
      if (length(direction) < .05 || Math.abs(cross(unit(direction), u)) > PARALLEL) continue;
      const s0 = dot(sub(segment[0], target[0]), u), s1 = dot(sub(segment[1], target[0]), u);
      const gap = Math.max(0, Math.min(s0, s1) - span, -Math.max(s0, s1));
      if (gap > tolerance) continue;
      const middle = scale(add(segment[0], segment[1]), .5);
      const offset = -dot(normal, sub(middle, target[0]));
      if (Math.abs(offset) < tolerance) constraints.push({ normal, offset, moving: segment, target, index });
    }
  });
  const first = constraints.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];
  if (first) {
    const second = constraints.find(item => Math.abs(cross(item.normal, first.normal)) > .5);
    if (second) {
      const det = cross(first.normal, second.normal);
      const delta: P2 = [(first.offset * second.normal[1] - second.offset * first.normal[1]) / det, (first.normal[0] * second.offset - second.normal[0] * first.offset) / det];
      options.push({ delta, kind: 'walls', targets: [first.index, second.index] });
    }
    const slide = scale(first.normal, first.offset), u = unit(sub(first.target[1], first.target[0]));
    let end: number | undefined;
    for (const m of first.moving) for (const t of first.target) {
      const shift = dot(sub(t, add(m, slide)), u);
      if (Math.abs(shift) < tolerance && (end === undefined || Math.abs(shift) < Math.abs(end))) end = shift;
    }
    if (end !== undefined) options.push({ delta: add(slide, scale(u, end)), kind: 'wall-end', targets: [first.index] });
    const locked = options.filter(option => length(option.delta) < tolerance * 1.5).sort((a, b) => length(a.delta) - length(b.delta))[0];
    return locked || { delta: slide, kind: 'wall', targets: [first.index] };
  }
  return corner;
}

// ---------- Joining zones ----------

export type JoinEnd = { zoneId: string; floorId: string; position: Vec3; anchorId: string };
export type JoinPlan = { a: JoinEnd; b: JoinEnd; gap: number; verified: boolean };
/** Floors farther apart than this are not considered touching. */
export const JOIN_GAP_METERS = 1;
const CONNECTOR_TYPES_TO_SKIP = new Set(['elevator', 'continuation', 'stairs']);

type Sample = { local: Vec3; world: P2 };
function floorSamples(zone: ZoneView, placement: Placement, floorId: string): Sample[] {
  const floor = zone.graph.floors.find(item => item.id === floorId);
  const story = floor?.story;
  const polygons = (zone.scan?.floors || []).filter(item => story == null || item.story == null || item.story === story).map(floorPolygon);
  const outline = polygons.length ? polygons.flat() : graphRectangle(zone.graph, floorId);
  const bounds = segmentBounds(ring(outline));
  if (!bounds) return [];
  const area = (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]);
  const step = Math.max(.25, Math.sqrt(area / 5000));
  const samples: Sample[] = [];
  for (let x = bounds.min[0] + step / 2; x < bounds.max[0]; x += step) for (let z = bounds.min[1] + step / 2; z < bounds.max[1]; z += step) {
    const local: Vec3 = [x, 0, z];
    if (!pointOnFloor(local, floorId, zone.graph, zone.scan)) continue;
    const world = toWorld(placement, local);
    samples.push({ local, world: [world[0], world[2]] });
  }
  return samples;
}

/** A continuation waypoint at `end.position`, linked to its walkable anchor. Throws if the anchor is gone or walled off. */
export function withContinuation(graph: Graph, scan: ScanFeatures | undefined, end: JoinEnd, id: string): Graph {
  const anchor = graph.nodes.find(node => node.id === end.anchorId);
  if (!anchor) throw Error('Waypoint ' + end.anchorId + ' changed since the join was planned. Try again.');
  const node: Node = { id, floor: end.floorId, type: 'continuation', position: [end.position[0], anchor.position[1], end.position[2]], label: 'Zone continuation', source: 'manual' };
  return connectWaypoints(addWaypoint(graph, node, scan), id, anchor.id, scan);
}

/** Nearest waypoint that a new point at `local` can be connected to without crossing a wall. */
function anchorFor(zone: ZoneView, floorId: string, local: Vec3, tries = 6): Node | undefined {
  const candidates = zone.graph.nodes
    .filter(node => node.floor === floorId && !CONNECTOR_TYPES_TO_SKIP.has(node.type))
    .sort((a, b) => Math.hypot(a.position[0] - local[0], a.position[2] - local[2]) - Math.hypot(b.position[0] - local[0], b.position[2] - local[2]))
    .slice(0, tries);
  for (const anchor of candidates) {
    try {
      withContinuation(zone.graph, zone.scan, { zoneId: zone.id, floorId, position: local, anchorId: anchor.id }, '__join-probe__');
      return anchor;
    } catch { /* walled off or off the floor; try the next one */ }
  }
  return undefined;
}

/**
 * Where two placed zones on one floor meet: a spot inside both floors (or the closest pair of floor
 * points within JOIN_GAP_METERS), close to waypoints in each zone that it can be wired to.
 */
/** Why the straight step between two world floor points crosses a wall (outside a door or opening) in either zone. */
export function seamWall(...ends: [zone: ZoneView, placement: Placement, floorId: string][]) {
  return (p: P2, q: P2): string | null => {
    for (const [zone, placement, floorId] of ends) {
      if (!zone.scan?.walls?.length) continue;
      const story = zone.graph.floors.find(floor => floor.id === floorId)?.story;
      const reason = wallBetween(toLocal(placement, [p[0], 0, p[1]]), toLocal(placement, [q[0], 0, q[1]]), zone.scan, story);
      if (reason) return reason;
    }
    return null;
  };
}

export function planJoin(a: ZoneView, ta: Placement, b: ZoneView, tb: Placement): JoinPlan | { error: string; walled?: boolean; at?: P2 } {
  const floorA = baseFloor(a)?.id, floorB = baseFloor(b)?.id;
  if (!floorA || !floorB) return { error: 'Both zones need a floor.' };
  const samplesA = floorSamples(a, ta, floorA), samplesB = floorSamples(b, tb, floorB);
  const cell = (value: number) => Math.floor(value / JOIN_GAP_METERS);
  const grid = new Map<string, Sample[]>();
  for (const sample of samplesB) {
    const key = cell(sample.world[0]) + ',' + cell(sample.world[1]);
    grid.set(key, [...(grid.get(key) || []), sample]);
  }
  const pairs: { p: Sample; q: Sample; gap: number }[] = [];
  for (const p of samplesA) {
    let best: Sample | undefined, gap = JOIN_GAP_METERS;
    const cx = cell(p.world[0]), cz = cell(p.world[1]);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const q of grid.get((cx + dx) + ',' + (cz + dz)) || []) {
      const distance = length(sub(p.world, q.world));
      if (distance <= gap) { gap = distance; best = q; }
    }
    if (best) pairs.push({ p, q: best, gap });
  }
  if (!pairs.length) return { error: 'These zones do not touch. Drag ' + a.name + ' until its floor meets or overlaps ' + b.name + ' (within ' + JOIN_GAP_METERS + ' m).' };
  const walled = seamWall([a, ta, floorA], [b, tb, floorB]);
  const open = pairs.filter(pair => !walled(pair.p.world, pair.q.world));
  if (!open.length) {
    const at = pairs.reduce<P2>((sum, pair) => [sum[0] + (pair.p.world[0] + pair.q.world[0]) / 2 / pairs.length, sum[1] + (pair.p.world[1] + pair.q.world[1]) / 2 / pairs.length], [0, 0]);
    return { error: a.name + ' and ' + b.name + ' meet along a solid wall, so they stay closed off. Line up a door or opening in that wall, or place seam points by hand where people walk through.', walled: true, at };
  }

  const nearest = (zone: ZoneView, floorId: string, local: Vec3) => Math.min(Infinity, ...zone.graph.nodes
    .filter(node => node.floor === floorId && !CONNECTOR_TYPES_TO_SKIP.has(node.type))
    .map(node => Math.hypot(node.position[0] - local[0], node.position[2] - local[2])));
  const ranked = open
    .map(pair => ({ ...pair, score: pair.gap * 3 + nearest(a, floorA, pair.p.local) + nearest(b, floorB, pair.q.local) }))
    .filter(pair => Number.isFinite(pair.score))
    .sort((x, y) => x.score - y.score)
    .slice(0, 40);
  for (const pair of ranked) {
    const anchorA = anchorFor(a, floorA, pair.p.local);
    const anchorB = anchorA && anchorFor(b, floorB, pair.q.local);
    if (!anchorA || !anchorB) continue;
    return {
      a: { zoneId: a.id, floorId: floorA, position: [pair.p.local[0], anchorA.position[1], pair.p.local[2]], anchorId: anchorA.id },
      b: { zoneId: b.id, floorId: floorB, position: [pair.q.local[0], anchorB.position[1], pair.q.local[2]], anchorId: anchorB.id },
      gap: pair.gap,
      verified: Boolean(a.scan?.floors?.length && b.scan?.floors?.length),
    };
  }
  return { error: 'The zones touch, but no waypoint near the seam can be reached without crossing a wall. Add a waypoint near where they meet in each zone, then try again.' };
}
