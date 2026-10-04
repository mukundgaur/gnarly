export type Floor={id:string;story:number;elevation:number;name?:string};
export type Node={id:string;floor:string;type:string;position:[number,number,number];label?:string|null;source?:string;roomPlanIdentifier?:string|null};
export type Edge={from:string;to:string;kind:string;meters:number;bidirectional?:boolean;source?:string};
export type Graph={floors:Floor[];nodes:Node[];edges:Edge[];schemaVersion?:number;zoneId?:string;coordinateSystem?:string;heightReference?:string;capturedAt?:string;notes?:string};
export type ScanFeature={identifier:string;category:string;story?:number;dimensions:[number,number,number];position:[number,number,number];transformColumnMajor?:number[];parentIdentifier?:string|null;polygonCorners?:[number,number,number][]};
export type SurfaceColorFace={face:string;color:[number,number,number];coverage:number;rect?:[number,number,number,number]};
export type SurfaceColors={atlasUrl?:string;atlasWidth:number;atlasHeight:number;surfaces:Record<string,Record<string,SurfaceColorFace>>};
export type ScanFeatures={walls:ScanFeature[];doors:ScanFeature[];openings:ScanFeature[];windows:ScanFeature[];floors:ScanFeature[];objects:ScanFeature[];colors?:SurfaceColors};
export type ZoneNodeRef={zoneId:string;nodeId:string};
export type ZoneConnectionKind='elevator'|'continuation'|'stairs';
export type ZoneConnection={from:ZoneNodeRef;to:ZoneNodeRef;kind?:ZoneConnectionKind};
export type ZoneConnections={schemaVersion:1;connections:ZoneConnection[];notes?:string};
/** Authored display layout.  This deliberately never changes a zone's ARKit coordinates. */
export type ZoneLayout={zoneId:string;floor:number;x:number;z:number;rotationDegrees:number};
export type FloorName={floor:number;name:string};
export type BuildingLayout={schemaVersion:1;zones:ZoneLayout[];floors?:FloorName[];notes?:string};
export type ZoneView={id:string;name:string;floorId:string;graph:Graph;scan?:ScanFeatures;notice:string;graphPath?:string};
export type Building={id:string;name:string;status:string;activeVersion?:string|null;viewingPreviousVersion?:boolean;lat?:number;lng?:number;graph?:Graph;scan?:ScanFeatures;zoneId?:string;zones?:ZoneView[];zoneConnections?:ZoneConnections;zoneConnectionsPath?:string;layout?:BuildingLayout;layoutPath?:string;demo?:boolean;structurePath?:string|null;notice?:string;graphPath?:string};
export const demoGraph:Graph={floors:[{id:'ground',story:0,elevation:0,name:'Ground floor'},{id:'upper',story:1,elevation:3.4,name:'Second floor'}],nodes:[{id:'entrance',floor:'ground',type:'entrance',position:[-8,0,6],label:'Main entrance'},{id:'hall-west',floor:'ground',type:'hallway',position:[-4,0,6]},{id:'hall-center',floor:'ground',type:'hallway',position:[1,0,6]},{id:'stairs-bottom',floor:'ground',type:'stairs',position:[5,0,6],label:'Stairwell A'},{id:'stairs-top',floor:'upper',type:'stairs',position:[5,3.4,6],label:'Stairwell A'},{id:'upper-hall',floor:'upper',type:'hallway',position:[5,3.4,0]},{id:'room-204',floor:'upper',type:'destination',position:[8,3.4,-3],label:'Room 204'},{id:'room-202',floor:'upper',type:'destination',position:[1,3.4,-3],label:'Room 202'},{id:'lobby',floor:'ground',type:'destination',position:[-5,0,-2],label:'Lobby'}],edges:[{from:'entrance',to:'hall-west',kind:'hallway',meters:4},{from:'hall-west',to:'hall-center',kind:'hallway',meters:5},{from:'hall-center',to:'stairs-bottom',kind:'hallway',meters:4},{from:'stairs-bottom',to:'stairs-top',kind:'stairs',meters:5},{from:'stairs-top',to:'upper-hall',kind:'hallway',meters:6},{from:'upper-hall',to:'room-204',kind:'hallway',meters:4.2},{from:'upper-hall',to:'room-202',kind:'hallway',meters:4.2},{from:'hall-west',to:'lobby',kind:'hallway',meters:8}]};
demoGraph.edges.forEach(edge=>{edge.source='manual'});
const demoFloorGraph=(floorId:string,elevatorId:string):Graph=>{const sourceFloor=demoGraph.floors.find(item=>item.id===floorId)!;const sourceNodes=demoGraph.nodes.filter(node=>node.floor===floorId);const rename=(id:string)=>id===elevatorId?'elevator-east':id;const nodes=sourceNodes.map(node=>({...node,id:rename(node.id),type:node.id===elevatorId?'elevator':node.type,label:node.id===elevatorId?'East elevator':node.label,position:[node.position[0],0,node.position[2]] as [number,number,number]}));const ids=new Set(sourceNodes.map(node=>node.id));return{schemaVersion:1,zoneId:'floor-'+(sourceFloor.story+1),coordinateSystem:'arkit-world-meters',heightReference:'floor',floors:[{...sourceFloor,elevation:0}],nodes,edges:demoGraph.edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to)).map(edge=>({...edge,from:rename(edge.from),to:rename(edge.to)}))}};
const demoFloor1=demoFloorGraph('ground','stairs-bottom'),demoFloor2=demoFloorGraph('upper','stairs-top');
demoFloor1.nodes.push({id:'zone-end-a',floor:'ground',type:'continuation',position:[1,0,10],label:'Zone end'},{id:'zone-end-b',floor:'ground',type:'continuation',position:[-4,0,10],label:'Zone end'});
demoFloor1.edges.push({from:'hall-center',to:'zone-end-a',kind:'hallway',meters:4,source:'manual'},{from:'hall-west',to:'zone-end-b',kind:'hallway',meters:4,source:'manual'});
/** A second Floor 1 scan. Its ARKit frame is rotated 90° from the first, so joining it exercises alignment. */
const demoFloor1East:Graph={schemaVersion:1,zoneId:'floor-1-east',coordinateSystem:'arkit-world-meters',heightReference:'floor',floors:[{id:'ground',story:0,elevation:0,name:'Ground floor'}],nodes:[
  {id:'zone-start-a',floor:'ground',type:'continuation',position:[0,0,1],label:'Zone start'},
  {id:'zone-start-b',floor:'ground',type:'continuation',position:[0,0,-4],label:'Zone start'},
  {id:'east-hall',floor:'ground',type:'hallway',position:[-4,0,-1.5]},
  {id:'cafe',floor:'ground',type:'destination',position:[-8,0,1],label:'Café'},
  {id:'reading-room',floor:'ground',type:'destination',position:[-8,0,-4],label:'Reading room'},
],edges:[
  {from:'zone-start-a',to:'east-hall',kind:'hallway',meters:4.7,source:'manual'},
  {from:'zone-start-b',to:'east-hall',kind:'hallway',meters:4.7,source:'manual'},
  {from:'east-hall',to:'cafe',kind:'hallway',meters:4.7,source:'manual'},
  {from:'east-hall',to:'reading-room',kind:'hallway',meters:4.7,source:'manual'},
]};
const demoZones:ZoneView[]=[{id:'floor-1',name:'Floor 1 west',floorId:'ground',graph:demoFloor1,notice:'Illustrative floor file.'},{id:'floor-1-east',name:'Floor 1 east',floorId:'ground',graph:demoFloor1East,notice:'Illustrative second scan of floor 1.'},{id:'floor-2',name:'Floor 2',floorId:'upper',graph:demoFloor2,notice:'Illustrative floor file.'}];
export const demoBuilding:Building={id:'demo-cornell',name:'North Hall',status:'Demo map',activeVersion:'sample-v1',lat:42.4536,lng:-76.4735,graph:demoFloor1,zoneId:'floor-1',zones:demoZones,zoneConnections:{schemaVersion:1,connections:[
  {from:{zoneId:'floor-1',nodeId:'elevator-east'},to:{zoneId:'floor-2',nodeId:'elevator-east'},kind:'elevator'},
  {from:{zoneId:'floor-1',nodeId:'zone-end-a'},to:{zoneId:'floor-1-east',nodeId:'zone-start-a'},kind:'continuation'},
  {from:{zoneId:'floor-1',nodeId:'zone-end-b'},to:{zoneId:'floor-1-east',nodeId:'zone-start-b'},kind:'continuation'},
]},demo:true,notice:'Illustrative two-floor building: floor 1 is two joined scan zones, and an elevator links it to floor 2. No Cornell scan or live AR data.'};
