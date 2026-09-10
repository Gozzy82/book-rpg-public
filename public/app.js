const FREE_ACTION_CHOICE_ID = "__bookrpg_free_action__";
const SOURCE_CONTINUATION_CHOICE_ID = "__bookrpg_source_continuation__";
const MAX_CHARACTER_CHOICES = 5;
const LOG_POLL_INTERVAL_MS = 1200;

const app = document.querySelector("#app");
const loadingOverlay = document.querySelector("#loading-overlay");
const loadingLabel = document.querySelector("#loading-label");
const toastRegion = document.querySelector("#toast-region");

if (
  !(app instanceof HTMLElement)
  || !(loadingOverlay instanceof HTMLElement)
  || !(loadingLabel instanceof HTMLElement)
  || !(toastRegion instanceof HTMLElement)
) {
  throw new Error("The BookRPG interface could not be started.");
}

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const state = {
  books: [],
  games: [],
  user: null,
  view: "boot",
  selectedBook: null,
  selectedPlayer: "",
  unavailablePlayers: new Set(),
  setupError: "",
  game: null,
  conversation: null,
  dialogueDraft: "",
  customOpen: false,
  customMode: "action",
  customDrafts: {
    action: "",
    event: "",
    parameter: "",
  },
  customError: "",
  busy: false,
  selectedChoiceId: null,
  pendingChoiceId: null,
  logs: [],
  logError: "",
  logsLoaded: false,
};

let logPollingId = 0;

const categoryLabels = {
  mystery: "Mystery",
  adventure: "Adventure",
  survival: "Survival",
  drama: "Drama",
  exploration: "Exploration",
  open_ended: "Open world",
};

const endingLabels = {
  win: "Play to win",
  completion: "Complete your journey",
  open_ended: "Keep exploring",
};

const customModes = {
  action: {
    label: "Custom action",
    title: "What do you want to do?",
    hint: "Describe what your character tries to do or say.",
    placeholder: "For example: I search the room for hidden clues.",
    submit: "Take this action",
    loading: "Your action is changing the story...",
  },
  event: {
    label: "World event",
    title: "What happens in the world?",
    hint: "This happens independently of your character and can change the whole story.",
    placeholder: "For example: A power outage shuts down the entire city.",
    submit: "Make this happen",
    loading: "The world is shifting...",
  },
  parameter: {
    label: "World rule",
    title: "Which rule should persist?",
    hint: "Save a lasting trait or rule for future scenes.",
    placeholder: "For example: No one in the village can lie.",
    submit: "Save this rule",
    loading: "The new world rule is being saved...",
  },
};

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function append(parent, ...children) {
  for (const child of children) {
    if (child) parent.append(child);
  }
  return parent;
}

function makeButton(label, className, onClick) {
  const button = element("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function createBrand(compact = false) {
  const brand = element("div", compact ? "brand brand-compact" : "brand");
  const mark = element("span", "brand-mark", "B");
  mark.setAttribute("aria-hidden", "true");
  const words = element("span", "brand-words");
  append(
    words,
    element("strong", "", "BOOKRPG"),
    compact ? null : element("small", "", "Your book. Your adventure."),
  );
  return append(brand, mark, words);
}

function setBusy(busy, label = "Just a moment...", showLoader = true) {
  state.busy = busy;
  loadingLabel.textContent = label;
  loadingOverlay.hidden = !(busy && showLoader);
  app.setAttribute("aria-busy", String(busy));
  document.body.classList.toggle("is-busy", busy && showLoader);
}

function errorMessage(error) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Something went wrong. Please try again.";
}

async function runTask(label, task, handleError, options = {}) {
  const { showLoader = true, trackLogs = false, onBusyChange } = options;
  if (state.busy) return;
  setBusy(true, label, showLoader);
  if (trackLogs) startLogPolling();
  onBusyChange?.();
  try {
    await task();
  } catch (error) {
    if (handleError?.(error)) return;
    showToast(errorMessage(error), "error");
  } finally {
    setBusy(false);
    if (trackLogs) stopLogPolling();
    onBusyChange?.();
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body !== undefined) headers.set("content-type", "application/json");

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (cause) {
    throw new ApiError(
      "The BookRPG server cannot be reached. Check whether the server is still running.",
      0,
      undefined,
      cause,
    );
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (cause) {
      throw new ApiError("The server returned an unreadable response.", response.status, undefined, cause);
    }
  }

  if (!response.ok) {
    const message = body && typeof body.error === "string"
      ? body.error
      : response.statusText || "The request could not be completed.";
    const code = body && typeof body.code === "string" ? body.code : undefined;
    throw new ApiError(message, response.status, code, body);
  }
  return body;
}

