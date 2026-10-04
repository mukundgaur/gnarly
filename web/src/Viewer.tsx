import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, Text } from '@react-three/drei';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { Box3, BoxGeometry, Color, DoubleSide, FrontSide, Matrix4, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Shape, ShapeGeometry, SRGBColorSpace, TextureLoader, Vector2, Vector3, type Material, type Texture } from 'three';
import type { Graph, ScanFeature, ScanFeatures, SurfaceColorFace, SurfaceColors, ZoneView } from './data';
import { elevatorStopNear, zoneEdgeChecks, type BuildingModel, type BuildingNode, type ElevatorStop } from './buildingGraph.ts';
import { canWalkBetween, floorHeightAt, pointOnFloor, wallBetween } from './geometry';
import { FLOOR_GAP, toLocal, toWorld, type Vec3, type ZoneTransform } from './zoneAlign.ts';

/** position is in the zone's own ARKit coordinates. */
export type WalkLocation = { position: [number, number, number]; floorId: string; zoneId: string };
export type FloorPick = { position: [number, number, number]; floorId: string; zoneId: string };
export type DropRequest = { clientX: number; clientY: number; id: number };

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
  model: BuildingModel;
  /** A building floor level, or every floor stacked. */
  level: number | 'all';
  illustrative?: boolean;
  /** Node key. */
  selected: string;
  onSelect: (key: string) => void;
  path: BuildingNode[];
  step: number;
  reset: number;
  editing?: boolean;
  editZoneId?: string;
  onFloorPick?: (pick: FloorPick) => void;
  walker?: WalkLocation | null;
  walking?: boolean;
  dropRequest?: DropRequest | null;
  onWalkerDrop?: (location: WalkLocation | null) => void;
  onWalkerMove?: (location: WalkLocation) => void;
  /** The linked elevator the walker is standing at, or null after walking away. */
  onWalkerElevator?: (stop: ElevatorStop | null) => void;
};
type WorldPick = (world: Vec3, floorId: string) => void;
const zoneMatrix = (t: ZoneTransform) => new Matrix4().makeRotationY(t.rotationDegrees * Math.PI / 180).setPosition(t.x, t.y, t.z);

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

function ScannedFloor({ feature, floorId, zoneId, onPick }: { feature: ScanFeature; floorId: string; zoneId?: string; onPick?: (world: Vec3) => void }) {
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
    if (onPick) { event.stopPropagation(); onPick([event.point.x, event.point.y, event.point.z]); }
  };
  const userData={walkableFloor:true,floorId,zoneId};
  if (!geometry || !outline) return <group matrix={matrix} matrixAutoUpdate={false}><mesh userData={userData} onClick={pick}><boxGeometry args={feature.dimensions.map(value=>Math.max(.025,value)) as [number,number,number]}/><meshStandardMaterial color="#d4e5e1" /></mesh></group>;
  const average = face ? new Color().setRGB(face.color[0], face.color[1], face.color[2], SRGBColorSpace) : null;
  return <group matrix={matrix} matrixAutoUpdate={false}>
    <mesh geometry={geometry} userData={userData} onClick={pick}>
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

