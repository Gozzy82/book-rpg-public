import type {GameChoice, GameState, SceneScope} from '../../shared/contracts.js';
import type {AiResponse, AiResponseRequest} from '../provider.js';
import {sceneScopeFailures, playerScopeAliases} from './scene-validation.js';
import {SceneGenerationError} from './core.js';

/** A read-only scene assessment: only omitted scope entries may be restored. */
export async function reviewResumeAnchor(
  state: GameState, anchor: GameChoice, model: string,
  call: (request: AiResponseRequest) => Promise<AiResponse>,
): Promise<SceneScope> {
  const scope=state.scene.sceneScope;
  if(!scope) throw new SceneGenerationError(['Cannot restore the saved anchor without a scene scope.'],1);
  const response=await call({
    model,reasoning:{effort:'low'},max_output_tokens:1400,
    instructions:'Review a saved scene before restoring its canonical menu anchor. Do not advance the story. Decide whether the proposed action can BEGIN from the CURRENT scene and its visible meaning; paraphrases suffice and spontaneous proposals need no new invitation. A later goal need not already have succeeded. Do not perform the action, invent arrivals, knowledge or missing setup. Restore omitted peoplePresent and peopleWithinSpeakingDistance entries only when the current prose establishes their current presence and conversational proximity. Names in the proposed action, memories, remote mentions, plans and future events are NOT evidence of presence. Preserve every existing list entry. Return supported=false if actual setup is missing, an actor is dead, a real barrier remains, or the action contradicts the scene. Do not infer future actions from book knowledge. The proposed action supplies only the action to assess, not facts to add. Location, narrative, memory and story progress cannot change.',
    input:JSON.stringify({player:state.playerName,scene_text:state.scene.text,original_scope:scope,
      known_characters:state.characterProfiles?.map(p=>({name:p.name,aliases:p.aliases})),
      confirmed_dead:state.confirmedDeadCharacters??[],proposed_action:anchor.text}),
    text:{format:{type:'json_schema',name:'bookrpg_resume_anchor_review',strict:true,schema:{
      type:'object',additionalProperties:false,properties:{
        supported:{type:'boolean'},reason:{type:'string'},
        peoplePresent:{type:'array',items:{type:'string'},maxItems:16},
        peopleWithinSpeakingDistance:{type:'array',items:{type:'string'},maxItems:16},
      },required:['supported','reason','peoplePresent','peopleWithinSpeakingDistance'],
    }}},
  });
  if(response.status!=='completed') throw new SceneGenerationError(['Incomplete saved anchor review.'],1);
  const v=JSON.parse(response.output_text);
  if(!v || v.supported!==true || typeof v.reason!=='string' || !v.reason.trim())
    throw new SceneGenerationError([`Saved anchor could not be restored: ${v?.reason??'missing review'}`],1);
  const valid=(xs:unknown):xs is string[]=>Array.isArray(xs)&&xs.length<=16
    && xs.every(n=>typeof n==='string'&&n.trim())&&new Set(xs).size===xs.length;
  if(Object.keys(v).some(k=>!['supported','reason','peoplePresent','peopleWithinSpeakingDistance'].includes(k))
    || !valid(v.peoplePresent)||!valid(v.peopleWithinSpeakingDistance)
    || scope.peoplePresent.some(n=>!v.peoplePresent.includes(n))
    || scope.peopleWithinSpeakingDistance.some(n=>!v.peopleWithinSpeakingDistance.includes(n))
    || v.peopleWithinSpeakingDistance.some((n:string)=>!v.peoplePresent.includes(n)))
    throw new SceneGenerationError(['Saved anchor review changed protected state.'],1);
  const corrected={...scope,peoplePresent:v.peoplePresent,peopleWithinSpeakingDistance:v.peopleWithinSpeakingDistance};
  const failures=sceneScopeFailures(corrected,{playerName:state.playerName,playerAliases:playerScopeAliases(state.playerName,state.characterProfiles),knownCharacterProfiles:state.characterProfiles,
    nonInteractableCharacters:state.confirmedDeadCharacters??[]});
  if(failures.length) throw new SceneGenerationError(failures,1);
  return corrected;
}
