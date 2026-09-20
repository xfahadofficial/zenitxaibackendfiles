require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const path = require('path');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require('@google/genai');
const {
  upsertUser,
  getUserById,
  getUserByEmail,
  createEmailUser,
  verifyPassword,
  getChatsByUser,
  getChatById,
  saveChat,
  deleteChat
} = require('./db');

const app = express();

// ─── Environment Configuration ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const AI_BACKEND_URL = (process.env.AI_BACKEND_URL || 'http://localhost:8081/v1').replace(/\/+$/, '');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gemini-1.5-flash';
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 60000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const crypto = require('crypto');
  const generated = crypto.randomBytes(48).toString('hex');
  console.warn('[Auth] JWT_SECRET not set in .env — using auto-generated secret (tokens invalidated on restart).');
  return generated;
})();

// Google GenAI SDK & System Instructions
const googleAI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Strictly instruct the AI model to respond using standard Markdown only without internal XML tags
const SYSTEM_PROMPT = `You are ZenitX AI, an advanced AI assistant. Strictly respond using standard Markdown only. Never output internal tags like <Steps>, <Step>, <Elicitations>, <thought>, <think>, or custom XML wrappers. Always provide clean, direct, and structured Markdown responses.`;

// Fast model fallback order: active, high-performance 2026 Gemini models with zero backoff wait time
const DEFAULT_FAST_MODEL = (process.env.AI_MODEL && !process.env.AI_MODEL.includes('1.5') && !process.env.AI_MODEL.includes('2.0'))
  ? process.env.AI_MODEL
  : 'gemini-3.6-flash';
const VALID_CANDIDATE_MODELS = [
  DEFAULT_FAST_MODEL,
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite'
];

function getCandidateModels() {
  return [...new Set(VALID_CANDIDATE_MODELS.filter(Boolean))];
}

function normalizeGeminiContents(contents) {
  return (contents || []).map(c => ({
    role: c.role,
    parts: (c.parts || []).map(p => {
      if (p.inline_data) {
        return {
          inlineData: {
            mimeType: p.inline_data.mime_type || p.inline_data.mimeType,
            data: p.inline_data.data
          }
        };
      }
      return p;
    })
  }));
}

function contentsToOpenAIMessages(contents, systemInstruction) {
  const openAIMessages = (contents || []).map(c => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: (c.parts || []).map(p => p.text).filter(Boolean).join('\n')
  }));
  if (systemInstruction) {
    openAIMessages.unshift({ role: 'system', content: systemInstruction });
  }
  return openAIMessages;
}

function extractGeminiSseText(data) {
  try {
    const json = JSON.parse(data);
    return json?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  } catch {
    return '';
  }
}

function extractOpenAISseText(data) {
  try {
    const json = JSON.parse(data);
    return json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.message?.content || '';
  } catch {
    return '';
  }
}

async function* readSseDataEvents(readable, extractText) {
  if (!readable) return;
  const decoder = new TextDecoder();
  let buffer = '';

  if (typeof readable.getReader === 'function') {
    const reader = readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = rawEvent
          .split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).replace(/^\s/, ''))
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        const text = extractText(data);
        if (text) yield text;
      }
    }
  } else if (readable[Symbol.asyncIterator]) {
    for await (const chunk of readable) {
      buffer += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = rawEvent
          .split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).replace(/^\s/, ''))
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        const text = extractText(data);
        if (text) yield text;
      }
    }
  }
}

/**
 * Creates a stateful stream filter that suppresses internal reasoning/XML tags (<thought>, <Steps>, etc.)
 * across streaming chunk boundaries without waiting for full response.
 */
function createStreamingTagCleaner() {
  let insideTag = false;
  let tagBuffer = '';
  const suppressedTags = ['steps', 'step', 'elicitations', 'thought', 'think', 'response', 'output', 'result', 'system_instructions'];

  return function filterChunk(chunk) {
    if (!chunk) return '';
    tagBuffer += chunk;
    let output = '';
    while (tagBuffer.length > 0) {
      if (insideTag) {
        const closeIdx = tagBuffer.indexOf('</');
        if (closeIdx === -1) {
          tagBuffer = '';
          break;
        }
        const endTagClose = tagBuffer.indexOf('>', closeIdx);
        if (endTagClose === -1) {
          tagBuffer = tagBuffer.slice(closeIdx);
          break;
        }
        tagBuffer = tagBuffer.slice(endTagClose + 1);
        insideTag = false;
        continue;
      }
      const openIdx = tagBuffer.indexOf('<');
      if (openIdx === -1) {
        output += tagBuffer;
        tagBuffer = '';
        break;
      }
      if (openIdx > 0) {
        output += tagBuffer.slice(0, openIdx);
        tagBuffer = tagBuffer.slice(openIdx);
      }
      const closeIdx = tagBuffer.indexOf('>');
      if (closeIdx === -1) {
        if (tagBuffer.length > 50) {
          output += tagBuffer;
          tagBuffer = '';
        }
        break;
      }
      const fullTag = tagBuffer.slice(0, closeIdx + 1);
      const tagMatch = fullTag.match(/^<\/?([a-zA-Z0-9_:-]+)/);
      if (tagMatch && suppressedTags.includes(tagMatch[1].toLowerCase())) {
        const tagName = tagMatch[1].toLowerCase();
        if (['thought', 'think', 'steps', 'step', 'elicitations'].includes(tagName) && !fullTag.startsWith('</')) {
          const closingTag = '</' + tagName + '>';
          const endIdx = tagBuffer.toLowerCase().indexOf(closingTag);
          if (endIdx !== -1) {
            tagBuffer = tagBuffer.slice(endIdx + closingTag.length);
            continue;
          } else {
            insideTag = true;
            tagBuffer = '';
            break;
          }
        }
        tagBuffer = tagBuffer.slice(closeIdx + 1);
      } else {
        output += fullTag;
        tagBuffer = tagBuffer.slice(closeIdx + 1);
      }
    }
    return output;
  };
}

/**
 * Checks whether an error represents an HTTP 503 / UNAVAILABLE / high demand condition.
 */
function isHighDemandError(err) {
  if (!err) return false;
  if (err.status === 503 || err.statusCode === 503) return true;
  const msg = (err.message || String(err)).toLowerCase();
  return msg.includes('503') ||
         msg.includes('unavailable') ||
         msg.includes('overloaded') ||
         msg.includes('high demand') ||
         msg.includes('resource exhausted') ||
         msg.includes('resource_exhausted') ||
         msg.includes('rate limit');
}

/**
 * Formats API errors into clean, user-friendly responses.
 * Never leaks raw API JSON strings for 503/high load errors.
 */
function formatUserFriendlyError(error) {
  if (!error) return 'An unexpected server error occurred.';
  const rawMsg = error.message || (typeof error === 'string' ? error : JSON.stringify(error));

  if (isHighDemandError(error)) {
    return 'Server is currently under high load. Please try again in a few seconds.';
  }

  try {
    const parsed = JSON.parse(rawMsg);
    if (parsed?.error?.message) {
      if (isHighDemandError(parsed.error) || isHighDemandError({ message: parsed.error.message })) {
        return 'Server is currently under high load. Please try again in a few seconds.';
      }
      return parsed.error.message;
    }
  } catch {}

  const jsonMatch = rawMsg.match(/\{"error":\s*\{[^}]+\}\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed?.error?.message) {
        if (isHighDemandError(parsed.error) || isHighDemandError({ message: parsed.error.message })) {
          return 'Server is currently under high load. Please try again in a few seconds.';
        }
        return parsed.error.message;
      }
    } catch {}
  }

  return rawMsg;
}

