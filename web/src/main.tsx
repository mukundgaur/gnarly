import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Building2, ChevronRight, Database, LocateFixed, Navigation, Search, ShieldCheck, X } from 'lucide-react';
import ExteriorMap from './ExteriorMap';
import AuthDialog from './AuthDialog';
import { demoBuilding, type Building } from './data';
import { configured, watchUser, listBuildings, loadBuilding, loadPreviousBuildingVersion } from './firebase';
import 'leaflet/dist/leaflet.css';
import './style.css';
const BuildingWorkspace = lazy(() => import('./BuildingWorkspace'));
const FirebaseData = lazy(() => import('./FirebaseData'));
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

class ErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <main className="app-fallback"><h1>Something went wrong</h1><p>Reload to reopen the explorer. Saved graphs and backed-up drafts will remain available.</p><button className="primary" onClick={() => window.location.reload()}>Reload explorer</button></main> : this.props.children;
  }
}
function App() {
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [dataDirty, setDataDirty] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [live, setLive] = useState<Building[]>([]);
  const [user, setUser] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMap, setLoadingMap] = useState(false);
  const [selected, setSelected] = useState<Building | null>(null);
  const [inside, setInside] = useState(false);
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const selectionRequest = useRef(0);
  useEffect(() => watchUser(u => setUser(Boolean(u))), []);
  useEffect(() => {
    let active = true;
    setLoadError('');
    if (!user) { setLive([]); setLoadingList(false); return; }
    setLoadingList(true);
    listBuildings().then(next => { if (active) setLive(next); })
      .catch(e => { if (active) setLoadError(failureMessage(e)); })
      .finally(() => { if (active) setLoadingList(false); });
    return () => { active = false; };
  }, [user, refresh]);
  const buildings = [demoBuilding, ...live];
  const query = search.trim().toLowerCase();
  const filtered = buildings.filter(b => b.name.toLowerCase().includes(query) || b.graph?.nodes.some(n => n.label?.toLowerCase().includes(query)));
  async function select(building: Building, previous = false) {
    const request = ++selectionRequest.current;
    setInside(false); setSelected(building); setLoadingMap(!building.demo);
    if (building.demo) return;
    try {
      const loaded = await (previous ? loadPreviousBuildingVersion(building) : loadBuilding(building));
      if (selectionRequest.current !== request) return;
      setSelected(loaded);
      if (!previous) setLive(items => items.map(item => item.id === loaded.id ? loaded : item));
    } catch (e) {
      if (selectionRequest.current === request) setSelected({ ...building, notice: failureMessage(e) });
    } finally { if (selectionRequest.current === request) setLoadingMap(false); }
  }
  function closeDetails() { selectionRequest.current++; setSelected(null); setLoadingMap(false); }
  function back() { setInside(false); setWorkspaceDirty(false); }
  function canLeave() {
    if (dataOpen && dataDirty) return window.confirm('Discard the unsaved JSON changes?');
    return !workspaceDirty || window.confirm('Leave with unsaved edits? Your draft will remain in this tab.');
  }
  function home() { if (!canLeave()) return; setDataOpen(false); setDataDirty(false); back(); }
  function openData() {
    if (dataOpen) return;
    if (!canLeave()) return;
    back(); setDataOpen(true);
  }
  return <div className="app">
    <header className="topbar">
      <button className="brand" onClick={home} aria-label="Gnarly home"><span className="brand-mark"><Navigation size={20}/></span><span>gnarly<span className="brand-dot">.</span></span></button>
      <div className="top-label">Indoor navigation</div>
      <div className="top-actions">
        <button className={'data-nav '+(dataOpen?'active':'')} onClick={openData} aria-label="Firebase data"><Database size={15}/> Data</button>
        <button className={'account '+(user?'connected':'')} aria-label={user?'Firebase account':'Connect Firebase'} onClick={() => setAuthOpen(true)}><ShieldCheck size={15}/>{user?'Connected':'Sign in'}</button>
      </div>
    </header>
    <Suspense fallback={<div className="page-loading" role="status"><span className="loading-ring"/>Opening explorer…</div>}>
      {dataOpen ? <FirebaseData connected={user} onDirtyChange={setDataDirty} onClose={() => {setDataOpen(false);setDataDirty(false)}} onConnect={() => setAuthOpen(true)}/>
        : inside && selected?.graph ? <BuildingWorkspace key={selected.id+':'+selected.activeVersion} building={selected} onBack={back} onUpdate={setSelected} onDirtyChange={setWorkspaceDirty}/>
        : <main className={'map-area '+(selected?'has-selection':'')}>
          <ExteriorMap buildings={buildings} selected={selected} onSelect={select}/><div className="map-tint"/>
          <aside className="map-panel glass">
            <div className="search-shell"><Search size={17}/><input aria-label="Search buildings and destinations" placeholder="Search buildings or rooms" value={search} onChange={e => setSearch(e.target.value)}/>{search&&<button onClick={() => setSearch('')} aria-label="Clear search"><X size={15}/></button>}</div>
            <div className="map-intro"><h1>Find your way inside</h1><p>Pick a building to explore its floors and preview a route.</p></div>
            <div className="list-head"><span>Buildings</span><span role="status">{loadingList?'Loading…':filtered.length+' found'}</span></div>
            <div className="building-list">{filtered.map(b => <button className={'building-row '+(selected?.id===b.id?'active':'')} key={b.id} onClick={() => void select(b)}><span className="building-icon"><Building2 size={21}/></span><span className="building-copy"><strong>{b.name}</strong><small>{b.demo?'Sample building · 2 floors':b.graph?'Indoor map available':b.activeVersion?'Open to load indoor map':'Indoor map unavailable'}</small></span><ChevronRight size={18}/></button>)}{!filtered.length&&<div className="empty">No matches for “{search}”.<button className="secondary" onClick={() => setSearch('')}>Show all buildings</button></div>}</div>
            {!configured&&<div className="connect-hint">Viewing sample data. Connect your Firebase project to load live buildings.</div>}
            {loadError&&<div role="alert" className="error">{loadError}<button className="secondary" onClick={() => setRefresh(value => value+1)}>Retry loading buildings</button></div>}
          </aside>
          {selected&&<aside className="detail-card glass" aria-busy={loadingMap}>
            <button className="close" onClick={closeDetails} aria-label="Close details"><X size={18}/></button>
            <div className="detail-top"><div className="detail-icon"><Building2 size={22}/></div><span className={selected.graph?'status':'status muted'}>{loadingMap?'LOADING INDOOR MAP':selected.graph?'INDOOR MAP AVAILABLE':'MAP UNAVAILABLE'}</span></div>
            <h2>{selected.name}</h2><p>{selected.demo?'Illustrative campus demo building':(selected.viewingPreviousVersion?'Previous version':selected.status)+' · '+(selected.activeVersion||'No active version')}</p>
            <div className="stats"><div><strong>{selected.graph?.floors.length??'—'}</strong><span>FLOORS</span></div><div><strong>{selected.graph?.nodes.filter(n=>n.type==='destination').length??'—'}</strong><span>DESTINATIONS</span></div><div><strong>{selected.graph?.edges.length??'—'}</strong><span>PATHS</span></div></div>
            {selected.notice&&<div className="notice">{selected.notice}</div>}
            <button className="primary" disabled={!selected.graph||loadingMap} onClick={() => setInside(true)}>{loadingMap?'Loading map…':'Explore inside'}<ArrowRight size={17}/></button>
            {!selected.graph&&!selected.demo&&selected.activeVersion&&<button className="secondary" disabled={loadingMap} onClick={() => void select(selected,true)}>Try a previous version <ArrowRight size={16}/></button>}
          </aside>}
          <div className="map-caption glass"><LocateFixed size={14}/> Cornell area, Ithaca NY</div>
        </main>}
    </Suspense>
    {authOpen&&<AuthDialog connected={user} onClose={() => setAuthOpen(false)} onBeforeLogout={canLeave}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>);
