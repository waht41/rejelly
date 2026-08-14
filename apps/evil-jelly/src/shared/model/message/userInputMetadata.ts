import type { Message } from "@rejelly/core";
import { z } from "zod";

export const USER_INPUT_MESSAGE_KIND = "user_input";

const fileLocatorSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace"), path: z.string() }),
  z.object({ scope: z.literal("absolute"), path: z.string() }),
]);

export const userInputAttachmentDisplaySchema = z.object({
  type: z.enum(["file", "image"]),
  label: z.string(),
  action: z.enum(["read", "list", "attach"]),
  status: z.literal("error").optional(),
  // Optional so sessions written before canonical locators remain resumable.
  locator: fileLocatorSchema.optional(),
});

export const userInputDisplaySchema = z.object({
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

const runtimeUserInputMetadata = new WeakMap<Message, UserInputMetadata>();

/** Attach a process-local projection to one immutable runtime Message without mutating its wire shape. */
export function registerRuntimeUserInputMetadata(
  message: Message,
  display: UserInputDisplay,
  imageDimensions: readonly (UserInputImageDimensions | null)[] = [],
): Message {
  runtimeUserInputMetadata.set(message, {
    kind: USER_INPUT_MESSAGE_KIND,
    ...(imageDimensions.length > 0 ? { imageDimensions: [...imageDimensions] } : {}),
    display,
  });
  return message;
}

export function getRuntimeUserInputDisplay(message: Message): UserInputDisplay | undefined {
  return runtimeUserInputMetadata.get(message)?.display;
}

export function getRuntimeUserInputImageDimensions(
  message: Message,
): Array<UserInputImageDimensions | undefined> {
  return (
    runtimeUserInputMetadata
      .get(message)
      ?.imageDimensions?.map((dimensions) => dimensions ?? undefined) ?? []
  );
}

export function copyRuntimeUserInputMetadata<T extends Message>(source: Message, target: T): T {
  const metadata = runtimeUserInputMetadata.get(source);
  if (metadata) {
    runtimeUserInputMetadata.set(target, {
      ...metadata,
      display: {
        ...metadata.display,
        attachments: metadata.display.attachments.map((attachment) => ({ ...attachment })),
      },
      ...(metadata.imageDimensions
        ? {
            imageDimensions: metadata.imageDimensions.map((dimensions) =>
              dimensions ? { ...dimensions } : null,
            ),
          }
        : {}),
    });
  }
  return target;
}

/** V1/V2 compatibility only. New runtime and stored V3 messages must not carry this metadata. */
export function getLegacyUserInputDisplay(message: Message): UserInputDisplay | undefined {
  const metadata = userInputMetadataSchema.safeParse(message.extra?.rejelly);
  return metadata.success ? metadata.data.display : undefined;
}
