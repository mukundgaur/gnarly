import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Box, CloudUpload, Eye, Footprints, HardDrive, Keyboard, Link, Magnet, MapPinPlus, MousePointer2, Move3d, Pencil, PersonStanding, Redo2, Scan, Spline, Square, Undo2, X } from 'lucide-react';
import Viewer, { type DropRequest, type FloorPick, type WalkLocation } from './Viewer';
import type { Building, BuildingLayout, Graph, Node, ZoneConnection, ZoneConnections, ZoneView } from './data.ts';
import { canEditFirebase } from './firebase.ts';
import { pointOnFloor } from './geometry.ts';
import { addWaypoint, autoConnect, connectWaypoints, deleteWaypoint, disconnectWaypoints, updateWaypoint, validateGraph } from './graphEdit.ts';
import { copyGraph, createGraphStore, readLocalGraph, type GraphSnapshot } from './graphStore.ts';
import { combineBuilding, elevatorFloorFit, findBuildingRoute, nodeKey, splitKey, zoneEdgeChecks, type ElevatorStop } from './buildingGraph.ts';
import { loadBuildingMeta, saveConnections, saveLayout, type DataMode } from './buildingStore.ts';
import { addZoneConnection, removeZoneConnection } from './zoneConnections.ts';
import { FLOOR_GAP, fitZone, moveFloor, toWorld, upsertZoneLayout } from './zoneAlign.ts';
import { planJoin, rotateAbout, withContinuation, zoneCenter, zonesNear, type Placement } from './zoneArrange.ts';
import Directions from './Directions';
import Outliner from './Outliner';
import { WaypointInspector, ZoneInspector } from './Inspector';
import { Kbd, ToolButton } from './ui.tsx';
import type { ElevatorSuggestion, JoinOption, LinkKind, PendingLink, Tool } from './workspaceShared.tsx';

type Props = { building: Building; onBack: () => void; onUpdate: (building: Building) => void; onDirtyChange?: (dirty:boolean)=>void };
type Tab = 'view' | 'edit';
type Status = 'loading' | 'saved' | 'unsynced' | 'saving' | 'failed' | 'conflict';
type HistoryEntry = { zoneId: string; graph: Graph | null; layout: BuildingLayout | undefined; layoutDirty: boolean; label: string };
/** Legacy packages have one version-level graph and no zone documents. */
const ROOT = 'root';
function zonesOf(building: Building): ZoneView[] {
  if (building.zones?.length) return building.zones;
  return [{ id: ROOT, name: building.name, floorId: building.graph!.floors[0]?.id || 'ground', graph: building.graph!, scan: building.scan, notice: building.notice || '', graphPath: building.graphPath }];
}
const zoneBuilding = (building: Building, zone: ZoneView): Building => ({ ...building, zoneId: zone.id === ROOT ? undefined : zone.id, graph: zone.graph, scan: zone.scan, graphPath: zone.graphPath });
const draftKey = (b: Building, mode: DataMode, zoneId: string) => ['gnarly-draft',mode,b.id,b.activeVersion||'sample',zoneId].join(':');
const walkerKey = (b: Building) => ['gnarly-walker',b.id,b.activeVersion||'sample'].join(':');
type SavedWalker={location:WalkLocation;walking:boolean};
function readWalker(building:Building):SavedWalker|null{try{const saved=JSON.parse(sessionStorage.getItem(walkerKey(building))||'null') as SavedWalker|null;return saved?.location?.zoneId?saved:null}catch{return null}}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const typingIn = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const TOOL_HINTS: Record<Tool, [string, string][]> = {
  select: [['Click', 'select'], ['Arrows', 'move on X / Z'], ['Green arrow', 'zone to another floor'], ['Ring', 'rotate'], ['Double-click', 'rename'], ['Del', 'delete']],
  add: [['Click floor', 'add waypoint'], ['Click waypoint', 'continue from it'], ['Esc', 'end chain']],
  connect: [['Click', 'waypoint to start'], ['Click again', 'connect'], ['Esc', 'stop']],
  arrange: [['Drag floor', 'move zone'], ['Arrows / ring', 'move / rotate'], ['G / R', 'keyboard move / rotate'], ['Ctrl', 'flip snapping']],
};

