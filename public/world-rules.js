// World rules share the app's task lock. They never submit a story turn.
export function createWorldRulesController({
  getGame, isBusy, beforeOpen, request, runTask, render, notify, element, append, makeButton,
}) {
  const MAX_RULES = 20;
  const MAX_TEXT = 1000;
  let current;

  function reset(gameId) {
    current = { gameId, rules: null, pending: null, error: "", draft: "", open: false, removeIndex: null };
  }
  reset(null);

  function path(suffix = "") {
    return `/api/games/${encodeURIComponent(current.gameId)}/world-rules${suffix}`;
  }

  function active() {
    const game = getGame();
    return game?.gameId === current.gameId && (game.scene?.outcome || game.status) === "active";
  }

  function focus(selector) {
    requestAnimationFrame(() => {
      const target = document.querySelector(selector);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
  }

  function open() {
    if (isBusy() || !current.gameId) return;
    beforeOpen();
    current.open = true;
    render();
    focus("#world-rules summary");
  }

  function close(redraw = true) {
    if (isBusy()) return;
    current.open = false;
    current.removeIndex = null;
    if (redraw) {
      render();
      focus("[data-open-world-rules]");
    }
  }

  async function load() {
    const target = current;
    if (target.rules !== null) return;
    if (!target.pending) {
      target.pending = request(path()).then((result) => {
        if (!Array.isArray(result.worldRules)) throw new Error("The world rules could not be read.");
        target.rules = result.worldRules;
        target.error = "";
      }).catch((error) => {
        target.error = error instanceof Error ? error.message : "The world rules could not be loaded.";
      }).finally(() => { target.pending = null; });
    }
    await target.pending;
  }

  async function mutate(suffix, method, text) {
    if (isBusy() || !active() || !current.open || current.rules === null) return;
    const target = current;
    // Capture both the game and URL before the asynchronous task starts.
    const url = path(suffix);
    await runTask(method === "POST" ? "Saving your world rule..." : "Removing the world rule...", async () => {
      const result = await request(url, {
        method,
        ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
      });
      if (current !== target) return;
      target.rules = result.worldRules;
      target.error = "";
      target.removeIndex = null;
      if (method === "POST") target.draft = "";
      notify(method === "POST" ? "World rule saved. The story has not advanced." : "World rule removed.", "success");
    }, (error) => {
      if (current === target) target.error = error instanceof Error ? error.message : "The world rule could not be saved.";
      return true;
    }, { showLoader: false, onBusyChange: render });
    if (current === target) focus("#new-world-rule");
  }

  function fill(panel, target) {
    if (current !== target) return;
    panel.replaceChildren();
    const summary = element("summary");
    append(summary,
      append(element("span", "world-rules-title"),
        element("small", "", "PERSISTENT SETTINGS"), element("strong", "", "World rules")),
      element("span", "world-rules-count", target.rules === null ? "…" : String(target.rules.length)));
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      if (isBusy()) return;
      if (target.open) close(); else open();
    });
    const body = element("div", "world-rules-body");
    body.append(element("p", "world-rules-intro",
      "Lasting rules for future scenes and dialogue. Saving or removing a rule does not advance the story."));
    const error = element("p", "world-rule-error", target.error);
    error.setAttribute("role", "alert");
    error.id = "world-rule-error";
    error.hidden = !target.error;
    body.append(error);

    if (target.rules === null) {
      if (target.error) {
        const retry = makeButton("Retry loading rules", "text-button", () => {
          target.error = "";
          render();
        });
        retry.disabled = isBusy();
        body.append(retry);
      } else {
        const loading = element("p", "world-rules-empty", "Loading world rules...");
        loading.setAttribute("role", "status");
        body.append(loading);
      }
    } else {
      if (target.rules.length === 0) body.append(element("p", "world-rules-empty", "No persistent world rules are active."));
      target.rules.forEach((rule, index) => {
        const row = append(element("div", "world-rule-row"), element("p", "", rule));
        if (active()) {
          if (target.removeIndex === index) {
            const confirmation = element("div", "world-rule-confirm");
            confirmation.setAttribute("role", "group");
            confirmation.setAttribute("aria-label", `Remove world rule: ${rule}`);
            const remove = makeButton("Confirm removal", "world-rule-remove", () => {
              if (current === target && target.removeIndex === index) void mutate(`/${index}`, "DELETE");
            });
            const cancel = makeButton("Keep rule", "text-button", () => {
              target.removeIndex = null;
              render();
            });
            remove.disabled = cancel.disabled = isBusy();
            append(confirmation, element("span", "", "Remove this rule?"), remove, cancel);
            row.append(confirmation);
          } else {
            const remove = makeButton("Remove", "world-rule-remove", () => {
              if (isBusy() || current !== target) return;
              target.removeIndex = index;
              render();
              focus(".world-rule-confirm button");
            });
            remove.setAttribute("aria-label", `Remove world rule: ${rule}`);
            remove.disabled = isBusy();
            row.append(remove);
          }
        }
        body.append(row);
      });
      if (active()) body.append(addForm(target));
    }
    const done = makeButton("Close world rules", "text-button", () => close());
    done.disabled = isBusy();
    body.append(done);
    append(panel, summary, body);
  }

  function addForm(target) {
    const form = element("form", "world-rule-add");
    const input = element("input");
    input.id = "new-world-rule";
    input.type = "text";
    input.name = "worldRule";
    input.required = true;
    input.maxLength = MAX_TEXT;
    input.placeholder = "For example: No one in the village can lie.";
    input.autocomplete = "off";
    input.value = target.draft;
    input.setAttribute("aria-label", "New world rule");
    input.setAttribute("aria-describedby", "world-rule-error world-rule-limit");
    input.disabled = isBusy();
    const submit = element("button", "", "Save world rule");
    submit.type = "submit";
    const valid = () => target.draft.trim().length > 0 && target.draft.trim().length <= MAX_TEXT
      && target.rules.length < MAX_RULES && target.removeIndex === null;
    const sync = () => { submit.disabled = isBusy() || !valid(); };
    input.addEventListener("input", () => {
      target.draft = input.value;
      target.error = "";
      const error = document.querySelector("#world-rule-error");
      if (error) error.hidden = true;
      sync();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (current !== target || isBusy() || !valid()) return;
      void mutate("", "POST", target.draft.trim());
    });
    sync();
    const limit = element("p", "world-rules-intro",
      target.rules.length >= MAX_RULES
        ? "20 rules are active. Remove a rule before adding another; existing rules will not be replaced silently."
        : "Up to 20 rules, 1–1000 characters each. Close this panel to choose a story action.");
    limit.id = "world-rule-limit";
    return append(form, input, submit, limit);
  }

  function createPanel() {
    const target = current;
    const panel = element("details", "world-rules-panel");
    panel.id = "world-rules";
    panel.dataset.worldRulesPanel = "";
    panel.open = target.open;
    fill(panel, target);
    // A resumed/undone game may supersede an in-flight GET. Never attach its
    // rules (or a stale removal index) to the newly displayed game.
    if (target.rules === null && !target.error) {
      void load().then(() => {
        if (current === target && panel.isConnected) fill(panel, target);
      });
    }
    return panel;
  }

  return { reset, open, close, createPanel, isOpen: () => current.open };
}
