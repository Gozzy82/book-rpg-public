import { turnCharacters } from "./turn-characters.js";
import { CHARACTER_RUNTIME_RULES } from "./character-runtime.js";
import type { TurnContract } from "./turn-contract.js";

/** Render only this turn's authorized execution window and one unperformed decision.
 * beat_index is turn-local; event_id/source_beat_index retain the persisted source origin.
 */
export function buildTurnScript(contract: TurnContract, includeSourceEvidence = true) {
  const context = JSON.parse(contract.contextJson);
  const indexes = [...contract.allowedPlayerBeatIndexes, ...contract.requiredAutomaticBeatIndexes].sort((a,b) => a-b);
  const required = contract.sourceProgression === "required";
  const next = required && contract.nextPlayerDecision !== null ? contract.beats[contract.nextPlayerDecision] : null;
  return {
    story_so_far: {current_scene: context.current_scene, recent_history: context.recent_history?.filter((entry: any) => entry.kind !== "scene" || entry.text !== context.current_scene?.text), story_memory: context.story_memory},
    player: {identity: contract.player, aliases: contract.playerAliases, profile: {name: contract.player, aliases: contract.playerAliases}},
    character_runtime_state: turnCharacters(contract),
    active_world_rules: contract.worldRules,
    selected_action: contract.sourceBeatSelection
      ? contract.selectedPlayerAction?.completion ?? contract.beats[contract.sourceBeatSelection.beatIndex]?.action
      : contract.selectedIntent,
    selected_choice: contract.sourceBeatSelection ? {value: contract.sourceBeatSelection.actionId ?? `${contract.eventId}:beat_${contract.sourceBeatSelection.beatIndex}`, label: contract.selectedIntent,
      player_beat_indexes: contract.allowedPlayerBeatIndexes, automatic_beat_indexes: contract.requiredAutomaticBeatIndexes} : null,
    player_action: contract.selectedPlayerAction ?? null,
    source_route: contract.sourceProgression,
    event_id: contract.eventId,
    source_start_beat_index: contract.startBeatIndex ?? 0,
    already_completed_beat_indexes: contract.completedBeatIndexes,
    source_start_state: (() => {
      const first = indexes[0] ?? contract.nextPlayerDecision;
      if (first === null || first === undefined) return null;
      if (first === contract.startBeatIndex && first > 0) return null;
      return contract.beats[first]?.automaticPreludeEndState
        ?? (first > 0 && contract.completedBeatIndexes.includes(first - 1) ? contract.beats[first - 1]?.resultingState : null) ?? null;
    })(),
    ordered_execution: indexes.map(index => ({
      beat_index: index,
      event_id: contract.beatOrigins?.[index]?.eventId ?? contract.eventId,
      source_beat_index: contract.beatOrigins?.[index]?.beatIndex ?? index,
      actor: contract.beats[index]!.actor, targets: contract.beats[index]!.targets,
      execution: contract.allowedPlayerBeatIndexes.includes(index) ? "selected_player_action" : "automatic_consequence",
      do: contract.beats[index]!.action,
      precondition: index === contract.startBeatIndex && index > 0 ? null : contract.beats[index]!.automaticPreludeEndState ?? null,
      resulting_state: contract.beats[index]!.resultingState ?? null,
      source_semantics: contract.beats[index]!.sourceSemantics ?? null,
      source_evidence: includeSourceEvidence ? contract.sourceEvidence[index] ?? "" : "",
      completion: "Visibly complete this exact action at its stated scope and resulting state; preserve actor and causal order. For starts/tries/attempts, beginning the attempt completes this beat without completing its ultimate goal. Do not extend it into next_decision.",
    })),
    next_decision: next ? {
      beat_index: contract.nextPlayerDecision,
      event_id: contract.nextPlayerDecisionOrigin?.eventId ?? contract.eventId,
      source_beat_index: contract.nextPlayerDecisionOrigin?.beatIndex ?? contract.nextPlayerDecision,
      actor: next.actor, action: contract.nextPlayerAction?.choiceText ?? next.action, targets: next.targets,
      entry_action: {beat_index: contract.nextPlayerDecision,
        event_id: contract.nextPlayerDecisionOrigin?.eventId ?? contract.eventId,
        source_beat_index: contract.nextPlayerDecisionOrigin?.beatIndex ?? contract.nextPlayerDecision,
        actor: next.actor, action: next.action},
      purpose: "setup_only", must_remain_unperformed: true,
      precondition_after_beat_index: contract.nextPlayerDecision! > 0 ? contract.nextPlayerDecision! - 1 : null,
      precondition: next.automaticPreludeEndState
        ?? (contract.nextPlayerDecision! > 0 ? contract.beats[contract.nextPlayerDecision! - 1]?.resultingState : null) ?? null,
      end_state_requirement: "Establish the conditions needed to BEGIN entry_action. The menu action may cover a whole group; its later steps and completion are not entry prerequisites. Ordinary approach, reaching and overcoming the stated difficulty belong after selection. Require relevant target/location/knowledge and no established barrier to beginning, not guaranteed success, exact distances or a fully completed route. Do not perform entry_action to establish readiness.",
    } : null,
    stopping_rule: contract.selectedPlayerAction
      ? "Attempt the selected player action through its permitted beats in source order. Stop at its completion or earlier on a concrete source/established-state-supported failure or interruption. Do not invent obstacles to avoid completion. Never introduce a new goal, information-dependent decision, materially different method or new material risk without a new choice. Travel, rescue, dialogue, investigation and other actions may complete when they are the selected goal. Missing prose is not an interruption."
      : required
      ? "Complete the ordered execution window, then stop before the next player act. If its prerequisites cannot be established from authorized beats, report missing setup; do not execute the next act."
      : "Resolve the selected input and its immediate consequences. Source progression is optional; do not force source beats or the next canonical choice into the scene.",
  };
}

