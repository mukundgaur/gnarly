import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Eye, Footprints, Layers, Pencil, PersonStanding, RotateCcw } from 'lucide-react';
import Viewer, { type DropRequest, type FloorPick, type WalkLocation } from './Viewer';
import type { Building, BuildingLayout, Graph, ZoneConnection, ZoneConnections, ZoneView } from './data.ts';
import { canEditFirebase } from './firebase.ts';
import { pointOnFloor } from './geometry.ts';
import { addWaypoint, autoConnect, connectWaypoints, deleteWaypoint, disconnectWaypoints, updateWaypoint, validateGraph } from './graphEdit.ts';
import { copyGraph, createGraphStore, readLocalGraph, type GraphSnapshot } from './graphStore.ts';
import { combineBuilding, elevatorFloorFit, findBuildingRoute, nodeKey, splitKey, zoneEdgeChecks, type ElevatorStop } from './buildingGraph.ts';
import { loadBuildingMeta, saveConnections, saveLayout, type DataMode } from './buildingStore.ts';
import { addZoneConnection, removeZoneConnection } from './zoneConnections.ts';
import { fitZone, moveFloor, upsertZoneLayout } from './zoneAlign.ts';
import ViewPanel from './ViewPanel';
import EditPanel, { type LinkKind, type PendingLink, type Tool } from './EditPanel';
import { waypointForm, type WaypointForm } from './workspaceShared.tsx';