function showToast(message, kind = "info") {
  const toast = element("div", `toast toast-${kind}`);
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  append(
    toast,
    element("span", "toast-dot", kind === "error" ? "!" : ""),
    element("p", "", message),
  );
  toastRegion.append(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  window.setTimeout(() => {
    toast.classList.remove("toast-visible");
    window.setTimeout(() => toast.remove(), 220);
  }, 4200);
}

function formatLogTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function updateLogPanel() {
  const lists = document.querySelectorAll("[data-server-log-list]");
  const statuses = document.querySelectorAll("[data-server-log-status]");
  if (lists.length === 0 || statuses.length === 0) return;

  for (const status of statuses) {
    status.textContent = state.logError || (state.busy ? "Live" : `${state.logs.length} recent`);
  }

  for (const list of lists) {
    list.replaceChildren();
    if (state.logs.length === 0) {
      list.append(element("p", "log-empty", state.logError || "No server logs yet."));
      continue;
    }

    for (const entry of state.logs.slice(-40).reverse()) {
      append(
        list,
        append(
          element("div", `log-line log-${entry.level}`),
          element("time", "", formatLogTimestamp(entry.timestamp)),
          element("span", "log-level", entry.level.toUpperCase()),
          element("p", "", entry.message),
        ),
      );
    }
    list.scrollTop = 0;
  }
}

async function refreshLogs() {
  try {
    const logs = await request("/api/logs?limit=80");
    state.logs = Array.isArray(logs) ? logs : [];
    state.logError = "";
    state.logsLoaded = true;
  } catch (error) {
    state.logError = error instanceof ApiError && error.status === 404
      ? "Logs are not enabled for this server."
      : errorMessage(error);
    state.logsLoaded = true;
  }
  updateLogPanel();
}

function startLogPolling() {
  if (logPollingId) return;
  void refreshLogs();
  logPollingId = window.setInterval(() => void refreshLogs(), LOG_POLL_INTERVAL_MS);
}

function stopLogPolling() {
  if (!logPollingId) return;
  window.clearInterval(logPollingId);
  logPollingId = 0;
  void refreshLogs();
}

function focusPageTitle(scrollToTop = false) {
  requestAnimationFrame(() => {
    if (scrollToTop) window.scrollTo({ top: 0, behavior: "auto" });
    const title = app.querySelector("[data-page-title]");
    if (title instanceof HTMLElement) title.focus({ preventScroll: true });
  });
}

function normalizedName(name) {
  return name.trim().toLocaleLowerCase("en-GB");
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("en-GB");
}

function bookTone(bookId) {
  let value = 0;
  for (const character of bookId) value = (value + character.charCodeAt(0)) % 5;
  return String(value);
}

function createBookCover(book, size = "regular") {
  const cover = element("div", `book-cover book-cover-${size}`);
  cover.dataset.tone = bookTone(book.bookId);
  append(
    cover,
    element("span", "book-cover-kicker", "A BOOKRPG"),
    element("strong", "book-cover-title", book.title),
    element("span", "book-cover-author", book.author || "Unknown author"),
    element("span", "book-cover-sigil", "B"),
  );
  return cover;
}

function categoryLabel(category) {
  return categoryLabels[category] || category?.replaceAll("_", " ") || "Story";
}

function endingLabel(endingMode) {
  return endingLabels[endingMode] || "Shape your own ending";
}

function formatUpdated(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently saved";
  return `Saved ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

function createSectionHeading(eyebrow, title, detail) {
  const wrapper = element("div", "section-heading");
  const copy = element("div");
  append(
    copy,
    element("span", "eyebrow eyebrow-dark", eyebrow),
    element("h2", "", title),
  );
  append(wrapper, copy, detail ? element("span", "section-detail", detail) : null);
  return wrapper;
}

function setPage(content, className) {
  state.view = className;
  app.className = `app-shell ${className}`;
  app.replaceChildren(content);
}

async function loadHome() {
  await runTask(
    "Updating your library...",
    async () => {
      const [user, books, games] = await Promise.all([
        request("/api/me"),
        request("/api/books"),
        request("/api/games"),
      ]);
      state.user = user;
      state.books = Array.isArray(books) ? books : [];
      state.games = Array.isArray(games) ? games : [];
      state.game = null;
      state.conversation = null;
      renderHome();
    },
    (error) => {
      if (error instanceof ApiError && error.status === 401) {
        renderSignIn();
        return true;
      }
      renderConnectionError(error);
      return true;
    },
  );
}

function createSignInLink(label, provider, className) {
  const link = element("a", className, label);
  link.href = `/.auth/login/${provider}?post_login_redirect_uri=/`;
  return link;
}

function renderSignIn() {
  const page = element("section", "sign-in-page");
  const mark = element("div", "boot-mark", "B");
  mark.setAttribute("aria-hidden", "true");
  const title = element("h1", "", "Your story is waiting.");
  title.tabIndex = -1;
  title.dataset.pageTitle = "";
  append(
    page,
    mark,
    element("span", "eyebrow eyebrow-dark", "WELCOME TO BOOKRPG"),
    title,
    element(
      "p",
      "",
      "Sign in to open the book library and keep every adventure private to your account.",
    ),
    append(
      element("div", "sign-in-actions"),
      createSignInLink("Continue with Microsoft", "aad", "button button-primary button-wide"),
      createSignInLink("Continue with GitHub", "github", "button button-github button-wide"),
    ),
    element("small", "", "Your books are managed centrally. Your saved games belong only to you."),
  );
  setPage(page, "sign-in-view");
  focusPageTitle();
}

function renderConnectionError(error) {
  const page = element("section", "error-page");
  const mark = element("div", "error-mark", "!");
  const title = element("h1", "", "The bookcase stays shut");
  title.tabIndex = -1;
  title.dataset.pageTitle = "";
  append(
    page,
    mark,
    element("span", "eyebrow eyebrow-dark", "NO CONNECTION"),
    title,
    element(
      "p",
      "",
      errorMessage(error),
    ),
    element(
      "code",
      "command-card",
      "npm run dev",
    ),
    makeButton("Try again", "button button-primary button-wide", loadHome),
  );
  setPage(page, "error-view");
  focusPageTitle();
}

function renderHome() {
  const page = element("div", "home-page");
  const header = element("header", "home-header content-width");
  const account = state.user?.provider && state.user.provider !== "local"
    ? (() => {
        const wrapper = element("div", "account-actions");
        const pill = element("span", "connection-pill");
        append(
          pill,
          element("span", "connection-dot"),
          document.createTextNode(state.user.displayName || "Signed in"),
        );
        const logout = element("a", "logout-link", "Sign out");
        logout.href = "/.auth/logout?post_logout_redirect_uri=/";
        return append(wrapper, pill, logout);
      })()
    : append(
        element("div", "connection-pill"),
        element("span", "connection-dot"),
        document.createTextNode("Server connected"),
      );
  append(header, createBrand(), account);

  const hero = element("section", "hero content-width");
  const heroCopy = element("div", "hero-copy");
  const heroTitle = element("h1", "", "Step into the story.");
  heroTitle.tabIndex = -1;
  heroTitle.dataset.pageTitle = "";
  append(
    heroCopy,
    element("span", "eyebrow", "YOUR BOOK. YOUR CHOICES."),
    heroTitle,
    element(
      "p",
      "",
      "Play as your favourite character, change decisive moments, and discover the ending you will write.",
    ),
    state.books.length > 0
      ? makeButton("Start a new adventure", "button button-coral", () => {
          document.querySelector("#library")?.scrollIntoView({ behavior: "smooth" });
        })
      : null,
  );

  const heroArt = element("div", "hero-art");
  heroArt.setAttribute("aria-hidden", "true");
  append(
    heroArt,
    element("span", "hero-orbit orbit-one"),
    element("span", "hero-orbit orbit-two"),
    append(
      element("div", "open-book"),
      append(
        element("div", "open-book-page"),
        element("i"),
        element("i"),
        element("i"),
        element("i"),
      ),
      append(
        element("div", "open-book-page"),
        element("i"),
        element("i"),
        element("i"),
        element("i"),
      ),
    ),
    append(
      element("div", "story-spark"),
      element("span", "", "B"),
    ),
  );
  append(hero, heroCopy, heroArt);

  const activeGames = state.games.filter((game) => game.status === "active");
  const content = element("div", "home-content content-width");
  if (activeGames.length > 0) {
    const journeys = element("section", "home-section");
    append(
      journeys,
      createSectionHeading(
        "CONTINUE PLAYING",
        activeGames.length === 1 ? "Your open adventure" : "Your open adventures",
        `${activeGames.length} active`,
      ),
    );
    const journeyList = element("div", "journey-list");
    for (const game of activeGames) journeyList.append(createJourneyCard(game));
    journeys.append(journeyList);
    content.append(journeys);
  }

  const library = element("section", "home-section library-section");
  library.id = "library";
  append(
    library,
    createSectionHeading(
      "LIBRARY",
      "Choose your world",
      `${state.books.length} ${state.books.length === 1 ? "book" : "books"}`,
    ),
  );
  if (state.books.length === 0) {
    library.append(createEmptyLibrary());
  } else {
    const grid = element("div", "book-grid");
    for (const book of state.books) grid.append(createBookCard(book));
    library.append(grid);
  }
  content.append(library);

  const footer = element("footer", "home-footer content-width");
  append(
    footer,
    element("span", "footer-mark", "B"),
    element("p", "", "Every completed turn is saved automatically."),
  );

  append(page, header, hero, content, footer);
  setPage(page, "home-view");
  focusPageTitle();
}

function createJourneyCard(game) {
  const card = makeButton("", "journey-card", () => resumeGame(game));
  card.setAttribute("aria-label", `Continue ${game.book.title} as ${game.playerName}`);
  const miniCover = createBookCover(game.book, "mini");
  const copy = element("span", "journey-copy");
  const location = game.position?.chapterTitle || game.sceneTitle;
  append(
    copy,
    element("span", "journey-kicker", `PLAYING AS ${game.playerName.toLocaleUpperCase("en-GB")}`),
    element("strong", "", game.book.title),
    element("span", "journey-location", location),
    element("small", "", formatUpdated(game.updatedAt)),
  );
  const arrow = element("span", "round-arrow", ">");
  arrow.setAttribute("aria-hidden", "true");
  return append(card, miniCover, copy, arrow);
}

function createBookCard(book) {
  const card = makeButton("", "book-card", () => openSetup(book));
  card.setAttribute("aria-label", `Start an adventure in ${book.title}`);
  const info = element("span", "book-card-info");
  const profile = book.gameProfile;
  const meta = [
    `${book.chapterCount} chap.`,
    `${book.pageCount} pages`,
  ].join("  /  ");
  append(
    info,
    element("span", "book-card-category", categoryLabel(profile?.category)),
    element("strong", "", book.title),
    element("span", "", book.author || "Unknown author"),
    element("small", "", meta),
    element("span", "book-card-cta", "Start adventure  >"),
  );
  return append(card, createBookCover(book, "card"), info);
}

function createEmptyLibrary() {
  const empty = element("div", "empty-library");
  append(
    empty,
    element("span", "empty-library-mark", "B"),
    append(
      element("div"),
      element("h3", "", "No books found yet"),
      element(
        "p",
        "",
        "First import an EPUB that you are allowed to process. The book will then appear here automatically.",
      ),
      element("code", "command-card", "npm run import -- path\\to\\book.epub"),
    ),
  );
  return empty;
}

function openSetup(book) {
  state.selectedBook = book;
  state.unavailablePlayers = new Set();
  state.setupError = "";
  state.selectedPlayer = startingCharacterChoices(book)[0] || "";
  renderSetup();
}

function startingCharacterChoices(book) {
  return (book.startingCharacters || []).slice(0, MAX_CHARACTER_CHOICES);
}

function renderSetup() {
  const book = state.selectedBook;
  if (!book) {
    renderHome();
    return;
  }

  const page = element("div", "setup-page");
  const header = element("header", "subpage-header content-narrow");
  append(
    header,
    makeButton("<  Library", "text-button", renderHome),
    createBrand(true),
    element("span", "header-spacer"),
  );

  const main = element("div", "setup-main content-narrow");
  const intro = element("section", "setup-intro");
  const copy = element("div", "setup-book-copy");
  const title = element("h1", "", book.title);
  title.tabIndex = -1;
  title.dataset.pageTitle = "";
  append(
    copy,
    element("span", "eyebrow eyebrow-dark", "NEW ADVENTURE"),
    title,
    element("p", "setup-author", book.author || "Unknown author"),
    append(
      element("div", "tag-row"),
      element("span", "soft-tag", categoryLabel(book.gameProfile?.category)),
      element("span", "soft-tag", endingLabel(book.gameProfile?.endingMode)),
    ),
    book.gameProfile?.description
      ? element("p", "setup-description", book.gameProfile.description)
      : null,
  );
  append(intro, createBookCover(book, "large"), copy);

  const form = element("form", "player-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    startSelectedGame();
  });
  const formHeader = element("div", "form-heading");
  append(
    formHeader,
    element("span", "step-number", "01"),
    append(
      element("div"),
      element("h2", "", "Who will you be?"),
      element("p", "", "You begin at this character's first important story moment."),
    ),
  );
  form.append(formHeader);

  const choices = element("div", "player-options");
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-label", "Choose a character");
  const startingCharacters = startingCharacterChoices(book);
  for (const character of startingCharacters) {
    const unavailable = state.unavailablePlayers.has(normalizedName(character));
    const selected = state.selectedPlayer === character;
    const option = makeButton("", `player-option${selected ? " player-option-selected" : ""}`, () => {
      if (unavailable) return;
      state.selectedPlayer = character;
      state.setupError = "";
      renderSetup();
    });
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(selected));
    option.disabled = unavailable;
    append(
      option,
      element("span", "player-avatar", initials(character)),
      append(
        element("span", "player-option-copy"),
        element("strong", "", character),
        element("small", "", unavailable ? "Unavailable at the beginning" : "Character from the book"),
      ),
      element("span", "radio-mark"),
    );
    choices.append(option);
  }
  if (choices.childElementCount === 0) {
    choices.append(element(
      "p",
      "empty-choices",
      "No playable characters were found. Analyze this book before starting a game.",
    ));
  }
  form.append(choices);
  if ((book.startingCharacters?.length || 0) > MAX_CHARACTER_CHOICES) {
    form.append(element(
      "p",
      "save-note",
      `Showing the first ${MAX_CHARACTER_CHOICES} playable characters.`,
    ));
  }

  if (state.setupError) {
    const error = element("p", "inline-error", state.setupError);
    error.setAttribute("role", "alert");
    form.append(error);
  }

  const startButton = element("button", "button button-primary button-start", "Start my story");
  startButton.type = "submit";
  startButton.disabled = !state.selectedPlayer;
  append(
    form,
    startButton,
    element("p", "save-note", "Your game is saved automatically after every turn."),
  );

  append(main, intro, form);
  append(page, header, main);
  setPage(page, "setup-view");
  focusPageTitle();
}

async function startSelectedGame() {
  const book = state.selectedBook;
  if (!book) return;
  const playerName = state.selectedPlayer.trim();
  if (!playerName) {
    state.setupError = "Choose one of the available book characters.";
    renderSetup();
    return;
  }

  await runTask(
    `Opening ${playerName}'s story...`,
    async () => {
      const bookRef = {
        bookId: book.bookId,
        title: book.title,
        ...(book.author ? { author: book.author } : {}),
      };
      const result = await request("/api/games", {
        method: "POST",
        body: JSON.stringify({ book: bookRef, playerName }),
      });
      enterGame(result, bookRef, playerName);
    },
    (error) => {
      if (!(error instanceof ApiError) || error.code !== "PLAYER_UNAVAILABLE") return false;
      state.unavailablePlayers.add(normalizedName(playerName));
      const reason = error.details && typeof error.details.reason === "string"
        ? ` ${error.details.reason}`
        : "";
      state.setupError = `${playerName} cannot be played at this point.${reason}`;
      const next = startingCharacterChoices(book).find(
        (character) => !state.unavailablePlayers.has(normalizedName(character)),
      );
      state.selectedPlayer = next || "";
      renderSetup();
      return true;
    },
  );
}

