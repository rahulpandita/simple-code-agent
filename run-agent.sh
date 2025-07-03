#!/bin/bash

# Simple Code Agent Runner Script
# Usage: ./run-agent.sh <style_parameter>
# Example: ./run-agent.sh "modern dark theme"

# Check if style parameter is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <style_parameter>"
    echo "Example: $0 \"modern dark theme\""
    echo "Example: $0 \"minimalist design\""
    echo "Example: $0 \"colorful and vibrant\""
    exit 1
fi

# Get the style parameter
STYLE_PARAM="$1"

# Set the target directory (you can modify this)
TARGET_DIR="/workspaces/a-sample"

# Construct the prompt
PROMPT="update the webapp to have ${STYLE_PARAM} look and feel while retaining the current functionality"

echo "================================================"
echo "Simple Code Agent - Style Update Runner"
echo "================================================"
echo "Style Parameter: ${STYLE_PARAM}"
echo "Target Directory: ${TARGET_DIR}"
echo "Prompt: ${PROMPT}"
echo "================================================"
echo ""

# Run npm install and then the agent
echo "Installing dependencies..."
npm install

if [ $? -eq 0 ]; then
    echo ""
    echo "Running agent with style parameter..."
    node agent.js "${TARGET_DIR}" "${PROMPT}"
else
    echo "Error: npm install failed"
    exit 1
fi
