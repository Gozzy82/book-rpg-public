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
import { loadAiApiKey, loadDotEnv } from "../util/env.js";
import { json, readJson } from "./http.js";
import { installConsoleLogCapture, recentWebLogs } from "./logs.js";
import { serveWebAsset } from "./web.js";

loadDotEnv();
loadAiApiKey();
const port = Number(process.env.BOOKRPG_PORT || 8787);
const host = process.env.BOOKRPG_HOST?.trim() || "127.0.0.1";
const webLogsEnabled = process.env.BOOKRPG_WEB_LOGS === "1"
  || (
    process.env.BOOKRPG_WEB_LOGS !== "0"
    && ["127.0.0.1", "localhost", "::1"].includes(host)
  );

installConsoleLogCapture();

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const user = authenticatedUser(request.headers);
  await runAsUser(user, async () => {
    if (method === "GET" && url.pathname === "/api/me") {
      return json(response, 200, {
        displayName: user.displayName,
        provider: user.provider,
        migrationOwnerId: user.userId,
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
      return json(response, 201, await startGame(await readJson<StartGameRequest>(request)));
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
      return json(response, 200, await makeChoice(choiceMatch[1]!, await readJson<MakeChoiceRequest>(request)));
    }

    const undoMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/undo$/);
    if (method === "POST" && undoMatch) {
      return json(response, 200, await undoLastChoice(undoMatch[1]!));
    }

    const eventMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/events$/);
    if (method === "POST" && eventMatch) {
      return json(
        response,
        200,
        await initiateEvent(eventMatch[1]!, await readJson<InitiateEventRequest>(request)),
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
      return json(response, 200, await continueFromSource(storyMatch[1]!));
    }

    const continuationMatch = url.pathname.match(
      /^\/api\/games\/([a-zA-Z0-9_-]+)\/continue$/,
    );
    if (method === "POST" && continuationMatch) {
      return json(response, 200, await continueScene(continuationMatch[1]!));
    }

    const dialogueMatch = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)\/dialogue$/);
    if (method === "POST" && dialogueMatch) {
      return json(response, 200, await say(dialogueMatch[1]!, await readJson<DialogueRequest>(request)));
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
      return await handleApiRequest(request, response, method, url);
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return json(response, error.status, {
        error: error.message,
        code: "AUTHENTICATION_REQUIRED",
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
    console.error(error);
    return json(response, 400, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

server.listen(port, host, () => {
  const browserHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`BookRPG web app: http://${browserHost}:${port}`);
  console.log(
    `AI mode: ${process.env.BOOKRPG_FAKE_AI === "1" ? "FAKE" : configuredAiProvider()}`,
  );
});

function shutdown(signal: NodeJS.Signals): void {
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
