import assert from 'node:assert/strict';
import test from 'node:test';
import type { Graph, ScanFeature, ScanFeatures, ZoneConnections, ZoneView } from './data.ts';
import { demoBuilding } from './data.ts';
import { combineBuilding, ELEVATOR_BOARD_COST, ELEVATOR_STORY_COST, elevatorFloorFit, elevatorStopNear, findBuildingRoute, nodeKey } from './buildingGraph.ts';
import { fitZone, guessFloors, moveFloor, resolveLayout, toLocal, toWorld } from './zoneAlign.ts';
import { addZoneConnection, emptyZoneConnections } from './zoneConnections.ts';

const near = (a: number[], b: number[]) => a.every((value, index) => Math.abs(value - b[index]) < 1e-6);
const zone = (id: string, nodes: Graph['nodes'], edges: [string, string, number][], story = 0): ZoneView => ({
  id, name: id, floorId: 'ground', notice: '',
  graph: { floors: [{ id: 'ground', story, elevation: 0 }], nodes, edges: edges.map(([from, to, meters]) => ({ from, to, meters, kind: 'hallway', source: 'manual' })) },
});
const node = (id: string, type: string, x: number, z: number) => ({ id, floor: 'ground', type, position: [x, 0, z] as [number, number, number] });

test('zone transforms round-trip and match a three.js Y rotation', () => {
  const t = { x: 3, z: -2, rotationDegrees: 90, y: 1 };
  assert.ok(near(toWorld(t, [1, 0, 0]), [3, 1, -3]));
  assert.ok(near(toLocal(t, toWorld(t, [2.5, .4, -7])), [2.5, .4, -7]));
});

test('one continuation pair snaps position; two pairs also solve rotation', () => {
  const west = zone('west', [node('end-a', 'continuation', 1, 10), node('end-b', 'continuation', -4, 10)], []);
  const east = zone('east', [node('start-a', 'continuation', 0, 1), node('start-b', 'continuation', 0, -4)], []);
  const one: ZoneConnections = { schemaVersion: 1, connections: [{ from: { zoneId: 'west', nodeId: 'end-a' }, to: { zoneId: 'east', nodeId: 'start-a' }, kind: 'continuation' }] };
  const placed = new Map([['west', { zoneId: 'west', floor: 0, x: 0, z: 0, rotationDegrees: 0 }]]);
  const translated = fitZone('east', [west, east], one, placed)!;
  assert.equal(translated.rotationDegrees, 0);
  assert.ok(near(toWorld(translated, [0, 0, 1]), [1, 0, 10]));
  const two: ZoneConnections = { ...one, connections: [...one.connections, { from: { zoneId: 'west', nodeId: 'end-b' }, to: { zoneId: 'east', nodeId: 'start-b' }, kind: 'continuation' }] };
  const rigid = fitZone('east', [west, east], two, placed)!;
  assert.ok(Math.abs(rigid.rotationDegrees - 90) < 1e-6);
  assert.ok(near(toWorld(rigid, [0, 0, 1]), [1, 0, 10]));
  assert.ok(near(toWorld(rigid, [0, 0, -4]), [-4, 0, 10]));
});

test('continuation-joined zones share a floor; separate scans that all report story 0 use their names', () => {
  const a = zone('floor-1-west', [node('end', 'continuation', 0, 0)], []), b = zone('floor-1-east', [node('start', 'continuation', 0, 0)], []), c = zone('floor-2', [], []);
  const links: ZoneConnections = { schemaVersion: 1, connections: [{ from: { zoneId: a.id, nodeId: 'end' }, to: { zoneId: b.id, nodeId: 'start' }, kind: 'continuation' }] };
  const floors = guessFloors([a, b, c], links);
  assert.equal(floors.get(a.id), floors.get(b.id));
  assert.notEqual(floors.get(a.id), floors.get('floor-2'));
  const authored = resolveLayout([a, b, c], links, { schemaVersion: 1, zones: [{ zoneId: a.id, floor: 3, x: 5, z: 0, rotationDegrees: 0 }] });
  assert.equal(authored.find(item => item.zoneId === b.id)!.floor, 3);
  assert.equal(authored.find(item => item.zoneId === b.id)!.x, 5);
});

