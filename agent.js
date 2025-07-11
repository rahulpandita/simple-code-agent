import OpenAI from "openai";
import { readFile, writeFile } from "fs/promises";
import { exec } from "child_process";
import util from "util";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: '.env.local' });

// Configuration constants
const CONFIG = {
  // Timeout settings (in milliseconds)
  TIMEOUTS: {
    API_REQUEST: parseInt(process.env.API_TIMEOUT) || 60000,        // 60 seconds
    WEB_REQUEST: parseInt(process.env.WEB_TIMEOUT) || 30000,        // 30 seconds
    COMMAND_EXECUTION: parseInt(process.env.COMMAND_TIMEOUT) || 120000, // 2 minutes
    IMAGE_ANALYSIS: parseInt(process.env.IMAGE_TIMEOUT) || 90000,   // 90 seconds
  },
  
  // Retry settings
  RETRY: {
    MAX_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3,
    BASE_DELAY: parseInt(process.env.RETRY_BASE_DELAY) || 1000,     // 1 second
    MAX_DELAY: parseInt(process.env.RETRY_MAX_DELAY) || 30000,      // 30 seconds
    BACKOFF_MULTIPLIER: parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER) || 2,
  },
  
  // Azure settings
  AZURE: {
    API_VERSION: process.env.AZURE_API_VERSION,
    GPT_API_KEY: process.env.AZURE_GPT_API_KEY,
    GPT_ENDPOINT: process.env.AZURE_GPT_ENDPOINT,
  }
};

// Utility function for exponential backoff delay
function calculateDelay(attempt, baseDelay = CONFIG.RETRY.BASE_DELAY, multiplier = CONFIG.RETRY.BACKOFF_MULTIPLIER, maxDelay = CONFIG.RETRY.MAX_DELAY) {
  const delay = baseDelay * Math.pow(multiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

// Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generic retry wrapper with exponential backoff
async function withRetry(operation, options = {}) {
  const {
    maxAttempts = CONFIG.RETRY.MAX_ATTEMPTS,
    baseDelay = CONFIG.RETRY.BASE_DELAY,
    multiplier = CONFIG.RETRY.BACKOFF_MULTIPLIER,
    maxDelay = CONFIG.RETRY.MAX_DELAY,
    shouldRetry = (error) => true, // Default: retry on any error
    onRetry = (error, attempt) => console.log(`Retry attempt ${attempt} after error: ${error.message}`)
  } = options;

  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Don't retry on the last attempt or if shouldRetry returns false
      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      
      const delay = calculateDelay(attempt, baseDelay, multiplier, maxDelay);
      onRetry(error, attempt);
      await sleep(delay);
    }
  }
  
  throw lastError;
}

// Enhanced fetch with timeout and retry
async function fetchWithRetry(url, options = {}) {
  const {
    timeout = CONFIG.TIMEOUTS.WEB_REQUEST,
    retryOptions = {},
    ...fetchOptions
  } = options;

  return withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Check if response is ok, throw error for bad status codes that should be retried
      if (!response.ok && response.status >= 500) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Transform abort error to timeout error
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      
      throw error;
    }
  }, {
    ...retryOptions,
    shouldRetry: (error) => {
      // Retry on network errors, timeouts, and 5xx status codes
      return error.message.includes('timeout') || 
             error.message.includes('ECONNRESET') ||
             error.message.includes('ENOTFOUND') ||
             error.message.includes('ECONNREFUSED') ||
             error.message.includes('HTTP 5');
    }
  });
}

// Enhanced OpenAI API call with retry
async function openaiWithRetry(operation, options = {}) {
  return withRetry(operation, {
    ...options,
    shouldRetry: (error) => {
      // Retry on rate limits, network errors, and 5xx status codes
      return error.status === 429 || // Rate limit
             error.status >= 500 ||   // Server errors
             error.code === 'ECONNRESET' ||
             error.code === 'ENOTFOUND' ||
             error.message.includes('timeout');
    },
    onRetry: (error, attempt) => {
      if (error.status === 429) {
        console.log(`Rate limited, retry attempt ${attempt} after backoff`);
      } else {
        console.log(`API error, retry attempt ${attempt}: ${error.message}`);
      }
    }
  });
}

