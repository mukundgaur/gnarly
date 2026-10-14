import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/http.ts';
import { ApiError, type Quotas } from '../src/model.ts';
import type { Deps } from '../src/service.ts';
import { MemoryCounters, MemoryMetadata, MemoryObjectStore } from '../src/store.ts';

const examples = resolve(import.meta.dirname, '../../shared/examples');
const buildingJson = readFileSync(resolve(examples, 'building.example.json'));
const scanFeatures = readFileSync(resolve(examples, 'scan-features.example.json'));
const connections = readFileSync(resolve(examples, 'zone-connections.example.json'));
const scanJson = Buffer.from('{"capturedRoom":true}');
const structure = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const worldMap = Buffer.from([1, 2, 3, 4, 5]);
const layout = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  zones: [{ zoneId: 'zone-a', floor: 0, x: 1, z: 2, rotationDegrees: 0 }],
}));

const quotas: Quotas = {
  publish: { windowMs: 60_000, user: 20, building: 20, ip: 20 },
  list: { windowMs: 60_000, user: 20, building: 20, ip: 20 },
  download: { windowMs: 60_000, user: 20, building: 20, ip: 20 },
};

function world(options: { quotas?: Quotas; adminUid?: string } = {}) {
  const clock = { time: Date.parse('2026-10-14T04:00:00Z') };
  const metadata = new MemoryMetadata();
  const objects = new MemoryObjectStore();
  const deps: Deps & { trustProxy: boolean; corsOrigins: string[] } = {
    now: () => new Date(clock.time),
    adminUid: options.adminUid ?? 'admin',
    verifyToken: async token => {
      if (!token.startsWith('user:')) throw new ApiError(401, 'unauthenticated', 'Sign in again.');
      return { uid: token.slice('user:'.length) };
    },
    objects,
    metadata,
    counters: new MemoryCounters(),
    quotas: options.quotas ?? quotas,
    trustProxy: true,
    corsOrigins: ['http://localhost:5173'],
  };
  const server = createServer((req, res) => { void createHandler(deps)(req, res); });
  return { server, metadata, objects, clock, deps };
}

test('health and auth', async () => {
  const { server } = world();
  const base = await listen(server);
  try {
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    const denied = await fetch(base + '/v1/buildings');
    assert.equal(denied.status, 401);
    const origin = await fetch(base + '/v1/buildings', { headers: { origin: 'https://evil.example' } });
    assert.equal(origin.status, 403);
  } finally {
    server.close();
  }
});

