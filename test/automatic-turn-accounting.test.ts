import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { GameState } from '../src/shared/contracts.js';

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookrpg-auto-accounting-'));
process.env.BOOKRPG_DATA_DIR = testDataDir;
process.env.BOOKRPG_FAKE_AI = '1';
const { getGame, saveGame } = await import('../src/games/repository.js');
const { refreshAutomaticTurnResponse } = await import('../src/server/auto-source-continuation.js');
const { gameResponse, applyGeneratedScene, recordCompletedTurn } = await import('../src/games/service/game-state.js');
const { createUndoSnapshot, undoLastChoice } = await import('../src/games/service/operations.js');
const { assertTurnProgress } = await import('../e2e/bookrpg-playwright/progress-check.mjs');
after(() => fs.rm(testDataDir, { recursive: true, force: true }));

for (const hops of [1, 3]) {
  test(`${hops} saved continuations survive response finalization, a player choice and undo`, async () => {
    const scene = { title: 'Riverbank', text: 'We reached the riverbank; Scarecrow remains stranded.', choices: [{id: 'continue', type: 'action' as const, text: 'Continue'}] };
    const game = {
      gameId: `auto-accounting-${hops}`, book: {bookId: 'missing-book', title: 'Oz'}, playerName: 'Cowardly Lion',
      gameProfile: {category: 'adventure', endingMode: 'open_ended', description: 'Journey'}, objective: 'Find Oz', victoryCondition: 'Reach Oz',
      status: 'active', selectedText: '', scene, history: [{kind: 'scene', text: scene.text}],
      turnNumber: 14, turnHistory: [], createdAt: 'now', updatedAt: 'now',
      sourceEventProgress: {eventId: 'river', completedBeatIndexes: [0]},
    } as GameState;
    recordCompletedTurn(game, 'choice', 'Swim ashore');
    await saveGame(game);
    const descriptions=['The Stork offers help.','The Stork rescues Scarecrow.','We enter the poppy field.'];
    for(let i=0;i<hops;i++) {
      applyGeneratedScene(game,{...scene,text:descriptions[i]!});
      game.history.push({kind:'scene',text:game.scene.text});
      recordCompletedTurn(game,'continuation','And events move forward…');
      await saveGame(game);
    }
    const persisted=structuredClone((await getGame(game.gameId))!);
    const responseMetadata={sourceAdvance:{sourceChapter:{chapterPosition:9,chapterTitle:'Journey'},anchor:'Continue',cursorBefore:{chapterPosition:9,textOffset:0},cursorAfter:{chapterPosition:9,textOffset:100}},notice:{code:'STORY_CONTINUATION_UNAVAILABLE' as const,message:'The next window was rejected; previous progress is saved.'}};
    const response=await refreshAutomaticTurnResponse({...gameResponse(game),...responseMetadata});
    const saved=(await getGame(game.gameId))!;
    assert.deepEqual(saved,persisted);
    assert.deepEqual(response.turnHistory.map(t=>t.turnNumber),Array.from({length:hops+1},(_,i)=>14+i));
    assert.deepEqual(response.turnHistory.slice(1).map(t=>t.scene.text),descriptions.slice(0,hops));
    assert.equal(response.scene.text,response.turnHistory.at(-1)!.scene.text);
    assert.deepEqual(response.notice,responseMetadata.notice);
    assert.deepEqual(response.sourceAdvance,responseMetadata.sourceAdvance);
    saved.undoSnapshot=createUndoSnapshot(saved);
    applyGeneratedScene(saved,{...scene,text:'I run through the poppies.'});
    saved.history.push({kind:'scene',text:saved.scene.text});
    recordCompletedTurn(saved,'choice','Run');
    await saveGame(saved);
    assert.equal(saved.turnHistory!.at(-1)!.turnNumber,15+hops);
    assert.deepEqual(saved.turnHistory!.slice(0,-1),response.turnHistory);
    assert.doesNotThrow(()=>assertTurnProgress(response,gameResponse(saved)));
    const undone=await undoLastChoice(game.gameId);
    assert.deepEqual(undone.turnHistory,response.turnHistory);
    assert.equal(undone.scene.text,response.scene.text);
  });
}
