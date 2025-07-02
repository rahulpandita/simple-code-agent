import OpenAI from "openai";
import { readFile, writeFile } from "fs/promises";
import { exec } from "child_process";
import util from "util";
import path from "path";
import dotenv from "dotenv";
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
  }
];

// --- Implementations ---
async function read_file({ path: filePath }) {
  const full = path.resolve(process.cwd(), filePath);
  const txt = await readFile(full, "utf8");
  return txt;
}

async function write_file({ path: filePath, content }) {
  const full = path.resolve(process.cwd(), filePath);
  await writeFile(full, content, "utf8");
  return `Wrote ${content.length} bytes to ${filePath}`;
}

async function run_command({ command }) {
  const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
  return stderr ? `ERR: ${stderr}` : stdout;
}

const toolHandlers = { read_file, write_file, run_command };

// --- Agent loop function ---
async function agent(userInput, workingDir = process.cwd()) {
  const messages = [{ role: "system", content: "You are an AI coding assistant." }];

  messages.push({ role: "user", content: userInput });

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
      
      // Set working directory for file operations
      const originalCwd = process.cwd();
      process.chdir(workingDir);
      
      try {
        const result = await toolHandlers[name](args);
        messages.push({ 
          role: "tool", 
          tool_call_id: toolCall.id, 
          content: result 
        });
      } finally {
        process.chdir(originalCwd);
      }
    }

    const res2 = await openai.chat.completions.create({ model: "gpt-41", messages });
    console.log(res2.choices[0].message.content);
  } else {
    console.log(msg.content);
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