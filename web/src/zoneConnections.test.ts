import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZoneView } from './data.ts';
import { addZoneConnection, emptyZoneConnections, normalizeZoneConnections, removeZoneConnection } from './zoneConnections.ts';

const zones: ZoneView[] = [
  { id: 'hall', name: 'Hall', floorId: 'ground', notice: '', graph: { floors: [], edges: [], nodes: [{ id: 'door-a', floor: 'ground', type: 'door', position: [0, 0, 0] }] } },
  { id: 'stairs', name: 'Stairs', floorId: 'ground', notice: '', graph: { floors: [], edges: [], nodes: [{ id: 'landing', floor: 'ground', type: 'stairs', position: [0, 0, 0] }] } },
];
const connection = { from: { zoneId: 'hall', nodeId: 'door-a' }, to: { zoneId: 'stairs', nodeId: 'landing' } };

test('normalizes, adds, deduplicates, and removes bidirectional zone connections', () => {
  assert.deepEqual(normalizeZoneConnections({ schemaVersion: 1, connections: [] }), emptyZoneConnections());
  const added = addZoneConnection(emptyZoneConnections(), connection, zones);
  assert.equal(added.connections.length, 1);
  assert.throws(() => addZoneConnection(added, { from: connection.to, to: connection.from }, zones), /already connected/);
  assert.equal(removeZoneConnection(added, { from: connection.to, to: connection.from }).connections.length, 0);
});

test('rejects missing endpoints and links inside one zone', () => {
  assert.throws(() => addZoneConnection(emptyZoneConnections(), { from: connection.from, to: { zoneId: 'hall', nodeId: 'door-a' } }, zones), /different zone/);
  assert.throws(() => addZoneConnection(emptyZoneConnections(), { from: connection.from, to: { zoneId: 'stairs', nodeId: 'missing' } }, zones), /not saved/);
});
