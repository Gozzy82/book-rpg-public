import type { GameState, Scene, StoryMemory } from "../shared/contracts.js";

export const MAX_STORED_HISTORY_ITEMS = 16;
const MAX_STORY_SUMMARY_CHARS = 4_000;
const MAX_MEMORY_ITEM_CHARS = 240;
const MAX_OPEN_THREADS = 6;
const MAX_CANON_FACTS = 12;

function boundedText(value: string | undefined, maximum = MAX_MEMORY_ITEM_CHARS): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function uniqueMemoryItems(
  values: readonly string[],
  maximumItems: number,
): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = boundedText(value);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items.slice(-maximumItems);
}

function appendSummary(current: string, addition: string): string {
  const combined = [boundedText(current, MAX_STORY_SUMMARY_CHARS), addition]
    .filter(Boolean)
    .join(" ");
  if (combined.length <= MAX_STORY_SUMMARY_CHARS) return combined;
  return combined.slice(combined.length - MAX_STORY_SUMMARY_CHARS).trimStart();
}

function historySummary(game: Pick<GameState, "history">): string {
  const summary = game.history
    .flatMap((item) => {
      if (item.kind === "start") return [`Opening: ${boundedText(item.text)}`];
      if (item.kind === "scene") {
        return [boundedText(item.development) || boundedText(item.text)];
      }
      if (item.kind === "choice") return [`Player chose: ${boundedText(item.text)}`];
      if (item.kind === "dialogue") return [`Player said: ${boundedText(item.text)}`];
      if (item.kind === "event") return [`World event: ${boundedText(item.text)}`];
      if (item.kind === "story") return [boundedText(item.text)];
      return [];
    })
    .filter(Boolean)
    .join(" ");
  if (summary.length <= MAX_STORY_SUMMARY_CHARS) return summary;
  const openingChars = Math.min(800, Math.floor(MAX_STORY_SUMMARY_CHARS / 4));
  const endingChars = MAX_STORY_SUMMARY_CHARS - openingChars - 3;
  return `${summary.slice(0, openingChars).trimEnd()} … ${
    summary.slice(-endingChars).trimStart()
  }`;
}

function fallbackOpenThreads(
  game: Pick<GameState, "storyMemory">,
  scene: Scene,
): string[] {
  if ((scene.outcome ?? "active") !== "active") return [];
  return uniqueMemoryItems([
    ...(game.storyMemory?.openThreads ?? []),
    scene.development ?? "",
  ], MAX_OPEN_THREADS);
}

export function applyStoryMemory(
  game: Pick<GameState, "storyMemory">,
  scene: Scene,
  update?: StoryMemory,
): void {
  const fallbackSummary = scene.development?.trim() || scene.text;
  const summary = boundedText(update?.summary, MAX_STORY_SUMMARY_CHARS)
    || appendSummary(game.storyMemory?.summary ?? "", boundedText(fallbackSummary));
  game.storyMemory = {
    summary,
    openThreads: update
      ? uniqueMemoryItems(update.openThreads ?? [], MAX_OPEN_THREADS)
      : fallbackOpenThreads(game, scene),
    // Model memory is a complete current snapshot, not an append-only fact log.
    canonFacts: uniqueMemoryItems(update ? update.canonFacts : game.storyMemory?.canonFacts ?? [], MAX_CANON_FACTS),
  };
}

export function compactGameHistory(game: GameState): boolean {
  let changed = false;
  if (!game.storyMemory) {
    game.storyMemory = {
      summary: historySummary(game),
      openThreads: fallbackOpenThreads(game, game.scene),
      canonFacts: [],
    };
    changed = true;
  }
  if (game.history.length > MAX_STORED_HISTORY_ITEMS) {
    game.history = game.history.slice(-MAX_STORED_HISTORY_ITEMS);
    changed = true;
  }
  return changed;
}
