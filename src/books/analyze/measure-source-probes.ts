import { measureSourceReview, type SourceReviewFixture } from "./staged-index.js";
import type { ChapterAnalysisPart, CreateAnalysisResponse } from "./batching.js";
import type { AiReasoningEffort } from "../../ai/provider.js";

export interface SourceReviewProbe extends SourceReviewFixture {
  name: string;
  fixtureVersion: number;
  sourceFixture: string;
  expectedRepairField: string | null;
  rubric: string;
}
/** Expected answers are measurement metadata, never supplied to the reviewer. */
export async function measureSourceReviewProbe(provider: CreateAnalysisResponse, model: string,
  part: ChapterAnalysisPart, probe: SourceReviewProbe, effort: AiReasoningEffort) {
  const outcome = await measureSourceReview(provider, model, part,
    {timeline: probe.timeline, sourceSha256: probe.sourceSha256, provenance: probe.provenance}, effort);
  const probePassed = probe.expectedRepairField === null ? outcome.verdict === "accepted"
    : outcome.verdict === "rejected" && outcome.target === "source"
      && outcome.repairFields.length === 1 && outcome.repairFields[0] === probe.expectedRepairField;
  return {outcome, probePassed};
}
