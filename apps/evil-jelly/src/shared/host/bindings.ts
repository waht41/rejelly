import type { PromptInputBindings } from "./inputBindings";
import type { ConversationPresentationBindings } from "./presentationBindings";
import type { ToolConfirmationBindings } from "./toolConfirmationBindings";

/**
 * Complete flat binding object installed by a runtime adapter.
 *
 * Capability interfaces remain independently usable; this facade exists only for composition and
 * the single execution-scoped binding context.
 */
export interface EvilJellyBindings
  extends PromptInputBindings,
    ConversationPresentationBindings,
    ToolConfirmationBindings {}
