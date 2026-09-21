import { CONVERSATIONAL_REACH_POLICY } from "../../shared/conversational-reach-policy.js";
import type { AiResponseRequest } from "../provider.js";
import {
  CHOICE_TIMELINE_RULES,
  INFORMED_PLAYER_CHOICE_RULES,
  PLAYER_EMBODIMENT_RULES,
  SOURCE_RECOUNTING_RULES,
  WORLD_RULE_POLICY,
} from "./rules.js";

// Domain rules are shared verbatim by writers and reviewers. Output schemas,
// evidence extraction, failure fields and mode-specific instructions stay local.
export const PLAYER_PERSPECTIVE_POLICY = [
  "Narrate player-facing scene prose in first-person singular from player_identity's perspective, using I, me, and my for the player. Non-player dialogue may address the player as you; dialogue attribution is not narration.",
  "Never switch the player to another character because that character dominates the source passage.",
  "The source passage establishes the situation only; its narrator, viewpoint character, actions, and private knowledge do not define the player.",
  "Treat player_identity and its canonical profile name and aliases as one player-controlled identity. Never introduce a second named copy as a figure, body, target, observer, or participant. Self-identification such as 'I am Dorothy' is allowed.",
  "An explicitly authorized opening-prelude objective cutaway may show a source-backed event outside the player's perception. It must not imply player knowledge or a second copy of the player; return to player perspective at the perceivable decision boundary.",
] as const;

export const TURN_PROGRESSION_POLICY = [
  "Resolve one player decision per turn: all acts explicitly selected in latest_input and their immediate causal responses. Never perform an unselected meaningful voluntary player decision, including an unselected option or a later source beat.",
  "An opening has no selected player action and needs none: automatic NPC/world progression is valid. An agency failure requires an identifiable unselected player act in the candidate, including a partly performed compound action; the absence of a selected input is not itself a violation.",
  "A concrete new NPC response, fact, reaction, obstacle, opportunity, or observable state change advances the scene even when the source event remains future. Reusing the same characters, location, or topic alone is not repetition.",
  "Ordered automatic progression is relative to the player's identity and aliases: intentional NPC actions can be automatic, while intentional or ambiguous meaningful player actions require selection. An opening automatic prefix must visibly complete in source order. After a selected action, complete the automatic follow-up window before a new player decision; a partial scene with verified progress requires automatic continuation and is not an accepted decision boundary. Its immediate NPC beats are not extra player decisions or an unrelated second major event.",
  "An automatic follow-up never authorizes, implies completion of, or skips an earlier unselected meaningful player beat. Physical setup for a future player action is not performance of that action.",
  "Credit source-beat completion by its concrete semantic action and outcome, not shared words. Preserve the typed actor, targets, material claims, causal prerequisites and source order; previously completed beats need not be replayed.",
] as const;

export const EVENT_COMPLETION_POLICY = [
  "An event may be claimed complete only when its description's material actions/outcomes and every required beat are visibly completed, together with any explicitly supplied previously completed progress. A general outcome phrase does not substitute for a missing required beat.",
  "Do not require unlisted source beats, participants, causes, or details that the completion contract omits. Preparation, anticipation, intention, or an unselected choice does not complete a physical act; an internal reaction or decision counts only when that is the typed event itself and the narrative establishes it.",
] as const;

export const PRESENCE_POLICY = [
  ...CONVERSATIONAL_REACH_POLICY.split("\n"),
  "The player's concrete current location and established physical state persist until narration visibly changes them. Source order does not teleport people, props, or events into that location.",
  "Record player_identity exactly once in peoplePresent and peopleWithinSpeakingDistance, including nonhuman players. This records spatial presence, not human speech, NPC status, or permission for self-targeted choices.",
  "Include only living NPCs whose physical presence is established by the visible narrative and prior state. A name mentioned in memory, anticipation, plans, narration about elsewhere, an uncertain sound, or a future/conditional arrival does not establish presence. Proposed presence metadata alone does not establish an arrival.",
  "An NPC is within speaking distance only if present and able to hear and answer immediately without another movement or transition. Use exact unqualified profile names or known aliases.",
  "Dead NPCs, corpses, permanently departed characters and explicitly unavailable NPCs are not living interactable participants. Mere absence or distance does not establish death or permanent departure. Established remains and possessions may still be physically inspected without putting the dead character in peoplePresent.",
  "After a visible location change, rebuild presence for the destination; carry an NPC forward only when narration establishes that they traveled with the player or arrived independently.",
] as const;

export const FREE_CHOICE_CREATIVITY_POLICY = [
  "SCENE-GROUNDED FREEDOM: derive non-anchor options from the generated scene's visible end state, not from the book's future plot or a prepared return plan. Options may be eccentric, absurd, playful, disruptive, or lead the adventure in a completely different direction. They need not resemble what the book character would normally choose; personality informs reactions, not a veto on the player's intentions.",
  "Ground the immediate action in the scene's people, objects, location or ongoing situation. An unexpected new intention needs no earlier foreshadowing. Do not invent an already-present prop, participant, power or completed journey solely to make an option possible. Offer an attempt or first step when its outcome is uncertain; do not promise future success. Respect established physical capabilities and active world rules, but never reject an otherwise playable option merely for being strange, off-plot or out of character. Seek meaningfully different directions without requiring every menu to contain a bizarre option.",
] as const;

