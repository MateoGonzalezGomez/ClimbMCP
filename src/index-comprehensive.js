import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import fs_sync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDF2JSON from 'pdf2json';
import pdf2pic from 'pdf2pic';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHAPTERS_DIR = path.join(__dirname, '..', 'chapters');
const EXTRACTED_DIR = path.join(__dirname, '..', 'extracted_content');
const IMAGES_DIR = path.join(EXTRACTED_DIR, 'images');

// Content extraction and delivery limits
const EXTRACTION_CONFIG = {
  MAX_RESPONSE_SIZE: 800000,      // 800KB max response
  CHUNK_SIZE: 150000,             // 150KB per chunk 
  CONTEXT_WINDOW: 500,            // Characters around search matches
  MAX_IMAGES_PER_CHUNK: 3,        // Max images per content chunk
  IMAGE_QUALITY: 85,              // JPEG quality for compression
  IMAGE_MAX_WIDTH: 1200,          // Max image width
  IMAGE_MAX_HEIGHT: 1600          // Max image height
};

class ComprehensiveClimbingPDFServer {
  constructor() {
    this.server = new Server(
      {
        name: 'comprehensive-climbing-pdf-server',
        version: '2.0.0',
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
          description: 'List all available PDF chapters with extraction status and content metadata',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'search_content',
          description: 'Search within extracted PDF text and return relevant sections with images',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for specific climbing topics, techniques, or concepts',
              },
              max_results: {
                type: 'number',
                description: 'Maximum number of results to return (1-5)',
                default: 3,
                minimum: 1,
                maximum: 5
              },
              include_images: {
                type: 'boolean',
                description: 'Include relevant page images with text results',
                default: true
              }
            },
            required: ['query'],
          },
        },
        {
          name: 'get_chapter_section',
          description: 'Get a specific section of a chapter with text and associated images',
          inputSchema: {
            type: 'object',
            properties: {
              chapter_name: {
                type: 'string',
                description: 'The filename of the chapter PDF',
              },
              section_topic: {
                type: 'string',
                description: 'Specific topic or technique to focus on (e.g., "trad anchors", "belaying", "rappelling")',
              },
              context_level: {
                type: 'string',
                enum: ['brief', 'detailed', 'comprehensive'],
                description: 'Amount of surrounding context to include',
                default: 'detailed'
              }
            },
            required: ['chapter_name', 'section_topic'],
          },
        },
        {
          name: 'extract_chapter_content',
          description: 'Extract and cache text and images from a chapter for future searches',
          inputSchema: {
            type: 'object',
            properties: {
              chapter_name: {
                type: 'string',
                description: 'The filename of the chapter PDF to extract',
              },
              force_reextract: {
                type: 'boolean',
                description: 'Force re-extraction even if cached version exists',
                default: false
              }
            },
            required: ['chapter_name'],
          },
        },
        {
          name: 'get_visual_content',
          description: 'Get images and diagrams from specific pages with surrounding text context',
          inputSchema: {
            type: 'object',
            properties: {
              chapter_name: {
                type: 'string',
                description: 'The filename of the chapter PDF',
              },
              page_numbers: {
                type: 'array',
                items: { type: 'number' },
                description: 'Specific page numbers to retrieve images from',
              },
              topic_context: {
                type: 'string',
                description: 'Topic context to help identify relevant images (e.g., "anchor diagrams", "knot illustrations")',
              }
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
        
        case 'search_content':
          return await this.searchContent(
            args.query, 
            args.max_results || 3, 
            args.include_images !== false
          );
        
        case 'get_chapter_section':
          return await this.getChapterSection(
            args.chapter_name, 
            args.section_topic, 
            args.context_level || 'detailed'
          );
        
        case 'extract_chapter_content':
          return await this.extractChapterContent(
            args.chapter_name, 
            args.force_reextract || false
          );
        
        case 'get_visual_content':
          return await this.getVisualContent(
            args.chapter_name, 
            args.page_numbers, 
            args.topic_context
          );
        
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async extractTextWithPDF2JSON(pdfBuffer) {
    return new Promise((resolve, reject) => {
      const pdfParser = new PDF2JSON();
      
      pdfParser.on('pdfParser_dataError', errData => {
        console.error('PDF parsing error:', errData.parserError);
        resolve(''); // Return empty string if parsing fails
      });
      
      pdfParser.on('pdfParser_dataReady', pdfData => {
        try {
          let fullText = '';
          
          if (pdfData.Pages) {
            pdfData.Pages.forEach(page => {
              if (page.Texts) {
                page.Texts.forEach(textItem => {
                  if (textItem.R) {
                    textItem.R.forEach(textRun => {
                      if (textRun.T) {
                        fullText += decodeURIComponent(textRun.T) + ' ';
                      }
                    });
                  }
                });
                fullText += '\n'; // Add line break between pages
              }
            });
          }
          
          resolve(fullText.trim());
        } catch (error) {
          console.error('Error processing PDF data:', error);
          resolve(''); // Return empty string on error
        }
      });
      
      pdfParser.parseBuffer(pdfBuffer);
    });
  }

  async comprehensiveExtractPDF(filePath, chapterName) {
    try {
      console.error(`Starting comprehensive extraction for ${chapterName}...`);
      
      const pdfBuffer = await fs.readFile(filePath);
      
      // Extract text content using pdf2json
      const fullText = await this.extractTextWithPDF2JSON(pdfBuffer);
      
      // Estimate page count from image extraction or text length
      let totalPages = 0;
      
      // Create chapter-specific directories
      const chapterDir = path.join(IMAGES_DIR, chapterName.replace('.pdf', ''));
      await fs.mkdir(chapterDir, { recursive: true });
      
      // Extract page images
      const pageImages = [];
      try {
        const convert = pdf2pic.fromBuffer(pdfBuffer, {
          density: 200,           // Higher resolution for better quality
          saveFilename: "page",
          savePath: chapterDir,
          format: "png",
          width: EXTRACTION_CONFIG.IMAGE_MAX_WIDTH,
          height: EXTRACTION_CONFIG.IMAGE_MAX_HEIGHT
        });
        
        // Convert all pages to images
        const results = await convert.bulk(-1, { responseType: "buffer" });
        
        for (const result of results) {
          try {
            // Compress image with Sharp for smaller file sizes
            const compressedBuffer = await sharp(result.buffer)
              .jpeg({ quality: EXTRACTION_CONFIG.IMAGE_QUALITY })
              .resize(
                EXTRACTION_CONFIG.IMAGE_MAX_WIDTH, 
                EXTRACTION_CONFIG.IMAGE_MAX_HEIGHT, 
                { fit: 'inside', withoutEnlargement: true }
              )
              .toBuffer();
            
            const imagePath = result.path.replace('.png', '.jpg');
            await fs.writeFile(imagePath, compressedBuffer);
            
            pageImages.push({
              page: result.page,
              path: imagePath,
              filename: path.basename(imagePath),
              size: compressedBuffer.length,
              base64: compressedBuffer.toString('base64')
            });
          } catch (imageProcessError) {
            console.error(`Error processing page ${result.page}:`, imageProcessError.message);
          }
        }
        
        totalPages = pageImages.length;
        console.error(`Extracted ${pageImages.length} page images from ${chapterName}`);
        
      } catch (imageError) {
        console.error(`Image extraction failed for ${chapterName}:`, imageError.message);
        // Estimate pages from text length if image extraction fails
        totalPages = Math.max(1, Math.ceil(fullText.length / 3000));
      }
      
      // Create text-image mapping by estimating page boundaries
      const textChunks = this.createTextImageChunks(fullText, pageImages, totalPages);
      
      // Cache the extracted content
      const extractedContent = {
        chapterName,
        extractedAt: new Date().toISOString(),
        text: fullText,
        totalPages,
        pageImages,
        textChunks,
        searchIndex: this.createSearchIndex(fullText, textChunks)
      };
      
      const cacheFile = path.join(EXTRACTED_DIR, `${chapterName.replace('.pdf', '.json')}`);
      await fs.writeFile(cacheFile, JSON.stringify(extractedContent, null, 2));
      
      return extractedContent;
      
    } catch (error) {
      throw new Error(`Comprehensive PDF extraction failed: ${error.message}`);
    }
  }

  createTextImageChunks(fullText, pageImages, totalPages) {
    const chunks = [];
    const chunkSize = EXTRACTION_CONFIG.CHUNK_SIZE;
    
    for (let i = 0; i < fullText.length; i += chunkSize) {
      const chunkText = fullText.substring(i, i + chunkSize);
      const startPage = Math.ceil(((i / fullText.length) * totalPages)) || 1;
      const endPage = Math.ceil((((i + chunkSize) / fullText.length) * totalPages)) || totalPages;
      
      // Find relevant images for this text chunk
      const relevantImages = pageImages.filter(img => 
        img.page >= startPage && img.page <= endPage
      ).slice(0, EXTRACTION_CONFIG.MAX_IMAGES_PER_CHUNK);
      
      chunks.push({
        id: chunks.length,
        text: chunkText,
        startChar: i,
        endChar: Math.min(i + chunkSize, fullText.length),
        startPage,
        endPage,
        images: relevantImages,
        topics: this.extractTopics(chunkText)
      });
    }
    
    return chunks;
  }

  createSearchIndex(fullText, textChunks) {
    const index = {};
    
    textChunks.forEach(chunk => {
      const words = chunk.text.toLowerCase()
        .split(/\W+/)
        .filter(word => word.length > 2);
      
      words.forEach(word => {
        if (!index[word]) {
          index[word] = [];
        }
        index[word].push(chunk.id);
      });
    });
    
    return index;
  }

  extractTopics(text) {
    // Extract potential topic keywords from text
    const climbingTerms = [
      'anchor', 'anchors', 'belay', 'belaying', 'rappel', 'rappelling', 
      'knot', 'knots', 'rope', 'carabiner', 'cam', 'nut', 'protection',
      'pitch', 'multipitch', 'trad', 'traditional', 'sport', 'lead',
      'follow', 'climbing', 'technique', 'safety', 'SERENE', 'equalization'
    ];
    
    const foundTerms = [];
    const lowerText = text.toLowerCase();
    
    climbingTerms.forEach(term => {
      if (lowerText.includes(term)) {
        foundTerms.push(term);
      }
    });
    
    return foundTerms;
  }

  async getCachedContent(chapterName) {
    try {
      const cacheFile = path.join(EXTRACTED_DIR, `${chapterName.replace('.pdf', '.json')}`);
      const cachedData = await fs.readFile(cacheFile, 'utf-8');
      return JSON.parse(cachedData);
    } catch (error) {
      return null; // Cache doesn't exist
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
          
          // Check if content has been extracted
          const cachedContent = await this.getCachedContent(file);
          const extractionStatus = cachedContent ? {
            extracted: true,
            extractedAt: cachedContent.extractedAt,
            totalPages: cachedContent.totalPages,
            textLength: this.formatBytes(cachedContent.text?.length || 0),
            imageCount: cachedContent.pageImages?.length || 0,
            chunkCount: cachedContent.textChunks?.length || 0
          } : {
            extracted: false,
            message: 'Use extract_chapter_content to process this chapter'
          };
          
          return {
            filename: file,
            title: metadata.title || file,
            description: metadata.description || 'No description available',
            keywords: metadata.keywords || [],
            extraction: extractionStatus
          };
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: `CLIMBING PDF CHAPTERS (${chapters.length} total)\n\n${JSON.stringify(chapters, null, 2)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing chapters: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }

  async extractChapterContent(chapterName, forceReextract) {
    try {
      const filePath = path.join(CHAPTERS_DIR, chapterName);
      await fs.access(filePath);

      // Check if already extracted and not forcing re-extraction
      if (!forceReextract) {
        const cached = await this.getCachedContent(chapterName);
        if (cached) {
          return {
            content: [{
              type: 'text',
              text: `CONTENT ALREADY EXTRACTED for ${chapterName}
              
EXTRACTION INFO:
- Extracted: ${cached.extractedAt}
- Total Pages: ${cached.totalPages}
- Text Length: ${this.formatBytes(cached.text?.length || 0)}
- Images: ${cached.pageImages?.length || 0} pages
- Text Chunks: ${cached.textChunks?.length || 0}

Use force_reextract=true to re-process this chapter.`
            }]
          };
        }
      }

      console.error(`Extracting content from ${chapterName}...`);
      const extractedContent = await this.comprehensiveExtractPDF(filePath, chapterName);

      return {
        content: [{
          type: 'text',
          text: `EXTRACTION COMPLETED for ${chapterName}

RESULTS:
- Total Pages: ${extractedContent.totalPages}
- Text Length: ${this.formatBytes(extractedContent.text.length)}
- Images Extracted: ${extractedContent.pageImages.length} pages
- Text Chunks Created: ${extractedContent.textChunks.length}
- Topics Identified: ${[...new Set(extractedContent.textChunks.flatMap(c => c.topics))].join(', ')}

The chapter is now ready for content search and section retrieval.`
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error extracting chapter content: ${error.message}`
        }],
        isError: true
      };
    }
  }

  async searchContent(query, maxResults, includeImages) {
    try {
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\W+/).filter(w => w.length > 2);
      const results = [];

      // Get all extracted content
      const files = await fs.readdir(CHAPTERS_DIR);
      const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));

      for (const file of pdfFiles) {
        const cached = await this.getCachedContent(file);
        if (!cached) continue; // Skip non-extracted chapters

        // Search through text chunks
        const chunkMatches = cached.textChunks.filter(chunk => {
          const chunkTextLower = chunk.text.toLowerCase();
          return queryWords.some(word => chunkTextLower.includes(word)) ||
                 chunk.topics.some(topic => queryWords.includes(topic.toLowerCase()));
        });

        if (chunkMatches.length > 0) {
          // Score and sort matches
          const scoredMatches = chunkMatches.map(chunk => {
            let score = 0;
            queryWords.forEach(word => {
              const matches = (chunk.text.toLowerCase().match(new RegExp(word, 'g')) || []).length;
              score += matches * 10;
            });
            
            // Bonus for topic matches
            chunk.topics.forEach(topic => {
              if (queryWords.includes(topic.toLowerCase())) {
                score += 20;
              }
            });

            return { ...chunk, score };
          }).sort((a, b) => b.score - a.score);

          results.push({
            chapter: file,
            chapterTitle: cached.chapterName,
            matches: scoredMatches.slice(0, 2) // Top 2 matches per chapter
          });
        }
      }

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No content found for "${query}". 