test('routes continue across joined zones on one floor', () => {
  const west = zone('west', [node('entry', 'entrance', 0, 0), node('end', 'continuation', 5, 0)], [['entry', 'end', 5]]);
  const east = zone('east', [node('start', 'continuation', 0, 0), node('room', 'destination', 0, 4)], [['start', 'room', 4]]);
  const links: ZoneConnections = { schemaVersion: 1, connections: [{ from: { zoneId: 'west', nodeId: 'end' }, to: { zoneId: 'east', nodeId: 'start' }, kind: 'continuation' }] };
  const model = combineBuilding([west, east], links);
  assert.equal(model.floors.length, 1);
  const route = findBuildingRoute(model, nodeKey('west', 'entry'), nodeKey('east', 'room'));
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.deepEqual(route.nodes.map(item => item.key), ['west/entry', 'west/end', 'east/start', 'east/room']);
  assert.equal(route.legs.length, 2);
  assert.equal(route.transitions[0].kind, 'continuation');
  assert.equal(route.floorTransitions, 0);
  assert.ok(Math.abs(route.walkingMeters - 9.5) < 1e-6);
  const unlinked = combineBuilding([west, east], emptyZoneConnections());
  assert.equal(findBuildingRoute(unlinked, nodeKey('west', 'entry'), nodeKey('east', 'room')).ok, false);
});

test('elevators teleport between floors without merging zones, and a shaft is one ride', () => {
  const floors = [1, 2, 3].map(level => zone('floor-' + level, [node('lift', 'elevator', level * 10, 0), node('room', 'destination', level * 10, 5)], [['lift', 'room', 5]], level));
  const shaft: ZoneConnections = { schemaVersion: 1, connections: [
    { from: { zoneId: 'floor-1', nodeId: 'lift' }, to: { zoneId: 'floor-2', nodeId: 'lift' }, kind: 'elevator' },
    { from: { zoneId: 'floor-2', nodeId: 'lift' }, to: { zoneId: 'floor-3', nodeId: 'lift' }, kind: 'elevator' },
  ] };
  const model = combineBuilding(floors, shaft);
  assert.deepEqual(model.floors.map(floor => floor.zoneIds), [['floor-1'], ['floor-2'], ['floor-3']]);
  assert.ok(model.layout.every(item => item.x === 0 && item.z === 0), 'elevator links never align zones');
  const route = findBuildingRoute(model, nodeKey('floor-1', 'room'), nodeKey('floor-3', 'room'));
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.deepEqual(route.nodes.map(item => item.key), ['floor-1/room', 'floor-1/lift', 'floor-3/lift', 'floor-3/room']);
  assert.equal(route.transitions[0].kind, 'elevator');
  assert.equal(route.cost, 10 + ELEVATOR_BOARD_COST + 2 * ELEVATOR_STORY_COST);
  assert.equal(route.walkingMeters, 10);
  assert.equal(route.floorTransitions, 1);
});

const wallFeature = (identifier: string, dimensions: [number, number, number], position: [number, number, number], vertical: boolean): ScanFeature => ({
  identifier, category: vertical ? 'wall' : 'floor', dimensions, position, story: 0,
  transformColumnMajor: vertical ? [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, ...position, 1] : [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, ...position, 1],
});
/** Two scans of one hallway, joined only at z=0; their walked points run 0.4 m apart. */
function overlappingHall(scanB?: ScanFeatures) {
  const chain = (prefix: string, x: number) => [0, 2, 4, 6, 8].map(z => node(prefix + z, 'waypoint', x, z));
  const links = (prefix: string): [string, string, number][] => [0, 2, 4, 6].map(z => [prefix + z, prefix + (z + 2), 2]);
  const a = zone('a', [...chain('a', -1), node('join', 'continuation', -1, 0)], [...links('a'), ['a0', 'join', 0]]);
  const b = { ...zone('b', [...chain('b', -.6), node('join', 'continuation', -1, 0), node('room', 'destination', -.6, 9)], [...links('b'), ['b0', 'join', .4], ['b8', 'room', 1]]), scan: scanB };
  const joined: ZoneConnections = { schemaVersion: 1, connections: [{ from: { zoneId: 'a', nodeId: 'join' }, to: { zoneId: 'b', nodeId: 'join' }, kind: 'continuation' }] };
  return combineBuilding([a, b], joined);
}

