import { CONVERSATIONAL_REACH_POLICY } from "../../shared/conversational-reach-policy.js";
export const VIVID_SCENE_STYLE_RULES = [
  "Use vivid concrete detail and strong verbs. Cut exposition, filler, repeated information, and slow transitions.",
  "State major source-backed events plainly once they have happened. Do not replace a killing, death, attack, betrayal, disaster, or similarly decisive act with euphemisms such as 'a life-altering moment', 'what happened', or 'a deliberate consequence'.",
  "For a severe event already established at the current story moment, identify who did what to whom, the relevant means when known, and the immediate concrete physical consequence.",
  "Describe source-backed violence vividly and graphically when it is central to the scene. Include sensory and bodily detail supported by the source, but do not invent wounds, torture, or gore absent from the supplied material.",
  "When the stakes support it, include one striking reversal, image, or consequence while remaining plausible for the book's world and tone.",
] as const;

export const COMPACT_SCENE_STYLE_RULES = [
  "Open with the immediate consequence, danger, discovery, or emotional turn; do not recap the previous scene.",
  ...VIVID_SCENE_STYLE_RULES,
  "End on a sharp decision point rather than explaining what the player should feel.",
  "Keep scene text between 65 and 150 words. The former 65 and 120 words target is obsolete.",
] as const;

export const ORDERED_WINDOW_SCENE_STYLE_RULES = [
  "Open with the immediate action or consequence; do not recap the previous scene.",
  ...VIVID_SCENE_STYLE_RULES,
  "For this multi-beat turn, target 250–450 words and use up to 600 when needed to depict the authorized window clearly. Spend the space on concrete actions and their physical consequences, not repeated atmosphere. Do not omit required actions to meet a compact single-beat length target.",
  "End at the script's decision boundary. Keep all selectable choices in the menu; do not append a decision question, hypothetical options or a summary of possible futures to the prose.",
] as const;

export const OBSERVED_SCENE_PROGRESSION_STYLE_RULES = [
  "Write the next passage directly from the current scene's final moment; do not recap, replay, or restart it.",
  ...VIVID_SCENE_STYLE_RULES,
  "Paint a vivid visual and sensory picture of the same scene as it changes, preserving established setting details, positions, props, physical conditions, mood, and ongoing activity unless this passage visibly changes them.",
  "Advance by one cohesive narrated beat with a concrete new motion, reaction, line of non-player dialogue, sensory change, or immediate consequence. Do not summarize the rest of the sequence or race to its final resolution.",
  "Keep scene text between 90 and 180 words; end sooner when one clearly observable new beat is complete.",
] as const;

export const COMPACT_DIALOGUE_STYLE_RULES = [
  "Make the reply sharp, characterful, and consequential; avoid throat-clearing, repetition, and explanatory monologues.",
  "Use one vivid reaction, revelation, refusal, lie, threat, or reversal when it fits the character and situation.",
  "Keep characterResponse between 12 and 55 words and narration between 15 and 55 words.",
] as const;

export const SCENE_TITLE_RULES = [
  "Write title as a fresh, concise title for only the newly generated scene.",
  "Never copy or extend current_scene.title or previous_scene.title, and never include a turn number or '(Turn ...)' marker in title. The application adds the authoritative turn number.",
] as const;

export const PLAYER_EMBODIMENT_RULES = [
  "Preserve the player's established physical form, species or nature, scale, habitat, senses, locomotion, and means of communication.",
  "Never turn a nonhuman player into a human or give the player anatomy, equipment, posture, speech, or movement their identity cannot plausibly use.",
  "For a creature whose established habitat is the water, never place one standing or walking on a ship's deck or other dry location without a visibly plausible cause.",
  "The source narrator's viewpoint and location do not relocate the player. If the player is elsewhere, portray the same story moment from the player's own plausible location.",
  "Treat player_identity as the implicit actor of every offered choice and phrase action choices as direct selectable actions from that identity's perspective.",
  "Never name player_identity or any of their aliases inside a choice as a separate character to help, steady, follow, address, observe, or otherwise interact with.",
  "Never set a choice's character field to player_identity or one of their aliases; that field identifies a non-player character whose participation is required.",
  "Every offered action and talk choice must be physically possible for the player in the established circumstances.",

] as const;

