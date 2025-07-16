import * as cheerio from "cheerio";
import type { ChatCompletionMessageParam, ChatCompletion } from "openai/resources/chat/completions";
import { CONFIG } from "../config.js";
import { fetchWithRetry, openaiWithRetry } from "./utils.js";
import type { Tool, ImageSearchAnalysisParams, Message, ImageAnalysisResult } from "../types.js";

export const imageSearchAnalysisTool: Tool = {
  type: "function",
  function: {
    name: "image_search_analysis",
    description: "Search for images using DuckDuckGo and analyze the top 3 results",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The image search query to perform" },
        analysis_prompt: {
          type: "string",
          description: "Specific analysis question for the images",
          default: "Describe and analyze these images in the context of the search query"
        }
      },
      required: ["query"]
    }
  }
};

export async function image_search_analysis({
  query,
  analysis_prompt = "Describe and analyze these images in the context of the search query"
}: ImageSearchAnalysisParams): Promise<string> {
  try {
    console.log(`Performing image search for: ${query}`);

    // Perform DuckDuckGo image search with retry
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&iax=images&ia=images`;
    const searchResponse = await fetchWithRetry(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      },
      timeout: CONFIG.TIMEOUTS.WEB_REQUEST
    });

    if (!searchResponse.ok) {
      return `Error: Failed to perform image search. Status: ${searchResponse.status}`;
    }

    const searchHtml = await searchResponse.text();
    const $ = cheerio.load(searchHtml);

    // Extract image URLs from DuckDuckGo results
    const imageUrls: string[] = [];

    // Try multiple selectors to find images
    const selectors = ["img[data-src]", ".tile--img__img", ".image-result img", "img[src*=\"duckduckgo\"]"];

    for (const selector of selectors) {
      $(selector).each((index, element) => {
        if (imageUrls.length >= 3) {
          return false;
        } // Stop at 3 images

        const $img = $(element);
        const imgUrl = $img.attr("data-src") ?? $img.attr("src");

        if (imgUrl && imgUrl.startsWith("http") && !imgUrl.includes("duckduckgo.com/y.js")) {
          imageUrls.push(imgUrl);
        }

        return true; // Continue iteration
      });

      if (imageUrls.length >= 3) {
        break;
      }
    }

    // Fallback: Try to extract from script tags or data attributes
    if (imageUrls.length === 0) {
      const scriptContent = $("script").text();
      const imageMatches = scriptContent.match(/https:\/\/[^"'\s]+\.(jpg|jpeg|png|gif|webp)/gi);
      if (imageMatches) {
        imageUrls.push(...imageMatches.slice(0, 3));
      }
    }

    if (imageUrls.length === 0) {
      // Try alternative approach with direct image search API-style URL
      const altSearchUrl = `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&o=json`;
      try {
        const altResponse = await fetchWithRetry(altSearchUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
          },
          timeout: CONFIG.TIMEOUTS.WEB_REQUEST,
          retryOptions: {
            maxAttempts: 2,
            onRetry: (error: unknown, attempt: number) =>
              console.log(`Retrying alternative image search, attempt ${attempt}: ${(error as Error).message}`)
          }
        });

        if (altResponse.ok) {
          const jsonData = (await altResponse.json());
          const data = jsonData as { results?: { image?: string }[] };
          if (data?.results) {
            data.results.slice(0, 3).forEach(result => {
              if (result.image) {
                imageUrls.push(result.image);
              }
            });
          }
        }
      } catch (altError: unknown) {
        console.log("Alternative search method failed:", (altError as Error).message);
      }
    }

    // If still no images found, use some representative sample images for the query
    if (imageUrls.length === 0) {
      console.log("No images found in search results, using fallback approach");
      return `No images found for query "${query}". DuckDuckGo image search may be blocked or the page ` +
        "structure has changed. Consider using the analyze_image tool with specific image URLs instead.";
    }

    console.log(`Found ${imageUrls.length} images to analyze`);

    // Analyze each image with retry logic
    const analyses: ImageAnalysisResult[] = [];
    for (let i = 0; i < Math.min(imageUrls.length, 3); i++) {
      const imageUrl = imageUrls[i];
      if (!imageUrl) {
        continue;
      } // Skip if imageUrl is undefined

      console.log(`Analyzing image ${i + 1}: ${imageUrl}`);

      try {
        // Create the message with image content
        const messages: Message[] = [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${analysis_prompt}\n\nSearch query: "${query}"\nImage ${i + 1} of ${Math.min(
                  imageUrls.length,
                  3
                )}:`
              },
              {
                type: "image_url",
                image_url: { url: imageUrl }
              }
            ]
          }
        ];

        // Use gpt-4-vision-preview with retry logic
        const { openai } = await import("./utils.js");
        const response = (await openaiWithRetry(
          () =>
            openai.chat.completions.create({
              model: "gpt-4-vision-preview",
              messages: messages as ChatCompletionMessageParam[],
              max_tokens: 400
            }),
          {
            maxAttempts: 2, // Fewer retries for individual images
            onRetry: (error: unknown, attempt: number) =>
              console.log(`Retrying analysis for image ${i + 1}, attempt ${attempt}: ${(error as Error).message}`)
          }
        )) as ChatCompletion;

        const analysis = response.choices[0]?.message?.content ?? "No analysis available";
        analyses.push({
          imageUrl,
          analysis,
          imageNumber: i + 1
        });
      } catch (imageError: unknown) {
        console.log(`Failed to analyze image ${i + 1}: ${(imageError as Error).message}`);
        analyses.push({
          imageUrl,
          analysis: `Failed to analyze this image: ${(imageError as Error).message}`,
          imageNumber: i + 1
        });
      }
    }

    // Generate combined summary using OpenAI with retry
    const { openai } = await import("./utils.js");
    const summaryPrompt = `Based on the following image analyses for the search query "${query}", ` +
      `provide a comprehensive summary that synthesizes insights from all images:

${analyses
    .map(
      a => `
Image ${a.imageNumber}: ${a.imageUrl}
Analysis: ${a.analysis}
`
    )
    .join("\n")}

Please provide a comprehensive summary that identifies patterns, themes, and key insights across these images:`;

    const summaryResponse = await openaiWithRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-41",
          messages: [{ role: "user", content: summaryPrompt }],
          max_tokens: 400
        }),
      {
        onRetry: (error: unknown, attempt: number) =>
          console.log(`Retrying combined summary generation, attempt ${attempt}: ${(error as Error).message}`)
      }
    );

    const combinedSummary = summaryResponse.choices[0]?.message?.content ?? "No summary available";

    return `Image Search Analysis Results for "${query}":

COMBINED INSIGHTS:
${combinedSummary}

INDIVIDUAL IMAGE ANALYSES:
${analyses
    .map(
      a => `
Image ${a.imageNumber}: ${a.imageUrl}
${a.analysis}
`
    )
    .join("\n---\n")}`;
  } catch (error: unknown) {
    return `Error performing image search analysis: ${(error as Error).message}`;
  }
}
