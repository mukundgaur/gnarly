import type { BuildingLayout, Graph, Node, ScanFeatures, ZoneConnections, ZoneLayout, ZoneView } from './data.ts';
import { checkEdge, wallBetween, type EdgeCheck } from './geometry.ts';
import { shortestPath } from './routing.ts';
import { continuationGroups, resolveLayout, rigidFit, toLocal, toWorld, zoneTransforms, type Pair, type Vec3, type ZoneTransform } from './zoneAlign.ts';

/** Walking-meter cost of calling and boarding an elevator; matches the navigator. */
export const ELEVATOR_BOARD_COST = 30;
/** Walking-meter cost of riding one story; matches the navigator. */
export const ELEVATOR_STORY_COST = 6;
export const CONTINUATION_MIN_METERS = .5;
/** Waypoints of joined zones closer than this (horizontally) are linked across the seam. */
export const SEAM_METERS = 1.5;
/** Seam links per waypoint and neighboring zone, nearest first. */
export const SEAM_NEIGHBORS = 2;
/** Extra cost per seam crossing so routes through overlapping scans do not zig-zag between zones. */
export const SEAM_PENALTY = 1;
const SEAM_MAX_RISE = 1;

const checkCache = new WeakMap<Graph, Map<ScanFeatures | undefined, EdgeCheck[]>>();
/** Geometry checks for a zone graph, cached per graph and scan object so unchanged zones are not re-checked. */
export function zoneEdgeChecks(graph: Graph, scan?: ScanFeatures): EdgeCheck[] {
  let byScan = checkCache.get(graph);
  if (!byScan) checkCache.set(graph, byScan = new Map());
  let checks = byScan.get(scan);
  if (!checks) byScan.set(scan, checks = graph.edges.map(edge => checkEdge(edge, graph, scan)));
  return checks;
}

/** Same key format as the navigator's combined graph. */
export const nodeKey = (zoneId: string, nodeId: string) => zoneId + '/' + nodeId;
export function splitKey(key: string): { zoneId: string; nodeId: string } {
  const index = key.indexOf('/');
  return { zoneId: key.slice(0, index), nodeId: key.slice(index + 1) };
}

export type BuildingNode = Node & { key: string; zoneId: string; localId: string; level: number; world: Vec3 };
export type BuildingEdgeKind = 'walk' | 'stairs' | 'continuation' | 'seam' | 'elevator';
export type BuildingEdge = { from: string; to: string; meters: number; bidirectional?: boolean; kind: BuildingEdgeKind; check: EdgeCheck; zoneId?: string };
export type BuildingFloor = { level: number; name: string; zoneIds: string[] };
export type BuildingModel = {
  zones: ZoneView[];
  layout: ZoneLayout[];
  transforms: Map<string, ZoneTransform>;
  floors: BuildingFloor[];
  nodes: BuildingNode[];
  byKey: Map<string, BuildingNode>;
  edges: BuildingEdge[];
  /** Resolved links between zones, for display. Elevator links are listed once per saved link, not per ride. */
  links: BuildingEdge[];
  /** Generated walk links between nearby waypoints of joined zones. */
  seams: BuildingEdge[];
  issues: string[];
  levelOf: (zoneId: string, floorId: string) => number;
};

export function floorName(level: number, zones: ZoneView[], layout: ZoneLayout[], authored?: BuildingLayout): string {
  const named = authored?.floors?.find(item => item.floor === level)?.name;
  if (named) return named;
  for (const zone of zones) {
    if (layout.find(item => item.zoneId === zone.id)?.floor !== level) continue;
    const name = (zone.graph.floors.find(floor => floor.id === zone.floorId) || zone.graph.floors[0])?.name;
    if (name) return name;
  }
  return 'Floor ' + level;
}

