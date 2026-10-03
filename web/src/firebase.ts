import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { collection, deleteField, doc, GeoPoint, getDoc, getDocs, getFirestore, onSnapshot, runTransaction, Timestamp, type DocumentData } from 'firebase/firestore';
import { getDownloadURL, getMetadata, getStorage, ref, uploadBytes } from 'firebase/storage';
import type { Building, Graph, Node, ScanFeatures, ZoneView } from './data';
import { graphDigest } from './graphStore.ts';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
export const configured = Boolean(config.apiKey && config.projectId && config.appId);
const app = configured ? initializeApp(config) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
const storage = app ? getStorage(app) : null;

export async function fetchStorageJSON(path: string): Promise<unknown> {
  if (!storage) throw Error('Firebase Storage is not configured');
  const downloadURL = await getDownloadURL(ref(storage, path));
  const url = new URL(downloadURL);
  const bucketPrefix = '/v0/b/' + encodeURIComponent(config.storageBucket) + '/o/';
  if (url.hostname !== 'firebasestorage.googleapis.com' || !url.pathname.startsWith(bucketPrefix)) {
    throw Error('Unexpected Storage download URL');
  }
  const response = await fetch('/__firebase_storage' + url.pathname + url.search);
  if (!response.ok) throw Error('Storage download returned HTTP ' + response.status);
  return response.json();
}

export function normalizeGraph(raw: unknown): Graph {
  if (!raw || typeof raw !== 'object') throw Error('Invalid navigation graph');
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.floors) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw Error('Building package has no usable navigation graph');
  }
  return {
    ...value,
    floors: value.floors as Graph['floors'],
    nodes: value.nodes.map((node: { id: string; floor?: string; floorId?: string; type: string; label?: string; position: Node['position'] | { x: number; y: number; z: number } }) => ({
      ...node,
      floor: node.floor || node.floorId || 'ground',
      position: Array.isArray(node.position)
        ? node.position
        : [node.position.x, node.position.y, node.position.z],
    })) as Node[],
    edges: value.edges as Graph['edges'],
  };
}

