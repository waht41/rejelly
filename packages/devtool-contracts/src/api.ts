import { z } from "zod/v4";

export const apiErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export const apiErrorWithCodeResponseSchema = apiErrorResponseSchema.extend({
  code: z.string().optional(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type ApiErrorWithCodeResponse = z.infer<typeof apiErrorWithCodeResponseSchema>;
