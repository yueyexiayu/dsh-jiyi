// Explicit installation step only; the plugin runtime never downloads models.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {EMBEDDING_MODEL,EMBEDDING_VERSION} from '../lib/models.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await readFile(resolve(root,'models/manifest.json'),'utf8'));
if(manifest.model!==EMBEDDING_MODEL||manifest.version!==EMBEDDING_VERSION||!/^[a-f0-9]{40}$/.test(manifest.sourceRevision))throw Error('Model manifest does not match the installed runtime.');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [name,spec] of Object.entries(manifest.files)){
  const path=resolve(root,'models',manifest.model,name);
  if(!path.startsWith(resolve(root,'models',manifest.model)+'/'))throw Error('Unsafe model asset path.');
  let bytes;
  try{bytes=await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(bytes){
    if(bytes.length!==spec.bytes||digest(bytes)!==spec.sha256)throw Error(`Existing model asset is corrupt: ${name}; restore it explicitly before retrying.`);
    console.log(`Verified ${name}`);continue;
  }
  const url=`${manifest.source}/resolve/${manifest.sourceRevision}/${name}`;
  console.log(`Downloading ${name} (${spec.bytes} bytes)`);
  const response=await fetch(url,{signal:AbortSignal.timeout(900000)});
  if(!response.ok)throw Error(`Model download failed: HTTP ${response.status} (${name})`);
  const chunks=[];let received=0,nextProgress=16*1024*1024;
  for await(const chunk of response.body){
    received+=chunk.length;
    if(received>spec.bytes)throw Error(`Model download exceeds declared size: ${name}`);
    chunks.push(chunk);
    if(received>=nextProgress){console.log(`${name}: ${received}/${spec.bytes} bytes`);nextProgress+=16*1024*1024;}
  }
  bytes=Buffer.concat(chunks,received);
  if(bytes.length!==spec.bytes||digest(bytes)!==spec.sha256)throw Error(`Downloaded model asset checksum mismatch: ${name}`);
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,bytes,{flag:'wx',mode:0o644});
  console.log(`Installed and verified ${name}`);
}
console.log(`Ready: ${manifest.model} (${manifest.version}); runtime networking remains disabled.`);
