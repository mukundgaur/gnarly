import type { Edge, Graph, Node, ScanFeatures } from './data.ts';
import { checkEdge, distance3D, pointOnFloor } from './geometry.ts';

export type EditResult = { graph: Graph; removedEdges: Edge[] };
export function addWaypoint(graph: Graph, node: Node, scan?: ScanFeatures): Graph {
  if (!node.id.trim() || !node.position.every(Number.isFinite)) throw Error('Provide an ID and finite coordinates.');
  if (graph.nodes.some(item => item.id === node.id)) throw Error('Waypoint ID already exists.');
  if (!graph.floors.some(item => item.id === node.floor)) throw Error('Choose a valid floor.');
  if (!pointOnFloor(node.position, node.floor, graph, scan)) throw Error('Waypoint must be on the scanned floor.');
  return { ...graph, nodes: [...graph.nodes, node] };
}
export function updateWaypoint(graph: Graph, node: Node, scan?: ScanFeatures): EditResult {
  if (!graph.nodes.some(item => item.id === node.id)) throw Error('Waypoint no longer exists.');
  if (!graph.floors.some(item => item.id === node.floor)) throw Error('Choose a valid floor.');
  if (!node.position.every(Number.isFinite)) throw Error('Coordinates must be finite numbers.');
  const next: Graph = { ...graph, nodes: graph.nodes.map(item => item.id === node.id ? node : item) };
  const previous = graph.nodes.find(item=>item.id===node.id)!;
  if(previous.floor===node.floor && previous.type===node.type && previous.position.every((value,index)=>value===node.position[index]))return {graph:next,removedEdges:[]};
  if (!pointOnFloor(node.position, node.floor, graph, scan)) throw Error('Waypoint must be on the scanned floor.');
  const removedEdges: Edge[] = [];
  next.edges = graph.edges.flatMap(edge => {
    if (edge.from !== node.id && edge.to !== node.id) return [edge];
    const from = next.nodes.find(item => item.id === edge.from)!;
    const to = next.nodes.find(item => item.id === edge.to)!;
    if(!from||!to){removedEdges.push(edge);return []}
    const moved=previous.floor!==node.floor||previous.position.some((value,index)=>value!==node.position[index]);
    const updated = { ...edge, meters: moved ? distance3D(from, to) : edge.meters };
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
const isWalkSample = (node: Node) => node.source === 'walked-path' || node.id.startsWith('walk-');
/**
 * Mirrors the navigator's visibility pass: same floor, 0.2–18 m apart, and accepted by checkEdge.
 * Pairs of walk samples are skipped so a shortcut cannot bypass the recorded walk.
 */
export function autoConnect(graph: Graph, scan?: ScanFeatures, maxMeters = 18): { graph: Graph; added: Edge[] } {
  if (!scan?.floors?.length) return { graph, added: [] };
  const connected = new Set(graph.edges.flatMap(edge => [edge.from + '\u0000' + edge.to, edge.to + '\u0000' + edge.from]));
  const added: Edge[] = [];
  for (let i = 0; i < graph.nodes.length; i++) for (let j = i + 1; j < graph.nodes.length; j++) {
    const a = graph.nodes[i], b = graph.nodes[j];
    if (a.floor !== b.floor || (isWalkSample(a) && isWalkSample(b)) || connected.has(a.id + '\u0000' + b.id)) continue;
    const span = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
    if (span < .2 || span > maxMeters) continue;
    const edge: Edge = { from: a.id, to: b.id, kind: a.type === 'stairs' && b.type === 'stairs' ? 'stairs' : 'hallway', meters: distance3D(a, b), source: 'visibility' };
    if (checkEdge(edge, graph, scan).status === 'valid') added.push(edge);
  }
  return { graph: { ...graph, edges: [...graph.edges, ...added] }, added };
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
