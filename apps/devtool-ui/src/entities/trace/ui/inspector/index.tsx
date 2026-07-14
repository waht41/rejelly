/**
 * Inspector High-Level Components
 *
 * Molecular-level components that encapsulate common patterns.
 * Built on top of primitives, providing "fill-in-the-form" API instead of "build-with-blocks".
 */

import type { ComponentType, ReactNode } from "react";
import * as Primitives from "./primitives";

// Re-export primitives for advanced use cases
export * from "./primitives";

interface InspectorHeaderProps {
  icon?: ReactNode | ComponentType<{ className?: string }>;
  title: string;
  status?: ReactNode;
  metaItems?: Array<{ icon?: ReactNode; label: string; value?: string }>;
  rightContent?: ReactNode;
  className?: string;
}

/**
 * High-level header component
 * Encapsulates the common pattern: icon + title + status + meta row
 */
export function InspectorHeader({
  icon: IconOrNode,
  title,
  status,
  metaItems = [],
  rightContent,
  className,
}: InspectorHeaderProps) {
  let iconElement: ReactNode = null;
  if (IconOrNode) {
    if (typeof IconOrNode === "function") {
      const IconComponent = IconOrNode as ComponentType<{ className?: string }>;
      iconElement = <IconComponent className="w-4 h-4" />;
    } else {
      iconElement = IconOrNode;
    }
  }

  return (
    <Primitives.InspectorHeader className={className}>
      <Primitives.InspectorTitleRow>
        <div className="flex items-center gap-2">
          {iconElement}
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {status}
          {rightContent}
        </div>
      </Primitives.InspectorTitleRow>
      {metaItems.length > 0 && (
        <Primitives.InspectorMetaRow>
          {metaItems.map((item, index) => (
            <div key={index} className="flex items-center gap-1">
              {item.icon}
              <span>{item.label}</span>
              {item.value && <span className="font-mono">{item.value}</span>}
            </div>
          ))}
        </Primitives.InspectorMetaRow>
      )}
    </Primitives.InspectorHeader>
  );
}

interface InspectorSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  variant?: "default" | "error";
  contentClassName?: string;
  className?: string;
}

/**
 * High-level section component
 * Encapsulates the common pattern: section header (title + description) + content
 */
export function InspectorSection({
  title,
  description,
  children,
  variant = "default",
  contentClassName,
  className,
}: InspectorSectionProps) {
  return (
    <Primitives.InspectorSection className={className}>
      <Primitives.InspectorSectionHeader variant={variant}>
        {variant === "error" ? (
          <Primitives.InspectorErrorTitle>{title}</Primitives.InspectorErrorTitle>
        ) : (
          <>
            <Primitives.InspectorSectionTitle>{title}</Primitives.InspectorSectionTitle>
            {description && (
              <Primitives.InspectorSectionDescription>
                {description}
              </Primitives.InspectorSectionDescription>
            )}
          </>
        )}
      </Primitives.InspectorSectionHeader>
      <Primitives.InspectorSectionContent className={contentClassName}>
        {children}
      </Primitives.InspectorSectionContent>
    </Primitives.InspectorSection>
  );
}

interface InspectorEmptySectionProps {
  message: string;
  className?: string;
}

/**
 * Empty section component for displaying empty states
 */
export function InspectorEmptySection({ message, className }: InspectorEmptySectionProps) {
  return (
    <Primitives.InspectorSection className={className}>
      <div className="p-4">
        <div className="text-xs text-muted-foreground text-center">{message}</div>
      </div>
    </Primitives.InspectorSection>
  );
}

// Export as namespace with both primitives and high-level components
export const Inspector = {
  // Primitives (for advanced customization)
  ...Primitives.Inspector,
  // High-level components (for common patterns)
  Header: InspectorHeader,
  Section: InspectorSection,
  EmptySection: InspectorEmptySection,
};
