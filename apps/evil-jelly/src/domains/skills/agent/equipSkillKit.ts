import { augmentTool, equipInstruction, equipTool, expectResource } from "@rejelly/core";
import { env } from "../../../shared/config";
import { DEFAULT_OPENAI_CONTEXT_WINDOW_TOKENS } from "../../../shared/configDefaults";
import { evilJellyToolLoggerMiddleware } from "../../../shared/host/withToolLogger";
import { renderSkillCatalog } from "./catalogPrompt";
import { SKILL_RUNTIME_PROVIDER_KEY, type SkillRuntimeSnapshot } from "./skillRuntime";
import { createSkillTools } from "./skillTools";

/** Equip the borrowed snapshot's catalog and tools without scanning or reading the filesystem. */
export function equipSkillKit(): void {
  const snapshot = expectResource<SkillRuntimeSnapshot>(SKILL_RUNTIME_PROVIDER_KEY, {
    optional: true,
  });
  if (!snapshot || snapshot.catalog.size === 0) {
    return;
  }

  const catalog = renderSkillCatalog(
    snapshot.catalog,
    env.OPENAI_CONTEXT_WINDOW ?? DEFAULT_OPENAI_CONTEXT_WINDOW_TOKENS,
  );
  if (catalog.text) {
    equipInstruction(catalog.text);
  }

  const tools = createSkillTools(snapshot);
  equipTool(augmentTool(tools.readSkill, [evilJellyToolLoggerMiddleware]));
  equipTool(augmentTool(tools.listSkills, [evilJellyToolLoggerMiddleware]));
  equipTool(augmentTool(tools.readSkillResource, [evilJellyToolLoggerMiddleware]));
}
