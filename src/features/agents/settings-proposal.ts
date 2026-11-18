import type { SessionScope } from "../agent-harness/session-scope";
import { offRecommended } from "./recommended";

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
