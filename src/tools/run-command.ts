import { exec } from "child_process";
import util from "util";
import { CONFIG } from "../config.js";
import type { Tool, RunCommandParams } from "../types.js";

const execAsync = util.promisify(exec);

export const runCommandTool: Tool = {
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
};

export async function run_command({ command }: RunCommandParams): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: CONFIG.TIMEOUTS.COMMAND_EXECUTION
    });
    return stderr ? `STDERR: ${stderr}\nSTDOUT: ${stdout}` : stdout;
  } catch (error: unknown) {
    const err = error as {
      signal?: string;
      killed?: boolean;
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    // Handle timeout specifically
    if (err.signal === "SIGTERM" && err.killed) {
      return `Command timed out after ${CONFIG.TIMEOUTS.COMMAND_EXECUTION}ms: ${command}`;
    }

    // Command failed (non-zero exit code)
    return `Command failed with exit code ${err.code ?? "unknown"}:\n` +
      `STDOUT: ${err.stdout ?? ""}\n` +
      `STDERR: ${err.stderr ?? ""}\n` +
      `Error: ${err.message ?? "Unknown error"}`;
  }
}
