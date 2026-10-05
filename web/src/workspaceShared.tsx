import type { Node } from './data.ts';
import type { BuildingModel, BuildingNode } from './buildingGraph.ts';
import type { SearchOption } from './ui.tsx';
import type { Vec3 } from './zoneAlign.ts';
import { nodeColor } from './Viewer.tsx';

export type Tool = 'select' | 'add' | 'connect' | 'arrange';
export type LinkKind = 'elevator' | 'continuation';
export type PendingLink = { from: { zoneId: string; nodeId: string }; kind: LinkKind; targetZoneId: string; toNodeId?: string };
/**
 * A neighbor on the same floor. `blocked` means an existing join runs through a wall; `walled` explains
 * why touching zones cannot be joined; `seam` is where a join would go, in building coordinates.
 */
export type JoinOption = { zoneId: string; name: string; joined: boolean; touching: boolean; blocked?: string; walled?: string; wallAt?: Vec3; seam?: [Vec3, Vec3] };
/** An unlinked elevator here and the closest unlinked-to-it elevator on another floor. */
export type ElevatorSuggestion = { nodeId: string; otherKey: string; otherName: string; floor: string; meters: number };

export const waypointTypes = ['waypoint', 'hallway', 'entrance', 'destination', 'door', 'opening', 'stairs', 'elevator', 'continuation'];
export const typeLabel = (type: string) => ({ waypoint: 'Waypoint', hallway: 'Hallway', entrance: 'Entrance', destination: 'Place', door: 'Door', opening: 'Opening', stairs: 'Stairs', elevator: 'Elevator', continuation: 'Zone seam' } as Record<string, string>)[type] || type;
export const title = (node: Node) => node.label || node.id;

export function floorName(model: BuildingModel, level: number) {
  return model.floors.find(item => item.level === level)?.name || 'Floor ' + level;
}
export function zoneName(model: BuildingModel, zoneId: string) {
  return model.zones.find(item => item.id === zoneId)?.name || zoneId;
}

/** Search options for building waypoints, labeled the way a visitor reads them. */
export function nodeOptions(model: BuildingModel, nodes: BuildingNode[] = model.nodes): SearchOption[] {
  return nodes.map(node => ({
    value: node.key,
    label: title(node),
    detail: typeLabel(node.type) + (model.zones.length > 1 ? ' · ' + zoneName(model, node.zoneId) : ''),
    group: floorName(model, node.level),
    color: nodeColor(node.type),
  })).sort((a, b) => Number(Boolean(model.byKey.get(b.value)?.label)) - Number(Boolean(model.byKey.get(a.value)?.label)) || a.label.localeCompare(b.label, undefined, { numeric: true }));
}
