import type { CharacterDynamics } from "./character-dynamics.js";
export type ChoiceType = "action" | "talk";
export type ChoiceStakes = "routine" | "significant" | "critical";
export type SourceAnchorRoute = "event" | "transition";
export const FREE_ACTION_CHOICE_ID = "__bookrpg_free_action__";
export const SOURCE_ANCHOR_CHOICE_ID = "__bookrpg_source_anchor__";
export const SOURCE_CONTINUATION_CHOICE_ID = "__bookrpg_source_continuation__";
export const SOURCE_CONTINUATION_CHOICE_TEXT = "And events move forward…";
export type GameStatus = "active" | "won" | "completed" | "lost";
export type BookGameCategory =
  | "mystery"
  | "adventure"
  | "survival"
  | "drama"
  | "exploration"
  | "open_ended";
export type EndingMode = "win" | "completion" | "open_ended";
export type EstablishedEventCategory =
  | "death"
  | "violence"
  | "betrayal"
  | "disaster"
  | "abduction"
  | "accident"
  | "other";

export interface EstablishedEvent {
  category: EstablishedEventCategory;
  actor: string;
  action: string;
  target: string;
  means: string;
  immediateConsequences: string[];
  sourceBacked: true;
  narrative: string;
}

export interface BookGameProfile {
  category: BookGameCategory;
  endingMode: EndingMode;
  description: string;
}

export interface BookRef {
  bookId: string;
  title: string;
  author?: string;
}

// v17 re-audits passive perception so automatic observations cannot become player decisions.
export const CHAPTER_SOURCE_INDEX_VERSION = 17;
export const WORLD_BIBLE_SCHEMA_VERSION = 15;
export const MIN_VERIFIED_IDENTITY_CONFIDENCE = 0.75;

export interface SourceReference {
  chapterPosition: number;
  chapterIndex: number;
  lineStart: number;
  lineEnd: number;
}

export type StoryEventBeatAgency =
  | "intentional"
  | "involuntary"
  | "external"
  | "ambiguous";

/** One source-backed player goal; categories do not grant additional authorization. */
export interface PlayerAction {
  /** Assigned by the server within the pinned book index, never inferred from the label. */
  id?: string;
  kind: "player_action";
  /** Final authorized beat, including an NPC reply or automatic consequence. */
  endBeatIndex: number;
  boundaryReason: string;
  choiceText: string;
  playerBeatIndexes: number[];
  completion: string;
  preconditions: string[];
  interruptWhen: string[];
}

export interface SourceBeatSemantics {
  mode: "present" | "narration";
  /** History being told; never a present physical state or action. */
  narratedContent: string | null;
  intentionalRole: "meaningful" | "other";
  /** Multiple actor representations of one joint act, not successive phases. */
  jointAction: {id: string; participants: string[]; resultingState: string} | null;
}

/** Exact onset of the action; sourceReferences remain broader supporting evidence. */
export interface SourceActionStart {
  chapterPosition: number;
  chapterIndex: number;
  /** One-based line in chapter.text.trim(), matching sourceReferences. */
  line: number;
  /** Zero-based JavaScript string offset within that line. */
  column: number;
  /** Exact nonempty source text starting at column, within the same line. */
  quote: string;
}

export interface StoryEventBeat {
  sourceActionStart?: SourceActionStart;
  /** Optional character-perspective grouping over unchanged source beats. Null suppresses a legacy choice on a continuation. */
  characterActionGroup?: PlayerAction | null;
  sourceSemantics?: SourceBeatSemantics;
  /** Present only on the first beat of an indexed player action. Absolute event-local indexes. */
  playerAction?: PlayerAction;
  /** A new goal, information-dependent choice or material commitment by this actor. */
  decisionBoundaryBefore?: string;
  actor: string | null;
  action: string;
  targets: string[];
  agency: StoryEventBeatAgency;
  stakes: ChoiceStakes;
  /** Concrete world/character state immediately after this source beat. */
  resultingState?: string;
  /** Character-specific state established by the automatic beats preceding this beat. */
  automaticPreludeEndState?: string;
  sourceReferences: SourceReference[];
}

