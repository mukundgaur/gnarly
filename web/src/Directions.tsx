import { ArrowDownUp, ArrowUpDown, Footprints, Link2, MapPin, Navigation, Pause, Play, PersonStanding, Save, Search } from 'lucide-react';
import type { BuildingModel, BuildingRoute } from './buildingGraph.ts';
import { nodeColor } from './Viewer.tsx';
import { PlaceSearch } from './ui.tsx';
import { floorName, nodeOptions, title, typeLabel, zoneName } from './workspaceShared.tsx';

type Props = {
  model: BuildingModel; buildingName: string;
  start: string; destination: string; setStart: (key: string) => void; setDestination: (key: string) => void; swap: () => void; requestRoute: () => void;
  place: string; setPlace: (key: string) => void;
  route: BuildingRoute | null; playing: boolean; step: number; togglePreview: () => void; showLevel: (level: number) => void;
  walkFrom: (key: string) => void;
  dirty: boolean; reviewEdits: () => void; localMode: boolean;
};

const WALK_SPEED = 1.25;
const minutes = (meters: number) => { const value = meters / WALK_SPEED / 60; return value < 1 ? '<1' : String(Math.round(value)); };

export default function Directions(p: Props) {
  const { model, route } = p;
  const options = nodeOptions(model);
  const place = model.byKey.get(p.place);
  return <div className="directions">
    <PlaceSearch placeholder={'Search ' + p.buildingName} options={options} value="" onChange={key => key && p.setPlace(key)} icon={<Search size={15} />} />

    {place && <div className="place-card">
      <span className="place-badge" style={{ background: nodeColor(place.type) }}><MapPin size={16} /></span>
      <div className="place-copy"><strong>{title(place)}</strong><small>{typeLabel(place.type)} · {floorName(model, place.level)}{model.zones.length > 1 ? ' · ' + zoneName(model, place.zoneId) : ''}</small></div>
      <div className="place-actions">
        <button className="btn accent" onClick={() => p.setDestination(place.key)}><Navigation size={14} /> Directions</button>
        <button className="btn" onClick={() => p.setStart(place.key)}>Start here</button>
        <button className="btn" data-tip="Walk in first person from here" aria-label="Walk from here" onClick={() => p.walkFrom(place.key)}><PersonStanding size={14} /></button>
      </div>
    </div>}

    <div className="route-card">
      <div className="route-fields">
        <div className="route-rail"><span className="rail-dot from" /><span className="rail-line" /><span className="rail-dot to" /></div>
        <div className="route-inputs">
          <PlaceSearch placeholder="Choose start" options={options} value={p.start} onChange={p.setStart} dot="#4ade80" />
          <PlaceSearch placeholder="Choose destination" options={options} value={p.destination} onChange={p.setDestination} dot="#ff6b8b" />
        </div>
        <button className="icon-btn swap" aria-label="Swap start and destination" data-tip="Swap" onClick={p.swap}><ArrowDownUp size={15} /></button>
      </div>

      {route && (route.ok ? <>
        <div className="route-summary">
          <div className="eta"><strong>{minutes(route.walkingMeters)}</strong><span>min</span></div>
          <div className="route-meta"><span>{route.walkingMeters.toFixed(0)} m walk</span><span>{route.floorTransitions ? route.floorTransitions + ' floor change' + (route.floorTransitions === 1 ? '' : 's') : 'Same floor'}</span></div>
          <button className="btn accent round" aria-label={p.playing ? 'Stop preview' : 'Preview route'} data-tip={p.playing ? 'Stop preview' : 'Preview route'} onClick={p.togglePreview}>{p.playing ? <Pause size={16} /> : <Play size={16} />}</button>
        </div>
        <ol className="steps">
          {route.legs.map((leg, index) => {
            const transition = route.transitions[index - 1];
            const from = leg.nodes[0], to = leg.nodes.at(-1)!;
            return [transition && <li key={'t' + index} className={'step ' + transition.kind}>
              <span className="step-icon">{transition.kind === 'continuation' ? <Link2 size={14} /> : <ArrowUpDown size={14} />}</span>
              <div><strong>{transition.kind === 'elevator' ? 'Elevator to ' + floorName(model, transition.to.level) : transition.kind === 'continuation' ? 'Continue into ' + zoneName(model, transition.to.zoneId) : 'Stairs to ' + floorName(model, transition.to.level)}</strong></div>
            </li>,
            <li key={'l' + index} className="step walk" onClick={() => p.showLevel(leg.level)}>
              <span className="step-icon"><Footprints size={14} /></span>
              <div><strong>{index === 0 ? 'From ' + title(from) : 'Walk to ' + title(to)}</strong><small>{floorName(model, leg.level)}{model.zones.length > 1 ? ' · ' + zoneName(model, leg.zoneId) : ''} · {leg.nodes.length - 1} segment{leg.nodes.length === 2 ? '' : 's'}</small></div>
            </li>];
          })}
          <li className="step arrive"><span className="step-icon"><MapPin size={14} /></span><div><strong>Arrive at {title(route.nodes.at(-1)!)}</strong></div></li>
        </ol>
        {p.playing && <div className="hint">Previewing: {title(route.nodes[Math.min(p.step, route.nodes.length - 1)])}</div>}
        {route.unverifiedEdges > 0 && <div className="hint warn">{route.unverifiedEdges} connection{route.unverifiedEdges === 1 ? ' is' : 's are'} confirmed but couldn't be checked against a scan.</div>}
        <button className="btn ghost wide" onClick={() => p.walkFrom(p.start)}><PersonStanding size={14} /> Walk this route in first person</button>
      </> : <div className="hint warn">{route.message}</div>)}
      {!route && (p.start && p.destination
        ? <button className="btn accent wide" onClick={p.requestRoute}><Navigation size={14} /> Show route</button>
        : <div className="hint">Pick a start and a destination, or click any labeled place in the map.</div>)}
    </div>

    {p.dirty && <button className="btn ghost wide" onClick={p.reviewEdits}><Save size={14} /> You have unsaved edits. Review them</button>}
    {p.localMode && <div className="hint">Showing browser-local test data.</div>}
  </div>;
}
