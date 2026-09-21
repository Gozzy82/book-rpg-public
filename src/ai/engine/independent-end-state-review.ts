import type {AiResponse, AiResponseRequest} from '../provider.js';
import {type TurnContract} from './turn-contract.js';
import {validateTurnEvidence} from './turn-validator.js';
import {EndStateReviewFormatError, endStateObservationRequest, decodeEndStateObservation, endStateComparisonRequest, decodeEndStateComparison} from './observe-end-state.js';

/** Production uses the independent observer for final state; keep intermediate beat checks. */
export function withIndependentFinalState(request:AiResponseRequest):AiResponseRequest {
 const schema=request.text?.format.schema as any;
 if(!schema?.properties?.final_checkpoint)return request;
 const {final_checkpoint:_,...properties}=schema.properties;
 return {...request,text:{format:{...request.text!.format,schema:{...schema,properties,required:schema.required.filter((key:string)=>key!=='final_checkpoint')}}},
  instructions:[request.instructions,'The final_checkpoint field is deliberately omitted: an independent review checks the final physical state. Report intermediate checkpoint_observations and beat execution normally; do not infer a missing beat from a compatible final state.'].join('\n')};
}

export async function reviewIndependentEndState(contract:TurnContract,decoded:AiResponse,text:string,model:string,
 call:(label:string,request:AiResponseRequest)=>Promise<AiResponse>):Promise<AiResponse> {
 if(contract.sourceProgression!=='required'||decoded.status!=='completed')return decoded;
 const raw=JSON.parse(decoded.output_text);
 const decision=validateTurnEvidence(contract,raw);
 // Do not spend additional calls on an already rejected draft. Grounded stops have
 // their own observed outcome, not the canonical success checkpoint.
 if(decision.status==='repair_scene'||decision.actionOutcome)return decoded;
 const last=decision.authorizedCompletedBeatIndexes.at(-1);
 if(last===undefined)return decoded;
 const expected=contract.beats[last]?.resultingState;
 if(!expected)return decoded;
 let observed,comparison;
 try {
  observed=decodeEndStateObservation(await call('scene end-state observation',endStateObservationRequest(text,contract.player,model)),text);
  comparison=decodeEndStateComparison(await call('scene end-state comparison',endStateComparisonRequest(observed,expected,contract.player,model)));
 }catch(error){
  if(!(error instanceof EndStateReviewFormatError))throw error;
  // No approval without usable evidence. Let the existing bounded scene-repair
  // loop handle this draft instead of aborting the whole turn on review formatting.
  return {...decoded,output_text:JSON.stringify({...raw,
    independent_end_state:{beatIndex:last,status:'unavailable',reason:error.message},
    checkpointFindings:[...(raw.checkpointFindings??[]),{beatIndexes:[last],message:`Final state could not be verified: ${error.message}. Depict the authorized actions and their final indexed state clearly.`}],
  })};
 }
 return {...decoded,output_text:JSON.stringify({...raw,
  independent_end_state:{beatIndex:last,observed,expected,comparison},
  checkpointFindings:[...(raw.checkpointFindings??[]),...(!comparison.matches?[{beatIndexes:[last],message:`Final state: ${observed.finalState}. ${comparison.reason}`}]:[])],
 })};
}