export interface CharacterReference {
  characterId?: string;
  character: string;
}

export interface CharacterAction {
  description: string;
  targets: CharacterReference[];
  sourceReferences: SourceReference[];
}

export interface CharacterRelationship extends CharacterReference {
  description: string;
  sourceReferences?: SourceReference[];
}

export interface CharacterProfile {
  dynamics?: CharacterDynamics;
  characterId?: string;
  name: string;
  aliases: string[];
  role: string;
  description: string;
  traits: string[];
  relationships: CharacterRelationship[];
  actions?: CharacterAction[];
  significantEvents?: BookStoryEvent[];
  sourceReferences?: SourceReference[];
  storyArc: string;
}

export type IdentityDecision = "same_person" | "different_people" | "uncertain";

export interface CharacterIdentityResolution {
  canonicalName: string;
  alias: string;
  decision: IdentityDecision;
  confidence: number;
  sourceReferences: SourceReference[];
}

export interface ChapterCharacterObservation {
  name: string;
  aliases: string[];
  sourceReferences: SourceReference[];
}

export interface ChapterActionObservation {
  actor: string;
  description: string;
  targets: string[];
  sourceReferences: SourceReference[];
}

export interface ChapterRelationshipObservation {
  character: string;
  relatedCharacter: string;
  description: string;
  sourceReferences: SourceReference[];
}

export interface ChapterSignificantEvent {
  description: string;
  /** AI classification; absent in legacy indexes. */
  category?: StoryEventCategory;
  /** Direct grammatical actors of this event; absent in legacy source indexes. */
  actors?: string[];
  /** Character recipients or affected participants; absent in legacy source indexes. */
  targets?: string[];
  /** Atomic agency-classified event actions; absent in legacy imported books. */
  beats?: StoryEventBeat[];
  sourceReferences: SourceReference[];
}

export type StoryEventCategory =
  | "death"
  | "violence"
  | "discovery"
  | "revelation"
  | "departure"
  | "arrival"
  | "investigation"
  | "decision"
  | "other";

export interface BookStoryEvent {
  eventId: string;
  sequence: number;
  description: string;
  category: StoryEventCategory;
  chapterPosition: number;
  actors: string[];
  targets: string[];
  /** Atomic agency-classified event actions; absent in legacy imported books. */
  beats?: StoryEventBeat[];
  sourceReferences: SourceReference[];
}

export interface ChapterSourceIndex {
  /** Shared extraction contains no character goal partitions. */
  extractionMode?: "shared_events_v1";
  schemaVersion: typeof CHAPTER_SOURCE_INDEX_VERSION;
  summary: string;
  significantEvents?: ChapterSignificantEvent[];
  characters: ChapterCharacterObservation[];
  actions: ChapterActionObservation[];
  relationships: ChapterRelationshipObservation[];
}

export interface WorldBible {
  schemaVersion?: typeof WORLD_BIBLE_SCHEMA_VERSION;
  summary: string;
  characters: string[];
  characterProfiles?: CharacterProfile[];
  identityResolutions?: CharacterIdentityResolution[];
  locations: string[];
}

export interface ReadingPosition {
  chapterIndex?: number;
  chapterTitle?: string;
  progress?: number; // 0..1; later populated by KOReader
}

export interface SourceCursor {
  chapterPosition: number;
  textOffset: number;
  eventId?: string;
}

/** Cumulative, ordered beat progress for the next source event. */
export interface SourceEventProgress {
  /** Entry or later bridge re-entry boundary; earlier indexes are not required again and are not implicitly completed. */
  startBeatIndex?: number;
  eventId: string;
  completedBeatIndexes: number[];
}

export interface StartGameRequest {
  book: BookRef;
  playerName?: string;
}

/** Server-owned identity of the canonical action; display text is not authorization. */
export interface SourceBeatSelection {
  actionId?: string;
  playerBeatIndexes?: readonly number[];
  eventId: string;
  beatIndex: number;
  endBeatIndex: number;
  kind: "beat" | "player_action";
}