async function loadScan(path: string | undefined): Promise<{ scan?: ScanFeatures; error?: string }> {
  if (!path) return { error: 'No scan path' };
  try {
    const scan = await fetchStorageJSON(path) as ScanFeatures;
    if (Array.isArray(scan.walls) && Array.isArray(scan.floors)) return { scan };
    return { error: 'Invalid scan geometry JSON' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function watchUser(callback: (user: User | null) => void) {
  return auth ? onAuthStateChanged(auth, callback) : () => {};
}
export async function login(email: string, password: string) {
  if (!auth) throw Error('Firebase is not configured');
  await signInWithEmailAndPassword(auth, email, password);
}
export async function logout() {
  if (auth) await signOut(auth);
}
export async function listBuildings(): Promise<Building[]> {
  if (!db) return [];
  const snapshot = await getDocs(collection(db, 'buildings'));
  return snapshot.docs.map(item => {
    const value = item.data();
    return {
      id: item.id,
      name: value.name || item.id,
      status: value.status || 'draft',
      activeVersion: value.activeVersion || null,
      lat: Number(value.latitude ?? value.location?.latitude ?? value.location?.lat) || undefined,
      lng: Number(value.longitude ?? value.location?.longitude ?? value.location?.lng) || undefined,
    };
  });
}

export async function loadBuilding(input: Building): Promise<Building> {
  if (!db || !storage || !input.activeVersion) {
    return { ...input, notice: 'No active map version is published.' };
  }
  const versionBase = 'buildings/' + input.id + '/versions/' + input.activeVersion;
  const storageBase = 'buildings/' + input.id + '/' + input.activeVersion;
  const version = (await getDoc(doc(db, versionBase))).data();
  if (!version) return { ...input, notice: 'Active version metadata is missing.' };

  const zoneDocs = await getDocs(collection(db, versionBase, 'zones'));
  const zones: ZoneView[] = [];
  const errors: string[] = [];
  for (const item of zoneDocs.docs) {
    const zone = item.data();
    const graphPath = zone.buildingJsonPath || storageBase + '/zones/' + item.id + '/building.json';
    try {
      const graph = normalizeGraph(await fetchStorageJSON(graphPath));
      const scanPath = zone.scanFeaturesPath || storageBase + '/zones/' + item.id + '/scan-features.json';
      const scanResult = await loadScan(scanPath);
      const scan = scanResult.scan;
      let rawScanStatus = '';
      if (!scan && storage) {
        const rawPath = zone.scanJsonPath || storageBase + '/zones/' + item.id + '/scan.json';
        try {
          await getDownloadURL(ref(storage, rawPath));
          rawScanStatus = ' Raw scan.json exists.';
        } catch {
          rawScanStatus = ' Raw scan.json is also missing.';
        }
      }
      zones.push({
        id: item.id,
        name: zone.name || item.id,
        floorId: zone.floorId || graph.floors[0]?.id || 'ground',
        graph,
        graphPath,
        scan,
        notice: scan ? 'RoomPlan scan geometry' : 'Scan unavailable: ' + scanResult.error + rawScanStatus,
      });
    } catch (error) {
      errors.push(item.id + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  if (zones.length) {
    const first = zones.find(zone => zone.scan) || zones[0];
    return {
      ...input,
      zoneId: first.id,
      zones,
      graph: first.graph,
      scan: first.scan,
      notice: first.scan
        ? 'Showing RoomPlan geometry from zone ' + first.name + '. ' + zones.length + ' zone(s) available.'
        : zones.length + ' zone(s) found, but none has readable scan-features.json. ' + zones.map(zone => zone.id + ': ' + zone.notice).join('; '),
    };
  }

  const graphPath = version.buildingJsonPath || storageBase + '/building.json';
  try {
    const graph = normalizeGraph(await fetchStorageJSON(graphPath));
    const scanResult = await loadScan(version.scanFeaturesPath || storageBase + '/scan-features.json');
    const scan = scanResult.scan;
    return {
      ...input,
      graph,
      graphPath,
      scan,
      structurePath: version.structurePath,
      notice: scan ? 'Showing RoomPlan geometry.' : 'No scan geometry uploaded yet; showing graph-based layout.',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const zoneReason = errors.length ? ' Zone errors: ' + errors.join('; ') : '';
    return { ...input, notice: 'Building package unavailable: ' + reason + zoneReason };
  }
}

export async function loadPreviousBuildingVersion(input: Building): Promise<Building> {
  if (!db) return { ...input, notice: 'Firebase is not configured.' };
  const snapshot = await getDocs(collection(db, 'buildings', input.id, 'versions'));
  const candidates = snapshot.docs
    .filter(item => item.id !== input.activeVersion)
    .sort((a, b) => Number(b.data().versionNumber || 0) - Number(a.data().versionNumber || 0));
  for (const candidate of candidates) {
    const result = await loadBuilding({ ...input, activeVersion: candidate.id });
    if (result.graph) {
      return {
        ...result,
        viewingPreviousVersion: true,
        notice: 'Viewing previous version ' + candidate.id + '. Current active version ' +
          input.activeVersion + ' is unavailable. ' + (result.notice || ''),
      };
    }
  }
  return { ...input, notice: 'No earlier version with a usable building package was found.' };
}

export type DataRecord = { path: string; data: DocumentData };
export const canEditFirebase = () => auth?.currentUser?.uid === 'WwvbXcl5hpQgdl8KO79JwcThYJd2';

function displayValue(value: unknown): unknown {
  if (value instanceof Timestamp) return { __type: 'timestamp', value: value.toDate().toISOString() };
  if (value instanceof GeoPoint) return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (Array.isArray(value)) return value.map(displayValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, displayValue(item)]));
  return value;
}

function firestoreValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(firestoreValue);
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (item.__type === 'timestamp' && typeof item.value === 'string') return Timestamp.fromDate(new Date(item.value));
    if (item.__type === 'geopoint' && typeof item.latitude === 'number' && typeof item.longitude === 'number') return new GeoPoint(item.latitude, item.longitude);
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, firestoreValue(nested)]));
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}

export async function listDataRecords(): Promise<DataRecord[]> {
  if (!db) return [];
  const records: DataRecord[] = [];
  async function addCollection(path: string) {
    const snapshot = await getDocs(collection(db!, path));
    for (const item of snapshot.docs) records.push({ path: item.ref.path, data: displayValue(item.data()) as DocumentData });
    return snapshot.docs;
  }
  const buildings = await addCollection('buildings');
  await Promise.all(buildings.map(async building => {
    const versions = await addCollection(building.ref.path + '/versions');
    await Promise.all(versions.map(version => Promise.all(['floors', 'zones', 'destinations', 'nodes', 'edges'].map(name => addCollection(version.ref.path + '/' + name)))));
  }));
  return records.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export async function saveDataRecord(path: string, before: DocumentData, after: DocumentData) {
  if (!db || !canEditFirebase()) throw Error('This Firebase account cannot edit project data.');
  if (!after || typeof after !== 'object' || Array.isArray(after)) throw Error('Document JSON must be an object.');
  const changed = Object.keys(after).filter(key => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  const removed = Object.keys(before).filter(key => !(key in after));
  if (!changed.length && !removed.length) return;
  await runTransaction(db, async transaction => {
    const reference = doc(db!, path);
    const current = await transaction.get(reference);
    if (!current.exists()) throw Error('Document was deleted. Refresh the data view.');
    if (canonical(displayValue(current.data())) !== canonical(before)) throw Error('Document changed since you opened it. Refresh before saving.');
    const patch: DocumentData = Object.fromEntries(changed.map(key => [key, firestoreValue(after[key])]));
    for (const key of removed) patch[key] = deleteField();
    transaction.update(reference, patch);
  });
}

export async function loadStorageData(path: string): Promise<unknown> {
  return fetchStorageJSON(path);
}

export function createFirebaseGraphStore(input: Building): import('./graphStore.ts').GraphStore {
  if (!db || !storage || !input.activeVersion || !input.graph) throw Error('Firebase graph is unavailable.');
  const documentPath = 'buildings/' + input.id + '/versions/' + input.activeVersion +
    (input.zoneId ? '/zones/' + input.zoneId : '');
  const documentRef = doc(db, documentPath);
  const fallbackPath = input.graphPath || 'buildings/' + input.id + '/' + input.activeVersion +
    (input.zoneId ? '/zones/' + input.zoneId : '') + '/building.json';
  const load = async (): Promise<import('./graphStore.ts').GraphSnapshot> => {
    const metadata = await getDoc(documentRef);
    if (!metadata.exists()) throw Error('Graph metadata document is missing.');
    const path = String(metadata.data().buildingJsonPath || fallbackPath);
    const graph = normalizeGraph(await fetchStorageJSON(path));
    return { graph, revision: path + ':' + graphDigest(graph), path, remoteMarker: String(metadata.data().webGraphRevision || ''), source: 'firebase' };
  };
  return {
    load,
    async save(graph, expected) {
      if (!canEditFirebase()) throw Error('The signed-in account lacks Firebase graph write permission.');
      const latest = await load();
      if (latest.revision !== expected.revision) throw Error('Remote graph changed. Review the conflict before saving.');
      const base = 'buildings/' + input.id + '/' + input.activeVersion + (input.zoneId ? '/zones/' + input.zoneId : '');
      const id = crypto.randomUUID();
      const path = base + '/graph-edits/' + id + '.json';
      await uploadBytes(ref(storage, path), new TextEncoder().encode(JSON.stringify(graph)), { contentType: 'application/json', cacheControl: 'no-cache' });
      await runTransaction(db, async transaction => {
        const current = await transaction.get(documentRef);
        if (!current.exists() || String(current.data().buildingJsonPath || fallbackPath) !== expected.path ||
            String(current.data().webGraphRevision || '') !== (expected.remoteMarker || ''))
          throw Error('Remote graph pointer changed during save. Your edits remain local for conflict review.');
        transaction.update(documentRef, { buildingJsonPath: path, webGraphRevision: id });
      });
      return { graph, revision: path + ':' + graphDigest(graph), path, remoteMarker: id, source: 'firebase' };
    },
    subscribe(onChange, onError) {
      let disposed = false;
      let lastRevision = '';
      const check = async () => {
        try {
          const snapshot = await load();
          if (!disposed && snapshot.revision !== lastRevision) { lastRevision = snapshot.revision; onChange(snapshot); }
        } catch (error) { if (!disposed) onError(error instanceof Error ? error : Error(String(error))); }
      };
      const unsubscribe = onSnapshot(documentRef, () => void check(), error => onError(error));
      const interval = window.setInterval(() => void check(), 15000);
      return () => { disposed = true; unsubscribe(); window.clearInterval(interval); };
    },
  };
}
