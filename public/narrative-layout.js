const LONG_SCENE_WORD_THRESHOLD = 180;

function wordCount(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function splitAtSentenceNearMiddle(text) {
  const normalized = String(text || "").trim().replace(/\s+/gu, " ");
  if (!normalized) return ["", ""];

  const sentences = normalized.match(/[^.!?]+(?:[.!?]+["'’”)]*|$)/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [normalized];
  if (sentences.length < 2) {
    const words = normalized.split(/\s+/u);
    const midpoint = Math.ceil(words.length / 2);
    return [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")];
  }

  const totalWords = sentences.reduce((sum, sentence) => sum + wordCount(sentence), 0);
  const target = totalWords / 2;
  let running = 0;
  let bestIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 1; index < sentences.length; index += 1) {
    running += wordCount(sentences[index - 1]);
    const distance = Math.abs(running - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return [
    sentences.slice(0, bestIndex).join(" "),
    sentences.slice(bestIndex).join(" "),
  ];
}

function decorateLongNarrative(narrative) {
  if (!(narrative instanceof HTMLElement) || narrative.dataset.longSceneSplit === "true") return;
  const text = narrative.textContent || "";
  if (wordCount(text) <= LONG_SCENE_WORD_THRESHOLD) return;

  const [first, second] = splitAtSentenceNearMiddle(text);
  if (!first || !second) return;

  narrative.dataset.longSceneSplit = "true";
  narrative.classList.add("narrative-split");
  narrative.replaceChildren();

  const firstPart = document.createElement("section");
  firstPart.className = "narrative-part";
  firstPart.setAttribute("aria-label", "Scene, first part");
  const firstParagraph = document.createElement("p");
  firstParagraph.textContent = first;
  firstPart.append(firstParagraph);

  const divider = document.createElement("div");
  divider.className = "narrative-part-divider";
  divider.setAttribute("aria-hidden", "true");
  divider.textContent = "• • •";

  const secondPart = document.createElement("section");
  secondPart.className = "narrative-part";
  secondPart.setAttribute("aria-label", "Scene, second part");
  const secondParagraph = document.createElement("p");
  secondParagraph.textContent = second;
  secondPart.append(secondParagraph);

  narrative.append(firstPart, divider, secondPart);
}

function decorateCurrentScene() {
  document.querySelectorAll(".scene-panel > .narrative").forEach(decorateLongNarrative);
}

const app = document.querySelector("#app");
if (app) {
  const observer = new MutationObserver(() => decorateCurrentScene());
  observer.observe(app, { childList: true, subtree: true });
  decorateCurrentScene();
}