const openai = new OpenAI({ 
  apiKey: CONFIG.AZURE.GPT_API_KEY,
  baseURL: CONFIG.AZURE.GPT_ENDPOINT,
  defaultQuery: CONFIG.AZURE.GPT_ENDPOINT ? { 'api-version': CONFIG.AZURE.API_VERSION } : undefined,
  defaultHeaders: CONFIG.AZURE.GPT_ENDPOINT ? { 'api-key': CONFIG.AZURE.GPT_API_KEY } : undefined
});
const execAsync = util.promisify(exec);

// --- Tools definition for OpenAI ---
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the repository",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the repository",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_image",
      description: "Analyze an image file or URL and provide detailed description",
      parameters: {
        type: "object",
        properties: { 
          path: { type: "string", description: "File path to image or image URL" },
          prompt: { type: "string", description: "Optional specific question about the image", default: "Describe this image in detail" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "image_search_analysis",
      description: "Search for images using DuckDuckGo and analyze the top 3 results",
      parameters: {
        type: "object",
        properties: { 
          query: { type: "string", description: "The image search query to perform" },
          analysis_prompt: { type: "string", description: "Specific analysis question for the images", default: "Describe and analyze these images in the context of the search query" }
        },
        required: ["query"]
      }
    }
  },
  {
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
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Mark the task as complete and end the iteration",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "A summary of what was accomplished" } },
        required: ["summary"]
      }
    }
  }
];

// --- Implementations ---
async function read_file({ path: filePath }) {
  const full = path.resolve(process.cwd(), filePath);
  try {
    const txt = await readFile(full, "utf8");
    return txt;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return `Error: File '${filePath}' does not exist.`;
    } else if (error.code === 'EACCES') {
      return `Error: Permission denied accessing '${filePath}'.`;
    } else {
      return `Error reading file '${filePath}': ${error.message}`;
    }
  }
}

async function write_file({ path: filePath, content }) {
  const full = path.resolve(process.cwd(), filePath);
  try {
    await writeFile(full, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return `Error: Directory for '${filePath}' does not exist. Please create the directory first.`;
    } else if (error.code === 'EACCES') {
      return `Error: Permission denied writing to '${filePath}'.`;
    } else if (error.code === 'ENOSPC') {
      return `Error: No space left on device when writing to '${filePath}'.`;
    } else if (error.code === 'EISDIR') {
      return `Error: '${filePath}' is a directory, not a file.`;
    } else if (error.code === 'EROFS') {
      return `Error: File system is read-only, cannot write to '${filePath}'.`;
    } else {
      return `Error writing file '${filePath}': ${error.message}`;
    }
  }
}

async function run_command({ command }) {
  try {
    const { stdout, stderr } = await execAsync(command, { 
      cwd: process.cwd(),
      timeout: CONFIG.TIMEOUTS.COMMAND_EXECUTION
    });
    return stderr ? `STDERR: ${stderr}\nSTDOUT: ${stdout}` : stdout;
  } catch (error) {
    // Handle timeout specifically
    if (error.signal === 'SIGTERM' && error.killed) {
      return `Command timed out after ${CONFIG.TIMEOUTS.COMMAND_EXECUTION}ms: ${command}`;
    }
    
    // Command failed (non-zero exit code)
    return `Command failed with exit code ${error.code}:\nSTDOUT: ${error.stdout || ''}\nSTDERR: ${error.stderr || ''}\nError: ${error.message}`;
  }
}

async function done({ summary }) {
  return `Task completed: ${summary}`;
}

