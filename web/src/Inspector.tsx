import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpDown, CheckCircle2, Compass, Link2, MapPin, Move3d, RotateCcw, RotateCw, Trash2, Wand2, X } from 'lucide-react';
import type { Graph, Node, ScanFeatures, ZoneConnection, ZoneLayout, ZoneView } from './data.ts';
import { nodeKey, type BuildingModel } from './buildingGraph.ts';
import { checkEdge } from './geometry.ts';
import { nodeColor } from './Viewer.tsx';
import { Kbd, PlaceSearch, ScrubField, Section } from './ui.tsx';
import { floorName, nodeOptions, title, typeLabel, waypointTypes, zoneName, type ElevatorSuggestion, type JoinOption, type LinkKind } from './workspaceShared.tsx';

type LinkProps = {
  zoneLinks: ZoneConnection[]; deleteZoneLink: (connection: ZoneConnection) => void;
  pending: boolean; linkSaving: boolean;
  linkExisting: (kind: LinkKind, otherKey: string) => void;
  beginPlacement: (kind: LinkKind, targetZoneId: string, level: number) => void;
};

export type WaypointInspectorProps = LinkProps & {
  model: BuildingModel; zone: ZoneView; node: Node; graph: Graph; scan?: ScanFeatures;
  editWaypoint: (patch: Partial<Node>, label: string, coalesce?: string) => void;
  remove: () => void; disconnect: (from: string, to: string) => void; connectTo: (targetId: string) => void;
  close: () => void;
};

const statusText = { valid: 'Clear', unverified: 'Unverified', warning: 'Recorded', blocked: 'Blocked by wall' } as Record<string, string>;

