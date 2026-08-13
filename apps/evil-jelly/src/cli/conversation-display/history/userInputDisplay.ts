import type {
  UserInputAttachmentDisplay,
  UserInputDisplay,
} from "../../../shared/model/message/userInputMetadata";

function formatAttachmentDisplay(display: UserInputAttachmentDisplay): string {
  return `${display.action} ${display.label}${display.status === "error" ? " failed" : ""}`;
}

export function formatUserInputDisplay(display: UserInputDisplay): string {
  if (display.attachments.length === 0) {
    return display.text;
  }
  return `${display.text}\n${display.attachments
    .map((attachment) => `  -> ${formatAttachmentDisplay(attachment)}`)
    .join("\n")}`;
}
