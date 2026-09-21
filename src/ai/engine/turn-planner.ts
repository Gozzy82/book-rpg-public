import { playerActionAt } from "../../shared/player-actions.js";
import type { AiResponse, AiResponseRequest } from "../provider.js";
import { planTurn, playerControlsBeat, TurnExecutionError } from "./turn-contract.js";

/** Resolve semantic paraphrases before writing, without authorizing a later decision window. */
export async function resolveTurnPlan(
  input: Parameters<typeof planTurn>[0],
  model: string,
  review: (request: AiResponseRequest) => Promise<AiResponse>,
) {
  const contract = planTurn(input);
  if (!contract.selectedIntent || contract.allowedPlayerBeatIndexes.length > 0) return contract;
  const candidates: Array<{index: number; action: string}> = [];
  for (let index = contract.startBeatIndex ?? 0; index < contract.beats.length; index++) {
    if (contract.completedBeatIndexes.includes(index)) continue;
    const beat = contract.beats[index]!;
    if (!playerControlsBeat(beat, contract.playerAliases)) break;
    candidates.push({index, action: beat.action});
  }
  if (candidates.length === 0) return contract;
  const firstPending = contract.beats.findIndex((_, i) => i >= (contract.startBeatIndex ?? 0) && !contract.completedBeatIndexes.includes(i));
  const group = input.state.playerActionVersion === 2 && contract.sourceProgression === "required"
    ? playerActionAt(contract.beats, firstPending, contract.playerAliases) : undefined;
  const response = await review({model, max_output_tokens: 1600, reasoning: {effort: "low"},
    instructions: [
      "Resolve only the player's explicitly selected intent against the supplied immediate source player beats.",
      "Return the length of the contiguous prefix explicitly authorized by selected_input. Return zero when none match or the meaning is uncertain.",
      "Accept semantic paraphrases, including dialogue utterances that perform the listed speech act. Preserve negation, participants, objects and direction of action.",
      "A prerequisite, possibility, refusal, topic overlap, or implied later action is not authorization. Never count an action merely because source material says it happens.",
      "Multiple beats require an explicitly selected compound action covering every counted beat. Do not write story prose or infer any completed progress.",
      ...(group ? ["selectedPlayerAction may be true only when selected_input explicitly selects the entire supplied candidate_player_action goal, including a semantic paraphrase. A question utterance can perform its listed question goal. Merely starting, reaching, asking about a goal, refusing, limiting the scope, or choosing another action is not full-goal consent. New information, commitments and changed methods beyond the group's endpoint stay unselected. When uncertain return false and evaluate only the immediate prefix. Current state and world rules can prevent execution; canonical completion is never guaranteed."] : []),
    ].join("\n"),
    input: JSON.stringify({player: contract.player, playerAliases: contract.playerAliases,
      activeWorldRules: contract.worldRules, selected_input: contract.selectedIntent, candidate_player_beats: candidates, ...(group ? {candidate_player_action: group, context: JSON.parse(contract.contextJson)} : {})}),
    text: {format: {type: "json_schema", name: "bookrpg_turn_intent_review", strict: true,
      schema: {type: "object", additionalProperties: false, properties: {
        ...(group ? {selectedPlayerAction: {type: "boolean"}} : {}),
        selectedPrefixLength: {type: "integer", minimum: 0, maximum: candidates.length}, reason: {type: "string"},
      }, required: ["selectedPrefixLength", "reason", ...(group ? ["selectedPlayerAction"] : [])]}}},
  });
  let verdict: {selectedPrefixLength: number; reason: string; selectedPlayerAction?: boolean};
  try {
    verdict = JSON.parse(response.output_text);
    if (response.status !== "completed" || !verdict || typeof verdict.reason !== "string"
      || !Number.isInteger(verdict.selectedPrefixLength) || (group && typeof verdict.selectedPlayerAction !== "boolean")) throw new Error("invalid verdict");
  } catch {
    throw new TurnExecutionError("review_unavailable", "The selected intent could not be verified against the source boundary.");
  }
  return planTurn({...input, reviewedSelectedPrefixLength: verdict.selectedPrefixLength, reviewedPlayerAction: Boolean(group && verdict.selectedPlayerAction)});
}