export interface GameChoice {
  /** Server-owned link to a prepared opportunity; never rendered in prose. */
  bridgeId?: string;
  /** Free intermediate action toward a prepared bridge; never canonical authorization. */
  bridgeStepId?: string;
  sourceBeatSelection?: SourceBeatSelection;
  id: string;
  type: ChoiceType;
  text: string;
  character?: string;
  /** Known characters whose current presence is required for this choice. */
  requiredPresentCharacters?: string[];
  /** Known characters whose current absence is required for this choice. */
  requiredAbsentCharacters?: string[];
  /** Source event this concrete anchor choice is intended to reach. */
  sourceEventId?: string;
  /**
   * Whether selecting this anchor performs the linked event now or only establishes
   * a prerequisite for a later choice. Optional for backward-compatible saves.
   */
  sourceAnchorRoute?: SourceAnchorRoute;
  /** Optional for backward compatibility with saves created before stakes metadata. */
  stakes?: ChoiceStakes;
}

export interface SceneScope {
  /** Concrete location occupied by the player at the end of this turn. */
  currentLocation: string;
  /** The player plus living NPCs physically present and interactable at currentLocation. */
  peoplePresent: string[];
  /** The player (spatial reference) plus present NPCs available for an immediate exchange. */
  peopleWithinSpeakingDistance: string[];
}

export interface Scene {
  /** Structured AI assessment of actual deaths established in this scene. */
  peopleKilledInScene?: string[];
  /** Derived from grounded review, never trusted from writer metadata. */
  sourceActionOutcome?: "interrupted" | "failed";
  title: string;
  text: string;
  choices: GameChoice[];
  /** Optional only so savegames created before scene scopes remain readable. */
  sceneScope?: SceneScope;
  development?: string;
  outcome?: GameStatus;
  outcomeReason?: string;
}

export type GameNoticeCode =
  | "STORY_CONTINUATION_UNAVAILABLE"
  | "EXPLICIT_PLAYER_CHOICE_REQUIRED";

export interface GameNotice {
  code: GameNoticeCode;
  message: string;
  suggestedChoice?: GameChoice;
}

export interface SourceAdvance {
  sourceChapter: {
    chapterPosition: number;
    chapterTitle: string;
  };
  anchor: string;
  cursorBefore: SourceCursor;
  cursorAfter: SourceCursor;
}

export interface StartGameResponse {
  gameId: string;
  scene: Scene;
  turnHistory: GameTurnHistoryEntry[];
  gameProfile: BookGameProfile;
  objective: string;
  victoryCondition: string;
  status: GameStatus;
  notice?: GameNotice;
  sourceAdvance?: SourceAdvance;
}

export interface MakeChoiceRequest {
  choiceId: string;
  actionText?: string;
}

export interface InitiateEventRequest {
  text: string;
}

export interface SetParameterRequest {
  text: string;
}

export interface SetParameterResponse {
  gameId: string;
  parameters: string[];
}

export interface TalkResponse {
  character: string;
  prompt: string;
  suggestions: string[];
}

