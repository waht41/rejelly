/**
 * Status Configuration
 *
 * Single source of truth for status styling, colors, icons, and emojis
 */

import { AlertCircle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { ExecutionStatus } from "src/entities/trace/types";

// Define unified color scheme (Tailwind classes + Hex values)
// Hex values are used for libraries like React Flow MiniMap that don't support Tailwind classes
export const STATUS_CONFIG: Record<
  ExecutionStatus | "default",
  {
    label: string;
    color: string; // Tailwind text class
    bgColor: string; // Tailwind bg class
    borderColor: string; // Tailwind border class
    hex: string; // CSS Hex code (for canvas/libraries)
    icon: any; // Lucide Icon component
    emoji: string; // For simple text fallback
  }
> = {
  success: {
    label: "Success",
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    borderColor: "border-green-500",
    hex: "#22c55e", // tailwind green-500
    icon: CheckCircle2,
    emoji: "🟢",
  },
  error: {
    label: "Error",
    color: "text-red-500",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500",
    hex: "#ef4444", // tailwind red-500
    icon: XCircle,
    emoji: "🔴",
  },
  running: {
    label: "Running",
    color: "text-yellow-500",
    bgColor: "bg-yellow-500/10",
    borderColor: "border-yellow-500",
    hex: "#eab308", // tailwind yellow-500
    icon: Loader2,
    emoji: "🟡",
  },
  pending: {
    label: "Pending",
    color: "text-muted-foreground",
    bgColor: "bg-muted/10",
    borderColor: "border-muted",
    hex: "#9ca3af", // tailwind gray-400
    icon: Circle,
    emoji: "⚪",
  },
  reborn: {
    label: "Reborn",
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500",
    hex: "#3b82f6", // tailwind blue-500
    icon: AlertCircle,
    emoji: "🔵",
  },
  default: {
    // fallback
    label: "Unknown",
    color: "text-muted-foreground",
    bgColor: "bg-muted/10",
    borderColor: "border-muted",
    hex: "#9ca3af",
    icon: Circle,
    emoji: "⚪",
  },
};

/** Resolved row from STATUS_CONFIG (same shape for every key, including `default`). */
export type StatusConfigResolved = (typeof STATUS_CONFIG)[keyof typeof STATUS_CONFIG];

// Helper: map execution status to UI tokens; `undefined` uses the unknown fallback
export function getStatusConfig(status?: ExecutionStatus): StatusConfigResolved {
  if (status === undefined) {
    return STATUS_CONFIG.default;
  }
  return STATUS_CONFIG[status];
}
