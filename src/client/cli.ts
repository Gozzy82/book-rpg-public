import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  FREE_ACTION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
} from "../shared/contracts.js";
import type {
  BookListItem,
  BookGameProfile,
  GameChoice,
  GameTurnHistoryEntry,
  ResumeGameResponse,
  SavedGameSummary,
  Scene,
  SetParameterResponse,
  SourceAdvance,
  StartGameResponse,
  TalkResponse,
} from "../shared/contracts.js";
import { loadDotEnv } from "../util/env.js";
import {
  MAX_SCENE_CONTINUATION_BATCH,
  parseChoiceInput,
} from "./choice-input.js";
import {
  resolvePlayerSelection,
} from "./player-selection.js";

loadDotEnv();
const base = `http://127.0.0.1:${process.env.BOOKRPG_PORT || 8787}`;
const rl = readline.createInterface({ input, output });

class QuitRequested extends Error {}

let rejectQuit: (reason: QuitRequested) => void;
const quitRequested = new Promise<never>((_, reject) => {
  rejectQuit = reject;
});

rl.on("SIGINT", () => rejectQuit(new QuitRequested()));

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function outdatedServerError(feature?: string): Error {
  return new Error(
    `The running BookRPG server is outdated${feature ? ` and does not support ${feature}` : ""}. `
    + 'Stop it with Ctrl+C, restart it with "npm run dev", and then run the client again.',
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json() as { error?: unknown; code?: unknown };
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : response.statusText;
    const code = typeof body.code === "string" ? body.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return body as T;
}

function showSceneNarrative(scene: Scene): void {
  console.log(`\n=== ${scene.title} ===\n`);
  console.log(scene.text, "\n");
}

function showSceneChoices(scene: Scene): void {
  scene.choices.forEach((choice, index) => {
    const text = choice.type === "talk" && choice.character
      ? `Talk to ${choice.character}`
      : choice.text;
    console.log(`${index + 1}. ${text}${choice.type === "talk" ? " [talk]" : ""}`);
  });
}

function showScene(scene: Scene): void {
  showSceneNarrative(scene);
  showSceneChoices(scene);
}

function showTurnHistory(turnHistory: readonly GameTurnHistoryEntry[]): void {
  if (turnHistory.length === 0) {
    console.log("\nNo turns have been completed yet.");
    return;
  }
  console.log("\n=== TURN HISTORY ===");
  for (const turn of turnHistory) {
    console.log(`\nTurn ${turn.turnNumber} [${turn.kind}]`);
    console.log(`Your step: ${turn.action}`);
    console.log(`${turn.scene.title}\n${turn.scene.text}`);
  }
}

function showSourceAdvance(sourceAdvance: SourceAdvance): void {
  const sourceChapter = sourceAdvance.sourceChapter;
  const before = sourceAdvance.cursorBefore;
  const after = sourceAdvance.cursorAfter;
  console.log("\nCanonical source progression:");
  console.log(
    `Source chapter: ${sourceChapter.chapterPosition + 1} (${sourceChapter.chapterTitle})`,
  );
  console.log(`Adapted anchor: ${sourceAdvance.anchor}`);
  console.log(
    `Source cursor: ${before.chapterPosition + 1}:${before.textOffset}`
      + ` -> ${after.chapterPosition + 1}:${after.textOffset}`,
  );
}

type CliSelection =
  | GameChoice
  | { id: typeof SOURCE_CONTINUATION_CHOICE_ID; type: "story" }
  | { type: "continue"; count: number }
  | { type: "history" }
  | { type: "undo" }
  | { type: "event"; text: string }
  | { type: "param"; text: string };

async function choose(choices: GameChoice[]): Promise<CliSelection> {
  while (true) {
    const raw = await rl.question("\nChoice (u = undo, h = turn history): ");
    if (/^(?:u|undo)$/iu.test(raw.trim())) return { type: "undo" };
    const parsed = parseChoiceInput(raw, choices.length);
    if (parsed.kind === "history") return { type: "history" };
    if (parsed.kind === "continue") {
      return { type: "continue", count: parsed.count };
    }
    if (parsed.kind === "story") {
      return {
        id: SOURCE_CONTINUATION_CHOICE_ID,
        type: "story",
      };
    }
    if (parsed.kind === "custom") {
      while (true) {
        const customType = (
          await askRequired("Custom action, event, or param: ")
        ).toLocaleLowerCase();
        if (customType === "action") {
          return {
            id: FREE_ACTION_CHOICE_ID,
            type: "action",
            text: await askRequired("Action: "),
          };
        }
        if (customType === "event") {
          return {
            type: "event",
            text: await askRequired("World event: "),
          };
        }
        if (customType === "param") {
          return {
            type: "param",
            text: await askRequired("Parameter: "),
          };
        }
        console.log("Enter action, event, or param.");
      }
    }
    if (parsed.kind === "choice") {
      const choice = choices[parsed.index]!;
      return choice.id === SOURCE_CONTINUATION_CHOICE_ID
        ? { id: SOURCE_CONTINUATION_CHOICE_ID, type: "story" }
        : choice;
    }
    console.log(
      parsed.message
        ?? "Choose a displayed number, repeat c, or use cxN to watch the scene unfold.",
    );
  }
}

async function askRequired(question: string): Promise<string> {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (answer) return answer;
    console.log("Please enter a value.");
  }
}

