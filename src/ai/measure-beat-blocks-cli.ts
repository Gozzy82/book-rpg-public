import {oilBeatPilotContract} from './engine/oil-beat-pilot.js';
import type {BookStoryEvent} from '../shared/contracts.js';
import {generateParallelBeatScene} from './engine/parallel-beat-scene.js';
import {beatBlockReviewRequest,decodeBeatBlockReview} from './engine/beat-block-review.js';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {AiResponseRequest} from './provider.js';
import {configuredAiModel} from './provider.js';
import {loadDotEnv,loadAiApiKey} from '../util/env.js';
import {createDefaultResponse} from '../books/analyze/identity.js';
import type {FallReviewFixture} from './engine/measure-fall-review.js';
import {beatBlockSceneRequest,assembleBeatBlockScene,reviewBeatBlockEnding} from './engine/beat-block-scene.js';
const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('npm run measure:beat-blocks -- [--case toto|oil] [--generation parallel|combined] [--model MODEL] [--reasoning low|medium] [--out DIRECTORY]\nDefault parallel: four (toto) or five (oil) concurrent bare factual single-beat generation calls, no reviews or retries, 1600 output tokens each. Combined mode: one scene generation followed by independent end-state observation/comparison and one review of all individual blocks: at most four calls, one attempt per stage, no retries or AI rewrite. Model defaults to the configured game model with low reasoning; combined generation uses 4000 output tokens. Saves blocks, assembled scene and indexed actions for manual review. Does not change gameplay or the book index.');process.exit(0);
}
const options=new Map<string,string>();
for(let i=0;i<args.length;i+=2){if(!['--model','--reasoning','--out','--generation','--case'].includes(args[i]!)||!args[i+1]||args[i+1]!.startsWith('--')||options.has(args[i]!))throw new Error('Invalid arguments; use --help');options.set(args[i]!,args[i+1]!);}
const effort=options.get('--reasoning')??'low';if(effort!=='low'&&effort!=='medium')throw new Error('Use low or medium reasoning');
const generation=options.get('--generation')??'parallel';if(generation!=='parallel'&&generation!=='combined')throw new Error('Use parallel or combined generation');
const caseName=options.get('--case')??'toto';if(caseName!=='toto'&&caseName!=='oil')throw new Error('Use toto or oil case');
loadDotEnv();loadAiApiKey();
const model=options.get('--model')||configuredAiModel();
const fixture:Pick<FallReviewFixture,'contract'>=caseName==='toto'
 ? JSON.parse(await readFile(new URL('../../test/fixtures/fall-review.json',import.meta.url),'utf8'))
 : {contract:oilBeatPilotContract((JSON.parse(await readFile(new URL('../../test/fixtures/import-goals/existing-character-events.json',import.meta.url),'utf8')) as BookStoryEvent[])[1]!)};