export const SOURCE_RECOUNTING_RULES = [
  "When the immediate source beat is a character recounting their own past, the supplied source account establishes what that speaker already knows. The listeners need not have heard that account or its historical names before the speaker can choose to disclose it. Require an able speaker and reachable listeners, not a prior disclosure of the very content being offered as the next choice. Do not extend this exception to future events, another character's private knowledge, or replies to information the speaker has not received.",
  "Treat recounting as a present act of communication. People mentioned in that account need not be physically present and must not be added to the scene merely because they are discussed. Leave a player's unselected disclosure untold; when it is selected, convey the source beat's material facts in speech without reenacting the historical injuries, deaths, arrivals, or relationships as new events.",
] as const;

export const SOURCE_GROUNDING_RULES = [
  ...SOURCE_RECOUNTING_RULES,
  "Introduce a newly arriving NPC through an observable arrival and source-backed identity before choices address that character. Bridge any required change of place or world state visibly from the previous scene; a future source encounter does not teleport an NPC into the current setting.",
  "When the next player beat responds to an NPC statement, question, accusation, offer, or revelation, make its specific content explicit in player-facing prose first. A vague greeting, praise, or mention of a conversation is not enough; preserve the claim the player will answer without performing the player's response.",
  "Set sourceChapterPosition only to the chapterPosition of upcoming_source_material actually adapted into this turn",
  "When upcoming_source_material is empty, sourceChapterPosition must be null. A chapter mentioned by position, source_passage, a summary, or history is not supplied unless it appears in upcoming_source_material.",
  "For an ordinary player turn, sourceChapterPosition must remain null when reaching the source development would require a new voluntary player action that is not part of latest_input.",
  "When the selected source candidate has startsNewChapter true, first introduce its earliest concrete event in the player-facing narrative as a natural in-story transition. Only then may later narration or choices rely on that event.",
  "For next_significant_event_progress, the typed beat is the required narrative contract and its sourceReferencesExcerpt is the most specific source evidence. When that excerpt is present, use it before the broader upcoming_source_material.excerpt to preserve the beat's concrete actor, target, location, objects, positions, and circumstances.",
  "When next_required_beat has automaticPreludeSourceExcerpt, treat that excerpt as already-established causal source context immediately preceding the intentional beat. Use it to preserve the concrete situation, positions, objects, dangers, and circumstances that make next_required_beat possible.",
  "Never replay, re-perform, or present events from automaticPreludeSourceExcerpt as new pending beats. They describe how the current state was reached; continue from their resulting state and leave next_required_beat as the action that is now pending.",
  "When consecutive unfinished ordered beats have agency 'external' or 'involuntary', they may be realized together in the same generated scene in strict source order when causally coherent. Do not insert a player decision merely to separate those automatic beats; stop before the first later meaningful intentional or ambiguous player-controlled beat.",
  "When the instruction contains OPENING AUTOMATIC PREFIX, treat every ordered beat before the identified first meaningful player beat as one opening-only automatic progression window. This includes intentional NPC beats and routine player beats as well as world, external, and involuntary beats. Complete that prefix in strict order in the same opening, then stop before the first meaningful intentional or ambiguous player-controlled beat. This opening-only exception does not authorize skipping or performing an earlier meaningful player beat.",
  "When a typed source beat assigns player_identity as actor even though the source excerpt originally names another actor, the typed beat is an intentional runtime actor takeover caused by the interactive world state. Preserve the beat's narrative function with player_identity as actor; do not restore the unavailable original actor from source prose.",
  "Do not announce a chapter number, source transition, summary, cursor, actor takeover, or other internal source metadata to the player.",
] as const;

