import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, Text } from '@react-three/drei';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Box3, BoxGeometry, Color, DoubleSide, FrontSide, Matrix4, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Plane, Shape, ShapeGeometry, SRGBColorSpace, TextureLoader, Vector2, Vector3, type Camera, type Group, type Material, type Raycaster, type Texture } from 'three';
import type { Graph, ScanFeature, ScanFeatures, SurfaceColorFace, SurfaceColors, ZoneView } from './data';
import { elevatorStopNear, zoneEdgeChecks, type BuildingModel, type BuildingNode, type ElevatorStop } from './buildingGraph.ts';
import { canWalkBetween, floorHeightAt, pointOnFloor, wallBetween } from './geometry';
import { FLOOR_GAP, toLocal, toWorld, type Vec3, type ZoneTransform } from './zoneAlign.ts';
import { InlineRename } from './ui.tsx';
import { dominantAngle, normalizeDegrees, placeSegments, rotateAbout, snapRotation, snapTranslation, zoneCenter, zoneSegments, type P2, type Placement, type Segment } from './zoneArrange.ts';

/** position is in the zone's own ARKit coordinates. */
export type WalkLocation = { position: [number, number, number]; floorId: string; zoneId: string };
export type FloorPick = { position: [number, number, number]; floorId: string; zoneId: string };
export type DropRequest = { clientX: number; clientY: number; id: number };

// Matches the face names and UV directions baked by the mapper (three.js BoxGeometry group order).
/** Scene palette: a dark operations-map look where floors read as slate plates and paths glow. */
const SCENE = {
  background: '#0b1219', gridMajor: '#1c2a35', gridMinor: '#131e27',
  floor: '#1f2d37', scannedFloor: '#26363f', outline: '#3d5a6b', floorText: '#5f7d8e',
  wall: '#7e97a6', door: '#6fb39a', window: '#5fa8c4', object: '#4c6170', stairs: '#c9a46a',
  edge: '#3fc7b0', edgeWarn: '#e0b45a', edgeBad: '#ef7a6d', route: '#4aa8ff', accent: '#5ec8ff', snap: '#ffb020',
};
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
  /** Blender-style zone moving: drag a zone's floor, or G / R with the pointer over the scene. */
  arrange?: ArrangeOptions;
  cameraView?: 'iso' | 'top';
  /** Lets waypoints of the zone being edited be dragged on their floor. */
  waypointEdit?: WaypointEditOptions;
  /** Node key of the waypoint a connection is being drawn from; a rubber band follows the pointer. */
  connectFrom?: string;
  /** Neighbors the edited zone touches but isn't joined to, shown as in-scene Join pills. */
  joinHints?: JoinHint[];
  onJoinHint?: (zoneId: string) => void;
  /** Node key whose label is being edited in place. */
  renaming?: string;
  /** Double-clicking a waypoint or its label starts renaming it; absent when names can't be edited. */
  onRename?: (key: string) => void;
  onRenamed?: (key: string, name: string | null) => void;
};
/** `seam` previews where the join would go; without it, `wallAt` marks a meeting blocked by a solid wall. */
export type JoinHint = { zoneId: string; name: string; seam?: [Vec3, Vec3]; wallAt?: Vec3; walled?: string; busy?: boolean };
export type WaypointEditOptions = {
  zoneId: string;
  snapping: boolean;
  onMove: (key: string, position: Vec3) => void;
  /** The selected waypoint, which gets a move gizmo. */
  selectedKey?: string;
};
export type ArrangeOptions = {
  /** The zone G and R act on. */
  zoneId: string;
  snapping: boolean;
  /** Whether a plain drag on a floor moves its zone (otherwise only G / R do). */
  dragFloors: boolean;
  /** Asked before dragging a different zone; false keeps the current one. */
  onSelect: (zoneId: string) => boolean;
  onCommit: (zoneId: string, placement: Placement) => void;
  /** Show the move / rotate gizmo on the zone. */
  gizmo: boolean;
  /** Dragging the gizmo's Y arrow moves the zone to another floor level. */
  onLevel: (zoneId: string, level: number) => void;
};
type ArrangeStatus = { title: string; detail: string; snap?: string; hint?: string };
const TRANSFORM_HINT = 'X / Z lock axis · type a number · Enter or click to confirm · Esc or right-click to cancel · hold Ctrl to flip snapping';
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
  if (!geometry || !outline) return <group matrix={matrix} matrixAutoUpdate={false}><mesh userData={userData} onClick={pick}><boxGeometry args={feature.dimensions.map(value=>Math.max(.025,value)) as [number,number,number]}/><meshStandardMaterial color={SCENE.scannedFloor} /></mesh></group>;
  const average = face ? new Color().setRGB(face.color[0], face.color[1], face.color[2], SRGBColorSpace) : null;
  return <group matrix={matrix} matrixAutoUpdate={false}>
    <mesh geometry={geometry} userData={userData} onClick={pick}>
      {textured && atlas
        ? <meshBasicMaterial map={atlas} side={DoubleSide} toneMapped={false} />
        : average
          ? <meshBasicMaterial color={average} side={DoubleSide} toneMapped={false} />
          : <meshStandardMaterial color={SCENE.scannedFloor} side={DoubleSide} />}
    </mesh>
    {!colors && <Line points={[...outline, outline[0]].map(([x, y]) => [x, y, .015])} color={SCENE.outline} lineWidth={1.5} />}
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
      fallback={SCENE.wall}
      opacity={colored ? .94 : .5}
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
    {scan.windows.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color={SCENE.window} opacity={real ? .6 : .32} />)}
    {scan.doors.filter(visible).filter(item => item.category === 'door-closed').map(item =>
      <FeatureBox key={item.identifier} feature={item} color={SCENE.door} opacity={real ? .96 : .35} />)}
    {scan.objects.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color={item.category === 'stairs' ? SCENE.stairs : SCENE.object} opacity={real ? .96 : .8} />)}
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
        <meshStandardMaterial color={SCENE.floor} roughness={.9} />
      </mesh>
      <Line points={[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([sx, sz]) => [cx + sx * width / 2, item.elevation - .015, cz + sz * depth / 2] as Vec3)} color={SCENE.outline} lineWidth={1.2} />
      {illustrative && <>
        {[-1, 1].map(side => <mesh key={'x' + side} position={[cx + side * width / 2, item.elevation + .65, cz]}>
          <boxGeometry args={[.16, 1.3, depth]} />
          <meshStandardMaterial color={SCENE.wall} transparent opacity={.38} />
        </mesh>)}
        {[-1, 1].map(side => <mesh key={'z' + side} position={[cx, item.elevation + .65, cz + side * depth / 2]}>
          <boxGeometry args={[width, 1.3, .16]} />
          <meshStandardMaterial color={SCENE.wall} transparent opacity={.38} />
        </mesh>)}
      </>}
      <Text position={[cx - width / 2 + 1, item.elevation + .05, cz - depth / 2 + 1]} rotation={[-Math.PI / 2, 0, 0]} fontSize={.35} color={SCENE.floorText} anchorX="left">
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
const edgeColor = (status: string) => status === 'blocked' ? SCENE.edgeBad : status === 'unverified' || status === 'warning' ? SCENE.edgeWarn : SCENE.edge;

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