test('joined zones merge their paths through nearby waypoints', () => {
  const model = overlappingHall();
  assert.ok(model.seams.length >= 5);
  assert.ok(model.seams.every(seam => seam.check.status === 'unverified'), 'no scans, so seams are usable but unverified');
  const route = findBuildingRoute(model, nodeKey('a', 'a8'), nodeKey('b', 'room'));
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.deepEqual(route.nodes.map(item => item.key), ['a/a8', 'b/room']);
  assert.ok(route.walkingMeters < 2);
  assert.equal(route.transitions[0].kind, 'continuation');
  const separate = combineBuilding(model.zones, emptyZoneConnections());
  assert.equal(separate.seams.length, 0, 'zones that are not joined never get seams');
});

test('seams between joined zones never cross a scanned wall', () => {
  const scan: ScanFeatures = { floors: [wallFeature('floor', [20, 20, 0], [0, 0, 0], false)], walls: [wallFeature('wall', [10, 2, 0], [-.8, 1, 7], true)], doors: [], openings: [], windows: [], objects: [] };
  const model = overlappingHall(scan);
  assert.ok(model.seams.length > 0);
  assert.ok(model.seams.every(seam => model.byKey.get(seam.from)!.world[2] < 2 && model.byKey.get(seam.to)!.world[2] < 2));
  const route = findBuildingRoute(model, nodeKey('a', 'a8'), nodeKey('b', 'room'));
  assert.equal(route.ok, true);
  if (route.ok) assert.ok(route.walkingMeters > 15, 'the route walks back around the wall');
});

test('moving a floor keeps its zones joined, and elevators line floors up', () => {
  const west = zone('west', [node('end', 'continuation', 5, 0), node('lift', 'elevator', 0, 0), node('lift-b', 'elevator', 0, 6)], []);
  const east = zone('east', [node('start', 'continuation', 0, 0)], []);
  const up = zone('up', [node('lift', 'elevator', 0, 0), node('lift-b', 'elevator', 0, 6)], [], 1);
  const links: ZoneConnections = { schemaVersion: 1, connections: [
    { from: { zoneId: 'west', nodeId: 'end' }, to: { zoneId: 'east', nodeId: 'start' }, kind: 'continuation' },
    { from: { zoneId: 'west', nodeId: 'lift' }, to: { zoneId: 'up', nodeId: 'lift' }, kind: 'elevator' },
  ] };
  const authored = { schemaVersion: 1 as const, zones: [
    { zoneId: 'west', floor: 0, x: 0, z: 0, rotationDegrees: 0 }, { zoneId: 'east', floor: 0, x: 5, z: 0, rotationDegrees: 0 },
    { zoneId: 'up', floor: 1, x: 10, z: -3, rotationDegrees: 30 },
  ] };
  const turned = moveFloor(authored.zones, 0, { x: 2, z: 1, rotationDegrees: 90 }, [5, 0]);
  const moved = combineBuilding([west, east, up], links, { ...authored, zones: turned });
  assert.ok(near(moved.byKey.get('west/end')!.world, moved.byKey.get('east/start')!.world), 'joined points stay together');
  assert.deepEqual(turned.find(item => item.zoneId === 'up'), authored.zones[2], 'other floors do not move');

  const model = combineBuilding([west, east, up], links, authored);
  const one = elevatorFloorFit(model, 1)!;
  assert.equal(one.reference, 0);
  assert.equal(one.pairs, 1);
  const shifted = combineBuilding([west, east, up], links, { ...authored, zones: moveFloor(model.layout, 1, one.move) });
  const [a, b] = [shifted.byKey.get('west/lift')!.world, shifted.byKey.get('up/lift')!.world];
  assert.ok(Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6, 'one elevator snaps the floor position');
  assert.equal(shifted.layout.find(item => item.zoneId === 'up')!.rotationDegrees, 30, 'one pair keeps rotation');

  const both: ZoneConnections = { ...links, connections: [...links.connections, { from: { zoneId: 'west', nodeId: 'lift-b' }, to: { zoneId: 'up', nodeId: 'lift-b' }, kind: 'elevator' }] };
  const two = combineBuilding([west, east, up], both, authored);
  const fit = elevatorFloorFit(two, 1)!;
  const aligned = combineBuilding([west, east, up], both, { ...authored, zones: moveFloor(two.layout, 1, fit.move) });
  for (const id of ['lift', 'lift-b']) {
    const [p, q] = [aligned.byKey.get('west/' + id)!.world, aligned.byKey.get('up/' + id)!.world];
    assert.ok(Math.abs(p[0] - q[0]) < 1e-3 && Math.abs(p[2] - q[2]) < 1e-3, 'two elevators also fix rotation');
  }
});

