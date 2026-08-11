import type { ConversationPresentationBindings } from "../conversation/presentationBindings";
import type { PromptInputBindings } from "../input/bindings";
import type { ToolConfirmationBindings } from "../tool-confirmation/bindings";

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