export function combineBuilding(zones: ZoneView[], connections?: ZoneConnections, authored?: BuildingLayout): BuildingModel {
  const layout = resolveLayout(zones, connections, authored);
  const transforms = zoneTransforms(zones, layout);
  const issues: string[] = [];
  const levelOf = (zoneId: string, floorId: string) => {
    const zone = zones.find(item => item.id === zoneId), t = transforms.get(zoneId);
    if (!zone || !t) return 0;
    const base = zone.graph.floors.find(floor => floor.id === zone.floorId) || zone.graph.floors[0];
    const floor = zone.graph.floors.find(item => item.id === floorId);
    return t.floor + ((floor?.story ?? base?.story ?? 0) - (base?.story ?? 0));
  };
  const nodes: BuildingNode[] = [], edges: BuildingEdge[] = [], links: BuildingEdge[] = [];
  for (const zone of zones) {
    const t = transforms.get(zone.id)!;
    for (const node of zone.graph.nodes) nodes.push({ ...node, key: nodeKey(zone.id, node.id), zoneId: zone.id, localId: node.id, level: levelOf(zone.id, node.floor), world: toWorld(t, node.position) });
    const checks = zoneEdgeChecks(zone.graph, zone.scan);
    zone.graph.edges.forEach((edge, index) => edges.push({
      from: nodeKey(zone.id, edge.from), to: nodeKey(zone.id, edge.to), meters: edge.meters, bidirectional: edge.bidirectional,
      kind: edge.kind === 'stairs' ? 'stairs' : 'walk', check: checks[index], zoneId: zone.id,
    }));
  }
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const zoneById = new Map(zones.map(zone => [zone.id, zone]));
  const shafts = new Map<string, Set<string>>();
  const join = (a: string, b: string) => { for (const [x, y] of [[a, b], [b, a]]) { if (!shafts.has(x)) shafts.set(x, new Set()); shafts.get(x)!.add(y); } };
  for (const link of connections?.connections || []) {
    const a = byKey.get(nodeKey(link.from.zoneId, link.from.nodeId)), b = byKey.get(nodeKey(link.to.zoneId, link.to.nodeId));
    const label = link.from.zoneId + '/' + link.from.nodeId + ' ↔ ' + link.to.zoneId + '/' + link.to.nodeId;
    if (!a || !b) { issues.push('Skipped ' + label + ': a waypoint or zone is missing.'); continue; }
    if (a.type === 'elevator' && b.type === 'elevator' && link.kind !== 'continuation') {
      if (a.level === b.level) { issues.push('Skipped elevator ' + label + ': both ends are on the same floor.'); continue; }
      join(a.key, b.key);
      links.push({ from: a.key, to: b.key, meters: ELEVATOR_BOARD_COST + ELEVATOR_STORY_COST * Math.abs(a.level - b.level), kind: 'elevator', check: { status: 'valid', reason: 'Elevator link' } });
      continue;
    }
    if (a.type === 'continuation' && b.type === 'continuation' && link.kind !== 'elevator') {
      if (a.level !== b.level) { issues.push('Skipped continuation ' + label + ': the zones are on different floors.'); continue; }
      const walled = seamCheck(a, b, zoneById, transforms);
      const check: EdgeCheck = walled.status === 'blocked' ? { status: 'blocked', reason: 'Joined through a wall: ' + walled.reason.charAt(0).toLowerCase() + walled.reason.slice(1) } : { status: 'valid', reason: 'Zone continuation' };
      const edge: BuildingEdge = { from: a.key, to: b.key, meters: Math.max(CONTINUATION_MIN_METERS, Math.hypot(a.world[0] - b.world[0], a.world[2] - b.world[2])), kind: 'continuation', check };
      edges.push(edge); links.push(edge);
      continue;
    }
    issues.push('Skipped ' + label + ': link matching elevator or continuation waypoints.');
  }
  const seams = seamEdges(zones, connections, transforms, nodes);
  edges.push(...seams);
  // Linked elevators form a shaft; every pair of floors in it is one ride.
  const seen = new Set<string>();
  for (const start of shafts.keys()) {
    if (seen.has(start)) continue;
    const shaft: string[] = [], queue = [start];
    seen.add(start);
    while (queue.length) { const id = queue.shift()!; shaft.push(id); for (const next of shafts.get(id) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); } }
    for (let i = 0; i < shaft.length; i++) for (let j = i + 1; j < shaft.length; j++) {
      const a = byKey.get(shaft[i])!, b = byKey.get(shaft[j])!;
      if (a.level === b.level) continue;
      edges.push({ from: a.key, to: b.key, meters: ELEVATOR_BOARD_COST + ELEVATOR_STORY_COST * Math.abs(a.level - b.level), kind: 'elevator', check: { status: 'valid', reason: 'Elevator ride' } });
    }
  }
  const levels = [...new Set([...layout.map(item => item.floor), ...nodes.map(node => node.level)])].sort((a, b) => a - b);
  const floors = levels.map(level => ({
    level, name: floorName(level, zones, layout, authored),
    zoneIds: zones.filter(zone => zone.graph.floors.some(floor => levelOf(zone.id, floor.id) === level) || (!zone.graph.floors.length && transforms.get(zone.id)!.floor === level)).map(zone => zone.id),
  }));
  return { zones, layout, transforms, floors, nodes, byKey, edges, links, seams, issues, levelOf };
}

