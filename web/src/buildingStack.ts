import type { Node, ZoneConnections, ZoneView } from './data.ts';

export type StackZone = ZoneView & { story: number; offset: [number, number, number] };

function zoneStory(zone: ZoneView, index: number): number {
  const floor = zone.graph.floors.find(item => item.id === zone.floorId) || zone.graph.floors[0];
  if (Number.isFinite(floor?.story)) return floor!.story;
  const number = Number((zone.name + ' ' + zone.id).match(/-?\d+/)?.[0]);
  return Number.isFinite(number) ? number : index;
}

function namedStory(zone:ZoneView):number|undefined{const value=Number((zone.floorId+' '+zone.name+' '+zone.id).match(/-?\d+/)?.[0]);return Number.isFinite(value)?value:undefined}

function node(zone: ZoneView, id: string): Node | undefined {
  return zone.graph.nodes.find(item => item.id === id);
}

export function stackBuilding(zones: ZoneView[], links?: ZoneConnections, gap = 4): StackZone[] {
  let ordered = zones.map((zone, index) => ({ zone, story: zoneStory(zone, index) }));
  if(new Set(ordered.map(item=>item.story)).size<ordered.length){const named=ordered.map(item=>namedStory(item.zone));ordered=ordered.map((item,index)=>({...item,story:named[index]??index}))}
  // A continuation joins two scan files on the same physical floor.
  let joined=true;
  while(joined){joined=false;for(const link of links?.connections||[]){if(link.kind!=='continuation')continue;const from=ordered.find(item=>item.zone.id===link.from.zoneId),to=ordered.find(item=>item.zone.id===link.to.zoneId);if(!from||!to||from.story===to.story)continue;const story=Math.min(from.story,to.story);from.story=story;to.story=story;joined=true}}
  ordered=ordered
    .sort((a, b) => a.story - b.story || a.zone.name.localeCompare(b.zone.name));
  const minimum = ordered.length?Math.min(...ordered.map(item => item.story)):0;
  const offsets = new Map<string, [number, number]>();
  if (ordered[0]) offsets.set(ordered[0].zone.id, [0, 0]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links?.connections || []) {
      const fromZone = zones.find(item => item.id === link.from.zoneId);
      const toZone = zones.find(item => item.id === link.to.zoneId);
      const fromNode = fromZone && node(fromZone, link.from.nodeId);
      const toNode = toZone && node(toZone, link.to.nodeId);
      if (!fromZone || !toZone || !fromNode || !toNode) continue;
      const fromOffset = offsets.get(fromZone.id), toOffset = offsets.get(toZone.id);
      if (fromOffset && !toOffset) {
        offsets.set(toZone.id, [fromNode.position[0] + fromOffset[0] - toNode.position[0], fromNode.position[2] + fromOffset[1] - toNode.position[2]]);
        changed = true;
      } else if (toOffset && !fromOffset) {
        offsets.set(fromZone.id, [toNode.position[0] + toOffset[0] - fromNode.position[0], toNode.position[2] + toOffset[1] - fromNode.position[2]]);
        changed = true;
      }
    }
  }
  return ordered.map(({ zone, story }) => {
    const floor = zone.graph.floors.find(item => item.id === zone.floorId) || zone.graph.floors[0];
    const horizontal = offsets.get(zone.id) || [0, 0];
    return { ...zone, story, offset: [horizontal[0], (story - minimum) * gap - (floor?.elevation || 0), horizontal[1]] };
  });
}

export function stackPoint(zone: StackZone, position: [number, number, number]): [number, number, number] {
  return [position[0] + zone.offset[0], position[1] + zone.offset[1], position[2] + zone.offset[2]];
}