test('publish validates the package and only then moves activeVersion', async () => {
  const { server, metadata, objects } = world();
  const base = await listen(server);
  try {
    await metadata.createBuilding({
      id: 'hall', name: 'Hall', status: 'active', activeVersion: 'v1', ownerUid: 'owner',
      acl: {}, visibility: 'authenticated',
    });
    metadata.versions.set('hall/v1', { id: 'v1', versionNumber: 1, status: 'published', buildingLayoutPath: null, zoneConnectionsPath: null });
    metadata.zones.set('hall/v1', [{
      id: 'old', name: 'Old', floorId: 'ground',
      buildingJsonPath: 'buildings/hall/v1/zones/old/building.json',
      scanJsonPath: 'buildings/hall/v1/zones/old/scan.json',
      scanFeaturesPath: 'buildings/hall/v1/zones/old/scan-features.json',
      structurePath: 'buildings/hall/v1/zones/old/structure.usdz',
      worldMapPath: 'buildings/hall/v1/worldmaps/old.bin',
    }]);
    for (const path of [
      'buildings/hall/v1/zones/old/building.json',
      'buildings/hall/v1/zones/old/scan.json',
      'buildings/hall/v1/zones/old/scan-features.json',
      'buildings/hall/v1/zones/old/structure.usdz',
      'buildings/hall/v1/worldmaps/old.bin',
    ]) objects.put(path, Buffer.from('{"ok":true}'), 'application/json');

    const tooBig = await call(base, 'POST', '/v1/buildings/hall/publishes', {
      zones: [zoneManifest({ 'building.json': 3 * 1024 * 1024 })],
    }, 'owner');
    assert.equal(tooBig.status, 413);
    assert.equal(metadata.buildings.get('hall')?.activeVersion, 'v1');

    const stranger = await call(base, 'POST', '/v1/buildings/hall/publishes', { zones: [zoneManifest()] }, 'stranger');
    assert.equal(stranger.status, 403);

    const started = await call(base, 'POST', '/v1/buildings/hall/publishes', {
      versionId: 'v1',
      zones: [zoneManifest()],
      files: [
        file('zone-connections.json', connections.length),
        file('building-layout.json', layout.length),
      ],
    }, 'owner');
    assert.equal(started.status, 200);
    const session = await started.json() as Session;
    assert.notEqual(session.versionId, 'v1');
    assert.ok(session.uploads.length >= 5);
    const exp = Number(new URL(session.uploads[0].url).searchParams.get('exp'));
    assert.ok(exp - Date.parse('2026-10-14T04:00:00Z') <= 15 * 60 * 1000);
    assert.ok(exp > Date.parse('2026-10-14T04:00:00Z'));

    const incomplete = await call(base, 'POST', `/v1/buildings/hall/publishes/${session.publishId}/commit`, {}, 'owner');
    assert.equal(incomplete.status, 400);
    assert.equal(metadata.buildings.get('hall')?.activeVersion, 'v1');
    assert.equal(metadata.versions.has(`hall/${session.versionId}`), false);

    putSession(objects, session, { 'building.json': Buffer.from(buildingJson.toString().replace('"zone-a"', '"zone-b"')) });
    const invalid = await call(base, 'POST', `/v1/buildings/hall/publishes/${session.publishId}/commit`, {}, 'owner');
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as { error: { message: string } }).error.message, /zoneId/);
    assert.equal(metadata.buildings.get('hall')?.activeVersion, 'v1');

    putSession(objects, session);
    const committed = await call(base, 'POST', `/v1/buildings/hall/publishes/${session.publishId}/commit`, {}, 'owner');
    assert.equal(committed.status, 200);
    assert.equal(metadata.buildings.get('hall')?.activeVersion, session.versionId);
    const zones = metadata.zones.get(`hall/${session.versionId}`) ?? [];
    assert.deepEqual(zones.map(zone => zone.id).sort(), ['old', 'zone-a']);
    assert.equal(zones.find(zone => zone.id === 'old')?.buildingJsonPath, 'buildings/hall/v1/zones/old/building.json');
    assert.equal(metadata.versions.get(`hall/${session.versionId}`)?.buildingLayoutPath, `buildings/hall/${session.versionId}/building-layout.json`);

    const listed = await call(base, 'GET', '/v1/buildings', undefined, 'visitor');
    assert.equal(listed.status, 200);
    const library = await listed.json() as { buildings: { id: string; zones: { id: string }[] }[] };
    assert.equal(library.buildings.some(item => item.id === 'hall' && item.zones.some(zone => zone.id === 'zone-a')), true);

    const pack = await call(base, 'GET', '/v1/buildings/hall/package?zoneId=zone-a', undefined, 'visitor');
    assert.equal(pack.status, 200);
    const body = await pack.json() as { zones: { files: { url: string; name: string }[] }[] };
    assert.equal(body.zones[0].files.some(file => file.name === 'building.json' && file.url.includes('signed.example')), true);

    const traversal = await call(base, 'POST', '/v1/downloads', { path: 'buildings/../secret' }, 'visitor');
    assert.equal(traversal.status, 400);
  } finally {
    server.close();
  }
});

test('a publish that loses the pointer race does not overwrite the newer map', async () => {
  const { server, metadata, objects } = world();
  const base = await listen(server);
  try {
    await metadata.createBuilding({
      id: 'hall', name: 'Hall', status: 'draft', activeVersion: null, ownerUid: 'owner', acl: {}, visibility: 'authenticated',
    });
    const started = await call(base, 'POST', '/v1/buildings/hall/publishes', { versionId: 'v9', zones: [zoneManifest()] }, 'owner');
    const session = await started.json() as Session;
    putSession(objects, session);
    metadata.buildings.get('hall')!.activeVersion = 'someone-else';
    const committed = await call(base, 'POST', `/v1/buildings/hall/publishes/${session.publishId}/commit`, {}, 'owner');
    assert.equal(committed.status, 409);
    assert.equal(metadata.buildings.get('hall')?.activeVersion, 'someone-else');
  } finally {
    server.close();
  }
});

test('members-only buildings stay closed to other accounts', async () => {
  const { server, metadata, objects } = world();
  const base = await listen(server);
  try {
    await metadata.createBuilding({
      id: 'private', name: 'Private', status: 'active', activeVersion: 'v1', ownerUid: 'owner',
      acl: { editor: 'editor', viewer: 'viewer' }, visibility: 'members',
    });
    metadata.versions.set('private/v1', { id: 'v1', versionNumber: 1, status: 'published' });
    objects.put('buildings/private/v1/zone-connections.json', connections, 'application/json');
    const outsider = await call(base, 'GET', '/v1/buildings/private/package', undefined, 'stranger');
    assert.equal(outsider.status, 403);
    const viewer = await call(base, 'POST', '/v1/downloads', { path: 'buildings/private/v1/zone-connections.json' }, 'viewer');
    assert.equal(viewer.status, 200);
    const editorDenied = await call(base, 'POST', '/v1/buildings/private/publishes', { files: [file('zone-connections.json', connections.length)] }, 'viewer');
    assert.equal(editorDenied.status, 403);
    const editor = await call(base, 'POST', '/v1/buildings/private/publishes', { files: [file('zone-connections.json', connections.length)] }, 'editor');
    assert.equal(editor.status, 200);
    const listed = await call(base, 'GET', '/v1/buildings', undefined, 'stranger');
    const library = await listed.json() as { buildings: { id: string }[] };
    assert.equal(library.buildings.some(item => item.id === 'private'), false);
  } finally {
    server.close();
  }
});

