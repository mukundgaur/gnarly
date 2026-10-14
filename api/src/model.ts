export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Role = 'owner' | 'editor' | 'viewer';
export type Visibility = 'authenticated' | 'members';
export type Action = 'publish' | 'list' | 'download';

export type BuildingRecord = {
  id: string;
  name: string;
  status: string;
  activeVersion: string | null;
  ownerUid: string | null;
  acl: Record<string, Role>;
  visibility: Visibility;
  latitude?: number;
  longitude?: number;
  mapHeadingDegrees?: number;
};

export type ZoneRecord = {
  id: string;
  name: string;
  floorId: string;
  worldMapPath?: string;
  buildingJsonPath?: string;
  scanJsonPath?: string;
  scanFeaturesPath?: string;
  structurePath?: string;
  surfaceColorsPath?: string;
  surfaceColorAtlasPath?: string;
  relocalizationHint?: string;
  startNodeId?: string;
};

export type FloorRecord = {
  id: string;
  name: string;
  story: number;
  elevation: number;
};

export type VersionRecord = {
  id: string;
  versionNumber: number;
  status: string;
  buildingLayoutPath?: string | null;
  zoneConnectionsPath?: string | null;
  publishId?: string;
};

export type ExpectedFile = {
  name: string;
  zoneId: string;
  path: string;
  size: number;
  contentType: string;
};

export type PublishZone = {
  zoneId: string;
  floorId: string;
  name: string;
  story: number;
  elevation: number;
  relocalizationHint: string;
  startNodeId: string;
};

export type CarryForward = {
  zones: ZoneRecord[];
  floors: FloorRecord[];
  layoutPath: string | null;
  connectionsPath: string | null;
};

export type PublishRecord = {
  id: string;
  buildingId: string;
  versionId: string;
  uid: string;
  status: 'open' | 'committed';
  expiresAt: string;
  carriedFromVersion: string | null;
  files: ExpectedFile[];
  zones: PublishZone[];
  carry: CarryForward;
};

export type CommitWrite = {
  buildingId: string;
  publishId: string;
  versionId: string;
  carriedFromVersion: string | null;
  version: VersionRecord;
  zones: ZoneRecord[];
  floors: FloorRecord[];
};

export type Caller = { uid: string; ip: string };

export type Quota = { windowMs: number; user: number; building: number; ip: number };
export type Quotas = Record<Action, Quota>;

export const defaultQuotas: Quotas = {
  publish: { windowMs: 60 * 60 * 1000, user: 10, building: 20, ip: 30 },
  list: { windowMs: 60 * 1000, user: 60, building: 120, ip: 120 },
  download: { windowMs: 60 * 1000, user: 120, building: 240, ip: 240 },
};

export const FILE_LIMITS: Record<string, number> = {
  'building.json': 2 * 1024 * 1024,
  'scan.json': 48 * 1024 * 1024,
  'scan-features.json': 8 * 1024 * 1024,
  'structure.usdz': 100 * 1024 * 1024,
  'worldmap.bin': 80 * 1024 * 1024,
  'zone-connections.json': 1024 * 1024,
  'building-layout.json': 1024 * 1024,
  'surface-colors.json': 8 * 1024 * 1024,
  'surface-colors.jpg': 25 * 1024 * 1024,
};

export const TOTAL_LIMIT = 250 * 1024 * 1024;
export const ZONE_REQUIRED = ['building.json', 'scan.json', 'scan-features.json', 'structure.usdz', 'worldmap.bin'];
export const ZONE_OPTIONAL = ['surface-colors.json', 'surface-colors.jpg'];
export const BUILDING_FILES = ['zone-connections.json', 'building-layout.json'];
export const UPLOAD_TTL_MS = 15 * 60 * 1000;
export const DOWNLOAD_TTL_MS = 5 * 60 * 1000;
export const PUBLISH_TTL_MS = 30 * 60 * 1000;
export const MAX_ZONES = 24;