export function WaypointInspector(p: WaypointInspectorProps) {
  const { model, zone, node, graph, scan } = p;
  const [name, setName] = useState(node.label || '');
  useEffect(() => setName(node.label || ''), [node.id, node.label]);
  const level = model.levelOf(zone.id, node.floor);
  const edges = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
  const color = nodeColor(node.type);
  const mine = (connection: ZoneConnection) => (connection.from.zoneId === zone.id && connection.from.nodeId === node.id) || (connection.to.zoneId === zone.id && connection.to.nodeId === node.id);
  const links = p.zoneLinks.filter(mine);
  const linkKind: LinkKind | undefined = node.type === 'elevator' || node.type === 'continuation' ? node.type : undefined;
  const [elevatorLevel, setElevatorLevel] = useState<number | ''>('');
  const otherLevels = model.floors.filter(floor => floor.level !== level);
  const chosenLevel = elevatorLevel === '' ? otherLevels[0]?.level : elevatorLevel;
  const linkTargets = linkKind === 'elevator'
    ? model.nodes.filter(item => item.type === 'elevator' && item.zoneId !== zone.id && item.level === chosenLevel)
    : model.nodes.filter(item => item.type === 'continuation' && item.zoneId !== zone.id);
  const placeZones = linkKind === 'elevator'
    ? model.zones.filter(item => item.id !== zone.id && chosenLevel !== undefined && model.floors.find(floor => floor.level === chosenLevel)?.zoneIds.includes(item.id))
    : model.zones.filter(item => item.id !== zone.id && model.layout.find(entry => entry.zoneId === item.id)?.floor === level);
  const commitName = () => { if ((node.label || '') !== name.trim()) p.editWaypoint({ label: name.trim() || null }, 'rename', 'name:' + node.id); };
  return <div className="inspector-body">
    <header className="inspector-head">
      <span className="inspector-swatch" style={{ background: color, boxShadow: '0 0 16px ' + color + '88' }}><MapPin size={14} /></span>
      <div className="inspector-title">
        <input className="title-input" value={name} placeholder={node.id} aria-label="Waypoint name" onChange={event => setName(event.target.value)} onBlur={commitName} onKeyDown={event => { if (event.key === 'Enter') { commitName(); event.currentTarget.blur(); } if (event.key === 'Escape') { setName(node.label || ''); requestAnimationFrame(() => (event.target as HTMLInputElement).blur()); } }} />
        <small>{floorName(model, level)} · {zone.name} · <code>{node.id}</code></small>
      </div>
      <button className="icon-btn" aria-label="Deselect" data-tip="Deselect  Esc" onClick={p.close}><X size={15} /></button>
    </header>

    <Section title="Type">
      <div className="type-grid">{waypointTypes.map(type => <button key={type} className={'type-chip' + (type === node.type ? ' on' : '')} style={{ ['--chip' as string]: nodeColor(type) }} onClick={() => p.editWaypoint({ type }, 'change type')}><i />{typeLabel(type)}</button>)}</div>
    </Section>

    <Section title="Position" extra={<span className="muted">zone frame · m</span>}>
      <div className="scrub-row">
        {([0, 1, 2] as const).map(axis => <ScrubField key={axis} label={'XYZ'[axis]} unit="m" value={node.position[axis]} step={.01} precision={2}
          onChange={value => { const position = [...node.position] as Node['position']; position[axis] = value; p.editWaypoint({ position }, 'move waypoint', 'pos:' + node.id); }} />)}
      </div>
      {graph.floors.length > 1 && <label className="field">Floor<select value={node.floor} onChange={event => p.editWaypoint({ floor: event.target.value }, 'change floor')}>{graph.floors.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label>}
      <p className="hint">Drag the waypoint in the view, or scrub a label. Type expressions like <code>2.4+0.6</code>.</p>
    </Section>

    <Section title={'Connections · ' + edges.length}>
      {edges.length ? <ul className="list">{edges.map(edge => {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = graph.nodes.find(item => item.id === otherId);
        const status = checkEdge(edge, graph, scan).status;
        return <li key={edge.from + edge.to} className="list-row">
          <span className="tree-dot" style={{ background: nodeColor(other?.type || '') }} />
          <span className="list-main">{other ? title(other) : otherId}<small>{edge.meters.toFixed(1)} m</small></span>
          <span className={'pill ' + status}>{statusText[status] || status}</span>
          <button className="icon-btn" aria-label={'Disconnect ' + otherId} data-tip="Disconnect" onClick={() => p.disconnect(edge.from, edge.to)}><X size={13} /></button>
        </li>;
      })}</ul> : <p className="hint">Not connected yet. Routes can't reach it.</p>}
      <PlaceSearch placeholder="Connect to…" value="" options={nodeOptions(model, model.nodes.filter(item => item.zoneId === zone.id && item.localId !== node.id && !edges.some(edge => edge.from === item.localId || edge.to === item.localId)))} onChange={key => key && p.connectTo(key.split('/').slice(1).join('/'))} />
      <p className="hint">Or press <Kbd>C</Kbd> and click waypoints one after another.</p>
    </Section>

    {linkKind && <Section title={linkKind === 'elevator' ? 'Elevator link' : 'Zone seam link'} icon={linkKind === 'elevator' ? <ArrowUpDown size={13} /> : <Link2 size={13} />}>
      {links.length > 0 && <ul className="list">{links.map(connection => {
        const other = connection.from.zoneId === zone.id && connection.from.nodeId === node.id ? connection.to : connection.from;
        const otherNode = model.byKey.get(nodeKey(other.zoneId, other.nodeId));
        return <li key={other.zoneId + other.nodeId} className="list-row"><CheckCircle2 size={14} className="ok-icon" />
          <span className="list-main">{otherNode ? title(otherNode) : other.nodeId}<small>{zoneName(model, other.zoneId)}{otherNode ? ' · ' + floorName(model, otherNode.level) : ' · missing'}</small></span>
          <button className="icon-btn" aria-label={'Remove link to ' + other.nodeId} data-tip="Remove link" disabled={p.linkSaving} onClick={() => p.deleteZoneLink(connection)}><X size={13} /></button></li>;
      })}</ul>}
      {linkKind === 'elevator' && !otherLevels.length ? <p className="hint">Only one floor exists. Put another zone on a different floor level first.</p> : <>
        {linkKind === 'elevator' && <label className="field">Rides to<select value={chosenLevel ?? ''} onChange={event => setElevatorLevel(Number(event.target.value))}>{otherLevels.map(floor => <option key={floor.level} value={floor.level}>{floor.name}</option>)}</select></label>}
        <PlaceSearch placeholder={linkTargets.length ? 'Link to existing ' + (linkKind === 'elevator' ? 'elevator' : 'seam point') + '…' : 'None to link to yet'} value="" options={nodeOptions(model, linkTargets)} onChange={key => key && p.linkExisting(linkKind, key)} />
        {placeZones.length > 0 && <div className="chip-row"><span className="muted">or place its match in</span>{placeZones.map(item => <button key={item.id} className="chip" disabled={p.linkSaving} onClick={() => p.beginPlacement(linkKind, item.id, linkKind === 'elevator' ? chosenLevel! : level)}>{item.name}</button>)}</div>}
        {p.pending && <p className="hint">Linking saves this zone’s edits first.</p>}
      </>}
    </Section>}

    <div className="inspector-foot">
      <button className="btn danger" onClick={p.remove}><Trash2 size={14} /> Delete waypoint <Kbd>Del</Kbd></button>
    </div>
  </div>;
}

export type ZoneInspectorProps = Pick<LinkProps, 'zoneLinks' | 'deleteZoneLink' | 'linkSaving'> & {
  model: BuildingModel; zone: ZoneView; zoneLayout: ZoneLayout;
  floorNameValue: string; setFloorName: (name: string) => void;
  changeLayout: (field: 'floor' | 'x' | 'z' | 'rotationDegrees', value: number) => void;
  rotateZone: (degrees: number) => void; arrange: () => void; arranging: boolean;
  joinOptions: JoinOption[]; joining: string; joinZones: (zoneId: string) => void; unjoin: (zoneId: string) => void; pending: boolean;
  elevatorSuggestions: ElevatorSuggestion[]; linkElevator: (nodeId: string, otherKey: string) => void;
  autoAlign: () => void; shiftFloor: (move: { x: number; z: number; rotationDegrees: number }) => void; alignFloorToElevators: () => void;
  beginBoundaryPlacement: (end: 'start' | 'end') => void;
  health: { blocked: number; unverified: number; warnings: number; issues: string[] };
  runAutoConnect: () => void; removeBlocked: () => void; selectNode: (key: string) => void;
};

export function ZoneInspector(p: ZoneInspectorProps) {
  const { model, zone, zoneLayout } = p;
  const [step, setStep] = useState(.5), [turn, setTurn] = useState(5);
  const elevators = zone.graph.nodes.filter(node => node.type === 'elevator');
  const linkedElevator = (nodeId: string) => p.zoneLinks.some(link => link.kind === 'elevator' && ((link.from.zoneId === zone.id && link.from.nodeId === nodeId) || (link.to.zoneId === zone.id && link.to.nodeId === nodeId)));
  const healthy = !p.health.blocked && !p.health.issues.length;
  return <div className="inspector-body">
    <header className="inspector-head">
      <span className="inspector-swatch zone"><Move3d size={14} /></span>
      <div className="inspector-title"><strong>{zone.name}</strong><small>{floorName(model, zoneLayout.floor)} · {zone.graph.nodes.length} waypoints{zone.scan ? ' · scanned' : ''}</small></div>
    </header>

    <Section title="Placement" icon={<Compass size={13} />} extra={<button className={'chip' + (p.arranging ? ' on' : '')} onClick={p.arrange}>Arrange <Kbd>M</Kbd></button>}>
      <div className="scrub-row">
        <ScrubField label="X" unit="m" value={zoneLayout.x} step={.05} precision={2} onChange={value => p.changeLayout('x', value)} />
        <ScrubField label="Z" unit="m" value={zoneLayout.z} step={.05} precision={2} onChange={value => p.changeLayout('z', value)} />
        <ScrubField label="R" unit="°" value={zoneLayout.rotationDegrees} step={.5} precision={1} onChange={value => p.changeLayout('rotationDegrees', value)} />
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => p.rotateZone(90)}><RotateCcw size={13} /> 90°</button>
        <button className="btn" onClick={() => p.rotateZone(-90)}><RotateCw size={13} /> 90°</button>
      </div>
      <p className="hint">Drag the gizmo in the view: red and blue arrows move along X and Z, the ring rotates, the green arrow moves the zone to another floor. Or press <Kbd>G</Kbd> / <Kbd>R</Kbd>. Walls snap together.</p>
    </Section>

    <Section title="Floor">
      <div className="scrub-row two">
        <ScrubField label="Level" value={zoneLayout.floor} step={1} precision={0} onChange={value => p.changeLayout('floor', Math.round(value))} />
        <label className="field inline">Name<input value={p.floorNameValue} placeholder={floorName(model, zoneLayout.floor)} onChange={event => p.setFloorName(event.target.value)} /></label>
      </div>
    </Section>

    <Section title="Connections" icon={<Link2 size={13} />}>
      <div className="sub-head first">Same floor</div>
      {p.joinOptions.length ? <ul className="list">{p.joinOptions.map(option => {
        const state = option.joined ? (option.blocked ? 'blocked' : 'joined') : option.touching ? (option.walled ? 'walled' : 'ready') : 'apart';
        const detail = { joined: 'Joined. Routes walk across the seam.', blocked: 'Joined through a wall, so routes can’t cross. Unjoin, line up a doorway, and join again.', walled: option.walled, ready: 'Touching. Join so routes can walk across.', apart: 'Not touching. Drag it next to this zone.' }[state];
        return <li key={option.zoneId} className={'list-row join-row ' + state}>
          <span className={'status-dot ' + ({ joined: 'ok', blocked: 'bad', walled: 'bad', ready: 'ready', apart: 'idle' }[state])} />
          <span className="list-main wrap">{option.name}<small>{detail}</small></span>
          {option.joined
            ? <button className="btn small ghost" disabled={p.linkSaving} data-tip="Stop routing between these zones" onClick={() => p.unjoin(option.zoneId)}>Unjoin</button>
            : state === 'ready' ? <button className="btn small accent" disabled={Boolean(p.joining)} data-tip={'Adds a linked seam point to both zones' + (p.pending ? ' and saves your edits' : '')} onClick={() => p.joinZones(option.zoneId)}>{p.joining === option.zoneId ? 'Joining…' : 'Join'}</button>
              : null}
        </li>;
      })}</ul> : <p className="hint">No other zones on {floorName(model, zoneLayout.floor)}. Drag a zone's green arrow up or down, or set its level to {zoneLayout.floor}, to bring it here.</p>}

      {elevators.length > 0 && <>
        <div className="sub-head">Elevators</div>
        <ul className="list">{elevators.map(node => {
          const suggestion = p.elevatorSuggestions.find(item => item.nodeId === node.id);
          const linked = linkedElevator(node.id);
          return <li key={node.id} className="list-row elevator-row">
            <span className="tree-dot" style={{ background: nodeColor('elevator') }} />
            <button className="list-main link-like" onClick={() => p.selectNode(nodeKey(zone.id, node.id))}>{title(node)}<small>{linked ? 'Linked to another floor' : suggestion ? 'Matches ' + suggestion.otherName + ' on ' + suggestion.floor + ' · ' + suggestion.meters.toFixed(1) + ' m apart' : 'No elevator on another floor yet'}</small></button>
            {linked ? <span className="pill valid">Linked</span>
              : suggestion ? <button className="btn small accent" disabled={p.linkSaving} data-tip={suggestion.meters > 6 ? 'Far apart: check it is the same shaft' : 'Link these elevators'} onClick={() => p.linkElevator(node.id, suggestion.otherKey)}>Link</button>
                : <span className="pill warning">Unlinked</span>}
          </li>;
        })}</ul>
        <button className="btn ghost" onClick={p.alignFloorToElevators}>Stack this floor over linked elevators</button>
      </>}
    </Section>

    <Section title="Map health" icon={healthy ? <CheckCircle2 size={13} className="ok-icon" /> : <AlertTriangle size={13} className="warn-icon" />}>
      <div className="health">
        <div><strong className={p.health.blocked ? 'bad' : ''}>{p.health.blocked}</strong><span>blocked</span></div>
        <div><strong className={p.health.unverified ? 'warn' : ''}>{p.health.unverified}</strong><span>unverified</span></div>
        <div><strong>{p.health.warnings}</strong><span>recorded</span></div>
      </div>
      {p.health.issues.slice(0, 3).map(issue => <p key={issue} className="hint warn">{issue}</p>)}
      <div className="btn-row">
        <button className="btn" onClick={p.runAutoConnect}><Wand2 size={13} /> Auto-connect</button>
        {p.health.blocked > 0 && <button className="btn danger" onClick={p.removeBlocked}>Remove blocked</button>}
      </div>
    </Section>

    {p.zoneLinks.length > 0 && <Section title={'Links · ' + p.zoneLinks.length} defaultOpen={false}>
      <ul className="list">{p.zoneLinks.map(connection => {
        const mine = connection.from.zoneId === zone.id ? connection.from : connection.to, other = mine === connection.from ? connection.to : connection.from;
        return <li key={mine.nodeId + other.zoneId + other.nodeId} className="list-row">
          {connection.kind === 'elevator' ? <ArrowUpDown size={13} /> : <Link2 size={13} />}
          <span className="list-main">{mine.nodeId} → {zoneName(model, other.zoneId)}<small>{other.nodeId}</small></span>
          <button className="icon-btn" aria-label={'Remove zone connection to ' + other.nodeId} data-tip="Remove link" disabled={p.linkSaving} onClick={() => p.deleteZoneLink(connection)}><X size={13} /></button>
        </li>;
      })}</ul>
    </Section>}

    <Section title="Advanced" defaultOpen={false}>
      <button className="btn ghost" onClick={p.autoAlign}>Re-fit to joined zones</button>
      <div className="sub-head">Move the whole {floorName(model, zoneLayout.floor)}</div>
      <div className="scrub-row two">
        <ScrubField label="Step" unit="m" value={step} step={.05} min={.01} precision={2} onChange={setStep} />
        <ScrubField label="Turn" unit="°" value={turn} step={.5} min={.1} precision={1} onChange={setTurn} />
      </div>
      <div className="nudge">
        <button className="btn" onClick={() => p.shiftFloor({ x: -step, z: 0, rotationDegrees: 0 })}>−X</button>
        <button className="btn" onClick={() => p.shiftFloor({ x: step, z: 0, rotationDegrees: 0 })}>+X</button>
        <button className="btn" onClick={() => p.shiftFloor({ x: 0, z: -step, rotationDegrees: 0 })}>−Z</button>
        <button className="btn" onClick={() => p.shiftFloor({ x: 0, z: step, rotationDegrees: 0 })}>+Z</button>
        <button className="btn" aria-label="Turn floor left" onClick={() => p.shiftFloor({ x: 0, z: 0, rotationDegrees: turn })}><RotateCcw size={13} /></button>
        <button className="btn" aria-label="Turn floor right" onClick={() => p.shiftFloor({ x: 0, z: 0, rotationDegrees: -turn })}><RotateCw size={13} /></button>
      </div>
      <div className="sub-head">Manual seam points</div>
      <div className="btn-row"><button className="btn" onClick={() => p.beginBoundaryPlacement('start')}>Place zone start</button><button className="btn" onClick={() => p.beginBoundaryPlacement('end')}>Place zone end</button></div>
    </Section>
  </div>;
}
