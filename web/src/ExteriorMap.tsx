import {useEffect,useState} from 'react';
import {APIProvider,Map,AdvancedMarker,useMap} from '@vis.gl/react-google-maps';
import {MapContainer,TileLayer,Marker,Popup,useMap as useLeafletMap} from 'react-leaflet';
import L from 'leaflet';
import type {Building} from './data';
const googleKey=import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const mapId=import.meta.env.VITE_GOOGLE_MAPS_MAP_ID||'DEMO_MAP_ID';
const icon=L.divIcon({className:'building-pin',html:'<span>⌂</span>',iconSize:[42,42],iconAnchor:[21,42]});
function GoogleFocus({point}:{point:[number,number]}){const map=useMap();useEffect(()=>{map?.panTo({lat:point[0],lng:point[1]});map?.setZoom(16)},[map,point]);return null}
function LeafletFocus({point}:{point:[number,number]}){const map=useLeafletMap();useEffect(()=>{map.flyTo(point,16,{duration:1.2})},[map,point]);return null}
export default function ExteriorMap({buildings,selected,onSelect}:{buildings:Building[];selected:Building|null;onSelect:(building:Building)=>void}){const [googleFailed,setGoogleFailed]=useState(false);const point:[number,number]=[selected?.lat||42.4536,selected?.lng||-76.4735];if(googleKey&&!googleFailed)return <APIProvider apiKey={googleKey} onError={()=>setGoogleFailed(true)}><Map className="map" defaultCenter={{lat:42.4536,lng:-76.4735}} defaultZoom={15} mapId={mapId} gestureHandling="greedy" disableDefaultUI><GoogleFocus point={point}/>{buildings.filter(b=>b.lat&&b.lng).map(b=><AdvancedMarker key={b.id} position={{lat:b.lat!,lng:b.lng!}} onClick={()=>onSelect(b)} title={b.name}><div className="google-building-pin">⌂</div></AdvancedMarker>)}</Map></APIProvider>;return <MapContainer center={[42.4536,-76.4735]} zoom={15} zoomControl={false} className="map"><TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><LeafletFocus point={point}/>{buildings.filter(b=>b.lat&&b.lng).map(b=><Marker key={b.id} position={[b.lat!,b.lng!]} icon={icon} eventHandlers={{click:()=>onSelect(b)}}><Popup>{b.name} · {b.graph?'Indoor map available':'Indoor map unavailable'}</Popup></Marker>)}</MapContainer>}
