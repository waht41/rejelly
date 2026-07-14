/**
 * Inspector UI Primitives
 *
 * Atomic UI components for building Inspector layouts with consistent styling.
 * Use composition pattern to build custom Inspector layouts while maintaining visual consistency.
 */

import { cn } from "@shared/lib/style";
import type { ReactNode } from "react";

/**
 * Root container for Inspector components
 * Provides flex column layout and full height
 */
export function InspectorRoot({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("h-full flex flex-col", className)}>{children}</div>;
}

/**
 * Header container for Inspector
 * Provides consistent padding and border styling
 */
export function InspectorHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("p-3 border-b border-border", className)}>{children}</div>;
}

/**
 * Title row within Inspector header
 * Displays icon, title, and optional right-side content (e.g., StatusBadge)
 */
export function InspectorTitleRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex items-center justify-between mb-2", className)}>{children}</div>;
}

/**
 * Meta row within Inspector header
 * Displays metadata items (duration, ID, type, etc.)
 */
export function InspectorMetaRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-4 text-[10px] text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/**
 * Scrollable content container for Inspector body
 * Provides flex-1 and overflow-auto for scrollable content
 */
export function InspectorContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex-1 overflow-auto", className)}>{children}</div>;
}

/**
 * Section container for Inspector content
 * Provides consistent border styling between sections
 */
export function InspectorSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("border-b border-border", className)}>{children}</div>;
}

/**
 * Section header with title and optional description
 * Provides consistent styling for section headers
 */
export function InspectorSectionHeader({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: "default" | "error";
}) {
  return (
    <div
      className={cn(
        "p-2 border-b border-border",
        variant === "default" && "bg-muted/30",
        variant === "error" && "bg-red-500/10 border-red-500/20",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Section title text
 */
export function InspectorSectionTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("text-xs font-semibold text-foreground", className)}>{children}</div>;
}

/**
 * Section description text
 */
export function InspectorSectionDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("text-[10px] text-muted-foreground mt-0.5", className)}>{children}</div>
  );
}

/**
 * Section content container
 * Provides consistent padding for section content
 */
export function InspectorSectionContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("p-3 space-y-2", className)}>{children}</div>;
}

/**
 * Error section title (red variant)
 */
export function InspectorErrorTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("text-xs font-semibold text-red-500", className)}>{children}</div>;
}

// Export as namespace for better organization
export const Inspector = {
  Root: InspectorRoot,
  Header: InspectorHeader,
  TitleRow: InspectorTitleRow,
  MetaRow: InspectorMetaRow,
  Content: InspectorContent,
  Section: InspectorSection,
  SectionHeader: InspectorSectionHeader,
  SectionTitle: InspectorSectionTitle,
  SectionDescription: InspectorSectionDescription,
  SectionContent: InspectorSectionContent,
  ErrorTitle: InspectorErrorTitle,
};
