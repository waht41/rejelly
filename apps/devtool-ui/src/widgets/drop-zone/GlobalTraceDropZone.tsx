import { useTraceFileLoader } from "@features/load-trace/useTraceFileLoader";
import type React from "react";
import { useRef, useState } from "react";

interface GlobalTraceDropZoneProps {
  children: React.ReactNode;
}

export function GlobalTraceDropZone({ children }: GlobalTraceDropZoneProps) {
  const { handleFile } = useTraceFileLoader();
  const [isDragging, setIsDragging] = useState(false);

  // Use ref to track enter/leave depth and fix drag flicker
  const dragCounter = useRef(0);

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    // Only clear dragging state when fully left the main container
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    // Must prevent default so that onDrop can fire
    e.preventDefault();
    e.stopPropagation();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div
      className="h-screen w-screen overflow-hidden relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}

      {isDragging && (
        <div
          // pointer-events-none so overlay does not intercept drag events
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-none pointer-events-none"
          aria-hidden
        >
          <span className="text-lg font-medium text-primary">Drop to load trace</span>
        </div>
      )}
    </div>
  );
}
