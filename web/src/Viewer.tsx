import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, Text } from '@react-three/drei';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { Box3, BoxGeometry, Color, DoubleSide, FrontSide, Matrix4, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Shape, ShapeGeometry, SRGBColorSpace, TextureLoader, Vector2, Vector3, type Material, type Texture } from 'three';
import type { Graph, Node, ScanFeature, ScanFeatures, SurfaceColorFace, SurfaceColors, ZoneConnections, ZoneView } from './data';
import { stackBuilding, stackPoint, type StackZone } from './buildingStack.ts';
import { canWalkBetween, checkEdge } from './geometry';

export type WalkLocation = { position: [number, number, number]; floorId: string; zoneId?: string };
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
  onFloorPick?: (position: [number, number, number], floorId: string, zoneId?: string) => void;
  walker?: WalkLocation | null;
  walking?: boolean;
  dropRequest?: DropRequest | null;
  onWalkerDrop?: (location: WalkLocation | null) => void;
  onWalkerMove?: (location: WalkLocation) => void;
  zones?: ZoneView[];
  zoneConnections?: ZoneConnections;
  zoneId?: string;
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

function ScannedFloor({ feature, floorId, zoneId, offset=[0,0,0], onPick }: { feature: ScanFeature; floorId: string; zoneId?: string; offset?:[number,number,number]; onPick?: (position: [number, number, number]) => void }) {
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
    if (onPick) { event.stopPropagation(); onPick([event.point.x-offset[0],event.point.y-offset[1],event.point.z-offset[2]]); }
  };
  const userData={walkableFloor:true,floorId,zoneId,stackOffset:offset};
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

function ScannedGeometry({ scan, graph, floor, zoneId, offset, onFloorPick }: { scan: ScanFeatures; graph: Graph; floor: string; zoneId?:string; offset?:[number,number,number]; onFloorPick?: ViewerProps['onFloorPick'] }) {
  const story = graph.floors.find(item => item.id === floor)?.story;
  const visible = (item: ScanFeature) => floor === 'all' || item.story == null || item.story === story;
  const portals = [...scan.doors, ...scan.openings, ...scan.windows].filter(visible);
  const atlas = useAtlasTexture(scan.colors);
  const real = Boolean(scan.colors);
  const surfaceColors = useMemo(() => ({ colors: scan.colors, atlas }), [scan.colors, atlas]);
  return <SurfaceColorContext.Provider value={surfaceColors}>
    {scan.floors.filter(visible).map(item => {
      const floorId = graph.floors.find(candidate => candidate.story === item.story)?.id || graph.floors[0]?.id;
      return floorId ? <ScannedFloor key={item.identifier} feature={item} floorId={floorId} zoneId={zoneId} offset={offset} onPick={onFloorPick ? position => onFloorPick(position, floorId, zoneId) : undefined} /> : null;
    })}
    {scan.walls.filter(visible).map(item => <Wall key={item.identifier} wall={item} portals={portals.filter(portal => portal.parentIdentifier === item.identifier)} />)}
    {scan.windows.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color="#8fbfce" opacity={real ? .6 : .32} />)}
    {scan.doors.filter(visible).filter(item => item.category === 'door-closed').map(item =>
      <FeatureBox key={item.identifier} feature={item} color="#b6d0c2" opacity={real ? .96 : .35} />)}
    {scan.objects.filter(visible).map(item => <FeatureBox key={item.identifier} feature={item} color={item.category === 'stairs' ? '#c9ac7e' : '#c9d2d4'} opacity={real ? .96 : .8} />)}
  </SurfaceColorContext.Provider>;
}

