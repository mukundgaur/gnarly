import { useMemo, useState } from 'react';
import { ChevronRight, Eye, Layers, Link2, Search, Square, X } from 'lucide-react';
import type { BuildingModel } from './buildingGraph.ts';
import { nodeColor } from './Viewer.tsx';
import { title, typeLabel } from './workspaceShared.tsx';
import { InlineRename } from './ui.tsx';

const importance = (type: string, labeled: boolean) => (['entrance', 'destination', 'elevator', 'stairs'].includes(type) ? 0 : labeled ? 1 : type === 'continuation' ? 2 : 3);

/** The building's structure: floors, the zones (scans) on each, and their waypoints. */
export default function Outliner({ model, editZoneId, selectedKey, level, onZone, onNode, onLevel, renaming, onRename, onRenamed, onFloorRename }: {
  model: BuildingModel; editZoneId: string; selectedKey: string; level: number | 'all';
  onZone: (zoneId: string) => void; onNode: (key: string) => void; onLevel: (level: number | 'all') => void;
  /** Node key whose name is being edited in place. */
  renaming: string;
  /** Starts renaming a waypoint; absent when names can't be edited. */
  onRename?: (key: string) => void;
  onRenamed: (key: string, name: string | null) => void;
  onFloorRename?: (level: number, name: string) => void;
}) {
  const [renamingFloor, setRenamingFloor] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [openZones, setOpenZones] = useState<Record<string, boolean>>({});
  const floors = [...model.floors].sort((a, b) => b.level - a.level);
  const linkCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of model.links) for (const key of [link.from, link.to]) {
      const zoneId = model.byKey.get(key)?.zoneId;
      if (zoneId) counts.set(zoneId, (counts.get(zoneId) || 0) + 1);
    }
    return counts;
  }, [model]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length ? model.nodes.filter(node => words.every(word => (title(node) + ' ' + node.id + ' ' + typeLabel(node.type)).toLowerCase().includes(word))).slice(0, 80) : [];
  const nodeRow = (key: string) => {
    const node = model.byKey.get(key)!;
    if (key === renaming) return <div key={key} className="tree-row leaf renaming">
      <span className="tree-dot" style={{ background: nodeColor(node.type) }} />
      <InlineRename value={node.label || ''} placeholder={node.id} onDone={name => onRenamed(key, name)} />
    </div>;
    return <button key={key} className={'tree-row leaf' + (key === selectedKey ? ' selected' : '')} onClick={() => onNode(key)} onDoubleClick={() => onRename?.(key)}
      onKeyDown={event => { if (event.key === 'F2' && onRename) { event.preventDefault(); onRename(key); } }}
      title={onRename ? 'Double-click to rename' : node.id}>
      <span className="tree-dot" style={{ background: nodeColor(node.type) }} />
      <span className="tree-name">{title(node)}</span>
      <small>{typeLabel(node.type)}</small>
    </button>;
  };
  return <nav className="outliner" aria-label="Building outline">
    <div className="outliner-search"><Search size={13} /><input placeholder="Find waypoint" value={query} onChange={event => setQuery(event.target.value)} aria-label="Find waypoint" />{query && <button aria-label="Clear" onClick={() => setQuery('')}><X size={12} /></button>}</div>
    {words.length ? <div className="tree">
      {matches.length ? matches.map(node => nodeRow(node.key)) : <div className="tree-empty">No waypoints match “{query}”.</div>}
    </div> : <div className="tree">
      <button className={'tree-row floor-row all' + (level === 'all' ? ' isolated' : '')} onClick={() => onLevel('all')}>
        <Layers size={13} /><span className="tree-name">All floors</span><small>{model.zones.length} zones</small>
      </button>
      {floors.map(floor => {
        const isClosed = closed[floor.level];
        return <div key={floor.level} className="tree-group">
          <div className={'tree-row floor-row' + (level === floor.level ? ' isolated' : '')}>
            <button className={'tree-toggle' + (isClosed ? '' : ' open')} aria-label={(isClosed ? 'Expand ' : 'Collapse ') + floor.name} onClick={() => setClosed(value => ({ ...value, [floor.level]: !isClosed }))}><ChevronRight size={13} /></button>
            {renamingFloor === floor.level && onFloorRename
              ? <div className="tree-label"><InlineRename value={floor.name} onDone={name => { setRenamingFloor(null); if (name !== null && name.trim() !== floor.name) onFloorRename(floor.level, name.trim()); }} /></div>
              : <button className="tree-label" onClick={() => onLevel(floor.level)} onDoubleClick={() => onFloorRename && setRenamingFloor(floor.level)} title={onFloorRename ? 'Double-click to rename' : undefined}><span className="tree-name">{floor.name}</span><small>L{floor.level}</small></button>}
            <button className={'tree-icon' + (level === floor.level ? ' on' : '')} aria-label={'Show only ' + floor.name} data-tip="Isolate floor" onClick={() => onLevel(level === floor.level ? 'all' : floor.level)}><Eye size={13} /></button>
          </div>
          {!isClosed && floor.zoneIds.map(zoneId => {
            const zone = model.zones.find(item => item.id === zoneId);
            if (!zone) return null;
            const expanded = openZones[zoneId] ?? zoneId === editZoneId;
            const nodes = zone.graph.nodes.filter(node => model.byKey.get(zoneId + '/' + node.id)?.level === floor.level)
              .sort((a, b) => importance(a.type, Boolean(a.label)) - importance(b.type, Boolean(b.label)) || title(a).localeCompare(title(b), undefined, { numeric: true }));
            const links = linkCount.get(zoneId) || 0;
            return <div key={zoneId} className="tree-group">
              <div className={'tree-row zone-row' + (zoneId === editZoneId ? ' current' : '')}>
                <button className={'tree-toggle' + (expanded ? ' open' : '')} aria-label={(expanded ? 'Collapse ' : 'Expand ') + zone.name} onClick={() => setOpenZones(value => ({ ...value, [zoneId]: !expanded }))}><ChevronRight size={13} /></button>
                <button className="tree-label" onClick={() => onZone(zoneId)}><Square size={12} className="tree-zone-icon" /><span className="tree-name">{zone.name}</span><small>{nodes.length}</small></button>
                {links > 0 && <span className="tree-badge" data-tip={links + ' link' + (links === 1 ? '' : 's') + ' to other zones'}><Link2 size={11} />{links}</span>}
              </div>
              {expanded && <div className="tree-children">{nodes.map(node => nodeRow(zoneId + '/' + node.id))}{!nodes.length && <div className="tree-empty">No waypoints yet</div>}</div>}
            </div>;
          })}
        </div>;
      })}
    </div>}
  </nav>;
}