Make sure chapters are extracted first using extract_chapter_content.
Try broader search terms or check available topics in extracted chapters.`
          }]
        };
      }

      // Build response with text and images
      let responseText = `SEARCH RESULTS for "${query}" (${results.length} chapters found)\n\n`;

      results.slice(0, maxResults).forEach((result, index) => {
        responseText += `${index + 1}. CHAPTER: ${result.chapterTitle}\n`;
        responseText += `   FILE: ${result.chapter}\n\n`;

        result.matches.forEach((match, matchIndex) => {
          responseText += `   MATCH ${matchIndex + 1} (Score: ${match.score}):\n`;
          responseText += `   PAGES: ${match.startPage}-${match.endPage}\n`;
          responseText += `   TOPICS: ${match.topics.join(', ')}\n`;
          responseText += `   TEXT: "${this.getContextSnippet(match.text, queryWords)}"\n`;

          if (includeImages && match.images.length > 0) {
            responseText += `   IMAGES:\n`;
            match.images.slice(0, 2).forEach(img => {
              responseText += `     Page ${img.page}: [IMAGE_DATA] ${img.base64.substring(0, 200)}...\n`;
            });
          }
          responseText += `\n`;
        });
      });

      return {
        content: [{
          type: 'text',
          text: responseText
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error searching content: ${error.message}`
        }],
        isError: true
      };
    }
  }

  getContextSnippet(text, queryWords, contextLength = EXTRACTION_CONFIG.CONTEXT_WINDOW) {
    let bestMatch = { index: 0, word: '' };
    
    queryWords.forEach(word => {
      const index = text.toLowerCase().indexOf(word);
      if (index !== -1 && (bestMatch.index === 0 || index < bestMatch.index)) {
        bestMatch = { index, word };
      }
    });

    if (bestMatch.index === 0) {
      return text.substring(0, contextLength) + (text.length > contextLength ? '...' : '');
    }

    const start = Math.max(0, bestMatch.index - contextLength / 2);
    const end = Math.min(text.length, bestMatch.index + contextLength / 2);
    const snippet = text.substring(start, end);

    return (start > 0 ? '...' : '') + snippet + (end < text.length ? '...' : '');
  }

  async getChapterSection(chapterName, sectionTopic, contextLevel) {
    try {
      const cached = await this.getCachedContent(chapterName);
      if (!cached) {
        return {
          content: [{
            type: 'text',
            text: `Chapter "${chapterName}" not extracted. Use extract_chapter_content first.`
          }],
          isError: true
        };
      }

      const topicLower = sectionTopic.toLowerCase();
      const topicWords = topicLower.split(/\W+/).filter(w => w.length > 2);

      // Find relevant chunks
      const relevantChunks = cached.textChunks.filter(chunk => {
        const chunkTextLower = chunk.text.toLowerCase();
        return topicWords.some(word => chunkTextLower.includes(word)) ||
               chunk.topics.some(topic => topicWords.includes(topic.toLowerCase()));
      });

      if (relevantChunks.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No content found for "${sectionTopic}" in ${chapterName}.
            
Available topics in this chapter: ${[...new Set(cached.textChunks.flatMap(c => c.topics))].join(', ')}`
          }]
        };
      }

      const contextSizes = { brief: 1, detailed: 2, comprehensive: 3 };
      const maxChunks = contextSizes[contextLevel] || 2;
      
      let responseText = `SECTION: "${sectionTopic}" from ${chapterName}\n`;
      responseText += `CONTEXT LEVEL: ${contextLevel}\n\n`;

      relevantChunks.slice(0, maxChunks).forEach((chunk, index) => {
        responseText += `=== SECTION ${index + 1} (Pages ${chunk.startPage}-${chunk.endPage}) ===\n`;
        responseText += `TOPICS: ${chunk.topics.join(', ')}\n\n`;
        responseText += `${chunk.text}\n\n`;

        if (chunk.images.length > 0) {
          responseText += `RELATED IMAGES:\n`;
          chunk.images.forEach(img => {
            responseText += `Page ${img.page}: [IMAGE_DATA] ${img.base64.substring(0, 300)}...\n`;
          });
          responseText += `\n`;
        }
      });

      return {
        content: [{
          type: 'text',
          text: responseText
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error getting chapter section: ${error.message}`
        }],
        isError: true
      };
    }
  }

  async getVisualContent(chapterName, pageNumbers, topicContext) {
    try {
      const cached = await this.getCachedContent(chapterName);
      if (!cached) {
        return {
          content: [{
            type: 'text',
            text: `Chapter "${chapterName}" not extracted. Use extract_chapter_content first.`
          }],
          isError: true
        };
      }

      let targetImages = cached.pageImages;
      
      // Filter by specific page numbers if provided
      if (pageNumbers && pageNumbers.length > 0) {
        targetImages = cached.pageImages.filter(img => pageNumbers.includes(img.page));
      }

      // If topic context provided, find relevant chunks and their images
      if (topicContext) {
        const contextWords = topicContext.toLowerCase().split(/\W+/).filter(w => w.length > 2);
        const relevantChunks = cached.textChunks.filter(chunk => {
          const chunkTextLower = chunk.text.toLowerCase();
          return contextWords.some(word => chunkTextLower.includes(word)) ||
                 chunk.topics.some(topic => contextWords.includes(topic.toLowerCase()));
        });
        
        const relevantPages = [...new Set(relevantChunks.flatMap(chunk => 
          chunk.images.map(img => img.page)
        ))];
        
        targetImages = cached.pageImages.filter(img => relevantPages.includes(img.page));
      }

      if (targetImages.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No images found matching the criteria in ${chapterName}.`
          }]
        };
      }

      let responseText = `VISUAL CONTENT from ${chapterName}\n`;
      if (topicContext) responseText += `TOPIC CONTEXT: ${topicContext}\n`;
      if (pageNumbers) responseText += `REQUESTED PAGES: ${pageNumbers.join(', ')}\n`;
      responseText += `\nFOUND ${targetImages.length} IMAGES:\n\n`;

      targetImages.slice(0, 5).forEach(img => { // Limit to 5 images
        responseText += `=== PAGE ${img.page} ===\n`;
        responseText += `FILENAME: ${img.filename}\n`;
        responseText += `SIZE: ${this.formatBytes(img.size)}\n`;
        
        // Find associated text context
        const associatedChunk = cached.textChunks.find(chunk => 
          chunk.startPage <= img.page && chunk.endPage >= img.page
        );
        
        if (associatedChunk) {
          const contextSnippet = associatedChunk.text.substring(0, 200) + '...';
          responseText += `TEXT CONTEXT: "${contextSnippet}"\n`;
          responseText += `TOPICS: ${associatedChunk.topics.join(', ')}\n`;
        }
        
        responseText += `[IMAGE_DATA]\n${img.base64}\n\n`;
      });

      return {
        content: [{
          type: 'text',
          text: responseText
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error getting visual content: ${error.message}`
        }],
        isError: true
      };
    }
  }

  async run() {
    // Ensure all directories exist
    try {
      await fs.mkdir(CHAPTERS_DIR, { recursive: true });
      await fs.mkdir(EXTRACTED_DIR, { recursive: true });
      await fs.mkdir(IMAGES_DIR, { recursive: true });
    } catch (error) {
      console.error('Error creating directories:', error);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Comprehensive Climbing PDF MCP server running on stdio');
  }
}

const server = new ComprehensiveClimbingPDFServer();
server.run().catch(console.error);