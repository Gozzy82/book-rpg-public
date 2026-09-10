(() => {
  const originalFetch = window.fetch.bind(window);
  let activeGameId = null;
  let cachedRules = [];
  let rulesLoadedForGameId = null;
  let refreshPromise = null;

  function apiPath(gameId, suffix = "") {
    return `/api/games/${encodeURIComponent(gameId)}${suffix}`;
  }

  function gameIdFromUrl(value) {
    const url = new URL(typeof value === "string" ? value : value.url, window.location.href);
    const match = url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    return match?.[1] || null;
  }

  function isGameStart(url, method) {
    return method === "POST" && url.pathname === "/api/games";
  }

  function isResume(url, method) {
    return method === "POST" && /^\/api\/games\/[a-zA-Z0-9_-]+\/resume$/.test(url.pathname);
  }

  function isWorldRuleMutation(url, method) {
    return (method === "POST" && /\/world-rules$/.test(url.pathname))
      || (method === "DELETE" && /\/world-rules\/\d+$/.test(url.pathname));
  }

  function explicitWorldRuleRequest(input, method) {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    if (method !== "POST" || !/\/parameters$/.test(url.pathname)) {
      return { input, url, legacyParameterRequest: false };
    }
    url.pathname = url.pathname.replace(/\/parameters$/, "/world-rules");
    return { input: url.toString(), url, legacyParameterRequest: true };
  }

  async function legacyParameterResponse(response) {
    if (!response.ok) return response;
    try {
      const body = await response.clone().json();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify({
        ...body,
        parameters: Array.isArray(body?.worldRules) ? body.worldRules : [],
      }), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return response;
    }
  }

  function setActiveGame(gameId) {
    if (!gameId || gameId === activeGameId) return;
    activeGameId = gameId;
    rulesLoadedForGameId = null;
    cachedRules = [];
    queueMicrotask(() => void renderWorldRulesPanel());
  }

  window.fetch = async (input, init = {}) => {
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const explicit = explicitWorldRuleRequest(input, method);
    const response = await originalFetch(explicit.input, init);
    const url = explicit.url;

    if (response.ok && (isGameStart(url, method) || isResume(url, method))) {
      try {
        const body = await response.clone().json();
        if (body && typeof body.gameId === "string") setActiveGame(body.gameId);
      } catch {
        // The main app owns response/error handling; the world-rule panel is optional UI.
      }
    } else if (response.ok && method === "GET" && /^\/api\/games\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
      setActiveGame(gameIdFromUrl(url.toString()));
    }

    if (response.ok && isWorldRuleMutation(url, method)) {
      rulesLoadedForGameId = null;
      cachedRules = [];
      queueMicrotask(() => void refreshWorldRules());
    }

    return explicit.legacyParameterRequest
      ? await legacyParameterResponse(response)
      : response;
  };

  async function loadWorldRules() {
    if (!activeGameId) return [];
    if (rulesLoadedForGameId === activeGameId) return cachedRules;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const response = await originalFetch(apiPath(activeGameId, "/world-rules"), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return [];
      const body = await response.json();
      cachedRules = Array.isArray(body?.worldRules) ? body.worldRules : [];
      rulesLoadedForGameId = activeGameId;
      return cachedRules;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function addWorldRule(text) {
    if (!activeGameId) return;
    const response = await originalFetch(apiPath(activeGameId, "/world-rules"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "The world rule could not be added.");
    }
    const body = await response.json();
    cachedRules = Array.isArray(body?.worldRules) ? body.worldRules : [];
    rulesLoadedForGameId = activeGameId;
  }

  async function deleteWorldRule(index) {
    if (!activeGameId) return;
    const response = await originalFetch(apiPath(activeGameId, `/world-rules/${index}`), {
      method: "DELETE",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "The world rule could not be removed.");
    }
    const body = await response.json();
    cachedRules = Array.isArray(body?.worldRules) ? body.worldRules : [];
    rulesLoadedForGameId = activeGameId;
  }

  function makeRuleRow(rule, index) {
    const row = document.createElement("div");
    row.className = "world-rule-row";

    const copy = document.createElement("p");
    copy.textContent = rule;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "world-rule-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove world rule: ${rule}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await deleteWorldRule(index);
        await renderWorldRulesPanel(true);
      } catch (error) {
        remove.disabled = false;
        console.error(error);
      }
    });

    row.append(copy, remove);
    return row;
  }

  function makeAddRuleForm() {
    const form = document.createElement("form");
    form.className = "world-rule-add";

    const input = document.createElement("input");
    input.type = "text";
    input.name = "worldRule";
    input.placeholder = "Add a persistent world rule…";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "New world rule");

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add rule";

    const error = document.createElement("p");
    error.className = "world-rule-error";
    error.hidden = true;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      submit.disabled = true;
      error.hidden = true;
      try {
        await addWorldRule(text);
        input.value = "";
        await renderWorldRulesPanel(true);
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : "The world rule could not be added.";
        error.hidden = false;
      } finally {
        input.disabled = false;
        submit.disabled = false;
        input.focus();
      }
    });

    form.append(input, submit, error);
    return form;
  }

  async function renderWorldRulesPanel(forceOpen = false) {
    const main = document.querySelector(".game-main");
    if (!(main instanceof HTMLElement) || !activeGameId) return;

    let panel = main.querySelector("[data-world-rules-panel]");
    const isNewPanel = !(panel instanceof HTMLDetailsElement);
    if (isNewPanel) {
      panel = document.createElement("details");
      panel.className = "world-rules-panel";
      panel.dataset.worldRulesPanel = "";
      const mission = main.querySelector(".mission-panel");
      if (mission?.nextSibling) main.insertBefore(panel, mission.nextSibling);
      else if (mission) mission.after(panel);
      else main.querySelector(".game-identity")?.after(panel);
    }

    const rules = await loadWorldRules();
    if (!panel.isConnected) return;
    const wasOpen = panel.open;
    panel.replaceChildren();
    panel.open = forceOpen || wasOpen || (isNewPanel && rules.length > 0);

    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "world-rules-title";
    title.innerHTML = `<small>BOOKRPG WORLD</small><strong>World rules</strong>`;
    const count = document.createElement("span");
    count.className = "world-rules-count";
    count.textContent = String(rules.length);
    summary.append(title, count);

    const body = document.createElement("div");
    body.className = "world-rules-body";
    const intro = document.createElement("p");
    intro.className = "world-rules-intro";
    intro.textContent = "Persistent rules override the book world and are enforced in future scenes and dialogue.";
    body.append(intro);

    if (rules.length === 0) {
      const empty = document.createElement("p");
      empty.className = "world-rules-empty";
      empty.textContent = "No persistent world rules are active.";
      body.append(empty);
    } else {
      rules.forEach((rule, index) => body.append(makeRuleRow(rule, index)));
    }
    body.append(makeAddRuleForm());
    panel.append(summary, body);
  }

  async function refreshWorldRules() {
    rulesLoadedForGameId = null;
    await renderWorldRulesPanel();
  }

  const observer = new MutationObserver(() => {
    if (document.querySelector(".game-main") && !document.querySelector("[data-world-rules-panel]")) {
      void renderWorldRulesPanel();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
