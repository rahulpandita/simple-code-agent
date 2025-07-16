import { readFile } from "fs/promises";
import path from "path";
import type { Tool, ReadFileParams } from "../types.js";

export const readFileTool: Tool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from the repository",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
};

export async function read_file({ path: filePath }: ReadFileParams): Promise<string> {
  const full = path.resolve(process.cwd(), filePath);
  try {
    const txt = await readFile(full, "utf8");
    return txt;
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === "ENOENT") {
      return `Error: File '${filePath}' does not exist.`;
    } else if (err.code === "EACCES") {
      return `Error: Permission denied accessing '${filePath}'.`;
    } else {
      return `Error reading file '${filePath}': ${err.message ?? "Unknown error"}`;
    }
  }
}