/**
 * Strips custom XML, system tags, and internal reasoning tags from the AI response.
 * @param {string} text
 * @returns {string} Cleaned markdown text
 */
function cleanAIResponse(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  // Strip paired internal/reasoning tags and their contents
  cleaned = cleaned.replace(/<(?:Steps|Step|Elicitations|thought|think)[^>]*>[\s\S]*?<\/(?:Steps|Step|Elicitations|thought|think)>/gi, '');
  // Strip any stray opening or closing tags for these elements
  cleaned = cleaned.replace(/<\/?(?:Steps|Step|Elicitations|thought|think)[^>]*>/gi, '');
  // Strip generic custom XML wrappers
  cleaned = cleaned.replace(/<\/?(?:response|output|result|system_instructions)[^>]*>/gi, '');
  // Collapse excess blank lines and trim whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/**
 * Unified Gemini AI Client for generating content with automatic retries and model fallback
 */
const ai = {
  /**
   * Generates content using Google Gemini SDK or direct API with automatic retries & model fallback.
   * - 3 automatic retries per model on 503 / high demand
   * - Automatic fallback to gemini-1.5-flash or gemini-2.0-flash if main model fails with 503
   * @param {Object} options
   * @param {Array} options.contents - Mapped Gemini contents array [{ role: 'user'|'model', parts: [{ text }] }]
   * @param {string} [options.systemInstruction] - Optional system prompt
   */
  async generateContent({ contents, systemInstruction = SYSTEM_PROMPT }) {
    const candidateModels = getCandidateModels();
    const normalizedContents = normalizeGeminiContents(contents);
    let lastError = null;

    if (googleAI) {
      for (const modelName of candidateModels) {
        try {
          console.log(`[Gemini AI] Calling model '${modelName}'...`);
          const response = await googleAI.models.generateContent({
            model: modelName,
            contents: normalizedContents,
            config: {
              systemInstruction
            }
          });
          return {
            text: response.text || '',
            modelUsed: modelName
          };
        } catch (err) {
          lastError = err;
          console.warn(`[Gemini AI Error] Model '${modelName}' failed:`, err.status || err.message?.slice(0, 100));

          // Zero backoff: fallback immediately to next model
          const msg = (err.message || String(err)).toLowerCase();
          if (err.status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('no longer available')) {
            console.log(`[Gemini AI] Model '${modelName}' not available. Falling back immediately...`);
            continue;
          }

          if (isHighDemandError(err)) {
            console.warn(`[Gemini AI] High Demand on '${modelName}'. Falling back immediately with zero backoff...`);
            continue;
          }

          if (err.status && err.status >= 400 && err.status < 500 && err.status !== 404 && err.status !== 429) {
            throw err;
          }
          continue;
        }
      }

      const err = lastError || new Error('Server is currently under high load. Please try again in a few seconds.');
      err.status = 503;
      throw err;
    }

    if (GEMINI_API_KEY) {
      for (const modelName of candidateModels) {
        try {
          const directApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
          const payload = {
            contents,
            system_instruction: {
              parts: [{ text: systemInstruction }]
            }
          };
          const res = await fetch(directApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            const errText = await res.text();
            const err = new Error(`Gemini API error (${res.status}):${errText}`);
            err.status = res.status;
            // Zero backoff: fallback immediately
            continue;
          }

          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
          return { text, modelUsed: modelName };
        } catch (err) {
          lastError = err;
          continue;
        }
      }

      const err = lastError || new Error('Server is currently under high load. Please try again in a few seconds.');
      err.status = 503;
      throw err;
    }

    // Fallback to local OpenAI-compatible endpoint if no GEMINI_API_KEY
    const openAIMessages = contentsToOpenAIMessages(contents, systemInstruction);
    const res = await fetch(`${AI_BACKEND_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(AI_API_KEY ? { 'Authorization': `Bearer ${AI_API_KEY}` } : {})
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: openAIMessages
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`AI backend error (${res.status}):${errText}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return { text, modelUsed: AI_MODEL };
  },

  /**
   * Generates streaming content chunks with zero backoff and fast model fallback.
   * Yields { text, modelUsed } for each token/chunk received.
   */
  async *generateContentStream({ contents, systemInstruction = SYSTEM_PROMPT }) {
    const candidateModels = getCandidateModels();
    const normalizedContents = normalizeGeminiContents(contents);
    let lastError = null;

    if (googleAI) {
      for (const modelName of candidateModels) {
        try {
          console.log(`[Gemini AI Stream] Calling model '${modelName}'...`);
          const responseStream = await googleAI.models.generateContentStream({
            model: modelName,
            contents: normalizedContents,
            config: {
              systemInstruction
            }
          });

          let yieldedAny = false;
          for await (const chunk of responseStream) {
            const text = chunk.text;
            if (text) {
              yieldedAny = true;
              yield { text, modelUsed: modelName };
            }
          }
          if (yieldedAny) {
            return;
          }
        } catch (err) {
          lastError = err;
          console.warn(`[Gemini AI Stream Error] Model '${modelName}' failed:`, err.status || err.message?.slice(0, 100));

          // Zero backoff: fallback immediately to next candidate model
          const msg = (err.message || String(err)).toLowerCase();
          if (err.status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('no longer available')) {
            console.log(`[Gemini AI Stream] Model '${modelName}' not available (404). Falling back immediately...`);
            continue;
          }

          if (isHighDemandError(err)) {
            console.warn(`[Gemini AI Stream] High Demand on '${modelName}'. Falling back immediately with zero backoff...`);
            continue;
          }

          if (err.status && err.status >= 400 && err.status < 500 && err.status !== 404 && err.status !== 429) {
            throw err;
          }
          continue;
        }
      }

      const err = lastError || new Error('Server is currently under high load. Please try again in a few seconds.');
      if (!err.status) err.status = 503;
      throw err;
    }

    if (GEMINI_API_KEY) {
      for (const modelName of candidateModels) {
        try {
          const directApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;
          const payload = {
            contents,
            system_instruction: {
              parts: [{ text: systemInstruction }]
            }
          };
          const res = await fetch(directApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            const errText = await res.text();
            const err = new Error(`Gemini API error (${res.status}):${errText}`);
            err.status = res.status;
            continue;
          }

          let yieldedAny = false;
          for await (const text of readSseDataEvents(res.body, extractGeminiSseText)) {
            if (text) {
              yieldedAny = true;
              yield { text, modelUsed: modelName };
            }
          }
          if (yieldedAny) {
            return;
          }
        } catch (err) {
          lastError = err;
          continue;
        }
      }

      const err = lastError || new Error('Server is currently under high load. Please try again in a few seconds.');
      if (!err.status) err.status = 503;
      throw err;
    }

    // Fallback to local OpenAI-compatible endpoint if no GEMINI_API_KEY
    const openAIMessages = contentsToOpenAIMessages(contents, systemInstruction);
    const res = await fetch(`${AI_BACKEND_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(AI_API_KEY ? { 'Authorization': `Bearer ${AI_API_KEY}` } : {})
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: openAIMessages,
        stream: true
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`AI backend error (${res.status}):${errText}`);
      err.status = res.status;
      throw err;
    }

    for await (const text of readSseDataEvents(res.body, extractOpenAISseText)) {
      if (text) {
        yield { text, modelUsed: AI_MODEL };
      }
    }
  }
};

// Hugging Face Configuration for FLUX.1 / Stable Diffusion image generation
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';

function getHfToken() {
  const token = (process.env.HF_TOKEN || HF_TOKEN || '').trim();
  const placeholderValues = new Set([
    'your_token_here',
    'your_hf_token_here',
    'hf_example',
    'changeme',
    'replace_me',
    'example_token'
  ]);

  return placeholderValues.has(token.toLowerCase()) ? '' : token;
}

if (getHfToken()) {
  console.log(`[HF] Hugging Face Image Generation connected — model: ${HF_IMAGE_MODEL}`);
} else {
  console.warn('[HF] process.env.HF_TOKEN is missing or still using a placeholder value. Add a valid token in server/.env to enable image generation.');
}

// ─── Middleware ──────────────────────────────────────────────────────────────
// Full CORS setup allowing cross-origin requests from any frontend
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  credentials: false
}));

// JSON body parser
app.use(express.json({ limit: '10mb' }));

// Strip trailing slash to prevent 404 on URLs like /api/v1/chat/
app.use((req, res, next) => {
  if (req.path.length > 1 && req.path.endsWith('/')) {
    const query = req.url.slice(req.path.length);
    req.url = req.path.slice(0, -1) + query;
  }
  next();
});

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// ─── Multer: Multi-File Upload ────────────────────────────────────────────────
const FILE_SIZE_LIMIT_MB = parseInt(process.env.FILE_SIZE_LIMIT_MB, 10) || 20;
const MAX_FILES = 10;

const SUPPORTED_IMAGE_EXTS  = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SUPPORTED_TEXT_EXTS   = new Set([
  '.txt', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.md', '.py',
  '.java', '.c', '.cpp', '.cs', '.rb', '.go', '.sh', '.yaml', '.yml', '.xml', '.csv'
]);
const SUPPORTED_PDF_TYPE    = 'application/pdf';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: FILE_SIZE_LIMIT_MB * 1024 * 1024,
    files: MAX_FILES
  }
});

const uploadFilesMiddleware = (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            error: `File too large. Maximum allowed size is ${FILE_SIZE_LIMIT_MB}MB per file.`
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            success: false,
            error: `Too many files. Maximum allowed is ${MAX_FILES} files per request.`
          });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({
            success: false,
            error: `Validation failed: Files must be uploaded under the 'files' field (up to ${MAX_FILES} files).`
          });
        }
        return res.status(400).json({
          success: false,
          error: `Upload error: ${err.message}`
        });
      }
      return res.status(400).json({
        success: false,
        error: err.message || 'File upload error.'
      });
    }
    next();
  });
};

async function extractPdfText(buffer) {
  if (typeof pdfParse === 'function') {
    const parsed = await pdfParse(buffer);
    return parsed?.text?.trim() || '';
  }
  if (pdfParse && pdfParse.PDFParse) {
    const parser = new pdfParse.PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      return parsed?.text?.trim() || '';
    } finally {
      await parser.destroy();
    }
  }
  throw new Error('PDF parsing engine is not available.');
}

async function compressImageIfNeeded(buffer, mimeType) {
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  if (buffer.length <= MAX_IMAGE_BYTES) {
    return { buffer, mimeType };
  }

  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);

    let width = image.width;
    let height = image.height;
    const maxDimension = 1536;

    if (width > maxDimension || height > maxDimension) {
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    const compressedBuffer = canvas.toBuffer('image/jpeg', { quality: 0.8 });
    console.log(`[Image Compressed] Reduced from ${(buffer.length / 1024 / 1024).toFixed(2)}MB to${(compressedBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    return { buffer: compressedBuffer, mimeType: 'image/jpeg' };
  } catch (compressErr) {
    console.warn('[Image Compression Warning]:', compressErr.message);
    return { buffer, mimeType };
  }
}

// ─── Auth: Google OAuth2 Client ──────────────────────────────────────────────
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required. Provide a Bearer token.' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};

const optionalJWT = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore */ }
  }
  next();
};

// ─── Endpoints ───────────────────────────────────────────────────────────────

app.get(['/', '/api', '/api/v1'], (req, res) => {
  res.status(200).json({
    name: 'ZenitX AI REST API Server',
    version: '2.0.0',
    endpoints: {
      health:        'GET  /api/v1/health (aliases: /health, /api/health)',
      models:        'GET  /v1/models (aliases: /api/v1/models, /models)',
      auth_google:   'POST /api/v1/auth/google',
      auth_signup:   'POST /api/v1/auth/signup',
      auth_login:    'POST /api/v1/auth/login',
      auth_me:       'GET  /api/v1/auth/me (JWT required)',
      chat:          'POST /api/v1/chat (aliases: /chat, /api/chat, /v1/chat/completions)',
      chats_list:    'GET  /api/v1/chats (JWT required)',
      chats_get:     'GET  /api/v1/chats/:id (JWT required)',
      chats_save:    'POST /api/v1/chats/save (JWT required)',
      chats_delete:  'DELETE /api/v1/chats/:id (JWT required)',
      generate_image:'POST /api/v1/generate-image (aliases: /generate-image, /v1/images/generations)',
      analyze_link:  'POST /api/v1/analyze-link (aliases: /analyze-link, /api/analyze-link)',
      analyze_files: 'POST /api/v1/analyze-files (aliases: /analyze-files, multipart/form-data)',
      analyze_image: 'POST /api/v1/analyze-image (alias for analyze-files)'
    },
    image_model: HF_IMAGE_MODEL,
    ai_model: AI_MODEL,
    available_models: getCandidateModels()
  });
});

app.get(['/health', '/api/health', '/api/v1/health'], (req, res) => {
  const hfConfigured = Boolean(getHfToken());
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
    huggingface: {
      connected: hfConfigured,
      model: HF_IMAGE_MODEL,
      endpoints: [
        'https://router.huggingface.co/nscale/v1/images/generations',
        `https://api-inference.huggingface.co/models/${HF_IMAGE_MODEL}`
      ]
    },
    gemini: {
      connected: Boolean(googleAI || GEMINI_API_KEY),
      active_model: AI_MODEL,
      fallback_models: getCandidateModels()
    }
  });
});

