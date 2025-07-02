# Simple Code Agent

A basic AI-powered code agent that can read files, write files, and execute shell commands in any repository using OpenAI's function calling capabilities.

## Features

- **File Operations**: Read and write files in any repository
- **Command Execution**: Run shell commands and capture output
- **AI-Powered**: Uses OpenAI GPT models with function calling
- **Custom Endpoints**: Supports Azure OpenAI endpoints
- **Repository Aware**: Works with any local repository path

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure your environment by creating a `.env.local` file:
   ```bash
   AZURE_GPT41_ENDPOINT=https://your-azure-endpoint.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2025-01-01-preview
   AZURE_GPT41_API_KEY=your_api_key_here
   ```

## Usage

```bash
node agent.js <repo_path> <prompt>
```

### Parameters

- `<repo_path>`: Path to the repository you want to work with (use `.` for current directory)
- `<prompt>`: Natural language prompt describing what you want the agent to do

### Examples

```bash
# Work in current directory - read package.json
node agent.js . "Read the package.json file"

# Work in a specific directory - analyze project structure
node agent.js /path/to/my/project "List all JavaScript files and show their contents"

# Create new files
node agent.js . "Create a new file called test.js with a simple hello world function"

# Run commands and analyze output
node agent.js . "Run 'npm test' and explain the results"

# Complex analysis
node agent.js /path/to/project "Analyze the code structure and suggest improvements"
```

## Available Tools

The agent has access to three main tools:

1. **read_file**: Read the contents of any file in the repository
2. **write_file**: Create or overwrite files with new content
3. **run_command**: Execute shell commands and capture their output

## Requirements

- Node.js v16 or higher
- Valid OpenAI API key (or Azure OpenAI endpoint)
- Access to the repositories you want to analyze

## Configuration

The agent supports both standard OpenAI endpoints and Azure OpenAI endpoints. Configure your endpoint and API key in the `.env.local` file as shown in the setup section.
