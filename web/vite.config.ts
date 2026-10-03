import {defineConfig,loadEnv} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({mode})=>{
  const env=loadEnv(mode,process.cwd(),'VITE_');
  const bucket=env.VITE_FIREBASE_STORAGE_BUCKET;
  const prefix=bucket?'/__firebase_storage/v0/b/'+encodeURIComponent(bucket)+'/o/':'';
  return {
    plugins:[react()],
    server:{proxy:prefix?{[prefix]:{target:'https://firebasestorage.googleapis.com',changeOrigin:true,rewrite:path=>path.replace(/^\/__firebase_storage/,'')}}:{}},
  };
});