function GraphFloor({ graph, floor, illustrative, zoneId, offset=[0,0,0], onFloorPick }: { graph: Graph; floor: string; illustrative?: boolean; zoneId?:string; offset?:[number,number,number]; onFloorPick?: ViewerProps['onFloorPick'] }) {
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
      <mesh position={[cx, item.elevation - .08, cz]} userData={{ walkableFloor: true, floorId: item.id, zoneId, stackOffset:offset }} onClick={event => { if (onFloorPick) { event.stopPropagation(); onFloorPick([event.point.x-offset[0],event.point.y-offset[1],event.point.z-offset[2]], item.id, zoneId); } }}>
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
  const { camera, size: viewportSize } = useThree();
  const geometryKey=graph.nodes.map(node=>node.floor+':'+node.position.join(',')).join('|');
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
    const span = Math.max(8, size.x, size.z, size.y * 2) * Math.max(1, viewportSize.height / Math.max(1,viewportSize.width));
    camera.position.copy(center).add(new Vector3(span * 1.2, span * .95, span * 1.2));
    camera.lookAt(center);
    controls.current?.target.copy(center);
    controls.current?.update();
  }, [camera, geometryKey, scan, floor, reset, viewportSize.width, viewportSize.height]);
  return <OrbitControls ref={controls as never} enableDamping minDistance={2} maxDistance={200} maxPolarAngle={Math.PI / 2.05} />;
}

function StackCameraRig({ zones, reset }: { zones: StackZone[]; reset:number }) {
  const { camera } = useThree();
  const controls = useRef<{ target: Vector3; update: () => void } | null>(null);
  useEffect(()=>{
    const box=new Box3();
    for(const zone of zones){
      const offset=new Vector3(...zone.offset);
      zone.graph.nodes.forEach(node=>box.expandByPoint(new Vector3(...node.position).add(offset)));
      for(const feature of [...(zone.scan?.floors||[]),...(zone.scan?.walls||[]),...(zone.scan?.objects||[])]){
        const size=new Vector3(...feature.dimensions.map(value=>Math.max(.025,value)));
        box.union(new Box3().setFromCenterAndSize(new Vector3(),size).applyMatrix4(featureMatrix(feature)).translate(offset));
      }
    }
    if(box.isEmpty())box.expandByPoint(new Vector3());
    const center=box.getCenter(new Vector3()),size=box.getSize(new Vector3());
    const span=Math.max(10,size.x,size.z,size.y*1.4);
    camera.position.copy(center).add(new Vector3(span*1.25,span*.9,span*1.25));camera.lookAt(center);
    controls.current?.target.copy(center);controls.current?.update();
  },[camera,zones,reset]);
  return <OrbitControls ref={controls as never} enableDamping minDistance={2} maxDistance={300} maxPolarAngle={Math.PI*.88}/>;
}

function StackScene({ zones, connections, activeZoneId, selected, onSelect, onFloorPick, walker }:{zones:StackZone[];connections?:ZoneConnections;activeZoneId?:string;selected:string;onSelect:(id:string)=>void;onFloorPick?:ViewerProps['onFloorPick'];walker?:WalkLocation|null}){
  const byId=new Map(zones.map(zone=>[zone.id,zone]));
  return <>
    <ambientLight intensity={2}/><directionalLight position={[10,22,14]} intensity={2}/>
    <gridHelper args={[120,120,'#d7dee3','#e8edef']} position={[0,-.15,0]}/>
    {zones.map(zone=><group key={zone.id} position={zone.offset}>
      {zone.scan?<ScannedGeometry scan={zone.scan} graph={zone.graph} floor="all" zoneId={zone.id} offset={zone.offset} onFloorPick={onFloorPick}/>:<GraphFloor graph={zone.graph} floor="all" zoneId={zone.id} offset={zone.offset} onFloorPick={onFloorPick}/>}
      {zone.graph.edges.map((edge,index)=>{const from=zone.graph.nodes.find(node=>node.id===edge.from),to=zone.graph.nodes.find(node=>node.id===edge.to);if(!from||!to)return null;return <Line key={index} points={[from.position,to.position]} color="#8abdb2" lineWidth={1} transparent opacity={.28}/>})}
      {zone.graph.nodes.filter(node=>node.label||['entrance','destination','elevator'].includes(node.type)).map(node=><group key={node.id} position={node.position} onClick={event=>{event.stopPropagation();if(zone.id===activeZoneId)onSelect(node.id)}}>
        <mesh position={[0,.35,0]}><cylinderGeometry args={[node.type==='elevator'?.22:.15,node.type==='elevator'?.22:.15,.7,20]}/><meshStandardMaterial color={node.type==='elevator'?'#8b5cf6':node.id===selected&&zone.id===activeZoneId?'#0b8b81':'#277ad1'}/></mesh>
        {node.type==='elevator'&&<Html position={[0,.95,0]} center distanceFactor={15}><span className="elevator-label">Elevator · {zone.name}</span></Html>}
      </group>)}
      <Html position={[0,.15,0]} center distanceFactor={24}><span className="floor-stack-label">{zone.name}</span></Html>
      {walker&&walker.zoneId===zone.id&&<WalkerMarker location={walker}/>}
    </group>)}
    {(connections?.connections||[]).map((connection,index)=>{const fromZone=byId.get(connection.from.zoneId),toZone=byId.get(connection.to.zoneId);const from=fromZone?.graph.nodes.find(node=>node.id===connection.from.nodeId),to=toZone?.graph.nodes.find(node=>node.id===connection.to.nodeId);if(!fromZone||!toZone||!from||!to)return null;return <Line key={'floor-link-'+index} points={[stackPoint(fromZone,from.position),stackPoint(toZone,to.position)]} color="#8b5cf6" lineWidth={3} dashed dashSize={.28} gapSize={.2} transparent opacity={.9}/>})}
  </>;
}