/**
 * The move that puts a floor's elevators directly above or below the elevators they are linked to, using the
 * linked floor with the most elevator pairs. One pair shifts the floor; two or more spread-out pairs also rotate it.
 */
export function elevatorFloorFit(model: BuildingModel, level: number): { move: Pick<ZoneLayout, 'x' | 'z' | 'rotationDegrees'>; reference: number; pairs: number } | null {
  const byLevel = new Map<number, Pair[]>();
  for (const link of model.links) {
    if (link.kind !== 'elevator') continue;
    const a = model.byKey.get(link.from)!, b = model.byKey.get(link.to)!;
    const [mine, other] = a.level === level ? [a, b] : b.level === level ? [b, a] : [];
    if (!mine || !other || other.level === level) continue;
    byLevel.set(other.level, [...(byLevel.get(other.level) || []), { local: mine.world, target: other.world }]);
  }
  const [reference, pairs] = [...byLevel].sort(([la, pa], [lb, pb]) => pb.length - pa.length || Math.abs(la - level) - Math.abs(lb - level) || la - lb)[0] || [];
  const move = pairs && rigidFit(pairs);
  return move ? { move, reference: reference!, pairs: pairs!.length } : null;
}

/** How close the walker must stand to an elevator waypoint to ride it. */
export const ELEVATOR_REACH_METERS = 1.5;

export type ElevatorStop = { from: BuildingNode; up?: BuildingNode; down?: BuildingNode };

/** The linked elevator the walker is standing at on `level`, with the nearest floor above and below in its shaft. */
export function elevatorStopNear(model: BuildingModel, world: Vec3, level: number, reach = ELEVATOR_REACH_METERS): ElevatorStop | null {
  let best: ElevatorStop | null = null, bestMeters = reach;
  for (const edge of model.edges) {
    if (edge.kind !== 'elevator') continue;
    for (const [fromKey, toKey] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      const from = model.byKey.get(fromKey)!, to = model.byKey.get(toKey)!;
      if (from.level !== level) continue;
      const meters = Math.hypot(from.world[0] - world[0], from.world[2] - world[2]);
      if (meters > bestMeters + 1e-9) continue;
      if (!best || best.from.key !== from.key) { best = { from }; bestMeters = meters; }
      if (to.level > level && (!best.up || to.level < best.up.level)) best.up = to;
      if (to.level < level && (!best.down || to.level > best.down.level)) best.down = to;
    }
  }
  return best;
}

function seamCheck(a: BuildingNode, b: BuildingNode, zones: Map<string, ZoneView>, transforms: Map<string, ZoneTransform>): EdgeCheck {
  let scanned = 0;
  for (const end of [a, b]) {
    const zone = zones.get(end.zoneId)!, t = transforms.get(end.zoneId)!;
    if (!zone.scan?.walls?.length) continue;
    scanned++;
    const story = zone.graph.floors.find(floor => floor.id === end.floor)?.story;
    const reason = wallBetween(toLocal(t, a.world), toLocal(t, b.world), zone.scan, story);
    if (reason) return { status: 'blocked', reason: reason + ' in ' + zone.name };
  }
  return scanned === 2 ? { status: 'valid', reason: 'Joined zones' } : { status: 'unverified', reason: 'Joined zones; a scan is missing, so walls were not checked' };
}

