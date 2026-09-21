import { canonicalSceneRequest } from "./canonical-scene-request.js";
import { FREE_CHOICE_CREATIVITY_POLICY } from "./shared-policy.js";
import type { AiResponse, AiResponseRequest } from "../provider.js";
import { TurnExecutionError, type TurnContract } from "./turn-contract.js";

function firstObject(text: string): Record<string, any> | null {
  const start = text.indexOf("{");
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; start >= 0 && i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export function candidateSentenceEvidence(text: string): Array<{id: number; text: string}> {
  return [...new Intl.Segmenter("en", {granularity: "sentence"}).segment(text)]
    .map(part => part.segment.trim()).filter(Boolean).map((text, index) => ({id: index + 1, text}));
}

/** Replace legacy review prose and lookahead payloads with a stage-specific view.
 * Never use a second event's beat numbering to assess the current candidate.
 */
export function withTurnReview(label: string, request: AiResponseRequest, contract: TurnContract): AiResponseRequest {
  if (label === "scene" && contract.sourceProgression === "required" && (contract.sourceBeatSelection || contract.selectedIntent === null)) {
    request = canonicalSceneRequest(request, contract);
  }
  if (label === "scene" && contract.selectedIntent === null) {
    const schema = request.text?.format.schema as any;
    if (!schema?.properties?.playerAction) return request;
    return {...request, instructions: [request.instructions,
      "This turn has no newly selected player action. Historical choices are completed history, never current authorization. Keep playerAction and actionResult empty and actionOutcome none. Narrate the authorized automatic window in text and summarize its external change in externalDevelopment; do not print metadata labels in prose.",
    ].filter(Boolean).join("\n"), text: {format: {...request.text!.format, schema: {...schema, properties: {...schema.properties,
      playerAction: {...schema.properties.playerAction, enum: [""]},
      actionResult: {...schema.properties.actionResult, enum: [""]},
      actionOutcome: {...schema.properties.actionOutcome, enum: ["none"]},
      ...(contract.requiredAutomaticBeatIndexes.length && schema.properties.externalDevelopment
        ? {externalDevelopment: {...schema.properties.externalDevelopment, minLength: 1}} : {}),
    }}}}};
  }
  if (label === "scene choices") {
    const input = firstObject(request.input);
    const nextIndex = contract.sourceProgression === "required" && !(contract.mode === "observe" && contract.requiredAutomaticBeatIndexes.length > 0) ? contract.nextPlayerDecision : null;
    const next = nextIndex === null ? null : contract.beats[nextIndex];
    if (input && next) request = {...request, input: JSON.stringify({...input,
      required_anchor_decision: {beat_index: nextIndex, actor: next.actor, action: contract.nextPlayerAction?.choiceText ?? next.action},
    }), instructions: [request.instructions,
      "All options are actions by the player; character identifies a target or conversation partner, not another actor. Alternatives must differ meaningfully from the anchor, not paraphrase it. Respect established restrictions and use capabilities that remain available: an immobilized verbal character may ask a different question or refuse help, but cannot reach for an absent object or free their own joints. Do not invent equipment from an imagined future scene.",
      "required_anchor_decision is the next intentional player beat on the canonical route. Put that concrete action in choices[0], as an attempt if its outcome is uncertain. The approved scene must already have completed intervening automatic beats and established setup. Do not substitute waiting, preparation or a later beat. This target does not constrain choices[1+].",
    ].filter(Boolean).join("\n")};
    const schema = request.text?.format.schema as any;
    const choice = schema?.properties?.choices?.items;
    const present = input?.setting?.sceneScope?.peoplePresent;
    if (!choice || !Array.isArray(present)) return request;
    const normalize = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase();
    const aliases = new Set(contract.playerAliases.map(normalize));
    const participants = [...new Set(present.filter((name: unknown): name is string => typeof name === "string" && !aliases.has(normalize(name))))];
    return {...request, text: {format: {...request.text!.format, schema: {...schema, properties: {...schema.properties,
      choices: {...schema.properties.choices, items: {...choice, properties: {...choice.properties,
        character: {...choice.properties.character, enum: [null, ...participants]},
        requiredPresentCharacters: {...choice.properties.requiredPresentCharacters,
          ...(participants.length ? {items: {type: "string", enum: participants}} : {maxItems: 0})},
      }}},
    }}}}};
  }
  if (label === "scene choice review") {
    const input = firstObject(request.input);
    if (!input?.candidate_scene) return request;
    const marker = request.input.indexOf("CHOICE NAVIGATION EVENT:");
    const navigation = marker >= 0 ? firstObject(request.input.slice(marker)) : null;
    return {...request, max_output_tokens: Math.max(request.max_output_tokens ?? 0, 1600), input: JSON.stringify({player_identity: contract.player, player_identity_aliases: contract.playerAliases,
      candidate_scene: {...input.candidate_scene, choices: input.candidate_scene.choices?.map((choice: Record<string, unknown>) => ({...choice, actor: contract.player}))}, recent_prior_scenes: input.recent_prior_scenes ?? [],
      anchor_target: contract.sourceProgression === "optional" || (contract.mode === "observe" && contract.requiredAutomaticBeatIndexes.length > 0) ? null : contract.nextPlayerDecision === null ? navigation : {beat_index: contract.nextPlayerDecision,
        actor: contract.beats[contract.nextPlayerDecision]?.actor, action: contract.nextPlayerAction?.choiceText ?? contract.beats[contract.nextPlayerDecision]?.action},
    }), instructions: [
      "Review the menu of this already-approved scene. The visible end state is authoritative; do not require old scene actions to be replayed.",
      ...FREE_CHOICE_CREATIVITY_POLICY,
      "Every menu choice is performed by player_identity. actor is supplied by the server. The optional character field names the interaction target or conversation partner, NEVER the action performer. An action addressed to Dorothy is still performed by Tin Woodman when he is the player. Judge duplicate options by meaning, even when the labels or character fields differ.",
      "Make TWO INDEPENDENT assessments: anchorChoiceIndex identifies the best executable route toward anchor_target; unusableChoiceIndexes identifies choices that cannot actually be performed from the current state.",
      "Only the anchor needs source progression. Alternatives may radically diverge, including refusing, betraying, attacking, leaving or destroying an available object. A new action that changes the world is not a contradiction of its prior state. Not advancing anchor_target is NEVER a reason for unusability. They must remain distinct and executable.",
      "For unusability require a concrete spatial/temporal contradiction, replay, semantic duplicate, identity error, or unsupported capability. Explain the exact choice and conflicting visible fact, not failure to follow canon.",
      "Moving toward a departed person's destination or following their path does not require the person to remain beside the player. Direct touch and an immediate conversation do require the appropriate presence and speaking distance.",
      "Use zero-based indexes. Return null for anchorChoiceIndex when no executable anchor exists or no meaningful player decision is available. Return an empty unusableChoiceIndexes array when all choices are playable. Do not automatically bless the first choice.",
    ].join("\n")};
  }
  if (!["scene presence review", "scene repetition review"].includes(label)) return request;
  const old = firstObject(request.input);
  if (!old?.candidate_scene || !request.text?.format.schema) return request;
  const runtime = JSON.parse(contract.contextJson).character_runtime;
  const nonverbalCharacters: string[] = (runtime?.characters ?? []).filter((p: any) => p?.speech?.mode === "nonverbal").map((p: any) => p.name);
  const common = {
    indexed_nonverbal_characters: nonverbalCharacters,
    player_identity: contract.player, player_identity_aliases: contract.playerAliases,
    selected_input: contract.selectedIntent, mode: contract.mode,
    // Writer metadata is an unverified claim, not visible evidence. In the 8950
    // run the reviewer quoted action_result as though it appeared in the scene.
    candidate_scene: {title: old.candidate_scene.title, text: old.candidate_scene.text},
    previous_scene: contract.mode === "opening" ? null : old.previous_scene ?? old.immediate_transition?.previous_scene ?? null,
    recent_prior_scenes: contract.mode === "opening" ? [] : old.recent_prior_scenes ?? [],
    explicitly_unavailable: old.explicitly_unavailable ?? [],
    known_characters: Array.isArray(old.character_profiles) ? old.character_profiles.map((p: any) => ({name: p.name, aliases: p.aliases ?? []})) : [],
  };
  const schema = request.text.format.schema as any;
  if (!schema.properties || !Array.isArray(schema.required)) return request;
  if (label === "scene repetition review") {
    const {staysWithinTurnScope: _scope, turnScopeFailureReason: _scopeReason, turnScopeViolationQuote: _scopeQuote, ...reviewProperties} = schema.properties;
    return {...request, input: JSON.stringify(common), instructions: [
      "Review only the supplied candidate's continuity, first-person identity and player agency. The appended turn script defines authorization.",
      "Compare repetition only with visible previous/recent scenes, never with source prose or a future beat. No prior scene means repeatsPriorScene=false.",
      "No selected_input means there is no action-resolution requirement: set latestInputResolvedFaithfully=true and latestInputFailureType=none. An opening needs no selected action. Assess unselected player actions separately through preservesPlayerAgency.",
      "An unperformed next_decision is correct; it is never an unresolved selected input. Missing automatic beats are progress omissions, not scope overrun. turnScopeFindings is only for extra performed plot/player actions or checkpoint reversals, not for failing to advance further.",
      "For preservesPlayerAgency=false supply playerAgencyViolationQuote copied exactly from candidate_scene.text, identifying the actual unselected act. Absence of a selected input is not an act. Include partial execution and extra speech/decisions.",
      "Only indexed_nonverbal_characters can fail the indexed speech-capability check. Unknown or absent capability, an empty communicationModes array and missing development do NOT mean nonverbal. If the list is empty, respectsCharacterCapabilities must be true. For a failure supply characterCapabilityViolationCharacter from that list, an exact candidate quote in characterCapabilityViolationQuote, and a concrete characterCapabilityFailureReason. Otherwise use empty strings. Thoughts and nonverbal sounds are not spoken language.",
      "Return turnScopeFindings=[] when no scope violation is observed. For each actual unauthorized action or checkpoint reversal, return one finding with a non-empty reason and an exact non-empty quote from candidate_scene.text. Completing the authorized automatic window and stopping before next_decision is within scope. Missing automatic actions belong to presence review; do not invent a scope violation for an omission.",
      "Check that I/me/my refers to player_identity. Naming the player as a separate acting or observed character in narration violates perspective; quoted NPC address does not.",
      "Reject silent reversals of established checkpoint facts in turnScopeFindings, even in openings. The authorized ordered automatic window is one turn. requiredEventOccurred means that this required window visibly occurred, never permission to execute next_decision. Return concise concrete reasons, not missing future outcomes. Preserve the established physical state and active world rules.",
    ].join("\n"), text: {format: {...request.text.format, schema: {...schema,
      properties: {...reviewProperties,
        turnScopeFindings: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {reason: {type: "string", minLength: 1}, quote: {type: "string", minLength: 1}}, required: ["reason", "quote"]}},
        playerAgencyViolationQuote: {type: "string"},
        respectsCharacterCapabilities: {type: "boolean", enum: nonverbalCharacters.length ? [true, false] : [true]},
        characterCapabilityFailureReason: {type: "string"},
        characterCapabilityViolationCharacter: {type: "string", enum: ["", ...nonverbalCharacters]},
        characterCapabilityViolationQuote: {type: "string"}},
      required: [...schema.required.filter((key: string) => !["staysWithinTurnScope", "turnScopeFailureReason", "turnScopeViolationQuote"].includes(key)), "turnScopeFindings", "playerAgencyViolationQuote", "respectsCharacterCapabilities", "characterCapabilityFailureReason", "characterCapabilityViolationCharacter", "characterCapabilityViolationQuote"],
    }}}};
  }
  const indexes = [...new Set([...contract.allowedPlayerBeatIndexes, ...contract.requiredAutomaticBeatIndexes,
    ...(contract.nextPlayerDecision === null ? [] : [contract.nextPlayerDecision])])].sort((a,b) => a-b);
  if (!indexes.length) return request;
  const sentences = candidateSentenceEvidence(common.candidate_scene.text ?? "");
  const checkpointIndexes = contract.sourceProgression === "required"
    ? indexes.filter(i => i !== contract.nextPlayerDecision && contract.beats[i]?.resultingState) : [];
  const checkpointSchema = {type: "object", additionalProperties: false, properties: {
    observed_state: {type: "string"},
    matches: {type: "boolean"},
    reason: {type: "string"},
    evidence_sentence_ids: {type: "array", items: {type: "integer", enum: sentences.length ? sentences.map(s => s.id) : [0]}},
  }, required: ["observed_state", "matches", "reason", "evidence_sentence_ids"]};
  const observations = Object.fromEntries(indexes.map(index => [`beat_${index}`, {
    type: "object", additionalProperties: false,
    description: `Absolute beat ${index}. Actor: ${contract.beats[index]!.actor ?? "world"}. Action: ${contract.beats[index]!.action}. Judge completion of this literal action, not its ultimate purpose: visibly starting/trying completes a starts/tries beat. Its endpoint is ${contract.beats[index]!.resultingState ?? "the stated action"}.`,
    properties: {status: {type: "string", enum: ["absent", "partial", "completed"]},
      evidence_sentence_ids: {type: "array", items: {type: "integer", enum: sentences.length ? sentences.map(s => s.id) : [0]}}},
    required: ["status", "evidence_sentence_ids"],
  }]));
  const {completedSourceEventBeatIndexes: _completed, partiallyPerformedSourceEventBeatIndexes: _partial, ...properties} = schema.properties;
  return {...request, input: JSON.stringify({...common, candidate_sentences: sentences, beat_definitions: indexes.map(index => ({
    key: `beat_${index}`, actor: contract.beats[index]!.actor, action: contract.beats[index]!.action, source_semantics: contract.beats[index]!.sourceSemantics ?? null, resulting_state: contract.beats[index]!.resultingState ?? null,
  }))}), instructions: [
    "Source semantics distinguish present narration from narrated history: evidence of telling satisfies the narration, not reenacting the injury or emotion. Joint-action participants may share evidence sentences for the same authorized joint act; do not require invented sequential phases. Still verify each actor participation and authorization.",
    "Review the candidate's physical end state and each explicitly keyed beat. Use the provided keys exactly; never invent or shift beat numbers.",
    ...(contract.selectedPlayerAction ? ["If player_action_resolution is requested, completed requires the entire permitted player action. interrupted/failed requires a visibly attempted player action and a concrete cause supported by source or established world state, with candidate sentence IDs and a reason. beforeBeatIndex is the first beat not fully completed when it stops; no subsequent beat may execute. Missing actions, vague hesitation, invented obstacles, or missing review evidence are unresolved, not interruption. causeEstablished is true only after checking the cause against the supplied story_so_far/source/runtime conditions. Do not require the canonical next decision to be executable after a grounded stop."] : []),
    "For each beat return absent, partial or completed. completed requires ALL material parts of that exact action. partial includes any visibly begun constituent act. For partial/completed select one or more evidence_sentence_ids from candidate_sentences. For absent return an empty array. Never copy or paraphrase source text as evidence; sentence IDs refer ONLY to the supplied candidate.",
    "CHECKPOINT REPORT: for each checkpoint_observations key, first describe the actual physical state shown by candidate sentences at the end of that beat, then compare it with resulting_state. matches=false for contradiction or missing evidence; a broad action status must not override this. final_checkpoint describes the actual final location, posture and possession and compares it with the last completed authorized checkpoint, including any subsequent reversal. When a source-backed interruption prevents a checkpoint, report that explicitly rather than inventing completion. Reasons must explain mismatches. Do not copy the expected state as observed_state unless the candidate actually establishes it.",
    "LITERAL COMPLETION SCOPE: apply status to the indexed verb and resulting_state, not the wider goal. 'Starts trying to retrieve' is completed when the attempt visibly begins; catching is not required at that index. 'Catches and starts toward' is completed by catching plus beginning movement, without arrival. Partial means a required constituent of that literal beat is missing, not that the eventual goal remains unfinished. A later successful catch cannot retroactively make an already depicted start partial.",
    "GROUP RESOLUTION: assess player_action_resolution against the group's endBeatIndex, member actions and completion. Do not require reaching a destination or another outcome beyond that endpoint. An automatic accident after the group's endpoint does not undo its completion. Separately assess ordered automatic follow-up; still reject missing actions, wrong causal order, contradictory possession or movement after the final authorized checkpoint.",
    "BEAT CHECKPOINT VALIDATION: compare each observed action with its indexed resulting_state at the time that beat finishes, before later beats supersede it. Completion requires the action AND its compatible checkpoint; final possession alone cannot prove the earlier ordered retrieval. For a starts/tries beat, an established attempt with the target still unretrieved is its completed checkpoint, not partial. Check the final scene against the last authorized beat's state as well: if it requires remaining seated and the candidate then stands/climbs, that is an unauthorized reversal. Report concrete evidence rather than certifying a completed group with contradictory ordering or end state; player_action_resolution must be unresolved in that case. Do not require earlier checkpoints to remain true after an authorized later beat changes them.",
    "Selected sentences must jointly support ALL parts of a completed actor/action, not merely a compatible resulting state. A spring being visible does not prove searching for water occurred. Freed arms do not prove both oiling and assisted bending occurred. The act is not absent merely because a later beat is missing. Source instructions, summaries and metadata are not observations. Previously completed beats need not be replayed.",
    "PERSISTENCE IS NOT A NEW ACTION: identify what the player newly DOES beyond the established state and authorized external change before marking next_decision partial/completed. Remaining in a vehicle while it moves, retaining an object, an existing seated posture, perception, or an automatic balance reaction do not by themselves execute a future intentional choice to stay and wait. The future action needs a newly depicted decision or deliberate continuation over time, not mere compatibility with its resulting_state. A stated decision such as 'I decide to stay here and wait' or a depicted period of deliberate waiting DOES execute it and must still be rejected when unselected. Do not remove real new action evidence to make a scene pass.",
    "ACTOR AND TEMPORAL EVIDENCE: before reporting partial/completed, identify the exact actor performing this action and when it happens relative to the preceding events. A target moving independently is not the player's attempt to act on it. Earlier possession or contact before separation is not later retrieval. Do not reuse a sentence about one actor as evidence for another without that actor's actual participation. A shared object or compatible end state is insufficient. Joint acts still allow shared evidence when it actually depicts both participants.",
    "Do not treat intentions, readiness, feelings, negation or unrealized clauses such as 'before I can catch him' as execution. If the candidate only shows the target escaping, with no subsequent player approach, reach or other constituent of retrieval, that retrieval beat is absent. Conversely an explicit approach/reach to retrieve after escape performs the attempt, even without catching; do not excuse it as mere setup. Use the same actor/time test for every character and action.",
    "Assess next_decision.entry_action prerequisites from the current end state, not the group's completed outcome or menu label. An object at a known accessible location allows an ordinary retrieval attempt to begin, even while the player is elsewhere in the same room. No exact arm's reach, furniture geometry or proven successful route is required absent a concrete established barrier. Later movement, NPC help or opening a passage inside the group need not already have occurred. Preserve real restraints, absent targets and missing communicated information as genuine setup failures.",
    "BEGINNING VERSUS FINISHING: assess the exact next action, including 'starts' or 'tries'. Starting retrieval may include ordinary approach, bending and reaching within the same accessible room after selection. The player need not already be beside or under the bed, reaching, holding the target, or past the difficulty the action is meant to address. Require a concrete established barrier (for example a locked partition, restraint or blocked route), not merely distance across the room or an object being under furniture. Never demand successful retrieval as a prerequisite for starting an attempt.",
    "If required setup is missing, name a concrete obstacle or missing fact in futureActionSetupReason. Do not demand that the next player action be performed. An open route, reachable target, required mobility and already conveyed knowledge are prerequisites.",
    "Record only living characters established at the final location. Someone who ran to the sheds is not still in the room. Someone below a trapdoor is not automatically beside the player. Preserve the player exactly once in both presence lists.",
    "Use null for latestVisibleSourceEventId unless every event beat is completed; the application determines progress from the keyed observations. Keep reasons concise.",
  ].join("\n"), max_output_tokens: Math.max(request.max_output_tokens ?? 0, 1600 + indexes.length * 100),
    text: {format: {...request.text.format, schema: {...schema, properties: {...properties,
      ...(contract.selectedPlayerAction ? {player_action_resolution: {type: "object", additionalProperties: false,
        properties: {
          status: {type: "string", enum: ["completed", "interrupted", "failed", "unresolved"]},
          beforeBeatIndex: {type: ["integer", "null"], enum: [null, ...indexes.filter(i => i !== contract.nextPlayerDecision)]},
          reason: {type: "string"},
          causeEstablished: {type: "boolean"},
          evidence_sentence_ids: {type: "array", items: {type: "integer", enum: sentences.length ? sentences.map(s => s.id) : [0]}},
        }, required: ["status", "beforeBeatIndex", "reason", "causeEstablished", "evidence_sentence_ids"]}} : {}),
      ...(checkpointIndexes.length ? {
        checkpoint_observations: {type: "object", additionalProperties: false,
          properties: Object.fromEntries(checkpointIndexes.map(i => [`beat_${i}`, checkpointSchema])), required: checkpointIndexes.map(i => `beat_${i}`)},
        final_checkpoint: checkpointSchema,
      } : {}),
      beat_observations: {type: "object", additionalProperties: false, properties: observations, required: Object.keys(observations)},
    }, required: [...schema.required.filter((k: string) => !["completedSourceEventBeatIndexes", "partiallyPerformedSourceEventBeatIndexes"].includes(k)), "beat_observations", ...(checkpointIndexes.length ? ["checkpoint_observations", "final_checkpoint"] : []), ...(contract.selectedPlayerAction ? ["player_action_resolution"] : [])]}}},
  };
}