// OpenAI & ZenitX Models List
app.get(['/models', '/v1/models', '/api/models', '/api/v1/models'], (req, res) => {
  const candidateList = getCandidateModels();
  const modelsData = candidateList.map(m => ({
    id: m,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'zenitx-google',
    permission: [],
    root: m,
    parent: null
  }));
  return res.status(200).json({
    object: 'list',
    data: modelsData,
    models: candidateList
  });
});

app.post(['/auth/google', '/api/auth/google', '/api/v1/auth/google'], async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ success: false, error: "Body must contain a 'credential' field with a Google ID token." });
    }
    if (!googleClient) {
      return res.status(503).json({ success: false, error: 'Google OAuth is not configured on this server. Set GOOGLE_CLIENT_ID in .env.' });
    }
    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid Google credential token.' });
    }
    const payload = ticket.getPayload();
    const user = upsertUser({
      google_id:  payload.sub,
      name:        payload.name || payload.email,
      email:      payload.email,
      avatar_url: payload.picture || null
    });
    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    return res.status(200).json({
      success: true,
      token: sessionToken,
      user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url }
    });
  } catch (err) {
    console.error('[Auth Google Error]:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

app.post(['/auth/signup', '/api/auth/signup', '/api/v1/auth/signup'], async (req, res) => {
  try {
    const { name, email, password, terms_accepted } = req.body || {};

    const termsAccepted = terms_accepted !== undefined ? Boolean(terms_accepted) : true;
    if (!termsAccepted) {
      return res.status(400).json({ success: false, error: 'You must accept the Terms & Conditions to create an account.' });
    }
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Full name must be at least 2 characters.' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = getUserByEmail(cleanEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: 'An account with this email address already exists. Please log in.' });
    }

    const user = createEmailUser({ name: name.trim(), email: cleanEmail, password });
    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      success: true,
      token: sessionToken,
      user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url || null }
    });
  } catch (err) {
    console.error('[Auth Signup Error]:', err);
    return res.status(500).json({ success: false, error: 'Failed to create account. Please try again.' });
  }
});

