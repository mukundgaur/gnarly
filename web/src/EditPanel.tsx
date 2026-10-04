import { useEffect, useState } from 'react';
import { ArrowUpDown, Layers, Link2, Save, Wand2, X } from 'lucide-react';
import type { Graph, Node, ScanFeatures, ZoneConnection, ZoneLayout, ZoneView } from './data.ts';
import type { BuildingModel } from './buildingGraph.ts';
import { nodeKey } from './buildingGraph.ts';
import { checkEdge, type EdgeCheck } from './geometry.ts';
import { nodeOption, Picker, title, waypointTypes, type WaypointForm } from './workspaceShared.tsx';

export type Tool = 'select' | 'add' | 'move';
export type LinkKind = 'elevator' | 'continuation';
export type PendingLink = { from: { zoneId: string; nodeId: string }; kind: LinkKind; targetZoneId: string; toNodeId?: string };

export type EditPanelProps = {
  model: BuildingModel;
  zones: ZoneView[];
  editZoneId: string; switchZone: (zoneId: string) => void;
  graph: Graph; scan?: ScanFeatures;
  disabled: boolean;
  tool: Tool; setTool: (tool: Tool) => void;
  boundaryPlacement: 'start' | 'end' | null; beginBoundaryPlacement: (end: 'start' | 'end') => void;
  selected?: Node; selectWaypoint: (nodeId: string) => void;
  form: WaypointForm; setForm: (form: WaypointForm) => void; formDirty: boolean; applyForm: () => void; remove: () => void;
  connect: (targetId: string) => void; disconnect: (from: string, to: string) => void; runAutoConnect: () => void;
  zoneLayout: ZoneLayout; layoutDirty: boolean; layoutSaving: boolean; changeLayout: (field: 'floor' | 'x' | 'z' | 'rotationDegrees', value: string) => void;
  floorNameValue: string; setFloorName: (name: string) => void; autoAlign: () => void; persistLayout: () => void;
  shiftFloor: (move: { x: number; z: number; rotationDegrees: number }) => void; alignFloorToElevators: () => void;
  pending: boolean; linkSaving: boolean;
  linkExisting: (kind: LinkKind, otherKey: string) => void;
  beginPlacement: (kind: LinkKind, targetZoneId: string, level: number) => void;
  pendingLink: PendingLink | null; finishPendingLink: () => void; cancelPendingLink: () => void;
  zoneLinks: ZoneConnection[]; deleteZoneLink: (connection: ZoneConnection) => void;
  blocked: number; unverified: number; warnings: number; removeBlocked: () => void;
  issues: string[]; newBlocked: number;
  dirty: boolean; status: string; hasRemote: boolean; save: () => void; cancel: () => void; mode: 'local' | 'firebase';
};

const statusLabel = (check: EdgeCheck) => check.status === 'warning' ? 'recorded · scan disagrees' : check.status;

