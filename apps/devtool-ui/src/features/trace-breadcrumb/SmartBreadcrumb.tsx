/**
 * Smart Breadcrumb Component
 *
 * Interactive breadcrumb navigation with generation dropdowns
 * Shows path from root to current node (NormalizedTrace parentSpanId chain, excluding update nodes).
 */

import {
  findNormalizedGenerationThatSpawnedChild,
  getChildAgentsForNormalizedGeneration,
  getGenerationsForHost,
  normalizedPathNodesRootToLeaf,
} from "@entities/trace/lib/treeFinder";
import { useTraceStore } from "@entities/trace/store";
import { getStatusConfig } from "@entities/trace/ui/status-config";
import { cn } from "@shared/lib/style";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/popover";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { ExecutionStatus, NormalizedTrace } from "src/entities/trace/types";

function normGenFinishReason(g: NormalizedTrace.GenerationNode): string {
  if (!g.endEvent) return "unknown";
  return g.endEvent.endReason ?? "unknown";
}

interface BreadcrumbItem {
  node: NormalizedTrace.TraceNode;
  isAgent: boolean;
  agent?: NormalizedTrace.AgentNode;
  currentGenerationId?: number;
  availableGenerations?: Array<{ id: number; status: ExecutionStatus; finishReason: string }>;
}

export function SmartBreadcrumb({ trailing }: { trailing?: ReactNode }) {
  const normalizedTrace = useTraceStore((state) => state.normalizedTrace);
  const {
    activeNodeId,
    activeNodeType: _activeNodeType,
    generationSelections,
    getActiveGenerationId,
    setActiveNode,
    selectGeneration,
  } = useSelectionStore();
  const selectedGenerationId = getActiveGenerationId();

  const breadcrumbItems = useMemo(() => {
    if (!activeNodeId || !normalizedTrace) {
      return [];
    }

    const path = normalizedPathNodesRootToLeaf(normalizedTrace, activeNodeId);
    if (path.length === 0) {
      return [];
    }

    const items: BreadcrumbItem[] = [];

    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      const isAgent = node.type === "agent";
      const agent = isAgent ? (node as NormalizedTrace.AgentNode) : undefined;

      if (isAgent && agent) {
        const nextNode = i < path.length - 1 ? path[i + 1] : null;
        let currentGenId: number | undefined;
        let availableGens:
          | Array<{ id: number; status: ExecutionStatus; finishReason: string }>
          | undefined;

        const gens = getGenerationsForHost(normalizedTrace, agent.spanId);

        if (gens.length > 1) {
          availableGens = gens.map((g) => ({
            id: g.startEvent.generationId,
            status: g.status,
            finishReason: normGenFinishReason(g),
          }));

          const storedGenId = generationSelections[agent.spanId];
          if (storedGenId !== undefined) {
            currentGenId = storedGenId;
          } else if (nextNode) {
            const genId = findNormalizedGenerationThatSpawnedChild(
              normalizedTrace,
              agent.spanId,
              nextNode.spanId,
            );
            currentGenId = genId ?? gens[gens.length - 1].startEvent.generationId;
          } else if (i === path.length - 1 && selectedGenerationId != null) {
            currentGenId = selectedGenerationId;
          } else {
            currentGenId = gens[gens.length - 1].startEvent.generationId;
          }
        } else if (gens.length === 1) {
          currentGenId = gens[0].startEvent.generationId;
        }

        items.push({
          node,
          isAgent: true,
          agent,
          currentGenerationId: currentGenId,
          availableGenerations: availableGens,
        });
      } else {
        items.push({
          node,
          isAgent: false,
        });
      }
    }

    return items;
  }, [normalizedTrace, activeNodeId, selectedGenerationId, generationSelections]);

  if (breadcrumbItems.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-1 px-3 py-2 border-b border-border bg-muted/30 text-xs">
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <span className="text-muted-foreground font-medium mr-1">PATH:</span>
        {breadcrumbItems.map((item, index) => (
          <div key={item.node.spanId} className="flex items-center gap-1">
            {item.isAgent &&
            item.agent &&
            item.availableGenerations &&
            item.availableGenerations.length > 1 ? (
              <GenerationDropdown
                hostName={item.agent.name}
                currentGenerationId={item.currentGenerationId!}
                availableGenerations={item.availableGenerations}
                onGenerationChange={(genId) => {
                  selectGeneration(item.agent!.spanId, genId);

                  const gens = getGenerationsForHost(normalizedTrace!, item.agent!.spanId);
                  const gen = gens.find((g) => g.startEvent.generationId === genId);
                  if (!gen) return;

                  const childAgents = getChildAgentsForNormalizedGeneration(normalizedTrace!, gen);

                  if (index < breadcrumbItems.length - 1) {
                    const nextItem = breadcrumbItems[index + 1];
                    const wasCalled = childAgents.some(
                      (child) => child.spanId === nextItem.node.spanId,
                    );

                    if (!wasCalled) {
                      if (childAgents.length > 0) {
                        const firstChild = childAgents[0];
                        setActiveNode(firstChild.spanId, "agent");
                        const childGens = getGenerationsForHost(
                          normalizedTrace!,
                          firstChild.spanId,
                        );
                        if (childGens.length > 0) {
                          const latestGen = childGens[childGens.length - 1];
                          selectGeneration(firstChild.spanId, latestGen.startEvent.generationId);
                        }
                      }
                    }
                  } else {
                    selectGeneration(item.agent!.spanId, genId);
                  }
                }}
              />
            ) : (
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded cursor-pointer hover:bg-muted",
                  index === breadcrumbItems.length - 1 && "font-semibold",
                )}
                onClick={() => {
                  if (item.isAgent && item.agent) {
                    setActiveNode(item.node.spanId, "agent");
                    if (item.currentGenerationId != null) {
                      selectGeneration(item.node.spanId, item.currentGenerationId);
                    }
                  } else if (item.node.type === "generation") {
                    const hostId = item.node.hostNodeId ?? item.node.parentSpanId;
                    if (!hostId || !normalizedTrace) return;
                    const host = normalizedTrace.nodeMap[hostId];
                    if (!host || host.category !== "structural") return;
                    if (host.type === "agent") {
                      setActiveNode(hostId, "agent");
                      selectGeneration(hostId, item.node.startEvent.generationId);
                    }
                  } else if (item.node.type === "runWith") {
                    setActiveNode(item.node.spanId, "runWith");
                  } else if (item.node.type === "span") {
                    setActiveNode(item.node.spanId, "span");
                  }
                }}
              >
                {item.node.name}
              </span>
            )}
            {index < breadcrumbItems.length - 1 && (
              <ChevronRight className="w-3 h-3 text-muted-foreground mx-0.5" />
            )}
          </div>
        ))}
      </div>
      {trailing != null && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
    </div>
  );
}