async function resumeGame(summary) {
  await runTask(
    `Resuming your adventure in ${summary.book.title}...`,
    async () => {
      const result = await request(`/api/games/${encodeURIComponent(summary.gameId)}/resume`, {
        method: "POST",
      });
      enterGame(result, result.book || summary.book, result.playerName || summary.playerName);
    },
  );
}

function enterGame(result, book, playerName) {
  setBusy(false);
  state.selectedChoiceId = null;
  state.pendingChoiceId = null;
  state.game = {
    ...result,
    book,
    playerName,
  };
  state.conversation = result.activeConversation || null;
  state.dialogueDraft = "";
  state.customOpen = false;
  state.customError = "";
  state.customDrafts = { action: "", event: "", parameter: "" };
  renderGame(true);
}

function gamePath(suffix) {
  if (!state.game) throw new Error("There is no active game.");
  return `/api/games/${encodeURIComponent(state.game.gameId)}${suffix}`;
}

function renderGame(scrollToTop = false) {
  const game = state.game;
  if (!game) {
    renderHome();
    return;
  }

  const page = element("div", "game-page");
  const header = element("header", "game-header");
  const headerInner = element("div", "game-header-inner content-game");
  const libraryButton = makeButton("Library", "game-back", loadHome);
  libraryButton.setAttribute("aria-label", "Return to the library");
  const gameBook = element("div", "game-book-label");
  append(
    gameBook,
    element("strong", "", game.book.title),
    element("span", "", `as ${game.playerName}`),
  );
  append(
    headerInner,
    libraryButton,
    gameBook,
    append(
      element("div", "autosave-pill"),
      element("span", "connection-dot"),
      document.createTextNode("Autosave"),
    ),
  );
  header.append(headerInner);

  const main = element("div", "game-main content-game");
  main.append(createGameIdentity(game));
  if (state.conversation) {
    append(main, createTurnHistoryPanel(game));
    main.append(createConversationPanel(game, state.conversation));
    main.append(createConversationDock());
  } else {
    main.append(createMissionPanel(game));
    append(main, createTurnHistoryPanel(game));
    main.append(createScenePanel(game));
    const outcome = game.scene?.outcome || game.status;
    if (outcome === "active") {
      if (state.customOpen) main.append(createCustomComposer());
      main.append(createActionDock());
    } else {
      main.append(createOutcomePanel(game, outcome));
    }
  }
  main.append(element("div", "safe-area-spacer"));

  append(page, header, main);
  setPage(page, "game-view");
  focusPageTitle(scrollToTop);
}

