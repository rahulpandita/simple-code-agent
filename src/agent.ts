import type { ChatCompletionMessageParam, ChatCompletion } from "openai/resources/chat/completions";
import { readFile, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { openaiWithRetry, openai } from "./tools/utils.js";
import type { Message } from "./types.js";

// Import all tools
import { readFileTool, read_file } from "./tools/read-file.js";
import { writeFileTool, write_file } from "./tools/write-file.js";
import { runCommandTool, run_command } from "./tools/run-command.js";
import { doneTool, done } from "./tools/done.js";
import { webresearchTool, webresearch } from "./tools/webresearch.js";
import { analyzeImageTool, analyze_image } from "./tools/analyze-image.js";
import { imageSearchAnalysisTool, image_search_analysis } from "./tools/image-search-analysis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tools array
const tools = [
  readFileTool,
  writeFileTool,
  runCommandTool,
  analyzeImageTool,
  imageSearchAnalysisTool,
  webresearchTool,
  doneTool
];

// Tool handlers map
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolHandlers: Record<string, (args: any) => Promise<string>> = {
  read_file,
  write_file,
  run_command,
  done,
  webresearch,
  analyze_image,
  image_search_analysis
};

// --- Agent loop function ---
async function agent(userInput: string, workingDir: string = process.cwd()): Promise<void> {
  // Read system prompt from file
  let systemPrompt: string;
  try {
    const systemPromptPath = path.resolve(__dirname, "system_prompt.txt");
    systemPrompt = await readFile(systemPromptPath, "utf8");
  } catch {
    // Fallback to default system prompt if file doesn't exist
    systemPrompt =
      "You are an AI coding assistant. First try to list the contents of the repository to understand the " +
      "structure before taking actions. When you have completed the task, use the 'done' tool to summarize " +
      "what you accomplished.";
  }

  // First, enhance the user prompt with more details
  console.log("--- Enhancing user prompt ---");
  // First, enhance the user prompt with more details
  console.log("--- Enhancing user prompt ---");
  const enhancementPrompt =
    "Given the following system prompt context and user request, rewrite the user request to be " +
    "more detailed, specific, and actionable while maintaining the original intent. Add technical details, " +
    "best practices, and step-by-step guidance that would help accomplish the task effectively.\n\n" +
    `System Context:\n${systemPrompt}\n\nOriginal User Request:\n${userInput}\n\n` +
    "Please provide an enhanced, more detailed version of the user request:";

  const enhancementResponse = await openaiWithRetry(
    () =>
      openai.chat.completions.create({
        model: "gpt-41",
        messages: [{ role: "user", content: enhancementPrompt }]
      }),
    {
      onRetry: (error: unknown, attempt: number) =>
        console.log(`Retrying prompt enhancement, attempt ${attempt}: ${(error as Error).message}`)
    }
  ) as ChatCompletion;

  const enhancedUserInput = enhancementResponse.choices[0]?.message?.content ?? userInput;
  console.log("Enhanced prompt:", enhancedUserInput);
  console.log("---");

  const messages: Message[] = [{ role: "system", content: systemPrompt }];

  messages.push({ role: "user", content: enhancedUserInput });

  let isTaskComplete = false;
  let turnCount = 0;
  const maxTurns = 50; // Safety limit to prevent infinite loops

  while (!isTaskComplete && turnCount < maxTurns) {
    turnCount++;
    console.log(`--- Turn ${turnCount} ---`);

    const res = (await openaiWithRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-41",
          tools,
          messages: messages as ChatCompletionMessageParam[],
          tool_choice: "auto"
        }),
      {
        onRetry: (error: unknown, attempt: number) =>
          console.log(`Retrying main agent call (turn ${turnCount}), attempt ${attempt}: ${(error as Error).message}`)
      }
    )) as ChatCompletion;

    const msg = res.choices[0]?.message;
    if (!msg) {
      continue;
    }

    if (msg.tool_calls) {
      messages.push(msg as Message);

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
          const handler = toolHandlers[name];
          if (!handler) {
            throw new Error(`Unknown tool: ${name}`);
          }
          const result = await handler(args);
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
        const res2 = (await openaiWithRetry(
          () =>
            openai.chat.completions.create({
              model: "gpt-41",
              messages: messages as ChatCompletionMessageParam[]
            }),
          {
            onRetry: (error: unknown, attempt: number) =>
              console.log(
                `Retrying follow-up response (turn ${turnCount}), attempt ${attempt}: ${(error as Error).message}`
              )
          }
        )) as ChatCompletion;
        const content = res2.choices[0]?.message?.content;
        if (content) {
          console.log("Agent response:", content);
          messages.push({ role: "assistant", content });
        }
      }
    } else {
      console.log("Agent response:", msg.content);
      messages.push(msg as Message);
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
function parseArgs(): { repoPath: string; prompt: string } {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: node agent.js <repo_path> <prompt>");
    console.log("Example: node agent.js /path/to/repo 'Read the package.json file'");
    process.exit(1);
  }

  const repoPath = path.resolve(args[0] as string);
  const prompt = args.slice(1).join(" ");

  return { repoPath, prompt };
}

// --- Main execution ---
(async () => {
  const { repoPath, prompt } = parseArgs();

  // Verify the repository path exists
  try {
    const stats = await stat(repoPath);
    if (!stats.isDirectory()) {
      console.error(`Error: ${repoPath} is not a directory`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: Repository path ${repoPath} does not exist`);
    process.exit(1);
  }

  console.log(`Working in repository: ${repoPath}`);
  console.log(`Processing prompt: ${prompt}`);
  console.log("---");

  await agent(prompt, repoPath);
})().catch(error => {
  console.error("Error running agent:", error);
  process.exit(1);
});
