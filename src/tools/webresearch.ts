import * as cheerio from "cheerio";
import { CONFIG } from "../config.js";
import { fetchWithRetry, openaiWithRetry } from "./utils.js";
import type { Tool, WebresearchParams, SearchResult, SearchResultWithContent } from "../types.js";

export const webresearchTool: Tool = {
  type: "function",
  function: {
    name: "webresearch",
    description: "Perform a DuckDuckGo search and summarize the first three results",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query to perform" } },
      required: ["query"]
    }
  }
};

export async function webresearch({ query }: WebresearchParams): Promise<string> {
  try {
    console.log(`Performing web search for: ${query}`);

    // Perform DuckDuckGo search with retry
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const searchResponse = await fetchWithRetry(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      },
      timeout: CONFIG.TIMEOUTS.WEB_REQUEST
    });

    if (!searchResponse.ok) {
      return `Error: Failed to perform search. Status: ${searchResponse.status}`;
    }

    const searchHtml = await searchResponse.text();
    const $ = cheerio.load(searchHtml);

    // Extract search results
    const results: SearchResult[] = [];
    $(".result")
      .slice(0, 3)
      .each((index, element) => {
        const $result = $(element);
        const title = $result.find(".result__title a").text().trim();
        const url = $result.find(".result__url").attr("href") ?? $result.find(".result__title a").attr("href");
        const snippet = $result.find(".result__snippet").text().trim();

        if (title && url) {
          results.push({ title, url, snippet });
        }
      });

    if (results.length === 0) {
      return `No search results found for query: ${query}`;
    }

    // Fetch and summarize the content of each result with retry and timeout
    const summaries: SearchResultWithContent[] = [];
    for (const result of results) {
      try {
        console.log(`Fetching content from: ${result.url}`);
        const contentResponse = await fetchWithRetry(result.url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
          },
          timeout: CONFIG.TIMEOUTS.WEB_REQUEST,
          retryOptions: {
            maxAttempts: 2, // Fewer retries for content fetching to avoid delays
            onRetry: (error: unknown, attempt: number) =>
              console.log(`Retrying fetch for ${result.url}, attempt ${attempt}: ${(error as Error).message}`)
          }
        });

        if (contentResponse.ok) {
          const contentHtml = await contentResponse.text();
          const $content = cheerio.load(contentHtml);

          // Extract main content (remove scripts, styles, nav, etc.)
          $content("script, style, nav, header, footer, aside").remove();
          const textContent = $content("body").text().replace(/\s+/g, " ").trim();

          // Limit content length for summarization
          const limitedContent = textContent.substring(0, 2000);

          summaries.push({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
            content: limitedContent
          });
        } else {
          summaries.push({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
            content: result.snippet // Fallback to snippet if content fetch fails
          });
        }
      } catch (error: unknown) {
        console.log(`Failed to fetch content from ${result.url}: ${(error as Error).message}`);
        summaries.push({
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          content: result.snippet // Fallback to snippet
        });
      }
    }

    // Generate summary using OpenAI with retry
    const { openai } = await import("./utils.js");
    const summaryPrompt = `Summarize the following web search results for the query "${query}". ` +
      `Provide a concise summary that captures the key information from all sources:

${summaries
    .map(
      (s, i) => `
Result ${i + 1}: ${s.title}
URL: ${s.url}
Content: ${s.content}
`
    )
    .join("\n")}

Please provide a comprehensive summary that synthesizes the information from these sources:`;

    const summaryResponse = await openaiWithRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-41",
          messages: [{ role: "user", content: summaryPrompt }],
          max_tokens: 500
        }),
      {
        onRetry: (error: unknown, attempt: number) =>
          console.log(`Retrying OpenAI summary generation, attempt ${attempt}: ${(error as Error).message}`)
      }
    );

    const summary = summaryResponse.choices[0]?.message?.content ?? "No summary available";

    return `Web Research Results for "${query}":

${summary}

Sources:
${summaries.map((s, i) => `${i + 1}. ${s.title} - ${s.url}`).join("\n")}`;
  } catch (error: unknown) {
    return `Error performing web research: ${(error as Error).message}`;
  }
}