app.post(['/auth/login', '/api/auth/login', '/api/v1/auth/login'], async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = getUserByEmail(cleanEmail);
    if (!user || !user.password_hash) {
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      success: true,
      token: sessionToken,
      user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url || null }
    });
  } catch (err) {
    console.error('[Auth Login Error]:', err);
    return res.status(500).json({ success: false, error: 'Failed to log in. Please try again.' });
  }
});

app.get(['/auth/me', '/api/auth/me', '/api/v1/auth/me'], authenticateJWT, (req, res) => {
  const user = getUserById(req.user.id);
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  return res.status(200).json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url || null }
  });
});

app.get(['/chats', '/api/chats', '/api/v1/chats'], authenticateJWT, (req, res) => {
  try {
    const chats = getChatsByUser(req.user.id);
    return res.status(200).json({ success: true, chats });
  } catch (err) {
    console.error('[Chats List Error]:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

app.get(['/chats/:id', '/api/chats/:id', '/api/v1/chats/:id'], authenticateJWT, (req, res) => {
  try {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId || isNaN(chatId)) return res.status(400).json({ success: false, error: 'Invalid chat id.' });
    const chat = getChatById(chatId, req.user.id);
    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found.' });
    return res.status(200).json({ success: true, chat: { id: chat.id, title: chat.title, messages: chat.messages, updated_at: chat.updated_at } });
  } catch (err) {
    console.error('[Chat Get Error]:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

app.post(['/chats/save', '/api/chats/save', '/api/v1/chats/save'], authenticateJWT, (req, res) => {
  try {
    const { chat_id, title, messages } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ success: false, error: "'messages' must be an array." });
    const chatId = saveChat({
      userId:  req.user.id,
      chatId:  chat_id ? parseInt(chat_id, 10) : null,
      title:   title || (messages[0]?.content || 'New Chat').toString().slice(0, 60),
      messages
    });
    return res.status(200).json({ success: true, chat_id: chatId });
  } catch (err) {
    console.error('[Chat Save Error]:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

app.delete(['/chats/:id', '/api/chats/:id', '/api/v1/chats/:id'], authenticateJWT, (req, res) => {
  try {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId || isNaN(chatId)) return res.status(400).json({ success: false, error: 'Invalid chat id.' });
    const deleted = deleteChat(chatId, req.user.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Chat not found or already deleted.' });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Chat Delete Error]:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

app.delete(['/chats', '/api/chats', '/api/v1/chats'], authenticateJWT, (req, res) => {
  return res.status(400).json({ success: false, error: 'Chat ID is required in the path (e.g. DELETE /api/v1/chats/:id).' });
});

const URL_IN_PROMPT_RE = /https?:\/\/[^\s<>"'`]+/i;
const IMAGE_GEN_INTENT_RE = /\b(?:generate|create|draw|make|render)\b.{0,40}\b(?:image|images|picture|pictures|photo|illustration|artwork|drawing)\b|\b(?:text[\s-]?to[\s-]?image|image[\s-]?generation)\b|\b(?:flux\.?\s*1|stable\s+diffusion)\b/i;
const LINK_REVIEW_INTENT_RE = /\b(?:review\s+this\s+page|review\s+this\s+(?:site|website|link|url|article)|analyze\s+this\s+(?:page|site|website|link|url|article)|summarize\s+this\s+(?:page|site|website|link|url|article)|scrape\s+this\s+(?:page|site|website|link|url)|link\s+analy[sz]er)\b/i;

function extractHttpUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(URL_IN_PROMPT_RE);
  if (!match) return null;
  return match[0].replace(/[.,);!?]+$/, '');
}

function isImageGenerationIntent(text) {
  return typeof text === 'string' && IMAGE_GEN_INTENT_RE.test(text);
}

function isLinkAnalysisIntent(text) {
  if (!text || typeof text !== 'string') return false;
  return URL_IN_PROMPT_RE.test(text) || LINK_REVIEW_INTENT_RE.test(text);
}

function extractImagePrompt(text) {
  const cleaned = String(text || '')
    .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:generate|create|draw|make|render)(?:\s+me)?(?:\s+an?)?\s+(?:image|picture|photo|illustration|artwork|drawing)(?:\s+of)?\s*/i, '')
    .trim();
  return cleaned || String(text || '').trim();
}

function persistChatTurn(req, { chatId, userPromptString, assistantMessage, mappedContents }) {
  if (!req.user || !req.user.id) return null;
  try {
    const rawChatId = chatId ? parseInt(chatId, 10) : null;
    let existingMessages = [];
    let chatTitle = null;

    if (rawChatId) {
      const existingChat = getChatById(rawChatId, req.user.id);
      if (existingChat) {
        existingMessages = Array.isArray(existingChat.messages) ? existingChat.messages : [];
        chatTitle = existingChat.title;
      }
    }

    if (existingMessages.length === 0 && Array.isArray(mappedContents) && mappedContents.length > 1) {
      const prior = mappedContents.slice(0, -1);
      existingMessages = prior.map(c => ({
        role: c.role === 'model' ? 'assistant' : 'user',
        content: c.parts?.[0]?.text || '',
        timestamp: new Date().toISOString()
      }));
    }

    existingMessages.push({
      role: 'user',
      content: userPromptString,
      timestamp: new Date().toISOString()
    });
    existingMessages.push({
      role: 'assistant',
      content: assistantMessage,
      timestamp: new Date().toISOString()
    });

    if (!chatTitle) {
      chatTitle = userPromptString.slice(0, 60);
    }

    return saveChat({
      userId: req.user.id,
      chatId: rawChatId,
      title: chatTitle,
      messages: existingMessages
    });
  } catch (saveErr) {
    console.warn('[Auto-Save Chat Warning]:', saveErr.message);
    return null;
  }
}

app.post(['/chat', '/api/chat', '/api/v1/chat', '/v1/chat/completions', '/api/v1/chat/completions', '/chat/completions'], optionalJWT, async (req, res) => {
  try {
    const { prompt, messages, chat_id, stream } = req.body || {};
    const isStreaming = stream !== false;

    const mappedContents = [];

    if (Array.isArray(messages) && messages.length > 0) {
      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const rawRole = (msg.role || '').toLowerCase();
        const geminiRole = (rawRole === 'assistant' || rawRole === 'model') ? 'model' : 'user';
        const textContent = typeof msg.content === 'string' ? msg.content.trim() : JSON.stringify(msg.content);
        if (!textContent) continue;

        mappedContents.push({
          role: geminiRole,
          parts: [{ text: textContent }]
        });
      }
    }

    let userPromptString = '';
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
      userPromptString = prompt.trim();
      const lastContent = mappedContents[mappedContents.length - 1];
      if (!lastContent || lastContent.role !== 'user' || lastContent.parts?.[0]?.text !== userPromptString) {
        mappedContents.push({
          role: 'user',
          parts: [{ text: userPromptString }]
        });
      }
    } else {
      const lastUser = [...mappedContents].reverse().find(c => c.role === 'user');
      if (lastUser && lastUser.parts?.[0]?.text) {
        userPromptString = lastUser.parts[0].text;
      }
    }

    if (mappedContents.length === 0 || !userPromptString) {
      return res.status(400).json({
        success: false,
        error: "Validation failed: Either 'messages' array (with at least one user message) or 'prompt' is required."
      });
    }

    if (isImageGenerationIntent(userPromptString)) {
      console.log('[Chat Router] Image generation intent → Hugging Face Inference API');
      const hfPrompt = extractImagePrompt(userPromptString);
      try {
        const { image_url } = await generateImageWithHuggingFace(hfPrompt);
        const assistantMessage = `Here is the generated image:\n\n![Generated image](${image_url})`;
        const savedChatId = persistChatTurn(req, {
          chatId: chat_id,
          userPromptString,
          assistantMessage,
          mappedContents
        });
        if (isStreaming) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          res.write(`data: ${JSON.stringify({ chunk: assistantMessage, text: assistantMessage, response: assistantMessage, image_url, routed: 'huggingface' })}\n\n`);
          const donePayload = { done: true, success: true, image_url, routed: 'huggingface' };
          if (savedChatId !== null) donePayload.chat_id = savedChatId;
          res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        const payload = {
          success: true,
          response: assistantMessage,
          image_url,
          routed: 'huggingface'
        };
        if (savedChatId !== null) payload.chat_id = savedChatId;
        return res.status(200).json(payload);
      } catch (imgErr) {
        console.error('[Chat Router] Hugging Face image generation failed:', imgErr.message);
        const status = imgErr.status || 500;
        return res.status(status).json({
          success: false,
          error: imgErr.message || 'Image generation failed.',
          routed: 'huggingface'
        });
      }
    }

    if (isLinkAnalysisIntent(userPromptString)) {
      const targetUrl = extractHttpUrl(userPromptString);
      if (!targetUrl) {
        return res.status(400).json({
          success: false,
          error: 'A page URL (http:// or https://) is required to review or analyze a webpage.',
          routed: 'link-analyzer'
        });
      }
      console.log(`[Chat Router] Link analysis intent → scraper (${targetUrl})`);
      try {
        const analysis = await analyzeLinkPage(targetUrl, userPromptString);
        const assistantMessage = analysis.response;
        const savedChatId = persistChatTurn(req, {
          chatId: chat_id,
          userPromptString,
          assistantMessage,
          mappedContents
        });
        if (isStreaming) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          res.write(`data: ${JSON.stringify({ chunk: assistantMessage, text: assistantMessage, response: assistantMessage, url: analysis.url, fetch_method: analysis.fetch_method, routed: 'link-analyzer' })}\n\n`);
          const donePayload = { done: true, success: true, url: analysis.url, fetch_method: analysis.fetch_method, routed: 'link-analyzer' };
          if (savedChatId !== null) donePayload.chat_id = savedChatId;
          res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        const payload = {
          success: true,
          response: assistantMessage,
          url: analysis.url,
          fetch_method: analysis.fetch_method,
          routed: 'link-analyzer'
        };
        if (savedChatId !== null) payload.chat_id = savedChatId;
        return res.status(200).json(payload);
      } catch (linkErr) {
        console.error('[Chat Router] Link analysis failed:', linkErr.message);
        const status = linkErr.status || 500;
        return res.status(status).json({
          success: false,
          error: linkErr.message || 'Link analysis failed.',
          routed: 'link-analyzer'
        });
      }
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      let accumulatedRaw = '';
      const tagCleaner = createStreamingTagCleaner();

      for await (const chunkObj of ai.generateContentStream({ contents: mappedContents })) {
        const rawChunk = chunkObj.text || '';
        if (!rawChunk) continue;
        accumulatedRaw += rawChunk;
        const cleanChunk = tagCleaner(rawChunk);
        if (cleanChunk) {
          const chunkPayload = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: AI_MODEL,
            choices: [{ index: 0, delta: { content: cleanChunk }, finish_reason: null }],
            chunk: cleanChunk,
            text: cleanChunk,
            response: cleanChunk
          };
          res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
          if (typeof res.flush === 'function') res.flush();
        }
      }

      const assistantMessage = cleanAIResponse(accumulatedRaw);
      const savedChatId = persistChatTurn(req, {
        chatId: chat_id,
        userPromptString,
        assistantMessage,
        mappedContents
      });

      const donePayload = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: AI_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        done: true,
        success: true,
        response: assistantMessage
      };
      if (savedChatId !== null) {
        donePayload.chat_id = savedChatId;
      }
      res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const result = await ai.generateContent({ contents: mappedContents });
    const rawText = typeof result?.text === 'string' ? result.text : '';

    const assistantMessage = cleanAIResponse(rawText);

    if (!assistantMessage) {
      return res.status(502).json({
        success: false,
        error: 'Received empty or invalid response from Gemini API.'
      });
    }

    const savedChatId = persistChatTurn(req, {
      chatId: chat_id,
      userPromptString,
      assistantMessage,
      mappedContents
    });

    const responsePayload = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: AI_MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: assistantMessage
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: Math.ceil(userPromptString.length / 4),
        completion_tokens: Math.ceil(assistantMessage.length / 4),
        total_tokens: Math.ceil((userPromptString.length + assistantMessage.length) / 4)
      },
      success: true,
      response: assistantMessage
    };
    if (savedChatId !== null) {
      responsePayload.chat_id = savedChatId;
    }

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('[Chat Handler Error]:', error);
    const friendlyMsg = formatUserFriendlyError(error);
    const is503 = isHighDemandError(error) || error.status === 503;
    if (!res.headersSent) {
      return res.status(is503 ? 503 : 500).json({
        success: false,
        error: friendlyMsg
      });
    } else {
      res.write(`data: ${JSON.stringify({ error: friendlyMsg, status: is503 ? 503 : 500 })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  }
});

async function generateImageWithPollinations(prompt) {
  const cleanPrompt = (prompt || 'digital artwork').slice(0, 300);
  const encoded = encodeURIComponent(cleanPrompt);
  const seed = Math.floor(Math.random() * 100000);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux`;
  try {
    const res = await axios.get(pollinationsUrl, { responseType: 'arraybuffer', timeout: 25000 });
    const b64 = Buffer.from(res.data).toString('base64');
    const mime = res.headers['content-type'] || 'image/png';
    return { image_url: `data:${mime};base64,${b64}`, provider: 'pollinations' };
  } catch {
    return { image_url: pollinationsUrl, provider: 'pollinations' };
  }
}

async function generateImageWithHuggingFace(trimmedPrompt) {
  const token = getHfToken();
  if (!token) {
    console.warn('[HF] No valid HF_TOKEN, using Pollinations.ai fallback...');
    return await generateImageWithPollinations(trimmedPrompt);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, 45000));

    try {
      let hfResponse = await fetch('https://router.huggingface.co/nscale/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          model: HF_IMAGE_MODEL,
          response_format: 'b64_json'
        }),
        signal: controller.signal
      });

      if (!hfResponse.ok && hfResponse.status !== 503 && hfResponse.status !== 401 && hfResponse.status !== 403) {
        try {
          const fallback = await fetch(`https://api-inference.huggingface.co/models/${HF_IMAGE_MODEL}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Accept': 'image/png'
            },
            body: JSON.stringify({ inputs: trimmedPrompt }),
            signal: controller.signal
          });
          if (fallback.ok) hfResponse = fallback;
        } catch {}
      }

      if (hfResponse.status === 503) {
        if (attempt < maxRetries) {
          await sleep(3000);
          continue;
        }
        console.warn('[HF] 503 loading, falling back to Pollinations.ai...');
        return await generateImageWithPollinations(trimmedPrompt);
      }

      if (hfResponse.status === 401 || hfResponse.status === 403 || !hfResponse.ok) {
        console.warn(`[HF] Status ${hfResponse.status}, falling back to Pollinations.ai...`);
        return await generateImageWithPollinations(trimmedPrompt);
      }

      const contentType = hfResponse.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const json = await hfResponse.json();
        const base64Data = json?.data?.[0]?.b64_json
          || json?.[0]?.b64_json
          || json?.image
          || (typeof json === 'string' ? json : null);
        if (base64Data && typeof base64Data === 'string') {
          const raw = base64Data.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
          return { image_url: `data:image/png;base64,${raw}`, provider: 'huggingface' };
        }
      }

      const arrayBuffer = await hfResponse.arrayBuffer();
      const base64String = Buffer.from(arrayBuffer).toString('base64');
      const mime = contentType.includes('image') ? contentType.split(';')[0] : 'image/png';
      return { image_url: `data:${mime};base64,${base64String}`, provider: 'huggingface' };
    } catch (fetchErr) {
      console.warn('[HF] Fetch failed or timed out, falling back to Pollinations.ai:', fetchErr.message);
      return await generateImageWithPollinations(trimmedPrompt);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return await generateImageWithPollinations(trimmedPrompt);
}

app.post(['/generate-image', '/api/generate-image', '/api/v1/generate-image', '/v1/images/generations', '/api/v1/images/generations'], async (req, res) => {
  try {
    const { prompt } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "Validation failed: 'prompt' field is required and must be a non-empty string."
      });
    }

    const { image_url, provider } = await generateImageWithHuggingFace(prompt.trim());
    const base64Data = (image_url || '').replace(/^data:image\/[^;]+;base64,/, '');
    return res.status(200).json({
      success: true,
      image_url,
      provider: provider || 'huggingface',
      data: [{ b64_json: base64Data, url: image_url }]
    });
  } catch (error) {
    console.error('[Image Generation Handler Error]:', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'An unexpected internal error occurred during image generation.'
    });
  }
});

const analyzeFilesHandler = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY || GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'Vision request timed out or invalid API key.'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Validation failed: At least one file must be uploaded under the 'files' field."
      });
    }

    const userPrompt = (req.body.prompt && typeof req.body.prompt === 'string' && req.body.prompt.trim().length > 0)
      ? req.body.prompt.trim()
      : 'Analyze and describe the content of the provided file(s).';

    console.log(`[File Analysis] Processing ${req.files.length} file(s): ${req.files.map(f => f.originalname).join(', ')}`);

    let appendedText = '';
    const imageParts = [];
    let filesProcessed = 0;

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const mimetype = (file.mimetype || '').toLowerCase();

      const isImage = SUPPORTED_IMAGE_EXTS.has(ext) || SUPPORTED_IMAGE_TYPES.has(mimetype);
      const isPdf   = ext === '.pdf' || mimetype === SUPPORTED_PDF_TYPE;
      const isText  = SUPPORTED_TEXT_EXTS.has(ext) || mimetype.startsWith('text/') || mimetype === 'application/json' || mimetype === 'application/javascript';

      if (isImage) {
        let imageMime = mimetype;
        if (!SUPPORTED_IMAGE_TYPES.has(imageMime)) {
          if (ext === '.png') imageMime = 'image/png';
          else if (ext === '.jpg' || ext === '.jpeg') imageMime = 'image/jpeg';
          else if (ext === '.webp') imageMime = 'image/webp';
          else imageMime = 'image/png';
        }

        const { buffer: processedBuffer, mimeType: finalMime } = await compressImageIfNeeded(file.buffer, imageMime);
        const base64Data = processedBuffer.toString('base64');

        imageParts.push({
          inlineData: {
            mimeType: finalMime,
            data: base64Data
          }
        });
        filesProcessed++;

      } else if (isPdf) {
        try {
          const pdfText = await extractPdfText(file.buffer);
          appendedText += `\n\n--- [PDF File: ${file.originalname}] ---\n${pdfText || '(No extractable text found in PDF)'}`;
          filesProcessed++;
        } catch (pdfErr) {
          console.error(`[PDF Parse Error for ${file.originalname}]:`, pdfErr.message);
          return res.status(400).json({
            success: false,
            error: `Failed to parse PDF file '${file.originalname}': ${pdfErr.message}`
          });
        }

      } else if (isText) {
        const textContent = file.buffer.toString('utf-8');
        appendedText += `\n\n--- [File: ${file.originalname}] ---\n${textContent}`;
        filesProcessed++;

      } else {
        return res.status(400).json({
          success: false,
          error: `Unsupported file format: '${file.originalname}'. Supported formats are images (png, jpg, webp), text/code files (txt, js, html, json, md, py), and PDFs.`
        });
      }
    }

    const isReferenceImageDirective = imageParts.length > 0;
    let effectiveSystemInstruction = SYSTEM_PROMPT;
    let effectiveUserPrompt = userPrompt;

    if (isReferenceImageDirective) {
      effectiveSystemInstruction = `You are ZenitX AI's Nano Banana Reference Image Edit & Vision Engine.
Strict Protocol for Reference Image Editing:
1. Core Identity & Facial Preservation: Retain and lock the primary subject's facial structure, bone geometry, eyes, nose, lips, facial proportions, age, ethnicity, and anatomical identity with maximum fidelity from the reference image(s).
2. Directed Transformations: Accurately apply user-specified modifications regarding background environment, scene setting, clothing, aesthetic style, camera perspective, pose, and ambient lighting. Never replace or disfigure the reference subject's face or core identity.
3. Structured Output:
   - Provide an Executive Edit Summary explaining how the subject identity is preserved while modifying the background, pose, and lighting.
   - Provide an explicit Synthesis Description capturing the locked identity and new environment.`;

      effectiveUserPrompt = `[Nano Banana Reference Image Edit Directive]
User Instruction: ${userPrompt}

Please analyze the provided reference image(s). Lock and retain the primary subject's core facial structure, geometry, and physical identity while applying the requested background, pose, lighting, and environmental modifications.`;
    }

    const finalPrompt = effectiveUserPrompt + appendedText;
    const parts = [
      { text: finalPrompt },
      ...imageParts
    ];

    const geminiPayload = {
      contents: [
        {
          role: 'user',
          parts
        }
      ]
    };

    let result;
    try {
      result = await ai.generateContent({
        contents: geminiPayload.contents,
        systemInstruction: effectiveSystemInstruction
      });
    } catch (apiErr) {
      console.error('[Gemini Vision API Error]:', apiErr);
      const is503 = isHighDemandError(apiErr) || apiErr.status === 503;
      return res.status(is503 ? 503 : (apiErr.status || 500)).json({
        success: false,
        error: formatUserFriendlyError(apiErr)
      });
    }

    const rawText = typeof result?.text === 'string' ? result.text : '';
    const assistantMessage = cleanAIResponse(rawText);

    if (!assistantMessage) {
      return res.status(502).json({
        success: false,
        error: 'Invalid or empty response received from Gemini Vision API.'
      });
    }

    let generatedImageUrl = null;
    if (isReferenceImageDirective) {
      try {
        const cleanDirective = userPrompt.replace(/\[Nano Banana Reference Mode\]:?/i, '').trim();
        const synthesisPrompt = `${cleanDirective || 'Photo edit'}, preserving subject facial structure, highly detailed, photorealistic, 8k, cinematic lighting`;
        const token = getHfToken();
        if (token) {
          try {
            const gen = await generateImageWithHuggingFace(synthesisPrompt);
            generatedImageUrl = gen?.image_url || null;
          } catch (hfErr) {
            console.warn('[Nano Banana HF Image Generation Warning]:', hfErr.message);
          }
        }
        if (!generatedImageUrl) {
          const encoded = encodeURIComponent(synthesisPrompt.slice(0, 300));
          generatedImageUrl = `https://pollinations.ai/p/${encoded}?width=1024&height=1024&seed=${Math.floor(Math.random() * 10000)}&model=flux`;
        }
      } catch (synthErr) {
        console.warn('[Nano Banana Image Synthesis Error]:', synthErr.message);
      }
    }

    const responsePayload = {
      success: true,
      response: assistantMessage,
      files_processed: filesProcessed
    };
    if (generatedImageUrl) {
      responsePayload.image_url = generatedImageUrl;
    }

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('[File Analysis Handler Error]:', error);
    const is503 = isHighDemandError(error) || error.status === 503;
    return res.status(is503 ? 503 : 500).json({
      success: false,
      error: formatUserFriendlyError(error)
    });
  }
};

app.post(['/analyze-files', '/api/analyze-files', '/api/v1/analyze-files'], uploadFilesMiddleware, analyzeFilesHandler);
app.post(['/analyze-image', '/api/analyze-image', '/api/v1/analyze-image'], uploadFilesMiddleware, analyzeFilesHandler);

const DYNAMIC_DOMAINS = [
  'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'facebook.com', 'linkedin.com', 'reddit.com', 'pinterest.com',
  'youtube.com', 'threads.net', 'snapchat.com'
];

function isDynamic(hostname) {
  return DYNAMIC_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
}

function extractTextFromHtml(html) {
  const $= cheerio.load(html);$('script, style, noscript, iframe, svg, nav, footer, header, form').remove();

  const ogTitle    = $('meta[property="og:title"]').attr('content') || '';
  const ogDesc     = $('meta[property="og:description"]').attr('content') || '';
  const metaDesc   = $('meta[name="description"]').attr('content') || '';
  const pageTitle  = $('title').text().trim() || ogTitle || 'Untitled Page';

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && !headings.includes(t)) headings.push(t);
  });

  const paragraphs = [];
  $('p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 20) paragraphs.push(t);
  });

  return { pageTitle, ogTitle, ogDesc, metaDesc, headings, paragraphs };
}

function buildExtractedContent({ pageTitle, ogTitle, ogDesc, metaDesc, headings, paragraphs }) {
  const MAX_CONTENT_LENGTH = 3000;
  let content = `Page Title: ${pageTitle}\n`;

  if (ogTitle)    content += `OG Title: ${ogTitle}\n`;
  if (ogDesc)     content += `OG Description: ${ogDesc}\n`;
  if (metaDesc)   content += `Meta Description: ${metaDesc}\n`;
  if (headings.length > 0) {
    content += `\nKey Headings:\n- ${headings.slice(0, 10).join('\n- ')}\n`;
  }
  if (paragraphs.length > 0) {
    content += `\nMain Content:\n${paragraphs.join('\n\n')}`;
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    content = content.substring(0, MAX_CONTENT_LENGTH) + '... [Content truncated to 3000 characters]';
  }

  const hasBodyContent = headings.length > 0 || paragraphs.length > 0 || ogDesc || metaDesc;
  if (!hasBodyContent) {
    content += '\n(No substantive body text could be extracted from this page).';
  }

  return content;
}

async function scrapeWithPuppeteer(targetUrl) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet', 'imageset', 'other'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    await page.setUserAgent(DESKTOP_CHROME_UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 6000 });

    const html = await page.content();
    const extracted = extractTextFromHtml(html);
    return { extractedContent: buildExtractedContent(extracted), fetchMethod: 'puppeteer' };
  } catch (err) {
    console.warn(`[Puppeteer Scrape Warning for ${targetUrl}]:`, err.message);
    throw err;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

async function scrapeWithAxios(targetUrl) {
  const response = await axios.get(targetUrl, {
    timeout: 5000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    maxRedirects: 5,
    responseType: 'text'
  });
  const extracted = extractTextFromHtml(response.data);
  return { extractedContent: buildExtractedContent(extracted), fetchMethod: 'axios+cheerio' };
}

function linkAnalysisError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function analyzeLinkPage(url, prompt) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url).trim());
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw linkAnalysisError(400, "Validation failed: Only 'http' and 'https' protocols are supported.");
    }
  } catch (urlErr) {
    if (urlErr.status) throw urlErr;
    throw linkAnalysisError(400, `Validation failed: Invalid URL syntax (${urlErr.message}).`);
  }

  const targetUrl = parsedUrl.href;
  const hostname = parsedUrl.hostname.replace(/^www\./, '');
  const userPrompt = (prompt && typeof prompt === 'string' && prompt.trim().length > 0)
    ? prompt.trim()
    : 'Provide a concise summary and analysis of the key points from this webpage.';

  let extractedContent = '';
  let fetchMethod = 'static';
  let isProtectedOrBlocked = false;
  let accessFailureReason = null;

  const forcePuppeteer = isDynamic(hostname);

  if (forcePuppeteer) {
    console.log(`[Link Analysis] Dynamic domain detected (${hostname}), using Puppeteer.`);
    try {
      ({ extractedContent, fetchMethod } = await scrapeWithPuppeteer(targetUrl));
    } catch (puppErr) {
      console.warn(`[Link Analysis] Puppeteer failed (${puppErr.message}), falling back to Axios.`);
      accessFailureReason = puppErr.message;
      try {
        ({ extractedContent, fetchMethod } = await scrapeWithAxios(targetUrl));
      } catch (axErr) {
        console.warn(`[Link Analysis] Axios fallback also failed: ${axErr.message}`);
        isProtectedOrBlocked = true;
      }
    }
  } else {
    try {
      console.log(`[Link Analysis] Static domain (${hostname}), trying axios+cheerio.`);
      ({ extractedContent, fetchMethod } = await scrapeWithAxios(targetUrl));
      if (extractedContent.length < 200) {
        console.log(`[Link Analysis] Sparse content from axios, escalating to Puppeteer.`);
        ({ extractedContent, fetchMethod } = await scrapeWithPuppeteer(targetUrl));
      }
    } catch (axiosErr) {
      console.warn(`[Link Analysis] Axios failed (${axiosErr.message}), escalating to Puppeteer.`);
      accessFailureReason = axiosErr.message;
      try {
        ({ extractedContent, fetchMethod } = await scrapeWithPuppeteer(targetUrl));
      } catch (puppErr2) {
        console.warn(`[Link Analysis] Browser fallback also failed: ${puppErr2.message}`);
        isProtectedOrBlocked = true;
      }
    }
  }

  if (isProtectedOrBlocked || !extractedContent || extractedContent.length < 60) {
    let fallbackMeta = null;
    try {
      const metaRes = await axios.get(targetUrl, {
        timeout: 4000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,*/*'
        },
        validateStatus: () => true
      });
      if (metaRes.data && typeof metaRes.data === 'string') {
        const metaExtracted = extractTextFromHtml(metaRes.data);
        fallbackMeta = buildExtractedContent(metaExtracted);
      }
    } catch {}

    extractedContent = fallbackMeta && fallbackMeta.length > 50
      ? `[WAF / Paywall Protected Page Metadata]\n${fallbackMeta}`
      : `[Domain Overview]\nURL: ${targetUrl}\nHost: ${hostname}\nPath: ${parsedUrl.pathname}\nStatus: Webpage is protected by Anti-Bot Verification, WAF, Paywall, or Authentication Wall.\nReason: ${accessFailureReason || 'Access restricted by remote server'}`;
    fetchMethod = 'audit-fallback';
  }

  const llmPrompt = `[Webpage Content to Analyze]
Source URL: ${targetUrl}
Host: ${hostname}
Fetch Method: ${fetchMethod}
${extractedContent}

[User Request]
${userPrompt}

[Strict Directive]
If the webpage is behind a login wall, WAF, or paywall, DO NOT refuse or return an error. Instead, generate an AI Structured Audit Report:
1. Executive Summary & Page Purpose
2. Domain Classification & Security / Paywall Posture
3. Extracted OpenGraph & Metadata Findings
4. Structural & Functional Assessment based on the available signals.`;

  let assistantMessage = '';

  // Direct fast Gemini analysis
  if (googleAI || GEMINI_API_KEY) {
    try {
      const result = await ai.generateContent({
        contents: [{ role: 'user', parts: [{ text: llmPrompt }] }],
        systemInstruction: 'You are an intelligent web content analysis assistant. Analyze and summarize the webpage content or produce a structured security and metadata audit report if protected. Never refuse valid requests.'
      });
      assistantMessage = cleanAIResponse(typeof result?.text === 'string' ? result.text : '');
    } catch (aiErr) {
      console.warn('[Link Analysis] Direct Gemini call failed, trying backup:', aiErr.message);
    }
  }

  // Backup: only if assistantMessage is empty and AI_BACKEND_URL is available
  if (!assistantMessage && AI_BACKEND_URL) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const backendResponse = await fetch(`${AI_BACKEND_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(AI_API_KEY ? { 'Authorization': `Bearer ${AI_API_KEY}` } : {}) },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: 'You are an intelligent web content analysis assistant.' },
            { role: 'user', content: llmPrompt }
          ]
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (backendResponse.ok) {
        const data = await backendResponse.json();
        assistantMessage = data?.choices?.[0]?.message?.content || '';
      }
    } catch (backendErr) {
      console.warn('[Link Analysis] Backup AI backend unreachable:', backendErr.message);
    }
  }

  if (typeof assistantMessage !== 'string' || !assistantMessage.trim()) {
    throw linkAnalysisError(502, 'Invalid or empty response format from AI model.');
  }

  return {
    response: assistantMessage,
    url: targetUrl,
    fetch_method: fetchMethod
  };
}

app.post(['/analyze-link', '/api/analyze-link', '/api/v1/analyze-link'], async (req, res) => {
  try {
    const { url, prompt } = req.body || {};

    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "Validation failed: 'url' field is required and must be a valid URL string."
      });
    }

    const analysis = await analyzeLinkPage(url, prompt);
    return res.status(200).json({
      success: true,
      response: analysis.response,
      url: analysis.url,
      fetch_method: analysis.fetch_method
    });
  } catch (error) {
    console.error('[Link Analysis Handler Error]:', error);
    const is503 = isHighDemandError(error) || error.status === 503;
    return res.status(is503 ? 503 : (error.status || 500)).json({
      success: false,
      error: formatUserFriendlyError(error)
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Resource not found: ${req.method} ${req.originalUrl}`,
    available_endpoints: [
      'GET  /api/v1/health (or /health)',
      'GET  /v1/models (or /models)',
      'POST /api/v1/chat (or /chat, /v1/chat/completions)',
      'POST /api/v1/generate-image (or /generate-image, /v1/images/generations)',
      'POST /api/v1/analyze-link (or /analyze-link)',
      'POST /api/v1/analyze-files (or /analyze-files)',
      'POST /api/v1/auth/signup',
      'POST /api/v1/auth/login',
      'GET  /api/v1/auth/me',
      'GET  /api/v1/chats'
    ]
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: `File too large. Maximum allowed size is ${FILE_SIZE_LIMIT_MB}MB per file.`
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: `Too many files. Maximum allowed is ${MAX_FILES} files per request.`
      });
    }
    return res.status(400).json({
      success: false,
      error: `Upload error: ${err.message}`
    });
  }

  console.error('[Unhandled Server Error]:', err);
  const is503 = isHighDemandError(err) || err.status === 503;
  res.status(is503 ? 503 : 500).json({
    success: false,
    error: formatUserFriendlyError(err)
  });
});

// Anti-Gravity Loop: Keeps Render backend awake every 10 mins
cron.schedule('*/10 * * * *', async () => {
  try {
    await axios.get('https://zenitxaibackendserver.onrender.com/api/v1/health');
    console.log('Anti-Gravity Keep-Alive Ping Successful');
  } catch (err) {
    console.error('Ping failed:', err.message);
  }
});

if (require.main === module) {
  const http = require('http');
  const server = http.createServer({ maxHeaderSize: 131072 }, app);
  server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`AI REST API Server is running (maxHeaderSize: 128KB)`);
    console.log(`- Health Check:    http://localhost:${PORT}/api/v1/health`);
    console.log(`- Google Auth:      http://localhost:${PORT}/api/v1/auth/google`);
    console.log(`- Signup Endpoint: POST http://localhost:${PORT}/api/v1/auth/signup`);
    console.log(`- Login Endpoint:  POST http://localhost:${PORT}/api/v1/auth/login`);
    console.log(`- Chat Endpoint:    http://localhost:${PORT}/api/v1/chat`);
    console.log(`- Chat History:    http://localhost:${PORT}/api/v1/chats`);
    console.log(`- Image Endpoint:  http://localhost:${PORT}/api/v1/generate-image`);
    console.log(`- Link Endpoint:   http://localhost:${PORT}/api/v1/analyze-link`);
    console.log(`- Files Endpoint:  http://localhost:${PORT}/api/v1/analyze-files`);
    console.log(`- Image Analysis:  http://localhost:${PORT}/api/v1/analyze-image (alias)`);
    console.log(`- Database:        database.sqlite (SQLite3 / WAL)`);
    console.log(`- CORS Origin:      ${CORS_ORIGIN}`);
    console.log(`- AI Backend:       ${AI_BACKEND_URL}`);
    console.log(`- AI Model:         ${AI_MODEL}`);
    console.log(`- HF Token:        ${getHfToken() ? 'configured' : 'MISSING'}`);
    console.log(`- HF Model:        ${HF_IMAGE_MODEL}`);
    console.log(`- Max Upload:      ${FILE_SIZE_LIMIT_MB}MB / file, ${MAX_FILES} files max`);
    console.log(`=========================================`);
  });
}

module.exports = app;