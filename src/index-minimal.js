import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHAPTERS_DIR = path.join(__dirname, '..', 'chapters');

class MinimalClimbingPDFServer {
  constructor() {
    this.server = new Server(
      {
        name: 'minimal-climbing-pdf-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_chapters',
          description: 'List all available PDF chapters with their titles and descriptions',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_chapter',
          description: 'Get the content of a specific PDF chapter as base64',
          inputSchema: {
            type: 'object',
            properties: {
              chapter_name: {
                type: 'string',
                description: 'The filename of the chapter PDF to retrieve',
              },
            },
            required: ['chapter_name'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'list_chapters':
          return await this.listChapters();
        
        case 'get_chapter':
          return await this.getChapter(args.chapter_name);
        
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async listChapters() {
    try {
      const files = await fs.readdir(CHAPTERS_DIR);
      const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
      
      const chapters = await Promise.all(
        pdfFiles.map(async (file) => {
          const metadataPath = path.join(CHAPTERS_DIR, file.replace('.pdf', '.json'));
          let metadata = { title: file, description: 'No description available' };
          
          try {
            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
            metadata = JSON.parse(metadataContent);
          } catch (err) {
            // Metadata file doesn't exist, use defaults
          }
          
          return {
            filename: file,
            title: metadata.title || file,
            description: metadata.description || 'No description available',
            keywords: metadata.keywords || []
          };
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(chapters, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing chapters: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async getChapter(chapterName) {
    try {
      const filePath = path.join(CHAPTERS_DIR, chapterName);
      
      // Check if file exists
      await fs.access(filePath);
      
      // Read the PDF file as buffer
      const pdfBuffer = await fs.readFile(filePath);
      
      // Return PDF content as base64-encoded text
      const base64Content = pdfBuffer.toString('base64');
      
      return {
        content: [
          {
            type: 'text',
            text: `PDF_CONTENT:${chapterName}:BASE64:${base64Content}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reading chapter: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    try {
      await fs.mkdir(CHAPTERS_DIR, { recursive: true });
    } catch (error) {
      console.error('Error creating chapters directory:', error);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Minimal Climbing PDF MCP server running on stdio');
  }
}

const server = new MinimalClimbingPDFServer();
server.run().catch(console.error);