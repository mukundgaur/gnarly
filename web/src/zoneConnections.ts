import type { ZoneConnection, ZoneConnectionKind, ZoneConnections, ZoneNodeRef, ZoneView } from './data.ts';

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
      const kind=connection.kind;
      if(kind!==undefined&&!['elevator','continuation','stairs'].includes(String(kind)))throw Error('Invalid zone connection kind.');
      return { from: nodeRef(connection.from), to: nodeRef(connection.to), ...(kind?{kind:kind as ZoneConnectionKind}:{}) };
    }),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
  };
}

const refKey = (value: ZoneNodeRef) => value.zoneId + '\u0000' + value.nodeId;
export const zoneConnectionKey = (connection: ZoneConnection) => [refKey(connection.from), refKey(connection.to)].sort().join('\u0001');

/** levelOf returns an endpoint's building floor, so elevators can be required to change floors. */
export type ConnectionOptions = { levelOf?: (zoneId: string, floorId: string) => number };

export function addZoneConnection(document: ZoneConnections, connection: ZoneConnection, zones: ZoneView[], options: ConnectionOptions = {}): ZoneConnections {
  if (connection.from.zoneId === connection.to.zoneId) throw Error('Choose a waypoint in a different zone.');
  const endpoints = [connection.from, connection.to].map(endpoint => {
    const zone = zones.find(item => item.id === endpoint.zoneId);
    if (!zone) throw Error('Zone ' + endpoint.zoneId + ' is unavailable.');
    const node = zone.graph.nodes.find(item => item.id === endpoint.nodeId);
    if (!node) throw Error('Waypoint ' + endpoint.nodeId + ' is not saved in zone ' + zone.name + '.');
    return { endpoint, node };
  });
  if(connection.kind==='elevator'||connection.kind==='continuation'){
    if(endpoints.some(item=>item.node.type!==connection.kind))throw Error('Both endpoints must be '+connection.kind+' waypoints.');
  }
  if (connection.kind === 'elevator' && options.levelOf) {
    const [a, b] = endpoints.map(item => options.levelOf!(item.endpoint.zoneId, item.node.floor));
    if (a === b) throw Error('An elevator link must connect two different floors. Assign the zones to their floors first.');
  }
  const key = zoneConnectionKey(connection);
  if (document.connections.some(item => zoneConnectionKey(item) === key)) throw Error('These waypoints are already connected.');
  return { ...document, connections: [...document.connections, connection] };
}

export function removeZoneConnection(document: ZoneConnections, connection: ZoneConnection): ZoneConnections {
  const key = zoneConnectionKey(connection);
  return { ...document, connections: document.connections.filter(item => zoneConnectionKey(item) !== key) };
}
