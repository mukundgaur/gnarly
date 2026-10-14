import { createHash } from 'node:crypto';
import {
  ApiError,
  type Action,
  type BuildingRecord,
  type CommitWrite,
  type FloorRecord,
  type PublishRecord,
  type Quota,
  type VersionRecord,
  type ZoneRecord,
} from './model.ts';

export type SignedUrl = { url: string; expiresAt: string };

export interface ObjectStore {
  stat(path: string): Promise<{ size: number; contentType?: string } | null>;
  read(path: string, maxBytes: number): Promise<Buffer>;
  signUpload(path: string, contentType: string, expiresAt: Date): Promise<string>;
  signDownload(path: string, expiresAt: Date): Promise<string>;
}

export interface MetadataStore {
  getBuilding(id: string): Promise<BuildingRecord | null>;
  createBuilding(record: BuildingRecord): Promise<'created' | 'exists'>;
  listBuildings(): Promise<BuildingRecord[]>;
  getVersion(buildingId: string, versionId: string): Promise<VersionRecord | null>;
  listVersionIds(buildingId: string): Promise<string[]>;
  listZones(buildingId: string, versionId: string): Promise<ZoneRecord[]>;
  listFloors(buildingId: string, versionId: string): Promise<FloorRecord[]>;
  listPublishes(buildingId: string): Promise<PublishRecord[]>;
  savePublish(record: PublishRecord): Promise<void>;
  getPublish(buildingId: string, publishId: string): Promise<PublishRecord | null>;
  commit(write: CommitWrite): Promise<'committed' | 'already'>;
}

export type RateKey = { id: string; limit: number };

export interface CounterStore {
  consume(keys: RateKey[]): Promise<{ ok: true } | { ok: false }>;
}

export function rateWindow(quota: Quota, now: Date) {
  const windowStart = Math.floor(now.getTime() / quota.windowMs) * quota.windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + quota.windowMs - now.getTime()) / 1000));
  return { windowStart, retryAfterSeconds };
}

export function rateKey(action: Action, kind: 'user' | 'building' | 'ip', id: string, windowStart: number): string {
  const hash = createHash('sha256').update(`${id}:${windowStart}`).digest('hex').slice(0, 32);
  return `${action}_${kind}_${hash}`;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async stat(path: string) {
    const item = this.objects.get(path);
    return item ? { size: item.bytes.length, contentType: item.contentType } : null;
  }

  async read(path: string, maxBytes: number) {
    const item = this.objects.get(path);
    if (!item) throw new ApiError(404, 'missing_object', `${path} has not been uploaded.`);
    if (item.bytes.length > maxBytes) throw new ApiError(413, 'too_large', `${path} exceeds its size limit.`);
    return item.bytes;
  }

  async signUpload(path: string, contentType: string, expiresAt: Date) {
    return `https://signed.example/upload?path=${encodeURIComponent(path)}&exp=${expiresAt.getTime()}&type=${encodeURIComponent(contentType)}`;
  }

  async signDownload(path: string, expiresAt: Date) {
    return `https://signed.example/download?path=${encodeURIComponent(path)}&exp=${expiresAt.getTime()}`;
  }

  put(path: string, bytes: Buffer, contentType: string) {
    this.objects.set(path, { bytes, contentType });
  }
}

export class MemoryMetadata implements MetadataStore {
  readonly buildings = new Map<string, BuildingRecord>();
  readonly versions = new Map<string, VersionRecord>();
  readonly zones = new Map<string, ZoneRecord[]>();
  readonly floors = new Map<string, FloorRecord[]>();
  readonly publishes = new Map<string, PublishRecord>();

  private versionKey(buildingId: string, versionId: string) {
    return `${buildingId}/${versionId}`;
  }

  async getBuilding(id: string) {
    return this.buildings.get(id) ?? null;
  }

  async createBuilding(record: BuildingRecord) {
    if (this.buildings.has(record.id)) return 'exists';
    this.buildings.set(record.id, record);
    return 'created';
  }

  async listBuildings() {
    return [...this.buildings.values()];
  }

  async getVersion(buildingId: string, versionId: string) {
    return this.versions.get(this.versionKey(buildingId, versionId)) ?? null;
  }

  async listVersionIds(buildingId: string) {
    const prefix = `${buildingId}/`;
    return [...this.versions.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  }

  async listZones(buildingId: string, versionId: string) {
    return this.zones.get(this.versionKey(buildingId, versionId)) ?? [];
  }

  async listFloors(buildingId: string, versionId: string) {
    return this.floors.get(this.versionKey(buildingId, versionId)) ?? [];
  }

  async listPublishes(buildingId: string) {
    return [...this.publishes.values()].filter(item => item.buildingId === buildingId);
  }

  async savePublish(record: PublishRecord) {
    this.publishes.set(`${record.buildingId}/${record.id}`, record);
  }

  async getPublish(buildingId: string, publishId: string) {
    return this.publishes.get(`${buildingId}/${publishId}`) ?? null;
  }

  async commit(write: CommitWrite) {
    const publish = await this.getPublish(write.buildingId, write.publishId);
    if (!publish) throw new ApiError(404, 'not_found', 'That publish session does not exist.');
    if (publish.status === 'committed') return 'already';
    const building = this.buildings.get(write.buildingId);
    if (!building) throw new ApiError(404, 'not_found', 'That building does not exist.');
    if ((building.activeVersion ?? null) !== (write.carriedFromVersion ?? null)) {
      throw new ApiError(409, 'building_changed', 'The building changed while the package uploaded. Publish it again.');
    }
    const key = this.versionKey(write.buildingId, write.versionId);
    this.versions.set(key, write.version);
    this.zones.set(key, write.zones.map(zone => ({ ...zone })));
    this.floors.set(key, write.floors.map(floor => ({ ...floor })));
    building.activeVersion = write.versionId;
    building.status = 'active';
    publish.status = 'committed';
    return 'committed';
  }
}

export class MemoryCounters implements CounterStore {
  readonly counts = new Map<string, number>();

  async consume(keys: RateKey[]) {
    for (const key of keys) {
      if ((this.counts.get(key.id) ?? 0) >= key.limit) return { ok: false as const };
    }
    for (const key of keys) this.counts.set(key.id, (this.counts.get(key.id) ?? 0) + 1);
    return { ok: true as const };
  }
}
