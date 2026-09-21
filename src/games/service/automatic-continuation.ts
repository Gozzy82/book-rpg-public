import {SOURCE_CONTINUATION_CHOICE_ID} from '../../shared/contracts.js';
import type {GameState} from '../../shared/contracts.js';
import {SceneGenerationError} from '../../ai/engine/core.js';
import {flowDiagnostic} from '../../util/flow-trace.js';

/** Join reviewed automatic segments into one visible turn; never select a player option. */
export async function joinAutomaticContinuations(game: GameState,
  advance: (draft: GameState) => Promise<boolean>, maximum = 8): Promise<void> {
  if (game.narrativeMode !== 'canonical') return;
  const texts = [game.scene.text];
  const position = (state: GameState) => JSON.stringify([state.sourceCursor, state.sourceEventProgress]);
  for (let count = 0; count < maximum; count++) {
    if ((game.scene.outcome ?? 'active') !== 'active' || game.scene.choices.length !== 1
      || game.scene.choices[0]?.id !== SOURCE_CONTINUATION_CHOICE_ID) break;
    const draft = structuredClone(game);
    const before = position(game);
    try {
      if (!await advance(draft)) break;
    } catch (error) {
      if (!(error instanceof SceneGenerationError)) throw error;
      // Keep the last reviewed boundary and its explicit continuation option.
      flowDiagnostic('Automatic continuation stopped at reviewed boundary: ' + error.message);
      break;
    }
    if (position(draft) === before) {
      // A preflight may expose the next player menu without advancing the story.
      if (draft.scene.choices.some(c => c.id !== SOURCE_CONTINUATION_CHOICE_ID)) game.scene.choices = draft.scene.choices;
      break;
    }
    texts.push(draft.scene.text);
    Object.assign(game, draft);
  }
  // Scope, memory and menu describe the final segment; prose preserves ordered events.
  game.scene.text = texts.join('\n\n');
}
