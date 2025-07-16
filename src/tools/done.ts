import type { Tool, DoneParams } from "../types.js";

export const doneTool: Tool = {
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
};

export function done({ summary }: DoneParams): Promise<string> {
  return Promise.resolve(`Task completed: ${summary}`);
}