export const FIRST_CHOICE_ANCHOR_RULES = [
  "For every active outcome, prefer choices[0] as the strongest immediate, voluntary route toward an upcoming source development when that route follows naturally from the current player-facing state.",
  "Do not force every local decision back to upcoming_source_material. A meaningful local consequence, relationship, conflict, investigation, or opportunity may occupy choices[0] while the interactive timeline develops.",
  "When no offered choice provides a reliable causal route to the source, do not invent one or expose future knowledge. The application can add a separate Continue story option for an explicit later return.",
  "Do not reveal or summarize an unreached source event in the choice text unless the typed navigation event requires an explicit consequential player choice. Otherwise phrase choices[0] as an action, investigation, conversation, or transition the player can choose now.",
  "Phrase choices[0] as an executable attempt, not as a promise that an uncertain discovery, answer, or NPC reaction is guaranteed.",
  "Order choices by narrative usefulness and avoid placing a repetitive or stalling option first.",
] as const;

export const CHOICE_TIMELINE_RULES = [
  "A reply, denial, acceptance, or answer must respond to specific information already conveyed in player-facing prose. A reachable speaker alone does not establish that information; never import an unsaid accusation or revelation from the source excerpt into a choice.",
  "Every choice must be executable at the decision point created by the generated scene, using only people, objects, events, and information already established in player-facing narrative.",
  "A choice must not hide an unmet prerequisite in assumed setup. Its main voluntary verb must be able to begin immediately from the visible scene state; for example, 'Catch a fish' requires the player-facing prose to already establish the player fishing with access to fish. If that activity is not yet established, offer the prerequisite itself, such as 'Start fishing', instead.",
  "Treat anything the completed setting text visibly shows player_identity saying, doing, deciding, revealing, requesting, accepting, refusing, or otherwise accomplishing as already past for the new menu, even if source_event_beat_progress still lists a matching source beat as remaining. Never offer that action or disclosure again as choice 1 or as an alternative.",
  "When visible completed setting text and stored source-event progress disagree, the visible completed scene controls what may be offered to the player now; stale progress may guide later reconciliation but must never cause a replay choice.",
  "Every choice must have a plausible immediate consequence that advances the world state through new information, action, conflict, movement, or another concrete development. Waiting or observing is valid only when an established ongoing event can visibly progress.",
  "A temporal clause does not make a deferred action executable. When a choice's main voluntary act can begin only after an unmet prerequisite introduced by words such as 'after', 'once', 'when', 'until', or 'then', offer the immediate prerequisite itself instead.",
  "Treat character_profiles, objective, victoryCondition, story_so_far, and unreached upcoming_source_material as background knowledge, never as evidence that their later people or events are currently known, present, expected, or inevitable. The only disclosure exception is a typed navigation event that requires informed consent for a consequential voluntary action by player_identity.",
  "If unavailable_characters contains the actor of the earliest remaining source beat, prefer choices[0] as player_identity taking over that same concrete narrative function when the action is physically possible and does not turn an actor-to-player or self-directed beat into a self-targeted action. Otherwise do not steer choices toward that impossible beat; later source routing will invalidate or bypass it.",
  "Do not offer a choice that presupposes a future character, arrival, crime, discovery, consequence, or plan that the player-facing timeline has not established.",
  "Future-tense wording such as 'when they arrive' or 'if it happens' does not make an unreached event a valid choice premise. First introduce a present in-story reason to anticipate it without revealing future source knowledge.",
] as const;

export const INFORMED_PLAYER_CHOICE_RULES = [
  "When a supplied choice navigation event has requiresExplicitPlayerChoice true, choice 1 must explicitly name the consequential voluntary act proposed for player_identity and its foreseeable decisive intent. Asking for consent to a killing, attack, betrayal, departure, deception, or other decisive player action is an informed-consent exception, not a spoiler; phrase it as an action the player can choose now, never as already completed.",
  "This exception applies only to a consequential voluntary source action attributed to player_identity. Preserve spoiler protection for NPC or world events and for non-consequential future developments: do not reveal, summarize, presuppose, or present them as inevitable before player-facing narrative establishes them.",
] as const;

export const CHOICE_STAKES_RULES = [
  "Classify every choice by its likely consequences, not by individual words in its text.",
  "Use stakes 'routine' for low-impact, readily reversible choices; 'significant' for choices that materially change the situation but are not inherently irreversible; and 'critical' only when choosing it could directly cause irreversible harm, death, betrayal, a major confession, surrender, or a comparably decisive consequence.",
] as const;

