import type { AiResponseRequest } from "../provider.js";

/** Line references can start/end halfway through an adjacent action. Keep only
 * complete sentence edges for generation; the typed beat remains the action contract.
 * This is boundary cleanup, not semantic permission to execute the retained text.
 */
export function completeSourceSentences(excerpt: string): string {
  const text = excerpt.trim();
  const ends = [...text.matchAll(/[.!?]["'”’»)]*(?=\s|$)/gu)];
  if (!ends.length) return "";
  const last = ends.at(-1)!;
  const start = /^[\p{Ll}]/u.test(text) ? ends[0]!.index! + ends[0]![0].length : 0;
  return text.slice(start, last.index! + last[0].length).trim();
}

export function withBoundedOpeningEvidence(label: string, request: AiResponseRequest): AiResponseRequest {
  if (label !== "scene" || !request.input.includes("OPENING PRELUDE:")) return request;
  const input = request.input.replace(
    /("sourceReferencesExcerpt"\s*:\s*)("(?:\\.|[^"\\])*")/gu,
    (_match, key: string, value: string) => key + JSON.stringify(completeSourceSentences(JSON.parse(value))),
  );
  return {...request, input, max_output_tokens: Math.max(request.max_output_tokens ?? 0, 2400),
    instructions: [request.instructions,
      "OPENING SOURCE EVIDENCE: excerpt line ranges can cut through adjacent actions. Incomplete sentence edges have been omitted; an empty excerpt does not remove its mandatory typed PRELUDE BEAT. Use the typed actor and every action in each listed beat as the completion contract.",
      "Opening source details and resultingState annotations never authorize any part of the next player decision. Preserve the final automatic beat's physical state; do not retrieve, hold, move with, speak, or decide for the player unless that act is automatic in the supplied contract.",
      "Keep the complete opening near its stated narrative target. Stop after the final automatic beat; do not add a reflective coda or repeatedly describe the approaching threat. Leave output room for required JSON metadata.",
    ].filter(Boolean).join("\n"),
  };
}
