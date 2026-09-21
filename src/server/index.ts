import {startReturnPlanningWorker, drainReturnPlanning} from '../games/bridge-planner.js';
import {exportStoryTrace} from '../games/return-bridges.js';
import { runWithTurnBudget, TurnExecutionError } from "../ai/engine/turn-contract.js";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { countBookPages, getBookPage } from "../books/pages.js";
import { getBook, listBooks } from "../books/repository.js";
import { getGame } from "../games/repository.js";
import {
  addWorldRule,
  initiateEvent,
  continueFromSource,
  continueScene,
  startingCharacterOptions,
  listSavedGames,
  listWorldRules,
  makeChoice,
  PlayerUnavailableError,
  removeWorldRule,
  resumeGame,
  say,
  setParameter,
  startGame,
  undoLastChoice,
} from "../games/service.js";
import type {
  AddWorldRuleRequest,
} from "../games/service.js";
import type {
  DialogueRequest,
  InitiateEventRequest,
  MakeChoiceRequest,
  SetParameterRequest,
  StartGameRequest,
} from "../shared/contracts.js";
import { configuredAiProvider } from "../ai/provider.js";
import {
  AuthenticationRequiredError,
  authenticatedUser,
  runAsUser,
} from "../auth/user-context.js";
import {
  TurnLimitReachedError,
  commitMemberTurn,
  getCurrentMembership,
  releaseMemberTurn,
  reserveMemberTurn,
} from "../members/service.js";
import { loadAiApiKey, loadDotEnv } from "../util/env.js";
import { json, readJson } from "./http.js";
import { recentWebLogs, runWithLiveTurnLog } from "./logs.js";
import type { LiveTurnOperation } from "./logs.js";
import { serveWebAsset } from "./web.js";
import {
  autoAdvanceSourceContinuations,
  isStaleSourceContinuationRequest,
} from "./auto-source-continuation.js";

loadDotEnv();
loadAiApiKey();
const port = Number(process.env.BOOKRPG_PORT || 8787);
const host = process.env.BOOKRPG_HOST?.trim() || "127.0.0.1";
const webLogsEnabled = process.env.BOOKRPG_WEB_LOGS === "1"
  || (
    process.env.BOOKRPG_WEB_LOGS !== "0"
    && ["127.0.0.1", "localhost", "::1"].includes(host)
  );


async function runMeteredGameTurn<T>(
  gameId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const before = await getGame(gameId);
  if (!before) return operation();

  const completedTurnsBefore = before.turnHistory?.length ?? 0;
  const reservation = await reserveMemberTurn();
  let operationCompleted = false;
  try {
    const result = await operation();
    operationCompleted = true;
    const after = await getGame(gameId);
    const completedTurnsAfter = after?.turnHistory?.length ?? completedTurnsBefore;
    if (completedTurnsAfter > completedTurnsBefore) {
      await commitMemberTurn(reservation);
    } else {
      await releaseMemberTurn(reservation);
    }
    return result;
  } catch (error) {
    if (!operationCompleted) {
      try {
        await releaseMemberTurn(reservation);
      } catch (releaseError) {
        console.error("Could not release member turn reservation", releaseError);
      }
    }
    throw error;
  }
}

