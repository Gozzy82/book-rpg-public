import type {StoryEventCategory} from './contracts.js';

export const STORY_EVENT_CATEGORIES = [
  'death', 'violence', 'discovery', 'revelation', 'departure', 'arrival',
  'investigation', 'decision', 'other',
] as const;
export const STORY_EVENT_CATEGORY_POLICY = "Classify each event by what actually happens in its source-backed beats. Use death only for an actual death in this event, not a threat, plan, condition, recollection or discovery of an earlier death. Discovery of a body is discovery; deciding to kill is decision. Arrival and departure require actual movement, not anticipation. For a compound event with no single suitable category use other. Never classify from isolated words.";
export const storyEventCategorySchema = {
  type: 'string', enum: [...STORY_EVENT_CATEGORIES], description: STORY_EVENT_CATEGORY_POLICY,
} as const;

/** Legacy missing metadata stays unknown; never derive a category from prose. */
export function parseStoryEventCategory(value: unknown): StoryEventCategory {
  if (value === undefined) return 'other';
  if (typeof value !== 'string' || !STORY_EVENT_CATEGORIES.includes(value as StoryEventCategory))
    throw new Error('Invalid story event category');
  return value as StoryEventCategory;
}

/** Merging unlike event kinds must not turn the whole compound event into a death/arrival. */
export function mergedStoryEventCategory(events: readonly {category?: StoryEventCategory}[]): StoryEventCategory {
  const kinds = new Set(events.map(event => parseStoryEventCategory(event.category)));
  return kinds.size === 1 ? [...kinds][0]! : 'other';
}