function DropController({ request, onDrop }: { request?: DropRequest | null; onDrop?: ViewerProps['onWalkerDrop'] }) {
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
      .find(item => item.object.userData.walkableFloor === true && typeof item.object.userData.floorId === 'string');
    const offset=(hit?.object.userData.stackOffset||[0,0,0]) as [number,number,number];
    onDrop(hit ? { position: [hit.point.x-offset[0],hit.point.y-offset[1],hit.point.z-offset[2]], floorId: hit.object.userData.floorId as string, zoneId: hit.object.userData.zoneId as string|undefined } : null);
  }, [camera, gl, onDrop, raycaster, request, scene]);
  return null;
}

function WalkerMarker({ location }: { location: WalkLocation }) {
  return <group position={[location.position[0], location.position[1] + .02, location.position[2]]}>
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

function WalkCamera({ location, graph, scan, onMove }: {
  location: WalkLocation;
  graph: Graph;
  scan?: ScanFeatures;
  onMove?: ViewerProps['onWalkerMove'];
}) {
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>());
  const dragging = useRef(false);
  const lastPointer = useRef<[number, number]>([0, 0]);
  const yaw = useRef(0);
  const pitch = useRef(0);
  const feet = useRef(new Vector3(...location.position));
  const lastUpdate = useRef(0);

  useEffect(() => {
    const canvas = gl.domElement;
    const perspective = camera as PerspectiveCamera;
    const nearest = graph.nodes
      .filter(node => node.floor === location.floorId && Math.hypot(node.position[0] - location.position[0], node.position[2] - location.position[2]) > .3)
      .sort((a, b) => Math.hypot(a.position[0] - location.position[0], a.position[2] - location.position[2]) - Math.hypot(b.position[0] - location.position[0], b.position[2] - location.position[2]))[0];
    feet.current.set(...location.position);
    if (nearest) yaw.current = Math.atan2(location.position[0] - nearest.position[0], location.position[2] - nearest.position[2]);
    pitch.current = 0;
    camera.position.set(location.position[0], location.position[1] + 1.62, location.position[2]);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(0, yaw.current, 0);
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
  }, [camera, gl, graph, location.floorId]);

  useFrame((_, delta) => {
    const forward = Number(keys.current.has('KeyW') || keys.current.has('ArrowUp')) - Number(keys.current.has('KeyS') || keys.current.has('ArrowDown'));
    const turn = Number(keys.current.has('KeyA') || keys.current.has('ArrowLeft')) - Number(keys.current.has('KeyD') || keys.current.has('ArrowRight'));
    if (turn) yaw.current += turn * 1.85 * Math.min(delta, .05);
    camera.rotation.set(pitch.current, yaw.current, 0);
    if (!forward) return;
    const speed = (keys.current.has('ShiftLeft') || keys.current.has('ShiftRight') ? 3.7 : 1.9) * Math.min(delta, .05);
    const dx = -Math.sin(yaw.current) * forward * speed;
    const dz = -Math.cos(yaw.current) * forward * speed;
    const current = feet.current.toArray() as [number, number, number];
    let next: [number, number, number] = [current[0] + dx, current[1], current[2] + dz];
    if (!canWalkBetween(current, next, location.floorId, graph, scan)) {
      const alongX: [number, number, number] = [current[0] + dx, current[1], current[2]];
      const alongZ: [number, number, number] = [current[0], current[1], current[2] + dz];
      if (canWalkBetween(current, alongX, location.floorId, graph, scan)) next = alongX;
      else if (canWalkBetween(current, alongZ, location.floorId, graph, scan)) next = alongZ;
      else return;
    }
    feet.current.set(...next);
    camera.position.set(next[0], next[1] + 1.62, next[2]);
    if (onMove && performance.now() - lastUpdate.current > 180) {
      lastUpdate.current = performance.now();
      onMove({ position: next, floorId: location.floorId });
    }
  });
  return null;
}