function ScannedGeometry({ scan, graph, floor, zoneId, onFloorPick }: { scan: ScanFeatures; graph: Graph; floor: string; zoneId?:string; onFloorPick?: WorldPick }) {
  const story = graph.floors.find(item => item.id === floor)?.story;
  const visible = (item: ScanFeature) => floor === 'all' || item.story == null || item.story === story;
  const portals = [...scan.doors, ...scan.openings, ...scan.windows].filter(visible);
  const atlas = useAtlasTexture(scan.colors);
  const real = Boolean(scan.colors);
  const surfaceColors = useMemo(() => ({ colors: scan.colors, atlas }), [scan.colors, atlas]);
  return <SurfaceColorContext.Provider value={surfaceColors}>
    {scan.floors.filter(visible).map(item => {
      const floorId = graph.floors.find(candidate => candidate.story === item.story)?.id || graph.floors[0]?.id;
      return floorId ? <ScannedFloor key={item.identifier} feature={item} floorId={floorId} zoneId={zoneId} onPick={onFloorPick ? world => onFloorPick(world, floorId) : undefined} /> : null;
    })}
    {scan.walls.filter(visible).map(item => <Wall key={item.identifier} wall={item} portals={portals.filter(portal => portal.parentIdentifier === item.identifier)} />)}
    {scan.windows.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color="#8fbfce" opacity={real ? .6 : .32} />)}
    {scan.doors.filter(visible).filter(item => item.category === 'door-closed').map(item =>
      <FeatureBox key={item.identifier} feature={item} color="#b6d0c2" opacity={real ? .96 : .35} />)}
    {scan.objects.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color={item.category === 'stairs' ? '#c9ac7e' : '#c9d2d4'} opacity={real ? .96 : .8} />)}
  </SurfaceColorContext.Provider>;
}

