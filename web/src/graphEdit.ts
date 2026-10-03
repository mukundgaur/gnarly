import type { Edge, Graph, Node, ScanFeatures } from './data.ts';
import { checkEdge, distance3D, pointOnFloor } from './geometry.ts';

export type EditResult = { graph: Graph; removedEdges: Edge[] };
export function addWaypoint(graph: Graph, node: Node, scan?: ScanFeatures): Graph {
  if (graph.nodes.some(item => item.id === node.id)) throw Error('Waypoint ID already exists.');
  if (!graph.floors.some(item => item.id === node.floor)) throw Error('Choose a valid floor.');
  if (!pointOnFloor(node.position, node.floor, graph, scan)) throw Error('Waypoint must be on the scanned floor.');
  return { ...graph, nodes: [...graph.nodes, node] };
}
export function updateWaypoint(graph: Graph, node: Node, scan?: ScanFeatures): EditResult {
  if (!graph.nodes.some(item => item.id === node.id)) throw Error('Waypoint no longer exists.');
  if (!graph.floors.some(item => item.id === node.floor)) throw Error('Choose a valid floor.');
  if (!node.position.every(Number.isFinite)) throw Error('Coordinates must be finite numbers.');
  if (!pointOnFloor(node.position, node.floor, graph, scan)) throw Error('Waypoint must be on the scanned floor.');
  const next: Graph = { ...graph, nodes: graph.nodes.map(item => item.id === node.id ? node : item) };
  const removedEdges: Edge[] = [];
  next.edges = graph.edges.flatMap(edge => {
    if (edge.from !== node.id && edge.to !== node.id) return [edge];
    const from = next.nodes.find(item => item.id === edge.from)!;
    const to = next.nodes.find(item => item.id === edge.to)!;
    const updated = { ...edge, meters: distance3D(from, to) };
    if (checkEdge(updated, next, scan).status === 'blocked') { removedEdges.push(edge); return []; }
    return [updated];
  });
  return { graph: next, removedEdges };
}
export function deleteWaypoint(graph: Graph, id: string): EditResult {
  const removedEdges = graph.edges.filter(edge => edge.from === id || edge.to === id);
  return { graph: { ...graph, nodes: graph.nodes.filter(node => node.id !== id), edges: graph.edges.filter(edge => edge.from !== id && edge.to !== id) }, removedEdges };
}
export function connectWaypoints(graph: Graph, fromId: string, toId: string, scan?: ScanFeatures): Graph {
  const from = graph.nodes.find(node => node.id === fromId), to = graph.nodes.find(node => node.id === toId);
  if (!from || !to || fromId === toId) throw Error('Choose two different waypoints.');
  if (graph.edges.some(edge => edge.from === fromId && edge.to === toId || edge.from === toId && edge.to === fromId)) throw Error('These waypoints are already connected.');
  const edge: Edge = { from: fromId, to: toId, kind: from.floor === to.floor ? 'hallway' : 'stairs', meters: distance3D(from, to), source: 'manual' };
  const check = checkEdge(edge, graph, scan);
  if (check.status === 'blocked') throw Error(check.reason);
  return { ...graph, edges: [...graph.edges, edge] };
}
export function disconnectWaypoints(graph: Graph, fromId: string, toId: string): Graph {
  return { ...graph, edges: graph.edges.filter(edge => !(edge.from === fromId && edge.to === toId || edge.from === toId && edge.to === fromId)) };
}
export function validateGraph(graph: Graph): string[] {
  const errors: string[] = [];
  const ids = new Set<string>(), floors = new Set(graph.floors.map(floor => floor.id));
  for (const node of graph.nodes) {
    if (!node.id || ids.has(node.id)) errors.push('Duplicate or empty waypoint ID: ' + node.id);
    ids.add(node.id);
    if (!floors.has(node.floor)) errors.push('Unknown floor for ' + node.id);
    if (node.position.length !== 3 || !node.position.every(Number.isFinite)) errors.push('Invalid coordinates for ' + node.id);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push('Dangling connection: ' + edge.from + ' → ' + edge.to);
    if (!Number.isFinite(edge.meters) || edge.meters <= 0) errors.push('Invalid distance: ' + edge.from + ' → ' + edge.to);
  }
  return errors;
}
