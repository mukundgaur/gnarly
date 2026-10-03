import type { Edge, Graph, Node, ScanFeature, ScanFeatures } from './data.ts';

type P = [number, number];
export type EdgeCheck = { status: 'valid' | 'unverified' | 'blocked'; reason: string };
const eps = 1e-6;
const xz = (p: [number, number, number]): P => [p[0], p[2]];
const length = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];

function world(feature: ScanFeature, local: [number, number, number]): [number, number, number] {
  const m = feature.transformColumnMajor;
  if (!m || m.length !== 16) return [feature.position[0] + local[0], feature.position[1] + local[1], feature.position[2] + local[2]];
  return [m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12],
    m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13],
    m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14]];
}
export function floorPolygon(feature: ScanFeature): P[] {
  const points = feature.polygonCorners && feature.polygonCorners.length >= 3
    ? feature.polygonCorners
    : [[-feature.dimensions[0] / 2, -feature.dimensions[1] / 2, 0], [feature.dimensions[0] / 2, -feature.dimensions[1] / 2, 0], [feature.dimensions[0] / 2, feature.dimensions[1] / 2, 0], [-feature.dimensions[0] / 2, feature.dimensions[1] / 2, 0]] as [number, number, number][];
  return points.map(point => xz(world(feature, point)));
}
function distanceToSegment(point: P, a: P, b: P): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / Math.max(eps, dot(ab, ab))));
  return length(point, [a[0] + t * ab[0], a[1] + t * ab[1]]);
}
function inPolygon(point: P, polygon: P[], tolerance = .12): boolean {
  if (polygon.some((p, i) => distanceToSegment(point, p, polygon[(i + 1) % polygon.length]) <= tolerance)) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function segmentHit(a: P, b: P, c: P, d: P): P | null {
  const r = sub(b, a), s = sub(d, c), denominator = cross(r, s);
  if (Math.abs(denominator) < eps) return null;
  const t = cross(sub(c, a), s) / denominator;
  const u = cross(sub(c, a), r) / denominator;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}
function overlapsWall(a: P, b: P, c: P, d: P): boolean {
  const direction = sub(b, a), wall = sub(d, c);
  if (Math.abs(cross(direction, wall)) > eps || Math.abs(cross(sub(c, a), direction)) > eps) return false;
  const squared = dot(direction, direction);
  if (squared < eps) return false;
  const low = Math.max(0, Math.min(dot(sub(c, a), direction), dot(sub(d, a), direction)) / squared);
  const high = Math.min(1, Math.max(dot(sub(c, a), direction), dot(sub(d, a), direction)) / squared);
  return (high - low) * length(a, b) > .02;
}
function surfaceSegment(feature: ScanFeature): [P, P] {
  const half = feature.dimensions[0] / 2;
  return [xz(world(feature, [-half, 0, 0])), xz(world(feature, [half, 0, 0]))];
}
export function pointOnFloor(position: [number, number, number], floorId: string, graph: Graph, scan?: ScanFeatures): boolean {
  if (!position.every(Number.isFinite) || !graph.floors.some(floor=>floor.id===floorId)) return false;
  if (!scan?.floors?.length) {
    const nodes = graph.nodes.filter(node => node.floor === floorId);
    return position[0] >= Math.min(0, ...nodes.map(node => node.position[0])) - 2 &&
      position[0] <= Math.max(0, ...nodes.map(node => node.position[0])) + 2 &&
      position[2] >= Math.min(0, ...nodes.map(node => node.position[2])) - 2 &&
      position[2] <= Math.max(0, ...nodes.map(node => node.position[2])) + 2;
  }
  const story = graph.floors.find(floor => floor.id === floorId)?.story;
  const floors = scan.floors.filter(item => story == null || item.story == null || item.story === story);
  return floors.some(item => inPolygon(xz(position), floorPolygon(item), .25));
}
// Split at every polygon boundary, so short gaps and concave corners cannot be skipped.
function segmentOnFloors(a: P, b: P, polygons: P[][]): boolean {
  const distance=length(a,b);
  const cuts=[0,1];
  for(const polygon of polygons)for(let i=0;i<polygon.length;i++){
    const hit=segmentHit(a,b,polygon[i],polygon[(i+1)%polygon.length]);
    if(hit&&distance>eps)cuts.push(length(a,hit)/distance);
  }
  cuts.sort((x,y)=>x-y);
  const inside=(t:number)=>polygons.some(polygon=>inPolygon([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],polygon,.02));
  return inside(0)&&inside(1)&&cuts.slice(1).every((t,i)=>inside((cuts[i]+t)/2));
}
function wallObstruction(a:P,b:P,story:number|undefined,scan:ScanFeatures):string|null {
  const portals=[...(scan.doors||[]),...(scan.openings||[])];
  for(const wall of scan.walls||[]){
    if(story!=null&&wall.story!=null&&wall.story!==story)continue;
    const [c,d]=surfaceSegment(wall);
    if(overlapsWall(a,b,c,d))return 'Connection runs along a wall';
    const hit=segmentHit(a,b,c,d);
    if(!hit)continue;
    const doorway=portals.some(portal=>{
      if(story!=null&&portal.story!=null&&portal.story!==story)return false;
      if(wall.story!=null&&portal.story!=null&&wall.story!==portal.story)return false;
      if(portal.parentIdentifier&&portal.parentIdentifier!==wall.identifier)return false;
      const [left,right]=surfaceSegment(portal);
      return distanceToSegment(hit,left,right)<=.12;
    });
    if(!doorway)return 'Connection crosses a wall outside a doorway';
  }
  return null;
}
export function canWalkBetween(from: [number, number, number], to: [number, number, number], floorId: string, graph: Graph, scan?: ScanFeatures): boolean {
  if(!pointOnFloor(from,floorId,graph,scan)||!pointOnFloor(to,floorId,graph,scan))return false;
  if(!scan?.floors?.length)return true;
  const story=graph.floors.find(floor=>floor.id===floorId)?.story;
  const polygons=scan.floors.filter(item=>story==null||item.story==null||item.story===story).map(floorPolygon);
  return segmentOnFloors(xz(from),xz(to),polygons)&&!wallObstruction(xz(from),xz(to),story,scan);
}
function isWalked(edge: Edge): boolean { return ['manual', 'recorded', 'walked-path'].includes(edge.source || ''); }
export function checkEdge(edge: Edge, graph: Graph, scan?: ScanFeatures): EdgeCheck {
  if (!Number.isFinite(edge.meters) || edge.meters <= 0) return { status: 'blocked', reason: 'Invalid connection distance' };
  const from = graph.nodes.find(node => node.id === edge.from);
  const to = graph.nodes.find(node => node.id === edge.to);
  if (!from || !to) return { status: 'blocked', reason: 'Missing endpoint' };
  if (from.id === to.id) return { status: 'blocked', reason: 'Self connection' };
  if (from.floor !== to.floor) {
    return edge.kind === 'stairs' && from.type === 'stairs' && to.type === 'stairs'
      ? { status: 'valid', reason: 'Explicit stair connection' }
      : { status: 'blocked', reason: 'Floor transition requires connected stair waypoints' };
  }
  if (edge.kind === 'stairs' && (from.type !== 'stairs' || to.type !== 'stairs')) return { status: 'blocked', reason: 'Stair edge requires stair waypoints' };
  if (!scan?.floors?.length) return isWalked(edge)
    ? { status: 'unverified', reason: 'Manually or physically recorded; no floor scan to verify' }
    : { status: 'blocked', reason: 'No scanned floor; only confirmed connections can be routed' };
  const a = xz(from.position), b = xz(to.position);
  const distance = length(a, b);
  if (distance < .02) return { status: 'blocked', reason: 'Waypoints overlap' };
  const story = graph.floors.find(floor => floor.id === from.floor)?.story;
  const floors = scan.floors.filter(item => story == null || item.story == null || item.story === story).map(floorPolygon);
  if (!floors.length) return { status: 'blocked', reason: 'No scanned surface for this floor' };
  if(!segmentOnFloors(a,b,floors))return {status:'blocked',reason:'Connection leaves the scanned floor'};
  const obstruction=wallObstruction(a,b,story,scan);
  if(obstruction)return {status:'blocked',reason:obstruction};
  return { status: 'valid', reason: 'Inside floor and clear of walls' };
}
export function distance3D(a: Node, b: Node): number {
  return Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
}
