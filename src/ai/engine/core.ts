import type {
  BookGameProfile,
  BookStoryEvent,
  ChoiceStakes,
  EstablishedEvent,
  GameState,
  ImportedBook,
  Scene,
  SourceAnchorRoute,
  SourceCursor,
  SourceEventProgress,
  StoryEventBeat,
  StoryMemory,
  TalkResponse,
} from "../../shared/contracts.js";

export interface PlayerAvailability {
  playable: boolean;
  reason: string;
  objective: string;
  victoryCondition: string;
}

export class InvalidAiJsonError extends Error {
  constructor(label: string, cause: SyntaxError) {
    super(`${label} returned incomplete or invalid JSON: ${cause.message}`, { cause });
    this.name = "InvalidAiJsonError";
  }
}

export class SceneGenerationError extends Error {
  constructor(
    readonly validationFailures: readonly string[],
    readonly attempts: number,
  ) {
    const reason = validationFailures.length > 0
      ? ` Last rejection: ${validationFailures.join(" ")}`
      : "";
    super(
      `The game could not continue from that input after ${attempts} generation attempts. `
      + "The generated scenes could not satisfy the game's continuity and choice requirements."
      + reason
      + " The turn was not saved; try another choice or rephrase the custom input.",
    );
    this.name = "SceneGenerationError";
  }
}

export function parseAiJson<T>(output: string, label: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new InvalidAiJsonError(label, error);
    }
    throw error;
  }
}

export interface GameEngine {
  classifyBook(book: ImportedBook): Promise<BookGameProfile>;
  validatePlayer(state: GameState, book: ImportedBook): Promise<PlayerAvailability>;
  identifyEstablishedEvent(
    state: GameState,
    book: ImportedBook,
  ): Promise<EstablishedEvent | undefined>;
  identifyLatestVisibleStoryEvent(
    state: GameState,
    candidate: SourceContinuationCandidate,
  ): Promise<string | undefined>;
  start(
    state: GameState,
    candidates?: readonly SourceContinuationCandidate[],
  ): Promise<GeneratedScene>;
  continue(
    state: GameState,
    actionText: string,
    candidates?: readonly SourceContinuationCandidate[],
    options?: ContinuationOptions,
  ): Promise<GeneratedScene>;
  continueScene(
    state: GameState,
    candidates?: readonly SourceContinuationCandidate[],
  ): Promise<GeneratedScene>;
  continueEvent(
    state: GameState,
    eventText: string,
    candidates?: readonly SourceContinuationCandidate[],
  ): Promise<GeneratedScene>;
  reviewLoss(state: GameState, lossScene: Scene): Promise<GeneratedScene>;
  selectSourceCandidate(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationCandidate | undefined>;
  selectSourceEvent(
    state: GameState,
    candidate: SourceContinuationCandidate,
  ): Promise<SourceContinuationCandidate | undefined>;
  continueFromSource(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationResult | undefined>;
  refreshSceneChoices(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<Scene>;
  startTalk(
    state: GameState,
    character: string,
    candidates?: readonly SourceContinuationCandidate[],
    options?: ContinuationOptions,
  ): Promise<TalkResponse>;
  continueDialogue(
    state: GameState,
    character: string,
    playerText: string,
    candidates?: readonly SourceContinuationCandidate[],
    options?: ContinuationOptions,
  ): Promise<GeneratedScene>;
}

export interface GeneratedScene extends Scene {
  sourceProgress?: SourceCursor;
  sourceEventProgress?: SourceEventProgress | null;
  storyMemory?: StoryMemory;
}

export interface ContinuationOptions {
  anchorDirected?: boolean;
  choiceStakes?: ChoiceStakes;
  sourceEventId?: string;
  sourceAnchorRoute?: SourceAnchorRoute;
}

export interface SourceContinuationCandidate {
  chapterPosition: number;
  chapterTitle: string;
  summary: string;
  chapterSummary?: string;
  storySoFar?: Array<{
    chapterPosition: number;
    chapterTitle: string;
    summary: string;
  }>;
  excerpt: string;
  requiredEvent?: string;
  requiredEventId?: string;
  requiredEventCategory?: BookStoryEvent["category"];
  requiredEventActors?: string[];
  requiredEventTargets?: string[];
  requiredEventBeats?: StoryEventBeat[];
  /** Exact source text keyed by chapter/index/line range for beat grounding. */
  sourceReferenceExcerpts?: Readonly<Record<string, string>>;
  storyEvents?: Array<
    Pick<BookStoryEvent, "eventId" | "sequence" | "description" | "chapterPosition">
    & Partial<Pick<BookStoryEvent, "category" | "actors" | "targets" | "beats">>
  >;
  /** The event already reached in player-facing narrative, never a lookahead event. */
  currentStoryEvent?: Pick<
    BookStoryEvent,
    "eventId" | "sequence" | "description" | "chapterPosition"
  > & Partial<Pick<BookStoryEvent, "category" | "actors" | "targets" | "beats">>;
  unavailableCharacters?: string[];
  surroundingContext?: string;
  nextTextOffset: number;
  recovery?: boolean;
}

export interface SourceContinuationResult {
  scene: GeneratedScene;
  chapterPosition: number;
  nextTextOffset: number;
  eventId?: string;
  requiresExplicitPlayerChoice?: boolean;
}

export interface SourceEventSelection {
  compatible: boolean;
  blockIndex: number | null;
  eventId: string | null;
  event: string;
  reason: string;
}

export const SOURCE_EVENT_BLOCK_CHARS = 1_500;
export const SOURCE_EVENT_BLOCK_OVERLAP_CHARS = 200;
export const SOURCE_EVENT_MAX_LOOKAHEAD_BLOCKS = 5;
