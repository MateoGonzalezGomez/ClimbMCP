import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import PDF2JSON from 'pdf2json';
import { PdfReader } from 'pdfreader';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOOKS_DIR = path.join(__dirname, '..', 'Books');
const EXTRACTED_DIR = path.join(__dirname, '..', 'extracted_content');

// Content extraction and delivery limits
const EXTRACTION_CONFIG = {
  MAX_RESPONSE_SIZE: 800000,      // 800KB max response
  CHUNK_SIZE: 150000,             // 150KB per chunk 
  CONTEXT_WINDOW: 500,            // Characters around search matches
};

class ClimbingResourcesServer {
  constructor() {
    this.server = new Server(
      {
        name: 'climbing-resources-server',
        version: '2.1.0',
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
          name: 'list_books_and_chapters',
          description: 'List all available books and their PDF chapters with extraction status and content metadata',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'search_content',
          description: 'Search within extracted PDF text and return relevant sections with page references',
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
              book_name: {
                type: 'string',
                description: 'The name of the book directory',
              },
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
            required: ['book_name', 'chapter_name', 'section_topic'],
          },
        },
        {
          name: 'extract_chapter_content',
          description: 'Extract and cache text and images from a chapter for future searches',
          inputSchema: {
            type: 'object',
            properties: {
              book_name: {
                type: 'string',
                description: 'The name of the book directory',
              },
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
            required: ['book_name', 'chapter_name'],
          },
        },
        {
          name: 'get_chapter_text',
          description: 'Get readable text from a chapter - combines extraction and cleaning into one tool',
          inputSchema: {
            type: 'object',
            properties: {
              book_name: {
                type: 'string',
                description: 'The name of the book directory',
              },
              chapter_name: {
                type: 'string',
                description: 'The filename of the chapter PDF',
              },
              start_chars: {
                type: 'number',
                description: 'Starting character position (0 for beginning of chapter)',
                default: 0
              },
              length: {
                type: 'number',
                description: 'Number of characters to return',
                default: 1000
              },
              force_reextract: {
                type: 'boolean',
                description: 'Force re-extraction even if cached version exists',
                default: false
              }
            },
            required: ['book_name', 'chapter_name'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'list_books_and_chapters':
          return await this.listBooksAndChapters();
        
        case 'search_content':
          return await this.searchContent(
            args.query, 
            args.max_results || 3
          );
        
        case 'get_chapter_section':
          return await this.getChapterSection(
            args.book_name,
            args.chapter_name, 
            args.section_topic, 
            args.context_level || 'detailed'
          );
        
        case 'extract_chapter_content':
          return await this.extractChapterContent(
            args.book_name,
            args.chapter_name, 
            args.force_reextract || false
          );
        
        case 'get_chapter_text':
          return await this.getChapterText(
            args.book_name,
            args.chapter_name,
            args.start_chars || 0,
            args.length || 1000,
            args.force_reextract || false
          );
        
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  reconstructText(rawText) {
    // Advanced text reconstruction to fix severe PDF spacing corruption
    if (!rawText || rawText.length === 0) return '';
    
    let text = rawText;
    
    // Step 1: Fix the severe character-by-character spacing issue
    // Pattern like "la ng er nu ts" should become "larger nuts"
    text = text.replace(/([a-z])\s+([a-z])\s+([a-z])/g, (match) => {
      // Remove all spaces and see if it forms a real word
      const merged = match.replace(/\s+/g, '');
      return merged;
    });
    
    // Step 2: More aggressive character merging for 2-char sequences
    text = text.replace(/([a-z])\s+([a-z])/g, '$1$2');
    
    // Step 3: Handle mixed case issues like "si depla ce me nt" -> "side placement"
    text = text.replace(/([a-z])\s+([a-z])\s+([a-z])\s+([a-z])\s+([a-z])/g, (match) => {
      return match.replace(/\s+/g, '');
    });
    
    // Step 4: Insert spaces at likely word boundaries
    // Between sequences that look like merged words
    const wordBoundaryPatterns = [
      // Between lowercase and uppercase
      [/([a-z])([A-Z])/g, '$1 $2'],
      // Before common prefixes
      [/([a-z])(and|the|of|to|in|for|with|are|can|will|may)/g, '$1 $2'],
      // After common suffixes  
      [/(ing|tion|ed|er|ly|ness)([a-z])/g, '$1 $2'],
      // Between letters and numbers
      [/([a-zA-Z])([0-9])/g, '$1 $2'],
      [/([0-9])([a-zA-Z])/g, '$1 $2'],
      // Before/after punctuation
      [/([a-zA-Z])([.,:;!?])/g, '$1$2'],
      [/([.,:;!?])([a-zA-Z])/g, '$1 $2']
    ];
    
    wordBoundaryPatterns.forEach(([pattern, replacement]) => {
      text = text.replace(pattern, replacement);
    });
    
    // Step 5: Fix common climbing terminology
    const climbingFixes = [
      [/placements?/gi, 'placement'],
      [/anchors?/gi, 'anchor'],  
      [/protection/gi, 'protection'],
      [/carabiners?/gi, 'carabiner'],
      [/generally/gi, 'generally'],
      [/stronger/gi, 'stronger'],
      [/smaller/gi, 'smaller'],
      [/larger/gi, 'larger'],
      [/important/gi, 'important']
    ];
    
    climbingFixes.forEach(([pattern, replacement]) => {
      text = text.replace(pattern, replacement);
    });
    
    // Step 6: Clean up whitespace and formatting
    text = text.replace(/\s{2,}/g, ' ');
    text = text.replace(/\s*\n\s*/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();
    
    // Step 7: Final pass - try to reconstruct obvious words
    // This catches remaining fragmented common words
    const commonWordsMap = {
      'gene rally': 'generally',
      'place ment': 'placement', 
      'place ments': 'placements',
      'import ant': 'important',
      'strong er': 'stronger',
      'small er': 'smaller',
      'larg er': 'larger',
      'fig ure': 'figure',
      'anch or': 'anchor',
      'anch ors': 'anchors',
      'protect ion': 'protection',
      'cara bin er': 'carabiner',
      'cara bin ers': 'carabiners'
    };
    
    Object.keys(commonWordsMap).forEach(fragmented => {
      const regex = new RegExp(fragmented, 'gi');
      text = text.replace(regex, commonWordsMap[fragmented]);
    });
    
    return text;
  }

  async extractTextWithPdfReader(pdfBuffer) {
    return new Promise((resolve, reject) => {
      const reader = new PdfReader();
      let pageText = {};
      let currentPage = 0;
      
      reader.parseBuffer(pdfBuffer, (err, item) => {
        if (err) {
          console.error('PDFReader error:', err);
          resolve({ text: '', pageData: {} });
          return;
        }
        
        if (!item) {
          // End of document - return both text and page mapping
          const sortedPages = Object.keys(pageText)
            .sort((a, b) => parseInt(a) - parseInt(b));
          
          const fullText = sortedPages.map(page => pageText[page] || '').join('\n').trim();
          
          resolve({ 
            text: fullText, 
            pageData: pageText,
            totalPages: sortedPages.length 
          });
          return;
        }
        
        if (item.page) {
          currentPage = item.page;
          if (!pageText[currentPage]) {
            pageText[currentPage] = '';
          }
        }
        
        if (item.text) {
          // PDFReader gives us better spaced text usually
          pageText[currentPage] = (pageText[currentPage] || '') + item.text + ' ';
        }
      });
    });
  }

  async extractTextWithPDF2JSON(pdfBuffer) {
    return new Promise((resolve, reject) => {
      const pdfParser = new PDF2JSON(null, 1); // Disable verbose logging
      
      // Suppress console output from pdf2json
      const originalConsoleWarn = console.warn;
      const originalConsoleError = console.error;
      
      console.warn = () => {}; // Suppress warnings
      console.error = (msg) => {
        if (!msg.includes('Warning:') && !msg.includes('Unexpected token')) {
          originalConsoleError(msg);
        }
      };
      
      pdfParser.on('pdfParser_dataError', errData => {
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        console.error('PDF text extraction failed:', errData.parserError);
        resolve(''); // Return empty string if parsing fails
      });
      
      pdfParser.on('pdfParser_dataReady', pdfData => {
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        
        try {
          let fullText = '';
          let pageData = {};
          
          if (pdfData && pdfData.Pages) {
            pdfData.Pages.forEach((page, pageIndex) => {
              const pageNum = pageIndex + 1;
              let pageText = '';
              
              if (page.Texts && Array.isArray(page.Texts)) {
                page.Texts.forEach(textItem => {
                  if (textItem.R && Array.isArray(textItem.R)) {
                    textItem.R.forEach(textRun => {
                      if (textRun.T) {
                        try {
                          let decodedText = decodeURIComponent(textRun.T);
                          // Remove excessive spacing between characters
                          decodedText = decodedText.replace(/\s{2,}/g, ' ').trim();
                          if (decodedText) {
                            pageText += decodedText + ' ';
                          }
                        } catch (decodeError) {
                          // Skip malformed text or try cleaning the raw text
                          let cleanText = textRun.T.replace(/\s{2,}/g, ' ').trim();
                          if (cleanText) {
                            pageText += cleanText + ' ';
                          }
                        }
                      }
                    });
                  }
                });
              }
              
              pageData[pageNum] = pageText.trim();
              fullText += pageText + '\n'; // Add line break between pages
            });
          }
          
          // Apply intelligent text reconstruction to fix PDF extraction issues
          const cleanedText = this.reconstructText(fullText);
          resolve({ 
            text: cleanedText, 
            pageData: pageData,
            totalPages: Object.keys(pageData).length 
          });
        } catch (error) {
          console.error('Error processing PDF data:', error);
          resolve({ text: '', pageData: {} }); // Return empty data on error
        }
      });
      
      try {
        pdfParser.parseBuffer(pdfBuffer);
      } catch (parseError) {
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        console.error('PDF buffer parsing failed:', parseError);
        resolve('');
      }
    });
  }

  async comprehensiveExtractPDF(filePath, chapterName, bookName = null) {
    try {
      console.error(`Starting comprehensive extraction for ${chapterName}...`);
      
      const pdfBuffer = await fs.readFile(filePath);
      
      // Try different PDF text extraction methods for better results
      console.error(`Trying PDFReader for text extraction...`);
      let extractionResult = await this.extractTextWithPdfReader(pdfBuffer);
      
      // If PDFReader fails or gives poor results, fall back to PDF2JSON
      if (!extractionResult.text || extractionResult.text.length < 100) {
        console.error(`PDFReader failed, falling back to PDF2JSON...`);
        extractionResult = await this.extractTextWithPDF2JSON(pdfBuffer);
      }
      
      const { text: fullText, pageData, totalPages } = extractionResult;
      console.error(`Extracted ${fullText.length} characters of text from ${totalPages} pages`);
      
      // Create page-aware text chunks with accurate page references
      const textChunks = this.createPageAwareChunks(fullText, pageData, totalPages);
      
      // Cache the extracted content
      const extractedContent = {
        chapterName,
        extractedAt: new Date().toISOString(),
        text: fullText,
        totalPages,
        pageData,
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

  createPageAwareChunks(fullText, pageData, totalPages) {
    const chunks = [];
    const chunkSize = EXTRACTION_CONFIG.CHUNK_SIZE;
    
    // Create a mapping of character positions to page numbers
    const charToPageMap = this.createCharToPageMap(fullText, pageData);
    
    for (let i = 0; i < fullText.length; i += chunkSize) {
      const chunkText = fullText.substring(i, i + chunkSize);
      const endChar = Math.min(i + chunkSize, fullText.length);
      
      // Find actual page range for this chunk using character mapping
      const startPage = charToPageMap[i] || 1;
      const endPage = charToPageMap[endChar - 1] || totalPages;
      
      // Extract page-specific content for better reference accuracy
      const pageReferences = this.extractPageReferences(chunkText, startPage, endPage);
      
      // Detect section heading in this chunk
      const sectionHeading = this.detectSectionHeading(chunkText);
      
      chunks.push({
        id: chunks.length,
        text: chunkText,
        startChar: i,
        endChar: endChar,
        startPage,
        endPage,
        pageReferences,
        sectionHeading,
        topics: this.extractTopics(chunkText)
      });
    }
    
    return chunks;
  }

  createCharToPageMap(fullText, pageData) {
    const charToPageMap = {};
    let currentChar = 0;
    
    // Build mapping based on actual page content
    Object.keys(pageData)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .forEach(pageNum => {
        const pageText = pageData[pageNum] || '';
        const pageLength = pageText.length + 1; // +1 for line break
        
        for (let i = 0; i < pageLength && currentChar < fullText.length; i++) {
          charToPageMap[currentChar] = parseInt(pageNum);
          currentChar++;
        }
      });
    
    return charToPageMap;
  }

  extractPageReferences(text, startPage, endPage) {
    // Extract key topics and concepts with their page context
    const references = [];
    const keyTerms = this.extractTopics(text);
    
    keyTerms.forEach(term => {
      const matches = [...text.matchAll(new RegExp(term, 'gi'))];
      matches.forEach(match => {
        references.push({
          term,
          context: text.substring(Math.max(0, match.index - 50), match.index + 50),
          pageRange: startPage === endPage ? `p. ${startPage}` : `pp. ${startPage}-${endPage}`
        });
      });
    });
    
    return references;
  }

  detectSectionHeading(text) {
    // Detect section headings in the text
    const headingPatterns = [
      // All caps headings
      /^([A-Z][A-Z\s&-]{5,})\s*$/m,
      // Title case headings
      /^([A-Z][a-zA-Z\s&-]{10,})\s*$/m,
      // Numbered sections
      /^(\d+\.\s*[A-Z][a-zA-Z\s&-]{5,})\s*$/m,
      // Common climbing section patterns
      /^(BASIC\s+[A-Z]+|ADVANCED\s+[A-Z]+|SAFETY\s+[A-Z]+|EQUIPMENT\s+[A-Z]+|TECHNIQUE\s+[A-Z]+)\s*$/m
    ];

    for (const pattern of headingPatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    // Look for common climbing section keywords at the start of text
    const commonSections = [
      'sleeping system', 'campsite selection', 'food and water', 'stoves',
      'basic safety', 'knots', 'anchors', 'belaying', 'rappelling',
      'rock protection', 'leading', 'aid climbing', 'snow travel', 
      'ice climbing', 'avalanche safety', 'glacier travel', 'rescue',
      'first aid', 'leadership', 'navigation', 'weather'
    ];

    const textLower = text.toLowerCase();
    for (const section of commonSections) {
      if (textLower.includes(section)) {
        return section.split(' ').map(word => 
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
      }
    }

    return null;
  }

  getChapterTitle(chapterName) {
    // Extract clean chapter title from filename
    const match = chapterName.match(/Ch\d+_Chapter\s*(\d+)\.\s*(.+)\.pdf$/i);
    if (match) {
      return `Chapter ${match[1]}: ${match[2]}`;
    }
    return chapterName.replace('.pdf', '');
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

  async listBooksAndChapters() {
    try {
      const bookDirs = await fs.readdir(BOOKS_DIR);
      const books = [];

      for (const bookDir of bookDirs) {
        const bookPath = path.join(BOOKS_DIR, bookDir);
        const stat = await fs.stat(bookPath);
        
        if (stat.isDirectory()) {
          const files = await fs.readdir(bookPath);
          const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
          
          const chapters = await Promise.all(
            pdfFiles.map(async (file) => {
              const metadataPath = path.join(bookPath, file.replace('.pdf', '.json'));
              let metadata = { title: file, description: 'No description available' };
              
              try {
                const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                metadata = JSON.parse(metadataContent);
              } catch (err) {
                // Metadata file doesn't exist, use defaults
              }
              
              // Check if content has been extracted using book/chapter structure
              const cachedContent = await this.getCachedContent(file);
              const extractionStatus = cachedContent ? {
                extracted: true,
                extractedAt: cachedContent.extractedAt,
                totalPages: cachedContent.totalPages,
                textLength: this.formatBytes(cachedContent.text?.length || 0),
                chunkCount: cachedContent.textChunks?.length || 0
              } : {
                extracted: false,
                message: 'Use get_chapter_text to process this chapter'
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

          books.push({
            bookName: bookDir,
            bookTitle: bookDir.replace(/_/g, ' '),
            chapterCount: chapters.length,
            chapters: chapters
          });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `CLIMBING RESOURCE BOOKS (${books.length} books, ${books.reduce((sum, book) => sum + book.chapterCount, 0)} total chapters)\n\n${JSON.stringify(books, null, 2)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing books and chapters: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }

  async extractChapterContent(bookName, chapterName, forceReextract) {
    try {
      const filePath = path.join(BOOKS_DIR, bookName, chapterName);
      await fs.access(filePath);

      // Check if already extracted and not forcing re-extraction
      if (!forceReextract) {
        const cached = await this.getCachedContent(chapterName);
        if (cached) {
          return {
            content: [{
              type: 'text',
              text: `CONTENT ALREADY EXTRACTED for ${bookName}/${chapterName}
              
EXTRACTION INFO:
- Book: ${bookName.replace(/_/g, ' ')}
- Chapter: ${chapterName}
- Extracted: ${cached.extractedAt}
- Total Pages: ${cached.totalPages}
- Text Length: ${this.formatBytes(cached.text?.length || 0)}
- Text Chunks: ${cached.textChunks?.length || 0}

Use force_reextract=true to re-process this chapter.`
            }]
          };
        }
      }

      console.error(`Extracting content from ${bookName}/${chapterName}...`);
      const extractedContent = await this.comprehensiveExtractPDF(filePath, chapterName, bookName);

      return {
        content: [{
          type: 'text',
          text: `EXTRACTION COMPLETED for ${bookName}/${chapterName}

RESULTS:
- Book: ${bookName.replace(/_/g, ' ')}
- Chapter: ${chapterName}
- Total Pages: ${extractedContent.totalPages}
- Text Length: ${this.formatBytes(extractedContent.text.length)}
- Text Chunks Created: ${extractedContent.textChunks.length}
- Topics Identified: ${[...new Set(extractedContent.textChunks.flatMap(c => c.topics))].join(', ')}

The chapter is now ready for content search and section retrieval.`
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error extracting chapter content from ${bookName}/${chapterName}: ${error.message}`
        }],
        isError: true
      };
    }
  }

  async searchContent(query, maxResults) {
    try {
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\W+/).filter(w => w.length > 2);
      const results = [];

      // Get all books and their chapters
      const bookDirs = await fs.readdir(BOOKS_DIR);
      
      for (const bookDir of bookDirs) {
        const bookPath = path.join(BOOKS_DIR, bookDir);
        const stat = await fs.stat(bookPath);
        
        if (!stat.isDirectory()) continue;
        
        const files = await fs.readdir(bookPath);
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
              book: bookDir,
              bookTitle: bookDir.replace(/_/g, ' '),
              chapter: file,
              chapterTitle: cached.chapterName,
              matches: scoredMatches.slice(0, 2) // Top 2 matches per chapter
            });
          }
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

      // Build response with text and detailed page references
      let responseText = `SEARCH RESULTS for "${query}" (${results.length} chapters found across ${[...new Set(results.map(r => r.book))].length} books)\n\n`;

      results.slice(0, maxResults).forEach((result, index) => {
        const chapterTitle = this.getChapterTitle(result.chapter);
        responseText += `${index + 1}. BOOK: ${result.bookTitle}\n`;
        responseText += `   CHAPTER: ${chapterTitle}\n\n`;

        result.matches.forEach((match, matchIndex) => {
          responseText += `   RESULT ${matchIndex + 1} (Relevance Score: ${match.score}):\n`;
          
          // Build complete citation with book, chapter, section, and page
          let citation = `${result.bookTitle} - ${chapterTitle}`;
          if (match.sectionHeading) {
            citation += ` > ${match.sectionHeading}`;
          }
          const pageRef = match.startPage === match.endPage ? 
            `p. ${match.startPage}` : `pp. ${match.startPage}-${match.endPage}`;
          citation += ` (${pageRef})`;
          
          responseText += `   CITATION: ${citation}\n`;
          responseText += `   TOPICS: ${match.topics.join(', ')}\n`;
          
          // Show context with page information
          const contextSnippet = this.getContextSnippet(match.text, queryWords);
          responseText += `   CONTENT: "${contextSnippet}"\n`;
          
          // Add specific page references for key terms with full citations
          if (match.pageReferences && match.pageReferences.length > 0) {
            responseText += `   DETAILED REFERENCES:\n`;
            match.pageReferences.slice(0, 3).forEach(ref => {
              const fullRef = match.sectionHeading ? 
                `${result.bookTitle} - ${chapterTitle} > ${match.sectionHeading} (${ref.pageRange})` :
                `${result.bookTitle} - ${chapterTitle} (${ref.pageRange})`;
              responseText += `     - ${ref.term}: ${fullRef}\n`;
              responseText += `       Context: "${ref.context.trim()}"\n`;
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

  async getChapterSection(bookName, chapterName, sectionTopic, contextLevel) {
    try {
      const cached = await this.getCachedContent(chapterName);
      if (!cached) {
        return {
          content: [{
            type: 'text',
            text: `Chapter "${chapterName}" from book "${bookName}" not extracted. Use extract_chapter_content first.`
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
      
      const chapterTitle = this.getChapterTitle(chapterName);
      const bookTitle = bookName.replace(/_/g, ' ');
      let responseText = `SECTION CONTENT: "${sectionTopic}" from ${bookTitle} - ${chapterTitle}\n`;
      responseText += `CONTEXT LEVEL: ${contextLevel}\n\n`;

      relevantChunks.slice(0, maxChunks).forEach((chunk, index) => {
        const pageRef = chunk.startPage === chunk.endPage ? 
          `p. ${chunk.startPage}` : `pp. ${chunk.startPage}-${chunk.endPage}`;
        
        // Build complete citation
        let citation = `${bookTitle} - ${chapterTitle}`;
        if (chunk.sectionHeading) {
          citation += ` > ${chunk.sectionHeading}`;
        }
        citation += ` (${pageRef})`;
          
        responseText += `=== CONTENT ${index + 1} ===\n`;
        responseText += `CITATION: ${citation}\n`;
        responseText += `TOPICS: ${chunk.topics.join(', ')}\n\n`;
        responseText += `${chunk.text}\n\n`;
        
        // Add specific page references for key terms with full citations
        if (chunk.pageReferences && chunk.pageReferences.length > 0) {
          responseText += `DETAILED REFERENCES:\n`;
          chunk.pageReferences.forEach(ref => {
            const fullRef = chunk.sectionHeading ? 
              `${bookTitle} - ${chapterTitle} > ${chunk.sectionHeading} (${ref.pageRange})` :
              `${bookTitle} - ${chapterTitle} (${ref.pageRange})`;
            responseText += `- ${ref.term}: ${fullRef}\n`;
            responseText += `  Context: "${ref.context.trim()}"\n`;
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


  async getChapterText(bookName, chapterName, startChars = 0, length = 1000, forceReextract = false) {
    try {
      // Check if extraction is needed
      let cached = await this.getCachedContent(chapterName);
      
      if (!cached || forceReextract) {
        // Extract the chapter first
        console.error(`Extracting content for ${bookName}/${chapterName}...`);
        const filePath = path.join(BOOKS_DIR, bookName, chapterName);
        
        try {
          await fs.access(filePath);
          const extractedContent = await this.comprehensiveExtractPDF(filePath, chapterName, bookName);
          cached = extractedContent;
        } catch (extractError) {
          return {
            content: [{
              type: 'text',
              text: `Error extracting chapter from ${bookName}/${chapterName}: ${extractError.message}`
            }],
            isError: true
          };
        }
      }

      if (!cached || !cached.text) {
        return {
          content: [{
            type: 'text',
            text: `No text content available for "${chapterName}".`
          }],
          isError: true
        };
      }

      // Apply text reconstruction to clean up the raw text
      const cleanedText = this.reconstructText(cached.text);
      
      const textLength = cleanedText.length;
      const endChars = Math.min(startChars + length, textLength);
      const extractedText = cleanedText.substring(startChars, endChars);
      
      // Estimate which pages this text section covers
      const estimatedStartPage = Math.ceil((startChars / textLength) * cached.totalPages) || 1;
      const estimatedEndPage = Math.ceil((endChars / textLength) * cached.totalPages) || cached.totalPages;
      
      const pageRef = estimatedStartPage === estimatedEndPage ? 
        `p. ${estimatedStartPage}` : `pp. ${estimatedStartPage}-${estimatedEndPage}`;
      
      const chapterTitle = this.getChapterTitle(chapterName);
      const bookTitle = bookName.replace(/_/g, ' ');
      
      // Try to detect section heading in the extracted text
      const sectionHeading = this.detectSectionHeading(extractedText);
      
      let citation = `${bookTitle} - ${chapterTitle}`;
      if (sectionHeading) {
        citation += ` > ${sectionHeading}`;
      }
      citation += ` (${pageRef})`;
      
      let responseText = `CHAPTER CONTENT from ${bookTitle} - ${chapterTitle}\n`;
      responseText += `CITATION: ${citation}\n`;
      responseText += `POSITION: Characters ${startChars}-${endChars} of ${textLength} total\n`;
      responseText += `TOTAL PAGES: ${cached.totalPages}\n`;
      responseText += `EXTRACTED: ${cached.extractedAt}\n\n`;
      responseText += `CONTENT:\n${extractedText}\n`;
      
      if (endChars < textLength) {
        responseText += `\n[Content continues for ${textLength - endChars} more characters...]`;
        responseText += `\n[To see more content, use start_chars=${endChars}]`;
      }

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
          text: `Error getting chapter text: ${error.message}`
        }],
        isError: true
      };
    }
  }

  async run() {
    // Ensure all directories exist
    try {
      await fs.mkdir(BOOKS_DIR, { recursive: true });
      await fs.mkdir(EXTRACTED_DIR, { recursive: true });
    } catch (error) {
      console.error('Error creating directories:', error);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Climbing Resources MCP server running on stdio');
  }
}

const server = new ClimbingResourcesServer();
server.run().catch(console.error);