function createGameIdentity(game) {
  const bar = element("section", "game-identity");
  const identity = element("div", "game-player");
  append(
    identity,
    element("span", "player-avatar game-avatar", initials(game.playerName)),
    append(
      element("span"),
      element("small", "", "YOU PLAY AS"),
      element("strong", "", game.playerName),
    ),
  );
  const profile = element("div", "game-profile-tags");
  append(
    profile,
    element("span", "soft-tag", categoryLabel(game.gameProfile?.category)),
    element("span", "soft-tag soft-tag-accent", endingLabel(game.gameProfile?.endingMode)),
  );
  return append(bar, identity, profile);
}

function createMissionPanel(game) {
  const details = element("details", "mission-panel");
  const summary = element("summary");
  append(
    summary,
    append(
      element("span", "mission-icon"),
      element("span", "", "M"),
    ),
    append(
      element("span", "mission-summary-copy"),
      element("small", "", "YOUR MISSION"),
      element("strong", "", game.objective),
    ),
    element("span", "details-toggle", "+"),
  );
  const body = element("div", "mission-body");
  append(
    body,
    append(
      element("div"),
      element("span", "mission-label", "GOAL"),
      element("p", "", game.objective),
    ),
    append(
      element("div"),
      element("span", "mission-label", "END CONDITION"),
      element("p", "", game.victoryCondition),
    ),
  );
  return append(details, summary, body);
}