export interface SavedGameSummary {
  gameId: string;
  book: BookRef;
  playerName: string;
  status: GameStatus;
  sceneTitle: string;
  objective: string;
  position?: ReadingPosition;
  conversationCharacter?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeGameResponse extends StartGameResponse {
  book: BookRef;
  playerName: string;
  activeConversation?: TalkResponse;
}

export interface DialogueRequest {
  text: string;
}

export interface ActiveConversationState {
  character: string;
  prompt?: string;
  suggestions?: string[];
  sourceEventId?: string;
}

export interface StoryMemory {
  summary: string;
  openThreads: string[];
  canonFacts: string[];
}

export type GameHistoryEntry = {
  kind:
    | "start"
    | "choice"
    | "dialogue"
    | "event"
    | "continuation"
    | "story"
    | "scene";
  text: string;
  development?: string;
  /** Scope snapshot for this particular saved turn. */
  sceneScope?: SceneScope;
};

export type GameTurnKind = "start" | "choice" | "dialogue" | "event" | "continuation";

export interface GameTurnHistoryEntry {
  storyCode?: string;
  bridgeId?: string;
  sourceEventId?: string;
  turnNumber: number;
  kind: GameTurnKind;
  action: string;
  scene: Pick<Scene, "title" | "text" | "outcome" | "outcomeReason">;
  completedAt: string;
}

export interface GameUndoSnapshot {
  narrativeMode?: "canonical" | "free";
  confirmedDeadCharacters?: string[];
  scene: Scene;
  history: GameHistoryEntry[];
  status: GameStatus;
  selectedText: string;
  position?: ReadingPosition;
  sourceCursor?: SourceCursor;
  sourceEventProgress?: SourceEventProgress;
  sourceIntroducedCharacters?: string[];
  storyMemory?: StoryMemory;
  establishedEvent?: EstablishedEvent;
  turnNumber?: number;
  turnHistoryLength?: number;
  activeConversation?: ActiveConversationState;
  activeConversationAnchorDirected?: boolean;
}

export interface GameState {
  gameRevision?: number;
  narrativeMode?: "canonical" | "free";
  returnPlanning?: import("../games/return-bridges.js").ReturnPlanning;
  /** Current scene provenance; no control codes are embedded in prose. */
  sceneTrace?: {storyCode: string; bridgeId?: string; sourceEventId?: string};
  /** Accumulated accepted AI death assessments; never inferred from prose. */
  confirmedDeadCharacters?: string[];
  /** New games pin source semantics; reindexing never remaps stored beat positions. */
  sourceIndexFingerprint?: string;
  playerActionVersion?: 2;
  gameId: string;
  /** Present for cloud saves; omitted from legacy and local save files. */
  ownerId?: string;
  book: BookRef;
  wholeBookSummary?: string;
  characterProfiles?: CharacterProfile[];
  position?: ReadingPosition;
  playerName: string;
  gameProfile: BookGameProfile;
  objective: string;
  victoryCondition: string;
  establishedEvent?: EstablishedEvent;
  status: GameStatus;
  selectedText: string;
  sourceCursor?: SourceCursor;
  sourceEventProgress?: SourceEventProgress;
  sourceIntroducedCharacters?: string[];
  parameters?: string[];
  storyMemory?: StoryMemory;
  turnNumber?: number;
  scene: Scene;
  history: GameHistoryEntry[];
  /** Durable player-facing turn log; optional for saves created before turn history. */
  turnHistory?: GameTurnHistoryEntry[];
  /** One-level rollback point captured immediately before the latest choice. */
  undoSnapshot?: GameUndoSnapshot;
  activeConversation?: ActiveConversationState;
  activeConversationAnchorDirected?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterAnchorRoute {
  character: string;
  events: Array<{eventId: string; sourceFingerprint: string; anchors: Array<{startBeatIndex: number; action: PlayerAction}>}>;
}
export interface CharacterAnchorIndex {
  version: 1;
  sourceFingerprint: string;
  playableCharacters: string[];
  routes: CharacterAnchorRoute[];
}
export interface ImportedBook {
  /** Approved routes only; partial work must never become playable. */
  characterAnchors?: CharacterAnchorIndex;
  anchorImport?: {version: 1; playableCharacters: string[]; events: Record<string, unknown>};
  /** Durable import work, not approved game data. Keyed by source part and source fingerprint. */
  importAnalysis?: {version: number; parts: Record<string, unknown>};
  bookId: string;              // KOReader-compatible partial MD5
  sourceSha256: string;        // full-file integrity/debug hash
  title: string;
  author?: string;
  chapters: Array<{
    index: number;
    title: string;
    text: string;
    summary?: string;
    sourceIndex?: ChapterSourceIndex;
  }>;
  storyEvents?: BookStoryEvent[];
  worldBible?: WorldBible;
  gameProfile?: BookGameProfile;
  importedAt: string;
}

export type BookListItem = Omit<ImportedBook, "chapters" | "importAnalysis" | "anchorImport"> & {
  chapterCount: number;
  pageCount: number;
  startingCharacters: string[];
};

export interface BookPage {
  pageNumber: number;
  pageCount: number;
  chapterPosition: number;
  chapterTitle: string;
  text: string;
}

