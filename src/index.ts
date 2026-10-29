
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  IMAGE_UPLOAD_WORKER_URL: string;
  UPLOAD_ACCESS_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
};

function createServer(env: Env) {
  const server = new McpServer({
    name: "Aza Creative Uploader",
    version: "1.0.0",
  });

  server.registerTool(
    "upload_creative_to_imagekit",
    {
      description:
        "Upload a campaign creative image to ImageKit and return its hosted URL for WebEngage.",
      inputSchema: z.object({
        filename: z.string().min(1).max(200),
        contentType: z.enum([
          "image/jpeg",
          "image/png",
          "image/webp",
        ]),
        imageBase64: z.string().min(1).max(12_000_000),
      }),
    },
    async ({ filename, contentType, imageBase64 }) => {
      try {
        const cleanBase64 = imageBase64.replace(
          /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
          "",
        );

        if (
          !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64) ||
          cleanBase64.length % 4 !== 0
        ) {
          throw new Error("Invalid Base64 image data.");
        }

        const binary = atob(cleanBase64);

        if (binary.length === 0 || binary.length > 9_000_000) {
          throw new Error("Image must be smaller than 9 MB.");
        }

        const bytes = Uint8Array.from(
          binary,
          (character) => character.charCodeAt(0),
        );

        const file = new File([bytes], filename, {
          type: contentType,
        });

        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch(env.IMAGE_UPLOAD_WORKER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.UPLOAD_ACCESS_TOKEN}`,
          },
          body: formData,
        });

        const result = (await response.json()) as {
          success?: boolean;
          name?: string;
          url?: string;
          error?: string;
        };

        if (!response.ok || !result.success || !result.url) {
          throw new Error(
            result.error || `Image upload failed (${response.status}).`,
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                filename: result.name || filename,
                imageUrl: result.url,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof Error
                  ? error.message
                  : "Image upload failed.",
            },
          ],
        };
      }
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const expectedToken = `Bearer ${env.MCP_ACCESS_TOKEN}`;
    const suppliedToken = request.headers.get("Authorization") || "";

    if (
      !env.MCP_ACCESS_TOKEN ||
      suppliedToken.length !== expectedToken.length
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let mismatch = 0;

    for (let i = 0; i < expectedToken.length; i++) {
      mismatch |= suppliedToken.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    }

    if (mismatch !== 0) {
      return new Response("Unauthorized", { status: 401 });
    }

    const handler = createMcpHandler(() => createServer(env));

    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
