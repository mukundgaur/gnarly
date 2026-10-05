import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScanFeature, ZoneView } from './data.ts';
import { dominantAngle, planJoin, rotateAbout, snapRotation, snapTranslation, withContinuation, zoneCenter, zoneSegments, type Segment } from './zoneArrange.ts';
import { toWorld } from './zoneAlign.ts';

const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, actual + ' ≉ ' + expected);
const square = (x: number, z: number, size: number): Segment[] => [
  [[x, z], [x + size, z]], [[x + size, z], [x + size, z + size]], [[x + size, z + size], [x, z + size]], [[x, z + size], [x, z]],
];
const floorFeature = (cx: number, cz: number, w: number, d: number): ScanFeature => ({ identifier: 'f' + cx, category: 'floor', dimensions: [w, d, 0], position: [cx, 0, cz], transformColumnMajor: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, cx, 0, cz, 1] });
const zone = (id: string, nodes: [string, number, number][], floor?: ScanFeature): ZoneView => ({
  id, name: id, floorId: 'ground', notice: '',
  graph: { floors: [{ id: 'ground', story: 0, elevation: 0 }], edges: [], nodes: nodes.map(([nodeId, x, z]) => ({ id: nodeId, floor: 'ground', type: 'hallway', position: [x, 0, z] as [number, number, number] })) },
  scan: floor ? { walls: [], doors: [], openings: [], windows: [], objects: [], floors: [floor] } : undefined,
});

test('rotating about the zone center keeps that center in place', () => {
  const placement = { x: 3, z: -2, rotationDegrees: 20 };
  const turned = rotateAbout(placement, [4, 1], 90);
  const before = toWorld(placement, [4, 0, 1]), after = toWorld(turned, [4, 0, 1]);
  near(after[0], before[0]); near(after[2], before[2]);
  assert.equal(turned.rotationDegrees, 110);
  assert.equal(rotateAbout(placement, [0, 0], 200).rotationDegrees, -140);
});

test('finds the dominant wall direction modulo 90 degrees', () => {
  near(dominantAngle(square(0, 0, 4))!, 0);
  const tilted = square(0, 0, 4).map(([a, b]) => [toWorld({ x: 0, z: 0, rotationDegrees: 30 }, [a[0], 0, a[1]]), toWorld({ x: 0, z: 0, rotationDegrees: 30 }, [b[0], 0, b[1]])].map(p => [p[0], p[2]]) as Segment);
  near(dominantAngle(tilted)!, 30, 1e-4);
});

test('rotation snaps parallel to neighbor walls, else to 15 degree steps', () => {
  assert.deepEqual(snapRotation(95, 0, [12]), { rotationDegrees: 102, kind: 'walls' });
  assert.deepEqual(snapRotation(44, undefined, []), { rotationDegrees: 45, kind: 'increment' });
  assert.deepEqual(snapRotation(40, undefined, []), { rotationDegrees: 40, kind: null });
});

test('translation snaps corners together and slides walls flush', () => {
  const target = square(0, 0, 4);
  const corner = snapTranslation(square(4.2, 0.1, 3), target, .5)!;
  near(corner.delta[0], -.2); near(corner.delta[1], -.1);
  const flush = snapTranslation(square(4.2, 1.5, 1), target, .3)!;
  assert.equal(flush.kind, 'wall');
  near(flush.delta[0], -.2); near(flush.delta[1], 0);
  assert.equal(snapTranslation(square(6, 6, 1), target, .3), null);
});

test('graph-only zones use the drawn floor rectangle for snapping', () => {
  const segments = zoneSegments(zone('a', [['n', 2, 2]]));
  assert.equal(segments.length, 4);
  assert.deepEqual(zoneCenter(zone('a', [['n', 2, 2]])), [1, 1]);
});

test('plans a join where two scanned floors meet and wires both ends', () => {
  const west = zone('west', [['w', 0, 0]], floorFeature(0, 0, 4, 4));
  const east = zone('east', [['e', 0, 0]], floorFeature(0, 0, 4, 4));
  const plan = planJoin(west, { x: 0, z: 0, rotationDegrees: 0 }, east, { x: 4.3, z: 0, rotationDegrees: 0 });
  assert.ok(!('error' in plan), 'error' in plan ? plan.error : '');
  assert.ok(plan.gap <= 1);
  assert.ok(plan.a.position[0] > 1.5 && plan.b.position[0] < -1.5, 'join sits on the shared edge');
  const graph = withContinuation(west.graph, west.scan, plan.a, 'zone-continuation-test');
  assert.equal(graph.nodes.at(-1)!.type, 'continuation');
  assert.equal(graph.edges.length, 1);
  const apart = planJoin(west, { x: 0, z: 0, rotationDegrees: 0 }, east, { x: 9, z: 0, rotationDegrees: 0 });
  assert.ok('error' in apart);
});

/** A wall (or door in it) running along Z at local x, centered on z. */
const alongZ = (identifier: string, category: string, x: number, z: number, length: number, parentIdentifier?: string): ScanFeature => ({
  identifier, category, parentIdentifier, dimensions: [length, 2.4, .1], position: [x, 1.2, z],
  transformColumnMajor: [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, x, 1.2, z, 1],
});
const walledRoom = (id: string, wallX: number, door: boolean): ZoneView => {
  const room = zone(id, [[id[0], 0, 0]], floorFeature(0, 0, 4, 4));
  room.scan!.walls = [alongZ(id + '-wall', 'wall', wallX, 0, 4)];
  if (door) room.scan!.doors = [alongZ(id + '-door', 'door-open', wallX, 1, .9, id + '-wall')];
  return room;
};

test('a join never passes through a shared wall, only through its doorway', () => {
  const solid = planJoin(walledRoom('west', 2, false), { x: 0, z: 0, rotationDegrees: 0 }, walledRoom('east', -2, false), { x: 4, z: 0, rotationDegrees: 0 });
  assert.ok('error' in solid && solid.walled, 'flush walls without a door stay closed');
  const door = planJoin(walledRoom('west', 2, true), { x: 0, z: 0, rotationDegrees: 0 }, walledRoom('east', -2, true), { x: 4, z: 0, rotationDegrees: 0 });
  assert.ok(!('error' in door), 'error' in door ? door.error : '');
  assert.ok(Math.abs(door.a.position[2] - 1) < .5 && Math.abs(door.b.position[2] - 1) < .5, 'seam goes through the door at z = 1');
});
