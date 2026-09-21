import {
  SOURCE_ANCHOR_CHOICE_ID,
} from "../../shared/contracts.js";
import type {
  BookGameProfile,
  EstablishedEvent,
  GameState,
  Scene,
  TalkResponse,
} from "../../shared/contracts.js";
import type {
  PlayerAvailability,
  GameEngine,
  GeneratedScene,
  ContinuationOptions,
  SourceContinuationCandidate,
  SourceContinuationResult,
} from "./core.js";
import {
  nextSignificantEventForCandidate,
  sourceEventRequiresExplicitPlayerChoice,
} from "./source-navigation.js";
import {
  buildSourceEventBlocks,
  groundedSourceProgress,
} from "./source.js";

export function fakeScene(
  prefix: string,
  candidate?: SourceContinuationCandidate,
  reaction = "The world reacts to your decision.",
): GeneratedScene {
  return {
    title: "BookRPG test scene",
    text: `${prefix} ${reaction} This response came from BOOKRPG_FAKE_AI, so no API call was made.`,
    choices: [
      { id: "investigate", type: "action", text: "Investigate the surroundings" },
      { id: "move_on", type: "action", text: "Move further into the scene" },
      { id: "talk_guide", type: "talk", text: "Talk to the nearby stranger", character: "the nearby stranger" },
    ],
    sceneScope: {
      currentLocation: "BookRPG test location",
      peoplePresent: ["the nearby stranger"],
      peopleWithinSpeakingDistance: ["the nearby stranger"],
    },
    outcome: "active",
    outcomeReason: "The objective is still in progress.",
    ...(candidate
      ? {
          sourceProgress: groundedSourceProgress(candidate),
        }
      : {}),
  };
}

export class FakeGameEngine implements GameEngine {
  async reviewResumeAnchor(state: GameState): Promise<import('../../shared/contracts.js').SceneScope> {
    if(!state.scene.sceneScope) throw new Error('Saved scene has no scope.');
    return state.scene.sceneScope;
  }

  async assessEstablishedDeaths(state: GameState): Promise<string[]> { return state.confirmedDeadCharacters ?? []; }
  async classifyBook(): Promise<BookGameProfile> {
    return {
      category: "adventure",
      endingMode: "completion",
      description: "Fake AI uses a completable test adventure.",
    };
  }
  async validatePlayer(): Promise<PlayerAvailability> {
    return {
      playable: true,
      reason: "Fake AI accepts every player identity.",
      objective: "Complete the BookRPG test scenario.",
      victoryCondition: "Reach the natural end of the test scenario.",
    };
  }
  async identifyEstablishedEvent(): Promise<EstablishedEvent | undefined> {
    return undefined;
  }
  async identifyLatestVisibleStoryEvent(
    _state: GameState,
    candidate: SourceContinuationCandidate,
  ): Promise<string | undefined> {
    return candidate.currentStoryEvent?.eventId;
  }
  async start(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[] = [],
  ): Promise<GeneratedScene> {
    return fakeScene(
      `${state.playerName} steps into ${state.book.title} at the selected passage.`,
      candidates[0],
    );
  }
  async continue(
    _state: GameState,
    actionText: string,
    candidates: readonly SourceContinuationCandidate[] = [],
    _options: ContinuationOptions = {},
  ): Promise<GeneratedScene> {
    return fakeScene(`You chose: ${actionText}.`, candidates[0]);
  }
  async continueScene(
    _state: GameState,
    candidates: readonly SourceContinuationCandidate[] = [],
  ): Promise<GeneratedScene> {
    return fakeScene(
      "The next moment of the established scene comes into focus without a new player action.",
      candidates[0],
      "Non-player activity and sensory detail create a new observable state.",
    );
  }
  async continueEvent(
    _state: GameState,
    eventText: string,
    candidates: readonly SourceContinuationCandidate[] = [],
  ): Promise<GeneratedScene> {
    return fakeScene(`World event: ${eventText}.`, candidates[0]);
  }
  async reviewLoss(_state: GameState, lossScene: Scene): Promise<GeneratedScene> {
    return lossScene;
  }
  async selectSourceCandidate(
    _state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationCandidate | undefined> {
    return candidates.find((candidate) =>
      !/\b(?:front matter|not story content|story has ended|the end)\b/iu.test(
        candidate.summary,
      )
    );
  }
  async selectSourceEvent(
    _state: GameState,
    candidate: SourceContinuationCandidate,
  ): Promise<SourceContinuationCandidate | undefined> {
    return buildSourceEventBlocks(candidate)[0];
  }
  async continueFromSource(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationResult | undefined> {
    const candidate = candidates.length === 1 && candidates[0]?.requiredEventId
      ? candidates[0]
      : await this.selectSourceCandidate(state, candidates);
    if (!candidate) return undefined;
    const event = nextSignificantEventForCandidate(candidate);
    if (
      sourceEventRequiresExplicitPlayerChoice(
        event,
        state.playerName,
        state.characterProfiles,
      )
    ) {
      return {
        scene: {
          ...state.scene,
          choices: [
            {
              id: `source_event_${event?.eventId ?? "action"}`,
              type: "action",
              text: event?.description ?? candidate.requiredEvent!,
              stakes: "critical",
            },
            {
              id: "decline_source_event",
              type: "action",
              text: "Choose a different immediate action",
              stakes: "significant",
            },
          ],
        },
        chapterPosition: state.sourceCursor?.chapterPosition
          ?? candidate.chapterPosition,
        nextTextOffset: state.sourceCursor?.textOffset
          ?? candidate.nextTextOffset,
        ...(state.sourceCursor?.eventId
          ? { eventId: state.sourceCursor.eventId }
          : {}),
        requiresExplicitPlayerChoice: true,
      };
    }
    return {
      scene: fakeScene(`The source story continues from ${candidate.chapterTitle}.`),
      chapterPosition: candidate.chapterPosition,
      nextTextOffset: candidate.nextTextOffset,
      ...(candidate.requiredEventId ? { eventId: candidate.requiredEventId } : {}),
    };
  }
  async refreshSceneChoices(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<Scene> {
    const nextEvent = nextSignificantEventForCandidate(candidates[0]);
    return {
      ...state.scene,
      choices: [
        {
          id: SOURCE_ANCHOR_CHOICE_ID,
          type: "action",
          text: nextEvent
            ? `Take a concrete step toward: ${nextEvent.description}`
            : "Investigate the strongest remaining story lead",
          stakes: "significant",
        },
        {
          id: "choose_another_path",
          type: "action",
          text: "Choose a different immediate path",
          stakes: "routine",
        },
      ],
    };
  }
  async startTalk(
    _state: GameState,
    character: string,
    _candidates: readonly SourceContinuationCandidate[] = [],
    _options: ContinuationOptions = {},
  ): Promise<TalkResponse> {
    return {
      character,
      prompt: `${character} turns toward you. What do you say?`,
      suggestions: ["What is happening here?", "Can I help you?", "What should I know before I continue?"],
    };
  }
  async continueDialogue(
    _state: GameState,
    character: string,
    playerText: string,
    candidates: readonly SourceContinuationCandidate[] = [],
    _options: ContinuationOptions = {},
  ): Promise<GeneratedScene> {
    return fakeScene(`You say to ${character}: “${playerText}”`, candidates[0]);
  }
}