function createTurnHistoryPanel(game) {
  const turns = Array.isArray(game.turnHistory) ? game.turnHistory : [];
  if (turns.length === 0) return null;

  const details = element("details", "turn-history-panel");
  const summary = element("summary");
  append(
    summary,
    append(
      element("span", "turn-history-icon"),
      element("span", "", "H"),
    ),
    append(
      element("span", "turn-history-summary-copy"),
      element("small", "", "YOUR JOURNEY"),
      element("strong", "", "Turn history"),
      element("span", "", `${turns.length} ${turns.length === 1 ? "turn" : "turns"} saved`),
    ),
    element("span", "details-toggle", "+"),
  );

  const list = element("div", "turn-history-list");
  for (const turn of turns) {
    const item = element("details", "turn-history-item");
    const itemSummary = element("summary");
    append(
      itemSummary,
      element("span", "turn-history-number", `TURN ${String(turn.turnNumber).padStart(2, "0")}`),
      append(
        element("span", "turn-history-action"),
        element("small", "", turnKindLabel(turn.kind)),
        element("strong", "", turn.action),
      ),
      element("span", "turn-history-item-toggle", "+"),
    );
    const scene = element("div", "turn-history-scene");
    append(
      scene,
      element("small", "", "RESULTING SCENE"),
      element("h3", "", turn.scene.title),
    );
    const narrative = element("div", "turn-history-narrative");
    appendNarrative(narrative, turn.scene.text);
    scene.append(narrative);
    append(item, itemSummary, scene);
    list.append(item);
  }

  return append(details, summary, list);
}

function turnKindLabel(kind) {
  if (kind === "start") return "OPENING";
  if (kind === "dialogue") return "DIALOGUE";
  if (kind === "event") return "WORLD EVENT";
  if (kind === "continuation") return "CONTINUATION";
  return "CHOICE";
}

function appendNarrative(container, text) {
  const blocks = String(text || "").trim().split(/\n\s*\n/).filter(Boolean);
  if (blocks.length === 0) {
    container.append(element("p", "", "The next scene is being prepared."));
    return;
  }
  for (const block of blocks) {
    const paragraph = element("p");
    const lines = block.split(/\n/);
    lines.forEach((line, index) => {
      if (index > 0) paragraph.append(document.createElement("br"));
      paragraph.append(document.createTextNode(line));
    });
    container.append(paragraph);
  }
}

