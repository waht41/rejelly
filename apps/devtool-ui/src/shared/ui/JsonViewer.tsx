/**
 * Generic JSON Viewer Component
 *
 * A reusable component for displaying JSON data without any business logic
 */

import { Editor } from "@monaco-editor/react";
import { useMemo } from "react";

interface JsonViewerProps {
  data: unknown;
}

export function JsonViewer({ data }: JsonViewerProps) {
  // Use useMemo to avoid stringify on every render
  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);

  return (
    <div className="h-full">
      <Editor
        height="100%"
        language="json"
        value={jsonString}
        options={{
          readOnly: true,
          fontSize: 12,
          fontFamily: "JetBrains Mono, Fira Code, Consolas, Monaco, monospace",
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
        }}
        theme="vs-dark"
      />
    </div>
  );
}
