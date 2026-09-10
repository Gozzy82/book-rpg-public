export {
  normalizeCharacterIdentity,
  buildVerifiedIdentityResolver,
  cleanIdentityLabel,
  parseChapterPartSourceIndex,
  mergeChapterPartSourceIndexes,
} from "./source-index/chapter-index.js";
export type {
  SourceLineRange,
  ChapterPartSourceIndex,
  ChapterPartBounds,
} from "./source-index/chapter-index.js";
export {
  classifyStoryEventCategory,
  buildBookStoryEvents,
} from "./source-index/story-events.js";
export {
  selectCoreCharacterProfiles,
  parseWorldBibleOutput,
} from "./source-index/profiles.js";