export const TURN_SCOPE_RULES = [
  "Resolve one player decision per turn. Show every beat explicitly contained in latest_input and its immediate causal responses, then stop at the next meaningful decision point.",
  "Do not invent or perform a separate consequential voluntary player action after latest_input. Movement, attacks, object use, speech, deception, cleanup, departures, and other menu-worthy decisions require a new player choice unless latest_input already includes them.",
  "An unselected source beat whose actor is player_identity is still an unselected player decision. Never perform its dialogue, confession, explanation, request, promise, acceptance, refusal, movement, or other voluntary act merely because it is the next canonical beat; stop immediately before it and leave it for the next choice menu.",
  "When latest_input lists unselected_options, those are explicitly unrealized alternatives. Do not perform, blend in, or assume any of them in the scene.",
  "Upcoming source material, the objective, and dramatic plausibility never authorize an unchosen player action. If a source-backed development requires such an action, leave it in the future and offer a voluntary route toward it as a choice.",
  "Classify ordered source beats relative to player_identity before narrating them: a beat whose actor is player_identity is a player beat; a beat whose targets include player_identity is directly player-relevant; a beat with neither is background world/NPC progression.",
  "When comparing beat actors and targets to player_identity, treat the player's known profile name and aliases as the same identity.",
  "Background beats may occur around the player in source order without inventing a role, decision, dialogue, or motive for player_identity. Do not rewrite an NPC or world beat so the player becomes its actor merely to keep the player active; a typed beat that already names player_identity as actor after world-state adaptation is the exception and must remain player-controlled.",
  "A directly player-relevant target beat may happen to or around player_identity when its causal prerequisites are satisfied, but it does not authorize a new voluntary response by the player unless latest_input selected that response.",
  "A contiguous run of source beats whose agency is external or involuntary is one automatic progression window and may be narrated in the same generated scene in source order when its causal prerequisites are satisfied. Do not force a player decision between those beats; stop before any later meaningful voluntary player beat that latest_input did not select.",
  "Never advance to a later source beat when reaching it requires an earlier meaningful voluntary player beat that latest_input did not authorize. Stop before that player beat and leave both it and every causally dependent later beat in the future.",
  "A later NPC, external, involuntary, or routine consequence cannot retroactively imply, authorize, or silently satisfy an unselected meaningful player beat. Do not narrate that later consequence until the required player beat has been selected or is already established as completed.",
  "Do not compress a later plot phase, a second major source event, or a substantial time or location jump into the same turn merely to make the scene dramatic. Immediate NPC reactions and independently occurring world consequences are allowed when they follow causally from the resolved input.",
  "When the turn instruction contains REGENERATION REQUIRED and REJECTED BECAUSE, treat every listed rejection as an authoritative correction constraint for the next draft. Do not merely vary wording; explicitly repair each listed failure while preserving the valid established state and the latest player input.",
] as const;

export const SCENE_SCOPE_RULES = [
  CONVERSATIONAL_REACH_POLICY,
  "Return sceneScope as authoritative hidden state for the decision point at the end of this turn.",
  "sceneScope.currentLocation is the player's concrete current location; keep it unchanged unless this turn visibly moves the player.",
  "Never transplant a source-backed event, character, or prop into sceneScope.currentLocation merely because that event is next in upcoming_source_material. Source order does not override physical continuity.",
  "When an explicitly selected source continuation requires the player to reach a different location, narrate a visible, causally plausible transition before depicting location-specific source events. If latest_input and the current turn scope do not authorize that movement, leave the source event in the future instead of relocating it into the current scene.",
  "When sceneScope.currentLocation changes, rebuild presence for the destination. Do not carry prior peoplePresent or peopleWithinSpeakingDistance forward unless the narration establishes that those characters moved with the player or independently arrived there.",
  "Always include player_identity exactly once in both peoplePresent and peopleWithinSpeakingDistance. These are character lists, including nonhuman players such as Toto; player membership does not make them an NPC, allow self-targeted choices, or grant human speech.",
  "sceneScope.peoplePresent contains the player and every living non-player character physically present and interactable at currentLocation at the end of the turn. Exclude characters who are elsewhere, absent, dead, corpses, or departed.",
  "sceneScope.peopleWithinSpeakingDistance contains the player plus only living non-player characters from peoplePresent who can immediately hear and answer the player without another movement or transition.",
  "Use only exact character names or aliases from the known character profiles in sceneScope. Do not decorate or qualify an identity; uncertain identity or an anticipated arrival is not confirmed presence.",
  "Carry the prior sceneScope forward and update it only for arrivals, departures, movement, or distance changes visibly established in this turn.",
  "Use sceneScope to constrain choices: immediate dialogue is possible only with peopleWithinSpeakingDistance; do not target absent people as if they were in the room.",
  "For every action choice that directly interacts with a named non-player character, that character must already be in sceneScope.peoplePresent. If they are absent, offer only actions executable before their arrival or another visible prerequisite.",
] as const;