export default function BuildingWorkspace({building,onBack,onUpdate,onDirtyChange}:Props) {
  const zones=useMemo(()=>zonesOf(building),[building]);
  const [mode,setMode]=useState<DataMode>(building.demo||!canEditFirebase()?'local':'firebase');
  const [tab,setTab]=useState<Tab>('view');
  const [editZoneId,setEditZoneId]=useState(()=>zones.some(zone=>zone.id===building.zoneId)?building.zoneId!:zones[0].id);
  const editZone=zones.find(zone=>zone.id===editZoneId)||zones[0];
  const [sessionGraphs,setSessionGraphs]=useState<Record<string,Graph>>({});
  const savedZones=useMemo(()=>zones.map(zone=>({...zone,graph:sessionGraphs[zone.id]||(mode==='local'&&readLocalGraph(zoneBuilding(building,zone)))||zone.graph})),[zones,sessionGraphs,mode,building]);
  const store=useMemo(()=>createGraphStore(zoneBuilding(building,editZone),mode),[building.id,building.activeVersion,editZone.id,mode]);
  const key=draftKey(building,mode,editZoneId);

  const [base,setBase]=useState<GraphSnapshot|null>(null),[draft,setDraft]=useState<Graph|null>(null),[draftOwner,setDraftOwner]=useState(''),[remote,setRemote]=useState<GraphSnapshot|null>(null);
  const baseRef=useRef<GraphSnapshot|null>(null),savingRef=useRef(false),loadedKey=useRef<string|null>(null);
  const [status,setStatus]=useState<Status>('loading'),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [tool,setTool]=useState<Tool>('select'),[selectedKey,setSelectedKey]=useState(''),[place,setPlace]=useState(''),[renaming,setRenaming]=useState<{key:string;in:'tree'|'scene'}|null>(null);
  const [boundaryPlacement,setBoundaryPlacement]=useState<'start'|'end'|null>(null),[pendingLink,setPendingLink]=useState<PendingLink|null>(null);
  const [meta]=useState(()=>loadBuildingMeta(building,mode));
  const [connections,setConnections]=useState<ZoneConnections>(meta.connections),[layout,setLayout]=useState<BuildingLayout|undefined>(meta.layout);
  const [layoutDirty,setLayoutDirty]=useState(false),[layoutSaving,setLayoutSaving]=useState(false),[linkSaving,setLinkSaving]=useState(false);
  const [snapping,setSnapping]=useState(true),[autoLink,setAutoLink]=useState(true),[joining,setJoining]=useState(''),[cameraView,setCameraView]=useState<'iso'|'top'>('iso'),[shortcuts,setShortcuts]=useState(false);
  const [level,setLevel]=useState<number|'all'>('all'),[start,setStart]=useState(''),[destination,setDestination]=useState(''),[showRoute,setShowRoute]=useState(false),[step,setStep]=useState(0),[playing,setPlaying]=useState(false),[reset,setReset]=useState(0);
  const [walker,setWalker]=useState<WalkLocation|null>(()=>readWalker(building)?.location||null),[walking,setWalking]=useState(()=>Boolean(readWalker(building)?.walking)),[placingWalker,setPlacingWalker]=useState(false),[walkDrop,setWalkDrop]=useState<DropRequest|null>(null),[draggingWalker,setDraggingWalker]=useState(false),[elevatorStop,setElevatorStop]=useState<ElevatorStop|null>(null);
  const history=useRef<{past:HistoryEntry[];future:HistoryEntry[];lastKey?:string;lastAt:number}>({past:[],future:[],lastAt:0});
  const [,setHistoryTick]=useState(0);

  const editing=tab==='edit';
  const activeDraft=draftOwner===editZoneId?draft:null;
  const graph=activeDraft||savedZones.find(zone=>zone.id===editZoneId)!.graph;
  const scan=editZone.scan;
  const modelZones=useMemo(()=>savedZones.map(zone=>zone.id===editZoneId&&activeDraft?{...zone,graph:activeDraft}:zone),[savedZones,editZoneId,activeDraft]);
  const model=useMemo(()=>combineBuilding(modelZones,connections,layout),[modelZones,connections,layout]);
  const dirty=Boolean(base&&activeDraft&&JSON.stringify(base.graph)!==JSON.stringify(activeDraft));
  const selectedRef=selectedKey?splitKey(selectedKey):null;
  const selected=selectedRef?.zoneId===editZoneId?graph.nodes.find(node=>node.id===selectedRef.nodeId):undefined;
  const pending=dirty;
  const zoneLayout=model.layout.find(item=>item.zoneId===editZoneId)!;
  const current=useRef({pending});current.current={pending};
  const route=useMemo(()=>showRoute?findBuildingRoute(model,start,destination):null,[model,start,destination,showRoute]);
  const checks=useMemo(()=>zoneEdgeChecks(graph,scan),[graph,scan]);
  const blocked=graph.edges.filter((_,index)=>checks[index].status==='blocked');
  const newBlocked=useMemo(()=>{if(!base)return blocked;const baseChecks=zoneEdgeChecks(base.graph,scan);const previous=new Set(base.graph.edges.filter((edge,index)=>baseChecks[index].status==='blocked').map(edge=>JSON.stringify(edge)));return blocked.filter(edge=>!previous.has(JSON.stringify(edge)))},[base,blocked,scan]);
  const issues=useMemo(()=>validateGraph(graph),[graph]);
  const awaitingLinkHere=Boolean(pendingLink&&pendingLink.targetZoneId===editZoneId&&!pendingLink.toNodeId);

  useEffect(()=>onDirtyChange?.(pending||layoutDirty),[pending,layoutDirty,onDirtyChange]);
  useEffect(()=>{history.current={past:[],future:[],lastAt:0};setHistoryTick(t=>t+1)},[editZoneId,mode]);
  useEffect(()=>{
    let live=true,receivedSubscription=false;baseRef.current=null;loadedKey.current=null;
    setStatus('loading');setBase(null);setDraft(null);setDraftOwner('');setRemote(null);setError('');
    const zoneId=editZoneId;
    function received(snapshot:GraphSnapshot){
      if(!live||savingRef.current||baseRef.current?.revision===snapshot.revision)return;loadedKey.current=key;
      if(baseRef.current && current.current.pending){setRemote(snapshot);setStatus('conflict');return;}
      if(!baseRef.current){
        try{
          const saved=sessionStorage.getItem(key)||localStorage.getItem(key);
          if(saved){
            const local=JSON.parse(saved) as {base:GraphSnapshot;graph:Graph};
            if(!local.base?.graph || !local.graph?.nodes || !local.graph?.edges)throw Error('Invalid draft');
            baseRef.current=local.base;setBase(local.base);setDraft(local.graph);setDraftOwner(zoneId);
            setRemote(local.base.revision===snapshot.revision?null:snapshot);setStatus(local.base.revision===snapshot.revision?'unsynced':'conflict');
            setNotice('Recovered your unsaved draft in this tab.');
            localStorage.removeItem(key);return;
          }
        }catch{setError('The stored draft could not be restored. The saved graph has been loaded.');sessionStorage.removeItem(key)}
      }
      baseRef.current=snapshot;setBase(snapshot);setDraft(copyGraph(snapshot.graph));setDraftOwner(zoneId);setRemote(null);setStatus('saved');
    }
    store.load().then(snapshot=>{if(!receivedSubscription)received(snapshot)}).catch(e=>{if(live){setError(errorText(e));setStatus('failed')}});
    const unsubscribe=store.subscribe(snapshot=>{receivedSubscription=true;received(snapshot)},e=>{if(live)setError(e.message)});
    return()=>{live=false;unsubscribe()};
  },[store,key]);
  useEffect(()=>{if(!base||!activeDraft||loadedKey.current!==key)return;try{if(pending)sessionStorage.setItem(key,JSON.stringify({base,graph:activeDraft}));else sessionStorage.removeItem(key)}catch{setError('Browser draft backup is unavailable. Keep this tab open until you save.')}},[base,activeDraft,pending,key]);
  useEffect(()=>{if(!pending&&!layoutDirty)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[pending,layoutDirty]);
  useEffect(()=>{if(walker)sessionStorage.setItem(walkerKey(building),JSON.stringify({location:walker,walking} satisfies SavedWalker))},[walker,walking,building.id,building.activeVersion]);
  useEffect(()=>{
    if(!model.byKey.has(start))setStart(model.nodes.find(node=>node.type==='entrance')?.key||model.nodes[0]?.key||'');
    if(!model.byKey.has(destination))setDestination(model.nodes.filter(node=>node.type==='destination').at(-1)?.key||model.nodes.at(-1)?.key||'');
  },[model,start,destination]);
  useEffect(()=>{setStep(0);setPlaying(false)},[route]);
  useEffect(()=>{if(!playing||!route?.ok)return;const timer=window.setTimeout(()=>{if(step>=route.nodes.length-1){setPlaying(false);return}setStep(step+1);setLevel(route.nodes[step+1].level)},850);return()=>window.clearTimeout(timer)},[playing,route,step]);
  useEffect(()=>{if(awaitingLinkHere){setTab('edit');setTool('add');setNotice('Click the floor of '+editZone.name+' where the matching '+(pendingLink!.kind==='continuation'?'seam':'elevator')+' point belongs.')}},[awaitingLinkHere,editZone.name]);
  useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(''),6000);return()=>window.clearTimeout(timer)},[notice]);

  // ---------- History ----------
  function snapshot(label:string):HistoryEntry{return{zoneId:editZoneId,graph:activeDraft,layout,layoutDirty,label}}
  /** Records the state before an edit. Edits sharing a `coalesce` key within a moment (scrubbing, typing) undo as one. */
  function remember(label:string,coalesce?:string){
    const h=history.current,now=Date.now();
    if(coalesce&&h.lastKey===coalesce&&now-h.lastAt<900){h.lastAt=now;return}
    h.past.push(snapshot(label));if(h.past.length>200)h.past.shift();h.future=[];h.lastKey=coalesce;h.lastAt=now;setHistoryTick(t=>t+1);
  }
  function restore(entry:HistoryEntry){
    if(entry.zoneId===editZoneId&&entry.graph){setDraft(entry.graph);setDraftOwner(editZoneId);if(!remote)setStatus(base&&JSON.stringify(base.graph)===JSON.stringify(entry.graph)?'saved':'unsynced')}
    setLayout(entry.layout);setLayoutDirty(entry.layoutDirty);setError('');
  }
  function undo(){const h=history.current,entry=h.past.pop();if(!entry){setNotice('Nothing to undo.');return}h.future.push(snapshot(entry.label));h.lastKey=undefined;restore(entry);setNotice('Undid '+entry.label+'.');setHistoryTick(t=>t+1)}
  function redo(){const h=history.current,entry=h.future.pop();if(!entry){setNotice('Nothing to redo.');return}h.past.push(snapshot(entry.label));h.lastKey=undefined;restore(entry);setNotice('Redid '+entry.label+'.');setHistoryTick(t=>t+1)}

  function change(next:Graph,message='',label='edit',coalesce?:string){remember(label,coalesce);setDraft(next);setDraftOwner(editZoneId);setNotice(message);setError('');setPlaying(false);setStep(0);if(!remote)setStatus(base&&JSON.stringify(base.graph)===JSON.stringify(next)?'saved':'unsynced')}
  function switchZone(zoneId:string,keepTool=false){
    if(zoneId===editZoneId)return true;
    if(pending&&!window.confirm('Switch zones? Your unsaved draft for '+editZone.name+' will remain in this tab.'))return false;
    setEditZoneId(zoneId);setSelectedKey(previous=>previous&&splitKey(previous).zoneId===zoneId?previous:'');setBoundaryPlacement(null);if(!keepTool)setTool('select');
    return true;
  }
  function leave(){if((pending||layoutDirty)&&!window.confirm('Leave with unsaved edits? Applied graph edits will remain in this tab.'))return;onBack()}
  function modeChange(next:DataMode){
    if(next===mode)return;if((pending||layoutDirty)&&!window.confirm('Switch data modes? Your unsaved draft will remain in this tab.'))return;
    const nextMeta=loadBuildingMeta(building,next);setConnections(nextMeta.connections);setLayout(nextMeta.layout);setLayoutDirty(false);setSessionGraphs({});setPendingLink(null);setMode(next);
  }
  function connectPair(fromId:string,toId:string){try{change(connectWaypoints(graph,fromId,toId,scan),scan?.floors?.length?'Connected.':'Connected. No scan here, so it is marked unverified.','connect')}catch(e){setError(errorText(e))}}
  function selectNode(key:string){
    if(status==='saving')return;
    if(!editing){setPlace(key);return}
    const {zoneId,nodeId}=splitKey(key);
    if(tool==='connect'&&selected&&zoneId===editZoneId&&nodeId!==selected.id){connectPair(selected.id,nodeId);setSelectedKey(key);return}
    if(!switchZone(zoneId,true))return;
    setSelectedKey(key);setPlaying(false);
  }
  function editFloorPick(pick:FloorPick){
    if(tool==='arrange')return;
    if(tool==='select'||tool==='connect'){if(pick.zoneId!==editZoneId)switchZone(pick.zoneId,true);setSelectedKey('');return}
    if(pick.zoneId!==editZoneId){const zone=zones.find(item=>item.id===pick.zoneId);if(switchZone(pick.zoneId,true))setNotice('Now editing '+(zone?.name||pick.zoneId)+'. Click the floor again to place the point.');return}
    const nearest=graph.nodes.filter(node=>node.floor===pick.floorId).sort((a,b)=>Math.hypot(a.position[0]-pick.position[0],a.position[2]-pick.position[2])-Math.hypot(b.position[0]-pick.position[0],b.position[2]-pick.position[2]))[0];
    const point:[number,number,number]=[Math.round(pick.position[0]*100)/100,nearest?.position[1]??pick.position[1],Math.round(pick.position[2]*100)/100];
    if(!pointOnFloor(point,pick.floorId,graph,scan)){setError('Pick a position on the displayed floor.');return}
    try{
      const type:LinkKind|'waypoint'=awaitingLinkHere?pendingLink!.kind:boundaryPlacement?'continuation':'waypoint';
      const id=(type==='elevator'?'elevator-':type==='continuation'?'zone-'+(boundaryPlacement||'continuation')+'-':'wp-')+crypto.randomUUID().slice(0,8);
      const label=type==='elevator'?'Elevator':type==='continuation'?(boundaryPlacement==='start'?'Zone start':boundaryPlacement==='end'?'Zone end':'Zone continuation'):'';
      let next=addWaypoint(graph,{id,floor:pick.floorId,type,position:point,label,source:'manual'},scan),linked=false;
      if(autoLink&&type==='waypoint'&&selected&&selected.floor===pick.floorId){try{next=connectWaypoints(next,selected.id,id,scan);linked=true}catch{/* a wall is in the way; leave it unconnected */}}
      const message=awaitingLinkHere?'Matching point added. Connect it to a walkable waypoint here, then save and link it.':type==='continuation'?'Seam point added. Connect it to a walkable waypoint here.':linked?'':selected&&autoLink?'Added, but not linked: a wall is in the way.':'';
      change(next,message,'add waypoint');
      setSelectedKey(nodeKey(editZoneId,id));setBoundaryPlacement(null);
      if(awaitingLinkHere)setPendingLink({...pendingLink!,toNodeId:id});
      if(awaitingLinkHere||boundaryPlacement)setTool('select');
    }catch(e){setError(errorText(e))}
  }
  function placeWalker(location:WalkLocation|null){
    setDraggingWalker(false);
    if(!location){setError('Drop the person onto a visible floor inside the building.');return}
    const zone=modelZones.find(item=>item.id===location.zoneId);
    if(!zone){setError('Drop the person onto a visible floor inside the building.');return}
    const floorInfo=zone.graph.floors.find(item=>item.id===location.floorId);
    const position:[number,number,number]=[location.position[0],zone.scan?.floors?.length?location.position[1]:floorInfo?.elevation??location.position[1],location.position[2]];
    if(!pointOnFloor(position,location.floorId,zone.graph,zone.scan)){setError('Drop the person onto a walkable part of the floor.');return}
    setWalker({position,floorId:location.floorId,zoneId:zone.id});setLevel(model.levelOf(zone.id,location.floorId));setWalking(true);setPlacingWalker(false);setPlaying(false);setError('');
  }
  function walkFrom(key:string){const node=model.byKey.get(key);if(!node)return;placeWalker({position:node.position,floorId:node.floor,zoneId:node.zoneId})}
  function viewerFloorPick(pick:FloorPick){if(placingWalker)placeWalker(pick);else if(editing)editFloorPick(pick)}
  function moveWalker(location:WalkLocation){setWalker(location);setLevel(model.levelOf(location.zoneId,location.floorId))}
  const floorLabel=(level:number)=>model.floors.find(item=>item.level===level)?.name||'Floor '+level;
  function walkKey(code:string,down:boolean){window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true}))}
  function editWaypoint(patch:Partial<Node>,label:string,coalesce?:string){
    if(!selected)return;
    try{const result=updateWaypoint(graph,{...selected,...patch},scan);change(result.graph,result.removedEdges.length?result.removedEdges.length+' connection(s) would cross a wall and were removed. Ctrl+Z to undo.':'',label,coalesce)}catch(e){setError(errorText(e))}
  }
  function startRename(key:string,where:'tree'|'scene'){
    if(!editing||status==='saving')return;
    if(!switchZone(splitKey(key).zoneId,true))return;
    setSelectedKey(key);setRenaming({key,in:where});
  }
  function finishRename(key:string,name:string|null){
    setRenaming(null);
    const {zoneId,nodeId}=splitKey(key),node=graph.nodes.find(item=>item.id===nodeId);
    if(name===null||zoneId!==editZoneId||!node)return;
    const label=name.trim();if(label===(node.label||''))return;
    try{change(updateWaypoint(graph,{...node,label:label||null},scan).graph,label?'Renamed to '+label+'.':'Name cleared.','rename','name:'+nodeId)}catch(e){setError(errorText(e))}
  }
  function moveWaypointTo(key:string,position:[number,number,number]){
    const node=graph.nodes.find(item=>item.id===splitKey(key).nodeId);if(!node)return;
    try{const result=updateWaypoint(graph,{...node,position},scan);change(result.graph,result.removedEdges.length?result.removedEdges.length+' connection(s) would cross a wall and were removed. Ctrl+Z to undo.':'','move waypoint');setSelectedKey(key)}catch(e){setError(errorText(e))}
  }
  const zoneLinks=connections.connections.filter(item=>item.from.zoneId===editZoneId||item.to.zoneId===editZoneId);
  function remove(){if(!selected)return;const external=zoneLinks.filter(item=>(item.from.zoneId===editZoneId&&item.from.nodeId===selected.id)||(item.to.zoneId===editZoneId&&item.to.nodeId===selected.id));if(external.length){setError('Remove this waypoint’s '+external.length+' zone link(s) before deleting it.');return}change(deleteWaypoint(graph,selected.id).graph,'Deleted '+(selected.label||selected.id)+'. Ctrl+Z to undo.','delete waypoint');setSelectedKey('')}
  function runAutoConnect(){if(!scan?.floors?.length){setError('Auto-connect needs this zone’s scan to check walls. Connect waypoints with the Connect tool instead.');return}const result=autoConnect(graph,scan);change(result.graph,result.added.length?result.added.length+' wall-checked connection(s) added.':'No new connections: every visible pair is already connected or blocked by walls.','auto-connect')}
  async function save():Promise<GraphSnapshot|null>{
    if(!base||!activeDraft||savingRef.current)return null;
    if(issues.length||newBlocked.length){setError('Resolve '+issues.length+' graph error(s) and '+newBlocked.length+' newly blocked connection(s) before saving.');return null}
    if(remote){setStatus('conflict');return null}
    savingRef.current=true;setStatus('saving');setError('');
    try{
      const saved=await store.save(activeDraft,base);baseRef.current=saved;setBase(saved);setDraft(copyGraph(saved.graph));setDraftOwner(editZoneId);setStatus('saved');sessionStorage.removeItem(key);
      setSessionGraphs(previous=>({...previous,[editZoneId]:saved.graph}));
      setNotice(mode==='firebase'?'Saved to Firebase.':'Saved in this browser only · not synced.');
      if(mode==='firebase')onUpdate(editZoneId===ROOT?{...building,graph:saved.graph,graphPath:saved.path}:{...building,zones:building.zones?.map(zone=>zone.id===editZoneId?{...zone,graph:saved.graph,graphPath:saved.path}:zone),...(building.zoneId===editZoneId?{graph:saved.graph,graphPath:saved.path}:{})});
      return saved;
    }catch(e){setStatus('failed');setError(errorText(e));return null}
    finally{savingRef.current=false;void store.load().then(latest=>{if(latest.revision!==baseRef.current?.revision){setRemote(latest);setStatus('conflict')}}).catch(()=>{})}
  }
  async function saveAll(){if(dirty&&!await save())return;if(layoutDirty)await persistLayout()}
  function cancel(){const saved=remote||base;if(!saved)return;remember('discard edits');baseRef.current=saved;setBase(saved);setDraft(copyGraph(saved.graph));setDraftOwner(editZoneId);setSelectedKey('');setRemote(null);setError('');setNotice('Restored the latest saved graph. Ctrl+Z brings your edits back.');setStatus('saved');sessionStorage.removeItem(key)}
  function resolveConflict(useRemote:boolean){if(!remote)return;if(useRemote){if(!window.confirm('Discard your draft and load the remote graph?'))return;baseRef.current=remote;setBase(remote);setDraft(copyGraph(remote.graph));setDraftOwner(editZoneId);sessionStorage.removeItem(key);setSelectedKey('');setStatus('saved')}
    else{if(!window.confirm('This will keep your complete draft as the next graph. Changes made in the remote graph since you started will not appear in it. The previous graph file remains in Storage. Continue only after reviewing both versions.'))return;baseRef.current=remote;setBase(remote);setStatus('unsynced');setNotice('Your draft is based on the latest revision. Review all connections before saving; the prior graph file remains in Storage.')}setRemote(null)}

  // ---------- Zone placement ----------
  /** Authors every zone's current placement so adjusting one zone does not drag auto-fitted neighbors along with it. */
  function pinned(from:BuildingLayout|undefined):BuildingLayout{return model.layout.reduce((current,item)=>current.zones.some(zone=>zone.zoneId===item.zoneId)?current:upsertZoneLayout(current,item),from||{schemaVersion:1,zones:[]})}
  function updateLayout(update:(current:BuildingLayout)=>BuildingLayout,label:string,coalesce?:string){remember(label,coalesce);setLayout(previous=>update(pinned(previous)));setLayoutDirty(true)}
  function changeLayout(field:'floor'|'x'|'z'|'rotationDegrees',value:number){if(!Number.isFinite(value))return;updateLayout(current=>upsertZoneLayout(current,{...zoneLayout,[field]:value}),field==='floor'?'change floor level':'move zone','layout:'+field+':'+editZoneId)}
  const floorNameValue=layout?.floors?.find(item=>item.floor===zoneLayout.floor)?.name||'';
  function renameFloor(floor:number,name:string){updateLayout(current=>{const floors=(current.floors||[]).filter(item=>item.floor!==floor);return{...current,floors:name.trim()?[...floors,{floor,name}]:floors}},'rename floor','floor-name:'+floor)}
  const setFloorName=(name:string)=>renameFloor(zoneLayout.floor,name);
  /** Moves a zone onto the floor of its continuation neighbors and fits it to their shared points. */
  function alignedLayout(zoneId:string,links:ZoneConnections,zoneViews:ZoneView[],from:BuildingLayout|undefined):BuildingLayout|null{
    const others=new Map(model.layout.filter(item=>item.zoneId!==zoneId).map(item=>[item.zoneId,item]));
    const own=model.layout.find(item=>item.zoneId===zoneId)!;
    const fit=fitZone(zoneId,zoneViews,links,others,own.rotationDegrees);
    if(!fit)return null;
    const neighbor=links.connections.find(item=>item.kind==='continuation'&&(item.from.zoneId===zoneId||item.to.zoneId===zoneId));
    const neighborId=neighbor&&(neighbor.from.zoneId===zoneId?neighbor.to.zoneId:neighbor.from.zoneId);
    return upsertZoneLayout(pinned(from),{...own,floor:(neighborId?others.get(neighborId)?.floor:undefined)??own.floor,...fit});
  }
  function applyFloorMove(move:{x:number;z:number;rotationDegrees:number},pivot:[number,number]){updateLayout(current=>({...current,zones:moveFloor(current.zones,zoneLayout.floor,move,pivot)}),'move floor')}
  function shiftFloor(move:{x:number;z:number;rotationDegrees:number}){
    const points=model.nodes.filter(node=>model.transforms.get(node.zoneId)?.floor===zoneLayout.floor);
    const pivot:[number,number]=points.length?[points.reduce((sum,node)=>sum+node.world[0],0)/points.length,points.reduce((sum,node)=>sum+node.world[2],0)/points.length]:[0,0];
    applyFloorMove(move,pivot);
  }
  function alignFloorToElevators(){
    const fit=elevatorFloorFit(model,zoneLayout.floor);
    if(!fit){setError('Link an elevator on this floor to an elevator on another floor first.');return}
    applyFloorMove(fit.move,[0,0]);setError('');
    setNotice('Lined up this floor with '+(model.floors.find(floor=>floor.level===fit.reference)?.name||'Floor '+fit.reference)+' using '+fit.pairs+' elevator'+(fit.pairs>1?'s':'')+(fit.pairs>1?'':' (position only; link a second elevator to also fix rotation)')+'.');
  }
  function autoAlign(){const next=alignedLayout(editZoneId,connections,modelZones,layout);if(!next){setError('Join this zone to a neighbor first.');return}remember('re-fit zone');setLayout(next);setLayoutDirty(true);setNotice('Re-fitted to the joined zone(s).')}
  async function persistLayout(next=layout){
    setLayoutSaving(true);setError('');
    try{const saved=await saveLayout(building,mode,next||{schemaVersion:1,zones:[]});setLayout(saved);setLayoutDirty(false);if(mode==='firebase')onUpdate({...building,layout:saved});setNotice('Zone placement saved'+(mode==='firebase'?' to Firebase.':' in this browser.'));return true}
    catch(e){setError(errorText(e));return false}finally{setLayoutSaving(false)}
  }
  async function persistConnections(next:ZoneConnections,message:string){
    setLinkSaving(true);setError('');
    try{const saved=await saveConnections(building,mode,next);setConnections(saved);if(mode==='firebase')onUpdate({...building,zoneConnections:saved});setNotice(message);return true}
    catch(e){setError(errorText(e));return false}finally{setLinkSaving(false)}
  }
  async function link(connection:ZoneConnection,zoneViews:ZoneView[]){
    const next=addZoneConnection(connections,connection,zoneViews,{levelOf:model.levelOf});
    if(!await persistConnections(next,connection.kind==='elevator'?'Elevator linked. Routes can now ride between these floors.':'Zones joined on one floor.'))return false;
    if(connection.kind==='continuation'){
      const moving=connection.to.zoneId;
      const aligned=alignedLayout(moving,next,zoneViews,layout);
      if(aligned){setLayout(aligned);await persistLayout(aligned);setNotice('Zones joined. '+(zones.find(zone=>zone.id===moving)?.name||moving)+' was aligned onto this floor.')}
    }
    return true;
  }
  /** Links reference saved waypoints, so unsaved edits in this zone are saved first. */
  async function zonesAfterSave():Promise<ZoneView[]|null>{
    if(!pending)return modelZones;
    const saved=await save();
    return saved?modelZones.map(zone=>zone.id===editZoneId?{...zone,graph:saved.graph}:zone):null;
  }
  async function linkWaypoint(nodeId:string,kind:LinkKind,otherKey:string){
    const zoneViews=await zonesAfterSave();if(!zoneViews)return;
    try{await link({from:{zoneId:editZoneId,nodeId},to:splitKey(otherKey),kind},zoneViews)}catch(e){setError(errorText(e))}
  }
  async function linkExisting(kind:LinkKind,otherKey:string){if(selected)await linkWaypoint(selected.id,kind,otherKey)}
  async function unjoin(otherId:string){
    const between=connections.connections.filter(item=>item.kind!=='elevator'&&((item.from.zoneId===editZoneId&&item.to.zoneId===otherId)||(item.to.zoneId===editZoneId&&item.from.zoneId===otherId)));
    if(!between.length||!window.confirm('Unjoin '+editZone.name+' and '+zoneName(otherId)+'? Routes will stop walking between them.'))return;
    await persistConnections(between.reduce((current,item)=>removeZoneConnection(current,item),connections),'Unjoined '+editZone.name+' and '+zoneName(otherId)+'.');
  }
  async function beginPlacement(kind:LinkKind,targetZoneId:string,targetLevel:number){
    if(!selected)return;
    const from={zoneId:editZoneId,nodeId:selected.id};
    if(!await zonesAfterSave())return;
    setEditZoneId(targetZoneId);setSelectedKey('');setBoundaryPlacement(null);
    setPendingLink({from,kind,targetZoneId});setLevel(targetLevel);setTool('add');
  }
  async function finishPendingLink(){
    if(!pendingLink?.toNodeId)return;
    let zoneViews=modelZones;
    if(pending){const saved=await save();if(!saved)return;zoneViews=modelZones.map(zone=>zone.id===editZoneId?{...zone,graph:saved.graph}:zone)}
    try{if(await link({from:pendingLink.from,to:{zoneId:editZoneId,nodeId:pendingLink.toNodeId},kind:pendingLink.kind},zoneViews)){setPendingLink(null);setTool('select')}}catch(e){setError(errorText(e))}
  }
  async function deleteZoneLink(connection:ZoneConnection){if(!window.confirm('Remove this link between zones?'))return;await persistConnections(removeZoneConnection(connections,connection),'Zone link removed.')}
  function beginBoundaryPlacement(end:'start'|'end'){setBoundaryPlacement(end);setTool('add');setNotice('Click the '+end+' of this zone to place a seam point.')}
  const zoneName=(zoneId:string)=>zones.find(zone=>zone.id===zoneId)?.name||zoneId;
  function commitArrange(zoneId:string,placement:Placement){
    const entry=model.layout.find(item=>item.zoneId===zoneId);if(!entry)return;
    updateLayout(current=>upsertZoneLayout(current,{...entry,...placement}),'arrange '+zoneName(zoneId));setError('');
  }
  function moveZoneToLevel(zoneId:string,target:number){
    const entry=model.layout.find(item=>item.zoneId===zoneId);if(!entry||entry.floor===target)return;
    updateLayout(current=>upsertZoneLayout(current,{...entry,floor:target}),'move to another floor');
    if(level!=='all')setLevel(target);
    setNotice('Moved '+zoneName(zoneId)+' to '+(model.floors.find(floor=>floor.level===target)?.name||'level '+target)+'. Ctrl+Z to undo.');
  }
  function rotateZone(degrees:number){
    const zone=modelZones.find(item=>item.id===editZoneId);if(!zone)return;
    commitArrange(editZoneId,rotateAbout(zoneLayout,zoneCenter(zone),degrees));
  }
  const joinOptions=useMemo<JoinOption[]>(()=>{
    if(!editing)return [];
    const own=modelZones.find(zone=>zone.id===editZoneId),ownT=model.transforms.get(editZoneId);if(!own||!ownT)return [];
    const zoneOf=(key:string)=>model.byKey.get(key)?.zoneId;
    return model.layout.filter(item=>item.zoneId!==editZoneId&&item.floor===zoneLayout.floor).map(item=>{
      const other=modelZones.find(zone=>zone.id===item.zoneId)!;
      const joined=connections.connections.some(link=>link.kind!=='elevator'&&((link.from.zoneId===editZoneId&&link.to.zoneId===item.zoneId)||(link.to.zoneId===editZoneId&&link.from.zoneId===item.zoneId)));
      const seams=model.links.filter(link=>link.kind==='continuation'&&[zoneOf(link.from),zoneOf(link.to)].sort().join()===[editZoneId,item.zoneId].sort().join());
      const blocked=seams.length&&seams.every(link=>link.check.status==='blocked')?seams[0].check.reason:undefined;
      const option:JoinOption={zoneId:item.zoneId,name:other.name,joined,touching:zonesNear(own,zoneLayout,other,item,1),blocked};
      if(joined||!option.touching)return option;
      const plan=planJoin(own,zoneLayout,other,item),otherT=model.transforms.get(item.zoneId);
      if('error' in plan)return{...option,walled:plan.error,wallAt:plan.at&&[plan.at[0],zoneLayout.floor*FLOOR_GAP,plan.at[1]]};
      return otherT?{...option,seam:[toWorld(ownT,plan.a.position),toWorld(otherT,plan.b.position)]}:option;
    });
  },[editing,modelZones,editZoneId,model,zoneLayout,connections]);
  const elevatorSuggestions=useMemo<ElevatorSuggestion[]>(()=>{
    if(!editing)return [];
    const linked=(a:string,b:string)=>connections.connections.some(link=>link.kind==='elevator'&&[nodeKey(link.from.zoneId,link.from.nodeId),nodeKey(link.to.zoneId,link.to.nodeId)].sort().join()===[a,b].sort().join());
    const hasLink=(key:string)=>connections.connections.some(link=>link.kind==='elevator'&&(nodeKey(link.from.zoneId,link.from.nodeId)===key||nodeKey(link.to.zoneId,link.to.nodeId)===key));
    return model.nodes.filter(node=>node.zoneId===editZoneId&&node.type==='elevator'&&!hasLink(node.key)).flatMap(node=>{
      const best=model.nodes.filter(other=>other.type==='elevator'&&other.zoneId!==editZoneId&&other.level!==node.level&&!linked(node.key,other.key))
        .map(other=>({other,meters:Math.hypot(other.world[0]-node.world[0],other.world[2]-node.world[2])}))
        .sort((a,b)=>Math.abs(a.other.level-node.level)-Math.abs(b.other.level-node.level)||a.meters-b.meters)[0];
      return best?[{nodeId:node.localId,otherKey:best.other.key,otherName:best.other.label||best.other.localId,floor:model.floors.find(floor=>floor.level===best.other.level)?.name||'Floor '+best.other.level,meters:best.meters}]:[];
    });
  },[editing,model,editZoneId,connections]);
  /**
   * Joins the zone being edited to a neighbor where their floors meet: adds a wired continuation point
   * to each zone, links the pair, and saves the current placement, all in one step.
   */
  async function joinZones(otherId:string){
    if(issues.length||newBlocked.length){setError('Fix this zone’s graph errors and blocked connections before joining.');return}
    if(!base||status==='saving'||joining)return;
    const withEdits=pending;
    const own=modelZones.find(zone=>zone.id===editZoneId),other=modelZones.find(zone=>zone.id===otherId),otherEntry=model.layout.find(item=>item.zoneId===otherId);
    const otherSource=zones.find(zone=>zone.id===otherId);
    if(!own||!other||!otherEntry||!otherSource)return;
    const plan=planJoin(own,zoneLayout,other,otherEntry);
    if('error' in plan){setError(plan.error);return}
    if(!plan.verified&&!window.confirm('No scan is available to check walls where these zones meet. Confirm the seam between '+own.name+' and '+other.name+' is walkable.'))return;
    setJoining(otherId);setError('');savingRef.current=true;
    try{
      const otherStore=createGraphStore(zoneBuilding(building,{...otherSource,graph:other.graph}),mode);
      const otherBase=await otherStore.load();
      const idA='zone-continuation-'+crypto.randomUUID().slice(0,8),idB='zone-continuation-'+crypto.randomUUID().slice(0,8);
      const nextA=withContinuation(withEdits?graph:base.graph,own.scan,plan.a,idA),nextB=withContinuation(otherBase.graph,other.scan,plan.b,idB);
      const savedB=await otherStore.save(nextB,otherBase);
      const savedA=await store.save(nextA,base);
      baseRef.current=savedA;setBase(savedA);setDraft(copyGraph(savedA.graph));setDraftOwner(editZoneId);setStatus('saved');sessionStorage.removeItem(key);
      setSessionGraphs(previous=>({...previous,[editZoneId]:savedA.graph,[otherId]:savedB.graph}));
      const zoneViews=modelZones.map(zone=>zone.id===editZoneId?{...zone,graph:savedA.graph}:zone.id===otherId?{...zone,graph:savedB.graph}:zone);
      const links=await saveConnections(building,mode,addZoneConnection(connections,{from:{zoneId:editZoneId,nodeId:idA},to:{zoneId:otherId,nodeId:idB},kind:'continuation'},zoneViews,{levelOf:model.levelOf}));
      setConnections(links);
      const placed=await saveLayout(building,mode,pinned(layout));
      setLayout(placed);setLayoutDirty(false);history.current={past:[],future:[],lastAt:0};
      if(mode==='firebase'){
        const graphs:Record<string,GraphSnapshot>={[editZoneId]:savedA,[otherId]:savedB};
        onUpdate({...building,zones:building.zones?.map(zone=>graphs[zone.id]?{...zone,graph:graphs[zone.id].graph,graphPath:graphs[zone.id].path}:zone),zoneConnections:links,layout:placed});
      }
      setNotice('Joined '+own.name+' and '+other.name+(plan.gap>.05?' ('+plan.gap.toFixed(2)+' m gap)':'')+'. Routes now walk across; placement'+(withEdits?' and your waypoint edits':'')+' saved.');
    }catch(e){setError('Joining failed: '+errorText(e))}
    finally{savingRef.current=false;setJoining('')}
  }
  function changeTab(next:Tab){
    if(next===tab)return;
    setTab(next);setTool('select');setBoundaryPlacement(null);setWalking(false);setPlacingWalker(false);setPlaying(false);
    if(next==='edit'&&place&&splitKey(place).zoneId!==editZoneId)switchZone(splitKey(place).zoneId);
    if(next==='edit'&&place)setSelectedKey(place);
  }
  function chooseTool(next:Tool){if(!editing)changeTab('edit');setBoundaryPlacement(null);setTool(next);if(next==='arrange')setSelectedKey('')}

  // ---------- Keyboard ----------
  const keyHandler=useRef<(event:KeyboardEvent)=>void>(()=>{});
  keyHandler.current=(event:KeyboardEvent)=>{
    if(event.defaultPrevented||typingIn(event.target)||walking)return;
    const k=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    if(mod&&k==='z'&&editing){event.preventDefault();if(event.shiftKey)redo();else undo();return}
    if(mod&&k==='y'&&editing){event.preventDefault();redo();return}
    if(mod&&k==='s'&&editing){event.preventDefault();void saveAll();return}
    if(mod||event.altKey)return;
    if(k==='f'){setReset(value=>value+1);return}
    if(k==='t'){setCameraView(view=>view==='top'?'iso':'top');return}
    if(k==='?'||(event.shiftKey&&k==='/')){setShortcuts(value=>!value);return}
    if(k==='e'&&!editing&&base){changeTab('edit');return}
    if(k==='escape'&&shortcuts){setShortcuts(false);return}
    if(k==='escape'&&placingWalker){setPlacingWalker(false);return}
    if(!editing){if(k==='escape')setPlace('');return}
    if(k==='v')chooseTool('select');
    else if(k==='w')chooseTool('add');
    else if(k==='c')chooseTool('connect');
    else if(k==='m')chooseTool(tool==='arrange'?'select':'arrange');
    else if(k==='s')setSnapping(value=>!value);
    else if((k==='delete'||k==='backspace')&&selected){event.preventDefault();remove()}
    else if(k==='f2'&&selected){event.preventDefault();setRenaming({key:selectedKey,in:'scene'})}
    else if(k==='escape'){if(shortcuts)setShortcuts(false);else if(pendingLink&&!pendingLink.toNodeId){setPendingLink(null);setTool('select')}else if(boundaryPlacement){setBoundaryPlacement(null);setTool('select')}else if(selected&&tool!=='select')setSelectedKey('');else if(tool!=='select')setTool('select');else setSelectedKey('')}
    else return;
  };
  useEffect(()=>{const handle=(event:KeyboardEvent)=>keyHandler.current(event);window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle)},[]);

  const statusText=status==='saved'&&!layoutDirty?(mode==='firebase'?'Synced':'Saved locally'):status==='saved'||status==='unsynced'?'Unsaved changes':status==='saving'?'Saving…':status==='conflict'?'Remote conflict':status==='failed'?(base?'Save failed':'Unable to load'):'Loading…';
  const statusTone=status==='saved'&&!layoutDirty?'ok':status==='failed'||status==='conflict'?'bad':status==='loading'||status==='saving'?'busy':'warn';
  const changes=(dirty?1:0)+(layoutDirty?1:0);
  const canUndo=history.current.past.length>0,canRedo=history.current.future.length>0;
  const hints=awaitingLinkHere?[['Click floor','place the matching '+pendingLink!.kind+' point']] as [string,string][]
    :boundaryPlacement?[['Click floor','place the zone '+boundaryPlacement+' point'],['Esc','cancel']] as [string,string][]
    :tool==='connect'&&selected?[['Click','connect '+(selected.label||selected.id)+' to…'],['Esc','stop']] as [string,string][]
    :tool==='add'&&selected&&autoLink?[['Click floor','add and link from '+(selected.label||selected.id)],['Esc','start a new chain']] as [string,string][]
    :TOOL_HINTS[tool];
  const unverified=checks.filter(check=>check.status==='unverified').length,warnings=checks.filter(check=>check.status==='warning').length;
  const floorsDesc=[...model.floors].sort((a,b)=>b.level-a.level);
  const selectedNodeView=selected&&modelZones.find(zone=>zone.id===editZoneId);

  return <main className={'workspace '+(editing?'is-editing':'is-exploring')+(walking?' is-walking':'')}>
    <div className={'stage'+(draggingWalker?' walker-dragging':'')+(walking?' walking-view':'')+(editing&&tool==='add'?' tool-add':'')} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-gnarly-walker')){e.preventDefault();e.dataTransfer.dropEffect='copy';setDraggingWalker(true)}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as globalThis.Node|null))setDraggingWalker(false)}} onDrop={e=>{if(!e.dataTransfer.types.includes('application/x-gnarly-walker'))return;e.preventDefault();setWalkDrop({clientX:e.clientX,clientY:e.clientY,id:Date.now()})}}>
      <Viewer model={model} level={level} illustrative={Boolean(building.demo)} selected={editing?selectedKey:(place||destination)} onSelect={selectNode} path={!editing&&route?.ok?route.nodes:[]} step={step} reset={reset} cameraView={cameraView}
        editing={editing} editZoneId={editZoneId} onFloorPick={status!=='saving'&&(editing||placingWalker)?viewerFloorPick:undefined}
        walker={walker} walking={walking} dropRequest={walkDrop} onWalkerDrop={placeWalker} onWalkerMove={moveWalker} onWalkerElevator={setElevatorStop}
        arrange={editing&&status!=='saving'&&!joining?{zoneId:editZoneId,snapping,dragFloors:tool==='arrange',onSelect:zoneId=>switchZone(zoneId,true),onCommit:commitArrange,gizmo:!selected&&(tool==='select'||tool==='arrange'),onLevel:moveZoneToLevel}:undefined}
        waypointEdit={editing&&status!=='saving'&&tool!=='arrange'?{zoneId:editZoneId,snapping,onMove:moveWaypointTo,selectedKey:tool==='select'&&selected?selectedKey:undefined}:undefined}
        connectFrom={editing&&tool==='connect'&&selected?selectedKey:undefined}
        joinHints={editing&&(tool==='select'||tool==='arrange')&&!pendingLink?joinOptions.filter(option=>!option.joined&&option.touching).map(option=>({...option,busy:joining===option.zoneId})):undefined}
        renaming={editing&&renaming?.in==='scene'?renaming.key:''} onRename={editing?key=>startRename(key,'scene'):undefined} onRenamed={finishRename}
        onJoinHint={zoneId=>{const option=joinOptions.find(item=>item.zoneId===zoneId);if(option?.walled)setError(option.walled);else void joinZones(zoneId)}}/>
      {draggingWalker&&<div className="drop-hint">Drop onto a floor to start walking</div>}
    </div>

    <header className="ws-head glass">
      <button className="icon-btn" disabled={status==='saving'} onClick={leave} aria-label="Back to map" data-tip="Back to map"><ArrowLeft size={16}/></button>
      <div className="ws-title"><small><span className={'live-dot'+(building.demo?' demo':'')}/>{building.demo?'Sample building':'Live building'}</small><strong>{building.name}</strong></div>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={!editing} className={!editing?'on':''} onClick={()=>changeTab('view')}><Eye size={13}/> Explore</button>
        <button role="tab" aria-selected={editing} className={editing?'on':''} disabled={!base||status==='saving'} onClick={()=>changeTab('edit')} data-tip="Edit map  E"><Pencil size={13}/> Edit</button>
      </div>
    </header>

    {!walking&&<aside className="ws-left glass">{editing
      ?<Outliner model={model} editZoneId={editZoneId} selectedKey={selectedKey} level={level} onZone={zoneId=>{if(switchZone(zoneId,true))setSelectedKey('')}} onNode={selectNode} onLevel={value=>{setLevel(value);setPlaying(false)}}
        renaming={renaming?.in==='tree'?renaming.key:''} onRename={key=>startRename(key,'tree')} onRenamed={finishRename} onFloorRename={renameFloor}/>
      :<Directions model={model} buildingName={building.name} start={start} destination={destination} setStart={key=>{setStart(key);setShowRoute(true)}} setDestination={key=>{setDestination(key);setShowRoute(true);setPlace('')}} swap={()=>{setStart(destination);setDestination(start);setShowRoute(true)}} requestRoute={()=>setShowRoute(true)}
        place={place} setPlace={key=>{setPlace(key);const node=model.byKey.get(key);if(node&&level!=='all'&&node.level!==level)setLevel(node.level)}}
        route={route} playing={playing} step={step} togglePreview={()=>{if(playing){setPlaying(false);return}if(!route?.ok)return;setWalking(false);setStep(0);setLevel(route.nodes[0].level);setPlaying(true)}} showLevel={value=>{setLevel(value);setWalking(false)}}
        walkFrom={walkFrom} dirty={dirty} reviewEdits={()=>changeTab('edit')} localMode={mode==='local'&&!building.demo}/>}
    </aside>}

    {editing&&<div className="ws-toolbar glass" role="toolbar" aria-label="Edit tools">
      <ToolButton icon={<MousePointer2 size={17}/>} label="Select & move" shortcut="V" active={tool==='select'} onClick={()=>chooseTool('select')}/>
      <ToolButton icon={<MapPinPlus size={17}/>} label="Add waypoints" shortcut="W" active={tool==='add'} onClick={()=>chooseTool('add')}/>
      <ToolButton icon={<Spline size={17}/>} label="Connect waypoints" shortcut="C" active={tool==='connect'} onClick={()=>chooseTool('connect')}/>
      <ToolButton icon={<Move3d size={17}/>} label="Arrange zones" shortcut="M" active={tool==='arrange'} onClick={()=>chooseTool(tool==='arrange'?'select':'arrange')}/>
      <span className="tool-sep"/>
      <ToolButton icon={<Magnet size={17}/>} label={'Snapping '+(snapping?'on':'off')} shortcut="S" active={snapping} onClick={()=>setSnapping(value=>!value)}/>
      {tool==='add'&&<ToolButton icon={<Link size={17}/>} label={'Auto-link new waypoints '+(autoLink?'on':'off')} active={autoLink} onClick={()=>setAutoLink(value=>!value)}/>}
      <span className="tool-sep"/>
      <ToolButton icon={<Undo2 size={17}/>} label="Undo" shortcut="Ctrl Z" disabled={!canUndo} onClick={undo}/>
      <ToolButton icon={<Redo2 size={17}/>} label="Redo" shortcut="Ctrl Shift Z" disabled={!canRedo} onClick={redo}/>
      <span className="tool-sep"/>
      <button className={'save-btn'+(changes?' has-changes':'')} disabled={!changes||status==='saving'||layoutSaving||Boolean(issues.length)||Boolean(newBlocked.length)||Boolean(remote)} onClick={()=>void saveAll()} data-tip={(mode==='firebase'?'Save to Firebase':'Save in this browser')+'  Ctrl S'}>
        {mode==='firebase'?<CloudUpload size={15}/>:<HardDrive size={15}/>}{status==='saving'||layoutSaving?'Saving…':'Save'}{changes>0&&<span className="save-count">{changes}</span>}
      </button>
    </div>}

    {editing&&!walking&&<aside className="ws-right glass">
      {remote&&<div className="banner bad"><strong>Graph changed elsewhere</strong><p>Your draft has {graph.nodes.length} waypoints and {graph.edges.length} connections; the shared graph has {remote.graph.nodes.length} and {remote.graph.edges.length}. Your draft is preserved.</p><div className="btn-row"><button className="btn" onClick={()=>resolveConflict(false)}>Keep my draft</button><button className="btn" onClick={()=>resolveConflict(true)}>Load remote</button></div></div>}
      {pendingLink&&<div className="banner accent"><strong>Matching {pendingLink.kind==='continuation'?'seam':'elevator'} point</strong>
        {!awaitingLinkHere&&!pendingLink.toNodeId?<p>Switch to <b>{zoneName(pendingLink.targetZoneId)}</b> to place it.</p>:!pendingLink.toNodeId?<p>Click the floor of <b>{editZone.name}</b> where it belongs.</p>
          :<><p>Placed <code>{pendingLink.toNodeId}</code>. Save it and link it to {zoneName(pendingLink.from.zoneId)}.</p><button className="btn accent" disabled={linkSaving} onClick={()=>void finishPendingLink()}>{linkSaving?'Saving…':'Save point & link'}</button></>}
        <button className="btn ghost" onClick={()=>{setPendingLink(null);setTool('select')}}>Cancel</button></div>}
      {editing&&!building.demo&&!scan&&<div className="banner warn"><p>No scan walls for {editZone.name}. New connections can't be wall-checked and stay unverified.</p></div>}
      {selected&&selectedNodeView
        ?<WaypointInspector model={model} zone={selectedNodeView} node={selected} graph={graph} scan={scan} editWaypoint={editWaypoint} remove={remove} disconnect={(from,to)=>change(disconnectWaypoints(graph,from,to),'','disconnect')} connectTo={targetId=>connectPair(selected.id,targetId)} close={()=>setSelectedKey('')}
          zoneLinks={zoneLinks} deleteZoneLink={connection=>void deleteZoneLink(connection)} pending={pending} linkSaving={linkSaving} linkExisting={(kind,other)=>void linkExisting(kind,other)} beginPlacement={beginPlacement}/>
        :<ZoneInspector model={model} zone={modelZones.find(zone=>zone.id===editZoneId)!} zoneLayout={zoneLayout} floorNameValue={floorNameValue} setFloorName={setFloorName} changeLayout={changeLayout}
          rotateZone={rotateZone} arrange={()=>chooseTool(tool==='arrange'?'select':'arrange')} arranging={tool==='arrange'} joinOptions={joinOptions} joining={joining} joinZones={zoneId=>void joinZones(zoneId)} unjoin={zoneId=>void unjoin(zoneId)} pending={pending}
          elevatorSuggestions={elevatorSuggestions} linkElevator={(nodeId,otherKey)=>void linkWaypoint(nodeId,'elevator',otherKey)}
          autoAlign={autoAlign} shiftFloor={shiftFloor} alignFloorToElevators={alignFloorToElevators} beginBoundaryPlacement={beginBoundaryPlacement}
          health={{blocked:blocked.length,unverified,warnings,issues:[...issues,...(newBlocked.length?[newBlocked.length+' new blocked connection(s) must be removed before saving.']:[]),...model.issues.slice(0,2)]}}
          runAutoConnect={runAutoConnect} removeBlocked={()=>change({...graph,edges:graph.edges.filter((_,index)=>checks[index].status!=='blocked')},'Blocked connections removed.','remove blocked')} selectNode={selectNode}
          zoneLinks={zoneLinks} deleteZoneLink={connection=>void deleteZoneLink(connection)} linkSaving={linkSaving}/>}
    </aside>}

    {!walking&&<div className="ws-floors glass" aria-label="Floors">
      <button className={level==='all'?'on':''} onClick={()=>setLevel('all')} data-tip="All floors" aria-label="All floors"><Box size={14}/></button>
      {floorsDesc.map(floor=><button key={floor.level} className={level===floor.level?'on':''} onClick={()=>{setLevel(floor.level);setPlaying(false)}} data-tip={floor.name}>{floor.level}</button>)}
    </div>}
    {!walking&&<div className="ws-camera glass">
      <button onClick={()=>setReset(value=>value+1)} data-tip="Fit view  F" aria-label="Fit view"><Scan size={15}/></button>
      <button className={cameraView==='top'?'on':''} onClick={()=>setCameraView(view=>view==='top'?'iso':'top')} data-tip={cameraView==='top'?'3D view  T':'Top view  T'} aria-label="Toggle top view">{cameraView==='top'?'3D':<Square size={14}/>}</button>
      <button onClick={()=>setShortcuts(value=>!value)} data-tip="Shortcuts  ?" aria-label="Keyboard shortcuts"><Keyboard size={15}/></button>
    </div>}

    {!editing&&!walking&&<div className={'walker-chip glass'+(placingWalker?' placing':'')}>
      <button className="walker-person" draggable onDragStart={e=>{e.dataTransfer.setData('application/x-gnarly-walker','person');e.dataTransfer.setData('text/plain','Gnarly walk position');e.dataTransfer.effectAllowed='copy';e.dataTransfer.setDragImage(e.currentTarget,20,20);setDraggingWalker(true)}} onDragEnd={()=>setDraggingWalker(false)} onClick={()=>walker?(setLevel(model.levelOf(walker.zoneId,walker.floorId)),setWalking(true)):setPlacingWalker(value=>!value)} aria-label={walker?'Enter walk mode from the person marker':'Drag person onto a floor or click to place'}><PersonStanding size={22}/></button>
      <div><strong>{placingWalker?'Click a floor':walker?'Walk from here':'Walk inside'}</strong><small>{placingWalker?'or press Esc':walker?'Drag to move the person':'Drag onto a floor'}</small></div>
      {placingWalker&&<button className="icon-btn" aria-label="Cancel" onClick={()=>setPlacingWalker(false)}><X size={13}/></button>}
    </div>}

    {walking&&<><div className="walk-hud glass"><Footprints size={18}/><div><strong>Walk mode</strong><span>Drag to look · W/S or ↑/↓ move · A/D or ←/→ turn · Shift to run</span></div><button className="btn" onClick={()=>setWalking(false)}>Exit</button></div>{elevatorStop&&(elevatorStop.up||elevatorStop.down)&&<div className="walk-elevator glass" aria-label="Elevator"><strong>Elevator</strong>{elevatorStop.up&&<button className="btn" onClick={()=>walkKey('KeyE',true)}>↑ {floorLabel(elevatorStop.up.level)} <Kbd>E</Kbd></button>}{elevatorStop.down&&<button className="btn" onClick={()=>walkKey('KeyQ',true)}>↓ {floorLabel(elevatorStop.down.level)} <Kbd>Q</Kbd></button>}</div>}<div className="walk-pad" aria-label="Walk controls"><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyW',true)}} onPointerUp={()=>walkKey('KeyW',false)} onPointerCancel={()=>walkKey('KeyW',false)} aria-label="Walk forward">↑</button><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyA',true)}} onPointerUp={()=>walkKey('KeyA',false)} onPointerCancel={()=>walkKey('KeyA',false)} aria-label="Turn left">↶</button><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyS',true)}} onPointerUp={()=>walkKey('KeyS',false)} onPointerCancel={()=>walkKey('KeyS',false)} aria-label="Walk backward">↓</button><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyD',true)}} onPointerUp={()=>walkKey('KeyD',false)} onPointerCancel={()=>walkKey('KeyD',false)} aria-label="Turn right">↷</button></div></>}

    {editing&&!walking&&<footer className="ws-status glass">
      <div className="status-hints">{hints.map(([keys,action])=><span key={keys+action}><Kbd>{keys}</Kbd>{action}</span>)}</div>
      <div className="status-right">
        {blocked.length>0&&<span className="pill blocked">{blocked.length} blocked</span>}
        {unverified>0&&<span className="pill unverified">{unverified} unverified</span>}
        <span className={'sync '+statusTone}><i/>{statusText}</span>
        <select aria-label="Data mode" className="mode-select" disabled={status==='saving'} value={mode} onChange={e=>modeChange(e.target.value as DataMode)}><option value="local">Local test</option>{!building.demo&&canEditFirebase()&&<option value="firebase">Firebase</option>}</select>
        {pending&&<button className="btn ghost small" onClick={cancel}>Discard</button>}
      </div>
    </footer>}

    <div className="toasts" aria-live="polite">
      {error&&<div role="alert" className="toast bad"><span>{error}</span><button className="icon-btn" aria-label="Dismiss" onClick={()=>setError('')}><X size={13}/></button></div>}
      {notice&&!error&&<div className="toast"><span>{notice}</span>{/Ctrl\+Z/.test(notice)&&<button className="btn small" onClick={undo}>Undo</button>}</div>}
      {!base&&status==='failed'&&mode!=='local'&&<div className="toast"><span>Couldn't load the shared graph.</span><button className="btn small" onClick={()=>modeChange('local')}>Open local test mode</button></div>}
    </div>

    {shortcuts&&<div className="sheet-backdrop" onClick={()=>setShortcuts(false)}><div className="shortcut-sheet glass" role="dialog" aria-label="Keyboard shortcuts" onClick={e=>e.stopPropagation()}>
      <header><strong>Keyboard shortcuts</strong><button className="icon-btn" aria-label="Close" onClick={()=>setShortcuts(false)}><X size={14}/></button></header>
      <div className="shortcut-grid">{([
        ['View',[['F','Fit building'],['T','Top / 3D view'],['E','Edit map'],['?','This sheet']]],
        ['Tools',[['V','Select & move'],['W','Add waypoints'],['C','Connect'],['M','Arrange zones'],['S','Toggle snapping']]],
        ['Zone transform',[['G','Move zone'],['R','Rotate zone'],['X / Z','Lock axis'],['0–9 . −','Exact value'],['Enter','Confirm'],['Esc','Cancel'],['Ctrl','Flip snapping']]],
        ['Editing',[['Drag','Move waypoint'],['Double-click / F2','Rename'],['Del','Delete waypoint'],['Ctrl Z','Undo'],['Ctrl Shift Z','Redo'],['Ctrl S','Save'],['Esc','Deselect / exit tool']]],
      ] as [string,[string,string][]][]).map(([group,items])=><section key={group}><h4>{group}</h4>{items.map(([keys,action])=><div key={keys} className="shortcut"><Kbd>{keys}</Kbd><span>{action}</span></div>)}</section>)}</div>
    </div></div>}
  </main>;
}
