import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_PARAMETER_RULES } from "../src/ai/engine/rules.js";

test("dialogue suggestion rules stop at the current required source beat", () => {
  const rules = RUNTIME_PARAMETER_RULES.join("\n");

  assert.match(
    rules,
    /next_significant_event_progress\.next_required_beat as the furthest source-backed development/i,
  );
  assert.match(
    rules,
    /Do not mention, propose, assume, or reveal any later beat or significant event whose prerequisite beats are still incomplete/i,
  );
  assert.match(
    rules,
    /may not presuppose knowledge, plans, relationships, destinations, goals, or agreements that exist only in later upcoming_source_material/i,
  );
});
