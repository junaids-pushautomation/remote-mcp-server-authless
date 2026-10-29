import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  IMAGE_UPLOAD_WORKER_URL: string;
  UPLOAD_ACCESS_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
  CREATIVE_DB: D1Database;
};

function createServer(env: Env) {
  const server = new McpServer({
    name: "Aza Creative Uploader",
    version: "1.1.0",
  });

  // Existing tool: upload a creative image to ImageKit.
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

  // New tool: retrieve creatives saved for a campaign date.
  server.registerTool(
    "list_creatives_by_date",
    {
      description:
        "Retrieve Aza campaign creatives from Cloudflare D1 by campaign date. Returns original filenames, ImageKit URLs, orientations, and WebEngage target columns. Use these records to map creative URLs to matching filenames in a WebEngage CSV. Dates must use YYYY-MM-DD format.",
      inputSchema: z.object({
        campaignDate: z
          .string()
          .regex(
            /^\d{4}-\d{2}-\d{2}$/,
            "Use YYYY-MM-DD format for the campaign date.",
          ),
      }),
    },
    async ({ campaignDate }) => {
      try {
        const result = await env.CREATIVE_DB
          .prepare(
            `SELECT
               campaign_date,
               filename,
               image_url,
               orientation,
               target_column,
               content_type,
               created_at
             FROM creatives
             WHERE campaign_date = ?
             ORDER BY filename COLLATE NOCASE ASC
             LIMIT 500`,
          )
          .bind(campaignDate)
          .all<{
            campaign_date: string;
            filename: string;
            image_url: string;
            orientation: string;
            target_column: string;
            content_type: string | null;
            created_at: string | null;
          }>();

        const creatives = result.results ?? [];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                campaignDate,
                count: creatives.length,
                creatives,
                message:
                  creatives.length > 0
                    ? `Found ${creatives.length} creative(s) for ${campaignDate}.`
                    : `No creatives found for ${campaignDate}.`,
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
                  ? `Failed to retrieve creatives: ${error.message}`
                  : "Failed to retrieve creatives from the database.",
            },
          ],
        };
      }
    },
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) {
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
      mismatch |=
        suppliedToken.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    }

    if (mismatch !== 0) {
      return new Response("Unauthorized", { status: 401 });
    }

    const handler = createMcpHandler(() => createServer(env));

    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