export default function EditPanel(p: EditPanelProps) {
  const { model, graph, scan, selected } = p;
  const [target, setTarget] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  const [placeZone, setPlaceZone] = useState('');
  const [elevatorLevel, setElevatorLevel] = useState<number | ''>('');
  const [moveStep, setMoveStep] = useState('0.5'), [turnStep, setTurnStep] = useState('5');
  const nudge = (x: number, z: number, turn: number) => {
    const meters = Number(moveStep), degrees = Number(turnStep);
    if (!(meters > 0) || !(degrees > 0)) return;
    p.shiftFloor({ x: x * meters, z: z * meters, rotationDegrees: turn * degrees });
  };
  useEffect(() => { setTarget(''); setLinkTarget(''); setPlaceZone(''); setElevatorLevel(''); }, [selected?.id, p.editZoneId]);
  const editZone = p.zones.find(zone => zone.id === p.editZoneId)!;
  const levelOfZone = (zoneId: string) => model.layout.find(item => item.zoneId === zoneId)?.floor ?? 0;
  const floorName = (level: number) => model.floors.find(item => item.level === level)?.name || 'Floor ' + level;
  const linkKind: LinkKind | undefined = selected?.type === 'elevator' || selected?.type === 'continuation' ? selected.type : undefined;
  const selectedLevel = selected ? model.levelOf(p.editZoneId, selected.floor) : 0;
  const otherZones = p.zones.filter(zone => zone.id !== p.editZoneId);
  const continuationTargets = model.nodes.filter(node => node.type === 'continuation' && node.zoneId !== p.editZoneId).map(node => nodeOption(model, node));
  const otherLevels = model.floors.filter(floor => floor.level !== selectedLevel);
  const chosenLevel = elevatorLevel === '' ? otherLevels[0]?.level : elevatorLevel;
  const elevatorTargets = model.nodes.filter(node => node.type === 'elevator' && node.zoneId !== p.editZoneId && node.level === chosenLevel).map(node => nodeOption(model, node));
  const levelZones = chosenLevel === undefined ? [] : p.zones.filter(zone => zone.id !== p.editZoneId && model.floors.find(floor => floor.level === chosenLevel)?.zoneIds.includes(zone.id));
  const zoneName = (zoneId: string) => p.zones.find(zone => zone.id === zoneId)?.name || zoneId;
  const awaitingHere = Boolean(p.pendingLink && p.pendingLink.targetZoneId === p.editZoneId);
  return <fieldset className="editor-fields" disabled={p.disabled}><legend className="sr-only">Waypoint editor</legend>
    {p.zones.length > 1 && <label>Editing zone<select aria-label="Editing zone" value={p.editZoneId} onChange={e => p.switchZone(e.target.value)}>{p.zones.map(zone => <option key={zone.id} value={zone.id}>{floorName(levelOfZone(zone.id))} · {zone.name}</option>)}</select></label>}
    <div className="editor-tools">
      <button className={p.tool === 'select' ? 'active' : ''} onClick={() => p.setTool('select')}>Select</button>
      <button className={p.tool === 'add' && !p.boundaryPlacement ? 'active' : ''} onClick={() => p.setTool('add')}>Add</button>
      <button className={p.tool === 'move' ? 'active' : ''} disabled={!selected} onClick={() => p.setTool('move')}>Move</button>
    </div>
    <button className="secondary" onClick={p.runAutoConnect} title="Connect waypoints that can see each other through scanned doors and openings"><span><Wand2 size={13} /> Auto-connect waypoints</span></button>
    <Picker caption="Selected waypoint" options={graph.nodes.map(node => ({ value: node.id, label: title(node) }))} value={selected?.id || ''} change={p.selectWaypoint} />
    {selected && <div className="waypoint-form"><small>ID · {selected.id} · {editZone.name}</small>
      <label>Name<input value={p.form.name} onChange={e => p.setForm({ ...p.form, name: e.target.value })} /></label>
      <div className="form-pair"><label>Type<select value={p.form.type} onChange={e => p.setForm({ ...p.form, type: e.target.value })}>{!waypointTypes.includes(p.form.type) && <option>{p.form.type}</option>}{waypointTypes.map(type => <option key={type}>{type}</option>)}</select></label>
        <label>Floor<select value={p.form.floor} onChange={e => p.setForm({ ...p.form, floor: e.target.value })}>{graph.floors.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label></div>
      <div className="coordinate-row">{(['x', 'y', 'z'] as const).map(axis => <label key={axis}>{axis.toUpperCase()} (m)<input type="number" step="0.01" value={p.form[axis]} onChange={e => p.setForm({ ...p.form, [axis]: e.target.value })} /></label>)}</div>
      <button className="primary" disabled={!p.formDirty} onClick={p.applyForm}>Apply waypoint</button>
      {p.formDirty && <small className="pending-fields">Apply these fields before saving the graph.</small>}
      <button className="delete-waypoint" onClick={p.remove}>Delete waypoint</button>
    </div>}
    {selected && <div className="connections"><h3>Connections</h3>
      {graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id).map((edge, index) => <div className="connection" key={index}><span>{edge.from === selected.id ? edge.to : edge.from}<small> · {edge.meters.toFixed(1)} m · {statusLabel(checkEdge(edge, graph, scan))}</small></span><button aria-label={'Remove connection ' + index} onClick={() => p.disconnect(edge.from, edge.to)}><X size={14} /></button></div>)}
      <label>Connect to<select value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose waypoint</option>{graph.nodes.filter(node => node.id !== selected.id).map(node => <option key={node.id} value={node.id}>{title(node)}</option>)}</select></label>
      <button disabled={!target} onClick={() => { p.connect(target); setTarget(''); }}>Add connection</button>
    </div>}

    {p.pendingLink && <div className="zone-links pending-link">
      <h3><Link2 size={14} /> Matching {p.pendingLink.kind} point</h3>
      {!awaitingHere ? <p>Switch to zone <strong>{zoneName(p.pendingLink.targetZoneId)}</strong> to place it.</p>
        : !p.pendingLink.toNodeId ? <p>Click the floor of <strong>{editZone.name}</strong> where the matching {p.pendingLink.kind} belongs.</p>
          : <><p>New point <strong>{p.pendingLink.toNodeId}</strong>. Save it and link it to {zoneName(p.pendingLink.from.zoneId)} · {p.pendingLink.from.nodeId}.</p>
            <button className="primary" disabled={p.linkSaving || p.formDirty} onClick={p.finishPendingLink}>{p.linkSaving ? 'Saving…' : 'Save point & link'}</button></>}
      <button className="zone-cancel" onClick={p.cancelPendingLink}>Cancel</button>
    </div>}

    <div className="zone-links zone-layout"><h3><Layers size={14} /> Zone placement</h3>
      <p>Assign <strong>{editZone.name}</strong> to a building floor and place it in that floor's shared frame. Zones joined by continuation points are aligned automatically; fine-tune here. Scan coordinates are never changed.</p>
      <div className="form-pair"><label>Floor level<input type="number" step="1" value={p.zoneLayout.floor} onChange={e => p.changeLayout('floor', e.target.value)} /></label>
        <label>Floor name<input value={p.floorNameValue} placeholder={floorName(p.zoneLayout.floor)} onChange={e => p.setFloorName(e.target.value)} /></label></div>
      <div className="coordinate-row">{([['x', 'X (m)', '0.25'], ['z', 'Z (m)', '0.25'], ['rotationDegrees', 'Rotation °', '5']] as const).map(([field, label, step]) => <label key={field}>{label}<input type="number" step={step} value={Math.round(p.zoneLayout[field] * 1000) / 1000} onChange={e => p.changeLayout(field, e.target.value)} /></label>)}</div>
      <button onClick={p.autoAlign}>Auto-align to joined zones</button>
      <div className="floor-move"><strong>Move whole {floorName(p.zoneLayout.floor)}</strong>
        <small>Shifts or turns every zone on this floor together, keeping their joins.</small>
        <div className="form-pair"><label>Step (m)<input type="number" min="0.01" step="0.1" value={moveStep} onChange={e => setMoveStep(e.target.value)} /></label>
          <label>Turn (°)<input type="number" min="0.1" step="1" value={turnStep} onChange={e => setTurnStep(e.target.value)} /></label></div>
        <div className="floor-nudge">
          <button aria-label="Move floor −X" onClick={() => nudge(-1, 0, 0)}>−X</button>
          <button aria-label="Move floor +X" onClick={() => nudge(1, 0, 0)}>+X</button>
          <button aria-label="Move floor −Z" onClick={() => nudge(0, -1, 0)}>−Z</button>
          <button aria-label="Move floor +Z" onClick={() => nudge(0, 1, 0)}>+Z</button>
          <button aria-label="Turn floor left" onClick={() => nudge(0, 0, 1)}>⟲</button>
          <button aria-label="Turn floor right" onClick={() => nudge(0, 0, -1)}>⟳</button>
        </div>
        <button onClick={p.alignFloorToElevators} title="Uses elevator links to another floor; elevators are stacked vertically"><span><ArrowUpDown size={13} /> Align floor to elevators</span></button>
      </div>
      <button className="primary" disabled={!p.layoutDirty || p.layoutSaving} onClick={p.persistLayout}>{p.layoutSaving ? 'Saving layout…' : 'Save zone placement'}</button>
    </div>

    <div className="zone-links">
      <h3><Link2 size={14} /> Join zones on a floor</h3>
      <p>Place a continuation point where this scan meets the next one, then link it to the matching point in the other zone. The zones merge into one floor; it is not treated as a door.</p>
      <div className="connector-placement-actions"><button onClick={() => p.beginBoundaryPlacement('start')}>Place zone start</button><button onClick={() => p.beginBoundaryPlacement('end')}>Place zone end</button></div>
      {linkKind === 'continuation' && otherZones.length > 0 && <div className="zone-link-form">
        <Picker caption="Matching continuation point" options={continuationTargets} value={linkTarget} change={setLinkTarget} />
        <button disabled={!linkTarget || p.pending || p.linkSaving} onClick={() => p.linkExisting('continuation', linkTarget)}>Join zones here</button>
        <div className="zone-or"><span>or place it</span></div>
        <label>Zone<select value={placeZone} onChange={e => setPlaceZone(e.target.value)}><option value="">Choose zone</option>{otherZones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
        <button disabled={!placeZone || p.pending} onClick={() => p.beginPlacement('continuation', placeZone, levelOfZone(placeZone))}>Place matching point in that zone</button>
      </div>}
      {selected && linkKind !== 'continuation' && <small>Select a continuation waypoint to join zones.</small>}
    </div>

    <div className="zone-links elevator-links">
      <h3><ArrowUpDown size={14} /> Elevators between floors</h3>
      <p>Link an elevator waypoint to the elevator on another floor. A ride teleports the route to that floor; the zones stay separate.</p>
      {linkKind === 'elevator' ? otherLevels.length ? <div className="zone-link-form">
        <label>Destination floor<select value={chosenLevel ?? ''} onChange={e => { setElevatorLevel(Number(e.target.value)); setLinkTarget(''); setPlaceZone(''); }}>{otherLevels.map(floor => <option key={floor.level} value={floor.level}>{floor.name}</option>)}</select></label>
        <Picker caption="Elevator on that floor" options={elevatorTargets} value={linkTarget} change={setLinkTarget} />
        <button disabled={!linkTarget || p.pending || p.linkSaving} onClick={() => p.linkExisting('elevator', linkTarget)}>Link elevator</button>
        <div className="zone-or"><span>or place it</span></div>
        <label>Zone on that floor<select value={placeZone} onChange={e => setPlaceZone(e.target.value)}><option value="">Choose zone</option>{levelZones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
        <button disabled={!placeZone || p.pending || chosenLevel === undefined} onClick={() => p.beginPlacement('elevator', placeZone, chosenLevel!)}>Place matching elevator there</button>
      </div> : <small>Only one floor exists. Assign another zone to a different floor level first.</small>
        : <small>Select an elevator waypoint (type “elevator”) to link it.</small>}
      {p.pending && (linkKind === 'elevator' || linkKind === 'continuation') && <small>Save this zone before linking it.</small>}
    </div>

    {p.zoneLinks.length > 0 && <div className="zone-links zone-link-list"><strong>Links from {editZone.name}</strong>{p.zoneLinks.map(connection => {
      const mine = connection.from.zoneId === p.editZoneId ? connection.from : connection.to, other = mine === connection.from ? connection.to : connection.from;
      const otherNode = model.byKey.get(nodeKey(other.zoneId, other.nodeId));
      return <div className="connection" key={mine.nodeId + ':' + other.zoneId + ':' + other.nodeId}><span>{mine.nodeId} → {zoneName(other.zoneId)}<small> · {connection.kind || 'legacy'} · {other.nodeId}{otherNode ? ' · ' + floorName(otherNode.level) : ' · missing'}</small></span><button aria-label={'Remove zone connection to ' + other.nodeId} disabled={p.linkSaving} onClick={() => p.deleteZoneLink(connection)}><X size={14} /></button></div>;
    })}</div>}

    <div className="graph-health">{p.blocked} blocked · {p.unverified} unverified · {p.warnings} recorded/scan mismatch{p.blocked > 0 && <button onClick={p.removeBlocked}>Remove blocked</button>}</div>
    {p.issues.length > 0 && <div className="error">{p.issues.slice(0, 3).join('; ')}</div>}
    {p.newBlocked > 0 && <div className="error">{p.newBlocked} new blocked connection(s) must be removed before saving.</div>}
    {model.issues.length > 0 && <div className="notice">{model.issues.slice(0, 3).join(' ')}</div>}
    <div className="save-actions"><button className="primary" disabled={!p.dirty || p.formDirty || p.status === 'saving' || Boolean(p.issues.length) || Boolean(p.newBlocked) || p.hasRemote} onClick={p.save}><Save size={15} /> Save {p.mode === 'firebase' ? 'to Firebase' : 'locally'}</button><button onClick={p.cancel} disabled={!p.pending}>Cancel edits</button></div>
  </fieldset>;
}
