export const MAX_SCENE_CONTINUATION_BATCH = 25;

export type ParsedChoiceInput =
  | { kind: "choice"; index: number }
  | { kind: "continue"; count: number }
  | { kind: "history" }
  | { kind: "story" }
  | { kind: "custom" }
  | { kind: "invalid"; message?: string };

export function parseChoiceInput(
  raw: string,
  choiceCount: number,
): ParsedChoiceInput {
  const command = raw.trim().toLocaleLowerCase();
  if (command === "h" || command === "history") return { kind: "history" };
  const repeatedContinuation = command.match(/^c+$/u);
  if (repeatedContinuation) {
    return command.length <= MAX_SCENE_CONTINUATION_BATCH
      ? { kind: "continue", count: command.length }
      : {
          kind: "invalid",
          message: `Request at most ${MAX_SCENE_CONTINUATION_BATCH} continuations at once.`,
        };
  }
  const countedContinuation = command.match(/^cx([1-9]\d*)$/u);
  if (countedContinuation) {
    const count = Number(countedContinuation[1]);
    return Number.isSafeInteger(count) && count <= MAX_SCENE_CONTINUATION_BATCH
      ? { kind: "continue", count }
      : {
          kind: "invalid",
          message: `Request at most ${MAX_SCENE_CONTINUATION_BATCH} continuations at once.`,
        };
  }
  if (command === "9") return { kind: "story" };
  if (command === "101") return { kind: "custom" };

  const index = Number(command) - 1;
  return Number.isInteger(index) && index >= 0 && index < choiceCount
    ? { kind: "choice", index }
    : { kind: "invalid" };
}
