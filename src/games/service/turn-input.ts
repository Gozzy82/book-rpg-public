import {
  SceneGenerationError,
} from "../../ai/engine.js";
import {
  FREE_ACTION_CHOICE_ID,
  SOURCE_ANCHOR_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
} from "../../shared/contracts.js";
import type {
  GameChoice,
  GameNotice,
  InitiateEventRequest,
  MakeChoiceRequest,
  Scene,
  SetParameterRequest,
} from "../../shared/contracts.js";

export const MAX_TURN_TEXT_LENGTH = 1_000;

export const MAX_GAME_PARAMETERS = 20;

export function explicitPlayerChoiceRequiredNotice(choice: GameChoice): GameNotice {
  return {
    code: "EXPLICIT_PLAYER_CHOICE_REQUIRED",
    message:
      "The next source event requires a consequential action by your character. "
      + "It has been presented as an explicit choice instead of being performed automatically.",
    suggestedChoice: { ...choice },
  };
}

export function storyContinuationUnavailableNotice(scene: Scene): GameNotice {
  const suggestedChoice = scene.choices[0]?.id === SOURCE_CONTINUATION_CHOICE_ID
    ? undefined
    : scene.choices[0];
  return {
    code: "STORY_CONTINUATION_UNAVAILABLE",
    message: suggestedChoice
      ? "I've lost the story thread and cannot find a reliable direct anchor. Your scene is unchanged. Try the suggested current choice; option 1 is the strongest available route back toward the source."
      : "I've lost the story thread and cannot find a reliable direct anchor. Your scene is unchanged. Use 101 to take a concrete action toward an unresolved conflict, relationship, location, or objective already established in the scene.",
    ...(suggestedChoice ? { suggestedChoice: { ...suggestedChoice } } : {}),
  };
}

export function normalizeTurnText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label} text is required`);
  if (text.length > MAX_TURN_TEXT_LENGTH) {
    throw new Error(`${label} text must be at most ${MAX_TURN_TEXT_LENGTH} characters`);
  }
  return text;
}

export function resolveFreeAction(request: MakeChoiceRequest): string | undefined {
  if (request.choiceId !== FREE_ACTION_CHOICE_ID) return undefined;
  return normalizeTurnText(request.actionText, "Free action");
}

export function isAnchorDirectedChoice(
  scene: Pick<Scene, "choices">,
  choiceId: string,
): boolean {
  return (
    choiceId === SOURCE_CONTINUATION_CHOICE_ID
    || choiceId === SOURCE_ANCHOR_CHOICE_ID
  )
    && scene.choices[0]?.id === choiceId;
}

export function resolveEventText(request: InitiateEventRequest): string {
  return normalizeTurnText(request.text, "Event");
}

export function eventGenerationFailureScene(
  eventText: string,
  error: SceneGenerationError,
): Scene {
  const lastRejection = error.validationFailures.join(" ").trim()
    || "The generated scene could not satisfy the game's continuity and choice requirements.";
  const outcomeReason =
    `Why you lost: the custom world event could not produce a valid continuation after `
    + `${error.attempts} generation attempts. The final draft was rejected because: `
    + `${lastRejection} Exhausting all custom-event retries triggers a loss, so your `
    + "character is dead and the game has ended.";
  return {
    title: "Fatal Event — Game Over",
    text:
      `Failed world event: "${eventText}"\n\n${outcomeReason}`,
    choices: [],
    development: `The unresolved world event ends the game: ${eventText}`,
    outcome: "lost",
    outcomeReason,
  };
}

export function resolveParameterText(request: SetParameterRequest): string {
  return normalizeTurnText(request.text, "Parameter");
}

export function appendGameParameter(
  parameters: readonly string[] | undefined,
  parameter: string,
): string[] {
  return [
    ...(parameters ?? []).filter((existing) => existing !== parameter),
    parameter,
  ].slice(-MAX_GAME_PARAMETERS);
}
