import type {AiResponseRequest} from '../../src/ai/provider.js';
/** Mock acceptance for tests concerned with subsequent entry transitions. */
export function acceptedCanonicalReview(request:AiResponseRequest) {
 const input=JSON.parse(request.input),check={status:'pass',reason:'Fixture evidence supports this check.'};
 return {status:'completed' as const,output_text:JSON.stringify({resolvedSceneScope:input.candidate_scene.sceneScope,
  blocks:Object.fromEntries(input.expected_beats.map((b:any)=>[b.key,{observedState:'Fixture checkpoint',...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,check]))}])),
  titleIssues:[],proseNotes:[],finalState:{...check,observedState:'Fixture final state'},productionChecks:Object.fromEntries(['continuity','authorization','worldRules','sceneScope','storyMemory','outcome','nextDecisionSetup'].map(k=>[k,check]))})};
}
