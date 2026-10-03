import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph, ScanFeature, ScanFeatures } from './data.ts';
import { checkEdge } from './geometry.ts';
import { addWaypoint, connectWaypoints, deleteWaypoint, updateWaypoint } from './graphEdit.ts';
import { findRoute } from './routing.ts';
const matrix = (x: number, y: number, z: number, vertical = false) => vertical
  ? [0,0,1,0, 0,1,0,0, -1,0,0,0, x,y,z,1]
  : [1,0,0,0, 0,0,1,0, 0,-1,0,0, x,y,z,1];
const feature = (identifier: string, dimensions: [number,number,number], position: [number,number,number], vertical = false): ScanFeature =>
  ({ identifier, category: vertical ? 'wall' : 'floor', dimensions, position, story: 0, transformColumnMajor: matrix(...position, vertical) });
const scan: ScanFeatures = { floors: [feature('floor', [10,10,0], [0,0,0])], walls: [feature('wall', [10,2,0], [0,1,0], true)], doors: [
  { ...feature('door', [2,2,0], [0,1,0], true), category: 'door-open', parentIdentifier: 'wall' }], openings: [], windows: [], objects: [] };
const nodes = [
  { id:'a', floor:'ground', type:'waypoint', position:[-2,0,-2] as [number,number,number] },
  { id:'b', floor:'ground', type:'waypoint', position:[2,0,-2] as [number,number,number] },
  { id:'left', floor:'ground', type:'door', position:[-1,0,0] as [number,number,number] },
  { id:'right', floor:'ground', type:'door', position:[1,0,0] as [number,number,number] },
];
const graph: Graph = { floors:[{id:'ground',story:0,elevation:0}], nodes, edges:[
  {from:'a',to:'b',kind:'hallway',meters:4,source:'manual'},
  {from:'a',to:'left',kind:'hallway',meters:2.24,source:'manual'},
  {from:'left',to:'right',kind:'hallway',meters:2,source:'manual'},
  {from:'right',to:'b',kind:'hallway',meters:2.24,source:'manual'},
] };
test('wall blocks nearby waypoints; doorway detour works', () => {
  assert.equal(checkEdge(graph.edges[0], graph, scan).status, 'blocked');
  const result = findRoute({graph,startId:'a',destinationId:'b',options:{scan}});
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.nodes.map(node=>node.id), ['a','left','right','b']);
});
test('hallway corner route remains inside floor polygon', () => {
  const cornerScan = structuredClone(scan);
  cornerScan.walls = []; cornerScan.doors = [];
  cornerScan.floors[0].polygonCorners = [[-5,-5,0],[5,-5,0],[5,-3,0],[-3,-3,0],[-3,5,0],[-5,5,0]];
  const g: Graph = {floors:graph.floors,nodes:[
    {id:'a',floor:'ground',type:'waypoint',position:[-4,0,4]},
    {id:'turn',floor:'ground',type:'waypoint',position:[-4,0,-4]},
    {id:'b',floor:'ground',type:'waypoint',position:[4,0,-4]},
  ],edges:[{from:'a',to:'b',kind:'hallway',meters:8,source:'manual'},{from:'a',to:'turn',kind:'hallway',meters:8,source:'manual'},{from:'turn',to:'b',kind:'hallway',meters:8,source:'manual'}]};
  const result=findRoute({graph:g,startId:'a',destinationId:'b',options:{scan:cornerScan}});
  assert.equal(result.ok,true);
  if(result.ok) assert.deepEqual(result.nodes.map(node=>node.id),['a','turn','b']);
});
test('cross-floor route requires explicit stairs', () => {
  const g: Graph={floors:[{id:'ground',story:0,elevation:0},{id:'upper',story:1,elevation:3}],nodes:[
    {id:'bottom',floor:'ground',type:'stairs',position:[0,0,0]}, {id:'top',floor:'upper',type:'stairs',position:[0,3,0]}],
    edges:[{from:'bottom',to:'top',kind:'stairs',meters:4,source:'manual'}]};
  const result=findRoute({graph:g,startId:'bottom',destinationId:'top'});
  assert.equal(result.ok,true);
  if(result.ok) assert.equal(result.floorTransitions,1);
  assert.equal(checkEdge({...g.edges[0],kind:'hallway'},g).status,'blocked');
});
test('editing recalculates distances, removes dangling edges, rejects unsafe points', () => {
  const moved=updateWaypoint(graph,{...nodes[0],position:[-3,0,-2]},scan);
  assert.equal(moved.graph.edges.find(edge=>edge.from==='a'&&edge.to==='left')?.meters,Math.hypot(2,2));
  assert.throws(()=>connectWaypoints({...graph,edges:[]},'a','b',scan));
  const deleted=deleteWaypoint(graph,'left');
  assert.ok(deleted.graph.edges.every(edge=>edge.from!=='left'&&edge.to!=='left'));
  assert.throws(()=>addWaypoint(graph,{id:'bad',floor:'ground',type:'waypoint',position:[20,0,20]},scan));
  const rerouted=findRoute({graph:deleted.graph,startId:'a',destinationId:'b',options:{scan}});
  assert.deepEqual(rerouted,{ok:false,reason:'no-walkable-route',message:'No walkable route found.'});
});
test('invalid endpoints, disconnected graphs, and unscanned confirmation',()=>{
  assert.equal(findRoute({graph,startId:'missing',destinationId:'b',options:{scan}}).ok,false);
  const disconnected={...graph,edges:[]};
  assert.equal(findRoute({graph:disconnected,startId:'a',destinationId:'b',options:{scan}}).ok,false);
  assert.equal(checkEdge(graph.edges[1],graph).status,'unverified');
  assert.equal(checkEdge({...graph.edges[1],source:'visibility'},graph).status,'blocked');
});