export const nodeColor = (type: string) => type === 'stairs' ? '#f0b04f' : type === 'elevator' ? '#a37bff' : type === 'continuation' ? '#2fd1b8' : type === 'entrance' ? '#4ade80' : type === 'destination' ? '#ff6b8b' : '#4aa8ff';

type CameraFlight = { fromPosition: Vector3; toPosition: Vector3; fromTarget: Vector3; toTarget: Vector3; started: number };
const FLIGHT_MS = 650;
const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function CameraRig({ model, level, reset, cameraView = 'iso' }: Pick<ViewerProps, 'model' | 'level' | 'reset' | 'cameraView'>) {
  const { camera, size: viewportSize } = useThree();
  const controls = useRef<{ target: Vector3; update: () => void } | null>(null);
  const flight = useRef<CameraFlight | null>(null);
  const framed = useRef(false);
  useFrame(() => {
    const current = flight.current;
    if (!current || !controls.current) return;
    const t = Math.min(1, (performance.now() - current.started) / FLIGHT_MS);
    const k = ease(t);
    camera.position.lerpVectors(current.fromPosition, current.toPosition, k);
    controls.current.target.lerpVectors(current.fromTarget, current.toTarget, k);
    controls.current.update();
    if (t >= 1) flight.current = null;
  });
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
    const position = cameraView === 'top'
      ? center.clone().add(new Vector3(0, span * 1.75, .01))
      : center.clone().add(new Vector3(span * 1.2, span * .95, span * 1.2));
    if (!framed.current || !controls.current) {
      framed.current = true;
      camera.position.copy(position);
      camera.lookAt(center);
      controls.current?.target.copy(center);
      controls.current?.update();
      return;
    }
    flight.current = { fromPosition: camera.position.clone(), toPosition: position, fromTarget: controls.current.target.clone(), toTarget: center, started: performance.now() };
  }, [camera, frameKey, level, reset, cameraView, viewportSize.width, viewportSize.height]);
  return <OrbitControls ref={controls as never} enableDamping dampingFactor={.12} minDistance={2} maxDistance={300} maxPolarAngle={level === 'all' ? Math.PI * .88 : Math.PI / 2.05}
    onStart={() => { flight.current = null; }} />;
}

