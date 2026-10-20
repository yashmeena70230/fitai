import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const file of ['server.js','public/app.js','public/service-worker.js','scripts/build.mjs','scripts/create-icons.mjs']){const checked=spawnSync(process.execPath,['--check',path.join(root,file)],{stdio:'inherit'});if(checked.status!==0)process.exit(checked.status??1);}
const icon=spawnSync(process.execPath,[path.join(root,'scripts','create-icons.mjs')],{stdio:'inherit'});
if(icon.status!==0)process.exit(icon.status??1);
const publicDir=path.join(root,'public'),dist=path.join(root,'dist','public');
JSON.parse(await fs.readFile(path.join(publicDir,'manifest.webmanifest'),'utf8'));
await fs.rm(path.join(root,'dist'),{recursive:true,force:true});
await fs.mkdir(dist,{recursive:true});
await fs.cp(publicDir,dist,{recursive:true});
console.log(`FitAI production assets built in ${path.relative(root,dist)}`);