test('a walker at an elevator can ride to the next floor up or down', () => {
  const ground = zone('ground', [node('lift', 'elevator', 0, 0)], []);
  const middle = zone('middle', [node('lift', 'elevator', 0, 0)], [], 1);
  const top = zone('top', [node('lift', 'elevator', 0, 0)], [], 2);
  const links: ZoneConnections = { schemaVersion: 1, connections: [
    { from: { zoneId: 'ground', nodeId: 'lift' }, to: { zoneId: 'middle', nodeId: 'lift' }, kind: 'elevator' },
    { from: { zoneId: 'middle', nodeId: 'lift' }, to: { zoneId: 'top', nodeId: 'lift' }, kind: 'elevator' },
  ] };
  const model = combineBuilding([ground, middle, top], links);
  const at = (key: string) => model.byKey.get(key)!.world;
  const fromGround = elevatorStopNear(model, at('ground/lift'), 0)!;
  assert.equal(fromGround.up?.key, 'middle/lift', 'rides one floor at a time');
  assert.equal(fromGround.down, undefined);
  const fromMiddle = elevatorStopNear(model, at('middle/lift'), 1)!;
  assert.deepEqual([fromMiddle.up?.key, fromMiddle.down?.key], ['top/lift', 'ground/lift']);
  const away = at('ground/lift');
  assert.equal(elevatorStopNear(model, [away[0] + 3, away[1], away[2]], 0), null, 'too far from the elevator');
});

test('elevator links must change floors', () => {
  const a = zone('a', [node('lift', 'elevator', 0, 0)], []), b = zone('b', [node('lift', 'elevator', 0, 0)], []);
  const link = { from: { zoneId: 'a', nodeId: 'lift' }, to: { zoneId: 'b', nodeId: 'lift' }, kind: 'elevator' as const };
  const sameFloor = combineBuilding([a, b], emptyZoneConnections(), { schemaVersion: 1, zones: [{ zoneId: 'a', floor: 0, x: 0, z: 0, rotationDegrees: 0 }, { zoneId: 'b', floor: 0, x: 0, z: 0, rotationDegrees: 0 }] });
  assert.throws(() => addZoneConnection(emptyZoneConnections(), link, [a, b], { levelOf: sameFloor.levelOf }), /different floors/);
  const linked = combineBuilding([a, b], { schemaVersion: 1, connections: [link] }, { schemaVersion: 1, zones: [{ zoneId: 'a', floor: 0, x: 0, z: 0, rotationDegrees: 0 }, { zoneId: 'b', floor: 0, x: 0, z: 0, rotationDegrees: 0 }] });
  assert.equal(linked.issues.length, 1);
  assert.ok(!linked.edges.some(edge => edge.kind === 'elevator'));
});

test('the demo routes from floor 1 east, across the joined zone, and up the elevator', () => {
  const model = combineBuilding(demoBuilding.zones!, demoBuilding.zoneConnections, demoBuilding.layout);
  assert.equal(model.floors.length, 2);
  assert.deepEqual(model.floors[0].zoneIds.sort(), ['floor-1', 'floor-1-east']);
  const east = model.layout.find(item => item.zoneId === 'floor-1-east')!;
  assert.ok(Math.abs(east.rotationDegrees - 90) < 1e-6);
  const route = findBuildingRoute(model, nodeKey('floor-1-east', 'cafe'), nodeKey('floor-2', 'room-204'));
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.deepEqual(route.transitions.map(item => item.kind), ['continuation', 'elevator']);
});
