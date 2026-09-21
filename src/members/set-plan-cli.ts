import { loadDotEnv } from "../util/env.js";
import type { MemberPlan } from "./service.js";
import { setMemberPlanForEmail } from "./service.js";

loadDotEnv();

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function run(): Promise<void> {
  const email = argument("--email");
  const rawPlan = argument("--plan")?.trim().toLowerCase();
  if (!email) throw new Error("Usage: npm run member:set -- --email person@example.com --plan unlimited");
  if (rawPlan !== "free" && rawPlan !== "unlimited") {
    throw new Error("--plan must be either free or unlimited");
  }

  const plan = rawPlan as MemberPlan;
  await setMemberPlanForEmail(email, plan);
  console.log(`Member plan for ${email.trim().toLowerCase()} set to ${plan}.`);
  console.log("The grant is applied on the member's next authenticated BookRPG request.");
}

run().catch((error: unknown) => {
  console.error(`Member update failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