async function runMeteredLoggedGameTurn<T>(
  gameId: string,
  logOperation: LiveTurnOperation,
  operation: () => Promise<T>,
): Promise<T> {
  return await runWithLiveTurnLog(
    logOperation,
    () => runMeteredGameTurn(gameId, operation),
  );
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const user = authenticatedUser(request.headers);
  response.once('finish', () => { void drainReturnPlanning(); });
  await runAsUser(user, async () => {
    const traceMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/story-trace$/);
    if (method === 'GET' && traceMatch) {
      const game = await getGame(traceMatch[1]!);
      if (!game) return json(response, 404, {error: 'Game not found'});
      const book = await getBook(game.book.bookId);
      if (!book) return json(response, 404, {error: 'Book not found'});
      response.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${game.gameId}-story-trace.txt"`});
      response.end(exportStoryTrace(game, book));
      return;
    }
    if (method === "GET" && url.pathname === "/api/me") {
      return json(response, 200, {
        displayName: user.displayName,
        provider: user.provider,
        ...(user.email ? { email: user.email } : {}),
        migrationOwnerId: user.userId,
        membership: await getCurrentMembership(),
      });
    }

    if (method === "GET" && url.pathname === "/api/logs") {
      if (!webLogsEnabled) return json(response, 404, { error: "Not found" });
      return json(response, 200, recentWebLogs(Number(url.searchParams.get("limit") || 80)));
    }

    if (method === "GET" && url.pathname === "/api/books") {
      const books = (await listBooks()).map((book) => ({
        bookId: book.bookId,
        title: book.title,
        author: book.author,
        chapterCount: book.chapters.length,
        pageCount: countBookPages(book),
        startingCharacters: startingCharacterOptions(book),
        gameProfile: book.gameProfile,
      }));
      return json(response, 200, books);
    }

    const chapterMatch = url.pathname.match(/^\/api\/books\/([a-zA-Z0-9_-]+)\/chapters\/(\d+)$/);
    if (method === "GET" && chapterMatch) {
      const [, bookId, indexText] = chapterMatch;
      const book = await getBook(bookId!);
      if (!book) return json(response, 404, { error: "Book not found" });
      const chapter = book.chapters[Number(indexText)];
      if (!chapter) return json(response, 404, { error: "Chapter not found" });
      return json(response, 200, chapter);
    }

    const pageMatch = url.pathname.match(/^\/api\/books\/([a-zA-Z0-9_-]+)\/pages\/(\d+)$/);
    if (method === "GET" && pageMatch) {
      const [, bookId, pageNumberText] = pageMatch;
      const book = await getBook(bookId!);
      if (!book) return json(response, 404, { error: "Book not found" });
      const page = getBookPage(book, Number(pageNumberText));
      if (!page) {
        const pageCount = countBookPages(book);
        return json(response, 404, {
          error: `Page not found. Choose a page from 1 to ${pageCount}.`,
        });
      }
      return json(response, 200, page);
    }

    if (method === "GET" && url.pathname === "/api/games") {
      return json(response, 200, await listSavedGames());
    }

    if (method === "POST" && url.pathname === "/api/games") {
      const startRequest = await readJson<StartGameRequest>(request);
      const result = await runWithLiveTurnLog("start", async () => (
        await autoAdvanceSourceContinuations(await startGame(startRequest))
      ));
      return json(response, 201, result);
    }

    const resumeMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/resume$/);
    if (method === "POST" && resumeMatch) {
      return json(response, 200, await resumeGame(resumeMatch[1]!));
    }

    const gameMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)$/);
    if (method === "GET" && gameMatch) {
      const game = await getGame(gameMatch[1]!);
      if (!game) return json(response, 404, { error: "Game not found" });
      const {
        ownerId: _ownerId,
        parameters: _legacyWorldRuleParameters,
        ...publicGame
      } = game;
      return json(response, 200, publicGame);
    }

    const choiceMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/choices$/);
    if (method === "POST" && choiceMatch) {
      const gameId = choiceMatch[1]!;
      const choiceRequest = await readJson<MakeChoiceRequest>(request);
      const result = await runMeteredLoggedGameTurn(gameId, "choice", async () => {
        const currentGame = await getGame(gameId);
        if (
          currentGame
          && isStaleSourceContinuationRequest(
            choiceRequest.choiceId,
            currentGame.scene.choices,
          )
        ) {
          return await autoAdvanceSourceContinuations(await resumeGame(gameId));
        }
        return await autoAdvanceSourceContinuations(
          await makeChoice(gameId, choiceRequest),
        );
      });
      return json(response, 200, result);
    }

    const undoMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/undo$/);
    if (method === "POST" && undoMatch) {
      return json(response, 200, await undoLastChoice(undoMatch[1]!));
    }

    const eventMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/events$/);
    if (method === "POST" && eventMatch) {
      const gameId = eventMatch[1]!;
      const eventRequest = await readJson<InitiateEventRequest>(request);
      return json(
        response,
        200,
        await runMeteredLoggedGameTurn(
          gameId,
          "event",
          () => initiateEvent(gameId, eventRequest),
        ),
      );
    }

    // Legacy endpoint kept for existing CLI clients. New code uses /world-rules.
    const parameterMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/parameters$/);
    if (method === "POST" && parameterMatch) {
      return json(
        response,
        200,
        await setParameter(
          parameterMatch[1]!,
          await readJson<SetParameterRequest>(request),
        ),
      );
    }

    const worldRulesMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/world-rules$/);
    if (worldRulesMatch && method === "GET") {
      return json(response, 200, await listWorldRules(worldRulesMatch[1]!));
    }
    if (worldRulesMatch && method === "POST") {
      return json(
        response,
        200,
        await addWorldRule(
          worldRulesMatch[1]!,
          await readJson<AddWorldRuleRequest>(request),
        ),
      );
    }

    const worldRuleDeleteMatch = url.pathname.match(
      /^\/api\/games\/([a-zA-Z0-9_-]+)\/world-rules\/(\d+)$/,
    );
    if (worldRuleDeleteMatch && method === "DELETE") {
      return json(
        response,
        200,
        await removeWorldRule(
          worldRuleDeleteMatch[1]!,
          Number(worldRuleDeleteMatch[2]),
        ),
      );
    }

    const storyMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/story$/);
    if (method === "POST" && storyMatch) {
      const gameId = storyMatch[1]!;
      const result = await runMeteredLoggedGameTurn(gameId, "story", async () => (
        await autoAdvanceSourceContinuations(await continueFromSource(gameId))
      ));
      return json(response, 200, result);
    }

    const continuationMatch = url.pathname.match(
      /^\/api\/games\/([a-zA-Z0-9_-]+)\/continue$/,
    );
    if (method === "POST" && continuationMatch) {
      const gameId = continuationMatch[1]!;
      const result = await runMeteredLoggedGameTurn(gameId, "continue", async () => (
        await autoAdvanceSourceContinuations(await continueScene(gameId))
      ));
      return json(response, 200, result);
    }

    const dialogueMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/dialogue$/);
    if (method === "POST" && dialogueMatch) {
      const gameId = dialogueMatch[1]!;
      const dialogueRequest = await readJson<DialogueRequest>(request);
      return json(
        response,
        200,
        await runMeteredLoggedGameTurn(
          gameId,
          "dialogue",
          () => say(gameId, dialogueRequest),
        ),
      );
    }
    return json(response, 404, { error: "Not found" });
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, fakeAi: process.env.BOOKRPG_FAKE_AI === "1" });
    }

    if (await serveWebAsset(method, url.pathname, response)) return;
    if (url.pathname.startsWith("/api/")) {
      return await runWithTurnBudget(() => handleApiRequest(request, response, method, url));
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return json(response, error.status, {
        error: error.message,
        code: "AUTHENTICATION_REQUIRED",
      });
    }
    if (error instanceof TurnLimitReachedError) {
      return json(response, error.status, {
        error: error.message,
        code: error.code,
        membership: error.membership,
      });
    }
    if (error instanceof PlayerUnavailableError) {
      return json(response, 409, {
        error: error.message,
        code: error.code,
        playerName: error.playerName,
        reason: error.reason,
      });
    }
    if (error instanceof TurnExecutionError) {
      return json(response, 503, { error: error.message, code: error.code });
    }
    console.error(error);
    return json(response, 400, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

const stopReturnPlanningWorker = startReturnPlanningWorker();
server.listen(port, host, () => {
  const browserHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`BookRPG web app: http://${browserHost}:${port}`);
  console.log(
    `AI mode: ${process.env.BOOKRPG_FAKE_AI === "1" ? "FAKE" : configuredAiProvider()}`,
  );
});

function shutdown(signal: NodeJS.Signals): void {
  stopReturnPlanningWorker();
  console.log(`Received ${signal}; closing BookRPG server`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));