export function renderTurnScript(contract: TurnContract, includeSourceEvidence = true): string {
  return [
    "ORDERED TURN SCRIPT (shared writer/reviewer contract; hidden control data):",
    JSON.stringify(buildTurnScript(contract, includeSourceEvidence)),
    ...CHARACTER_RUNTIME_RULES,
    "The scene title, prose and choices must use in-world language. Never copy control headings such as OPENING PRELUDE, beat numbers, ORDERED TURN SCRIPT or internal field names into them.",
    "For scene/dialogue generation: narrate ordered_execution in order from the player's perspective. These are this turn's permitted beats, not independent player choices. Do not stop after only the first beat. The selected action may begin at its immediate consequence when already established by the input.",
    "Opening prose should target 250–450 words, reserving room below the 600-word ceiling. Spend the words on concrete mandatory actions, not repeated atmosphere. Keep all choices in the separate menu; never append Choice:, options or a player decision prompt to scene text.",
    "INDEX CONFLICT PRECEDENCE: an action and its authorization determine what may happen. A resulting_state or precondition cannot introduce another actor's voluntary action not listed in the authorized window. When an indexed state mixes in such an act, preserve only the compatible physical facts; do not execute the extra act or treat its omission as failed progress. Indexing should represent that act separately with its own actor and agency.",
    "ATTEMPT BOUNDARY: when an authorized beat starts an attempt and next_decision completes it, narrate the attempt and intervening automatic actions, then stop with the goal still unresolved. For example, starting to retrieve an animal under furniture does not authorize catching, lifting or holding it when catching belongs to next_decision. Reaching toward it fulfills the attempt; the animal can remain reachable under the furniture. A completed attempt beat is not partial merely because its ultimate goal remains pending. Apply this distinction to both generation and review, including actionResult, actionOutcome and story memory.",
    "BOUND CHOICE IDENTITY: when selected_choice exists, value identifies the server-resolved action. Its label is display-only and grants no additional actions. Execute and review ordered_execution and player_action.completion, never infer scope from the label. A group may contain multiple selected player beats separated by automatic beats. Completing the selected group is not partial merely because the label suggests a wider future goal. After group completion, perform the listed automatic consequences and stop at next_decision. Ordinary NPC interleaving is not a failed player action.",
    "ORDERED GROUP CHECKPOINTS: grouping removes extra menu stops, not chronology. Depict each ordered_execution action through its own resulting_state before the next: if the start leaves an object unretrieved, keep it there through intervening NPC actions until the later catch/transfer beat. Never open with the group's completion as though selection had already executed it. After the final automatic checkpoint, preserve its posture, possession and location; do not add a recovery, renewed attempt or destination arrival even when next_decision is null. All player-owned actions remain I/me/my, not a separately named character.",
    "SOURCE SEMANTICS: narration is the current act of telling; narratedContent is history to convey, never physical events to reenact. Repeated jointAction IDs describe participants in one joint act, not successive phases. Shared candidate sentences may evidence multiple authorized participants; do not invent an intermediate state. These annotations grant no action outside the authorized window and no extra player choice.",
    "STATE PERSISTENCE: preserving a seated posture, held object or presence in a moving vehicle is not a new intentional player action. During an automatic window, depict the external change and retain those facts without adding a promise, speech or decision to wait. A future stay/wait choice requires new deliberate waiting, not just being carried by the authorized motion. Review actual new execution separately from unchanged physical state.",
    "SOURCE STATE CHECKPOINTS: source_start_state and precondition describe already-established canonical conditions, not actions to replay. Each executed action must visibly occur and pass through its resulting_state. State compatibility alone never proves an action happened. Carry position, possession, posture, open passages, presence and restraint forward until an authorized later action explicitly changes them. Never silently reverse a checkpoint or use next_decision to move, transfer possession, close a passage or complete a rescue. Established interactive facts take precedence over incompatible canon; do not reset a diverged game to its canonical state.",
    "ENTRY STATE CHECKPOINT: next_decision.precondition is the indexed end state after precondition_after_beat_index. When that preceding beat is visibly completed (or already established), carry its compatible resulting state into readiness for the entry action. Do not independently demand extra geometry, guaranteed success or later group outcomes. This checkpoint is not proof the preceding beat occurred: missing execution or an explicit contradictory scene fact still requires repair. Treat the checkpoint as partial state; retain compatible earlier location and other facts.",
    "For review: check the candidate against this exact script, beat by beat, and verify readiness to BEGIN next_decision.entry_action. When ordered_execution is complete and next_decision is present, set futureActionSetupRequired true; supported means its entry action can begin from the visible end state, not that every subsequent group step can already succeed. Instructions, source evidence and metadata are not proof of visible completion. Report actual partial unselected acts as violations, with evidence of the correct actor acting at the correct time.",
    "When next_decision represents an indexed player goal, its menu text selects the full bounded player action AFTER selection. Its entry_action defines readiness BEFORE selection. Later group steps may establish their own conditions during execution. The player-action metadata never authorizes anything before selection. Concrete failed or interrupted player-action attempts resolve the input without guaranteeing success. Do not demand canonical next-decision setup after a grounded interruption.",
    "For choice construction/review: use the candidate's validated end state. next_decision is a future selectable action, never an instruction to perform it in prose; do not offer it until the ordered progression and necessary setup are complete. On a required source route, choices[0] must offer this exact next intentional player decision; missing setup requires scene repair, never replacing it with generic preparation. Choices[1+] are free alternatives and need not advance or preserve future canon.",
    "This script is the source-window authority for this turn. A menu position alone grants no authorization. Generic single-beat pacing never truncates this ordered automatic window; a source continuation still grants no additional voluntary player action.",
  ].join("\n");
}