function WaypointMarker({ node, nodeKey, zoneId, chosen, dimmed, labeled, onSelect, renaming, onRename, onRenamed }: {
  node: Graph['nodes'][number]; nodeKey: string; zoneId: string; chosen: boolean; dimmed: boolean; labeled: boolean; onSelect: (key: string) => void;
  renaming: boolean; onRename?: (key: string) => void; onRenamed?: (key: string, name: string | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const radius = node.type === 'elevator' ? .22 : .16;
  const color = nodeColor(node.type);
  const userData = { nodeKey, zoneId };
  const hovering = useRef(false);
  hovering.current = hover;
  useEffect(() => () => { if (hovering.current) document.body.style.cursor = ''; }, []);
  return <group position={node.position}
    onClick={event => { event.stopPropagation(); onSelect(nodeKey); }}
    onDoubleClick={event => { if (!onRename) return; event.stopPropagation(); onRename(nodeKey); }}
    onPointerOver={event => { event.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
    onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}>
    <mesh position={[0, .35, 0]} scale={hover || chosen ? 1.18 : 1} userData={userData}>
      <cylinderGeometry args={[radius, radius, .7, 20]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={chosen ? .9 : hover ? .55 : .22} transparent={dimmed} opacity={dimmed ? .4 : 1} />
    </mesh>
    {(chosen || hover) && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .03, 0]} userData={userData}>
      <ringGeometry args={[radius + .12, radius + .22, 40]} />
      <meshBasicMaterial color={chosen ? SCENE.accent : '#ffffff'} transparent opacity={chosen ? .95 : .5} side={DoubleSide} toneMapped={false} />
    </mesh>}
    {renaming && onRenamed ? <Html position={[0, .95, 0]} center zIndexRange={[70, 60]}>
      <span className="scene-label renaming"><i style={{ background: color }} /><InlineRename value={node.label || ''} placeholder={node.id} onDone={name => onRenamed(nodeKey, name)} /></span>
    </Html> : labeled && <Html position={[0, .95, 0]} center distanceFactor={18} zIndexRange={[20, 0]}>
      <button className={'scene-label' + (chosen ? ' chosen' : '') + (dimmed ? ' dimmed' : '')} onClick={() => onSelect(nodeKey)} onDoubleClick={() => onRename?.(nodeKey)}
        title={onRename ? 'Double-click to rename' : undefined}>
        <i style={{ background: color }} />{node.label || node.id}
      </button>
    </Html>}
  </group>;
}

/** Live three.js groups per zone, so arranging can move a zone every frame without re-rendering React. */
class ZoneGroups {
  readonly groups = new Map<string, Group>();
  private refs = new Map<string, (group: Group | null) => void>();
  register(zoneId: string) {
    let ref = this.refs.get(zoneId);
    if (!ref) {
      ref = group => { if (group) this.groups.set(zoneId, group); else this.groups.delete(zoneId); };
      this.refs.set(zoneId, ref);
    }
    return ref;
  }
}
const ZoneGroupsContext = createContext(new ZoneGroups());

function ZoneLayer({ model, zone, level, illustrative, editing, active, selected, onSelect, onFloorPick, renaming, onRename, onRenamed }: Pick<ViewerProps, 'model' | 'level' | 'illustrative' | 'editing' | 'selected' | 'onSelect' | 'onFloorPick' | 'renaming' | 'onRename' | 'onRenamed'> & { zone: ZoneView; active: boolean }) {
  const t = model.transforms.get(zone.id)!;
  const groups = useContext(ZoneGroupsContext);
  const floorIds = visibleFloorIds(model, zone, level);
  if (!floorIds.length) return null;
  const shown = new Set(floorIds);
  const graph = zone.graph;
  const pick: WorldPick | undefined = onFloorPick ? (world, floorId) => onFloorPick({ position: toLocal(t, world), floorId, zoneId: zone.id }) : undefined;
  const nodes = graph.nodes.filter(node => shown.has(node.floor) && ((editing && active) || node.label || importantTypes.includes(node.type)));
  const center = graph.nodes.length ? graph.nodes.reduce((sum, node) => [sum[0] + node.position[0] / graph.nodes.length, 0, sum[2] + node.position[2] / graph.nodes.length], [0, 0, 0]) : [0, 0, 0];
  return <group ref={groups.register(zone.id)} position={[t.x, t.y, t.z]} rotation={[0, t.rotationDegrees * Math.PI / 180, 0]}>
    {zone.scan
      ? <ScannedGeometry scan={zone.scan} graph={graph} floor={level === 'all' ? 'all' : floorIds[0]} zoneId={zone.id} onFloorPick={pick} />
      : <GraphFloor graph={graph} floor={level === 'all' ? 'all' : floorIds[0]} illustrative={illustrative} zoneId={zone.id} onFloorPick={pick} />}
    {((editing && active) || !zone.scan) && <ZoneEdges zone={zone} shown={shown} strong={Boolean(editing && active)} />}
    {nodes.map(node => {
      const key = nodeKeyOf(zone.id, node.id);
      return <WaypointMarker key={node.id} node={node} nodeKey={key} zoneId={zone.id} chosen={key === selected} dimmed={Boolean(editing && !active)}
        labeled={Boolean(node.label || key === selected || !editing || importantTypes.includes(node.type))} onSelect={onSelect}
        renaming={key === renaming} onRename={onRename} onRenamed={onRenamed} />;
    })}
    {model.zones.length > 1 && <Html position={[center[0], (graph.floors.find(floor => floor.id === floorIds[0])?.elevation || 0) + .15, center[2]]} center distanceFactor={24}><span className={'floor-stack-label' + (editing && active ? ' active' : '')}>{zone.name}</span></Html>}
  </group>;
}

function SeamLines({ model, level }: Pick<ViewerProps, 'model' | 'level'>) {
  const segments = useMemo(() => model.seams.flatMap(seam => {
    const from = model.byKey.get(seam.from)!, to = model.byKey.get(seam.to)!;
    if (level !== 'all' && from.level !== level) return [];
    const lift = (point: Vec3): Vec3 => [point[0], point[1] + .05, point[2]];
    return [{ from: lift(from.world), to: lift(to.world), color: seam.check.status === 'valid' ? SCENE.edge : SCENE.edgeWarn }];
  }), [model.seams, model.byKey, level]);
  return <EdgeLines segments={segments} opacity={.9} lineWidth={3} />;
}

function JoinHints({ hints, onJoin }: { hints: JoinHint[]; onJoin?: (zoneId: string) => void }) {
  return <>{hints.map(hint => {
    if (hint.seam) {
      const [a, b] = hint.seam.map(point => [point[0], point[1] + .06, point[2]] as Vec3);
      const mid: Vec3 = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + .7, (a[2] + b[2]) / 2];
      return <group key={hint.zoneId}>
        <Line points={[a, b]} color="#2fd1b8" lineWidth={3} dashed dashSize={.18} gapSize={.12} />
        {[a, b].map((point, index) => <mesh key={index} position={point} rotation={[-Math.PI / 2, 0, 0]} renderOrder={900}>
          <ringGeometry args={[.22, .3, 32]} /><meshBasicMaterial color="#2fd1b8" depthTest={false} transparent opacity={.95} />
        </mesh>)}
        <Line points={[[mid[0], a[1], mid[2]], mid]} color="#2fd1b8" lineWidth={1} transparent opacity={.6} />
        <Html position={mid} center zIndexRange={[60, 40]}>
          <button className="join-pill" disabled={hint.busy} onClick={event => { event.stopPropagation(); onJoin?.(hint.zoneId); }}>
            <span className="join-pill-dot" />{hint.busy ? 'Joining…' : 'Join ' + hint.name}
          </button>
        </Html>
      </group>;
    }
    if (!hint.wallAt) return null;
    const at: Vec3 = [hint.wallAt[0], hint.wallAt[1] + .7, hint.wallAt[2]];
    return <Html key={hint.zoneId} position={at} center zIndexRange={[60, 40]}>
      <button className="join-pill walled" data-tip={hint.walled} onClick={event => { event.stopPropagation(); onJoin?.(hint.zoneId); }}>
        <span className="join-pill-dot" />Wall · no doorway to {hint.name}
      </button>
    </Html>;
  })}</>;
}

function Scene({ onArrangeStatus: reportStatus, ...props }: ViewerProps & { onArrangeStatus: (status: ArrangeStatus | null) => void }) {
  const { model, level, path, step, walker, walking, editing, editZoneId } = props;
  const [transforming, setTransforming] = useState(false);
  const onArrangeStatus = useCallback((status: ArrangeStatus | null) => { setTransforming(status !== null); reportStatus(status); }, [reportStatus]);
  const groups = useMemo(() => new ZoneGroups(), []);
  const visible = (value: number) => level === 'all' || value === level;
  const routeSegments = path.slice(1).map((node, index) => [path[index], node] as const).filter(([from, to]) => visible(from.level) && visible(to.level));
  const groundLevel = level === 'all' ? Math.min(0, ...model.floors.map(floor => floor.level)) : level;
  const walkerZone = walker && model.transforms.get(walker.zoneId);
  return <ZoneGroupsContext.Provider value={groups}>
    <ambientLight intensity={1.2} />
    <directionalLight position={[8, 22, 12]} intensity={2.2} />
    <color attach="background" args={[SCENE.background]} />
    <fog attach="fog" args={[SCENE.background, 90, 260]} />
    <hemisphereLight args={['#bcd7ff', '#0b1219', .9]} />
    <gridHelper args={[200, 200, SCENE.gridMajor, SCENE.gridMinor]} position={[0, groundLevel * FLOOR_GAP - .15, 0]} />
    {model.zones.map(zone => <ZoneLayer key={zone.id} {...props} zone={zone} active={!editing || zone.id === editZoneId} />)}
    {editing && !walking && props.arrange && <ZoneArranger model={model} options={props.arrange} onStatus={onArrangeStatus} />}
    {editing && !walking && props.waypointEdit && <WaypointDragger model={model} options={props.waypointEdit} onSelect={props.onSelect} onStatus={onArrangeStatus} />}
    {editing && !walking && props.connectFrom && model.byKey.has(props.connectFrom) && <ConnectPreview from={model.byKey.get(props.connectFrom)!.world} />}
    {model.links.map((link, index) => {
      const from = model.byKey.get(link.from), to = model.byKey.get(link.to);
      if (!from || !to || !visible(from.level) || !visible(to.level)) return null;
      return <Line key={'zone-link-' + index} points={[from.world, to.world]} color={link.check.status === 'blocked' ? SCENE.edgeBad : link.kind === 'continuation' ? '#2fd1b8' : '#a37bff'} lineWidth={3} dashed dashSize={.28} gapSize={.2} transparent opacity={.9} />;
    })}
    {editing && <SeamLines model={model} level={level} />}
    {editing && !walking && !transforming && props.joinHints && <JoinHints hints={props.joinHints} onJoin={props.onJoinHint} />}
    {routeSegments.map(([from, to], index) => from.level === to.level
      ? <Line key={'route-' + index} points={[[from.world[0], from.world[1] + .18, from.world[2]], [to.world[0], to.world[1] + .18, to.world[2]]]} color={SCENE.route} lineWidth={6} />
      : <Line key={'route-' + index} points={[from.world, to.world]} color="#a37bff" lineWidth={4} dashed dashSize={.35} gapSize={.2} />)}
    {path.slice(0, step + 1).filter(node => visible(node.level)).map(node => <mesh key={'breadcrumb-' + node.key} position={[node.world[0], node.world[1] + .24, node.world[2]]}>
      <sphereGeometry args={[.14, 12, 12]} />
      <meshBasicMaterial color={SCENE.route} />
    </mesh>)}
    {walker && walkerZone && !walking && visible(model.levelOf(walker.zoneId, walker.floorId)) && <WalkerMarker position={toWorld(walkerZone, walker.position)} />}
  </ZoneGroupsContext.Provider>;
}

type ArrangeSession = {
  zoneId: string;
  name: string;
  /** `level` comes from the gizmo's Y arrow and moves the zone between floor levels. */
  mode: 'move' | 'rotate' | 'level';
  handle?: GizmoHandle;
  level: number;
  levelShift: number;
  startHeight: number | null;
  startScreenY: number;
  /** Confirm when the mouse button is released (a drag), instead of on the next click (G / R). */
  confirmOnRelease: boolean;
  /** Drags only start moving after the pointer travels a few pixels, so a plain click never nudges a zone. */
  armed: boolean;
  downAt: { x: number; y: number } | null;
  /** Where the zone was before this G / R / drag, restored on cancel. */
  origin: Placement;
  start: Placement;
  current: Placement;
  y: number;
  planeY: number;
  center: P2;
  startPoint: P2;
  lastAngle: number;
  turned: number;
  localSegments: Segment[];
  movingAngle?: number;
  targets: { segment: Segment; zone: string }[];
  targetAngles: number[];
  axis: 'x' | 'z' | null;
  typed: string;
  moved: boolean;
};
const SNAP_PIXELS = 14;
const typingInField = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * Blender-style arranging of zones on one floor. Drag a floor to move its zone, or press G (move) /
 * R (rotate) and move the pointer; X / Z lock an axis, typed numbers set exact meters or degrees,
 * Enter or click confirms, Esc or right-click cancels, and holding Ctrl flips snapping.
 */
function ZoneArranger({ model, options, onStatus }: { model: BuildingModel; options: ArrangeOptions; onStatus: (status: ArrangeStatus | null) => void }) {
  const { camera, gl, raycaster, scene } = useThree();
  const groups = useContext(ZoneGroupsContext);
  const latest = useRef({ model, options, onStatus });
  latest.current = { model, options, onStatus };
  const [guides, setGuides] = useState<{ y: number; segments: Segment[]; point?: P2 } | null>(null);
  const gizmo = useRef<Group>(null);
  const [hovered, setHovered] = useState<GizmoHandle | null>(null);
  const [active, setActive] = useState<GizmoHandle | 'free' | null>(null);
  const zone = model.zones.find(item => item.id === options.zoneId);
  const center = useMemo(() => zone ? zoneCenter(zone) : [0, 0] as P2, [zone]);
  const elevation = zone ? (zone.graph.floors.find(item => item.id === zone.floorId) || zone.graph.floors[0])?.elevation || 0 : 0;
  const locate = useCallback((target: Vector3) => {
    const group = groups.groups.get(options.zoneId);
    if (!group || !options.gizmo) return false;
    target.set(center[0], elevation + .05, center[1]).applyEuler(group.rotation).add(group.position);
    return true;
  }, [groups, options.zoneId, options.gizmo, center, elevation]);

  useEffect(() => {
    let session: ArrangeSession | null = null;
    let hover: GizmoHandle | null = null;
    let pointer: { x: number; y: number } | null = null;
    let ctrl = false;
    let swallowClick = false;
    const canvas = gl.domElement;
    const plane = new Plane(new Vector3(0, 1, 0), 0);

    const ndc = (clientX: number, clientY: number) => {
      const bounds = canvas.getBoundingClientRect();
      return new Vector2(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1);
    };
    const onPlane = (clientX: number, clientY: number, y: number): P2 | null => {
      raycaster.setFromCamera(ndc(clientX, clientY), camera);
      plane.constant = -y;
      const hit = raycaster.ray.intersectPlane(plane, new Vector3());
      return hit ? [hit.x, hit.z] : null;
    };
    const overCanvas = (x: number, y: number) => {
      const bounds = canvas.getBoundingClientRect();
      return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    };
    const pivotWorld = (s: ArrangeSession, placement: Placement): P2 => {
      const point = toWorld(placement, [s.center[0], 0, s.center[1]]);
      return [point[0], point[2]];
    };
    /** Snap reach: a fixed number of screen pixels, in meters at the zone's depth. */
    const tolerance = (s: ArrangeSession) => {
      const pivot = pivotWorld(s, s.current);
      const distance = camera.position.distanceTo(new Vector3(pivot[0], s.planeY, pivot[1]));
      const fov = (camera as PerspectiveCamera).fov ?? 42;
      const metersPerPixel = 2 * distance * Math.tan(fov * Math.PI / 360) / Math.max(1, canvas.clientHeight);
      return Math.min(1.5, Math.max(.03, metersPerPixel * SNAP_PIXELS));
    };
    const apply = (s: ArrangeSession, placement: Placement) => {
      const group = groups.groups.get(s.zoneId);
      if (!group) return;
      group.position.set(placement.x, s.y, placement.z);
      group.rotation.set(0, placement.rotationDegrees * Math.PI / 180, 0);
    };
    const typedValue = (s: ArrangeSession) => {
      const value = Number.parseFloat(s.typed);
      return Number.isFinite(value) ? value : undefined;
    };

    const update = () => {
      const s = session;
      if (!s?.armed) return;
      const snapping = latest.current.options.snapping !== ctrl;
      const typed = typedValue(s);
      if (s.mode === 'level') {
        let shift = 0;
        if (typed !== undefined) shift = Math.round(typed) - s.level;
        else if (pointer) {
          const pivot = pivotWorld(s, s.start);
          const height = s.startHeight === null ? null : heightUnderPointer(raycaster, camera, ndc(pointer.x, pointer.y), new Vector3(pivot[0], s.planeY, pivot[1]));
          shift = height === null ? Math.round((s.startScreenY - pointer.y) / 90) : Math.round((height - s.startHeight!) / FLOOR_GAP);
        }
        s.levelShift = shift;
        s.moved = shift !== 0;
        apply(s, s.start);
        const group = groups.groups.get(s.zoneId);
        if (group) group.position.y = s.y + shift * FLOOR_GAP;
        const target = s.level + shift;
        const floor = latest.current.model.floors.find(item => item.level === target);
        latest.current.onStatus({
          title: 'Moving ' + s.name + ' to another floor',
          detail: (floor?.name || 'New floor') + ' · level ' + target + (shift ? ' (' + (shift > 0 ? '+' : '') + shift + ')' : ''),
          snap: 'Whole floors',
          hint: 'Drag up or down · type a level number · release or Enter to confirm · Esc to cancel',
        });
        return;
      }
      const point = pointer ? onPlane(pointer.x, pointer.y, s.planeY) : null;
      let snapLabel: string | undefined;
      let guide: { y: number; segments: Segment[]; point?: P2 } | null = null;
      let next: Placement;
      if (s.mode === 'move') {
        let delta: P2 = point ? [point[0] - s.startPoint[0], point[1] - s.startPoint[1]] : [0, 0];
        if (typed !== undefined) delta = s.axis === 'z' ? [0, typed] : [typed, 0];
        else if (s.axis === 'x') delta = [delta[0], 0];
        else if (s.axis === 'z') delta = [0, delta[1]];
        next = { ...s.start, x: s.start.x + delta[0], z: s.start.z + delta[1] };
        if (snapping && typed === undefined && s.targets.length) {
          const snap = snapTranslation(placeSegments(s.localSegments, next), s.targets.map(item => item.segment), tolerance(s));
          if (snap) {
            const shift: P2 = s.axis === 'x' ? [snap.delta[0], 0] : s.axis === 'z' ? [0, snap.delta[1]] : snap.delta;
            next = { ...next, x: next.x + shift[0], z: next.z + shift[1] };
            const zone = s.targets[snap.targets[0]]?.zone;
            snapLabel = (snap.kind === 'corner' ? 'Corner to corner' : snap.kind === 'walls' ? 'Into the corner' : snap.kind === 'wall-end' ? 'Flush with wall end' : 'Flush with wall') + (zone ? ' of ' + zone : '');
            guide = { y: s.planeY, segments: snap.targets.map(index => s.targets[index].segment), point: snap.point };
          }
        }
      } else {
        if (point) {
          const pivot = pivotWorld(s, s.start);
          const angle = Math.atan2(-(point[1] - pivot[1]), point[0] - pivot[0]) * 180 / Math.PI;
          let step = angle - s.lastAngle;
          step = ((step % 360) + 540) % 360 - 180;
          s.turned += step;
          s.lastAngle = angle;
        }
        let rotation = s.start.rotationDegrees + (typed ?? s.turned);
        if (snapping && typed === undefined) {
          const snap = snapRotation(rotation, s.movingAngle, s.targetAngles);
          rotation = snap.rotationDegrees;
          if (snap.kind) snapLabel = snap.kind === 'walls' ? 'Walls parallel to the neighbors' : '15° step';
        }
        next = rotateAbout(s.start, s.center, rotation - s.start.rotationDegrees);
        if (snapping && typed === undefined && s.targets.length) {
          const snap = snapTranslation(placeSegments(s.localSegments, next), s.targets.map(item => item.segment), tolerance(s) * .5);
          if (snap && (snap.kind === 'corner' || snap.kind === 'walls')) guide = { y: s.planeY, segments: snap.targets.map(index => s.targets[index].segment), point: snap.point };
        }
      }
      s.current = next;
      s.moved = Math.abs(next.x - s.origin.x) > 1e-4 || Math.abs(next.z - s.origin.z) > 1e-4 || Math.abs(normalizeDegrees(next.rotationDegrees - s.origin.rotationDegrees)) > 1e-4;
      apply(s, next);
      setGuides(guide);
      const axis = s.axis ? ' along ' + s.axis.toUpperCase() : '';
      const typing = s.typed ? ' · typed ' + s.typed + (s.mode === 'move' ? ' m' : '°') : '';
      latest.current.onStatus({
        title: (s.mode === 'move' ? 'Moving ' : 'Rotating ') + s.name + axis,
        detail: (s.mode === 'move'
          ? 'ΔX ' + (next.x - s.start.x).toFixed(2) + ' m · ΔZ ' + (next.z - s.start.z).toFixed(2) + ' m'
          : normalizeDegrees(next.rotationDegrees - s.start.rotationDegrees).toFixed(1) + '° (now ' + normalizeDegrees(next.rotationDegrees).toFixed(1) + '°)') + typing,
        snap: snapLabel ?? (snapping ? undefined : 'Snapping off'),
        hint: TRANSFORM_HINT,
      });
    };

    const begin = (mode: ArrangeSession['mode'], zoneId: string, at: { x: number; y: number } | null, confirmOnRelease: boolean, keep?: ArrangeSession, handle?: GizmoHandle) => {
      const { model } = latest.current;
      const zone = model.zones.find(item => item.id === zoneId);
      const t = model.transforms.get(zoneId);
      const entry = model.layout.find(item => item.zoneId === zoneId);
      if (!zone || !t || !entry) return;
      const floor = zone.graph.floors.find(item => item.id === zone.floorId) || zone.graph.floors[0];
      const start: Placement = keep?.current ?? { x: t.x, z: t.z, rotationDegrees: t.rotationDegrees };
      const center = zoneCenter(zone);
      const planeY = t.y + (floor?.elevation || 0);
      const neighbors = model.zones.filter(item => item.id !== zoneId && model.layout.find(layout => layout.zoneId === item.id)?.floor === entry.floor);
      const targets = neighbors.flatMap(item => placeSegments(zoneSegments(item), model.transforms.get(item.id)!).map(segment => ({ segment, zone: item.name })));
      const targetAngles = neighbors.map(item => dominantAngle(placeSegments(zoneSegments(item), model.transforms.get(item.id)!))).filter((angle): angle is number => angle !== undefined);
      const localSegments = zoneSegments(zone);
      const pivot = toWorld(start, [center[0], 0, center[1]]);
      const startPoint = (at && onPlane(at.x, at.y, planeY)) || [pivot[0], pivot[2]] as P2;
      const startHeight = mode === 'level' && at ? heightUnderPointer(raycaster, camera, ndc(at.x, at.y), new Vector3(pivot[0], planeY, pivot[2])) : null;
      session = {
        zoneId, name: zone.name, mode, handle, level: entry.floor, levelShift: 0, startHeight, startScreenY: at?.y ?? 0,
        confirmOnRelease, armed: !confirmOnRelease || Boolean(keep), downAt: at, origin: keep?.origin ?? start,
        start, current: start, y: t.y, planeY, center, startPoint,
        lastAngle: Math.atan2(-(startPoint[1] - pivot[2]), startPoint[0] - pivot[0]) * 180 / Math.PI, turned: 0,
        localSegments, movingAngle: dominantAngle(localSegments), targets, targetAngles,
        axis: keep?.axis ?? null, typed: '', moved: keep?.moved ?? false,
      };
      canvas.style.cursor = mode === 'rotate' ? 'alias' : 'grabbing';
      setActive(handle ?? 'free');
      update();
    };

    const finish = (confirm: boolean) => {
      const s = session;
      if (!s) return;
      session = null;
      canvas.style.cursor = hover ? 'grab' : '';
      setGuides(null);
      setActive(null);
      latest.current.onStatus(null);
      if (s.mode === 'level') {
        if (confirm && s.levelShift) latest.current.options.onLevel(s.zoneId, s.level + s.levelShift);
        else apply(s, s.origin);
        return;
      }
      if (confirm && s.moved) latest.current.options.onCommit(s.zoneId, {
        x: Math.round(s.current.x * 1000) / 1000,
        z: Math.round(s.current.z * 1000) / 1000,
        rotationDegrees: normalizeDegrees(s.current.rotationDegrees),
      });
      else apply(s, s.origin);
    };

    const pointerDown = (event: PointerEvent) => {
      swallowClick = false;
      if (event.target !== canvas) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (session) {
        event.stopPropagation(); event.preventDefault();
        swallowClick = true;
        if (event.button === 2) finish(false);
        else if (event.button === 0 && !session.confirmOnRelease) finish(true);
        return;
      }
      if (event.button !== 0) return;
      raycaster.setFromCamera(ndc(event.clientX, event.clientY), camera);
      const handle = gizmoHit(raycaster, gizmo.current);
      if (handle) {
        event.stopImmediatePropagation(); event.preventDefault();
        swallowClick = true;
        begin(handle === 'rotate' ? 'rotate' : handle === 'y' ? 'level' : 'move', latest.current.options.zoneId, pointer, true, undefined, handle);
        const started = session as ArrangeSession | null;
        if (started && (handle === 'x' || handle === 'z')) { started.axis = handle; update(); }
        return;
      }
      if (!latest.current.options.dragFloors) return;
      const hits = raycaster.intersectObjects(scene.children, true);
      if (hits[0]?.object.userData.nodeKey) return;
      const hit = hits.find(item => item.object.userData.walkableFloor === true && typeof item.object.userData.zoneId === 'string');
      if (!hit) return;
      const zoneId = hit.object.userData.zoneId as string;
      const { options } = latest.current;
      if (zoneId !== options.zoneId && !options.onSelect(zoneId)) return;
      event.stopPropagation(); event.preventDefault();
      swallowClick = true;
      begin('move', zoneId, pointer, true);
    };
    const pointerMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      ctrl = event.ctrlKey;
      if (session && !session.armed && session.downAt && Math.hypot(event.clientX - session.downAt.x, event.clientY - session.downAt.y) > 4) session.armed = true;
      if (session) { update(); return; }
      if (event.buttons || event.target !== canvas) return;
      raycaster.setFromCamera(ndc(event.clientX, event.clientY), camera);
      const next = gizmoHit(raycaster, gizmo.current);
      if (next === hover) return;
      hover = next;
      setHovered(next);
      canvas.style.cursor = next ? 'grab' : '';
    };
    const pointerUp = (event: PointerEvent) => {
      if (session?.confirmOnRelease && event.button === 0) finish(true);
    };
    const click = (event: MouseEvent) => {
      if (!swallowClick || event.target !== canvas) return;
      swallowClick = false;
      event.stopPropagation(); event.preventDefault();
    };
    const contextMenu = (event: MouseEvent) => {
      if (event.target === canvas && (session || swallowClick)) { event.preventDefault(); swallowClick = false; }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (typingInField(event.target)) return;
      if (event.key === 'Control') { ctrl = true; update(); return; }
      const key = event.key.toLowerCase();
      if (!session) {
        if (event.ctrlKey || event.metaKey || event.altKey || (key !== 'g' && key !== 'r')) return;
        if (!pointer || !overCanvas(pointer.x, pointer.y)) return;
        event.preventDefault();
        begin(key === 'g' ? 'move' : 'rotate', latest.current.options.zoneId, pointer, false);
        return;
      }
      const s = session;
      let handled = true;
      if (key === 'escape') finish(false);
      else if (key === 'enter') finish(true);
      else if ((key === 'g' && s.mode !== 'move') || (key === 'r' && s.mode !== 'rotate')) begin(key === 'g' ? 'move' : 'rotate', s.zoneId, pointer, s.confirmOnRelease, s);
      else if (key === 'x' && s.mode === 'move') { s.axis = s.axis === 'x' ? null : 'x'; update(); }
      else if ((key === 'z' || key === 'y') && s.mode === 'move') { s.axis = s.axis === 'z' ? null : 'z'; update(); }
      else if (/^[0-9]$/.test(key) || (key === '.' && !s.typed.includes('.'))) { s.typed += key; update(); }
      else if (key === '-') { s.typed = s.typed.startsWith('-') ? s.typed.slice(1) : '-' + s.typed; update(); }
      else if (key === 'backspace') { s.typed = s.typed.slice(0, -1); update(); }
      else handled = false;
      if (handled) { event.preventDefault(); event.stopPropagation(); }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') { ctrl = false; update(); }
    };
    const blur = () => finish(false);

    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('click', click, true);
    window.addEventListener('contextmenu', contextMenu, true);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      finish(false);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('click', click, true);
      window.removeEventListener('contextmenu', contextMenu, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, [camera, gl, groups, raycaster, scene]);

  const lift = (guides?.y ?? 0) + .07;
  return <>
    <TransformGizmo groupRef={gizmo} locate={locate} owner="zone" handles={['x', 'y', 'z', 'xz', 'rotate']} hovered={hovered} active={active} />
    {guides?.segments.map((segment, index) => <Line key={index} points={[[segment[0][0], lift, segment[0][1]], [segment[1][0], lift, segment[1][1]]]} color="#f59e0b" lineWidth={5} />)}
    {guides?.point && <mesh position={[guides.point[0], lift, guides.point[1]]}>
      <sphereGeometry args={[.16, 16, 16]} />
      <meshBasicMaterial color="#f59e0b" />
    </mesh>}
  </>;
}

export type GizmoHandle = 'x' | 'y' | 'z' | 'xz' | 'rotate';
type GizmoOwner = 'zone' | 'waypoint';
const AXIS_COLOR = { x: '#ff3b5c', y: '#8fd400', z: '#2f8bff' } as const;
const GIZMO_HOT = '#ffd84a';
/** Screen-constant gizmo size, as a fraction of the camera distance. */
const GIZMO_SCALE = .075;

function GizmoMaterial({ color, opacity = 1 }: { color: string; opacity?: number }) {
  return <meshBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={opacity} toneMapped={false} side={DoubleSide} />;
}

function GizmoArrow({ axis, color, owner }: { axis: 'x' | 'y' | 'z'; color: string; owner: GizmoOwner }) {
  const rotation: Vec3 = axis === 'x' ? [0, 0, -Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  const data = { gizmo: axis, gizmoOwner: owner };
  return <group rotation={rotation}>
    <mesh position={[0, .55, 0]} renderOrder={1000} userData={data}><cylinderGeometry args={[.024, .024, .9, 8]} /><GizmoMaterial color={color} /></mesh>
    <mesh position={[0, 1.1, 0]} renderOrder={1000} userData={data}><coneGeometry args={[.08, .24, 18]} /><GizmoMaterial color={color} /></mesh>
    <mesh position={[0, .65, 0]} userData={data}><cylinderGeometry args={[.13, .13, 1.1, 8]} /><meshBasicMaterial visible={false} /></mesh>
  </group>;
}

/**
 * Blender-style transform gizmo: red X, green Y and blue Z arrows, a plane handle for free moves and a
 * ring for turning. `locate` places it each frame, so it follows objects moved outside React.
 */
function TransformGizmo({ groupRef, locate, handles, hovered, active, owner, yaw = 0 }: {
  groupRef: RefObject<Group | null>; locate: (target: Vector3) => boolean; handles: GizmoHandle[];
  hovered: GizmoHandle | null; active: GizmoHandle | 'free' | null; owner: GizmoOwner; yaw?: number;
}) {
  const { camera } = useThree();
  const at = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    group.visible = locate(at);
    if (!group.visible) return;
    group.position.copy(at);
    group.scale.setScalar(Math.max(.05, camera.position.distanceTo(at) * GIZMO_SCALE));
  });
  const shown = (handle: GizmoHandle) => handles.includes(handle) && (!active || active === handle);
  const tint = (handle: GizmoHandle, base: string) => handle === active || handle === hovered ? GIZMO_HOT : base;
  const data = (handle: GizmoHandle) => ({ gizmo: handle, gizmoOwner: owner });
  return <group ref={groupRef} visible={false}>
    <group rotation={[0, yaw * Math.PI / 180, 0]}>
      {(['x', 'y', 'z'] as const).filter(shown).map(axis => <GizmoArrow key={axis} axis={axis} owner={owner} color={tint(axis, AXIS_COLOR[axis])} />)}
      {shown('xz') && <>
        <mesh position={[.32, 0, .32]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1000} userData={data('xz')}><planeGeometry args={[.26, .26]} /><GizmoMaterial color={tint('xz', AXIS_COLOR.y)} opacity={.55} /></mesh>
        <mesh renderOrder={1001} userData={data('xz')}><sphereGeometry args={[.07, 14, 14]} /><GizmoMaterial color={tint('xz', '#ffffff')} /></mesh>
      </>}
    </group>
    {shown('rotate') && <group rotation={[Math.PI / 2, 0, 0]}>
      <mesh renderOrder={1000} userData={data('rotate')}><torusGeometry args={[1.45, .02, 8, 72]} /><GizmoMaterial color={tint('rotate', AXIS_COLOR.y)} opacity={.9} /></mesh>
      <mesh userData={data('rotate')}><torusGeometry args={[1.45, .11, 6, 48]} /><meshBasicMaterial visible={false} /></mesh>
    </group>}
  </group>;
}

/** The first gizmo handle under the pointer, if the gizmo is showing. */
function gizmoHit(raycaster: Raycaster, group: Group | null): GizmoHandle | null {
  if (!group?.visible) return null;
  const hit = raycaster.intersectObject(group, true).find(item => item.object.userData.gizmo);
  return (hit?.object.userData.gizmo as GizmoHandle | undefined) ?? null;
}

/** World height under the pointer on a vertical plane through `pivot` that faces the camera; null when looking straight down. */
function heightUnderPointer(raycaster: Raycaster, camera: Camera, pointer: Vector2, pivot: Vector3): number | null {
  const direction = new Vector3();
  camera.getWorldDirection(direction);
  if (Math.abs(direction.y) > .93) return null;
  direction.y = 0;
  const plane = new Plane().setFromNormalAndCoplanarPoint(direction.normalize(), pivot);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.ray.intersectPlane(plane, new Vector3());
  return hit ? hit.y : null;
}

function ArrangeHud({ connect }: { connect: (show: (status: ArrangeStatus | null) => void) => void }) {
  const [status, setStatus] = useState<ArrangeStatus | null>(null);
  useEffect(() => { connect(setStatus); return () => connect(() => {}); }, [connect]);
  if (!status) return null;
  return <div className="arrange-hud" role="status">
    <strong>{status.title}</strong>
    <span>{status.detail}</span>
    {status.snap && <span className="arrange-snap">{status.snap}</span>}
    {status.hint && <small>{status.hint}</small>}
  </div>;
}

type WaypointDrag = {
  key: string; nodeId: string; label: string; transform: ZoneTransform; floorId: string;
  local: Vec3; start: { x: number; y: number }; armed: boolean; planeY: number;
  peers: Vec3[]; neighbors: Vec3[];
  /** Where the waypoint started and where the pointer grabbed it, both in the zone frame. */
  origin: Vec3; grab: Vec3 | null;
  /** A gizmo arrow locks the drag to one zone axis; `y` changes the height. */
  axis: 'x' | 'y' | 'z' | null; handle: GizmoHandle | null; startHeight: number | null;
};
type DragGhost = { world: Vec3; neighbors: Vec3[]; guides: [Vec3, Vec3][] };

/**
 * Drags waypoints of the zone being edited across their floor. Snaps the waypoint into line with
 * other waypoints (in the zone's own axes) so hallways come out straight; Ctrl flips snapping.
 */
function WaypointDragger({ model, options, onSelect, onStatus }: { model: BuildingModel; options: WaypointEditOptions; onSelect: (key: string) => void; onStatus: (status: ArrangeStatus | null) => void }) {
  const { camera, gl, raycaster, scene } = useThree();
  const latest = useRef({ model, options, onSelect, onStatus });
  latest.current = { model, options, onSelect, onStatus };
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const ghostRef = useRef<DragGhost | null>(null);
  ghostRef.current = ghost;
  const gizmo = useRef<Group>(null);
  const [hovered, setHovered] = useState<GizmoHandle | null>(null);
  const [active, setActive] = useState<GizmoHandle | 'free' | null>(null);
  const selected = options.selectedKey ? model.byKey.get(options.selectedKey) : undefined;
  const gizmoNode = selected?.zoneId === options.zoneId ? selected : undefined;
  const yaw = model.transforms.get(options.zoneId)?.rotationDegrees ?? 0;
  const locate = useCallback((target: Vector3) => {
    const world = ghostRef.current?.world ?? gizmoNode?.world;
    if (!world) return false;
    target.set(world[0], world[1] + .05, world[2]);
    return true;
  }, [gizmoNode]);
  useEffect(() => {
    const canvas = gl.domElement;
    const plane = new Plane(new Vector3(0, 1, 0), 0);
    let drag: WaypointDrag | null = null;
    let hover: GizmoHandle | null = null;
    let ctrl = false;
    let swallowClick = false;
    let last: { x: number; y: number } | null = null;
    const ndc = (x: number, y: number) => {
      const bounds = canvas.getBoundingClientRect();
      return new Vector2(((x - bounds.left) / bounds.width) * 2 - 1, -((y - bounds.top) / bounds.height) * 2 + 1);
    };
    const tolerance = (world: Vec3) => {
      const distance = camera.position.distanceTo(new Vector3(...world));
      const fov = (camera as PerspectiveCamera).fov ?? 42;
      return Math.min(.6, Math.max(.04, 2 * distance * Math.tan(fov * Math.PI / 360) / Math.max(1, canvas.clientHeight) * 10));
    };
    const finish = (commit: boolean) => {
      const current = drag;
      drag = null;
      setGhost(null);
      setActive(null);
      latest.current.onStatus(null);
      canvas.style.cursor = hover ? 'grab' : '';
      if (current && commit && current.armed) latest.current.options.onMove(current.key, current.local);
    };
    const update = () => {
      const d = drag;
      if (!d?.armed || !last) return;
      const snapping = latest.current.options.snapping !== ctrl;
      const guides: [Vec3, Vec3][] = [];
      let snapped: string | undefined;
      let local: Vec3;
      if (d.axis === 'y') {
        const height = d.startHeight === null ? null : heightUnderPointer(raycaster, camera, ndc(last.x, last.y), new Vector3(...toWorld(d.transform, d.origin)));
        const rise = height === null ? (d.start.y - last.y) * .01 : height - d.startHeight!;
        local = [d.origin[0], d.origin[1] + rise, d.origin[2]];
        if (snapping) { local[1] = Math.round(local[1] * 20) / 20; snapped = '5 cm steps'; }
      } else {
        raycaster.setFromCamera(ndc(last.x, last.y), camera);
        plane.constant = -d.planeY;
        const hit = raycaster.ray.intersectPlane(plane, new Vector3());
        if (!hit) return;
        const free = toLocal(d.transform, [hit.x, hit.y, hit.z]);
        d.grab ??= free;
        local = [d.origin[0] + (d.axis === 'z' ? 0 : free[0] - d.grab[0]), d.origin[1], d.origin[2] + (d.axis === 'x' ? 0 : free[2] - d.grab[2])];
        if (snapping) {
          const reach = tolerance([hit.x, hit.y, hit.z]);
          const alignX = d.axis === 'z' ? undefined : d.peers.filter(peer => Math.abs(peer[0] - local[0]) < reach).sort((a, b) => Math.abs(a[0] - local[0]) - Math.abs(b[0] - local[0]))[0];
          const alignZ = d.axis === 'x' ? undefined : d.peers.filter(peer => Math.abs(peer[2] - local[2]) < reach).sort((a, b) => Math.abs(a[2] - local[2]) - Math.abs(b[2] - local[2]))[0];
          if (alignX) { local[0] = alignX[0]; guides.push([alignX, local]); }
          if (alignZ) { local[2] = alignZ[2]; guides.push([alignZ, local]); }
          if (!alignX && d.axis !== 'z') local[0] = Math.round(local[0] * 20) / 20;
          if (!alignZ && d.axis !== 'x') local[2] = Math.round(local[2] * 20) / 20;
          snapped = alignX && alignZ ? 'Aligned on both axes' : alignX || alignZ ? 'Aligned with a waypoint' : '5 cm grid';
        }
      }
      d.local = local;
      const world = toWorld(d.transform, local);
      setGhost({ world, neighbors: d.neighbors.map(point => toWorld(d.transform, point)), guides: guides.map(([a, b]) => [toWorld(d.transform, a), toWorld(d.transform, [...b] as Vec3)]) });
      const along = d.axis === 'y' ? ' up / down' : d.axis ? ' along ' + d.axis.toUpperCase() : '';
      latest.current.onStatus({
        title: 'Moving ' + d.label + along,
        detail: d.axis === 'y' ? 'Y ' + local[1].toFixed(2) + ' m' : 'X ' + local[0].toFixed(2) + ' m · Z ' + local[2].toFixed(2) + ' m',
        snap: snapped ?? 'Snapping off', hint: 'Release to place · Esc to cancel · hold Ctrl to flip snapping',
      });
    };
    const pointerDown = (event: PointerEvent) => {
      swallowClick = false;
      if (event.target !== canvas || event.button !== 0) return;
      raycaster.setFromCamera(ndc(event.clientX, event.clientY), camera);
      const { model, options } = latest.current;
      const handle = gizmoHit(raycaster, gizmo.current);
      const hits = handle ? [] : raycaster.intersectObjects(scene.children, true);
      if (hits.some(item => item.object.userData.gizmoOwner === 'zone')) return;
      const hit = hits.find(item => item.object.userData.nodeKey && item.object.userData.zoneId === options.zoneId);
      const key = handle ? options.selectedKey : hit?.object.userData.nodeKey as string | undefined;
      if (!key) return;
      const node = model.byKey.get(key);
      const zone = model.zones.find(item => item.id === options.zoneId);
      const transform = model.transforms.get(options.zoneId);
      const source = zone?.graph.nodes.find(item => item.id === node?.localId);
      if (!node || !zone || !transform || !source) return;
      event.stopPropagation(); event.preventDefault();
      swallowClick = true;
      const linked = new Set(zone.graph.edges.flatMap(edge => edge.from === source.id ? [edge.to] : edge.to === source.id ? [edge.from] : []));
      const axis = handle === 'x' || handle === 'y' || handle === 'z' ? handle : null;
      drag = {
        key, nodeId: source.id, label: source.label || source.id, transform, floorId: source.floor, local: [...source.position] as Vec3,
        start: { x: event.clientX, y: event.clientY }, armed: false, planeY: node.world[1],
        peers: zone.graph.nodes.filter(item => item.id !== source.id && item.floor === source.floor).map(item => item.position),
        neighbors: zone.graph.nodes.filter(item => linked.has(item.id)).map(item => item.position),
        origin: [...source.position] as Vec3, grab: null, axis, handle,
        startHeight: axis === 'y' ? heightUnderPointer(raycaster, camera, ndc(event.clientX, event.clientY), new Vector3(...node.world)) : null,
      };
      last = { x: event.clientX, y: event.clientY };
      if (handle) setActive(handle);
      else {
        plane.constant = -node.world[1];
        const grabbed = raycaster.ray.intersectPlane(plane, new Vector3());
        if (grabbed) drag.grab = toLocal(transform, [grabbed.x, grabbed.y, grabbed.z]);
      }
    };
    const pointerMove = (event: PointerEvent) => {
      ctrl = event.ctrlKey;
      last = { x: event.clientX, y: event.clientY };
      if (!drag) {
        if (event.buttons || event.target !== canvas) return;
        raycaster.setFromCamera(ndc(event.clientX, event.clientY), camera);
        const next = gizmoHit(raycaster, gizmo.current);
        if (next === hover) return;
        hover = next;
        setHovered(next);
        canvas.style.cursor = next ? 'grab' : '';
        return;
      }
      if (!drag.armed && Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) > 4) {
        drag.armed = true;
        canvas.style.cursor = 'grabbing';
        if (!drag.handle) setActive('free');
      }
      update();
    };
    const pointerUp = (event: PointerEvent) => {
      if (!drag || event.button !== 0) return;
      const key = drag.key, armed = drag.armed;
      finish(true);
      if (!armed) latest.current.onSelect(key);
    };
    const click = (event: MouseEvent) => {
      if (!swallowClick || event.target !== canvas) return;
      swallowClick = false;
      event.stopPropagation(); event.preventDefault();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!drag) return;
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      else if (event.key === 'Control') { ctrl = true; update(); }
    };
    const keyUp = (event: KeyboardEvent) => { if (event.key === 'Control' && drag) { ctrl = false; update(); } };
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('click', click, true);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp);
    return () => {
      finish(false);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('click', click, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp);
    };
  }, [camera, gl, raycaster, scene]);
  const gizmoView = gizmoNode && <TransformGizmo groupRef={gizmo} locate={locate} owner="waypoint" handles={['x', 'y', 'z', 'xz']} hovered={hovered} active={active} yaw={yaw} />;
  if (!ghost) return gizmoView || null;
  const lift = (point: Vec3, by = .06): Vec3 => [point[0], point[1] + by, point[2]];
  return <>
    {gizmoView}
    <mesh position={lift(ghost.world, .35)}>
      <cylinderGeometry args={[.19, .19, .7, 20]} />
      <meshBasicMaterial color={SCENE.accent} transparent opacity={.75} toneMapped={false} />
    </mesh>
    {ghost.neighbors.map((point, index) => <Line key={'n' + index} points={[lift(ghost.world), lift(point)]} color={SCENE.accent} lineWidth={2} dashed dashSize={.2} gapSize={.12} />)}
    {ghost.guides.map(([a, b], index) => <Line key={'g' + index} points={[lift(a, .04), lift(b, .04)]} color={SCENE.snap} lineWidth={1.5} dashed dashSize={.12} gapSize={.1} />)}
  </>;
}

