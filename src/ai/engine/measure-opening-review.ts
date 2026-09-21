import type { AiResponseRequest, AiResponse } from "../provider.js";
import { scenePresenceReviewJsonSchema } from "../schema.js";
import { type TurnContract, turnContractInstructions } from "./turn-contract.js";
import { withTurnReview, decodeTurnReview } from "./turn-review.js";
import { withSharedStoryPolicy } from "./shared-policy.js";
import { reducePresenceReview } from "./turn-validator.js";

export interface OpeningReviewFixture {
  sourceLog: string;
  contract: TurnContract;
  baseInput: Record<string, unknown>;
  cases: Array<{name: string; expectedNextStatus: "absent" | "completed"; expectedSetup: boolean; scene: {text: string; [key: string]: unknown}}>;
}

/** Replay only presence review using the same request transforms and evidence reducer as gameplay. */
export function openingReviewRequest(fixture: OpeningReviewFixture, caseIndex: number, model: string): AiResponseRequest {
  const sample = fixture.cases[caseIndex];
  if (!sample || fixture.contract.mode !== "opening") throw new Error("Expected a captured opening case");
  const base: AiResponseRequest = {model, reasoning: {effort: "medium"}, max_output_tokens: 3000,
    input: JSON.stringify({...fixture.baseInput, candidate_scene: sample.scene}),
    text: {format: {type: "json_schema", name: "bookrpg_scene_presence_review", strict: true, schema: scenePresenceReviewJsonSchema}},
  };
  const request = withSharedStoryPolicy("scene presence review", withTurnReview("scene presence review", base, fixture.contract));
  return {...request, instructions: [request.instructions, turnContractInstructions(fixture.contract, false)].join("\n")};
}

export function scoreOpeningReview(fixture: OpeningReviewFixture, caseIndex: number, request: AiResponseRequest, response: AiResponse) {
  if (response.status !== "completed") throw new Error(`Incomplete review: ${JSON.stringify(response.incomplete_details)}`);
  const decoded = decodeTurnReview("scene presence review", request, response);
  const observed = JSON.parse(decoded.output_text);
  const reduced = JSON.parse(reducePresenceReview(fixture.contract, decoded).output_text);
  const sample = fixture.cases[caseIndex]!;
  const status = observed.beat_observations?.[`beat_${fixture.contract.nextPlayerDecision}`]?.status;
  const preludeComplete = fixture.contract.requiredAutomaticBeatIndexes.every(i => observed.beat_observations?.[`beat_${i}`]?.status === "completed");
  const decisionCorrect = sample.expectedNextStatus === "absent"
    ? reduced.turnValidation?.status === "accepted"
    : reduced.turnValidation?.findings?.some((f: {code: string}) => f.code === "unselected_player_action");
  return {passed: Boolean(preludeComplete && status === sample.expectedNextStatus && observed.futureActionSetupRequired === true
      && observed.futureActionSetupSupported === sample.expectedSetup && decisionCorrect),
    expectedNextStatus: sample.expectedNextStatus, preludeComplete, observed, decision: reduced.turnValidation};
}
