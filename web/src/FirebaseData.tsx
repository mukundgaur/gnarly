import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Database, FileJson, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { canEditFirebase, listDataRecords, loadStorageData, saveDataRecord, type DataRecord } from './firebase';

type Props = { connected: boolean; onClose: () => void; onConnect: () => void; onDirtyChange?: (dirty: boolean) => void };
const assetFields = ['buildingJsonPath', 'scanFeaturesPath', 'scanJsonPath'];

export default function FirebaseData({ connected, onClose, onConnect, onDirtyChange }: Props) {
  const requests=useRef(0),assetRequest=useRef(0);
  const [recordSearch,setRecordSearch]=useState('');
  const [records, setRecords] = useState<DataRecord[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [review, setReview] = useState(false);
  const [asset, setAsset] = useState<{ path: string; content: string } | null>(null);
  const selected = records.find(item => item.path === selectedPath);
  const editor = connected && canEditFirebase();
  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(draft);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Document JSON must be an object.');
      return { value: value as Record<string, unknown>, error: '' };
    } catch (failure) { return { value: null, error: failure instanceof Error ? failure.message : String(failure) }; }
  }, [draft]);
  const changed = selected && parsed.value ? Object.keys(parsed.value).filter(key => JSON.stringify(parsed.value?.[key]) !== JSON.stringify(selected.data[key])) : [];
  const removed = selected && parsed.value ? Object.keys(selected.data).filter(key => !(key in parsed.value!)) : [];
  const dirty = Boolean(selected && draft !== JSON.stringify(selected.data, null, 2));
  useEffect(()=>onDirtyChange?.(dirty),[dirty,onDirtyChange]);
  useEffect(()=>{if(!dirty)return;const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[dirty]);

  async function refresh(preferred = selectedPath) {
    if (!connected) return;
    const request=++requests.current;
    setBusy(true); setError('');
    assetRequest.current++;setAsset(null);
    try {
      const next = await listDataRecords();
      if(request!==requests.current)return;
      setRecords(next);
      const chosen = next.find(item => item.path === preferred) || next[0];
      setSelectedPath(chosen?.path || '');
      setDraft(chosen ? JSON.stringify(chosen.data, null, 2) : '');
      setReview(false);
    } catch (failure) { if(request===requests.current)setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if(request===requests.current)setBusy(false); }
  }
  useEffect(() => { if (connected) void refresh(''); else { setRecords([]); setSelectedPath('');setDraft('');setAsset(null);setBusy(false); } return()=>{requests.current++;assetRequest.current++} }, [connected]);
  function select(item: DataRecord) {
    if (dirty && !window.confirm('Discard the unsaved JSON changes?')) return;
    assetRequest.current++;
    setSelectedPath(item.path); setDraft(JSON.stringify(item.data, null, 2)); setReview(false); setAsset(null); setError(''); setMessage('');
  }
  async function save() {
    if (!selected || !parsed.value) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await saveDataRecord(selected.path, selected.data, parsed.value);
      setRecords(items=>items.map(item=>item.path===selected.path?{...item,data:parsed.value!}:item));
      setDraft(JSON.stringify(parsed.value,null,2));setReview(false);
      setMessage('Saved to Firestore.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  async function inspectAsset(path: string) {
    const request=++assetRequest.current;
    setAsset({ path, content: 'Loading…' }); setError('');
    try { const content=JSON.stringify(await loadStorageData(path),null,2);if(request===assetRequest.current)setAsset({path,content}); }
    catch (failure) { if(request===assetRequest.current)setAsset({ path, content: 'Unavailable: ' + (failure instanceof Error ? failure.message : String(failure)) }); }
  }
  return <main className="data-page">
    <div className="data-heading"><div><button className="back" disabled={busy} onClick={() => { if (!dirty || window.confirm('Discard the unsaved JSON changes?')) onClose(); }}><ArrowLeft size={17}/> Back to map</button><span className="route-eyebrow">FIREBASE DATA</span><h1>Project records</h1><p>Inspect building metadata, versions, zones, and navigation records.</p></div><button className="data-refresh" disabled={busy || !connected} onClick={() => { if (dirty && !window.confirm('Discard the unsaved JSON changes?')) return; void refresh(); }}><RefreshCw size={16}/> Refresh</button></div>
    {error&&<div className="error data-error" role="alert">{error}</div>}
    {!connected ? <div className="data-empty"><Database size={30}/><h2>Connect to Firebase</h2><p>Sign in to browse project records.</p><button className="primary" onClick={onConnect}>Connect Firebase</button></div> : <div className="data-layout">
      <aside className="data-sidebar"><strong>{records.length} DOCUMENTS</strong><input className="record-search" aria-label="Search Firebase documents" placeholder="Filter documents…" value={recordSearch} onChange={e=>setRecordSearch(e.target.value)}/>{records.filter(item=>item.path.toLowerCase().includes(recordSearch.trim().toLowerCase())).map(item => <button disabled={busy} key={item.path} className={item.path === selectedPath ? 'active' : ''} onClick={() => select(item)}><span>{item.path.split('/').at(-1)}</span><small>{item.path}</small></button>)}{!busy && !records.length && <p>No documents found.</p>}</aside>
      <section className="data-detail">{selected ? <><div className="data-detail-head"><div><span className="route-eyebrow">FIRESTORE DOCUMENT</span><h2>{selected.path.split('/').at(-1)}</h2><code>{selected.path}</code></div><span className={'data-access ' + (editor ? 'editable' : '')}><ShieldCheck size={14}/>{editor ? 'Admin editing' : 'Read only'}</span></div>
        <p className="data-caption">Edit this document’s JSON, then review the field changes before saving. Timestamp and GeoPoint values use tagged objects to preserve their types.</p>
        <textarea aria-label="Document JSON" className="data-json" spellCheck={false} readOnly={!editor||busy} value={draft} onChange={event => { setDraft(event.target.value); setReview(false); setMessage(''); }} />
        {parsed.error && <div className="error">JSON: {parsed.error}</div>}
        {editor && <div className="data-actions"><button disabled={!dirty || Boolean(parsed.error) || busy || !(changed?.length || removed?.length)} onClick={() => setReview(true)}><Save size={15}/> Review changes</button>{dirty && <button disabled={busy} onClick={() => { setDraft(JSON.stringify(selected.data, null, 2)); setReview(false); }}>Discard edits</button>}</div>}
        {review && parsed.value && <div className="data-review"><strong>Save changes to {selected.path}?</strong><p>{changed?.length ? 'Updated fields: ' + changed.join(', ') : ''}{removed?.length ? ' · Removed fields: ' + removed.join(', ') : ''}</p><button className="primary" disabled={busy} onClick={save}>Save to Firestore</button></div>}
        {message && <div className="data-success" role="status">{message}</div>}
        {assetFields.filter(field => typeof selected.data[field] === 'string').length > 0 && <div className="data-assets"><h3>Linked JSON assets <small>· read only</small></h3>{assetFields.filter(field => typeof selected.data[field] === 'string').map(field => <button key={field} onClick={() => void inspectAsset(String(selected.data[field]))}><FileJson size={15}/><span>{field}</span><small>{String(selected.data[field])}</small></button>)}{asset && <div className="data-asset-preview"><div><strong>{asset.path}</strong><button onClick={() => {assetRequest.current++;setAsset(null)}}>Close</button></div><pre>{asset.content}</pre></div>}</div>}
      </> : <div className="data-empty">{busy ? 'Loading records…' : 'Select a document to inspect.'}</div>}</section>
    </div>}
  </main>;
}