/** A dashed line from the waypoint a connection starts at to wherever the pointer is. */
function ConnectPreview({ from }: { from: Vec3 }) {
  const { camera, gl, raycaster } = useThree();
  const [to, setTo] = useState<Vec3 | null>(null);
  useEffect(() => {
    const canvas = gl.domElement;
    const plane = new Plane(new Vector3(0, 1, 0), -from[1]);
    const move = (event: PointerEvent) => {
      if (event.target !== canvas) { setTo(null); return; }
      const bounds = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new Vector2(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1), camera);
      const hit = raycaster.ray.intersectPlane(plane, new Vector3());
      setTo(hit ? [hit.x, hit.y, hit.z] : null);
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [camera, gl, raycaster, from[0], from[1], from[2]]);
  if (!to) return null;
  return <Line points={[[from[0], from[1] + .08, from[2]], [to[0], to[1] + .08, to[2]]]} color={SCENE.accent} lineWidth={2.5} dashed dashSize={.25} gapSize={.15} />;
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
  const showStatus = useRef<(status: ArrangeStatus | null) => void>(() => {});
  const connect = useCallback((show: (status: ArrangeStatus | null) => void) => { showStatus.current = show; }, []);
  const onArrangeStatus = useCallback((status: ArrangeStatus | null) => showStatus.current(status), []);
  return <>
  {props.editing && <ArrangeHud connect={connect} />}
  <Canvas camera={{ position: [24, 23, 27], fov: 42 }} gl={{ antialias: true }}>
    <Scene {...props} onArrangeStatus={onArrangeStatus} />
    <DropController request={props.dropRequest} onDrop={props.onWalkerDrop} model={props.model} />
    {props.walking && props.walker && props.model.transforms.has(props.walker.zoneId)
      ? <WalkCamera location={props.walker} model={props.model} onMove={props.onWalkerMove} onElevator={props.onWalkerElevator} />
      : <CameraRig model={props.model} level={props.level} reset={props.reset} cameraView={props.cameraView} />}
  </Canvas>
  </>;
}

