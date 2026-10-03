import { Canvas, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, Text } from '@react-three/drei';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { Box3, BoxGeometry, Color, DoubleSide, FrontSide, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Shape, ShapeGeometry, SRGBColorSpace, TextureLoader, Vector2, Vector3, type Material, type Texture } from 'three';
import type { Graph, Node, ScanFeature, ScanFeatures, SurfaceColorFace, SurfaceColors } from './data';
import { checkEdge } from './geometry';

// Matches the face names and UV directions baked by the mapper (three.js BoxGeometry group order).
const BOX_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;

const SurfaceColorContext = createContext<{ colors?: SurfaceColors; atlas: Texture | null }>({ atlas: null });

function useAtlasTexture(colors?: SurfaceColors) {
  const atlas = useMemo(() => {
    if (!colors?.atlasUrl) return null;
    const texture = new TextureLoader().load(colors.atlasUrl);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }, [colors?.atlasUrl]);
  useEffect(() => () => atlas?.dispose(), [atlas]);
  return atlas;
}

/** Face-local UV (0..1, v up) to atlas UV; rects are [x, y, w, h] in pixels from the atlas top-left. */
function atlasUV(colors: SurfaceColors, rect: NonNullable<SurfaceColorFace['rect']>, u: number, v: number): [number, number] {
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  return [(rect[0] + clampedU * rect[2]) / colors.atlasWidth, 1 - (rect[1] + (1 - clampedV) * rect[3]) / colors.atlasHeight];
}

function surfaceAverage(faces?: Record<string, SurfaceColorFace>) {
  const list = Object.values(faces || {});
  const total = list.reduce((sum, face) => sum + Math.max(face.coverage, .001), 0);
  if (!list.length) return null;
  const rgb = [0, 1, 2].map(channel => list.reduce((sum, face) => sum + face.color[channel] * Math.max(face.coverage, .001), 0) / total);
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

function useDisposable<T extends { dispose(): void } | { dispose(): void }[]>(value: T) {
  useEffect(() => () => { (Array.isArray(value) ? value : [value]).forEach(item => item.dispose()); }, [value]);
  return value;
}

/** A segment of a planar wall: where this box sits inside the full wall face, in wall-local meters. */
type WallRegion = { x: number; y: number; width: number; height: number; faceWidth: number; faceHeight: number };

function ColoredBox({ identifier, size, position, region, fallback, opacity = 1, side = FrontSide }: {
  identifier: string;
  size: [number, number, number];
  position?: [number, number, number];
  region?: WallRegion;
  fallback: string;
  opacity?: number;
  side?: typeof FrontSide | typeof DoubleSide;
}) {
  const { colors, atlas } = useContext(SurfaceColorContext);
  const faces = colors?.surfaces[identifier];
  const regionKey = region ? [region.x, region.y, region.width, region.height, region.faceWidth, region.faceHeight].join(',') : '';
  const geometry = useDisposable(useMemo(() => {
    const geometry = new BoxGeometry(...size);
    if (!colors || !faces || !atlas) return geometry;
    const uv = geometry.getAttribute('uv');
    BOX_FACES.forEach((name, index) => {
      const rect = faces[name]?.rect;
      if (!rect) return;
      for (let vertex = index * 4; vertex < index * 4 + 4; vertex++) {
        let u = uv.getX(vertex);
        let v = uv.getY(vertex);
        if (region && (name === 'pz' || name === 'nz')) {
          const localX = name === 'pz' ? region.x - region.width / 2 + u * region.width : region.x + region.width / 2 - u * region.width;
          u = name === 'pz' ? localX / region.faceWidth + .5 : .5 - localX / region.faceWidth;
          v = (region.y - region.height / 2 + v * region.height) / region.faceHeight + .5;
        }
        const [atlasU, atlasV] = atlasUV(colors, rect, u, v);
        uv.setXY(vertex, atlasU, atlasV);
      }
    });
    uv.needsUpdate = true;
    return geometry;
  }, [size.join(','), regionKey, colors, faces, atlas]));
  const materials = useDisposable(useMemo<Material[]>(() => {
    const average = surfaceAverage(faces);
    const transparent = opacity < 1;
    return BOX_FACES.map(name => {
      const face = faces?.[name];
      if (face?.rect && atlas) return new MeshBasicMaterial({ map: atlas, transparent, opacity, side, toneMapped: false });
      const color = face ? new Color().setRGB(face.color[0], face.color[1], face.color[2], SRGBColorSpace) : average;
      if (color) return new MeshBasicMaterial({ color, transparent, opacity, side, toneMapped: false });
      return new MeshStandardMaterial({ color: fallback, transparent, opacity, side });
    });
  }, [faces, atlas, fallback, opacity, side]));
  return <mesh geometry={geometry} material={materials} position={position} />;
}

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
    <ColoredBox identifier={feature.identifier} size={dimensions} fallback={color} opacity={opacity} />
  </group>;
}

