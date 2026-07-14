/**
 * Public Ask AI button: opens the AI analysis panel.
 * Can be placed in breadcrumb, toolbar, etc.
 */

import { useCommandViewStore } from "@features/command-view";
import { Sparkles } from "lucide-react";

export function AskAIButton() {
  const aiPanelOpen = useCommandViewStore((s) => s.aiPanelOpen);
  const toggleAIPanel = useCommandViewStore((s) => s.toggleAIPanel);

  return (
    <button
      type="button"
      onClick={toggleAIPanel}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors text-xs font-medium shrink-0"
      title={aiPanelOpen ? "Close AI analysis panel" : "Open AI analysis panel"}
    >
      <Sparkles className="w-3.5 h-3.5 text-primary" />
      <span className="hidden sm:inline">Ask AI</span>
    </button>
  );
}