async function webresearch({ query }) {
  try {
    console.log(`Performing web search for: ${query}`);
    
    // Perform DuckDuckGo search with retry
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const searchResponse = await fetchWithRetry(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: CONFIG.TIMEOUTS.WEB_REQUEST
    });
    
    if (!searchResponse.ok) {
      return `Error: Failed to perform search. Status: ${searchResponse.status}`;
    }
    
    const searchHtml = await searchResponse.text();
    const $ = cheerio.load(searchHtml);
    
    // Extract search results
    const results = [];
    $('.result').slice(0, 3).each((index, element) => {
      const $result = $(element);
      const title = $result.find('.result__title a').text().trim();
      const url = $result.find('.result__url').attr('href') || $result.find('.result__title a').attr('href');
      const snippet = $result.find('.result__snippet').text().trim();
      
      if (title && url) {
        results.push({ title, url, snippet });
      }
    });
    
    if (results.length === 0) {
      return `No search results found for query: ${query}`;
    }
    
    // Fetch and summarize the content of each result with retry and timeout
    const summaries = [];
    for (const result of results) {
      try {
        console.log(`Fetching content from: ${result.url}`);
        const contentResponse = await fetchWithRetry(result.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          timeout: CONFIG.TIMEOUTS.WEB_REQUEST,
          retryOptions: {
            maxAttempts: 2, // Fewer retries for content fetching to avoid delays
            onRetry: (error, attempt) => console.log(`Retrying fetch for ${result.url}, attempt ${attempt}: ${error.message}`)
          }
        });
        
        if (contentResponse.ok) {
          const contentHtml = await contentResponse.text();
          const $content = cheerio.load(contentHtml);
          
          // Extract main content (remove scripts, styles, nav, etc.)
          $content('script, style, nav, header, footer, aside').remove();
          const textContent = $content('body').text().replace(/\s+/g, ' ').trim();
          
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
      } catch (error) {
        console.log(`Failed to fetch content from ${result.url}: ${error.message}`);
        summaries.push({
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          content: result.snippet // Fallback to snippet
        });
      }
    }
    
    // Generate summary using OpenAI with retry
    const summaryPrompt = `Summarize the following web search results for the query "${query}". Provide a concise summary that captures the key information from all sources:

${summaries.map((s, i) => `
Result ${i + 1}: ${s.title}
URL: ${s.url}
Content: ${s.content}
`).join('\n')}

Please provide a comprehensive summary that synthesizes the information from these sources:`;

    const summaryResponse = await openaiWithRetry(() => 
      openai.chat.completions.create({
        model: "gpt-41",
        messages: [{ role: "user", content: summaryPrompt }],
        max_tokens: 500
      }), {
        onRetry: (error, attempt) => console.log(`Retrying OpenAI summary generation, attempt ${attempt}: ${error.message}`)
      }
    );
    
    const summary = summaryResponse.choices[0].message.content;
    
    return `Web Research Results for "${query}":

${summary}

Sources:
${summaries.map((s, i) => `${i + 1}. ${s.title} - ${s.url}`).join('\n')}`;
    
  } catch (error) {
    return `Error performing web research: ${error.message}`;
  }
}

