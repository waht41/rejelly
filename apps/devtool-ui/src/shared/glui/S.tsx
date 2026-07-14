/**
 * Semantic Component (S-Component) - The Body
 *
 * Polymorphic semantic component that automatically establishes parent-child connections
 * and reports state to the Registry. GLUE: registers state schema + sync (applyStatePatch).
 *
 * Features:
 * - Polymorphism: <S as="ul"> renders as <ul>, <S as={Button}> renders as Button
 * - Auto-connection: Uses React Context to automatically handle hierarchy
 * - Data sync: Automatically updates Registry when props change
 * - State registration: Registers stateSchema and applyStatePatch for AI to drive UI state
 */
import type React from "react";
import { createContext, useContext, useEffect, useMemo } from "react";
import type { StateSchema } from "./registry";
import { useGLUIStore } from "./registry";

// ------------------------------------------------------------------
// Context (lightweight: only passes parent ID to descendants)
// ------------------------------------------------------------------

const SemanticContext = createContext<string | null>(null);

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export interface SProps<E extends React.ElementType> {
  id: string;
  as?: E; // Polymorphic rendering: 'div', 'span', 'ul', Component...
  semType?: string; // Semantic type for AI (default inferred from id prefix)
  data?: Record<string, JSONValue>; // Data exposed to AI (key state)
  desc?: string; // Description for AI

  /** Schema of the state slice AI can adjust (optional = not AI-adjustable) */
  stateSchema?: StateSchema | null;
  /** Sync: apply a partial state update from AI. Required when stateSchema is set. */
  applyStatePatch?: ((patch: Record<string, any>) => void) | null;

  children?: React.ReactNode;
}

// TypeScript Magic: Allows passing through native props
type PolymorphicProps<E extends React.ElementType> = SProps<E> &
  Omit<React.ComponentPropsWithoutRef<E>, keyof SProps<E>>;

export const S = <E extends React.ElementType = "div">({
  id,
  as,
  semType,
  data = {},
  stateSchema = null,
  applyStatePatch = null,
  desc,
  children,
  ...domProps
}: PolymorphicProps<E>) => {
  const Component = (as || "div") as React.ElementType;
  const parentId = useContext(SemanticContext);

  const register = useGLUIStore((s) => s.register);
  const unregister = useGLUIStore((s) => s.unregister);

  // Infer type: if semType not provided, use id prefix (e.g. "btn-submit" -> "btn")
  const type = semType || id.split("-")[0] || "block";

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional stability optimization
  const stableData = useMemo(() => data, [JSON.stringify(data)]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional stability optimization
  const stableStateSchema = useMemo(() => stateSchema, [JSON.stringify(stateSchema)]);

  // Register/update: report to Registry when id, parentId, data, stateSchema or applyStatePatch change
  useEffect(() => {
    register({
      id,
      parentId,
      type,
      data: stableData,
      description: desc,
      stateSchema: stableStateSchema ?? undefined,
      applyStatePatch: applyStatePatch ?? undefined,
    });
    // Auto-unregister on unmount to prevent AI from hallucinating non-existent UI
    return () => unregister(id);
  }, [
    id,
    parentId,
    type,
    desc,
    register,
    unregister,
    stableData,
    stableStateSchema,
    applyStatePatch,
  ]);

  // Render: pass current ID as Provider value so descendants can establish hierarchy
  return (
    <SemanticContext.Provider value={id}>
      <Component
        {...(domProps as any)}
        // Add markers to DOM for human developer debugging
        data-sem-id={id}
        data-sem-type={type}
      >
        {children}
      </Component>
    </SemanticContext.Provider>
  );
};
