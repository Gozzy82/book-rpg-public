# BookRPG

An experimental TypeScript application that turns EPUB books into interactive stories. Players choose a character and take actions while the engine tracks story progression and game state.

The project explores how generated scenes can stay consistent with the book without making decisions for the player.

[Case study](https://gerko.amsterdam/book-rpg/) · [Portfolio](https://gerko.amsterdam/) · [LinkedIn](https://nl.linkedin.com/in/gerko-schrieken-b1853246)

This repository is a **sanitized public source snapshot** of the implementation. It is exported from the private development repository with fresh Git history and excludes local data, logs, credentials and other operational artifacts.

**Status:** experimental source snapshot, not a validated release. See [Validation of this snapshot](#validation-of-this-snapshot) for the recorded build and test limitations.

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

The existing public export and an additional credential/data check completed without findings. Application source and tests are unchanged from the development snapshot.

Validation with Node.js 24 and cached dependencies matching the source lockfile found existing TypeScript errors and failing regression tests. The build and test suite are **not currently green**. This snapshot is provided for code review; it is not a validated release.