async function analyze_image({ path: imagePath, prompt = "Describe this image in detail" }) {
  try {
    console.log(`Analyzing image: ${imagePath}`);
    
    let imageContent;
    
    // Check if it's a URL or file path
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      // Handle web URLs - validate and fetch with retry
      try {
        // Test if URL is accessible
        const testResponse = await fetchWithRetry(imagePath, {
          method: 'HEAD',
          timeout: CONFIG.TIMEOUTS.WEB_REQUEST,
          retryOptions: {
            maxAttempts: 2,
            onRetry: (error, attempt) => console.log(`Retrying image URL check, attempt ${attempt}: ${error.message}`)
          }
        });
        
        if (!testResponse.ok) {
          return `Error: Image URL returned status ${testResponse.status}: ${imagePath}`;
        }
        
        imageContent = {
          type: "image_url",
          image_url: { url: imagePath }
        };
      } catch (error) {
        return `Error: Failed to access image URL '${imagePath}': ${error.message}`;
      }
    } else {
      // Handle local file paths
      const full = path.resolve(process.cwd(), imagePath);
      const imageBuffer = await readFile(full);
      const base64Image = imageBuffer.toString('base64');
      
      // Determine image type from file extension
      const ext = path.extname(imagePath).toLowerCase();
      let mimeType;
      switch (ext) {
        case '.jpg':
        case '.jpeg':
          mimeType = 'image/jpeg';
          break;
        case '.png':
          mimeType = 'image/png';
          break;
        case '.gif':
          mimeType = 'image/gif';
          break;
        case '.webp':
          mimeType = 'image/webp';
          break;
        default:
          mimeType = 'image/jpeg';
      }
      
      imageContent = {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`
        }
      };
    }
    
    // Create the message with image content
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          imageContent
        ]
      }
    ];
    
    // Use gpt-4-vision-preview with retry logic
    const response = await openaiWithRetry(() =>
      openai.chat.completions.create({
        model: "gpt-4-vision-preview",
        messages: messages,
        max_tokens: 500
      }), {
        onRetry: (error, attempt) => console.log(`Retrying image analysis, attempt ${attempt}: ${error.message}`)
      }
    );
    
    const analysis = response.choices[0].message.content;
    return `Image Analysis: ${analysis}`;
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      return `Error: Image file '${imagePath}' does not exist.`;
    } else if (error.code === 'EACCES') {
      return `Error: Permission denied accessing image '${imagePath}'.`;
    } else {
      return `Error analyzing image '${imagePath}': ${error.message}`;
    }
  }
}

async function image_search_analysis({ query, analysis_prompt = "Describe and analyze these images in the context of the search query" }) {
  try {
    console.log(`Performing image search for: ${query}`);
    
    // Perform DuckDuckGo image search with retry
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&iax=images&ia=images`;
    const searchResponse = await fetchWithRetry(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: CONFIG.TIMEOUTS.WEB_REQUEST
    });
    
    if (!searchResponse.ok) {
      return `Error: Failed to perform image search. Status: ${searchResponse.status}`;
    }
    
    const searchHtml = await searchResponse.text();
    const $ = cheerio.load(searchHtml);
    
    // Extract image URLs from DuckDuckGo results
    const imageUrls = [];
    
    // Try multiple selectors to find images
    const selectors = [
      'img[data-src]',
      '.tile--img__img',
      '.image-result img',
      'img[src*="duckduckgo"]'
    ];
    
    for (const selector of selectors) {
      $(selector).each((index, element) => {
        if (imageUrls.length >= 3) return false; // Stop at 3 images
        
        const $img = $(element);
        let imgUrl = $img.attr('data-src') || $img.attr('src');
        
        if (imgUrl && imgUrl.startsWith('http') && !imgUrl.includes('duckduckgo.com/y.js')) {
          imageUrls.push(imgUrl);
        }
      });
      
      if (imageUrls.length >= 3) break;
    }
    
    // Fallback: Try to extract from script tags or data attributes
    if (imageUrls.length === 0) {
      const scriptContent = $('script').text();
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          timeout: CONFIG.TIMEOUTS.WEB_REQUEST,
          retryOptions: {
            maxAttempts: 2,
            onRetry: (error, attempt) => console.log(`Retrying alternative image search, attempt ${attempt}: ${error.message}`)
          }
        });
        
        if (altResponse.ok) {
          const jsonData = await altResponse.json();
          if (jsonData.results) {
            jsonData.results.slice(0, 3).forEach(result => {
              if (result.image) {
                imageUrls.push(result.image);
              }
            });
          }
        }
      } catch (altError) {
        console.log("Alternative search method failed:", altError.message);
      }
    }
    
    // If still no images found, use some representative sample images for the query
    if (imageUrls.length === 0) {
      console.log("No images found in search results, using fallback approach");
      return `No images found for query "${query}". DuckDuckGo image search may be blocked or the page structure has changed. Consider using the analyze_image tool with specific image URLs instead.`;
    }
    
    console.log(`Found ${imageUrls.length} images to analyze`);
    
    // Analyze each image with retry logic
    const analyses = [];
    for (let i = 0; i < Math.min(imageUrls.length, 3); i++) {
      const imageUrl = imageUrls[i];
      console.log(`Analyzing image ${i + 1}: ${imageUrl}`);
      
      try {
        // Create the message with image content
        const messages = [
          {
            role: "user",
            content: [
              { 
                type: "text", 
                text: `${analysis_prompt}\n\nSearch query: "${query}"\nImage ${i + 1} of ${Math.min(imageUrls.length, 3)}:` 
              },
              {
                type: "image_url",
                image_url: { url: imageUrl }
              }
            ]
          }
        ];
        
        // Use gpt-4-vision-preview with retry logic
        const response = await openaiWithRetry(() =>
          openai.chat.completions.create({
            model: "gpt-4-vision-preview",
            messages: messages,
            max_tokens: 400
          }), {
            maxAttempts: 2, // Fewer retries for individual images
            onRetry: (error, attempt) => console.log(`Retrying analysis for image ${i + 1}, attempt ${attempt}: ${error.message}`)
          }
        );
        
        const analysis = response.choices[0].message.content;
        analyses.push({
          imageUrl: imageUrl,
          analysis: analysis,
          imageNumber: i + 1
        });
        
      } catch (imageError) {
        console.log(`Failed to analyze image ${i + 1}: ${imageError.message}`);
        analyses.push({
          imageUrl: imageUrl,
          analysis: `Failed to analyze this image: ${imageError.message}`,
          imageNumber: i + 1
        });
      }
    }
    
    // Generate combined summary using OpenAI with retry
    const summaryPrompt = `Based on the following image analyses for the search query "${query}", provide a comprehensive summary that synthesizes insights from all images:

${analyses.map(a => `
Image ${a.imageNumber}: ${a.imageUrl}
Analysis: ${a.analysis}
`).join('\n')}

Please provide a comprehensive summary that identifies patterns, themes, and key insights across these images:`;

    const summaryResponse = await openaiWithRetry(() =>
      openai.chat.completions.create({
        model: "gpt-41",
        messages: [{ role: "user", content: summaryPrompt }],
        max_tokens: 400
      }), {
        onRetry: (error, attempt) => console.log(`Retrying combined summary generation, attempt ${attempt}: ${error.message}`)
      }
    );
    
    const combinedSummary = summaryResponse.choices[0].message.content;
    
    return `Image Search Analysis Results for "${query}":

COMBINED INSIGHTS:
${combinedSummary}

INDIVIDUAL IMAGE ANALYSES:
${analyses.map(a => `
Image ${a.imageNumber}: ${a.imageUrl}
${a.analysis}
`).join('\n---\n')}`;
    
  } catch (error) {
    return `Error performing image search analysis: ${error.message}`;
  }
}