function createScenePanel(game) {
  const scene = game.scene;
  const article = element("article", "scene-panel");
  const top = element("header", "scene-heading");
  const title = element("h1", "", scene.title);
  title.tabIndex = -1;
  title.dataset.pageTitle = "";
  append(
    top,
    append(
      element("div"),
      element("span", "eyebrow eyebrow-coral", "CURRENT SCENE"),
      title,
    ),
    element("span", "scene-flourish", "B"),
  );
  article.append(top);

  if (scene.sceneScope) {
    const scope = element("div", "scene-scope");
    append(
      scope,
      append(
        element("span", "scope-item"),
        element("span", "scope-symbol", "L"),
        document.createTextNode(scene.sceneScope.currentLocation),
      ),
      scene.sceneScope.peoplePresent?.length
        ? append(
            element("span", "scope-item"),
            element("span", "scope-symbol", "P"),
            document.createTextNode(scene.sceneScope.peoplePresent.join(", ")),
          )
        : null,
    );
    article.append(scope);
  }

  const narrative = element("div", "narrative");
  appendNarrative(narrative, scene.text);
  article.append(narrative);

  if (game.notice) article.append(createNotice(game.notice));

  if ((scene.outcome || game.status) === "active") {
    const choices = element("section", "choices-section");
    append(
      choices,
      append(
        element("div", "choices-heading"),
        element("span", "step-number step-number-small", "02"),
        append(
          element("div"),
          element("h2", "", "What do you do?"),
          element("p", "", "Your choice writes the next scene."),
        ),
      ),
    );
    const list = element("div", "choice-list");
    scene.choices.forEach((choice, index) => list.append(createChoiceButton(choice, index)));
    if (scene.choices.length === 0) {
      list.append(element("p", "empty-choices", "Continue to open the next story moment."));
    }
    choices.append(list);
    article.append(choices);
  }
  return article;
}

function createNotice(notice) {
  const box = element("aside", "notice-box");
  append(
    box,
    element("span", "notice-mark", "i"),
    append(
      element("div"),
      element("strong", "", "Story tip"),
      element("p", "", notice.message),
      notice.suggestedChoice
        ? element("small", "", `Try: ${notice.suggestedChoice.text}`)
        : null,
    ),
  );
  return box;
}

function createServerLogPanel() {
  const panel = element("details", "server-log-panel");
  panel.open = true;
  const summary = element("summary");
  append(
    summary,
    append(
      element("span"),
      element("strong", "", "Server log"),
      element("small", "", "Recent generation messages"),
    ),
    element("span", "server-log-status", state.busy ? "Live" : `${state.logs.length} recent`),
  );
  summary.querySelector(".server-log-status")?.setAttribute("data-server-log-status", "");

  const list = element("div", "server-log-list");
  list.setAttribute("data-server-log-list", "");
  append(panel, summary, list);
  requestAnimationFrame(() => {
    updateLogPanel();
    if (!state.logsLoaded && !state.logError) void refreshLogs();
  });
  return panel;
}

function createToolbarLogPanel() {
  const panel = element("section", "toolbar-log-panel");
  panel.setAttribute("aria-label", "Live server log");
  append(
    panel,
    append(
      element("div", "toolbar-log-heading"),
      element("strong", "", "Server log"),
      element("span", "server-log-status", state.logError || "Live"),
    ),
    (() => {
      const list = element("div", "server-log-list toolbar-log-list");
      list.setAttribute("data-server-log-list", "");
      return list;
    })(),
  );
  panel.querySelector(".server-log-status")?.setAttribute("data-server-log-status", "");
  requestAnimationFrame(() => updateLogPanel());
  return panel;
}

function createChoiceButton(choice, index) {
  const sourceChoice = choice.id === SOURCE_CONTINUATION_CHOICE_ID;
  const selected = state.selectedChoiceId === choice.id || state.pendingChoiceId === choice.id;
  const button = makeButton(
    "",
    `choice-button${selected ? " choice-button-selected" : ""}${choice.type === "talk" ? " choice-talk" : ""}${sourceChoice ? " choice-source" : ""}`,
    () => chooseSceneChoice(choice),
  );
  if (state.busy) {
    button.disabled = true;
  }
  const label = choice.type === "talk" && choice.character
    ? `Talk to ${choice.character}`
    : choice.text;
  const meta = choice.type === "talk"
    ? "CONVERSATION"
    : sourceChoice
      ? "FOLLOW THE BOOK"
      : choice.stakes === "critical"
        ? "DECISIVE ACTION"
        : "ACTION";
  append(
    button,
    element("span", "choice-number", String(index + 1).padStart(2, "0")),
    append(
      element("span", "choice-copy"),
      element("small", "", meta),
      element("strong", "", label),
    ),
    element("span", "choice-arrow", selected ? "✓" : ">"),
  );
  return button;
}

function createActionDock() {
  const dock = element("nav", `action-dock${state.busy ? " action-dock-busy" : ""}`);
  dock.setAttribute("aria-label", "Additional game actions");
  const undo = makeButton("Undo", "dock-button", undoChoice);
  const continueButton = makeButton("Continue", "dock-button dock-button-primary", continueStory);
  const custom = makeButton(
    state.customOpen ? "Close custom move" : "Custom move",
    `dock-button${state.customOpen ? " dock-button-active" : ""}`,
    () => {
      state.customOpen = !state.customOpen;
      state.customError = "";
      renderGame();
      if (state.customOpen) {
        requestAnimationFrame(() => {
          document.querySelector("#custom-turn")?.scrollIntoView({ behavior: "smooth", block: "center" });
          document.querySelector("#custom-turn textarea")?.focus({ preventScroll: true });
        });
      }
    },
  );
  custom.setAttribute("aria-expanded", String(state.customOpen));
  undo.disabled = state.busy;
  continueButton.disabled = state.busy;
  custom.disabled = state.busy;
  return append(dock, state.busy ? createToolbarLogPanel() : null, undo, continueButton, custom);
}

