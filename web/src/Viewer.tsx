import { Canvas, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, Text } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, DoubleSide, Matrix4, Shape, ShapeGeometry, Vector2, Vector3 } from 'three';
import type { Graph, Node, ScanFeature, ScanFeatures } from './data';
import { checkEdge } from './geometry';

type ViewerProps = {
  graph: Graph;
  scan?: ScanFeatures;
  illustrative?: boolean;
  floor: string;
  selected: string;
  onSelect: (id: string) => void;
  path: Node[];
  step: number;
  reset: number;
  editing?: boolean;
  onFloorPick?: (position: [number, number, number], floorId: string) => void;
};

function featureMatrix(feature: ScanFeature) {
  return feature.transformColumnMajor?.length === 16
    ? new Matrix4().fromArray(feature.transformColumnMajor)
    : new Matrix4().makeTranslation(...feature.position);
}

function FeatureBox({ feature, color, opacity = 1 }: {
  feature: ScanFeature;
  color: string;
  opacity?: number;
}) {
  const matrix = useMemo(() => featureMatrix(feature), [feature]);
  const dimensions = feature.dimensions.map(value => Math.max(.025, value)) as [number, number, number];
  return <group matrix={matrix} matrixAutoUpdate={false}>
    <mesh>
      <boxGeometry args={dimensions} />
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  </group>;
}

function ScannedFloor({ feature, onPick }: { feature: ScanFeature; onPick?: (position: [number, number, number]) => void }) {
  const outline = feature.polygonCorners?.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const geometry = useMemo(() => {
    if (!outline || outline.length < 3) return null;
    const shape = new Shape(outline.map(([x, y]) => new Vector2(x, y)));
    return new ShapeGeometry(shape);
  }, [feature]);
  const matrix = useMemo(() => featureMatrix(feature), [feature]);
  if (!geometry || !outline) return <group matrix={matrix} matrixAutoUpdate={false}><mesh onClick={event=>{if(onPick){event.stopPropagation();onPick(event.point.toArray() as [number,number,number])}}}><boxGeometry args={feature.dimensions.map(value=>Math.max(.025,value)) as [number,number,number]}/><meshStandardMaterial color="#d4e5e1" /></mesh></group>;
  return <group matrix={matrix} matrixAutoUpdate={false}>
    <mesh geometry={geometry} onClick={event => { if (onPick) { event.stopPropagation(); onPick(event.point.toArray() as [number, number, number]); } }}>
      <meshStandardMaterial color="#d4e5e1" side={DoubleSide} />
    </mesh>
    <Line points={[...outline, outline[0]].map(([x, y]) => [x, y, .015])} color="#6faaa1" lineWidth={1.5} />
  </group>;
}

function Wall({ wall, portals }: { wall: ScanFeature; portals: ScanFeature[] }) {
  const matrix = useMemo(() => featureMatrix(wall), [wall]);
  const width = Math.max(.025, wall.dimensions[0]);
  const height = Math.max(.025, wall.dimensions[1]);
  const depth = Math.max(.035, wall.dimensions[2] || .1);
  const segments = useMemo(() => {
    if (!portals.length) return [{ x: 0, y: 0, width, height }];
    const inverse = matrix.clone().invert();
    const holes = portals.map(portal => {
      const portalToWall = inverse.clone().multiply(featureMatrix(portal));
      const halfWidth = portal.dimensions[0] / 2;
      const halfHeight = portal.dimensions[1] / 2;
      const corners = [-halfWidth, halfWidth].flatMap(x =>
        [-halfHeight, halfHeight].map(y => new Vector3(x, y, 0).applyMatrix4(portalToWall)));
      // A parent link alone is insufficient if an export has a displaced portal.
      if (corners.some(corner => Math.abs(corner.z) > Math.max(.3, depth * 2))) return null;
      return {
        left: Math.max(-width / 2, Math.min(...corners.map(corner => corner.x))),
        right: Math.min(width / 2, Math.max(...corners.map(corner => corner.x))),
        bottom: Math.max(-height / 2, Math.min(...corners.map(corner => corner.y))),
        top: Math.min(height / 2, Math.max(...corners.map(corner => corner.y))),
      };
    }).filter((hole): hole is NonNullable<typeof hole> => Boolean(hole && hole.left < hole.right && hole.bottom < hole.top));
    const xs = [...new Set([-width / 2, width / 2, ...holes.flatMap(h => [h.left, h.right])])].sort((a, b) => a - b);
    const ys = [...new Set([-height / 2, height / 2, ...holes.flatMap(h => [h.bottom, h.top])])].sort((a, b) => a - b);
    const result: { x: number; y: number; width: number; height: number }[] = [];
    for (let x = 0; x < xs.length - 1; x++) {
      for (let y = 0; y < ys.length - 1; y++) {
        const cx = (xs[x] + xs[x + 1]) / 2;
        const cy = (ys[y] + ys[y + 1]) / 2;
        if (holes.some(h => cx > h.left && cx < h.right && cy > h.bottom && cy < h.top)) continue;
        if (xs[x + 1] - xs[x] < .005 || ys[y + 1] - ys[y] < .005) continue;
        result.push({ x: cx, y: cy, width: xs[x + 1] - xs[x], height: ys[y + 1] - ys[y] });
      }
    }
    return result;
  }, [matrix, portals, width, height]);
  return <group matrix={matrix} matrixAutoUpdate={false}>
    {segments.map((part, index) => <mesh key={index} position={[part.x, part.y, 0]}>
      <boxGeometry args={[part.width, part.height, depth]} />
      <meshStandardMaterial color="#c9d8dc" transparent opacity={.79} side={2} />
    </mesh>)}
  </group>;
}

