import type { ZoneConnection, ZoneConnections, ZoneNodeRef, ZoneView } from './data.ts';

export const emptyZoneConnections = (): ZoneConnections => ({ schemaVersion: 1, connections: [] });

function nodeRef(raw: unknown): ZoneNodeRef {
  if (!raw || typeof raw !== 'object') throw Error('Zone connection endpoint is invalid.');
  const value = raw as Record<string, unknown>;
  if (typeof value.zoneId !== 'string' || !value.zoneId || typeof value.nodeId !== 'string' || !value.nodeId) {
    throw Error('Zone connection endpoint must include zoneId and nodeId.');
  }
  return { zoneId: value.zoneId, nodeId: value.nodeId };
}

export function normalizeZoneConnections(raw: unknown): ZoneConnections {
  if (!raw || typeof raw !== 'object') throw Error('Invalid zone-connections.json.');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.connections)) throw Error('Unsupported zone-connections.json.');
  return {
    schemaVersion: 1,
    connections: value.connections.map(item => {
      if (!item || typeof item !== 'object') throw Error('Invalid zone connection.');
      const connection = item as Record<string, unknown>;
      return { from: nodeRef(connection.from), to: nodeRef(connection.to) };
    }),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
  };
}

const refKey = (value: ZoneNodeRef) => value.zoneId + '\u0000' + value.nodeId;
export const zoneConnectionKey = (connection: ZoneConnection) => [refKey(connection.from), refKey(connection.to)].sort().join('\u0001');

export function addZoneConnection(document: ZoneConnections, connection: ZoneConnection, zones: ZoneView[]): ZoneConnections {
  if (connection.from.zoneId === connection.to.zoneId) throw Error('Choose a waypoint in a different zone.');
  for (const endpoint of [connection.from, connection.to]) {
    const zone = zones.find(item => item.id === endpoint.zoneId);
    if (!zone) throw Error('Zone ' + endpoint.zoneId + ' is unavailable.');
    if (!zone.graph.nodes.some(node => node.id === endpoint.nodeId)) throw Error('Waypoint ' + endpoint.nodeId + ' is not saved in zone ' + zone.name + '.');
  }
  const key = zoneConnectionKey(connection);
  if (document.connections.some(item => zoneConnectionKey(item) === key)) throw Error('These waypoints are already connected.');
  return { ...document, connections: [...document.connections, connection] };
}

export function removeZoneConnection(document: ZoneConnections, connection: ZoneConnection): ZoneConnections {
  const key = zoneConnectionKey(connection);
  return { ...document, connections: document.connections.filter(item => zoneConnectionKey(item) !== key) };
}
