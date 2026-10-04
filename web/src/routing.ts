import type { Edge, Graph, Node, ScanFeatures } from './data.ts';
import { checkEdge, type EdgeCheck } from './geometry.ts';

export type RouteOptions = { scan?: ScanFeatures };
export type RouteResult =
  | { ok: true; nodes: Node[]; edges: Edge[]; distance: number; floorTransitions: number; unverifiedEdges: number; warningEdges: number }
  | { ok: false; reason: 'invalid-endpoint' | 'no-walkable-route'; message: string };
export type RouteRequest = { graph: Graph; startId: string; destinationId: string; options?: RouteOptions };
export type WeightedEdge<T> = { from: string; to: string; meters: number; bidirectional?: boolean; value: T };

class MinHeap {
  private items: [number, string][] = [];
  get size() { return this.items.length; }
  push(priority: number, id: string) {
    const items = this.items;
    items.push([priority, id]);
    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop(): [number, string] {
    const items = this.items, top = items[0], last = items.pop()!;
    if (items.length) {
      items[0] = last;
      for (let i = 0; ;) {
        const left = i * 2 + 1, right = left + 1;
        let smallest = i;
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Dijkstra over non-negative weights. Returns node ids and traversed edges, or null when unreachable. */
export function shortestPath<T>(edges: WeightedEdge<T>[], startId: string, goalId: string): { ids: string[]; edges: T[]; distance: number } | null {
  if (startId === goalId) return { ids: [startId], edges: [], distance: 0 };
  const adjacency = new Map<string, { to: string; meters: number; value: T }[]>();
  const add = (from: string, to: string, meters: number, value: T) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push({ to, meters, value });
  };
  for (const edge of edges) {
    if (!Number.isFinite(edge.meters) || edge.meters < 0) continue;
    add(edge.from, edge.to, edge.meters, edge.value);
    if (edge.bidirectional !== false) add(edge.to, edge.from, edge.meters, edge.value);
  }
  const distances = new Map<string, number>([[startId, 0]]);
  const previous = new Map<string, { id: string; value: T }>();
  const heap = new MinHeap();
  heap.push(0, startId);
  while (heap.size) {
    const [distance, current] = heap.pop();
    if (distance > (distances.get(current) ?? Infinity)) continue;
    if (current === goalId) break;
    for (const next of adjacency.get(current) || []) {
      const candidate = distance + next.meters;
      if (candidate >= (distances.get(next.to) ?? Infinity)) continue;
      distances.set(next.to, candidate);
      previous.set(next.to, { id: current, value: next.value });
      heap.push(candidate, next.to);
    }
  }
  if (!distances.has(goalId)) return null;
  const ids = [goalId], path: T[] = [];
  for (let id = goalId; id !== startId;) {
    const step = previous.get(id)!;
    path.unshift(step.value);
    id = step.id;
    ids.unshift(id);
  }
  return { ids, edges: path, distance: distances.get(goalId)! };
}

/** Routes inside one zone graph. Only edges accepted by checkEdge may be traversed. */
export function findRoute({ graph, startId, destinationId, options }: RouteRequest): RouteResult {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (!nodes.has(startId) || !nodes.has(destinationId)) return { ok: false, reason: 'invalid-endpoint', message: 'Choose valid start and destination waypoints.' };
  const allowed = graph.edges
    .map(edge => ({ edge, check: checkEdge(edge, graph, options?.scan) }))
    .filter(item => item.check.status !== 'blocked')
    .map(item => ({ from: item.edge.from, to: item.edge.to, meters: item.edge.meters, bidirectional: item.edge.bidirectional, value: item as { edge: Edge; check: EdgeCheck } }));
  const result = shortestPath(allowed, startId, destinationId);
  if (!result) return { ok: false, reason: 'no-walkable-route', message: 'No walkable route found.' };
  const path = result.ids.map(id => nodes.get(id)!);
  return {
    ok: true, nodes: path, edges: result.edges.map(item => item.edge), distance: result.distance,
    floorTransitions: path.slice(1).filter((node, index) => node.floor !== path[index].floor).length,
    unverifiedEdges: result.edges.filter(item => item.check.status === 'unverified').length,
    warningEdges: result.edges.filter(item => item.check.status === 'warning').length,
  };
}