function ScannedGeometry({ scan, graph, floor, onFloorPick }: { scan: ScanFeatures; graph: Graph; floor: string; onFloorPick?: ViewerProps['onFloorPick'] }) {
  const story = graph.floors.find(item => item.id === floor)?.story;
  const visible = (item: ScanFeature) => floor === 'all' || item.story == null || item.story === story;
  const portals = [...scan.doors, ...scan.openings, ...scan.windows].filter(visible);
  return <>
    {scan.floors.filter(visible).map(item => <ScannedFloor key={item.identifier} feature={item} onPick={onFloorPick ? position => {
      const floorId = graph.floors.find(candidate => candidate.story === item.story)?.id || graph.floors[0]?.id;
      if (floorId) onFloorPick(position, floorId);
    } : undefined} />)}
    {scan.walls.filter(visible).map(item => <Wall key={item.identifier} wall={item} portals={portals.filter(portal => portal.parentIdentifier === item.identifier)} />)}
    {scan.windows.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color="#8fbfce" opacity={.32} />)}
    {scan.doors.filter(visible).filter(item => item.category === 'door-closed').map(item =>
      <FeatureBox key={item.identifier} feature={item} color="#b6d0c2" opacity={.35} />)}
    {scan.objects.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color={item.category === 'stairs' ? '#c9ac7e' : '#c9d2d4'} opacity={.8} />)}
  </>;
}

function GraphFloor({ graph, floor, illustrative, onFloorPick }: { graph: Graph; floor: string; illustrative?: boolean; onFloorPick?: ViewerProps['onFloorPick'] }) {
  return <>{graph.floors.filter(item => floor === 'all' || item.id === floor).map(item => {
    const nodes = graph.nodes.filter(node => node.floor === item.id);
    const xs = nodes.map(node => node.position[0]);
    const zs = nodes.map(node => node.position[2]);
    const minX = Math.min(0, ...xs) - 2;
    const maxX = Math.max(0, ...xs) + 2;
    const minZ = Math.min(0, ...zs) - 2;
    const maxZ = Math.max(0, ...zs) + 2;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const width = Math.max(4, maxX - minX);
    const depth = Math.max(4, maxZ - minZ);
    return <group key={item.id}>
      <mesh position={[cx, item.elevation - .08, cz]} onClick={event => { if (onFloorPick) { event.stopPropagation(); onFloorPick(event.point.toArray() as [number, number, number], item.id); } }}>
        <boxGeometry args={[width, .12, depth]} />
        <meshStandardMaterial color={item.story ? '#e7edf0' : '#edf1f2'} />
      </mesh>
      {illustrative && <>
        {[-1, 1].map(side => <mesh key={'x' + side} position={[cx + side * width / 2, item.elevation + .65, cz]}>
          <boxGeometry args={[.16, 1.3, depth]} />
          <meshStandardMaterial color="#bac8ce" transparent opacity={.45} />
        </mesh>)}
        {[-1, 1].map(side => <mesh key={'z' + side} position={[cx, item.elevation + .65, cz + side * depth / 2]}>
          <boxGeometry args={[width, 1.3, .16]} />
          <meshStandardMaterial color="#bac8ce" transparent opacity={.45} />
        </mesh>)}
      </>}
      <Text position={[minX + 1, item.elevation + .05, minZ + 1]} rotation={[-Math.PI / 2, 0, 0]} fontSize={.35} color="#82949b">
        {item.name || item.id}
      </Text>
    </group>;
  })}</>;
}

