import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useDecisionStore } from "./decisionStore";

function dropLastCodePoint(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

/** Plain one-line response surface for a blocking operator decision. */
export function TextDecisionPrompt({ label }: { label: string }) {
  const [value, setValue] = useState("");
  const submitText = useDecisionStore((state) => state.submitText);

  useInput((input, key) => {
    if (key.return) {
      submitText(value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => dropLastCodePoint(current));
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setValue((current) => current + input);
    }
  });

  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold>{label || "Response:"} </Text>
      <Text>{value}</Text>
    </Box>
  );
}
