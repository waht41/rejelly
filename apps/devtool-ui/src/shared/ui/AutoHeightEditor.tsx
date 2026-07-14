/**
 * Auto-height Editor Components
 *
 * Reusable editor components with automatic height calculation.
 * AutoHeightEditor / AutoHeightDiffEditor are pure (Monaco + height only).
 * AutoHeightEditorSection / AutoHeightDiffEditorSection wrap them with CollapsibleSection for backward compatibility.
 */

import { DiffEditor, Editor } from "@monaco-editor/react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { CollapsibleSection } from "./CollapsibleSection";

// Extract type from Editor's onMount callback
export type EditorInstance = Parameters<
  NonNullable<React.ComponentProps<typeof Editor>["onMount"]>
>[0];
// Extract type from DiffEditor's onMount callback
export type DiffEditorInstance = Parameters<
  NonNullable<React.ComponentProps<typeof DiffEditor>["onMount"]>
>[0];

// Maximum height to prevent performance issues with very large content
export const MAX_EDITOR_HEIGHT = 800;
export const MIN_EDITOR_HEIGHT = 100;

// Common editor options with optimized scrollbar styling
const commonEditorOptions: React.ComponentProps<typeof Editor>["options"] = {
  readOnly: true,
  fontSize: 12,
  fontFamily: "JetBrains Mono, Fira Code, Consolas, Monaco, monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "on",
  automaticLayout: true,
  // Add padding to line number margin so code doesn't stick to the left edge
  lineDecorationsWidth: 10,
  lineNumbersMinChars: 3,
};

// --- Pure AutoHeightEditor: Monaco lifecycle + height only, no section UI ---
export interface AutoHeightEditorProps {
  value: string;
  /** Monaco language id (e.g. 'json', 'typescript'). Default 'json' */
  language?: string;
  /** Max height of the editor area. Default uses MAX_EDITOR_HEIGHT (800) */
  maxHeight?: number;
}

export function AutoHeightEditor({
  value,
  language = "json",
  maxHeight = MAX_EDITOR_HEIGHT,
}: AutoHeightEditorProps) {
  const [editorHeight, setEditorHeight] = useState(MIN_EDITOR_HEIGHT);
  const editorRef = useRef<EditorInstance | null>(null);

  const handleEditorMount = (editorInstance: EditorInstance) => {
    editorRef.current = editorInstance;

    const updateHeight = () => {
      const contentHeight = editorInstance.getContentHeight();
      // Add 2px buffer to avoid unnecessary scrollbar due to rounding errors
      const newHeight = Math.min(Math.max(contentHeight, MIN_EDITOR_HEIGHT), maxHeight) + 2;
      setEditorHeight(newHeight);
    };

    updateHeight();
    editorInstance.onDidContentSizeChange(() => {
      updateHeight();
      editorInstance.layout();
    });
  };

  useEffect(() => {
    return () => {
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ height: editorHeight }} className="transition-[height] duration-200 ease-in-out">
      <Editor
        height={editorHeight}
        language={language}
        value={value}
        onMount={handleEditorMount}
        options={{
          ...commonEditorOptions,
          scrollbar: {
            vertical: "auto",
            horizontal: "hidden",
            alwaysConsumeMouseWheel: false,
          },
        }}
        theme="vs-dark"
      />
    </div>
  );
}

// --- Auto-height editor section: CollapsibleSection + AutoHeightEditor (backward compatible) ---
export interface AutoHeightEditorSectionProps {
  title: string;
  value: string;
  /** Monaco language id (e.g. 'json', 'typescript'). Default 'json' */
  language?: string;
  /** Optional content to render on the right side of the header (e.g. view toggle) */
  rightContent?: React.ReactNode;
  /** Max height of the editor area. Default uses MAX_EDITOR_HEIGHT (800) */
  maxHeight?: number;
}

export function AutoHeightEditorSection({
  title,
  value,
  language = "json",
  rightContent,
  maxHeight = MAX_EDITOR_HEIGHT,
}: AutoHeightEditorSectionProps) {
  return (
    <CollapsibleSection title={title} rightContent={rightContent}>
      <AutoHeightEditor value={value} language={language} maxHeight={maxHeight} />
    </CollapsibleSection>
  );
}

// --- Pure AutoHeightDiffEditor: Monaco diff + height only, no section UI ---
export interface AutoHeightDiffEditorProps {
  original: string;
  modified: string;
}

export function AutoHeightDiffEditor({ original, modified }: AutoHeightDiffEditorProps) {
  const [diffEditorHeight, setDiffEditorHeight] = useState(MIN_EDITOR_HEIGHT);
  const diffEditorRef = useRef<DiffEditorInstance | null>(null);

  const handleDiffEditorMount = (editorInstance: DiffEditorInstance) => {
    diffEditorRef.current = editorInstance;
    const modifiedEditor = editorInstance.getModifiedEditor();

    modifiedEditor.updateOptions({ wordWrap: "on" });

    const calculateHeight = () => {
      const modifiedHeight = modifiedEditor.getContentHeight();
      return Math.min(Math.max(modifiedHeight, MIN_EDITOR_HEIGHT), MAX_EDITOR_HEIGHT) + 2;
    };

    setDiffEditorHeight(calculateHeight());

    const updateHeight = () => {
      setDiffEditorHeight(calculateHeight());
      editorInstance.layout();
    };

    modifiedEditor.onDidContentSizeChange(updateHeight);
  };

  useEffect(() => {
    return () => {
      if (diffEditorRef.current) {
        diffEditorRef.current.setModel(null);
        diffEditorRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ height: diffEditorHeight }}>
      <DiffEditor
        height={diffEditorHeight}
        language="json"
        original={original}
        modified={modified}
        options={{
          ...commonEditorOptions,
          renderSideBySide: false,
          scrollbar: {
            vertical: "hidden",
            horizontal: "hidden",
            useShadows: false,
            alwaysConsumeMouseWheel: false,
          },
          overviewRulerBorder: false,
        }}
        theme="vs-dark"
        onMount={handleDiffEditorMount}
      />
    </div>
  );
}

// --- Auto-height diff editor section: CollapsibleSection + AutoHeightDiffEditor (backward compatible) ---
export interface AutoHeightDiffEditorSectionProps {
  title: string;
  description?: string;
  original: string;
  modified: string;
}

export function AutoHeightDiffEditorSection({
  title,
  description,
  original,
  modified,
}: AutoHeightDiffEditorSectionProps) {
  return (
    <CollapsibleSection title={title} description={description}>
      <AutoHeightDiffEditor original={original} modified={modified} />
    </CollapsibleSection>
  );
}
