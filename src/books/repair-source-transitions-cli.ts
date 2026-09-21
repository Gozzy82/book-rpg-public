import fs from 'node:fs/promises';
import path from 'node:path';
import {dataDir,loadDotEnv} from '../util/env.js';
import {getBook,saveBook} from './repository.js';
import {repairSourceTransitions,type TransitionRepair} from './source-index/repair-transitions.js';
loadDotEnv();
const args=process.argv.slice(2), values=new Map<string,string>();
let apply=false;
for(let i=0;i<args.length;i++) {
  const arg=args[i]!;
  if(arg==='--apply'){apply=true;continue;}
  if(!['--book','--patch'].includes(arg)||values.has(arg)||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('Use --book ID --patch FILE [--apply]');
  values.set(arg,args[++i]!);
}
if(!values.get('--book')||!values.get('--patch'))throw new Error('Use --book ID --patch FILE [--apply]');
const original=await getBook(values.get('--book')!);
if(!original)throw new Error('Book not found');
const patch=JSON.parse(await fs.readFile(values.get('--patch')!,'utf8')) as TransitionRepair;
const repaired=repairSourceTransitions(original,patch);
console.log(JSON.stringify({applied:false,changes:repaired.storyEvents!.filter(e=>patch.events.some(c=>c.eventId===e.eventId)).map(e=>({eventId:e.eventId,sequence:e.sequence,beats:e.beats})),restartWithNewGame:true},null,2));
if(apply){
  if(JSON.stringify(await getBook(original.bookId))!==JSON.stringify(original))throw new Error('Book changed during repair');
  const directory=path.join(dataDir(),'source-transition-repairs',new Date().toISOString().replaceAll(':','-'));
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'original-book.json'),JSON.stringify(original,null,2));
  await fs.writeFile(path.join(directory,'repair.json'),JSON.stringify(patch,null,2));
  await saveBook(repaired);
  console.log(JSON.stringify({applied:true,backup:directory,restartWithNewGame:true}));
}
