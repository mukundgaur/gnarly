import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZoneView } from './data.ts';
import { stackBuilding, stackPoint } from './buildingStack.ts';

const zone = (id:string, story:number, elevator:[number,number,number]):ZoneView => ({id,name:id,floorId:id,notice:'',graph:{floors:[{id,story,elevation:0}],edges:[],nodes:[{id:'lift',floor:id,type:'elevator',position:elevator}]}});

test('stacks floor files and aligns linked elevator points', () => {
  const floors=[zone('floor-1',1,[2,0,3]),zone('floor-2',2,[-4,0,8])];
  const stack=stackBuilding(floors,{schemaVersion:1,connections:[{from:{zoneId:'floor-1',nodeId:'lift'},to:{zoneId:'floor-2',nodeId:'lift'}}]});
  const bottom=stackPoint(stack[0],stack[0].graph.nodes[0].position);
  const top=stackPoint(stack[1],stack[1].graph.nodes[0].position);
  assert.deepEqual([bottom[0],bottom[2]],[top[0],top[2]]);
  assert.equal(top[1]-bottom[1],4);
});

test('uses floor names when independent scans all report story zero',()=>{
  const floors=[zone('floor-1',0,[0,0,0]),zone('floor-2',0,[0,0,0])];
  const stack=stackBuilding(floors);
  assert.equal(stack[1].offset[1]-stack[0].offset[1],4);
});