const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function decodeTurnReview(label: string, request: AiResponseRequest, response: AiResponse): AiResponse {
  if (response.status !== "completed") return response;
  const schema = request.text?.format.schema as any;
  if (!schema?.properties?.beat_observations && !schema?.properties?.playerAgencyViolationQuote) return response;
  let value: any;
  try {value = JSON.parse(response.output_text);} catch {return response;}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TurnExecutionError("review_unavailable", "Review did not return an assessment object.");
  const input = firstObject(request.input);
  const candidateText = normalized(input?.candidate_scene?.text ?? "");
  const grounded = (quote: unknown) => typeof quote === "string" && normalized(quote).length > 0 && candidateText.includes(normalized(quote));
  if (label === "scene repetition review") {
    if (schema.properties.turnScopeFindings) {
      const findings = value.turnScopeFindings;
      if (!Array.isArray(findings) || findings.some(f => !f || typeof f.reason !== "string" || !f.reason.trim() || !grounded(f.quote))) {
        throw new TurnExecutionError("review_unavailable", "Scope rejection requires findings with a concrete reason and an exact non-empty candidate quote; return an empty findings array when no violation is observed.");
      }
      value.staysWithinTurnScope = findings.length === 0;
      value.turnScopeFailureReason = findings.map(f => f.reason.trim()).join(" ");
      value.turnScopeViolationQuote = findings.map(f => f.quote.trim()).join(" ");
    }
    if (value.preservesPlayerAgency === false && !grounded(value.playerAgencyViolationQuote)) {
      throw new TurnExecutionError("review_unavailable", "Agency review did not cite an actual unselected act in the candidate scene.");
    }
    if (input?.selected_input == null) {
      value.latestInputResolvedFaithfully = true; value.latestInputFailureType = "none"; value.latestInputFailureReason = "";
    }
    if (input?.mode === "opening") value.repeatsPriorScene = false;
    if (value.staysWithinTurnScope === false && (!value.turnScopeFailureReason?.trim() || (!schema.properties.turnScopeFindings && !grounded(value.turnScopeViolationQuote)))) {
      throw new TurnExecutionError("review_unavailable", "Scope rejection requires a concrete unauthorized act or checkpoint reversal, a non-empty turnScopeFailureReason, and an exact candidate quote. The authorized automatic window is within scope.");
    }
    if (value.respectsCharacterCapabilities === false) {
      if (!input?.indexed_nonverbal_characters?.includes(value.characterCapabilityViolationCharacter)
        || !grounded(value.characterCapabilityViolationQuote) || !value.characterCapabilityFailureReason?.trim()) {
        throw new TurnExecutionError("review_unavailable", "Speech-capability rejection requires a character from indexed_nonverbal_characters and quoted candidate evidence. Unknown capability and empty communication modes do not imply nonverbal.");
      }
      value.staysWithinTurnScope = false;
      value.turnScopeFailureReason = [value.turnScopeFailureReason, value.characterCapabilityFailureReason || "The scene violates an indexed speech capability."].filter(Boolean).join(" ");
    }
  } else {
    const complete: number[] = [], partial: number[] = [];
    for (const key of schema.properties.beat_observations.required as string[]) {
      const entry = value.beat_observations?.[key];
      const ids: unknown = entry?.evidence_sentence_ids;
      const sentences = candidateSentenceEvidence(input?.candidate_scene?.text ?? "");
      if (!entry || !["absent", "partial", "completed"].includes(entry.status)
        || !Array.isArray(ids) || ids.some(id => !Number.isInteger(id) || !sentences.some(s => s.id === id))
        || (entry.status !== "absent" && ids.length === 0) || (entry.status === "absent" && ids.length > 0)) {
        throw new TurnExecutionError("review_unavailable", `Presence review returned missing or invalid candidate sentence IDs for ${key}. Select only candidate_sentences IDs; source prose and indexed states are not evidence.`);
      }
      // Materialize evidence from the candidate, never from model-supplied prose.
      entry.quote = ids.map(id => sentences.find(s => s.id === id)!.text).join(" ");
      if (entry.status === "completed") complete.push(Number(key.slice(5)));
      if (entry.status === "partial") partial.push(Number(key.slice(5)));
    }
    if (schema.properties.player_action_resolution) {
      const r = value.player_action_resolution;
      const sentences = candidateSentenceEvidence(input?.candidate_scene?.text ?? "");
      const allowed = schema.properties.player_action_resolution.properties.beforeBeatIndex.enum;
      if (!r || !["completed", "interrupted", "failed", "unresolved"].includes(r.status)
        || !allowed.includes(r.beforeBeatIndex) || typeof r.reason !== "string" || typeof r.causeEstablished !== "boolean"
        || !Array.isArray(r.evidence_sentence_ids)
        || r.evidence_sentence_ids.some((id: unknown) => !Number.isInteger(id) || !sentences.some(s => s.id === id))
        || (["interrupted", "failed"].includes(r.status) && (!r.reason.trim() || !r.evidence_sentence_ids.length || r.beforeBeatIndex === null))) {
        throw new TurnExecutionError("review_unavailable", "Player-action resolution requires valid candidate evidence and a stop boundary.");
      }
      r.quote = r.evidence_sentence_ids.map((id: number) => sentences.find(s => s.id === id)!.text).join(" ");
    }
    const checkpointFindings: Array<{beatIndexes: number[]; message: string}> = [];
    if (schema.properties.checkpoint_observations) {
      const keys: string[] = schema.properties.checkpoint_observations.required;
      for (const key of [...keys, ...(schema.properties.final_checkpoint ? ["final_checkpoint"] : [])]) {
        const entry = key === "final_checkpoint" ? value.final_checkpoint : value.checkpoint_observations?.[key];
        const sentences = candidateSentenceEvidence(input?.candidate_scene?.text ?? "");
        if (!entry || typeof entry.matches !== "boolean" || typeof entry.observed_state !== "string" || !entry.observed_state.trim()
          || typeof entry.reason !== "string" || (!entry.matches && !entry.reason.trim())
          || !Array.isArray(entry.evidence_sentence_ids) || (entry.matches && !entry.evidence_sentence_ids.length)
          || entry.evidence_sentence_ids.some((id: unknown) => !sentences.some(s => s.id === id))) {
          throw new TurnExecutionError("review_unavailable", `Missing or unsupported physical checkpoint assessment: ${key}.`);
        }
        const index = Number(key.slice(5));
        // Missing future checkpoints on a genuine interruption are handled by the progress validator.
        if (!entry.matches && (key === "final_checkpoint" || complete.includes(index)))
          checkpointFindings.push({beatIndexes: key === "final_checkpoint" ? [] : [index],
            message: `${key}: ${entry.observed_state}. ${entry.reason}`});
      }
      // Sentence evidence must also respect source chronology. Shared sentences (joint acts) remain valid.
      let previous = -1;
      for (const key of keys) {
        const index = Number(key.slice(5));
        if (!complete.includes(index)) continue;
        const first = Math.min(...value.beat_observations[key].evidence_sentence_ids);
        if (first < previous) checkpointFindings.push({beatIndexes: [index], message: `${key} starts before its preceding source beat in candidate sentence evidence.`});
        previous = Math.max(previous, first);
      }
    }
    value.checkpointFindings = checkpointFindings;
    value.completedSourceEventBeatIndexes = complete;
    value.partiallyPerformedSourceEventBeatIndexes = partial;
  }
  return {...response, output_text: JSON.stringify(value)};
}
