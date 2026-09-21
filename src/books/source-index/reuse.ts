import { validateSourceBeatSemantics } from "../../shared/source-beat-semantics.js";
import { parsePlayerAction } from "../../shared/player-actions.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
} from "../../shared/contracts.js";
import type {
  ChapterSourceIndex,
} from "../../shared/contracts.js";

/**
 * A saved chapter source index is reusable only when it satisfies the current
 * persisted contract, not merely when its schemaVersion happens to match.
 *
 * v17 re-audits passive perception so automatic observations cannot become
 * player decisions. v16 added causal/spatial transition coverage before grouping.
 * Older indexes are re-audited on reimport; serving an existing book is unchanged.
 *
 * v12 requires every meaningful intentional beat to belong to exactly one group.
 * Older checkpoints are candidates for re-audit, never approved v12 results.
 *
 * v8 strengthens action/postcondition boundaries and invalidates existing v7
 * indexes, including those with non-empty but temporally incorrect states.
 *
 * v7 introduced source-backed postconditions for every indexed beat. Early v7
 * checkpoints created while that work was in progress can therefore carry the
 * v7 number without actually containing resultingState on every beat. Reusing
 * those checkpoints would prevent character projections from deriving
 * automaticPreludeEndState and would silently preserve stale boundary data.
 */
export function isReusableChapterSourceIndex(
  sourceIndex: ChapterSourceIndex | undefined,
): sourceIndex is ChapterSourceIndex {
  if (
    sourceIndex?.schemaVersion !== CHAPTER_SOURCE_INDEX_VERSION
    || !sourceIndex.summary.trim()
  ) {
    return false;
  }

  try {
    validateSourceBeatSemantics((sourceIndex.significantEvents ?? []).flatMap(e => e.beats ?? []));
    return (sourceIndex.significantEvents ?? []).every(event => {
      if (!event.beats?.length) return false;
      if (sourceIndex.extractionMode === "shared_events_v1") {
        return event.beats.every(beat => Boolean(beat.resultingState?.trim())
          && beat.playerAction === undefined && beat.characterActionGroup === undefined);
      }
      const coverage = new Set<number>();
      for (const [i, beat] of event.beats.entries()) {
        if (!beat.resultingState?.trim()) return false;
        const action = parsePlayerAction(beat.playerAction, i, event.beats);
        if (!action) continue;
        if (!action.id?.trim()) return false;
        for (const member of action.playerBeatIndexes) {
          if (coverage.has(member)) return false;
          coverage.add(member);
        }
      }
      return event.beats.every((beat, i) => !beat.actor || beat.agency !== "intentional"
        || beat.stakes === "routine" || coverage.has(i));
    });
  } catch { return false; }
}


