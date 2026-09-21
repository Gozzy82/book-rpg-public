import { CONVERSATIONAL_REACH_POLICY } from "../../shared/conversational-reach-policy.js";
import type { AiResponseRequest } from "../provider.js";
import type { TurnContract } from "./turn-contract.js";

/** A saved canonical choice already has an execution plan. Do not also send the
 * legacy free-input/anchor planner directives and a second copy of game history. */
export function canonicalSceneRequest(request: AiResponseRequest, contract: TurnContract): AiResponseRequest {
  const marker = request.input.lastIndexOf("GAME CONTEXT:\n");
  let context: Record<string, unknown>;
  try {
    if (marker < 0) throw new Error("No legacy context");
    context = JSON.parse(request.input.slice(marker + "GAME CONTEXT:\n".length));
  } catch {
    // Non-legacy adapters retain their own payload.
    return {...request, reasoning: {effort: request.reasoning?.effort === "minimal" ? "minimal" : "low"},
      max_output_tokens: Math.max(request.max_output_tokens ?? 0, 4000)};
  }
  const repair = request.input.match(/REJECTED BECAUSE:\n((?:- [^\n]*(?:\n|$))+)/)?.[1]?.trim() ?? null;
  return {...request,
    reasoning: {effort: request.reasoning?.effort === "minimal" ? "minimal" : "low"},
    max_output_tokens: Math.max(request.max_output_tokens ?? 0, 4000),
    input: JSON.stringify({
      book: context.book, game_profile: context.game_profile, objective: context.objective,
      victoryCondition: context.victoryCondition, status: context.status, position: context.position,
      selected_choice_label: contract.selectedIntent, repair_feedback: repair,
    }),
    instructions: [
      CONVERSATIONAL_REACH_POLICY,
      "Write the next BookRPG scene in first person as the player in the appended ordered turn script. Use the book's language and tone, without long source quotations.",
      contract.selectedIntent === null
        ? "There is no selected player action. Narrate only the ordered automatic window. Carry forward the player's established posture and possessions while the external event happens; do not add speech, promises, intentional waiting, voluntary movement or a later decision. Stop as soon as the authorized external change is established."
        : "The saved choice value has already selected the action and its boundaries. Do not plan a route to the whole event, infer extra actions from the label, or replay story_so_far. Execute ordered_execution in order, preserving its intermediate states and stopping at its final state before next_decision. Selection authorizes execution; it does not mean the action has already happened.",
      "Use concise prose proportional to the actions, usually 120–220 words for a short window. Add length only for necessary dialogue or distinct acts, never to fill a paragraph quota. No extra reversal, recovery or goal after the last beat.",
      "Repair feedback identifies faults in a rejected draft, not new world facts or permission to extend the action window. Return a complete replacement scene.",
      contract.selectedIntent === null
        ? "Set playerAction and actionResult to empty strings, actionOutcome to none, and externalDevelopment to the visible automatic change. Never copy the previous turn's choice as current authorization."
        : "Copy selected_choice_label into playerAction. Set actionOutcome and actionResult to the actual bounded result, not a wider ultimate goal. Describe automatic consequences in externalDevelopment. Keep those metadata fields out of the visible text.",
      "Return a fresh title without a turn number, scene text without choices, and sceneScope with only characters actually present or within speaking distance at the end. Do not silently revive, move or duplicate characters.",
      "Update storyMemory from story_so_far with only established events. Keep summary under 900 characters, at most 6 openThreads and 12 durable canonFacts. Do not store future source events or unselected options as facts.",
      "Preserve the objective and victoryCondition. Follow game_profile.endingMode: won only for a fulfilled win condition, completed for a completion ending, active for unresolved or open-ended play, lost only if the objective is irreversibly impossible. Explain terminal outcomes in outcomeReason. Set sourceChapterPosition only when the authorized source development visibly occurs.",
    ].join("\n"),
  };
}

