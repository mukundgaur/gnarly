import { useEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { configured, login, logout } from './firebase';

export default function AuthDialog({connected,onClose,onBeforeLogout}:{connected:boolean;onClose:()=>void;onBeforeLogout:()=>boolean}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close()},[]);
  async function submit(){
    if(busy)return;
    if(connected&&!onBeforeLogout())return;
    setBusy(true);setError('');
    try{if(connected)await logout();else await login(email,password);setPassword('');onClose()}
    catch(failure){setError(failure instanceof Error?failure.message:String(failure))}
    finally{setBusy(false)}
  }
  return <dialog ref={dialog} className="modal auth-dialog" aria-labelledby="auth-title" onCancel={event=>{event.preventDefault();if(!busy)onClose()}}>
    <form onSubmit={event=>{event.preventDefault();void submit()}}>
      <button type="button" className="close" disabled={busy} onClick={onClose} aria-label="Close account dialog"><X size={19}/></button>
      <span className="route-eyebrow">LIVE DATA</span><h2 id="auth-title">{connected?'Firebase connected':'Connect to Firebase'}</h2>
      <p>{connected?'You’re signed in. Access to shared graphs follows your project’s permissions.':'Sign in with an existing account authorized for this project.'}</p>
      {!configured?<div className="notice">Firebase web configuration is required before you can sign in.</div>:<>
        {!connected&&<><label>Email<input autoFocus required type="email" autoComplete="username" value={email} disabled={busy} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input required type="password" autoComplete="current-password" value={password} disabled={busy} onChange={e=>setPassword(e.target.value)}/></label></>}
        {error&&<div className="error" role="alert">{error}</div>}
        <button className="primary" type="submit" disabled={busy}>{busy?'Please wait…':connected?'Sign out':'Sign in'}<ArrowRight size={17}/></button>
      </>}
    </form>
  </dialog>;
}
