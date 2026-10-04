import { useState } from 'react';
import type { Node } from './data.ts';
import type { BuildingModel, BuildingNode } from './buildingGraph.ts';

export type PickerOption = { value: string; label: string };
export const waypointTypes = ['entrance','hallway','elevator','continuation','stairs','destination','door','opening','waypoint'];
export const title = (node: Node) => (node.label ? node.label + ' · ' : '') + node.id;
export const waypointForm = (node: Node) => ({name:node.label||'',type:node.type,floor:node.floor,x:String(node.position[0]),y:String(node.position[1]),z:String(node.position[2])});
export type WaypointForm = ReturnType<typeof waypointForm>;

export function nodeOption(model: BuildingModel, node: BuildingNode): PickerOption {
  const floor = model.floors.find(item => item.level === node.level)?.name || 'Floor ' + node.level;
  const zone = model.zones.length > 1 ? ' · ' + (model.zones.find(item => item.id === node.zoneId)?.name || node.zoneId) : '';
  return { value: node.key, label: floor + zone + ' · ' + title(node) };
}

export function Picker({ caption, options, value, change }: { caption: string; options: PickerOption[]; value: string; change: (value: string) => void }) {
  const [query,setQuery] = useState('');
  const visible=options.filter(option=>option.label.toLowerCase().includes(query.toLowerCase()));
  const current=options.find(option=>option.value===value);
  return <label className="waypoint-picker">{caption}<input aria-label={'Search '+caption} placeholder="Search waypoints" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label={caption} value={value} onChange={e=>change(e.target.value)}><option value="">Choose waypoint</option>{visible.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}{current&&!visible.includes(current)&&<option value={current.value}>{current.label}</option>}</select></label>;
}
