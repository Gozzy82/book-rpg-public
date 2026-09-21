import type { GameState, ImportedBook } from "../shared/contracts.js";
import { SOURCE_ANCHOR_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_TEXT } from "../shared/contracts.js";
import { playerControlsBeat } from "../shared/turn-policy.js";
import { playerActionAt } from "../shared/player-actions.js";
import { findPlayerCharacterProfile } from "../ai/engine/player.js";
import { sourceIndexFingerprint } from "../books/source-index/game-version.js";
import { buildBookStoryEvents } from "../books/source-index/story-events.js";

/** Attach identities after scene review and progress reduction, never from model-supplied IDs. */
export function bindSourceAnchorSelection(game: GameState, book: ImportedBook | undefined): void {
  for (const choice of game.scene.choices) delete choice.sourceBeatSelection;
  const anchor = game.scene.choices[0];
  if (!book || !game.sourceIndexFingerprint || game.sourceIndexFingerprint !== sourceIndexFingerprint(book)
    || !anchor || anchor.id !== SOURCE_ANCHOR_CHOICE_ID || anchor.type !== "action"
    || anchor.sourceAnchorRoute !== "event" || !anchor.sourceEventId || game.status !== "active") return;
  const event = (book.storyEvents ?? buildBookStoryEvents(book)).find(e => e.eventId === anchor.sourceEventId);
  if (!event?.beats?.length) return;
  const profile = findPlayerCharacterProfile(game.playerName, game.characterProfiles);
  const aliases = [...new Set([game.playerName, ...(profile ? [profile.name, ...profile.aliases] : [])])];
  const completed = game.sourceEventProgress?.eventId === event.eventId ? game.sourceEventProgress.completedBeatIndexes : [];
  const start = game.sourceEventProgress?.eventId === event.eventId ? game.sourceEventProgress.startBeatIndex ?? 0 : 0;
  const beatIndex = event.beats.findIndex((beat, i) => i >= start && !completed.includes(i) && playerControlsBeat(beat, aliases));
  // An automatic continuation anchor must not also consent to a later player act.
  const firstPending = event.beats.findIndex((_, i) => i >= start && !completed.includes(i));
  if (firstPending >= 0 && !playerControlsBeat(event.beats[firstPending]!, aliases)) {
    // Target presence alone does not make a later rescue/response executable. Keep
    // the canonical menu on automatic progression until its prerequisite beats occur.
    game.scene.choices = [{id: SOURCE_CONTINUATION_CHOICE_ID, type: "action", text: SOURCE_CONTINUATION_CHOICE_TEXT, stakes: "significant"},
      ...game.scene.choices.slice(1).filter(c => c.id !== SOURCE_CONTINUATION_CHOICE_ID && c.id !== SOURCE_ANCHOR_CHOICE_ID)];
    return;
  }
  if (beatIndex < 0 || beatIndex !== firstPending) return;
  const group = game.playerActionVersion === 2 ? playerActionAt(event.beats, beatIndex, aliases) : undefined;
  anchor.sourceBeatSelection = {...(group?.id ? {actionId: group.id, playerBeatIndexes: [...group.playerBeatIndexes]} : {}), eventId: event.eventId, beatIndex,
    endBeatIndex: group?.endBeatIndex ?? beatIndex, kind: group ? "player_action" : "beat"};
  // The canonical group choice always labels the complete goal that this value selects.
  if (group) anchor.text = group.choiceText;
}