interface GenerationDropdownProps {
  hostName: string;
  currentGenerationId: number;
  availableGenerations: Array<{ id: number; status: ExecutionStatus; finishReason: string }>;
  onGenerationChange: (generationId: number) => void;
}

function GenerationDropdown({
  hostName,
  currentGenerationId,
  availableGenerations,
  onGenerationChange,
}: GenerationDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  const getGenerationLabel = (gen: (typeof availableGenerations)[0]) => {
    const statusLabel =
      gen.status === "success"
        ? "Success"
        : gen.status === "error"
          ? "Failed"
          : gen.status === "reborn"
            ? "Reborn"
            : gen.status;
    return `Gen ${gen.id} (${statusLabel})`;
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer hover:bg-muted border border-transparent",
            isOpen && "border-border bg-muted",
          )}
        >
          <span className="font-semibold">{hostName}</span>
          <span className="text-muted-foreground">[Gen {currentGenerationId}</span>
          <ChevronDown
            className={cn(
              "w-3 h-3 text-muted-foreground transition-transform",
              isOpen && "rotate-180",
            )}
          />
          <span className="text-muted-foreground">]</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto min-w-[200px] max-h-[300px] overflow-auto p-0 shadow-lg"
        align="start"
      >
        <div className="p-2 text-[10px] font-semibold text-muted-foreground border-b border-border">
          {hostName} Context:
        </div>
        {availableGenerations.map((gen) => {
          const genStatusConfig = getStatusConfig(gen.status);
          const isSelected = gen.id === currentGenerationId;
          return (
            <button
              key={gen.id}
              type="button"
              className={cn(
                "w-full text-left px-3 py-2 text-xs hover:bg-muted flex items-center gap-2",
                isSelected && "bg-muted font-semibold",
              )}
              onClick={() => {
                onGenerationChange(gen.id);
                setIsOpen(false);
              }}
            >
              {/* Use solid hex: STATUS_CONFIG.bgColor is /10 tint for surfaces, too faint on tiny dots */}
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: genStatusConfig.hex }}
              />
              <span className="flex-1">{getGenerationLabel(gen)}</span>
              {isSelected && <span className="text-primary">✓</span>}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