const toolHandlers = { read_file, write_file, run_command, done, webresearch, analyze_image, image_search_analysis };

// --- Agent loop function ---
async function agent(userInput, workingDir = process.cwd()) {
  // Read system prompt from file
  let systemPrompt;
  try {
    const systemPromptPath = path.resolve(__dirname, 'system_prompt.txt');
    systemPrompt = await readFile(systemPromptPath, 'utf8');
  } catch (error) {
    // Fallback to default system prompt if file doesn't exist
    systemPrompt = "You are an AI coding assistant. First try to list the contents of the repository to understand the structure before taking actions. When you have completed the task, use the 'done' tool to summarize what you accomplished.";
  }

  // First, enhance the user prompt with more details
  console.log("--- Enhancing user prompt ---");
  const enhancementPrompt = `Given the following system prompt context and user request, rewrite the user request to be more detailed, specific, and actionable while maintaining the original intent. Add technical details, best practices, and step-by-step guidance that would help accomplish the task effectively.

System Context:
${systemPrompt}

Original User Request:
${userInput}

Please provide an enhanced, more detailed version of the user request:`;

  const enhancementResponse = await openaiWithRetry(() =>
    openai.chat.completions.create({
      model: "gpt-41",
      messages: [{ role: "user", content: enhancementPrompt }]
    }), {
      onRetry: (error, attempt) => console.log(`Retrying prompt enhancement, attempt ${attempt}: ${error.message}`)
    }
  );

  const enhancedUserInput = enhancementResponse.choices[0].message.content;
  console.log("Enhanced prompt:", enhancedUserInput);
  console.log("---");

  const messages = [{ role: "system", content: systemPrompt }];

  messages.push({ role: "user", content: enhancedUserInput });

  let isTaskComplete = false;
  let turnCount = 0;
  const maxTurns = 50; // Safety limit to prevent infinite loops

  while (!isTaskComplete && turnCount < maxTurns) {
    turnCount++;
    console.log(`--- Turn ${turnCount} ---`);

    const res = await openaiWithRetry(() =>
      openai.chat.completions.create({
        model: "gpt-41",
        tools,
        messages,
        tool_choice: "auto"
      }), {
        onRetry: (error, attempt) => console.log(`Retrying main agent call (turn ${turnCount}), attempt ${attempt}: ${error.message}`)
      }
    );

    const msg = res.choices[0].message;
    
    if (msg.tool_calls) {
      messages.push(msg);
      
      for (const toolCall of msg.tool_calls) {
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        
        // Check if this is the done tool
        if (name === "done") {
          console.log("Agent marked task as complete:", args.summary);
          isTaskComplete = true;
          messages.push({ 
            role: "tool", 
            tool_call_id: toolCall.id, 
            content: `Task completed: ${args.summary}` 
          });
          break;
        }
        
        // Set working directory for file operations
        const originalCwd = process.cwd();
        process.chdir(workingDir);
        
        try {
          const result = await toolHandlers[name](args);
          console.log(`Tool ${name} result:`, result);
          messages.push({ 
            role: "tool", 
            tool_call_id: toolCall.id, 
            content: result 
          });
        } finally {
          process.chdir(originalCwd);
        }
      }

      // Only continue if task is not complete
      if (!isTaskComplete) {
        const res2 = await openaiWithRetry(() =>
          openai.chat.completions.create({ 
            model: "gpt-41", 
            messages 
          }), {
            onRetry: (error, attempt) => console.log(`Retrying follow-up response (turn ${turnCount}), attempt ${attempt}: ${error.message}`)
          }
        );
        console.log("Agent response:", res2.choices[0].message.content);
        messages.push(res2.choices[0].message);
      }
    } else {
      console.log("Agent response:", msg.content);
      messages.push(msg);
      // If no tool calls and no done signal, the agent might be waiting for more input
      // We'll break here to avoid infinite loops
      break;
    }
  }

  if (turnCount >= maxTurns) {
    console.log("Maximum number of turns reached. Task may not be complete.");
  }

  if (isTaskComplete) {
    console.log("Task completed successfully!");
  }
}

// --- Command line argument parsing ---
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log("Usage: node agent.js <repo_path> <prompt>");
    console.log("Example: node agent.js /path/to/repo 'Read the package.json file'");
    process.exit(1);
  }
  
  const repoPath = path.resolve(args[0]);
  const prompt = args.slice(1).join(' ');
  
  return { repoPath, prompt };
}

// --- Main execution ---
(async () => {
  const { repoPath, prompt } = parseArgs();
  
  // Verify the repository path exists
  try {
    const stats = await import('fs/promises').then(fs => fs.stat(repoPath));
    if (!stats.isDirectory()) {
      console.error(`Error: ${repoPath} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: Repository path ${repoPath} does not exist`);
    process.exit(1);
  }
  
  console.log(`Working in repository: ${repoPath}`);
  console.log(`Processing prompt: ${prompt}`);
  console.log('---');
  
  await agent(prompt, repoPath);
})();