function createCustomComposer() {
  const section = element("section", "custom-composer");
  section.id = "custom-turn";
  const heading = element("div", "custom-heading");
  append(
    heading,
    append(
      element("div"),
      element("span", "eyebrow eyebrow-dark", "WRITE IT YOURSELF"),
      element("h2", "", "Create your own move"),
    ),
    makeButton("Close", "text-button", () => {
      state.customOpen = false;
      state.customError = "";
      renderGame();
    }),
  );
  heading.querySelector("button")?.toggleAttribute("disabled", state.busy);

  const tabs = element("div", "composer-tabs");
  tabs.setAttribute("role", "tablist");
  Object.entries(customModes).forEach(([key, mode]) => {
    const selected = state.customMode === key;
    const tab = makeButton(
      mode.label,
      `composer-tab${selected ? " composer-tab-selected" : ""}`,
      () => {
        state.customMode = key;
        state.customError = "";
        renderGame();
        requestAnimationFrame(() => document.querySelector("#custom-turn textarea")?.focus());
      },
    );
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(selected));
    tab.disabled = state.busy;
    tabs.append(tab);
  });

  const mode = customModes[state.customMode];
  const form = element("form", "composer-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitCustomTurn();
  });
  const label = element("label", "field");
  label.htmlFor = "custom-turn-text";
  append(
    label,
    element("strong", "", mode.title),
    element("span", "field-hint", mode.hint),
  );
  const textarea = element("textarea", "text-input text-area");
  textarea.id = "custom-turn-text";
  textarea.name = "customTurn";
  textarea.rows = 4;
  textarea.placeholder = mode.placeholder;
  textarea.value = state.customDrafts[state.customMode];
  textarea.disabled = state.busy;
  textarea.addEventListener("input", () => {
    state.customDrafts[state.customMode] = textarea.value;
    state.customError = "";
  });
  label.append(textarea);
  form.append(label);
  if (state.customError) {
    const error = element("p", "inline-error", state.customError);
    error.setAttribute("role", "alert");
    form.append(error);
  }
  const submit = element("button", "button button-primary button-wide", mode.submit);
  submit.type = "submit";
  submit.disabled = state.busy;
  form.append(submit);

  return append(section, heading, tabs, form);
}

function createConversationPanel(game, conversation) {
  const wrapper = element("section", "conversation-panel");
  const context = element("details", "conversation-context");
  const contextSummary = element("summary", "", `Previous scene: ${game.scene.title}`);
  const contextBody = element("div", "conversation-context-body");
  appendNarrative(contextBody, game.scene.text);
  append(context, contextSummary, contextBody);

  const character = element("div", "conversation-character");
  append(
    character,
    element("span", "dialogue-avatar", initials(conversation.character)),
    append(
      element("div"),
      element("span", "eyebrow eyebrow-coral", "IN CONVERSATION WITH"),
      (() => {
        const title = element("h1", "", conversation.character);
        title.tabIndex = -1;
        title.dataset.pageTitle = "";
        return title;
      })(),
    ),
  );

  const prompt = element("blockquote", "dialogue-prompt", conversation.prompt);
  const suggestions = element("div", "dialogue-suggestions");
  append(
    suggestions,
    element("h2", "", "What do you say?"),
    element("p", "", "Choose a reply or write your own response."),
  );
  const suggestionList = element("div", "suggestion-list");
  conversation.suggestions.forEach((suggestion, index) => {
    const button = makeButton("", "suggestion-button", () => sendDialogue(suggestion));
    button.disabled = state.busy;
    append(
      button,
      element("span", "choice-number", String(index + 1).padStart(2, "0")),
      element("strong", "", suggestion),
      element("span", "choice-arrow", ">"),
    );
    suggestionList.append(button);
  });
  suggestions.append(suggestionList);

  const form = element("form", "dialogue-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendDialogue(state.dialogueDraft);
  });
  const field = element("label", "field");
  field.htmlFor = "dialogue-reply";
  field.append(element("strong", "", "Or type your own reply"));
  const textarea = element("textarea", "text-input text-area");
  textarea.id = "dialogue-reply";
  textarea.rows = 3;
  textarea.placeholder = `What do you want to say to ${conversation.character}?`;
  textarea.value = state.dialogueDraft;
  textarea.disabled = state.busy;
  textarea.addEventListener("input", () => {
    state.dialogueDraft = textarea.value;
  });
  field.append(textarea);
  const submit = element("button", "button button-primary", "Say this");
  submit.type = "submit";
  submit.disabled = state.busy;
  append(form, field, submit);
  suggestions.append(form);

  return append(wrapper, context, character, prompt, suggestions);
}

function createConversationDock() {
  const dock = element("nav", `action-dock conversation-dock${state.busy ? " action-dock-busy" : ""}`);
  dock.setAttribute("aria-label", "Conversation actions");
  const undo = makeButton("Undo conversation", "dock-button dock-button-wide", undoChoice);
  undo.disabled = state.busy;
  return append(
    dock,
    state.busy ? createToolbarLogPanel() : null,
    undo,
  );
}