test('rate limits publish, list, and download separately for user, building, and ip', async () => {
  const tight: Quotas = {
    publish: { windowMs: 60_000, user: 5, building: 1, ip: 5 },
    list: { windowMs: 60_000, user: 5, building: 5, ip: 1 },
    download: { windowMs: 60_000, user: 1, building: 5, ip: 5 },
  };
  const { server, metadata, objects } = world({ quotas: tight });
  const base = await listen(server);
  try {
    await metadata.createBuilding({
      id: 'hall', name: 'Hall', status: 'active', activeVersion: 'v1', ownerUid: 'owner', acl: {}, visibility: 'authenticated',
    });
    await metadata.createBuilding({
      id: 'other', name: 'Other', status: 'active', activeVersion: 'v1', ownerUid: 'owner', acl: {}, visibility: 'authenticated',
    });
    metadata.versions.set('hall/v1', { id: 'v1', versionNumber: 1, status: 'published', zoneConnectionsPath: 'buildings/hall/v1/zone-connections.json' });
    objects.put('buildings/hall/v1/zone-connections.json', connections, 'application/json');

    const first = await call(base, 'GET', '/v1/buildings', undefined, 'owner', '1.1.1.1');
    assert.equal(first.status, 200);
    const listedAgain = await call(base, 'GET', '/v1/buildings', undefined, 'owner', '1.1.1.1');
    assert.equal(listedAgain.status, 429);
    const otherIp = await call(base, 'GET', '/v1/buildings', undefined, 'owner', '2.2.2.2');
    assert.equal(otherIp.status, 200);

    const download = await call(base, 'POST', '/v1/downloads', { path: 'buildings/hall/v1/zone-connections.json' }, 'owner', '3.3.3.3');
    assert.equal(download.status, 200);
    const downloadAgain = await call(base, 'POST', '/v1/downloads', { path: 'buildings/hall/v1/zone-connections.json' }, 'owner', '8.8.8.8');
    assert.equal(downloadAgain.status, 429);
    const otherUser = await call(base, 'POST', '/v1/downloads', { path: 'buildings/hall/v1/zone-connections.json' }, 'visitor', '3.3.3.3');
    assert.equal(otherUser.status, 200);

    const publish = await call(base, 'POST', '/v1/buildings/hall/publishes', { files: [file('zone-connections.json', 4)] }, 'owner', '4.4.4.4');
    assert.equal(publish.status, 200);
    const sameBuilding = await call(base, 'POST', '/v1/buildings/hall/publishes', { files: [file('zone-connections.json', 4)] }, 'owner', '5.5.5.5');
    assert.equal(sameBuilding.status, 429);
    const otherBuilding = await call(base, 'POST', '/v1/buildings/other/publishes', { files: [file('zone-connections.json', 4)] }, 'owner', '6.6.6.6');
    assert.equal(otherBuilding.status, 200);
  } finally {
    server.close();
  }
});

type Session = { publishId: string; versionId: string; uploads: { name: string; zoneId: string; path: string; url: string; headers: { 'Content-Type': string } }[] };

function zoneManifest(overrides: Record<string, number> = {}) {
  const files = [
    ['building.json', buildingJson.length, 'application/json'],
    ['scan.json', scanJson.length, 'application/json'],
    ['scan-features.json', scanFeatures.length, 'application/json'],
    ['structure.usdz', structure.length, 'model/vnd.usdz+zip'],
    ['worldmap.bin', worldMap.length, 'application/octet-stream'],
  ] as const;
  return {
    zoneId: 'zone-a',
    floorId: 'ground',
    name: 'Entrance',
    story: 0,
    elevation: 0,
    files: files.map(([name, size, contentType]) => ({ name, size: overrides[name] ?? size, contentType })),
  };
}

function file(name: string, size: number) {
  return { name, size, contentType: 'application/json' };
}

function putSession(objects: MemoryObjectStore, session: Session, overrides: Record<string, Buffer> = {}) {
  const bytes: Record<string, Buffer> = {
    'building.json': buildingJson,
    'scan.json': scanJson,
    'scan-features.json': scanFeatures,
    'structure.usdz': structure,
    'worldmap.bin': worldMap,
    'zone-connections.json': connections,
    'building-layout.json': layout,
    ...overrides,
  };
  for (const upload of session.uploads) {
    objects.put(upload.path, bytes[upload.name], upload.headers['Content-Type']);
  }
}

async function call(base: string, method: string, path: string, body: unknown, uid: string, ip = '127.0.0.1') {
  return fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer user:${uid}`,
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}
