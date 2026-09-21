import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {AiResponseRequest} from './provider.js';
import {loadDotEnv,loadAiApiKey} from '../util/env.js';
import {createDefaultResponse} from '../books/analyze/identity.js';
import type {TurnContract} from './engine/turn-contract.js';
import {assembleBeatBlockScene} from './engine/beat-block-scene.js';
import {rewriteAndReviewBeatScene,decodeRewrittenSceneReview,type BookStyle} from './engine/rewrite-beat-scene.js';
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('npm run measure:rewrite -- --from RUN_DIRECTORY [--model MODEL] [--reasoning low|medium] [--out DIRECTORY]\nReuses saved contract.json and scene.json. One rewrite and one combined beat/final-state review: at most two calls, no regeneration/retries. Defaults to gpt-5.6-luna and low reasoning. Original run is unchanged.');process.exit(0);}
const options=new Map<string,string>();
for(let i=0;i<args.length;i+=2){if(!['--from','--model','--reasoning','--out'].includes(args[i]!)||!args[i+1]||args[i+1]!.startsWith('--')||options.has(args[i]!))throw new Error('Invalid arguments; use --help');options.set(args[i]!,args[i+1]!);}
if(!options.has('--from'))throw new Error('--from RUN_DIRECTORY is required');
const effort=options.get('--reasoning')??'low';if(effort!=='low'&&effort!=='medium')throw new Error('Use low or medium reasoning');
const source=path.resolve(options.get('--from')!);
const contract:TurnContract=JSON.parse(await readFile(path.join(source,'contract.json'),'utf8'));
if(!['event_13c38b29b37ba87191c5','event_5b3afb6e1e10b0544fd3'].includes(contract.eventId??''))throw new Error('This style pilot supports only the existing Oz fixtures');
const original=JSON.parse(await readFile(path.join(source,'scene.json'),'utf8'));
const bare=assembleBeatBlockScene(contract,{status:'completed',output_text:JSON.stringify({title:original.title,blocks:Object.fromEntries(original.blocks.map((b:any)=>[`beat_${b.beatIndex}`,b.text]))})});
if(bare.text!==original.text||original.blocks.length!==bare.blocks.length)throw new Error('Stored scene does not match its beat blocks');
const style:BookStyle=JSON.parse(await readFile(new URL('../../test/fixtures/oz-rewrite-style.json',import.meta.url),'utf8'));
const directory=path.resolve(options.get('--out')??`data/scene-rewrite-measurements/${new Date().toISOString().replaceAll(':','-')}`);
if(directory===source)throw new Error('Output must differ from original run');
await mkdir(directory,{recursive:true});
const save=(name:string,value:unknown)=>writeFile(path.join(directory,name),JSON.stringify(value,null,2));
await save('contract.json',contract);await save('original-scene.json',bare);await save('style.json',style);
loadDotEnv();loadAiApiKey();const model=options.get('--model')??'gpt-5.6-luna',client=createDefaultResponse();
const started=Date.now(),calls:Array<{stage:string;elapsedMs:number;usage:unknown}>=[];
let fidelity:ReturnType<typeof decodeRewrittenSceneReview>|undefined;
const report=()=>({source,model,effort,calls,elapsedMs:Date.now()-started,productionChanged:false,manualAcceptance:'pending',reviewMode:'single',fidelity});
const call=async(stage:string,request:AiResponseRequest)=>{
 await save(`${stage}-request.json`,request);console.log(`${stage}: ${model}/${effort}`);
 const timing={stage,elapsedMs:0,usage:null as unknown};calls.push(timing);const start=Date.now();
 try{const response=await client(request);timing.usage=response.usage??null;await save(`${stage}-response.json`,response);return response;}
 finally{timing.elapsedMs=Date.now()-start;}
};
try{
 const result=await rewriteAndReviewBeatScene(contract,bare,style,model,call,async scene=>{
  await save('scene.json',scene);await writeFile(path.join(directory,'scene.md'),`# ${scene.title}\n\n${scene.text}\n`);
  await save('report.json',report());
 },effort);
 fidelity=result.review;
 const checksPassed=fidelity.checksPassed;
 await save('report.json',{...report(),checksPassed});
 console.log(checksPassed?'Model checks passed; inspect the rewritten scene and verdicts.':'Model checks failed; output saved without retry.');
}catch(error){await save('report.json',{...report(),checksPassed:false,error:String(error)});console.log('ERROR (no retry)');process.exitCode=1;}
console.log(`Saved ${directory}`);
