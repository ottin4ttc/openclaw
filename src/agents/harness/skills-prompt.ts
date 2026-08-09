import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "../embedded-agent-runner/sandbox-skills.js";
import type { SandboxContext } from "../sandbox/types.js";

/**
 * Shared skill prompt resolver for plugin-owned agent harnesses.
 *
 * Plugin harnesses build their own prompts outside the embedded OpenClaw runner,
 * so they must explicitly reuse the same sandbox skill path mapping before
 * showing skill files to the model.
 */
type AgentHarnessSkillSandboxContext = Pick<SandboxContext, "enabled"> &
  Partial<
    Pick<
      SandboxContext,
      "skillsEligibility" | "skillsWorkspaceDir" | "containerWorkdir" | "workspaceAccess"
    >
  >;

export function resolveAgentHarnessSkillsPromptForRun(params: {
  attempt: EmbeddedRunAttemptParams;
  effectiveWorkspace: string;
  sandbox?: AgentHarnessSkillSandboxContext | null;
  agentId?: string;
}): string {
  const {
    skillsEligibility,
    skillsPromptWorkspaceDir,
    skillsSnapshot: skillsSnapshotForRun,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: params.sandbox,
    effectiveWorkspace: params.effectiveWorkspace,
    skillsSnapshot: params.attempt.skillsSnapshot,
  });
  const agentId = params.agentId ?? params.attempt.agentId;
  const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
    workspaceDir: skillsWorkspaceDir,
    config: params.attempt.config,
    agentId,
    eligibility: skillsEligibility,
    skillsSnapshot: skillsSnapshotForRun,
    workspaceOnly,
  });
  const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
    entries: shouldLoadSkillEntries ? skillEntries : undefined,
    skillsWorkspaceDir,
    skillsPromptWorkspaceDir,
  });
  return resolveSkillsPromptForRun({
    skillsSnapshot: skillsSnapshotForRun,
    entries: promptSkillEntries,
    config: params.attempt.config,
    workspaceDir: skillsPromptWorkspaceDir,
    agentId,
    eligibility: skillsEligibility,
  });
}
