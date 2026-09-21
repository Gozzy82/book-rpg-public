import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {configuredAiModel} from './provider.js';
import {loadDotEnv,loadAiApiKey} from '../util/env.js';
import {createDefaultResponse} from '../books/analyze/identity.js';
import {fallReviewRequest,scoreFallReview,type FallReviewFixture} from './engine/measure-fall-review.js';
import {endStateObservationRequest,decodeEndStateObservation,endStateComparisonRequest,decodeEndStateComparison} from './engine/observe-end-state.js';
const args=process.argv.slice(2);
if(args.includes('--help')) {console.log('npm run measure:fall -- [--mode end-state|presence] [--model MODEL] [--reasoning low|medium] [--out DIRECTORY]\nDefault end-state mode: three fixed scenes, two small calls per scene (observation then comparison), one attempt per stage, no retries. No scene generation. Presence mode retains the original review measurement. Defaults: configured game model, low reasoning.');process.exit(0);}
const options=new Map<string,string>();
for(let i=0;i<args.length;i+=2){if(!['--model','--reasoning','--out','--mode'].includes(args[i]!)||!args[i+1]||args[i+1]!.startsWith('--')||options.has(args[i]!))throw new Error('Invalid arguments; use --help');options.set(args[i]!,args[i+1]!);}
const effort=options.get('--reasoning')??'low';if(effort!=='low'&&effort!=='medium')throw new Error('Use low or medium reasoning');
const mode=options.get('--mode')??'end-state';if(mode!=='end-state'&&mode!=='presence')throw new Error('Use end-state or presence mode');
loadDotEnv();loadAiApiKey();
const model=options.get('--model')||configuredAiModel();
const fixture:FallReviewFixture=JSON.parse(await readFile(new URL('../../test/fixtures/fall-review.json',import.meta.url),'utf8'));
const directory=path.resolve(options.get('--out')||`data/fall-review-measurements/${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'fixture.json'),JSON.stringify(fixture,null,2));
const createResponse=createDefaultResponse(),results:unknown[]=[];
console.log(`Mode ${mode}; three cases: ${model}/${effort}, one attempt per case, no retries.`);
for(const [i,sample] of fixture.cases.entries()){
 if(mode==='end-state'){
  const started=Date.now();const calls:Array<{stage:string;elapsedMs:number;usage:unknown}>=[];
  const call=async(stage:string,request:ReturnType<typeof endStateObservationRequest>)=>{
   await writeFile(path.join(directory,`${sample.name}-${stage}-request.json`),JSON.stringify(request,null,2));
   const start=Date.now();const response=await createResponse(request);
   calls.push({stage,elapsedMs:Date.now()-start,usage:response.usage??null});
   await writeFile(path.join(directory,`${sample.name}-${stage}-response.json`),JSON.stringify(response,null,2));return response;
  };
  console.log(`${i+1}/3: ${sample.name} (observe then compare)`);
  try{
   const observed=decodeEndStateObservation(await call('observe',endStateObservationRequest(sample.text,fixture.contract.player,model,effort)),sample.text);
   const indexes=[...fixture.contract.allowedPlayerBeatIndexes,...fixture.contract.requiredAutomaticBeatIndexes].sort((a,b)=>b-a);
   const expected=fixture.contract.beats[indexes[0]!] ?.resultingState;
   if(!expected)throw new Error('Missing final authorized resultingState');
   const comparison=decodeEndStateComparison(await call('compare',endStateComparisonRequest(observed,expected,fixture.contract.player,model,effort)));
   const passed=comparison.matches===sample.expectFinalMatch;
   results.push({name:sample.name,mode,model,effort,elapsedMs:Date.now()-started,calls,passed,observed,expected,comparison,scope:'final-state comparison only; beat completion and production acceptance not tested'});
   console.log(passed?'PASS':'FAIL');
  }catch(error){results.push({name:sample.name,mode,model,effort,elapsedMs:Date.now()-started,calls,passed:false,error:String(error)});console.log('ERROR (no retry)');}
  await writeFile(path.join(directory,'report.json'),JSON.stringify(results,null,2));continue;
 }
 const request=fallReviewRequest(fixture,i,model,effort);await writeFile(path.join(directory,`${sample.name}-request.json`),JSON.stringify(request,null,2));
 const started=Date.now();console.log(`${i+1}/3: ${sample.name}`);
 try{
  const response=await createResponse(request);await writeFile(path.join(directory,`${sample.name}-response.json`),JSON.stringify(response,null,2));
  const score=scoreFallReview(fixture,i,request,response);results.push({name:sample.name,model,effort,elapsedMs:Date.now()-started,usage:response.usage,...score});console.log(score.passed?'PASS':'FAIL');
 }catch(error){results.push({name:sample.name,model,effort,elapsedMs:Date.now()-started,passed:false,error:String(error)});console.log('ERROR (no retry)');}
 await writeFile(path.join(directory,'report.json'),JSON.stringify(results,null,2));
}
console.log(`Saved ${directory}`);