async function choosePlayerIdentity(characters: string[]): Promise<string> {
  if (characters.length === 0) {
    throw new Error("No playable characters are available for this book.");
  }

  console.log("Who do you want to play as?");
  characters.forEach((character, index) => console.log(`${index + 1}. ${character}`));

  while (true) {
    const selectedCharacter = resolvePlayerSelection(
      await rl.question("Play as (number): "),
      characters,
    );
    if (selectedCharacter !== undefined) return selectedCharacter;
    console.log("Choose one of the displayed numbers.");
  }
}

interface CliGame {
  gameId: string;
  bookTitle: string;
  playerName: string;
  gameProfile: BookGameProfile;
  scene: Scene;
  objective: string;
  victoryCondition: string;
  turnHistory: GameTurnHistoryEntry[];
  activeConversation?: TalkResponse;
}

function savedGameLabel(game: SavedGameSummary): string {
  const location = game.position?.chapterTitle || game.sceneTitle;
  const conversation = game.conversationCharacter
    ? `, talking to ${game.conversationCharacter}`
    : "";
  return `${game.book.title} as ${game.playerName} - ${location}${conversation} - ${new Date(game.updatedAt).toLocaleString()}`;
}

async function chooseSavedGame(games: SavedGameSummary[]): Promise<SavedGameSummary | undefined> {
  if (games.length === 0) return undefined;

  console.log("Active saved games:");
  games.forEach((game, index) => console.log(`${index + 1}. Continue ${savedGameLabel(game)}`));
  console.log(`${games.length + 1}. Start a new game`);

  while (true) {
    const index = Number(await rl.question("Game: ")) - 1;
    if (Number.isInteger(index) && index >= 0 && index < games.length) return games[index];
    if (index === games.length) return undefined;
    console.log("Choose one of the displayed numbers.");
  }
}

async function startNewGame(): Promise<CliGame> {
  const books = await request<BookListItem[]>("/api/books");
  if (books.length === 0) throw new Error("No books imported. Run: npm run import -- path/to/book.epub");

  console.log("\nImported books:");
  books.forEach((book, index) => console.log(
    `${index + 1}. ${book.title} — ${book.author || "unknown author"}`,
  ));
  const bookIndex = Number(await rl.question("Book: ")) - 1;
  const book = books[bookIndex];
  if (!book) throw new Error("Invalid book choice");

  let characters = book.startingCharacters;
  let playerName = "";
  let start: StartGameResponse | undefined;
  while (!start) {
    playerName = await choosePlayerIdentity(characters);
    try {
      start = await request<StartGameResponse>("/api/games", {
        method: "POST",
        body: JSON.stringify({
          book: { bookId: book.bookId, title: book.title, author: book.author },
          playerName,
        }),
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "PLAYER_UNAVAILABLE") {
        throw error;
      }

      console.log(`\n${error.message}`);
      characters = characters.filter(
        (character: string) => character.toLocaleLowerCase() !== playerName.toLocaleLowerCase(),
      );
      console.log("Choose another character for the beginning of this story.\n");
    }
  }

  return {
    gameId: start.gameId,
    bookTitle: book.title,
    playerName,
    gameProfile: start.gameProfile,
    scene: start.scene,
    objective: start.objective,
    victoryCondition: start.victoryCondition,
    turnHistory: start.turnHistory ?? [],
  };
}

async function selectGame(): Promise<CliGame> {
  let savedGames: SavedGameSummary[];
  try {
    savedGames = await request<SavedGameSummary[]>("/api/games");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw outdatedServerError();
    }
    throw error;
  }

  const activeGames = savedGames.filter((game) => game.status === "active");
  const savedGame = await chooseSavedGame(activeGames);
  if (!savedGame) return await startNewGame();

  const resumed = await request<ResumeGameResponse>(`/api/games/${savedGame.gameId}/resume`, {
    method: "POST",
  });
  console.log(`\nResuming ${resumed.book.title} as ${resumed.playerName}.`);
  return {
    gameId: resumed.gameId,
    bookTitle: resumed.book.title,
    playerName: resumed.playerName,
    gameProfile: resumed.gameProfile,
    scene: resumed.scene,
    objective: resumed.objective,
    victoryCondition: resumed.victoryCondition,
    turnHistory: resumed.turnHistory ?? [],
    activeConversation: resumed.activeConversation,
  };
}

