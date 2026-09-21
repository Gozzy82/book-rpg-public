import {traceEvent} from '../../util/flow-trace.js';
import type {GameState, ImportedBook} from '../../shared/contracts.js';
import {SOURCE_ANCHOR_CHOICE_ID} from '../../shared/contracts.js';
import type {AiClient} from '../../ai/provider.js';
import {generateFreeWorldScene} from '../../ai/free-world.js';
import {addSourceContinuationAnchorChoice} from '../../ai/engine.js';
import {newSceneCode, takeMatchingBridge, retireObsoleteBridge} from '../return-bridges.js';
import {applyReviewedGeneratedScene} from './game-state.js';
import {restoreSideTurnSourceAnchor} from './resume-source-anchor.js';

type FreeTurnKind = 'action' | 'observe' | 'event' | 'dialogue';
interface FreeTurnOptions {
  preserveNarrativeMode?: boolean;
  suppressBridgeRouting?: boolean;
  /** Internal provider override; never taken from the public turn request. */
  client?: AiClient;
}

/** No source candidates, source passage, alignment, or anchor search on this path. */
export async function applyFreeWorldTurn(game: GameState, input: string,
  kind: FreeTurnKind, book?: ImportedBook,
  options: FreeTurnOptions = {}): Promise<{bridgePreludeReady:boolean}> {
  // Event execution, reviewed world changes and menu restoration are one unit.
  // A failed writer/review must not leave a changed mode, bridge or partial scene
  // on the caller's game. initiateEvent saves only after this call succeeds.
  const working = kind === 'event' ? structuredClone(game) : game;
  const result = await applyFreeWorldTurnImpl(working, input, kind, book, options);
  if (working !== game) Object.assign(game, working);
  return result;
}

async function applyFreeWorldTurnImpl(game: GameState, input: string,
  kind: FreeTurnKind, book: ImportedBook | undefined,
  options: FreeTurnOptions): Promise<{bridgePreludeReady:boolean}> {
  const previousEventAnchor = kind === 'event' && game.narrativeMode !== 'free'
    ? game.scene.choices.find(choice => choice.id === SOURCE_ANCHOR_CHOICE_ID
      && choice.sourceAnchorRoute === 'event' && Boolean(choice.sourceBeatSelection))
    : undefined;
  const preserveEventAnchor = Boolean(previousEventAnchor);
  const preserveNarrativeMode = options.preserveNarrativeMode || preserveEventAnchor;
  const suppressBridgeRouting = options.suppressBridgeRouting || preserveEventAnchor;

  // The already offered canonical decision is not a new return opportunity.
  // Do not feed an unrelated/pre-event bridge to the event writer or let a
  // bridge review compete with executing the requested external occurrence.
  if (!preserveNarrativeMode) game.narrativeMode = 'free';
  if (!suppressBridgeRouting) retirePreviousBridgeMenu(game);
  const bridge = suppressBridgeRouting ? undefined : takeMatchingBridge(game);
  traceEvent('free_world.bridge_selection', {selectedBridgeId: bridge?.id ?? null, returnPlanning: game.returnPlanning ?? null});
  const scene = await generateFreeWorldScene(game, input, kind, bridge, options.client);
  const {obsoleteBridgeEvidence, canonicalPreludeReady, ...generatedScene} = scene;
  if (bridge && obsoleteBridgeEvidence) {
    retireObsoleteBridge(game, bridge, obsoleteBridgeEvidence);
    traceEvent('free_world.bridge_retired', {bridgeId:bridge.id,reason:'Target overtaken by free play',evidence:obsoleteBridgeEvidence});
  }
  // An offered anchor belongs to this menu; an unused plan remains eligible next turn.
  const offered = bridge && generatedScene.choices.some(c => c.bridgeId === bridge.id);
  if (bridge && game.returnPlanning?.activeBridgeId === bridge.id) {
    bridge.steps = [...(bridge.steps ?? []), {action:input, location:generatedScene.sceneScope?.currentLocation ?? '', scene:generatedScene.text}].slice(-8);
    traceEvent('free_world.bridge_progress', {bridgeId:bridge.id, target:bridge.target, steps:bridge.steps, anchorOffered:Boolean(offered)});
  }
  if (offered) bridge.status = 'offered';
  game.sceneTrace = {storyCode: newSceneCode(game), ...(bridge && (offered || game.returnPlanning?.activeBridgeId === bridge.id) ? {bridgeId: bridge.id} : {})};
  const preservedNarrativeMode = preserveNarrativeMode ? game.narrativeMode : undefined;
  const preservedSourceCursor = preserveNarrativeMode ? structuredClone(game.sourceCursor) : undefined;
  const preservedSourceEventProgress = preserveNarrativeMode ? structuredClone(game.sourceEventProgress) : undefined;
  const preservedSourceIntroducedCharacters = preserveNarrativeMode
    ? structuredClone(game.sourceIntroducedCharacters)
    : undefined;
  try {
    // A side interaction may update the visible world, memory and death ledger,
    // but it must never consume canonical source beats or trigger automatic
    // continuation merely because the surrounding game is still canonical.
    if (preserveNarrativeMode) game.narrativeMode = 'free';
    await applyReviewedGeneratedScene(game, generatedScene, book);
  } finally {
    if (preserveNarrativeMode) {
      game.narrativeMode = preservedNarrativeMode ?? 'canonical';
      if (preservedSourceCursor === undefined) delete game.sourceCursor;
      else game.sourceCursor = preservedSourceCursor;
      if (preservedSourceEventProgress === undefined) delete game.sourceEventProgress;
      else game.sourceEventProgress = preservedSourceEventProgress;
      if (preservedSourceIntroducedCharacters === undefined) delete game.sourceIntroducedCharacters;
      else game.sourceIntroducedCharacters = preservedSourceIntroducedCharacters;
    }
  }
  if (previousEventAnchor) {
    const active = (game.scene.outcome ?? 'active') === 'active' && game.status === 'active';
    const restored = active
      ? restoreSideTurnSourceAnchor(game, book, previousEventAnchor)
      : {restored:false, invalidated:false, reason:'The world event ended the game.'};
    if (active && !restored.restored) {
      // Invalidation retires the exact impossible target, never credits it as
      // completed. Keep a visible book route rather than reviving its victim.
      game.scene = addSourceContinuationAnchorChoice(game.scene);
    }
    traceEvent('world_event.anchor_restore', {
      ...restored,
      selectedInput: input,
      sourceBeatSelection: previousEventAnchor.sourceBeatSelection,
      previousAnchorText: previousEventAnchor.text,
      restoredAnchorText: restored.restored ? game.scene.choices[0]?.text ?? null : null,
      confirmedDeadCharacters: game.confirmedDeadCharacters ?? [],
      sourceCursor: game.sourceCursor ?? null,
      sourceEventProgress: game.sourceEventProgress ?? null,
    });
  }
  return {bridgePreludeReady:Boolean(canonicalPreludeReady)};
}
export function retirePreviousBridgeMenu(game: GameState, selectedBridgeId?: string): void {
  for (const bridge of game.returnPlanning?.bridges ?? []) {
    if (bridge.status === 'offered' && bridge.id !== selectedBridgeId) bridge.status = 'ready';
  }
}