const CONTENT_TYPES: Record<string, readonly string[]> = {
  'building.json': ['application/json'],
  'scan.json': ['application/json'],
  'scan-features.json': ['application/json'],
  'structure.usdz': ['model/vnd.usdz+zip', 'application/octet-stream'],
  'worldmap.bin': ['application/octet-stream'],
  'zone-connections.json': ['application/json'],
  'building-layout.json': ['application/json'],
  'surface-colors.json': ['application/json'],
  'surface-colors.jpg': ['image/jpeg'],
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function assertId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!ID.test(trimmed)) {
    throw new ApiError(400, 'invalid_id', `${field} must be 1–81 letters, numbers, dots, underscores, or hyphens.`);
  }
  return trimmed;
}

export function contentTypeFor(name: string, contentType: unknown): string {
  const allowed = CONTENT_TYPES[name];
  if (!allowed) throw new ApiError(400, 'invalid_file', `Unexpected package file ${name}.`);
  if (typeof contentType !== 'string' || !allowed.includes(contentType)) {
    throw new ApiError(400, 'invalid_file', `${name} must use content type ${allowed.join(' or ')}.`);
  }
  return contentType;
}

export function assertSize(name: string, size: unknown): number {
  const max = FILE_LIMITS[name];
  if (!max) throw new ApiError(400, 'invalid_file', `Unexpected package file ${name}.`);
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    throw new ApiError(400, 'invalid_file', `${name} needs a file size in bytes.`);
  }
  if (size > max) throw new ApiError(413, 'too_large', `${name} is ${size} bytes; the maximum is ${max}.`);
  return size;
}

export function objectPath(buildingId: string, versionId: string, name: string, zoneId = ''): string {
  if (name === 'worldmap.bin') return `buildings/${buildingId}/${versionId}/worldmaps/${zoneId}.bin`;
  if (zoneId) return `buildings/${buildingId}/${versionId}/zones/${zoneId}/${name}`;
  return `buildings/${buildingId}/${versionId}/${name}`;
}

const PATH_RULES = [
  /^buildings\/([^/]+)\/([^/]+)\/zones\/([^/]+)\/(building\.json|scan\.json|scan-features\.json|structure\.usdz|surface-colors\.json|surface-colors\.jpg)$/,
  /^buildings\/([^/]+)\/([^/]+)\/zones\/([^/]+)\/graph-edits\/([^/]+\.json)$/,
  /^buildings\/([^/]+)\/([^/]+)\/graph-edits\/([^/]+\.json)$/,
  /^buildings\/([^/]+)\/([^/]+)\/worldmaps\/([^/]+)\.bin$/,
  /^buildings\/([^/]+)\/([^/]+)\/(building\.json|scan\.json|scan-features\.json|structure\.usdz|zone-connections\.json|building-layout\.json)$/,
];

/** Accept only package object paths. Returns the building and version those bytes belong to. */
export function parseObjectPath(path: string): { buildingId: string; versionId: string } | null {
  if (path.includes('\\') || path.includes('//') || path.startsWith('/')) return null;
  for (const rule of PATH_RULES) {
    const match = rule.exec(path);
    if (!match) continue;
    try {
      return { buildingId: assertId(match[1], 'buildingId'), versionId: assertId(match[2], 'versionId') };
    } catch {
      return null;
    }
  }
  return null;
}

export function roleFor(uid: string, building: BuildingRecord, adminUid: string): Role | null {
  if (uid === adminUid) return 'owner';
  if (building.ownerUid && building.ownerUid === uid) return 'owner';
  return building.acl[uid] ?? null;
}

export function canPublish(role: Role | null): boolean {
  return role === 'owner' || role === 'editor';
}

/** Authenticated visibility still checks the building ACL: members-only maps are closed. */
export function canDownload(role: Role | null, building: BuildingRecord): boolean {
  if (role) return true;
  return building.visibility !== 'members';
}

export function assertPublish(uid: string, building: BuildingRecord, adminUid: string) {
  if (!canPublish(roleFor(uid, building, adminUid))) {
    throw new ApiError(403, 'forbidden', 'This account cannot publish that building.');
  }
}

export function assertDownload(uid: string, building: BuildingRecord, adminUid: string) {
  if (!canDownload(roleFor(uid, building, adminUid), building)) {
    throw new ApiError(403, 'forbidden', 'This account cannot download that building.');
  }
}