type Props = { building: Building; onBack: () => void; onUpdate: (building: Building) => void; onDirtyChange?: (dirty:boolean)=>void };
type Tab = 'view' | 'edit';
type Status = 'loading' | 'saved' | 'unsynced' | 'saving' | 'failed' | 'conflict';
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
  const baseRef=useRef<GraphSnapshot|null>(null),savingRef=useRef(false),loadedKey=useRef<string|null>(null),restoredForm=useRef<WaypointForm|null>(null);
  const [status,setStatus]=useState<Status>('loading'),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [tool,setTool]=useState<Tool>('select'),[selectedKey,setSelectedKey]=useState(''),[form,setForm]=useState<WaypointForm>({name:'',type:'waypoint',floor:'',x:'',y:'',z:''});
  const [boundaryPlacement,setBoundaryPlacement]=useState<'start'|'end'|null>(null),[pendingLink,setPendingLink]=useState<PendingLink|null>(null);
  const [meta]=useState(()=>loadBuildingMeta(building,mode));
  const [connections,setConnections]=useState<ZoneConnections>(meta.connections),[layout,setLayout]=useState<BuildingLayout|undefined>(meta.layout);
  const [layoutDirty,setLayoutDirty]=useState(false),[layoutSaving,setLayoutSaving]=useState(false),[linkSaving,setLinkSaving]=useState(false);
  const [level,setLevel]=useState<number|'all'>('all'),[start,setStart]=useState(''),[destination,setDestination]=useState(''),[showRoute,setShowRoute]=useState(false),[step,setStep]=useState(0),[playing,setPlaying]=useState(false),[reset,setReset]=useState(0);
  const [walker,setWalker]=useState<WalkLocation|null>(()=>readWalker(building)?.location||null),[walking,setWalking]=useState(()=>Boolean(readWalker(building)?.walking)),[placingWalker,setPlacingWalker]=useState(false),[walkDrop,setWalkDrop]=useState<DropRequest|null>(null),[draggingWalker,setDraggingWalker]=useState(false),[elevatorStop,setElevatorStop]=useState<ElevatorStop|null>(null);

  const editing=tab==='edit';
  const activeDraft=draftOwner===editZoneId?draft:null;
  const graph=activeDraft||savedZones.find(zone=>zone.id===editZoneId)!.graph;
  const scan=editZone.scan;
  const modelZones=useMemo(()=>savedZones.map(zone=>zone.id===editZoneId&&activeDraft?{...zone,graph:activeDraft}:zone),[savedZones,editZoneId,activeDraft]);
  const model=useMemo(()=>combineBuilding(modelZones,connections,layout),[modelZones,connections,layout]);
  const dirty=Boolean(base&&activeDraft&&JSON.stringify(base.graph)!==JSON.stringify(activeDraft));
  const selectedRef=selectedKey?splitKey(selectedKey):null;
  const selected=selectedRef?.zoneId===editZoneId?graph.nodes.find(node=>node.id===selectedRef.nodeId):undefined;
  const formDirty=Boolean(editing&&selected&&JSON.stringify(form)!==JSON.stringify(waypointForm(selected)));
  const pending=dirty||formDirty;
  const zoneLayout=model.layout.find(item=>item.zoneId===editZoneId)!;
  const current=useRef({pending});current.current={pending};
  const route=useMemo(()=>showRoute?findBuildingRoute(model,start,destination):null,[model,start,destination,showRoute]);
  const checks=useMemo(()=>zoneEdgeChecks(graph,scan),[graph,scan]);
  const blocked=graph.edges.filter((_,index)=>checks[index].status==='blocked');
  const newBlocked=useMemo(()=>{if(!base)return blocked;const baseChecks=zoneEdgeChecks(base.graph,scan);const previous=new Set(base.graph.edges.filter((edge,index)=>baseChecks[index].status==='blocked').map(edge=>JSON.stringify(edge)));return blocked.filter(edge=>!previous.has(JSON.stringify(edge)))},[base,blocked,scan]);
  const issues=useMemo(()=>validateGraph(graph),[graph]);
  const awaitingLinkHere=Boolean(pendingLink&&pendingLink.targetZoneId===editZoneId&&!pendingLink.toNodeId);

  useEffect(()=>onDirtyChange?.(pending),[pending,onDirtyChange]);
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
            const local=JSON.parse(saved) as {base:GraphSnapshot;graph:Graph;form?:WaypointForm;selectedId?:string};
            if(!local.base?.graph || !local.graph?.nodes || !local.graph?.edges)throw Error('Invalid draft');
            baseRef.current=local.base;setBase(local.base);setDraft(local.graph);setDraftOwner(zoneId);
            if(local.form&&local.selectedId){setSelectedKey(nodeKey(zoneId,local.selectedId));setForm(local.form);restoredForm.current=local.form;setTab('edit')}
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
  useEffect(()=>{if(!base||!activeDraft||loadedKey.current!==key)return;try{if(pending)sessionStorage.setItem(key,JSON.stringify({base,graph:activeDraft,form:formDirty?form:undefined,selectedId:formDirty?selected?.id:undefined}));else sessionStorage.removeItem(key)}catch{setError('Browser draft backup is unavailable. Keep this tab open until you save.')}},[base,activeDraft,pending,key,form,formDirty,selected?.id]);
  useEffect(()=>{if(!pending&&!layoutDirty)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[pending,layoutDirty]);
  useEffect(()=>{if(walker)sessionStorage.setItem(walkerKey(building),JSON.stringify({location:walker,walking} satisfies SavedWalker))},[walker,walking,building.id,building.activeVersion]);
  useEffect(()=>{if(restoredForm.current){setForm(restoredForm.current);restoredForm.current=null}else if(selected)setForm(waypointForm(selected))},[selected?.id,selected?.position,selected?.label,selected?.type,selected?.floor]);
  useEffect(()=>{
    if(!model.byKey.has(start))setStart(model.nodes.find(node=>node.type==='entrance')?.key||model.nodes[0]?.key||'');
    if(!model.byKey.has(destination))setDestination(model.nodes.filter(node=>node.type==='destination').at(-1)?.key||model.nodes.at(-1)?.key||'');
  },[model,start,destination]);
  useEffect(()=>{setStep(0);setPlaying(false)},[route]);
  useEffect(()=>{if(!playing||!route?.ok)return;const timer=window.setTimeout(()=>{if(step>=route.nodes.length-1){setPlaying(false);return}setStep(step+1);setLevel(route.nodes[step+1].level)},850);return()=>window.clearTimeout(timer)},[playing,route,step]);
  useEffect(()=>{if(awaitingLinkHere){setTab('edit');setTool('add');setNotice('Click the floor of '+editZone.name+' where the matching '+(pendingLink!.kind==='continuation'?'continuation':'elevator')+' point belongs.')}},[awaitingLinkHere,editZone.name]);

  function change(next:Graph,message=''){setDraft(next);setDraftOwner(editZoneId);setNotice(message);setError('');setPlaying(false);setStep(0);if(!remote)setStatus(base&&JSON.stringify(base.graph)===JSON.stringify(next)?'saved':'unsynced')}
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
  function selectNode(key:string){
    if(status==='saving')return;
    if(!editing){setSelectedKey(key);return}
    if(formDirty&&!window.confirm('Discard the unapplied waypoint fields? Apply waypoint first to keep them.'))return;
    const {zoneId}=splitKey(key);
    if(!switchZone(zoneId))return;
    setSelectedKey(key);setPlaying(false);
  }
  function editFloorPick(pick:FloorPick){
    if(tool==='select')return;
    if(pick.zoneId!==editZoneId){const zone=zones.find(item=>item.id===pick.zoneId);if(switchZone(pick.zoneId,true))setNotice('Now editing '+(zone?.name||pick.zoneId)+'. Click the floor again to place the point.');return}
    if(formDirty&&!window.confirm('Discard the unapplied waypoint fields before placing this waypoint?'))return;
    const nearest=graph.nodes.filter(node=>node.floor===pick.floorId).sort((a,b)=>Math.hypot(a.position[0]-pick.position[0],a.position[2]-pick.position[2])-Math.hypot(b.position[0]-pick.position[0],b.position[2]-pick.position[2]))[0];
    const point:[number,number,number]=[pick.position[0],nearest?.position[1]??pick.position[1],pick.position[2]];
    if(!pointOnFloor(point,pick.floorId,graph,scan)){setError('Pick a position on the displayed floor.');return}
    try{
      if(tool==='add'){
        const type:LinkKind|'waypoint'=awaitingLinkHere?pendingLink!.kind:boundaryPlacement?'continuation':'waypoint';
        const id=(type==='elevator'?'elevator-':type==='continuation'?'zone-'+(boundaryPlacement||'continuation')+'-':'wp-')+crypto.randomUUID().slice(0,8);
        const label=type==='elevator'?'Elevator':type==='continuation'?(boundaryPlacement==='start'?'Zone start':boundaryPlacement==='end'?'Zone end':'Zone continuation'):'';
        const message=awaitingLinkHere?'Matching point added. Connect it to a walkable waypoint here, then save and link it.':type==='continuation'?'Continuation point added. Connect it to a walkable waypoint here, then join it to the neighboring zone.':'Waypoint added. Connect it to walkable neighbors.';
        change(addWaypoint(graph,{id,floor:pick.floorId,type,position:point,label,source:'manual'},scan),message);
        setSelectedKey(nodeKey(editZoneId,id));setBoundaryPlacement(null);
        if(awaitingLinkHere)setPendingLink({...pendingLink!,toNodeId:id});
      }else if(selected){
        const result=updateWaypoint(graph,{...selected,floor:pick.floorId,position:point},scan);
        if(result.removedEdges.length&&!window.confirm('Moving removes '+result.removedEdges.length+' blocked connection(s). Continue?'))return;
        change(result.graph,result.removedEdges.length+' affected connection(s) removed.');
      }
      setTool('select');
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
  function viewerFloorPick(pick:FloorPick){if(placingWalker)placeWalker(pick);else if(editing)editFloorPick(pick)}
  function moveWalker(location:WalkLocation){setWalker(location);setLevel(model.levelOf(location.zoneId,location.floorId))}
  const floorLabel=(level:number)=>model.floors.find(item=>item.level===level)?.name||'Floor '+level;
  function walkKey(code:string,down:boolean){window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true}))}
  function applyForm(){if(!selected)return;const position=[Number(form.x),Number(form.y),Number(form.z)] as [number,number,number];if([form.x,form.y,form.z].some(x=>x.trim()==='')||!position.every(Number.isFinite)){setError('Enter valid X, Y, Z coordinates.');return}
    try{const result=updateWaypoint(graph,{...selected,label:form.name.trim()||null,type:form.type,floor:form.floor,position},scan);if(result.removedEdges.length&&!window.confirm('This edit removes '+result.removedEdges.length+' blocked connection(s). Continue?'))return;change(result.graph,result.removedEdges.length?result.removedEdges.length+' blocked connection(s) removed.':'Waypoint updated.')}catch(e){setError(errorText(e))}}
  const zoneLinks=connections.connections.filter(item=>item.from.zoneId===editZoneId||item.to.zoneId===editZoneId);
  function remove(){if(!selected)return;const external=zoneLinks.filter(item=>(item.from.zoneId===editZoneId&&item.from.nodeId===selected.id)||(item.to.zoneId===editZoneId&&item.to.nodeId===selected.id));if(external.length){setError('Remove this waypoint’s '+external.length+' zone link(s) before deleting it.');return}const count=graph.edges.filter(edge=>edge.from===selected.id||edge.to===selected.id).length;if(!window.confirm('Delete '+selected.id+(count?' and its '+count+' connection(s)':'')+'?'))return;change(deleteWaypoint(graph,selected.id).graph,'Waypoint deleted.');setSelectedKey('')}
  function connect(targetId:string){try{if(!scan?.floors?.length&&!window.confirm('No scan is available to check walls. Confirm that you have physically verified this connection is walkable.'))return;change(connectWaypoints(graph,selected!.id,targetId,scan),'Connection added.')}catch(e){setError(errorText(e))}}
  function runAutoConnect(){if(!scan?.floors?.length){setError('Auto-connect needs this zone’s scan-features.json to check walls. Connect waypoints manually instead.');return}const result=autoConnect(graph,scan);change(result.graph,result.added.length?result.added.length+' wall-checked connection(s) added.':'No new connections: every visible pair is already connected or blocked by walls.')}
  async function save():Promise<GraphSnapshot|null>{
    if(!base||!activeDraft||savingRef.current||formDirty)return null;
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
  function cancel(){const saved=remote||base;if(!saved)return;baseRef.current=saved;setBase(saved);setDraft(copyGraph(saved.graph));setDraftOwner(editZoneId);setSelectedKey('');setRemote(null);setError('');setNotice('Restored the latest saved graph.');setStatus('saved');sessionStorage.removeItem(key)}
  function resolveConflict(useRemote:boolean){if(!remote)return;if(useRemote){if(!window.confirm('Discard your draft and load the remote graph?'))return;baseRef.current=remote;setBase(remote);setDraft(copyGraph(remote.graph));setDraftOwner(editZoneId);sessionStorage.removeItem(key);setSelectedKey('');setStatus('saved')}
    else{if(!window.confirm('This will keep your complete draft as the next graph. Changes made in the remote graph since you started will not appear in it. The previous graph file remains in Storage. Continue only after reviewing both versions.'))return;baseRef.current=remote;setBase(remote);setStatus('unsynced');setNotice('Your draft is based on the latest revision. Review all connections before saving; the prior graph file remains in Storage.')}setRemote(null)}

  /** Authors every zone's current placement so adjusting one zone does not drag auto-fitted neighbors along with it. */
  function pinned(from:BuildingLayout|undefined):BuildingLayout{return model.layout.reduce((current,item)=>current.zones.some(zone=>zone.zoneId===item.zoneId)?current:upsertZoneLayout(current,item),from||{schemaVersion:1,zones:[]})}
  function changeLayout(field:'floor'|'x'|'z'|'rotationDegrees',value:string){const number=Number(value);if(value.trim()===''||!Number.isFinite(number))return;setLayout(previous=>upsertZoneLayout(pinned(previous),{...zoneLayout,[field]:field==='floor'?Math.round(number):number}));setLayoutDirty(true)}
  const floorNameValue=layout?.floors?.find(item=>item.floor===zoneLayout.floor)?.name||'';
  function setFloorName(name:string){setLayout(previous=>{const current=previous||{schemaVersion:1 as const,zones:[]};const floors=(current.floors||[]).filter(item=>item.floor!==zoneLayout.floor);return{...current,floors:name.trim()?[...floors,{floor:zoneLayout.floor,name}]:floors}});setLayoutDirty(true)}
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
  function applyFloorMove(move:{x:number;z:number;rotationDegrees:number},pivot:[number,number]){setLayout(previous=>{const current=pinned(previous);return{...current,zones:moveFloor(current.zones,zoneLayout.floor,move,pivot)}});setLayoutDirty(true)}
  function shiftFloor(move:{x:number;z:number;rotationDegrees:number}){
    const points=model.nodes.filter(node=>model.transforms.get(node.zoneId)?.floor===zoneLayout.floor);
    const pivot:[number,number]=points.length?[points.reduce((sum,node)=>sum+node.world[0],0)/points.length,points.reduce((sum,node)=>sum+node.world[2],0)/points.length]:[0,0];
    applyFloorMove(move,pivot);setNotice('Moved the whole floor. Save the zone placement to keep it.');
  }
  function alignFloorToElevators(){
    const fit=elevatorFloorFit(model,zoneLayout.floor);
    if(!fit){setError('Link an elevator on this floor to an elevator on another floor first.');return}
    applyFloorMove(fit.move,[0,0]);setError('');
    setNotice('Lined up this floor with '+(model.floors.find(floor=>floor.level===fit.reference)?.name||'Floor '+fit.reference)+' using '+fit.pairs+' elevator'+(fit.pairs>1?'s':'')+(fit.pairs>1?'':' (position only; link a second elevator to also fix rotation)')+'. Save the zone placement to keep it.');
  }
  function autoAlign(){const next=alignedLayout(editZoneId,connections,modelZones,layout);if(!next){setError('Join a continuation point in this zone to a neighboring zone first.');return}setLayout(next);setLayoutDirty(true);setNotice('Aligned to the joined zone(s). Save the zone placement to keep it.')}
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
      if(aligned){setLayout(aligned);await persistLayout(aligned);setNotice('Zones joined. '+(zones.find(zone=>zone.id===moving)?.name||moving)+' was aligned onto this floor; fine-tune its placement if needed.')}
    }
    return true;
  }
  async function linkExisting(kind:LinkKind,otherKey:string){
    if(!selected)return;if(pending){setError('Save this zone before linking it.');return}
    try{await link({from:{zoneId:editZoneId,nodeId:selected.id},to:splitKey(otherKey),kind},modelZones)}catch(e){setError(errorText(e))}
  }
  function beginPlacement(kind:LinkKind,targetZoneId:string,targetLevel:number){
    if(!selected)return;if(pending){setError('Save this zone before placing the matching point.');return}
    const from={zoneId:editZoneId,nodeId:selected.id};
    if(!switchZone(targetZoneId,true))return;
    setPendingLink({from,kind,targetZoneId});setLevel(targetLevel);setTool('add');
  }
  async function finishPendingLink(){
    if(!pendingLink?.toNodeId)return;
    let zoneViews=modelZones;
    if(pending){const saved=await save();if(!saved)return;zoneViews=modelZones.map(zone=>zone.id===editZoneId?{...zone,graph:saved.graph}:zone)}
    try{if(await link({from:pendingLink.from,to:{zoneId:editZoneId,nodeId:pendingLink.toNodeId},kind:pendingLink.kind},zoneViews)){setPendingLink(null);setTool('select')}}catch(e){setError(errorText(e))}
  }
  async function deleteZoneLink(connection:ZoneConnection){if(!window.confirm('Remove this link between zones?'))return;await persistConnections(removeZoneConnection(connections,connection),'Zone link removed.')}
  function beginBoundaryPlacement(end:'start'|'end'){if(formDirty&&!window.confirm('Discard the unapplied waypoint fields before placing this connector?'))return;setBoundaryPlacement(end);setTool('add');setNotice('Click the '+end+' of this zone to place a continuation point. It is not treated as a door.')}
  function changeTab(next:Tab){
    if(next===tab)return;
    if(next==='view'&&formDirty&&!window.confirm('Discard the unapplied waypoint fields?'))return;
    if(selected)setForm(waypointForm(selected));
    setTab(next);setTool('select');setBoundaryPlacement(null);setWalking(false);setPlacingWalker(false);setPlaying(false);
    if(next==='edit'&&selectedKey&&splitKey(selectedKey).zoneId!==editZoneId)switchZone(splitKey(selectedKey).zoneId);
  }
  const statusText=formDirty&&status==='saved'?'Unapplied waypoint changes':status==='saved'?(mode==='firebase'?'Saved to Firebase':'Saved locally · not synced'):status==='unsynced'?'Unsaved changes':status==='saving'?'Saving…':status==='conflict'?'Remote conflict':status==='failed'?(base?'Save failed · edits preserved':'Unable to load graph'):'Loading graph…';
  const hint=awaitingLinkHere?'Click the floor of '+editZone.name+' to place the matching '+pendingLink!.kind+' point':boundaryPlacement?'Click the '+boundaryPlacement+' of this zone to place its continuation point':tool==='add'?'Click the floor of '+editZone.name+' to add a waypoint':tool==='move'?'Click the floor to move the selected waypoint':'Click a waypoint to edit it; click another zone’s waypoint to switch zones';

  return <main className="inside"><div className="viewer-top"><div><button className="back" disabled={status==='saving'} onClick={leave}><ArrowLeft size={17}/> Back to map</button><div className="viewer-title"><span>BUILDING EXPLORER</span><h1>{building.name}</h1></div></div><div className="viewer-badge"><span/> {building.demo?'SAMPLE EXPERIENCE':'LIVE BUILDING'}</div></div>
    <div className={'viewer '+(draggingWalker?'walker-dragging ':'')+(walking?'walking-view':'')} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-gnarly-walker')){e.preventDefault();e.dataTransfer.dropEffect='copy';setDraggingWalker(true)}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as globalThis.Node|null))setDraggingWalker(false)}} onDrop={e=>{if(!e.dataTransfer.types.includes('application/x-gnarly-walker'))return;e.preventDefault();setWalkDrop({clientX:e.clientX,clientY:e.clientY,id:Date.now()})}}>
      <Viewer model={model} level={level} illustrative={Boolean(building.demo)} selected={selectedKey||(editing?'':destination)} onSelect={selectNode} path={!editing&&route?.ok?route.nodes:[]} step={step} reset={reset} editing={editing} editZoneId={editZoneId} onFloorPick={status!=='saving'&&(editing||placingWalker)?viewerFloorPick:undefined} walker={walker} walking={walking} dropRequest={walkDrop} onWalkerDrop={placeWalker} onWalkerMove={moveWalker} onWalkerElevator={setElevatorStop}/>
      {!editing&&!walking&&<div className={'walker-control '+(placingWalker?'placing':'')}><button className="walker-person" draggable onDragStart={e=>{e.dataTransfer.setData('application/x-gnarly-walker','person');e.dataTransfer.setData('text/plain','Gnarly walk position');e.dataTransfer.effectAllowed='copy';e.dataTransfer.setDragImage(e.currentTarget,25,25);setDraggingWalker(true)}} onDragEnd={()=>setDraggingWalker(false)} onClick={()=>walker?(setLevel(model.levelOf(walker.zoneId,walker.floorId)),setWalking(true)):setPlacingWalker(value=>!value)} aria-label={walker?'Enter walk mode from the person marker':'Drag person onto a floor or click to place'}><PersonStanding size={45} strokeWidth={2.2}/></button><span>{walker?'Walk from here':'Drag person inside'}</span><small>{walker?'Drag person to move':'or click person, then floor'}</small></div>}
      {walking&&<><div className="walk-hud"><Footprints size={18}/><div><strong>Walk mode</strong><span>Drag to look · W/S or ↑/↓ move · A/D or ←/→ turn · hold Shift to run</span></div><button onClick={()=>setWalking(false)}>Exit</button></div>{elevatorStop&&(elevatorStop.up||elevatorStop.down)&&<div className="walk-elevator" aria-label="Elevator"><strong>Elevator</strong>{elevatorStop.up&&<button onClick={()=>walkKey('KeyE',true)}>↑ {floorLabel(elevatorStop.up.level)} <kbd>E</kbd></button>}{elevatorStop.down&&<button onClick={()=>walkKey('KeyQ',true)}>↓ {floorLabel(elevatorStop.down.level)} <kbd>Q</kbd></button>}</div>}<div className="walk-pad" aria-label="Walk controls"><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyW',true)}} onPointerUp={()=>walkKey('KeyW',false)} onPointerCancel={()=>walkKey('KeyW',false)} aria-label="Walk forward">↑</button><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyA',true)}} onPointerUp={()=>walkKey('KeyA',false)} onPointerCancel={()=>walkKey('KeyA',false)} aria-label="Turn left">↶</button><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyS',true)}} onPointerUp={()=>walkKey('KeyS',false)} onPointerCancel={()=>walkKey('KeyS',false)} aria-label="Walk backward">↓</button><button onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);walkKey('KeyD',true)}} onPointerUp={()=>walkKey('KeyD',false)} onPointerCancel={()=>walkKey('KeyD',false)} aria-label="Turn right">↷</button></div></>}
      {draggingWalker&&<div className="walker-drop-hint">Drop onto a floor to start walking</div>}{placingWalker&&<div className="editor-hint walker-place-hint">Click a floor to place the person <button onClick={()=>setPlacingWalker(false)}>Cancel</button></div>}
      {editing&&!building.demo&&!scan&&<div className="geometry-notice">Scan walls unavailable for {editZone.name}. Only confirmed connections can be routed; they remain unverified.</div>}{editing&&<div className="editor-hint">{hint}</div>}
      <div className="viewer-toolbar"><div className="floor-switch"><Layers size={17}/><select aria-label="Visible floor" value={String(level)} onChange={e=>{setLevel(e.target.value==='all'?'all':Number(e.target.value));setWalking(false);setPlaying(false)}}><option value="all">3D building · all floors</option>{model.floors.map(item=><option key={item.level} value={item.level}>{item.name}{item.zoneIds.length>1?' · '+item.zoneIds.length+' zones':''}</option>)}</select></div><button onClick={()=>walking?setWalking(false):setReset(value=>value+1)} aria-label={walking?'Exit walk mode':'Reset camera view'}><RotateCcw size={17}/></button></div></div>
    <aside className="route-panel workspace-panel">
      <div className="mode-tabs" role="tablist"><button role="tab" aria-selected={!editing} className={!editing?'active':''} onClick={()=>changeTab('view')}><Eye size={14}/> View paths</button><button role="tab" aria-selected={editing} className={editing?'active':''} disabled={!base||status==='saving'} onClick={()=>changeTab('edit')}><Pencil size={14}/> Edit map</button></div>
      <div className="route-eyebrow">{editing?'EDIT WAYPOINTS & ZONES':'PLAN A ROUTE'}</div><h2>{editing?editZone.name:'Where to?'}</h2>
      {editing&&<><div role="status" className={'sync-status '+(formDirty&&status==='saved'?'unsynced':status)}>{statusText}</div>
        <div className="mode-row"><label>Data mode<select aria-label="Data mode" disabled={status==='saving'} value={mode} onChange={e=>modeChange(e.target.value as DataMode)}><option value="local">Local test · browser only</option>{!building.demo&&canEditFirebase()&&<option value="firebase">Firebase · shared graph</option>}</select></label></div></>}
      {!base&&status==='failed'&&mode!=='local'&&<button className="secondary" onClick={()=>modeChange('local')}>Open local test mode</button>}
      {remote&&<div className="conflict-box"><strong>Graph changed elsewhere</strong><p>Your draft has {graph.nodes.length} waypoints and {graph.edges.length} connections. The current shared graph has {remote.graph.nodes.length} waypoints and {remote.graph.edges.length} connections. Your draft is preserved.</p><button onClick={()=>resolveConflict(false)}>Keep draft as next version</button><button onClick={()=>resolveConflict(true)}>Discard draft and load remote</button></div>}
      {error&&<div role="alert" className="error">{error}</div>}{notice&&<div className="notice">{notice}</div>}
      {editing?<EditPanel model={model} zones={modelZones} editZoneId={editZoneId} switchZone={zoneId=>{switchZone(zoneId)}} graph={graph} scan={scan} disabled={status==='saving'||!base}
        tool={tool} setTool={next=>{setBoundaryPlacement(null);setTool(next)}} boundaryPlacement={boundaryPlacement} beginBoundaryPlacement={beginBoundaryPlacement}
        selected={selected} selectWaypoint={id=>selectNode(id?nodeKey(editZoneId,id):'')} form={form} setForm={setForm} formDirty={formDirty} applyForm={applyForm} remove={remove}
        connect={connect} disconnect={(from,to)=>change(disconnectWaypoints(graph,from,to))} runAutoConnect={runAutoConnect}
        zoneLayout={zoneLayout} layoutDirty={layoutDirty} layoutSaving={layoutSaving} changeLayout={changeLayout} floorNameValue={floorNameValue} setFloorName={setFloorName} autoAlign={autoAlign} shiftFloor={shiftFloor} alignFloorToElevators={alignFloorToElevators} persistLayout={()=>void persistLayout()}
        pending={pending} linkSaving={linkSaving} linkExisting={(kind,other)=>void linkExisting(kind,other)} beginPlacement={beginPlacement}
        pendingLink={pendingLink} finishPendingLink={()=>void finishPendingLink()} cancelPendingLink={()=>{setPendingLink(null);setTool('select')}}
        zoneLinks={zoneLinks} deleteZoneLink={connection=>void deleteZoneLink(connection)}
        blocked={blocked.length} unverified={checks.filter(check=>check.status==='unverified').length} warnings={checks.filter(check=>check.status==='warning').length}
        removeBlocked={()=>{if(window.confirm('Remove '+blocked.length+' blocked connections?'))change({...graph,edges:graph.edges.filter((_,index)=>checks[index].status!=='blocked')},'Blocked connections removed.')}}
        issues={issues} newBlocked={newBlocked.length} dirty={dirty} status={status} hasRemote={Boolean(remote)} save={()=>void save()} cancel={cancel} mode={mode}/>
      :<ViewPanel model={model} start={start} destination={destination} selectedKey={selectedKey} setStart={key=>{setStart(key);setShowRoute(true)}} setDestination={key=>{setDestination(key);setShowRoute(true)}}
        route={route} showRoute={()=>{setShowRoute(true);setPlaying(false);setStep(0);const a=model.byKey.get(start),b=model.byKey.get(destination);setLevel(a&&b&&a.level===b.level?a.level:'all')}}
        playing={playing} step={step} togglePreview={()=>{if(playing){setPlaying(false);return}if(!route?.ok)return;setWalking(false);setStep(0);setLevel(route.nodes[0].level);setPlaying(true)}}
        showLevel={value=>{setLevel(value);setWalking(false)}} canRoute={model.nodes.length>0} dirty={dirty} reviewEdits={()=>changeTab('edit')} localMode={mode==='local'&&!building.demo}/>}
    </aside></main>;
}