function Scene(props: ViewerProps) {
  const { graph, scan, illustrative, floor, selected, onSelect, path, step, editing, onFloorPick, walker, walking } = props;
  const visibleNodes = graph.nodes.filter(node => floor === 'all' || node.floor === floor);
  const routeSegments = path.slice(1).map((node, index) => [path[index], node] as const)
    .filter(([from, to]) => floor === 'all' || (from.floor === floor && to.floor === floor));
  return <>
    <ambientLight intensity={2} />
    <directionalLight position={[8, 15, 12]} intensity={2} />
    {!scan && <gridHelper args={[100, 100, '#d7dee3', '#e8edef']} position={[0, -.12, 0]} />}
    {scan ? <ScannedGeometry scan={scan} graph={graph} floor={floor} zoneId={props.zoneId} onFloorPick={onFloorPick} /> : <GraphFloor graph={graph} floor={floor} illustrative={illustrative} zoneId={props.zoneId} onFloorPick={onFloorPick} />}
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
    {path.slice(0, step + 1).filter(node=>floor==='all'||node.floor===floor).map(node => <mesh key={'breadcrumb-' + node.id} position={[node.position[0], node.position[1] + .24, node.position[2]]}>
      <sphereGeometry args={[.14, 12, 12]} />
      <meshBasicMaterial color="#2583df" />
    </mesh>)}
    {walker && !walking && (floor === 'all' || floor === walker.floorId) && <WalkerMarker location={walker} />}
  </>;
}

export default function Viewer(props: ViewerProps) {
  const stacked=useMemo(()=>props.zones&&props.zones.length>1?stackBuilding(props.zones,props.zoneConnections):[],[props.zones,props.zoneConnections]);
  const overview=stacked.length>1&&props.floor==='all'&&!props.editing&&!props.walking;
  return <Canvas camera={{ position: [24, 23, 27], fov: 42 }} gl={{ antialias: true }}>
    {overview?<StackScene zones={stacked} connections={props.zoneConnections} activeZoneId={props.zoneId} selected={props.selected} onSelect={props.onSelect} onFloorPick={props.onFloorPick} walker={props.walker}/>:<Scene {...props} />}
    <DropController request={props.dropRequest} onDrop={props.onWalkerDrop} />
    {props.walking && props.walker
      ? <WalkCamera location={props.walker} graph={props.graph} scan={props.scan} onMove={props.onWalkerMove} />
      : overview?<StackCameraRig zones={stacked} reset={props.reset}/>:<CameraRig graph={props.graph} scan={props.scan} floor={props.floor} reset={props.reset} />}
  </Canvas>;
}
