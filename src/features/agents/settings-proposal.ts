import type { SessionScope } from "../agent-harness/session-scope";
import { offRecommended } from "./recommended";
import type { Agent } from "./service";

export type AgentSettingsProposal = Readonly<{
  model?: string;
  effort?: string;
  scope?: SessionScope;
  workspace?: string;
  voice?: string;
  apps?: boolean;
}>;

export type AgentSettingsProposalSupport = Readonly<{
  voice?: true;
  apps?: true;
}>;

/** Explain when the current agent can no longer accept a proposal. */
export function settingsProposalProblem(
  { apps, workspace }: AgentSettingsProposal,
  agent: Pick<Agent, "type" | "protection">,
  executionBinding: Agent["executionBinding"],
  proposedFromType = agent.type,
) {
  if (agent.type !== proposedFromType)
    return "The agent changed harnesses after this proposal.";
  if (apps === true && agent.protection)
    return "Protected agents cannot enable Codex apps and plugins.";
  if (executionBinding && (apps !== undefined || workspace !== undefined))
    return "The execution adapter manages apps and workspace.";
}

/** Seed the normal Settings form. The form owns validation and its Save. */
export function applySettingsProposal(
  config: unknown,
  { model, effort, scope, workspace, voice, apps }: AgentSettingsProposal,
) {
  const draft = {
    ...(config as object),
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
    ...(scope !== undefined && { scope }),
    ...(workspace !== undefined && { workspace }),
    ...(voice !== undefined && { voice }),
    ...(apps !== undefined && { apps }),
  };
  return model !== undefined || effort !== undefined
    ? offRecommended(draft)
    : draft;
}