async function continueConversation(
  gameId: string,
  playerName: string,
  conversation: TalkResponse,
  turnHistory: readonly GameTurnHistoryEntry[],
): Promise<{ response: StartGameResponse; undone: boolean }> {
  console.log(`\nPlaying as: ${playerName}`);
  console.log(`Talking to: ${conversation.character}`);
  console.log(`${conversation.prompt}\n`);
  conversation.suggestions.forEach((text, index) => console.log(`${index + 1}. ${text}`));
  const customReplyNumber = conversation.suggestions.length + 1;
  console.log(`${customReplyNumber}. Type your own reply`);
  console.log("u. Undo this choice and return to the previous scene");
  let talkChoice: string;
  while (true) {
    talkChoice = (await rl.question("\nSay (h = turn history): ")).trim();
    if (/^(?:h|history)$/iu.test(talkChoice)) {
      showTurnHistory(turnHistory);
      continue;
    }
    break;
  }
  if (/^(?:u|undo)$/iu.test(talkChoice)) {
    const undone = await request<StartGameResponse>(`/api/games/${gameId}/undo`, {
      method: "POST",
    });
    return { response: undone, undone: true };
  }
  const suggestionIndex = Number(talkChoice) - 1;
  let text: string;
  if (suggestionIndex >= 0 && suggestionIndex < conversation.suggestions.length) {
    text = conversation.suggestions[suggestionIndex]!;
  } else if (talkChoice === String(customReplyNumber)) {
    text = await askRequired("Your reply: ");
  } else {
    text = talkChoice || await askRequired("Your reply: ");
  }

  console.log(`\n${playerName} to ${conversation.character}: "${text}"`);
  console.log(`Waiting for ${conversation.character}'s response...\n`);
  const next = await request<StartGameResponse>(`/api/games/${gameId}/dialogue`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  return { response: next, undone: false };
}

async function play(game: CliGame): Promise<void> {
  let { gameId, scene, turnHistory, activeConversation } = game;
  let narratedScene: Scene | undefined;
  console.log(`\nBook: ${game.bookTitle}`);
  console.log(`Game type: ${game.gameProfile.category} (${game.gameProfile.endingMode})`);
  console.log(`Objective: ${game.objective}`);
  console.log(`End condition: ${game.victoryCondition}`);
  console.log("Progress is saved automatically after every completed turn.");

  while (true) {
    if (activeConversation) {
      try {
        const conversationResult = await continueConversation(
          gameId,
          game.playerName,
          activeConversation,
          turnHistory,
        );
        scene = conversationResult.response.scene;
        turnHistory = conversationResult.response.turnHistory ?? [];
        activeConversation = undefined;
        if (conversationResult.undone) narratedScene = undefined;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        console.error(`\nCould not complete that dialogue turn: ${error.message}`);
        console.log("The conversation is still active. Try another reply, or press Ctrl+C to leave.");
      }
      continue;
    }

    if (scene === narratedScene) {
      showSceneChoices(scene);
    } else {
      showScene(scene);
      narratedScene = scene;
    }
    if (scene.outcome === "won" || scene.outcome === "completed" || scene.outcome === "lost") {
      const heading = scene.outcome === "won"
        ? "YOU WON"
        : scene.outcome === "completed"
          ? "JOURNEY COMPLETE"
          : "GAME OVER";
      console.log(`\n=== ${heading} ===`);
      console.log(scene.outcomeReason || "The game has ended.");
      break;
    }
    const selected = await choose(scene.choices);
    if (selected.type === "history") {
      showTurnHistory(turnHistory);
      continue;
    }
    if (selected.type === "undo") {
      try {
        const undone = await request<StartGameResponse>(`/api/games/${gameId}/undo`, {
          method: "POST",
        });
        gameId = undone.gameId;
        scene = undone.scene;
        turnHistory = undone.turnHistory ?? [];
        activeConversation = undefined;
        narratedScene = undefined;
        console.log("\nLast choice undone. Choose again.");
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        console.error(`\nCould not undo: ${error.message}`);
      }
      continue;
    }
    if (selected.type === "param") {
      const result = await request<SetParameterResponse>(
        `/api/games/${gameId}/parameters`,
        {
          method: "POST",
          body: JSON.stringify({ text: selected.text }),
        },
      );
      console.log(
        `\nParameter saved (${result.parameters.length}/20). `
          + "It will lead future character and world behavior; newer conflicts win.",
      );
      continue;
    }
    if (selected.type === "continue") {
      console.log(
        selected.count === 1
          ? "\nChoosing option 1 to continue the story..."
          : `\nContinuing the story through up to ${selected.count} automatic option-1 choices...`,
      );
      for (let index = 0; index < selected.count; index += 1) {
        let next: StartGameResponse | TalkResponse;
        try {
          next = await request<StartGameResponse | TalkResponse>(
            `/api/games/${gameId}/continue`,
            { method: "POST" },
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            throw outdatedServerError("automatic story continuation");
          }
          if (!(error instanceof ApiError)) throw error;
          console.error(`\nCould not continue the story: ${error.message}`);
          console.log(
            "The current scene is unchanged. Choose an available option, try c again, "
              + "or press Ctrl+C to leave.",
          );
          break;
        }
        if ("suggestions" in next) {
          activeConversation = next;
          break;
        }
        if (next.notice) {
          console.log(`\n${next.notice.message}`);
          const suggestedChoice = next.notice.suggestedChoice;
          if (suggestedChoice) {
            const choiceNumber = scene.choices.findIndex(
              (choice) => choice.id === suggestedChoice.id,
            ) + 1;
            const label = choiceNumber > 0 ? `Choose ${choiceNumber}` : "Try";
            console.log(`Tip: ${label}. ${suggestedChoice.text}`);
          }
          break;
        }
        gameId = next.gameId;
        scene = next.scene;
        turnHistory = next.turnHistory ?? [];
        const terminal = scene.outcome === "won"
          || scene.outcome === "completed"
          || scene.outcome === "lost";
        if (terminal || index === selected.count - 1) break;
        showSceneNarrative(scene);
        narratedScene = scene;
      }
      continue;
    }
    if (selected.type === "story") {
      console.log("\nContinuing to the direct next canonical story event...");
    }
    let result: StartGameResponse | TalkResponse;
    try {
      result = selected.type === "event"
        ? await request<StartGameResponse>(`/api/games/${gameId}/events`, {
            method: "POST",
            body: JSON.stringify({ text: selected.text }),
          })
        : selected.type === "story"
          ? await request<StartGameResponse>(`/api/games/${gameId}/story`, {
              method: "POST",
            })
          : await request<StartGameResponse | TalkResponse>(`/api/games/${gameId}/choices`, {
              method: "POST",
              body: JSON.stringify({
                choiceId: selected.id,
                ...(selected.id === FREE_ACTION_CHOICE_ID ? { actionText: selected.text } : {}),
              }),
            });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      console.error(`\nCould not complete that turn: ${error.message}`);
      console.log(
        "The current scene is unchanged. Try another choice, rephrase a custom input, "
          + "or press Ctrl+C to leave.",
      );
      continue;
    }

    if ("suggestions" in result) {
      activeConversation = result;
    } else {
      gameId = result.gameId;
      scene = result.scene;
      turnHistory = result.turnHistory ?? [];
      if (result.notice) {
        console.log(`\n${result.notice.message}`);
        const suggestedChoice = result.notice.suggestedChoice;
        if (suggestedChoice) {
          const choiceNumber = scene.choices.findIndex(
            (choice) => choice.id === suggestedChoice.id,
          ) + 1;
          const label = choiceNumber > 0 ? `Choose ${choiceNumber}` : "Try";
          console.log(`Tip: ${label}. ${suggestedChoice.text}`);
        }
      }
      if (result.sourceAdvance) showSourceAdvance(result.sourceAdvance);
    }
  }
}

async function run(): Promise<void> {
  console.log("Press Ctrl+C to leave; completed turns can be resumed later.");
  const game = await selectGame();
  await play(game);
}

Promise.race([run(), quitRequested]).catch((error) => {
  if (error instanceof QuitRequested) {
    console.log("\nGoodbye! Your latest completed turn is saved.");
    return;
  }
  console.error(`\nBookRPG client error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}).finally(() => rl.close());
