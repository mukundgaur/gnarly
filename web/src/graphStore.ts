import type { Building, Graph } from './data.ts';
import { createFirebaseGraphStore } from './firebase.ts';

export type GraphSnapshot = { graph: Graph; revision: string; source: 'local' | 'firebase'; path?: string; remoteMarker?: string };
export type GraphStore = {
  load(): Promise<GraphSnapshot>;
  save(graph: Graph, expected: GraphSnapshot): Promise<GraphSnapshot>;
  subscribe(onChange: (snapshot: GraphSnapshot) => void, onError: (error: Error) => void): () => void;
};
export function copyGraph(graph: Graph): Graph { return structuredClone(graph); }
export function graphDigest(graph: Graph): string {
  const text = JSON.stringify(graph);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export function createLocalGraphStore(building: Building): GraphStore {
  const key = ['gnarly-local-graph', building.id, building.activeVersion || 'sample', building.zoneId || 'root'].join(':');
  const initial = copyGraph(building.graph!);
  const read = (): GraphSnapshot => {
    const saved = localStorage.getItem(key);
    const graph = saved ? JSON.parse(saved) as Graph : copyGraph(initial);
    return { graph, revision: graphDigest(graph), source: 'local' };
  };
  return {
    async load() { return read(); },
    async save(graph, expected) {
      if (read().revision !== expected.revision) throw Error('Local graph changed in another tab. Review the conflict before saving.');
      localStorage.setItem(key, JSON.stringify(graph));
      return read();
    },
    subscribe(onChange) {
      const listener = (event: StorageEvent) => { if (event.key === key) onChange(read()); };
      window.addEventListener('storage', listener);
      return () => window.removeEventListener('storage', listener);
    },
  };
}
export function createGraphStore(building: Building, mode: 'local' | 'firebase'): GraphStore {
  return mode === 'local' ? createLocalGraphStore(building) : createFirebaseGraphStore(building);
}