function createOutcomePanel(game, outcome) {
  const won = outcome === "won";
  const completed = outcome === "completed";
  const panel = element("section", `outcome-panel outcome-${outcome}`);
  const title = won ? "You won" : completed ? "Your journey is complete" : "Your adventure ends here";
  const eyebrow = won ? "VICTORY" : completed ? "JOURNEY COMPLETE" : "GAME OVER";
  append(
    panel,
    element("span", "outcome-sigil", won ? "W" : completed ? "E" : "X"),
    element("span", "eyebrow", eyebrow),
    element("h2", "", title),
    element("p", "", game.scene.outcomeReason || "The story has reached its ending."),
    makeButton("Return to my library", "button button-coral", loadHome),
  );
  return panel;
}

function applyGameResponse(result) {
  if (!state.game) return;
  const { book, playerName } = state.game;
  state.game = {
    ...result,
    book,
    playerName,
  };
}

function isConversation(result) {
  return Boolean(
    result
    && typeof result.character === "string"
    && typeof result.prompt === "string"
    && Array.isArray(result.suggestions),
  );
}

function handleTurnResult(result) {
  state.selectedChoiceId = null;
  state.pendingChoiceId = null;
  state.customOpen = false;
  state.customError = "";
  if (isConversation(result)) {
    state.conversation = result;
    state.dialogueDraft = "";
    renderGame(true);
    return;
  }

  applyGameResponse(result);
  state.conversation = null;
  state.dialogueDraft = "";
  renderGame(true);
  if (result.notice?.message) showToast(result.notice.message, "info");
  if (result.sourceAdvance?.sourceChapter) {
    showToast(
      `Continuing in ${result.sourceAdvance.sourceChapter.chapterTitle}.`,
      "success",
    );
  }
}

async function chooseSceneChoice(choice) {
  if (state.busy) return;
  state.selectedChoiceId = choice.id;
  state.customOpen = false;
  renderGame();
}

async function submitSelectedChoice(choice) {
  const label = choice.type === "talk"
    ? `Opening the conversation with ${choice.character || "this character"}...`
    : "Your choice is changing the story...";
  state.pendingChoiceId = choice.id;
  renderGame();
  try {
    await runTask(label, async () => {
      const result = await request(gamePath("/choices"), {
        method: "POST",
        body: JSON.stringify({ choiceId: choice.id }),
      });
      handleTurnResult(result);
    }, undefined, { showLoader: false, trackLogs: true, onBusyChange: renderGame });
  } finally {
    if (state.pendingChoiceId) {
      state.pendingChoiceId = null;
      renderGame();
    }
  }
}

async function continueStory() {
  const selectedChoice = state.selectedChoiceId && state.game?.scene?.choices.find(
    (choice) => choice.id === state.selectedChoiceId,
  );
  if (selectedChoice) {
    await submitSelectedChoice(selectedChoice);
    return;
  }

  await runTask("Writing the next scene...", async () => {
    const result = await request(gamePath("/continue"), { method: "POST" });
    handleTurnResult(result);
  }, undefined, { showLoader: false, trackLogs: true, onBusyChange: renderGame });
}

async function undoChoice() {
  await runTask("Undoing your latest choice...", async () => {
    const result = await request(gamePath("/undo"), { method: "POST" });
    applyGameResponse(result);
    state.conversation = null;
    state.dialogueDraft = "";
    state.customOpen = false;
    renderGame(true);
    showToast("Your latest choice was undone.", "success");
  });
}

async function sendDialogue(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    showToast("First write what you want to say.", "error");
    document.querySelector("#dialogue-reply")?.focus();
    return;
  }
  const character = state.conversation?.character || "the character";
  await runTask(`Waiting for ${character}'s response...`, async () => {
    const result = await request(gamePath("/dialogue"), {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    handleTurnResult(result);
  }, undefined, { showLoader: false, trackLogs: true, onBusyChange: renderGame });
}

async function submitCustomTurn() {
  const modeKey = state.customMode;
  const mode = customModes[modeKey];
  const text = state.customDrafts[modeKey].trim();
  if (!text) {
    state.customError = "First describe what should happen.";
    renderGame();
    requestAnimationFrame(() => document.querySelector("#custom-turn textarea")?.focus());
    return;
  }

  await runTask(
    mode.loading,
    async () => {
      if (modeKey === "parameter") {
        const result = await request(gamePath("/parameters"), {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        state.customDrafts.parameter = "";
        state.customOpen = false;
        state.customError = "";
        renderGame();
        showToast(
          `World rule saved (${result.parameters.length}/20).`,
          "success",
        );
        return;
      }

      const result = modeKey === "event"
        ? await request(gamePath("/events"), {
            method: "POST",
            body: JSON.stringify({ text }),
          })
        : await request(gamePath("/choices"), {
            method: "POST",
            body: JSON.stringify({
              choiceId: FREE_ACTION_CHOICE_ID,
              actionText: text,
            }),
          });
      state.customDrafts[modeKey] = "";
      handleTurnResult(result);
    },
    (error) => {
      state.customError = errorMessage(error);
      renderGame();
      return true;
    },
    { showLoader: modeKey === "parameter", trackLogs: modeKey !== "parameter", onBusyChange: renderGame },
  );
}

window.addEventListener("offline", () => {
  showToast("You are offline. New turns require a connection to the server.", "error");
});

window.addEventListener("online", () => {
  showToast("The connection has been restored.", "success");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.customOpen) return;
  state.customOpen = false;
  state.customError = "";
  renderGame();
});

loadHome();
