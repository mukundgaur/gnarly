import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZoneView } from './data.ts';
import { addZoneConnection, emptyZoneConnections, normalizeZoneConnections, removeZoneConnection } from './zoneConnections.ts';

const zones: ZoneView[] = [
  { id: 'floor-1', name: 'Floor 1', floorId: 'floor-1', notice: '', graph: { floors: [], edges: [], nodes: [{ id: 'elevator-east', floor: 'floor-1', type: 'elevator', position: [0, 0, 0] }] } },
  { id: 'floor-2', name: 'Floor 2', floorId: 'floor-2', notice: '', graph: { floors: [], edges: [], nodes: [{ id: 'elevator-east', floor: 'floor-2', type: 'elevator', position: [0, 0, 0] }] } },
];
const connection = { from: { zoneId: 'floor-1', nodeId: 'elevator-east' }, to: { zoneId: 'floor-2', nodeId: 'elevator-east' } };

test('normalizes, adds, deduplicates, and removes bidirectional zone connections', () => {
  assert.deepEqual(normalizeZoneConnections({ schemaVersion: 1, connections: [] }), emptyZoneConnections());
  const added = addZoneConnection(emptyZoneConnections(), connection, zones);
  assert.equal(added.connections.length, 1);
  assert.throws(() => addZoneConnection(added, { from: connection.to, to: connection.from }, zones), /already connected/);
  assert.equal(removeZoneConnection(added, { from: connection.to, to: connection.from }).connections.length, 0);
});

test('rejects missing endpoints and links inside one zone', () => {
  assert.throws(() => addZoneConnection(emptyZoneConnections(), { from: connection.from, to: { zoneId: 'floor-1', nodeId: 'elevator-east' } }, zones), /different zone/);
  assert.throws(() => addZoneConnection(emptyZoneConnections(), { from: connection.from, to: { zoneId: 'floor-2', nodeId: 'missing' } }, zones), /not saved/);
});