function CameraRig({ graph, scan, floor, reset }: Pick<ViewerProps, 'graph' | 'scan' | 'floor' | 'reset'>) {
  const { camera } = useThree();
  const controls = useRef<{ target: Vector3; update: () => void } | null>(null);
  useEffect(() => {
    const box = new Box3();
    for (const node of graph.nodes) {
      if (floor === 'all' || node.floor === floor) box.expandByPoint(new Vector3(...node.position));
    }
    if (scan) {
      const story = graph.floors.find(item => item.id === floor)?.story;
      const features = [...scan.floors, ...scan.walls, ...scan.objects];
      for (const feature of features) {
        if (floor !== 'all' && feature.story != null && feature.story !== story) continue;
        const size = new Vector3(...feature.dimensions.map(value => Math.max(.025, value)));
        box.union(new Box3().setFromCenterAndSize(new Vector3(), size).applyMatrix4(featureMatrix(feature)));
      }
    }
    if (box.isEmpty()) box.expandByPoint(new Vector3(0, 0, 0));
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const span = Math.max(8, size.x, size.z, size.y * 2);
    camera.position.copy(center).add(new Vector3(span * 1.2, span * .95, span * 1.2));
    camera.lookAt(center);
    controls.current?.target.copy(center);
    controls.current?.update();
  }, [camera, graph, scan, floor, reset]);
  return <OrbitControls ref={controls as never} enableDamping minDistance={2} maxDistance={200} maxPolarAngle={Math.PI / 2.05} />;
}

function Scene(props: ViewerProps) {
  const { graph, scan, illustrative, floor, selected, onSelect, path, step, editing, onFloorPick } = props;
  const visibleNodes = graph.nodes.filter(node => floor === 'all' || node.floor === floor);
  const routeSegments = path.slice(1).map((node, index) => [path[index], node] as const)
    .filter(([from, to]) => floor === 'all' || (from.floor === floor && to.floor === floor));
  return <>
    <ambientLight intensity={2} />
    <directionalLight position={[8, 15, 12]} intensity={2} />
    {!scan && <gridHelper args={[100, 100, '#d7dee3', '#e8edef']} position={[0, -.12, 0]} />}
    {scan ? <ScannedGeometry scan={scan} graph={graph} floor={floor} onFloorPick={onFloorPick} /> : <GraphFloor graph={graph} floor={floor} illustrative={illustrative} onFloorPick={onFloorPick} />}
    {(editing || !scan) && graph.edges.map((edge, index) => {
      const from = graph.nodes.find(node => node.id === edge.from);
      const to = graph.nodes.find(node => node.id === edge.to);
      if (!from || !to || (floor !== 'all' && (from.floor !== floor || to.floor !== floor))) return null;
      const status = checkEdge(edge, graph, scan).status;
      return <Line key={index} points={[from.position, to.position]} color={status === 'blocked' ? '#d88a82' : status === 'unverified' ? '#d4ac62' : '#8abdb2'} lineWidth={editing ? 2 : 1} transparent opacity={editing ? .8 : .35} />;
    })}
    {visibleNodes.filter(node => editing || node.label || node.type === 'entrance' || node.type === 'destination' || node.type === 'stairs').map(node =>
      <group key={node.id} position={node.position} onClick={event => { event.stopPropagation(); onSelect(node.id); }}>
        <mesh position={[0, .35, 0]}>
          <cylinderGeometry args={[.16, .16, .7, 20]} />
          <meshStandardMaterial color={node.id === selected ? '#0b8b81' : node.type === 'stairs' ? '#e6a84d' : '#277ad1'} />
        </mesh>
        {(node.label || node.id === selected || !editing) && <Html position={[0, .9, 0]} center distanceFactor={13}>
          <button className={'scene-label ' + (node.id === selected ? 'chosen' : '')} onClick={() => onSelect(node.id)}>
            {node.label || node.id}
          </button>
        </Html>}
      </group>)}
    {routeSegments.map(([from, to], index) => <Line key={'route-' + index} points={[[from.position[0], from.position[1] + .18, from.position[2]], [to.position[0], to.position[1] + .18, to.position[2]]]} color="#2583df" lineWidth={5} />)}
    {path.slice(0, step + 1).map(node => <mesh key={'breadcrumb-' + node.id} position={[node.position[0], node.position[1] + .24, node.position[2]]}>
      <sphereGeometry args={[.14, 12, 12]} />
      <meshBasicMaterial color="#2583df" />
    </mesh>)}
  </>;
}

export default function Viewer(props: ViewerProps) {
  return <Canvas camera={{ position: [24, 23, 27], fov: 42 }} gl={{ antialias: true }}>
    <Scene {...props} />
    <CameraRig graph={props.graph} scan={props.scan} floor={props.floor} reset={props.reset} />
  </Canvas>;
}
