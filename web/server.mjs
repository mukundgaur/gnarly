import {createServer} from 'node:http';
import {createReadStream,existsSync,statSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';

const port=Number(process.env.PORT||5173);
const bucket=process.env.FIREBASE_STORAGE_BUCKET||'gnarly-e65c1.firebasestorage.app';
const root=resolve('dist');
const prefix='/__firebase_storage/v0/b/'+encodeURIComponent(bucket)+'/o/';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};

createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://localhost:${port}`);
  if(req.method!=='GET'){res.writeHead(405).end();return}
  if(url.pathname.startsWith('/__firebase_storage/')){
    if(!url.pathname.startsWith(prefix)||url.searchParams.get('alt')!=='media'){res.writeHead(400).end('Invalid Storage path');return}
    try{
      const upstream=await fetch('https://firebasestorage.googleapis.com'+url.pathname.replace(/^\/__firebase_storage/,'')+url.search);
      res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/octet-stream','Cache-Control':'private, max-age=60'});
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }catch{res.writeHead(502).end('Storage request failed')}
    return;
  }
  const requested=resolve(root,'.'+decodeURIComponent(url.pathname));
  const file=requested.startsWith(root+sep)&&existsSync(requested)&&statSync(requested).isFile()?requested:resolve(root,'index.html');
  if(!existsSync(file)){res.writeHead(404).end('Build not found');return}
  res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});
  createReadStream(file).pipe(res);
}).listen(port,()=>console.log('Gnarly web ready at http://localhost:'+port));