const directory=path.resolve(options.get('--out')||`data/beat-block-measurements/${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(directory,{recursive:true});
const save=(name:string,value:unknown)=>writeFile(path.join(directory,name),JSON.stringify(value,null,2));

await save('contract.json',fixture.contract);
const started=Date.now();
const client=createDefaultResponse();
const calls:Array<{stage:string;elapsedMs:number;usage:unknown}>=[];
let structureValid=false;
let blocks:unknown[]=[];
let endStateReview:Awaited<ReturnType<typeof reviewBeatBlockEnding>>|undefined;
let blockReview:ReturnType<typeof decodeBeatBlockReview>|undefined;
const report=()=>({model,effort,generation,caseName,writingStyle:generation==='parallel'?'bare-factual-v2':'combined-prose',calls:calls.length,stages:calls,elapsedMs:Date.now()-started,structureValid,
 semanticAcceptance:'pending human inspection of prose and any model verdicts',productionChanged:false,blocks,endStateReview,blockReview,
 endStateStatus:generation==='parallel'?'not_requested':endStateReview?(endStateReview.comparison.matches?'matched':'mismatched'):'unavailable',
 blockReviewStatus:generation==='parallel'?'not_requested':blockReview?(blockReview.beatChecksPassed?'passed':'failed'):'unavailable'});
const call=async(stage:string,r:AiResponseRequest)=>{
 await save(stage==='generate'?'request.json':`${stage}-request.json`,r);
 const timing={stage,elapsedMs:0,usage:null as unknown};calls.push(timing);
 const start=Date.now();console.log(`${stage} (${model}/${effort})...`);
 try{
  const response=await client(r);timing.usage=response.usage??null;
  await save(stage==='generate'?'response.json':`${stage}-response.json`,response);return response;
 }finally{timing.elapsedMs=Date.now()-start;}
};
if(generation==='parallel'){
 console.log(`${caseName}: ${fixture.contract.allowedPlayerBeatIndexes.length+fixture.contract.requiredAutomaticBeatIndexes.length} concurrent generation calls; no reviews, retries or rewriting.`);
 try {
  const result=await generateParallelBeatScene(fixture.contract,model,effort,(index,r)=>call(`beat-${index}`,r));
  structureValid=result.scene!==null;
  blocks=result.blocks.map(b=>({...b,actor:fixture.contract.beats[b.beatIndex]!.actor,action:fixture.contract.beats[b.beatIndex]!.action,resultingState:fixture.contract.beats[b.beatIndex]!.resultingState}));
  await save('blocks.json',result.blocks);
  if(result.scene){await save('scene.json',result.scene);await writeFile(path.join(directory,'scene.md'),`# ${result.scene.title}\n\n${result.scene.text}\n`);}
  const usageTotals=calls.reduce((sum,c)=>{const u=c.usage as any;return {input_tokens:sum.input_tokens+(u?.input_tokens??0),output_tokens:sum.output_tokens+(u?.output_tokens??0),total_tokens:sum.total_tokens+(u?.total_tokens??0)};},{input_tokens:0,output_tokens:0,total_tokens:0});
  await save('report.json',{...report(),failures:result.failures,usageTotals,usageComplete:calls.every(c=>c.usage!==null),
   timing:{wallMs:Date.now()-started,sumRequestMs:calls.reduce((sum,c)=>sum+c.elapsedMs,0),slowestRequestMs:Math.max(0,...calls.map(c=>c.elapsedMs))}});
  console.log(structureValid?'Scene assembled; inspect each transition and the joins.':'Failed beats retained in report; no incomplete scene assembled.');
  if(!structureValid)process.exitCode=1;
 }catch(error){await save('report.json',{...report(),error:String(error)});process.exitCode=1;}
}else{
const request=beatBlockSceneRequest(fixture.contract,model,effort);
console.log(`${caseName}: at most four calls; no retries or rewriting.`);
try{
 const scene=assembleBeatBlockScene(fixture.contract,await call('generate',request));
 structureValid=true;
 blocks=scene.blocks.map(b=>({...b,actor:fixture.contract.beats[b.beatIndex]!.actor,action:fixture.contract.beats[b.beatIndex]!.action,resultingState:fixture.contract.beats[b.beatIndex]!.resultingState}));
 await save('scene.json',scene);
 await writeFile(path.join(directory,'scene.md'),`# ${scene.title}\n\n${scene.text}\n`);
 await save('report.json',{...report(),endStateStatus:'pending'});
 endStateReview=await reviewBeatBlockEnding(fixture.contract,scene.text,model,effort,call);
 await save('report.json',{...report(),endStateStatus:endStateReview.comparison.matches?'matched':'mismatched',endStateReview});
 blockReview=decodeBeatBlockReview(scene,await call('blocks-review',beatBlockReviewRequest(fixture.contract,scene,model,effort)));
 await save('report.json',report());
 console.log(blockReview.beatChecksPassed?'Block checks passed; inspect verdicts and prose notes.':'Block checks failed; see findings in report.json.');
 console.log(endStateReview.comparison.matches?'Final state matches; inspect the individual beats and prose.':'Final state mismatch; draft saved without retry.');
}catch(error){await save('report.json',{...report(),error:String(error)});console.log('ERROR (no retry)');process.exitCode=1;}
}
console.log(`Saved ${directory}`);
