import type { Message } from "@rejelly/core";
import { z } from "zod";

export const USER_INPUT_MESSAGE_KIND = "user_input";

const fileLocatorSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace"), path: z.string() }),
  z.object({ scope: z.literal("absolute"), path: z.string() }),
]);

const userInputAttachmentDisplaySchema = z.object({
  type: z.enum(["file", "image"]),
  label: z.string(),
  action: z.enum(["read", "list", "attach"]),
  status: z.literal("error").optional(),
  // Optional so sessions written before canonical locators remain resumable.
  locator: fileLocatorSchema.optional(),
});

const userInputDisplaySchema = z.object({
  text: z.string(),
  attachments: z.array(userInputAttachmentDisplaySchema),
});

const imageDimensionsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const userInputMetadataSchema = z.object({
  kind: z.literal(USER_INPUT_MESSAGE_KIND),
  display: userInputDisplaySchema,
  /** Aligned by index with image content parts; null means the raster header was unreadable. */
  imageDimensions: z.array(imageDimensionsSchema.nullable()).optional(),
});

export type UserInputAttachmentDisplay = z.infer<typeof userInputAttachmentDisplaySchema>;
export type UserInputDisplay = z.infer<typeof userInputDisplaySchema>;
export type UserInputImageDimensions = z.infer<typeof imageDimensionsSchema>;
export type UserInputMetadata = z.infer<typeof userInputMetadataSchema>;

/** Construct the stable metadata stored beside a materialized user message. */
export function createUserInputMetadata(
  display: UserInputDisplay,
  imageDimensions: readonly (UserInputImageDimensions | null)[] = [],
): UserInputMetadata {
  return {
    kind: USER_INPUT_MESSAGE_KIND,
    ...(imageDimensions.length > 0 ? { imageDimensions: [...imageDimensions] } : {}),
    display,
  };
}

export function getUserInputDisplay(message: Message): UserInputDisplay | undefined {
  const metadata = userInputMetadataSchema.safeParse(message.extra?.rejelly);
  return metadata.success ? metadata.data.display : undefined;
}

export function getUserInputImageDimensions(
  message: Message,
): Array<UserInputImageDimensions | undefined> {
  const metadata = userInputMetadataSchema.safeParse(message.extra?.rejelly);
  return metadata.success
    ? (metadata.data.imageDimensions?.map((dimensions) => dimensions ?? undefined) ?? [])
    : [];
}
