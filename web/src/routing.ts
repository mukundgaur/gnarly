import type { Edge, Graph, Node, ScanFeatures } from './data.ts';
import { checkEdge, type EdgeCheck } from './geometry.ts';

export type RouteOptions = { scan?: ScanFeatures };
export type RouteResult =
  | { ok: true; nodes: Node[]; edges: Edge[]; distance: number; floorTransitions: number; unverifiedEdges: number }
  | { ok: false; reason: 'invalid-endpoint' | 'no-walkable-route'; message: string };
export type RouteRequest = { graph: Graph; startId: string; destinationId: string; options?: RouteOptions };

/** Replacement point for the teammate's algorithm. Only edges accepted by checkEdge may be traversed. */
export function findRoute({ graph, startId, destinationId, options }: RouteRequest): RouteResult {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (!nodes.has(startId) || !nodes.has(destinationId)) return { ok: false, reason: 'invalid-endpoint', message: 'Choose valid start and destination waypoints.' };
  if (startId === destinationId) return { ok: true, nodes: [nodes.get(startId)!], edges: [], distance: 0, floorTransitions: 0, unverifiedEdges: 0 };
  const allowed = graph.edges.map(edge => ({ edge, check: checkEdge(edge, graph, options?.scan) })).filter(item => item.check.status !== 'blocked');
  const distances = new Map<string, number>([[startId, 0]]);
  const previous = new Map<string, { id: string; edge: Edge; check: EdgeCheck }>();
  const pending = new Set([startId]);
  while (pending.size) {
    const current = [...pending].sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    pending.delete(current);
    if (current === destinationId) break;
    for (const { edge, check } of allowed) {
      const next = edge.from === current ? edge.to : edge.to === current && edge.bidirectional !== false ? edge.from : null;
      if (!next) continue;
      const candidate = distances.get(current)! + edge.meters;
      if (candidate >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, candidate);
      previous.set(next, { id: current, edge, check });
      pending.add(next);
    }
  }
  if (!distances.has(destinationId)) return { ok: false, reason: 'no-walkable-route', message: 'No walkable route found.' };
  const path: Node[] = [nodes.get(destinationId)!];
  const edges: Edge[] = [];
  let unverifiedEdges = 0;
  let id = destinationId;
  while (id !== startId) {
    const step = previous.get(id);
    if (!step) return { ok: false, reason: 'no-walkable-route', message: 'No walkable route found.' };
    edges.unshift(step.edge);
    if (step.check.status === 'unverified') unverifiedEdges++;
    id = step.id;
    path.unshift(nodes.get(id)!);
  }
  return { ok: true, nodes: path, edges, distance: distances.get(destinationId)!,
    floorTransitions: path.slice(1).filter((node, index) => node.floor !== path[index].floor).length, unverifiedEdges };
}
