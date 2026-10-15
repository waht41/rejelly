import {
  apiErrorResponseSchema,
  attachmentHashSchema,
  attachmentMimeTypeSchema,
  attachmentUploadResponseSchema,
} from "@rejelly/devtool-contracts";
import type { FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod/v4";
import {
  AttachmentUploadError,
  MAX_ATTACHMENT_BYTES,
  validateImageUpload,
} from "../../capabilities/trace-attachments/images";
import { readAttachment, storeAttachment } from "../../capabilities/trace-attachments/store";

export async function attachmentRoutes(fastify: FastifyInstance) {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  // Scoped to this plugin: trace ingestion remains JSON-only.
  fastify.addContentTypeParser(
    attachmentMimeTypeSchema.options,
    { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
    (_request, body, done) => done(null, body),
  );
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  let uploadsInFlight = 0;

  app.post<{ Body: Buffer }>(
    "",
    {
      bodyLimit: MAX_ATTACHMENT_BYTES,
      schema: {
        tags: ["attachments"],
        summary: "Upload a raw raster image as a content-addressed attachment",
        response: {
          200: attachmentUploadResponseSchema,
          400: apiErrorResponseSchema,
          413: apiErrorResponseSchema,
          415: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({
          error: "Unsupported Media Type",
          message: "Send raw image bytes, not JSON or base64",
        });
      }
      // Bound expensive pixel decoding separately from the HTTP byte limit.
      if (uploadsInFlight >= 2) {
        return reply
          .header("Retry-After", "1")
          .code(503)
          .send({ error: "Attachment uploads busy" });
      }
      uploadsInFlight++;
      try {
        const mimeType = await validateImageUpload(
          request.body,
          request.headers["content-type"] ?? "",
        );
        return storeAttachment(request.body, mimeType);
      } catch (error) {
        if (!(error instanceof AttachmentUploadError)) throw error;
        return reply
          .code(error.statusCode)
          .send({ error: "Invalid attachment", message: error.message });
      } finally {
        uploadsInFlight--;
      }
    },
  );

  app.get(
    "/:hash",
    {
      schema: {
        tags: ["attachments"],
        summary: "Read the original image bytes of an attachment",
        params: z.object({ hash: attachmentHashSchema }),
        response: {
          // Fastify sends Buffers directly, bypassing JSON serialization.
          200: z.unknown().meta({ type: "string", format: "binary" }),
          304: z.null().optional(),
          400: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const attachment = readAttachment(request.params.hash);
      if (!attachment) return reply.code(404).send({ error: "Attachment not found" });
      const etag = `"${request.params.hash}"`;
      reply
        .header("ETag", etag)
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff");
      const matches = request.headers["if-none-match"]?.split(",").some((value) => {
        const candidate = value.trim().replace(/^W\//, "");
        return candidate === etag || candidate === "*";
      });
      if (matches) return reply.code(304).send(undefined);
      return reply
        .code(200)
        .type(attachment.mimeType)
        .header("Content-Length", attachment.byteSize)
        .send(attachment.data);
    },
  );
}
