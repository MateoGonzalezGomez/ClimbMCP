# Climbing MCP Server

An MCP (Model Context Protocol) server for serving climbing book PDF chapters to Claude.

## Features

- Store PDF chapters in the `chapters/` directory
- List all available chapters with metadata
- Search for relevant chapters based on query
- Serve PDF content directly to Claude for reading

## Setup

1. Install dependencies:
```bash
npm install
```

2. Add your PDF files to the `chapters/` directory

3. Create corresponding `.json` metadata files for each PDF with:
   - `title`: Chapter title
   - `description`: Brief description
   - `keywords`: Array of relevant keywords for search

## Usage

Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "climbing-pdf": {
      "command": "node",
      "args": ["E:/Projects/climbing-mcp-server/src/index.js"]
    }
  }
}
```

## Available Tools

- `list_chapters`: Lists all available PDF chapters
- `get_chapter`: Retrieves a specific PDF for Claude to read
- `search_relevant_chapter`: Finds the most relevant chapters based on a query

## Adding PDFs

1. Place PDF files in the `chapters/` directory
2. Create a corresponding `.json` file with the same name (e.g., `chapter1.pdf` → `chapter1.json`)
3. The metadata helps with search and relevance scoring