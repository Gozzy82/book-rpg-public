import type {AiResponse,AiResponseRequest} from '../provider.js';
import type {TurnContract} from './turn-contract.js';
import {buildTurnScript} from './turn-script.js';
import type {assembleBeatBlockScene} from './beat-block-scene.js';
type Scene=ReturnType<typeof assembleBeatBlockScene>;
const dimensions=['perspective','action','order','resultingState'] as const;
export function beatBlockReviewRequest(contract:TurnContract,scene:Scene,model:string,effort:'low'|'medium'='low'):AiResponseRequest {
 const script=buildTurnScript(contract);
 const check={type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['pass','fail','uncertain']},reason:{type:'string'}},required:['status','reason']};
 const assessment={type:'object',additionalProperties:false,properties:{observedState:{type:'string'},...Object.fromEntries(dimensions.map(k=>[k,check]))},required:['observedState',...dimensions]};
 return {model,reasoning:{effort},max_output_tokens:3200,
  instructions:[
   'Review all supplied prose blocks as one ordered scene, then assess EACH block separately. Use only the supplied prose, identity and indexed transitions, never outside book knowledge. Do not rewrite the scene.',
   'viewpoint_character is the first-person narrator. Third-person description of that player acting is a perspective failure; other actors may be named and quoted dialogue may address the player by name.',
   'For action, require every material part of the assigned actor action in that block. A starts/tries beat is complete when the attempt visibly starts, without later success. A compatible end state alone does not prove the action occurred.',
   'For order, look across blocks for premature later actions, repeated completed actions, contradictions and reversals. An action depicted in the wrong block does not satisfy the assigned block. Retaining an ongoing attempt or unchanged physical facts is not repetition of completed action.',
   'Describe observedState from what the block actually narrates, including contradictions, then compare with desired_resulting_state. Do not copy the expectation as an observation. An appended assertion cannot undo a contradictory act earlier in the same block. Require concrete progress markers when indexed, not merely movement in their direction. Unspecified state facts carry forward; do not invent requirements.',
   'Return pass, fail or uncertain for each dimension, with a short concrete reason. Missing or contradictory evidence fails; genuinely ambiguous evidence is uncertain. A matching final scene cannot excuse earlier failures.',
   'titleIssues lists title defects such as a turn number. proseNotes lists readability problems such as redundant state recaps, incomplete sentences or awkward grammar. These are separate from the four beat dimensions. Return empty arrays when none.',
  ].join('\n'),
  input:JSON.stringify({viewpoint_character:contract.player,title:scene.title,source_start_state:script.source_start_state,
   blocks:scene.blocks.map((b,p)=>{const expected=script.ordered_execution.find(e=>e.beat_index===b.beatIndex);if(!expected)throw new Error('Unauthorized review block');return {
    key:`beat_${b.beatIndex}`,text:b.text,actor:expected.actor,action:expected.do,
    start_state:p===0?script.source_start_state:contract.beats[scene.blocks[p-1]!.beatIndex]!.resultingState??null,
    desired_resulting_state:expected.resulting_state,source_semantics:expected.source_semantics,
   };})}),
  text:{format:{type:'json_schema',name:'bookrpg_beat_block_review',strict:true,schema:{type:'object',additionalProperties:false,
   properties:{blocks:{type:'object',additionalProperties:false,properties:Object.fromEntries(scene.blocks.map(b=>[`beat_${b.beatIndex}`,assessment])),required:scene.blocks.map(b=>`beat_${b.beatIndex}`)},
    titleIssues:{type:'array',description:'Explanatory sentences about actual title defects only. Empty array for a valid title. Never beat keys or a list of checked beats.',items:{type:'string'}},proseNotes:{type:'array',items:{type:'string'}}},required:['blocks','titleIssues','proseNotes']}}},
 };
}
export function decodeBeatBlockReview(scene:Scene,response:AiResponse){
 if(response.status!=='completed')throw new Error('Incomplete block review');
 const value=JSON.parse(response.output_text);
 const keys=scene.blocks.map(b=>`beat_${b.beatIndex}`);
 if(!value||!value.blocks||Object.keys(value.blocks).length!==keys.length||Object.keys(value.blocks).some(k=>!keys.includes(k))
  ||['titleIssues','proseNotes'].some(k=>!Array.isArray(value[k])||value[k].some((s:unknown)=>typeof s!=='string')))throw new Error('Invalid block review');
 if(value.titleIssues.some((s:string)=>/^beat_\d+(?:[\s,;]+beat_\d+)*[.!]?$/i.test(s.trim())))throw new Error('Invalid title review: beat keys are not explanations of title defects');
 const findings:Array<{beatIndex:number;dimension:string;status:string;reason:string}>=[];
 for(const block of scene.blocks){
  const entry=value.blocks[`beat_${block.beatIndex}`];
  if(!entry||typeof entry.observedState!=='string'||!entry.observedState.trim())throw new Error('Missing observed block state');
  for(const dimension of dimensions){
   const check=entry[dimension];
   if(!check||!['pass','fail','uncertain'].includes(check.status)||typeof check.reason!=='string'||!check.reason.trim())throw new Error(`Invalid ${dimension} assessment`);
   if(check.status!=='pass')findings.push({beatIndex:block.beatIndex,dimension,...check});
  }
 }
 return {beatChecksPassed:findings.length===0,findings,assessments:value.blocks,titleIssues:value.titleIssues.map((s:string)=>s.trim()).filter(Boolean),proseNotes:value.proseNotes.map((s:string)=>s.trim()).filter(Boolean)};
}
