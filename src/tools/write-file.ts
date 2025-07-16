import { writeFile } from "fs/promises";
import path from "path";
import type { Tool, WriteFileParams } from "../types.js";

export const writeFileTool: Tool = {
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
};

export async function write_file({ path: filePath, content }: WriteFileParams): Promise<string> {
  const full = path.resolve(process.cwd(), filePath);
  try {
    await writeFile(full, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === "ENOENT") {
      return `Error: Directory for '${filePath}' does not exist. Please create the directory first.`;
    } else if (err.code === "EACCES") {
      return `Error: Permission denied writing to '${filePath}'.`;
    } else if (err.code === "ENOSPC") {
      return `Error: No space left on device when writing to '${filePath}'.`;
    } else if (err.code === "EISDIR") {
      return `Error: '${filePath}' is a directory, not a file.`;
    } else if (err.code === "EROFS") {
      return `Error: File system is read-only, cannot write to '${filePath}'.`;
    } else {
      return `Error writing file '${filePath}': ${err.message ?? "Unknown error"}`;
    }
  }
}
