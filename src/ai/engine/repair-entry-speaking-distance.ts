import type {AiResponse, AiResponseRequest} from '../provider.js';
import type {Scene, StoryMemory} from '../../shared/contracts.js';
import {CONVERSATIONAL_REACH_POLICY} from '../../shared/conversational-reach-policy.js';
import {SceneGenerationError} from './core.js';

/** Add missing presence/audibility metadata only; never change approved narrative state. */
export async function repairEntrySpeakingDistance(
  scene: Scene & {storyMemory?: StoryMemory}, reason: string, model: string,
  call: (label: string, request: AiResponseRequest) => Promise<AiResponse>, label: string,
): Promise<Scene & {storyMemory?: StoryMemory}> {
  const original = scene.sceneScope!;
  const evidence = {scene_text: scene.text, original_scope: original, rejection: reason};
  const response = await call(`${label} speaking distance repair`, {model, reasoning:{effort:'low'}, max_output_tokens:800,
    instructions: CONVERSATIONAL_REACH_POLICY + '\nCorrect only missing peoplePresent and peopleWithinSpeakingDistance entries supported by the CURRENT scene text. Keep every existing entry in each list. A person explicitly participating in the current scene may be added to peoplePresent even if the original list omitted them. Add them to peopleWithinSpeakingDistance only when the prose also establishes conversational proximity. Every speaking-distance entry must occur in the repaired peoplePresent list. Correct metadata omissions, never create an arrival, movement, changed location, new story presence, inferred consent or invented dialogue. Mere mentions, memories, future visits and offscreen people do not establish current presence. Nonverbal characters can be within speaking distance. If this cannot resolve the rejection without another change, return the original lists. Return only the two lists; no narrative or memory.',
    input:JSON.stringify(evidence), text:{format:{type:'json_schema', name:'bookrpg_entry_speaking_distance_repair',strict:true,schema:{type:'object',additionalProperties:false,properties:{peoplePresent:{type:'array',items:{type:'string'}},peopleWithinSpeakingDistance:{type:'array',items:{type:'string'}}},required:['peoplePresent','peopleWithinSpeakingDistance']}}}});
  if(response.status!=='completed') throw new SceneGenerationError(['Incomplete entry speaking-distance repair.'],1);
  const patch = JSON.parse(response.output_text);
  const present = patch?.peoplePresent;
  const names = patch?.peopleWithinSpeakingDistance;
  const validNames = (value: unknown): value is string[] => Array.isArray(value)
    && value.every(n => typeof n === 'string' && n.trim().length > 0)
    && new Set(value).size === value.length;
  if(!patch || Object.keys(patch).length!==2
    || !validNames(present) || !validNames(names)
    || original.peoplePresent.some(n=>!present.includes(n))
    || original.peopleWithinSpeakingDistance.some(n=>!names.includes(n))
    || names.some(n=>!present.includes(n))) {
    throw new SceneGenerationError(['Entry speaking-distance repair changed protected state or added an absent character.'],1);
  }
  const scope = {...original, peoplePresent:present, peopleWithinSpeakingDistance:names};
  const review = await call(`${label} speaking distance review`, {model,reasoning:{effort:'low'},max_output_tokens:1000,
    instructions:CONVERSATIONAL_REACH_POLICY + '\nReview only the proposed presence and speaking-distance corrections against scene_text. Confirm each addition to peoplePresent is already physically present in the current prose, not merely mentioned, remembered, expected or acting offscreen. Confirm each addition to peopleWithinSpeakingDistance also has established conversational proximity. A character visibly participating in the conversation may be restored to both lists without inventing an arrival. The original scope rejection must be fully resolved. Presence alone is insufficient if distance or barriers remain. Location, existing list entries, narrative and memory are frozen. No future source is evidence. Return supported=false if the rejection needs other changes or evidence is missing. Do not reassess narrative readiness, beliefs, motivation or pending choices; none of that content changed.',
    input:JSON.stringify({...evidence,proposed_scope:scope}),text:{format:{type:'json_schema',name:'bookrpg_entry_speaking_distance_review',strict:true,schema:{type:'object',additionalProperties:false,properties:{supported:{type:'boolean'},reason:{type:'string'}},required:['supported','reason']}}}});
  if(review.status!=='completed')throw new SceneGenerationError(['Incomplete entry speaking-distance review.'],1);
  const verdict=JSON.parse(review.output_text);
  if(verdict?.supported!==true || typeof verdict.reason!=='string' || !verdict.reason.trim())
    throw new SceneGenerationError([`Source event entry sceneScope: ${verdict?.reason ?? 'Missing scope review.'}`],1);
  return {...scene,sceneScope:scope};
}
