import type {BookStoryEvent} from '../../shared/contracts.js';
import {applyCharacterChoiceRanges} from '../../books/analyze/character-action-groups.js';
import {planTurn} from './turn-contract.js';

/** Existing indexed event with the same 7–11 Dorothy rescue grouping; no source rewrite. */
export function oilBeatPilotContract(event:BookStoryEvent) {
 if(event.eventId!=='event_13c38b29b37ba87191c5')throw new Error('Expected the stored Tin Woodman rescue event');
 const ranges=[
  {startBeatIndex:0,endBeatIndex:1,label:'Search for water and refresh yourself',boundaryReason:'Water search and breakfast completed.'},
  {startBeatIndex:2,endBeatIndex:6,label:'Investigate the nearby groan',boundaryReason:'The immobilized Tin Woodman is discovered and explains his predicament.'},
  {startBeatIndex:7,endBeatIndex:11,label:'Rescue the Tin Woodman with the oil-can',boundaryReason:'The Tin Woodman can move all his joints.'},
 ];
 const grouped=applyCharacterChoiceRanges(event,{name:'Dorothy',aliases:[]},ranges);
 const group=grouped.beats![7]!.characterActionGroup!;
 return planTurn({mode:'action',sourceProgression:'required',event:grouped,selectedIntent:group.choiceText,
  sourceBeatSelection:{eventId:event.eventId,beatIndex:7,endBeatIndex:11,kind:'player_action',actionId:group.id,playerBeatIndexes:group.playerBeatIndexes},
  state:{playerName:'Dorothy',playerActionVersion:2,characterProfiles:[],parameters:[],worldRules:[],turnNumber:1,
   sourceEventProgress:{eventId:event.eventId,completedBeatIndexes:[0,1,2,3,4,5,6]},
   scene:{title:'The immobilized Tin Woodman',text:event.beats![6]!.resultingState!,choices:[]},history:[]},
 });
}