export const WORLD_RULE_POLICY = [
  "The supplied active world rules are persistent, user-authored overrides for this interactive timeline.",
  "Apply them in listed order. When active world rules conflict, the newest (last) world rule wins.",
  "Treat them as authoritative over character_profiles, source characterizations, canonical motives, habits, preferences, goals, and other conflicting background details.",
  "Do not require an ordinary persistent fact to be restated in every scene when the candidate neither contradicts it nor makes it currently observable.",
  "Let affected characters consistently act, speak, choose, and react according to these world rules in every future scene and dialogue.",
  "When a world rule explicitly describes continuous, constant, always-on, frequent, repeated, recurring, or per-scene observable behavior, treat that recurrence as mandatory rather than optional flavor. In every generated scene where the affected character is present and the behavior is physically possible, include at least one concrete observable sign of it.",
  "Do not omit an applicable recurring behavior merely because the main plot beat is unrelated. Keep its manifestation brief and natural so it does not replace the turn's selected action, required source beat, or decision point.",
  "For dialogue turns involving an affected character, reflect applicable recurring behavior in characterResponse or narration when it can occur during the exchange.",
  "A world rule changes the game world's governing facts; it is not itself a player action or a completed scene event. Introduce its visible consequences naturally when relevant.",
  "Preserve source events where compatible, but adapt or replace conflicting characterization and causal details rather than ignoring an active world rule.",
  "A rule overridden by a newer conflicting rule is not a compliance requirement. Assess the effective rules in listed order, not each historical rule in isolation.",
] as const;

export const DIALOGUE_SUGGESTION_TIMELINE_RULES = [
  "When generating suggested player dialogue, treat next_significant_event_progress.next_required_beat as the furthest source-backed development the suggestions may intentionally steer toward. Do not mention, propose, assume, or reveal any later beat or significant event whose prerequisite beats are still incomplete.",
  "A dialogue suggestion may vary tone or strategy, but it must remain executable from the current player-facing scene and may not presuppose knowledge, plans, relationships, destinations, goals, or agreements that exist only in later upcoming_source_material.",
] as const;

export const RUNTIME_PARAMETER_RULES = WORLD_RULE_POLICY;

export const STORY_MEMORY_RULES = [
  "Return storyMemory as compact persistent memory after this turn.",
  "storyMemory.summary must update prior story_memory.summary with only established player-facing events and consequences. Keep it chronological, concrete, spoiler-free, and under 900 characters.",
  "storyMemory.openThreads must contain at most 6 unresolved conflicts, unanswered questions, promises, dangers, or plans that are explicitly established and still relevant after this turn.",
  "Do not treat unselected choices, hidden metadata, unreached source material, speculation, mood, or possible future events as open threads.",
  "Remove threads resolved or invalidated by this turn. Write each remaining thread as one short standalone sentence.",
  "storyMemory.canonFacts must contain at most 12 durable, established facts that future turns must not contradict, such as deaths, injuries, revealed identities, irreversible relationship changes, acquired objects, and binding world rules.",
  "Never add a canon fact from character_profiles, story_so_far, or upcoming_source_material until player-facing narration has established it.",
] as const;

