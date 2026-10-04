import { ArrowRight, ArrowUpDown, Footprints, Link2, Save } from 'lucide-react';
import type { BuildingModel, BuildingRoute } from './buildingGraph.ts';
import { nodeOption, Picker, title } from './workspaceShared.tsx';

type Props = {
  model: BuildingModel;
  start: string; destination: string; selectedKey: string;
  setStart: (key: string) => void; setDestination: (key: string) => void;
  route: BuildingRoute | null; showRoute: () => void;
  playing: boolean; step: number; togglePreview: () => void;
  showLevel: (level: number) => void;
  canRoute: boolean; dirty: boolean; reviewEdits: () => void; localMode: boolean;
};

export default function ViewPanel({ model, start, destination, selectedKey, setStart, setDestination, route, showRoute, playing, step, togglePreview, showLevel, canRoute, dirty, reviewEdits, localMode }: Props) {
  const options = model.nodes.map(node => nodeOption(model, node)).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const selected = model.byKey.get(selectedKey);
  const floorName = (level: number) => model.floors.find(item => item.level === level)?.name || 'Floor ' + level;
  const zoneName = (zoneId: string) => model.zones.find(item => item.id === zoneId)?.name || zoneId;
  return <>
    {localMode && <div className="notice">Showing browser-local test data. Switch the data mode in Edit to use Firebase.</div>}
    <Picker caption="Starting point" options={options} value={start} change={setStart} />
    <Picker caption="Destination" options={options} value={destination} change={setDestination} />
    {selected && <div className="selected-actions"><strong>{title(selected)}</strong><button onClick={() => setStart(selected.key)}>Set as start</button><button onClick={() => setDestination(selected.key)}>Set as destination</button></div>}
    <button className="primary" disabled={!start || !destination || !canRoute} onClick={showRoute}>Show route <ArrowRight size={17} /></button>
    {route && (route.ok ? <div className="route-result">
      <div className="route-distance"><strong>{route.walkingMeters.toFixed(1)} m</strong><span>{route.floorTransitions} FLOOR {route.floorTransitions === 1 ? 'CHANGE' : 'CHANGES'}</span></div>
      <ol className="route-steps">
        {route.legs.map((leg, index) => {
          const transition = route.transitions[index - 1];
          return [transition && <li key={'t' + index} className={'route-step ' + transition.kind}>
            {transition.kind === 'elevator' ? <ArrowUpDown size={14} /> : <Link2 size={14} />}
            <span>{transition.kind === 'elevator' ? 'Take the elevator from ' + floorName(transition.from.level) + ' to ' + floorName(transition.to.level)
              : transition.kind === 'continuation' ? 'Continue into ' + zoneName(transition.to.zoneId)
                : 'Take the stairs to ' + floorName(transition.to.level)}</span>
          </li>,
          <li key={'l' + index} className="route-step walk"><Footprints size={14} /><button onClick={() => showLevel(leg.level)}>
            {floorName(leg.level)}{model.zones.length > 1 ? ' · ' + zoneName(leg.zoneId) : ''}<small>{leg.nodes.map(node => node.label || node.localId).join(' → ')}</small>
          </button></li>];
        })}
      </ol>
      {route.unverifiedEdges > 0 && <div className="notice">{route.unverifiedEdges} connection(s) are confirmed but cannot be checked against a scan.</div>}
      {route.warningEdges > 0 && <div className="notice">{route.warningEdges} recorded walk connection(s) disagree with the scanned walls. They were walked during capture, so they are still used.</div>}
      <button className="preview" onClick={togglePreview}>{playing ? 'Stop preview' : 'Preview route'} <ArrowRight size={15} /></button>
      <div className="route-progress">{playing ? 'Previewing: ' + (route.nodes[Math.min(step, route.nodes.length - 1)].label || route.nodes[Math.min(step, route.nodes.length - 1)].localId) : 'Elevator rides switch floors; the route continues on the next floor.'}</div>
    </div> : <div className="notice">{route.message}</div>)}
    {dirty && <button className="secondary" onClick={reviewEdits}>Review unsaved edits <Save size={14} /></button>}
    <div className="route-foot">Routes follow waypoint connections that pass floor and wall checks, continue across joined zones, and use linked elevators between floors.</div>
  </>;
}