export const CHOICE_EXECUTION_POLICY = [
  ...FREE_CHOICE_CREATIVITY_POLICY,
  "ANCHOR VERSUS ALTERNATIVES: only the anchor choice must advance the source route. Choices[0] is the canonical attempt; choices[1+] may radically diverge, including refusing, betraying, attacking, leaving, or destroying an available object. Not advancing the next source beat does not make an alternative unusable. Judge alternatives by immediate executability, continuity, distinctness and capabilities.",
  "CANONICAL CONTINUATION: after a canonical choice, the following choices[0] must offer the next intentional player decision (the indexed player goal goal when present), after the scene completes its authorized automatic beats. Do not replace that decision with waiting, preparation or a later player beat. Missing setup requires scene repair, not a substitute menu. This requirement applies only on the required source route; a diverged world must not be silently reset.",
  "FREE WORLD: canonical future events, objectives and relationships are not obligations for alternatives. An alternative may intentionally change an existing state through a new player action; that is not a continuity error. Reject assumed changes that already happened without narration, impossible prerequisites or unsupported capabilities, not new intentions, risk, disobedience or divergence. Uncertain outcomes must be phrased as attempts, not guaranteed results.",
  "MENU REPAIR: assess anchor routing separately from every choice's executability. A missing canonical anchor requires repairing slot 1 only; it does not invalidate playable alternatives. Retain accepted alternatives while repairing rejected choices. Never apply a canonical-route rejection to choices[1+].",
  "SPATIAL PREREQUISITES: include only non-player participants whose presence is actually necessary now. Following someone's already-open path toward another room does not require that person to remain beside the player. Mentioning a name or destination is not direct interaction. Do not list unrelated absent characters as prerequisites.",
  "Start every action choice with a direct base-form selectable verb such as 'Ask', 'Lower', or 'Continue', never a third-person finite verb such as 'Asks', 'Lowers', or 'Continues'.",
  "Every choice has player_identity as its implicit actor; the character field only identifies a required non-player participant. Direct interaction requires a present NPC, and immediate dialogue requires speaking distance.",
  "Calling out for an absent character or listening, watching, or searching for possible footsteps, a voice, movement, or another sign is presently executable and is not direct interaction, provided the choice does not assume the character hears, answers, arrives, or otherwise participates.",
  "CHOICE DIVERSITY: choices[1+] must differ from choice 1 and from each other in immediate player intent and expected immediate outcome, not merely in wording. Two choices that both disclose, ask, request, travel toward, attack, wait for, or otherwise pursue the same immediate goal are semantic duplicates and must not both be returned.",
  "CHARACTER CAPABILITIES: respect physical and communicative capabilities established by the visible setting and known character identity. Do not offer a choice that expects a non-speaking animal or otherwise non-verbal character to give a human verbal answer. A player may address such a character only when the choice explicitly relies on an observable non-verbal reaction.",
  "For ordered source events, an event route targets the next required beat, not the whole remaining event. Authorize only the earliest eligible player decision. An explicitly selected indexed player goal in the shared turn contract may span intervening automatic beats; all other later player decisions remain future. An unmet prerequisite requires a transition route.",
  "Use the most specific source evidence supplied for the immediate beat to preserve who speaks to whom. A question about an absent character is not direct speech to that character. Source evidence does not establish a future disclosure as already heard.",
  "A source route requires a concrete causal bridge, not thematic similarity or a guaranteed NPC reaction. With no honest executable source route, a meaningful local alternative is valid; never invent a prerequisite or future knowledge.",
] as const;

const scene = [WORLD_RULE_POLICY, PLAYER_PERSPECTIVE_POLICY, TURN_PROGRESSION_POLICY, EVENT_COMPLETION_POLICY, PRESENCE_POLICY, SOURCE_RECOUNTING_RULES];
const choices = [WORLD_RULE_POLICY, CHOICE_TIMELINE_RULES, INFORMED_PLAYER_CHOICE_RULES, PLAYER_EMBODIMENT_RULES, SOURCE_RECOUNTING_RULES, PRESENCE_POLICY, CHOICE_EXECUTION_POLICY];

export const SHARED_POLICY_BY_OPERATION: Readonly<Record<string, readonly (readonly string[])[]>> = {
  scene,
  "opening prelude": scene,
  "opening boundary": scene,
  "dialogue response": scene,
  "scene repetition review": scene,
  "scene presence review": [WORLD_RULE_POLICY, PRESENCE_POLICY, TURN_PROGRESSION_POLICY, EVENT_COMPLETION_POLICY, SOURCE_RECOUNTING_RULES],
  "scene event alignment": [EVENT_COMPLETION_POLICY],
  "loss avoidability review": [...scene, ...choices],
  "scene choices": choices,
  "scene choice review": choices,
  "turn intent review": [WORLD_RULE_POLICY, PLAYER_PERSPECTIVE_POLICY],
  "source anchor route review": [WORLD_RULE_POLICY, CHOICE_TIMELINE_RULES, SOURCE_RECOUNTING_RULES, PRESENCE_POLICY],
  "dialogue suggestions": [WORLD_RULE_POLICY],
  "world rule compliance review": [WORLD_RULE_POLICY],
};

/** Apply at the provider boundary, after legacy context/prompt adapters.
 * No context is expanded here: reviewer evidence and generation spoiler bounds
 * intentionally differ. Unregistered operations (e.g. indexing) are untouched.
 */
export function withSharedStoryPolicy(label: string, request: AiResponseRequest): AiResponseRequest {
  const groups = SHARED_POLICY_BY_OPERATION[label];
  if (!groups) return request;
  const shared = [...new Set(groups.flat())];
  const sharedSet = new Set(shared);
  const local = (request.instructions ?? "").split("\n")
    .filter((line) => !sharedSet.has(line) && line !== "SHARED STORY POLICY:");
  return {
    ...request,
    instructions: [...local, "SHARED STORY POLICY:", ...shared].join("\n"),
  };
}

