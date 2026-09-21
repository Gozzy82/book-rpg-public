# BookRPG

An experimental TypeScript application that turns EPUB books into interactive stories. Players choose a character and take actions while the engine tracks story progression and game state.

The project explores how generated scenes can stay consistent with the book without making decisions for the player.

[Case study](https://gerko.amsterdam/book-rpg/) · [Portfolio](https://gerko.amsterdam/) · [LinkedIn](https://nl.linkedin.com/in/gerko-schrieken-b1853246)

This repository is a **sanitized public source snapshot** of the implementation. It is exported from the private development repository with fresh Git history and excludes local data, logs, credentials and other operational artifacts.

**Status:** experimental source snapshot. This published snapshot builds successfully and its deterministic test suite is green; see [Validation of this snapshot](#validation-of-this-snapshot).

## Why I started

I started BookRPG after jailbreaking my e-reader. I wanted to try an interactive story on it while keeping the client as small as possible.

That led to a client/server split: the client displays scenes, collects choices and sends requests over HTTP/JSON. Book import and indexing, AI calls, story progression and saved games stay on the server. A future device client should use that API rather than reimplement the story engine in Lua.

The current clients are a browser interface and a Node.js terminal client. The terminal client exercises the API without a browser; a KOReader/Lua client is still a future step. This is a thin-client architecture in terms of responsibilities, not a claim that the current web interface is optimised or tested for an e-reader. New AI-generated turns require a connection to the server.

## Main components

- EPUB ingestion and indexing into reusable story context;
- source-grounded significant events and beat progression;
- player-aware scene generation and choice construction;
- narrative continuity and character-presence tracking;
- structured AI generation and review steps;
- support for multiple AI providers behind one engine boundary;
- local and Azure-backed storage modes;
- Docker and Azure infrastructure-as-code deployment;
- unit/regression tests and Playwright endurance testing.

## High-level flow

```text
EPUB
  │
  ▼
Book analysis / source index
  │
  ├── characters
  ├── source material
  └── significant events + beats
             │
             ▼
        Game state engine
             │
      current required beat
             │
             ▼
       AI scene generation
             │
       validation / review
             │
             ▼
      player choice + turn
```

The implementation deliberately separates **what the source says should happen** from **what the player is allowed to do now**. The game state advances through source-grounded beats while still allowing generated prose and player choices to vary.

## Where to start

For a code review, start with [`src/books/`](src/books/) for book import and indexing, [`src/ai/`](src/ai/) for generation and review, and [`src/games/`](src/games/) for game state and persistence.

For the client/server boundary, compare [`src/client/cli.ts`](src/client/cli.ts), [`src/server/index.ts`](src/server/index.ts) and [`src/shared/contracts.ts`](src/shared/contracts.ts).

## Project structure

```text
src/                         application source
  ai/                        generation, review and prompt orchestration
  books/                     EPUB import, indexing and book storage
  games/                     game state and persistence
  server/                    HTTP/web application
  auth/                      authentication boundary
  azure/                     Azure integration
  shared/                    shared contracts and utilities
public/                      web client assets
test/                        unit and regression tests
e2e/bookrpg-playwright/      automated multi-turn browser testing
infra/                       Azure infrastructure source
Dockerfile                   container build
azure.yaml                   Azure Developer CLI configuration
```

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

The example configuration defaults to fake AI, so the application can be exercised without an external AI API call:

```env
BOOKRPG_FAKE_AI=1
```

To use a real provider, configure the relevant API key locally. Never commit credentials.

## Useful commands

```bash
npm run dev
npm run import -- path/to/book.epub
npm run build
npm test
```

The Playwright endurance runner lives under `e2e/bookrpg-playwright/` and is intentionally kept separate from generated run results.

## Storage and deployment

The application supports local development storage and Azure-backed operation. The Azure path uses Blob Storage for book artifacts and Cosmos DB for game state, with managed identity support in the deployment configuration.

Infrastructure source is included under `infra/`, together with the container and `azure.yaml` configuration used to describe the deployment shape.

## Public snapshot safety

The public export intentionally excludes, among other things:

- `data/` and imported book/game data;
- AI request/response logs and game logs;
- generated Playwright results, traces and screenshots;
- `.env` and local credential files;
- build output and dependency folders;
- private Git history.

The export command also scans the generated snapshot for common credential patterns before it can be published.

This does **not** make arbitrary Git history safe to expose. Publish only the generated snapshot to a new repository with fresh history.

## Copyright note

BookRPG processes books supplied by the operator. This public source snapshot does not intentionally include copyrighted book files or extracted book datasets. Use source material only when you have the rights to do so.

## Validation of this snapshot

This exported snapshot was validated on September 21, 2026 using Node.js 24.20.0 on Ubuntu:

- `npm ci --ignore-scripts --no-audit --no-fund`: passed;
- `npm run build`: passed;
- `npm test`: **1,120 passed, 0 failed, 0 skipped**.

The same 1,120-test suite also passed in the private development tree before export. The export's credential-pattern scan completed successfully, and the published tree was checked to exclude private data, repair directories, logs and Git history.

These deterministic results do not prove that every live AI-generated story behaves correctly. Live-model evaluations and real e-reader testing are separate concerns.
