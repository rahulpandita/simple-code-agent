import { readFile } from "fs/promises";
import path from "path";
import type { ChatCompletionMessageParam, ChatCompletion } from "openai/resources/chat/completions";
import { CONFIG } from "../config.js";
import { fetchWithRetry, openaiWithRetry } from "./utils.js";
import type { Tool, AnalyzeImageParams, Message } from "../types.js";

export const analyzeImageTool: Tool = {
  type: "function",
  function: {
    name: "analyze_image",
    description: "Analyze an image file or URL and provide detailed description",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to image or image URL" },
        prompt: {
          type: "string",
          description: "Optional specific question about the image",
          default: "Describe this image in detail"
        }
      },
      required: ["path"]
    }
  }
};

export async function analyze_image({
  path: imagePath,
  prompt = "Describe this image in detail"
}: AnalyzeImageParams): Promise<string> {
  try {
    console.log(`Analyzing image: ${imagePath}`);

    let imageContent: { type: string; image_url: { url: string } };

    // Check if it's a URL or file path
    if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
      // Handle web URLs - validate and fetch with retry
      try {
        // Test if URL is accessible
        const testResponse = await fetchWithRetry(imagePath, {
          method: "HEAD",
          timeout: CONFIG.TIMEOUTS.WEB_REQUEST,
          retryOptions: {
            maxAttempts: 2,
            onRetry: (error: unknown, attempt: number) =>
              console.log(`Retrying image URL check, attempt ${attempt}: ${(error as Error).message}`)
          }
        });

        if (!testResponse.ok) {
          return `Error: Image URL returned status ${testResponse.status}: ${imagePath}`;
        }

        imageContent = {
          type: "image_url",
          image_url: { url: imagePath }
        };
      } catch (error: unknown) {
        return `Error: Failed to access image URL '${imagePath}': ${(error as Error).message}`;
      }
    } else {
      // Handle local file paths
      const full = path.resolve(process.cwd(), imagePath);
      const imageBuffer = await readFile(full);
      const base64Image = imageBuffer.toString("base64");

      // Determine image type from file extension
      const ext = path.extname(imagePath).toLowerCase();
      let mimeType: string;
      switch (ext) {
      case ".jpg":
      case ".jpeg":
        mimeType = "image/jpeg";
        break;
      case ".png":
        mimeType = "image/png";
        break;
      case ".gif":
        mimeType = "image/gif";
        break;
      case ".webp":
        mimeType = "image/webp";
        break;
      default:
        mimeType = "image/jpeg";
      }

      imageContent = {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`
        }
      };
    }

    // Create the message with image content
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: prompt }, imageContent]
      }
    ];

    // Use gpt-4-vision-preview with retry logic
    const { openai } = await import("./utils.js");
    const response = (await openaiWithRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-4-vision-preview",
          messages: messages as ChatCompletionMessageParam[],
          max_tokens: 500
        }),
      {
        onRetry: (error: unknown, attempt: number) =>
          console.log(`Retrying image analysis, attempt ${attempt}: ${(error as Error).message}`)
      }
    )) as ChatCompletion;

    const analysis = response.choices[0]?.message?.content ?? "No analysis available";
    return `Image Analysis: ${analysis}`;
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === "ENOENT") {
      return `Error: Image file '${imagePath}' does not exist.`;
    } else if (err.code === "EACCES") {
      return `Error: Permission denied accessing image '${imagePath}'.`;
    } else {
      return `Error analyzing image '${imagePath}': ${err.message ?? "Unknown error"}`;
    }
  }
}
