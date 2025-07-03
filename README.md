# Simple Code Agent

A basic AI-powered code agent that can read files, write files, and execute shell commands in any repository using OpenAI's function calling capabilities.

## Features

- **File Operations**: Read and write files in any repository
- **Command Execution**: Run shell commands and capture output with configurable timeouts
- **AI-Powered**: Uses OpenAI GPT models with function calling
- **Multi-turn Conversations**: Agent can perform multiple actions in sequence until task completion
- **Enhanced Error Handling**: Gracefully handles command failures and provides detailed error information
- **Network Resilience**: Automatic retry logic with exponential backoff for API calls and web requests
- **Configurable Timeouts**: Customizable timeouts for all external operations
- **Custom Endpoints**: Supports Azure OpenAI endpoints
- **Repository Aware**: Works with any local repository path
- **Web Research**: Perform web searches and analyze results
- **Image Analysis**: Analyze images from files or URLs with retry logic

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

   Optional timeout and retry configuration:
   ```bash
   # Timeout settings (in milliseconds)
   API_TIMEOUT=60000          # API request timeout (default: 60s)
   WEB_TIMEOUT=30000          # Web request timeout (default: 30s)
   COMMAND_TIMEOUT=120000     # Command execution timeout (default: 2min)
   IMAGE_TIMEOUT=90000        # Image analysis timeout (default: 90s)
   
   # Retry settings
   MAX_RETRY_ATTEMPTS=3       # Maximum retry attempts (default: 3)
   RETRY_BASE_DELAY=1000      # Base delay between retries (default: 1s)
   RETRY_MAX_DELAY=30000      # Maximum delay between retries (default: 30s)
   RETRY_BACKOFF_MULTIPLIER=2 # Exponential backoff multiplier (default: 2)
   ```

   See `.env.example` for a complete configuration template.

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

The agent has access to four main tools:

1. **read_file**: Read the contents of any file in the repository
2. **write_file**: Create or overwrite files with new content
3. **run_command**: Execute shell commands and capture their output (handles both successful and failed commands)
4. **done**: Mark a task as complete with a summary (used internally by the agent)

## Requirements

- Node.js v16 or higher
- Valid OpenAI API key (or Azure OpenAI endpoint)
- Access to the repositories you want to analyze

## Robustness Features

The agent includes several robustness improvements for production use:

### Network Resilience
- **Automatic Retry Logic**: All external API calls and web requests automatically retry on failure
- **Exponential Backoff**: Retry delays increase exponentially to avoid overwhelming services
- **Smart Retry Logic**: Different retry strategies for different types of errors (rate limits, network errors, server errors)

### Timeout Handling
- **Configurable Timeouts**: All external operations have configurable timeout limits
- **Operation-Specific Timeouts**: Different timeout settings for API calls, web requests, command execution, and image analysis
- **Graceful Timeout Handling**: Clear error messages when operations time out

### Error Recovery
- **Partial Failure Handling**: Individual failures don't stop the entire operation
- **Fallback Mechanisms**: Alternative approaches when primary methods fail
- **Detailed Error Reporting**: Comprehensive error messages with context

## Configuration

The agent supports both standard OpenAI endpoints and Azure OpenAI endpoints. Configure your endpoint and API key in the `.env.local` file as shown in the setup section.
