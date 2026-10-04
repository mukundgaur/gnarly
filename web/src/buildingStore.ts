import type { Building, BuildingLayout, ZoneConnections } from './data.ts';
import { saveBuildingLayout, saveZoneConnections } from './firebase.ts';
import { emptyZoneConnections, normalizeZoneConnections } from './zoneConnections.ts';

export type DataMode = 'local' | 'firebase';
export type BuildingMeta = { connections: ZoneConnections; layout?: BuildingLayout };
const localKey = (kind: 'zone-links' | 'layout', building: Building) => ['gnarly-local-' + kind, building.id, building.activeVersion || 'sample'].join(':');

function readLocal<T>(key: string, parse: (raw: unknown) => T): T | undefined {
  try { const saved = localStorage.getItem(key); return saved ? parse(JSON.parse(saved)) : undefined; } catch { return undefined; }
}
function parseLayout(raw: unknown): BuildingLayout {
  const value = raw as BuildingLayout;
  if (value?.schemaVersion !== 1 || !Array.isArray(value.zones)) throw Error('Invalid building layout.');
  return value;
}

/** Local test mode keeps zone links and layout in this browser, falling back to the loaded package. */
export function loadBuildingMeta(building: Building, mode: DataMode): BuildingMeta {
  const fallback = { connections: building.zoneConnections || emptyZoneConnections(), layout: building.layout };
  if (mode !== 'local') return fallback;
  return {
    connections: readLocal(localKey('zone-links', building), normalizeZoneConnections) || fallback.connections,
    layout: readLocal(localKey('layout', building), parseLayout) || fallback.layout,
  };
}

export async function saveConnections(building: Building, mode: DataMode, document: ZoneConnections): Promise<ZoneConnections> {
  if (mode === 'firebase') return saveZoneConnections(building, document);
  const normalized = normalizeZoneConnections(document);
  localStorage.setItem(localKey('zone-links', building), JSON.stringify(normalized));
  return normalized;
}

export async function saveLayout(building: Building, mode: DataMode, layout: BuildingLayout): Promise<BuildingLayout> {
  if (mode === 'firebase') return saveBuildingLayout(building, layout);
  for (const zone of layout.zones) {
    if (!zone.zoneId || ![zone.floor, zone.x, zone.z, zone.rotationDegrees].every(Number.isFinite)) throw Error('Each zone needs a finite floor, X, Z, and rotation.');
  }
  const normalized = parseLayout(structuredClone(layout));
  localStorage.setItem(localKey('layout', building), JSON.stringify(normalized));
  return normalized;
}