function ScannedFloor({ feature, onPick }: { feature: ScanFeature; onPick?: (position: [number, number, number]) => void }) {
  const { colors, atlas } = useContext(SurfaceColorContext);
  const faces = colors?.surfaces[feature.identifier];
  const outline = feature.polygonCorners?.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  // The floor polygon is drawn once, so show whichever side the camera actually saw better.
  const face = [faces?.pz, faces?.nz]
    .filter((item): item is SurfaceColorFace => Boolean(item))
    .sort((a, b) => Number(Boolean(b.rect)) - Number(Boolean(a.rect)) || b.coverage - a.coverage)[0];
  const width = feature.dimensions[0];
  const height = feature.dimensions[1];
  const textured = Boolean(colors && atlas && face?.rect && width > .01 && height > .01);
  const geometry = useMemo(() => {
    if (!outline || outline.length < 3) return null;
    const shape = new Shape(outline.map(([x, y]) => new Vector2(x, y)));
    const geometry = new ShapeGeometry(shape);
    if (textured && colors && face?.rect) {
      const position = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      for (let index = 0; index < position.count; index++) {
        const x = position.getX(index);
        const u = face.face === 'nz' ? .5 - x / width : x / width + .5;
        const [atlasU, atlasV] = atlasUV(colors, face.rect, u, position.getY(index) / height + .5);
        uv.setXY(index, atlasU, atlasV);
      }
      uv.needsUpdate = true;
    }
    return geometry;
  }, [feature, textured, colors, face]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  const matrix = useMemo(() => featureMatrix(feature), [feature]);
  const pick = (event: { stopPropagation: () => void; point: Vector3 }) => {
    if (onPick) { event.stopPropagation(); onPick(event.point.toArray() as [number, number, number]); }
  };
  if (!geometry || !outline) return <group matrix={matrix} matrixAutoUpdate={false}><mesh onClick={pick}><boxGeometry args={feature.dimensions.map(value=>Math.max(.025,value)) as [number,number,number]}/><meshStandardMaterial color="#d4e5e1" /></mesh></group>;
  const average = face ? new Color().setRGB(face.color[0], face.color[1], face.color[2], SRGBColorSpace) : null;
  return <group matrix={matrix} matrixAutoUpdate={false}>
    <mesh geometry={geometry} onClick={pick}>
      {textured && atlas
        ? <meshBasicMaterial map={atlas} side={DoubleSide} toneMapped={false} />
        : average
          ? <meshBasicMaterial color={average} side={DoubleSide} toneMapped={false} />
          : <meshStandardMaterial color="#d4e5e1" side={DoubleSide} />}
    </mesh>
    {!colors && <Line points={[...outline, outline[0]].map(([x, y]) => [x, y, .015])} color="#6faaa1" lineWidth={1.5} />}
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
  const colored = Boolean(useContext(SurfaceColorContext).colors?.surfaces[wall.identifier]);
  return <group matrix={matrix} matrixAutoUpdate={false}>
    {segments.map((part, index) => <ColoredBox
      key={index}
      identifier={wall.identifier}
      size={[part.width, part.height, depth]}
      position={[part.x, part.y, 0]}
      region={{ ...part, faceWidth: width, faceHeight: height }}
      fallback="#c9d8dc"
      opacity={colored ? .94 : .79}
      side={colored ? FrontSide : DoubleSide}
    />)}
  </group>;
}

function ScannedGeometry({ scan, graph, floor, onFloorPick }: { scan: ScanFeatures; graph: Graph; floor: string; onFloorPick?: ViewerProps['onFloorPick'] }) {
  const story = graph.floors.find(item => item.id === floor)?.story;
  const visible = (item: ScanFeature) => floor === 'all' || item.story == null || item.story === story;
  const portals = [...scan.doors, ...scan.openings, ...scan.windows].filter(visible);
  const atlas = useAtlasTexture(scan.colors);
  const real = Boolean(scan.colors);
  const surfaceColors = useMemo(() => ({ colors: scan.colors, atlas }), [scan.colors, atlas]);
  return <SurfaceColorContext.Provider value={surfaceColors}>
    {scan.floors.filter(visible).map(item => <ScannedFloor key={item.identifier} feature={item} onPick={onFloorPick ? position => {
      const floorId = graph.floors.find(candidate => candidate.story === item.story)?.id || graph.floors[0]?.id;
      if (floorId) onFloorPick(position, floorId);
    } : undefined} />)}
    {scan.walls.filter(visible).map(item => <Wall key={item.identifier} wall={item} portals={portals.filter(portal => portal.parentIdentifier === item.identifier)} />)}
    {scan.windows.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color="#8fbfce" opacity={real ? .6 : .32} />)}
    {scan.doors.filter(visible).filter(item => item.category === 'door-closed').map(item =>
      <FeatureBox key={item.identifier} feature={item} color="#b6d0c2" opacity={real ? .96 : .35} />)}
    {scan.objects.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color={item.category === 'stairs' ? '#c9ac7e' : '#c9d2d4'} opacity={real ? .96 : .8} />)}
  </SurfaceColorContext.Provider>;
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
