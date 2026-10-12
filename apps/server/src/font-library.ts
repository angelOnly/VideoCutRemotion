import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MotionFontUnknownError, readMotionFontFile } from "../../../packages/motion-work/src/fonts.js";

/** 全局只读字体资源，不进入Project、素材、Job或Revision。 */
export function registerFontLibraryRoutes(server: FastifyInstance) {
  server.get("/api/motion/fonts/:fontId/file", async (request, reply) => {
    const { fontId } = z.object({ fontId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u) }).parse(request.params);
    const { sha256 } = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(request.query);
    try {
      const font = readMotionFontFile(fontId, sha256);
      return reply.header("Cache-Control", "private, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff").type(font.contentType).send(font.bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(error instanceof MotionFontUnknownError ? 404 : message.startsWith("MOTION_FONT_VERSION_MISMATCH:") ? 409 : 500)
        .header("Cache-Control", "no-store").send({ error: message.split(":")[0], message });
    }
  });
}