function GraphFloor({ graph, floor, illustrative, zoneId, onFloorPick }: { graph: Graph; floor: string; illustrative?: boolean; zoneId?:string; onFloorPick?: WorldPick }) {
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
      <mesh position={[cx, item.elevation - .08, cz]} userData={{ walkableFloor: true, floorId: item.id, zoneId }} onClick={event => { if (onFloorPick) { event.stopPropagation(); onFloorPick([event.point.x, event.point.y, event.point.z], item.id); } }}>
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

const nodeKeyOf = (zoneId: string, nodeId: string) => zoneId + '/' + nodeId;
const importantTypes = ['entrance', 'destination', 'stairs', 'elevator', 'continuation'];
function visibleFloorIds(model: BuildingModel, zone: ZoneView, level: number | 'all') {
  return zone.graph.floors.filter(floor => level === 'all' || model.levelOf(zone.id, floor.id) === level).map(floor => floor.id);
}
const edgeColor = (status: string) => status === 'blocked' ? '#d88a82' : status === 'unverified' || status === 'warning' ? '#d4ac62' : '#8abdb2';

/** All segments in one draw call; thousands of separate line meshes make editing large scans sluggish. */
function EdgeLines({ segments, opacity, lineWidth }: { segments: { from: Vec3; to: Vec3; color: string }[]; opacity: number; lineWidth: number }) {
  const { points, colors } = useMemo(() => {
    const color = new Color();
    return {
      points: segments.flatMap(segment => [segment.from, segment.to]),
      colors: segments.flatMap(segment => { color.set(segment.color); const rgb: [number, number, number] = [color.r, color.g, color.b]; return [rgb, rgb]; }),
    };
  }, [segments]);
  if (!segments.length) return null;
  return <Line points={points} vertexColors={colors} segments lineWidth={lineWidth} transparent opacity={opacity} />;
}

function ZoneEdges({ zone, shown, strong }: { zone: ZoneView; shown: Set<string>; strong: boolean }) {
  const shownKey = [...shown].join('|');
  const segments = useMemo(() => {
    const byId = new Map(zone.graph.nodes.map(node => [node.id, node]));
    const checks = zoneEdgeChecks(zone.graph, zone.scan);
    return zone.graph.edges.flatMap((edge, index) => {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      if (!from || !to || !shown.has(from.floor) || !shown.has(to.floor)) return [];
      return [{ from: from.position, to: to.position, color: edgeColor(checks[index].status) }];
    });
  }, [zone.graph, zone.scan, shownKey]);
  return <EdgeLines segments={segments} opacity={strong ? .8 : .35} lineWidth={strong ? 2 : 1} />;
}

const nodeColor = (type: string) => type === 'stairs' ? '#e6a84d' : type === 'elevator' ? '#8b5cf6' : type === 'continuation' ? '#0f9d91' : '#277ad1';

function CameraRig({ model, level, reset }: Pick<ViewerProps, 'model' | 'level' | 'reset'>) {
  const { camera, size: viewportSize } = useThree();
  const controls = useRef<{ target: Vector3; update: () => void } | null>(null);
  const frameKey = model.zones.map(zone => zone.id).join('|');
  const latest = useRef(model);
  latest.current = model;
  useEffect(() => {
    const model = latest.current;
    const box = new Box3();
    for (const node of model.nodes) if (level === 'all' || node.level === level) box.expandByPoint(new Vector3(...node.world));
    for (const zone of model.zones) {
      if (!zone.scan || !visibleFloorIds(model, zone, level).length) continue;
      const matrix = zoneMatrix(model.transforms.get(zone.id)!);
      for (const feature of [...zone.scan.floors, ...zone.scan.walls, ...zone.scan.objects]) {
        const size = new Vector3(...feature.dimensions.map(value => Math.max(.025, value)));
        box.union(new Box3().setFromCenterAndSize(new Vector3(), size).applyMatrix4(featureMatrix(feature)).applyMatrix4(matrix));
      }
    }
    if (box.isEmpty()) box.expandByPoint(new Vector3(0, 0, 0));
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const span = Math.max(8, size.x, size.z, size.y * 1.4) * Math.max(1, viewportSize.height / Math.max(1, viewportSize.width));
    camera.position.copy(center).add(new Vector3(span * 1.2, span * .95, span * 1.2));
    camera.lookAt(center);
    controls.current?.target.copy(center);
    controls.current?.update();
  }, [camera, frameKey, level, reset, viewportSize.width, viewportSize.height]);
  return <OrbitControls ref={controls as never} enableDamping minDistance={2} maxDistance={300} maxPolarAngle={level === 'all' ? Math.PI * .88 : Math.PI / 2.05} />;
}

function ZoneLayer({ model, zone, level, illustrative, editing, active, selected, onSelect, onFloorPick }: Pick<ViewerProps, 'model' | 'level' | 'illustrative' | 'editing' | 'selected' | 'onSelect' | 'onFloorPick'> & { zone: ZoneView; active: boolean }) {
  const t = model.transforms.get(zone.id)!;
  const floorIds = visibleFloorIds(model, zone, level);
  if (!floorIds.length) return null;
  const shown = new Set(floorIds);
  const graph = zone.graph;
  const pick: WorldPick | undefined = onFloorPick ? (world, floorId) => onFloorPick({ position: toLocal(t, world), floorId, zoneId: zone.id }) : undefined;
  const nodes = graph.nodes.filter(node => shown.has(node.floor) && ((editing && active) || node.label || importantTypes.includes(node.type)));
  const center = graph.nodes.length ? graph.nodes.reduce((sum, node) => [sum[0] + node.position[0] / graph.nodes.length, 0, sum[2] + node.position[2] / graph.nodes.length], [0, 0, 0]) : [0, 0, 0];
  return <group position={[t.x, t.y, t.z]} rotation={[0, t.rotationDegrees * Math.PI / 180, 0]}>
    {zone.scan
      ? <ScannedGeometry scan={zone.scan} graph={graph} floor={level === 'all' ? 'all' : floorIds[0]} zoneId={zone.id} onFloorPick={pick} />
      : <GraphFloor graph={graph} floor={level === 'all' ? 'all' : floorIds[0]} illustrative={illustrative} zoneId={zone.id} onFloorPick={pick} />}
    {((editing && active) || !zone.scan) && <ZoneEdges zone={zone} shown={shown} strong={Boolean(editing && active)} />}
    {nodes.map(node => {
      const key = nodeKeyOf(zone.id, node.id);
      return <group key={node.id} position={node.position} onClick={event => { event.stopPropagation(); onSelect(key); }}>
        <mesh position={[0, .35, 0]}>
          <cylinderGeometry args={[node.type === 'elevator' ? .22 : .16, node.type === 'elevator' ? .22 : .16, .7, 20]} />
          <meshStandardMaterial color={key === selected ? '#0b8b81' : nodeColor(node.type)} transparent={editing && !active} opacity={editing && !active ? .45 : 1} />
        </mesh>
        {(node.label || key === selected || !editing || importantTypes.includes(node.type)) && <Html position={[0, .9, 0]} center distanceFactor={13}>
          <button className={'scene-label ' + (key === selected ? 'chosen' : '')} onClick={() => onSelect(key)}>
            {node.label || node.id}
          </button>
        </Html>}
      </group>;
    })}
    {model.zones.length > 1 && <Html position={[center[0], (graph.floors.find(floor => floor.id === floorIds[0])?.elevation || 0) + .15, center[2]]} center distanceFactor={24}><span className={'floor-stack-label' + (editing && active ? ' active' : '')}>{zone.name}</span></Html>}
  </group>;
}

function SeamLines({ model, level }: Pick<ViewerProps, 'model' | 'level'>) {
  const segments = useMemo(() => model.seams.flatMap(seam => {
    const from = model.byKey.get(seam.from)!, to = model.byKey.get(seam.to)!;
    if (level !== 'all' && from.level !== level) return [];
    const lift = (point: Vec3): Vec3 => [point[0], point[1] + .05, point[2]];
    return [{ from: lift(from.world), to: lift(to.world), color: seam.check.status === 'valid' ? '#0f9d91' : '#d4ac62' }];
  }), [model.seams, model.byKey, level]);
  return <EdgeLines segments={segments} opacity={.9} lineWidth={3} />;
}

function Scene(props: ViewerProps) {
  const { model, level, path, step, walker, walking, editing, editZoneId } = props;
  const visible = (value: number) => level === 'all' || value === level;
  const routeSegments = path.slice(1).map((node, index) => [path[index], node] as const).filter(([from, to]) => visible(from.level) && visible(to.level));
  const groundLevel = level === 'all' ? Math.min(0, ...model.floors.map(floor => floor.level)) : level;
  const walkerZone = walker && model.transforms.get(walker.zoneId);
  return <>
    <ambientLight intensity={2} />
    <directionalLight position={[8, 22, 12]} intensity={2} />
    <gridHelper args={[160, 160, '#d7dee3', '#e8edef']} position={[0, groundLevel * FLOOR_GAP - .15, 0]} />
    {model.zones.map(zone => <ZoneLayer key={zone.id} {...props} zone={zone} active={!editing || zone.id === editZoneId} />)}
    {model.links.map((link, index) => {
      const from = model.byKey.get(link.from), to = model.byKey.get(link.to);
      if (!from || !to || !visible(from.level) || !visible(to.level)) return null;
      return <Line key={'zone-link-' + index} points={[from.world, to.world]} color={link.kind === 'continuation' ? '#0f9d91' : '#8b5cf6'} lineWidth={3} dashed dashSize={.28} gapSize={.2} transparent opacity={.9} />;
    })}
    {editing && <SeamLines model={model} level={level} />}
    {routeSegments.map(([from, to], index) => from.level === to.level
      ? <Line key={'route-' + index} points={[[from.world[0], from.world[1] + .18, from.world[2]], [to.world[0], to.world[1] + .18, to.world[2]]]} color="#2583df" lineWidth={5} />
      : <Line key={'route-' + index} points={[from.world, to.world]} color="#8b5cf6" lineWidth={4} dashed dashSize={.35} gapSize={.2} />)}
    {path.slice(0, step + 1).filter(node => visible(node.level)).map(node => <mesh key={'breadcrumb-' + node.key} position={[node.world[0], node.world[1] + .24, node.world[2]]}>
      <sphereGeometry args={[.14, 12, 12]} />
      <meshBasicMaterial color="#2583df" />
    </mesh>)}
    {walker && walkerZone && !walking && visible(model.levelOf(walker.zoneId, walker.floorId)) && <WalkerMarker position={toWorld(walkerZone, walker.position)} />}
  </>;
}

function DropController({ request, onDrop, model }: { request?: DropRequest | null; onDrop?: ViewerProps['onWalkerDrop']; model: BuildingModel }) {
  const { camera, gl, raycaster, scene } = useThree();
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!request || !onDrop || handled.current === request.id) return;
    handled.current = request.id;
    const bounds = gl.domElement.getBoundingClientRect();
    const pointer = new Vector2(
      ((request.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((request.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    if(request.clientX<bounds.left||request.clientX>bounds.right||request.clientY<bounds.top||request.clientY>bounds.bottom){onDrop(null);return}
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(scene.children, true)
      .find(item => item.object.userData.walkableFloor === true && typeof item.object.userData.floorId === 'string' && typeof item.object.userData.zoneId === 'string');
    const transform = hit && model.transforms.get(hit.object.userData.zoneId as string);
    onDrop(hit && transform ? { position: toLocal(transform, [hit.point.x, hit.point.y, hit.point.z]), floorId: hit.object.userData.floorId as string, zoneId: hit.object.userData.zoneId as string } : null);
  }, [camera, gl, onDrop, raycaster, request, scene, model]);
  return null;
}

function WalkerMarker({ position }: { position: Vec3 }) {
  return <group position={[position[0], position[1] + .02, position[2]]}>
    <mesh position={[0, 1.42, 0]} castShadow>
      <sphereGeometry args={[.18, 18, 18]} />
      <meshStandardMaterial color="#f3b33d" />
    </mesh>
    <mesh position={[0, .92, 0]} castShadow>
      <capsuleGeometry args={[.2, .55, 8, 16]} />
      <meshStandardMaterial color="#267ac7" />
    </mesh>
    <mesh position={[-.12, .35, 0]} rotation={[0, 0, -.08]} castShadow>
      <capsuleGeometry args={[.075, .55, 6, 10]} />
      <meshStandardMaterial color="#163d5a" />
    </mesh>
    <mesh position={[.12, .35, 0]} rotation={[0, 0, .08]} castShadow>
      <capsuleGeometry args={[.075, .55, 6, 10]} />
      <meshStandardMaterial color="#163d5a" />
    </mesh>
    <mesh position={[0, .02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[.28, .4, 28]} />
      <meshBasicMaterial color="#247aca" transparent opacity={.7} side={DoubleSide} />
    </mesh>
    <Html position={[0, 1.92, 0]} center distanceFactor={12}>
      <span className="walker-label">Walk from here</span>
    </Html>
  </group>;
}

/** Collision runs in the zone's own coordinates; the camera is placed in the building frame. */
function WalkCamera({ location, model, onMove, onElevator }: {
  location: WalkLocation;
  model: BuildingModel;
  onMove?: ViewerProps['onWalkerMove'];
  onElevator?: ViewerProps['onWalkerElevator'];
}) {
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>());
  const dragging = useRef(false);
  const lastPointer = useRef<[number, number]>([0, 0]);
  const yaw = useRef(0);
  const pitch = useRef(0);
  /** Feet in building coordinates, so the walker can cross from one zone into the next. */
  const feet = useRef<Vec3>([0, 0, 0]);
  const here = useRef({ zoneId: location.zoneId, floorId: location.floorId });
  const started = useRef('');
  const lastUpdate = useRef(0);
  const stop = useRef<ElevatorStop | null>(null);
  const latest = useRef(model);
  latest.current = model;
  const callbacks = useRef({ onMove, onElevator });
  callbacks.current = { onMove, onElevator };
  const placeCamera = (world: Vec3) => camera.position.set(world[0], world[1] + 1.62, world[2]);
  const report = () => {
    const { zoneId, floorId } = here.current, model = latest.current, t = model.transforms.get(zoneId);
    if (!t) return;
    lastUpdate.current = performance.now();
    callbacks.current.onMove?.({ position: toLocal(t, feet.current), floorId, zoneId });
    const next = elevatorStopNear(model, feet.current, model.levelOf(zoneId, floorId));
    const id = (stop: ElevatorStop | null) => stop ? [stop.from.key, stop.up?.key, stop.down?.key].join('|') : '';
    if (id(next) === id(stop.current)) return;
    stop.current = next;
    callbacks.current.onElevator?.(next);
  };
  const ride = (direction: 'up' | 'down') => {
    const to = stop.current?.[direction];
    const zone = to && latest.current.zones.find(item => item.id === to.zoneId), t = to && latest.current.transforms.get(to.zoneId);
    if (!to || !zone || !t) return;
    here.current = { zoneId: to.zoneId, floorId: to.floor };
    started.current = to.zoneId + '|' + to.floor;
    const ground = floorHeightAt(to.position, to.floor, zone.graph, zone.scan);
    feet.current = toWorld(t, [to.position[0], ground, to.position[2]]);
    placeCamera(feet.current);
    report();
  };
  const rideRef = useRef(ride);
  rideRef.current = ride;

  useEffect(() => {
    const id = location.zoneId + '|' + location.floorId;
    if (started.current === id) { report(); return; }
    started.current = id;
    const model = latest.current, zone = model.zones.find(item => item.id === location.zoneId), t = model.transforms.get(location.zoneId);
    if (!zone || !t) return;
    here.current = { zoneId: location.zoneId, floorId: location.floorId };
    feet.current = toWorld(t, location.position);
    const nearest = zone.graph.nodes
      .filter(node => node.floor === location.floorId && Math.hypot(node.position[0] - location.position[0], node.position[2] - location.position[2]) > .3)
      .sort((a, b) => Math.hypot(a.position[0] - location.position[0], a.position[2] - location.position[2]) - Math.hypot(b.position[0] - location.position[0], b.position[2] - location.position[2]))[0];
    if (nearest) {
      const there = toWorld(t, nearest.position);
      yaw.current = Math.atan2(feet.current[0] - there[0], feet.current[2] - there[2]);
    }
    pitch.current = 0;
    placeCamera(feet.current);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(0, yaw.current, 0);
    report();
  }, [camera, location.zoneId, location.floorId]);

  useEffect(() => () => { stop.current = null; callbacks.current.onElevator?.(null); }, []);

  useEffect(() => {
    const canvas = gl.domElement;
    const perspective = camera as PerspectiveCamera;
    if (perspective.isPerspectiveCamera) {
      perspective.fov = 68;
      perspective.updateProjectionMatrix();
    }
    canvas.tabIndex = 0;
    canvas.style.cursor = 'grab';
    canvas.focus();

    const movementCodes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
    const keyDown = (event: KeyboardEvent) => {
      const target=event.target;
      if(event.ctrlKey||event.metaKey||event.altKey||target instanceof HTMLElement && (target.matches('input,textarea,select,button')||target.isContentEditable))return;
      const direction = event.code === 'KeyE' || event.code === 'PageUp' ? 'up' : event.code === 'KeyQ' || event.code === 'PageDown' ? 'down' : null;
      if (direction) {
        event.preventDefault();
        if (!event.repeat) rideRef.current(direction);
        return;
      }
      if (movementCodes.has(event.code)) {
        event.preventDefault();
        keys.current.add(event.code);
      }
    };
    const keyUp = (event: KeyboardEvent) => keys.current.delete(event.code);
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging.current = true;
      lastPointer.current = [event.clientX, event.clientY];
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(event.pointerId);
      canvas.focus();
    };
    const pointerMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      const [x, y] = lastPointer.current;
      yaw.current -= (event.clientX - x) * .004;
      pitch.current = Math.max(-1.35, Math.min(1.35, pitch.current - (event.clientY - y) * .004));
      lastPointer.current = [event.clientX, event.clientY];
    };
    const pointerUp = (event: PointerEvent) => {
      dragging.current = false;
      canvas.style.cursor = 'grab';
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const clear = () => { keys.current.clear(); dragging.current = false; canvas.style.cursor = 'grab'; };
    window.addEventListener('keydown', keyDown, { passive: false });
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', clear);
    canvas.addEventListener('blur', clear);
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', clear);
      keys.current.clear();
      canvas.removeEventListener('blur', clear);
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerUp);
      canvas.style.cursor = '';
      if (perspective.isPerspectiveCamera) {
        perspective.fov = 42;
        perspective.updateProjectionMatrix();
      }
    };
  }, [camera, gl]);

  /** Steps within the current zone, or into another zone on the same floor where its scanned floor continues. */
  const step = (from: Vec3, to: Vec3): boolean => {
    const model = latest.current, { zoneId, floorId } = here.current;
    const zone = model.zones.find(item => item.id === zoneId), t = model.transforms.get(zoneId);
    if (!zone || !t) return false;
    const fromLocal = toLocal(t, from), toLocalPoint = toLocal(t, to);
    if (canWalkBetween(fromLocal, toLocalPoint, floorId, zone.graph, zone.scan)) return true;
    if (zone.scan && wallBetween(fromLocal, toLocalPoint, zone.scan)) return false;
    const level = model.levelOf(zoneId, floorId);
    for (const other of model.zones) {
      const t2 = model.transforms.get(other.id);
      if (other.id === zoneId || !t2) continue;
      const target = toLocal(t2, to);
      for (const floor of other.graph.floors) {
        if (model.levelOf(other.id, floor.id) !== level || !pointOnFloor(target, floor.id, other.graph, other.scan)) continue;
        if (other.scan && wallBetween(toLocal(t2, from), target, other.scan, floor.story)) continue;
        here.current = { zoneId: other.id, floorId: floor.id };
        started.current = other.id + '|' + floor.id;
        return true;
      }
    }
    return false;
  };

  useFrame((_, delta) => {
    const forward = Number(keys.current.has('KeyW') || keys.current.has('ArrowUp')) - Number(keys.current.has('KeyS') || keys.current.has('ArrowDown'));
    const turn = Number(keys.current.has('KeyA') || keys.current.has('ArrowLeft')) - Number(keys.current.has('KeyD') || keys.current.has('ArrowRight'));
    if (turn) yaw.current += turn * 1.85 * Math.min(delta, .05);
    camera.rotation.set(pitch.current, yaw.current, 0);
    if (!forward) return;
    const speed = (keys.current.has('ShiftLeft') || keys.current.has('ShiftRight') ? 5.5 : 1.9) * Math.min(delta, .05);
    const dx = -Math.sin(yaw.current) * forward * speed, dz = -Math.cos(yaw.current) * forward * speed;
    const current = feet.current;
    const next = ([[current[0] + dx, current[1], current[2] + dz], [current[0] + dx, current[1], current[2]], [current[0], current[1], current[2] + dz]] as Vec3[])
      .find(candidate => step(current, candidate));
    if (!next) return;
    feet.current = next;
    placeCamera(next);
    if (performance.now() - lastUpdate.current > 180) report();
  });
  return null;
}

export default function Viewer(props: ViewerProps) {
  return <Canvas camera={{ position: [24, 23, 27], fov: 42 }} gl={{ antialias: true }}>
    <Scene {...props} />
    <DropController request={props.dropRequest} onDrop={props.onWalkerDrop} model={props.model} />
    {props.walking && props.walker && props.model.transforms.has(props.walker.zoneId)
      ? <WalkCamera location={props.walker} model={props.model} onMove={props.onWalkerMove} onElevator={props.onWalkerElevator} />
      : <CameraRig model={props.model} level={props.level} reset={props.reset} />}
  </Canvas>;
}