/** Links nearby waypoints of zones joined by continuation points, so their paths merge into one walkable floor. */
function seamEdges(zones: ZoneView[], connections: ZoneConnections | undefined, transforms: Map<string, ZoneTransform>, nodes: BuildingNode[]): BuildingEdge[] {
  const byId = new Map(zones.map(zone => [zone.id, zone]));
  const cellOf = (value: number) => Math.floor(value / SEAM_METERS);
  const seams: BuildingEdge[] = [];
  for (const group of continuationGroups(zones, connections)) {
    if (group.length < 2) continue;
    const members = new Set(group);
    const groupNodes = nodes.filter(node => members.has(node.zoneId));
    const grid = new Map<string, BuildingNode[]>();
    for (const node of groupNodes) {
      const cell = cellOf(node.world[0]) + ',' + cellOf(node.world[2]);
      grid.set(cell, [...(grid.get(cell) || []), node]);
    }
    const added = new Set<string>();
    for (const a of groupNodes) {
      const near = new Map<string, { node: BuildingNode; meters: number }[]>();
      const cx = cellOf(a.world[0]), cz = cellOf(a.world[2]);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const b of grid.get((cx + dx) + ',' + (cz + dz)) || []) {
        if (b.zoneId === a.zoneId || b.level !== a.level || Math.abs(b.world[1] - a.world[1]) > SEAM_MAX_RISE) continue;
        const meters = Math.hypot(a.world[0] - b.world[0], a.world[2] - b.world[2]);
        if (meters <= SEAM_METERS) near.set(b.zoneId, [...(near.get(b.zoneId) || []), { node: b, meters }]);
      }
      for (const list of near.values()) for (const { node: b, meters } of list.sort((x, y) => x.meters - y.meters).slice(0, SEAM_NEIGHBORS)) {
        const id = a.key < b.key ? a.key + '|' + b.key : b.key + '|' + a.key;
        if (added.has(id)) continue;
        added.add(id);
        const check = seamCheck(a, b, byId, transforms);
        if (check.status !== 'blocked') seams.push({ from: a.key, to: b.key, meters, kind: 'seam', check });
      }
    }
  }
  return seams;
}

export type RouteLeg = { zoneId: string; level: number; nodes: BuildingNode[] };
export type RouteTransition = { kind: 'elevator' | 'continuation' | 'stairs'; from: BuildingNode; to: BuildingNode };
export type BuildingRoute =
  | { ok: true; nodes: BuildingNode[]; edges: BuildingEdge[]; cost: number; walkingMeters: number; floorTransitions: number; unverifiedEdges: number; warningEdges: number; legs: RouteLeg[]; transitions: RouteTransition[] }
  | { ok: false; reason: 'invalid-endpoint' | 'no-walkable-route'; message: string };

export function findBuildingRoute(model: BuildingModel, startKey: string, destinationKey: string): BuildingRoute {
  if (!model.byKey.has(startKey) || !model.byKey.has(destinationKey)) return { ok: false, reason: 'invalid-endpoint', message: 'Choose valid start and destination waypoints.' };
  const allowed = model.edges.filter(edge => edge.check.status !== 'blocked').map(edge => ({ ...edge, meters: edge.kind === 'seam' ? edge.meters + SEAM_PENALTY : edge.meters, value: edge }));
  const result = shortestPath(allowed, startKey, destinationKey);
  if (!result) return { ok: false, reason: 'no-walkable-route', message: 'No walkable route found.' };
  const nodes = result.ids.map(id => model.byKey.get(id)!);
  const legs: RouteLeg[] = [], transitions: RouteTransition[] = [];
  nodes.forEach((node, index) => {
    const last = legs.at(-1);
    if (last && last.zoneId === node.zoneId && last.level === node.level) { last.nodes.push(node); return; }
    if (last) {
      const kind = result.edges[index - 1].kind;
      transitions.push({ kind: kind === 'elevator' ? 'elevator' : kind === 'continuation' || kind === 'seam' ? 'continuation' : 'stairs', from: nodes[index - 1], to: node });
    }
    legs.push({ zoneId: node.zoneId, level: node.level, nodes: [node] });
  });
  return {
    ok: true, nodes, edges: result.edges, cost: result.distance,
    walkingMeters: result.edges.filter(edge => edge.kind !== 'elevator').reduce((sum, edge) => sum + edge.meters, 0),
    floorTransitions: nodes.slice(1).filter((node, index) => node.level !== nodes[index].level).length,
    unverifiedEdges: result.edges.filter(edge => edge.check.status === 'unverified').length,
    warningEdges: result.edges.filter(edge => edge.check.status === 'warning').length,
    legs, transitions,
  };
}
