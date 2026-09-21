import type {AiResponse, AiResponseRequest} from '../provider.js';
import type {TurnContract} from './turn-contract.js';
import {turnContractInstructions} from './turn-contract.js';
import {withTurnReview, decodeTurnReview} from './turn-review.js';
import {withSharedStoryPolicy} from './shared-policy.js';
import {reducePresenceReview} from './turn-validator.js';
import {scenePresenceReviewJsonSchema} from '../schema.js';
export interface FallReviewFixture {
  sourceLog: string; contract: TurnContract; baseInput: Record<string,unknown>;
  cases: Array<{name:string; text:string; expectedAccepted:boolean; expectFall:boolean; expectFinalMatch:boolean}>;
}
export function fallReviewRequest(f:FallReviewFixture, i:number, model:string, effort:'low'|'medium'='low'):AiResponseRequest {
  const sample=f.cases[i];if(!sample)throw new Error('Missing case');
  const request=withSharedStoryPolicy('scene presence review',withTurnReview('scene presence review',{
    model,reasoning:{effort},max_output_tokens:3200,
    input:JSON.stringify({...f.baseInput,candidate_scene:{text:sample.text}}),
    text:{format:{type:'json_schema',name:'bookrpg_scene_presence_review',strict:true,schema:scenePresenceReviewJsonSchema}},
  },f.contract));
  return {...request,instructions:[request.instructions,turnContractInstructions(f.contract,false)].join('\n')};
}
export function scoreFallReview(f:FallReviewFixture,i:number,request:AiResponseRequest,response:AiResponse) {
  if(response.status!=='completed')throw new Error(`Incomplete review: ${JSON.stringify(response.incomplete_details)}`);
  const decoded=decodeTurnReview('scene presence review',request,response);
  const observed=JSON.parse(decoded.output_text);
  const decision=JSON.parse(reducePresenceReview(f.contract,decoded).output_text).turnValidation;
  const sample=f.cases[i]!;
  const fallCompleted=observed.beat_observations?.beat_6?.status==='completed';
  const fallCheckpoint=observed.checkpoint_observations?.beat_6?.matches;
  const finalMatches=observed.final_checkpoint?.matches;
  const fallCorrect=sample.expectFall ? fallCompleted && fallCheckpoint===true : !fallCompleted && fallCheckpoint===false;
  return {passed:Boolean((decision.status==='accepted')===sample.expectedAccepted && fallCorrect && finalMatches===sample.expectFinalMatch),
    fallCorrect,finalMatches,fallCompleted,fallCheckpoint,decision,observed};
}
