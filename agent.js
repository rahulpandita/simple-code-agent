import OpenAI from "openai";
import { readFile, writeFile } from "fs/promises";
import { exec } from "child_process";
import util from "util";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: '.env.local' });

const openai = new OpenAI({ 
  apiKey: process.env.AZURE_GPT41_API_KEY,
  baseURL: process.env.AZURE_GPT41_ENDPOINT ? 
    process.env.AZURE_GPT41_ENDPOINT.replace('/chat/completions?api-version=2025-01-01-preview', '') :
    undefined,
  defaultQuery: process.env.AZURE_GPT41_ENDPOINT ? { 'api-version': '2025-01-01-preview' } : undefined,
  defaultHeaders: process.env.AZURE_GPT41_ENDPOINT ? { 'api-key': process.env.AZURE_GPT41_API_KEY } : undefined
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
    const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
    return stderr ? `STDERR: ${stderr}\nSTDOUT: ${stdout}` : stdout;
  } catch (error) {
    // Command failed (non-zero exit code)
    return `Command failed with exit code ${error.code}:\nSTDOUT: ${error.stdout || ''}\nSTDERR: ${error.stderr || ''}\nError: ${error.message}`;
  }
}

async function done({ summary }) {
  return `Task completed: ${summary}`;
}

const toolHandlers = { read_file, write_file, run_command, done };

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

  const messages = [{ role: "system", content: systemPrompt }];

  messages.push({ role: "user", content: userInput });

  let isTaskComplete = false;
  let turnCount = 0;
  const maxTurns = 10; // Safety limit to prevent infinite loops

  while (!isTaskComplete && turnCount < maxTurns) {
    turnCount++;
    console.log(`--- Turn ${turnCount} ---`);

    const res = await openai.chat.completions.create({
      model: "gpt-41",
      tools,
      messages,
      tool_choice: "auto"
    });

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
        const res2 = await openai.chat.completions.create({ 
          model: "gpt-41", 
          messages 
        });
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