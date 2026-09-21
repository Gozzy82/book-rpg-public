const continuationId = '__bookrpg_source_continuation__';

export function hasOnlyAutomaticContinuation(result) {
  return result?.status === 'active' && result.scene?.choices?.length > 0
    && result.scene.choices.every(choice => choice.id === continuationId);
}

export function assertPlayableResponse(result, { allowAutomatic = false } = {}) {
  if (result?.notice?.code === 'STORY_CONTINUATION_UNAVAILABLE') {
    throw Error(`Verhaalvoortgang mislukt: ${result.notice.message}`);
  }
  if (!result?.scene?.text?.trim()) throw Error('Lege of ontbrekende scènetekst.');
  if (result.status === 'active') {
    const choices = result.scene.choices;
    if (!Array.isArray(choices) || !choices.length) throw Error('Actieve scène heeft geen keuzes.');
    if (!allowAutomatic && hasOnlyAutomaticContinuation(result)) {
      throw Error('Automatisch vervolg is niet afgerond: er is nog geen speelbare keuze.');
    }
  }
}

export function assertTurnProgress(previous, result, options) {
  assertPlayableResponse(result, options);
  if (result.gameId !== previous.gameId) throw Error('Antwoord hoort bij een ander spel.');
  if (result.scene.text.trim() === previous.scene.text.trim()) throw Error('Exact dezelfde scènetekst na de keuze.');
  const before = previous.turnHistory?.at(-1)?.turnNumber;
  const after = result.turnHistory?.at(-1)?.turnNumber;
  if (!Number.isInteger(before) || !Number.isInteger(after) || after <= before) {
    throw Error('Geen nieuwe opgeslagen beurt na de keuze.');
  }
}

// Each callback starts a fresh request budget. Automatic hops are never player choices.
export async function resolveAutomaticContinuations(initial, continueOnce, maxHops = 20) {
  let result = initial;
  assertPlayableResponse(result, { allowAutomatic: true });
  for (let hop = 1; hasOnlyAutomaticContinuation(result); hop++) {
    if (hop > maxHops) throw Error(`Automatisch vervolg bleef na ${maxHops} vervolgpogingen actief.`);
    const next = await continueOnce(result, hop);
    assertTurnProgress(result, next, { allowAutomatic: true });
    result = next;
  }
  assertPlayableResponse(result);
  return result;
}
