import { Box, Text, useInput } from "ink";
import { usePromptStore } from "../../store/usePromptStore";

export function ConfirmPrompt({ message, defaultYes }: { message: string; defaultYes: boolean }) {
  const submitConfirm = usePromptStore((s) => s.submitConfirm);
  useInput((input, key) => {
    if (key.return) {
      submitConfirm(defaultYes);
      return;
    }
    if (input === "y" || input === "Y") {
      submitConfirm(true);
      return;
    }
    if (input === "n" || input === "N") {
      submitConfirm(false);
      return;
    }
    if (key.escape) {
      submitConfirm(false);
    }
  });

  const hint = defaultYes ? "Y/n" : "y/N";
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="yellowBright"
      paddingX={1}
    >
      <Text bold color="yellowBright">
        Confirmation required
      </Text>
      <Text color="white">{message}</Text>
      <Text color="yellow">[{hint}] Enter = default · Esc = no</Text>
    </Box>
  );
}
