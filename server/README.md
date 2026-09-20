# AI REST API Server (Node.js & Express)

A complete, lightweight, production-ready REST API server that bridges frontend web applications (React, Next.js, Vue, vanilla JS) with AI services:
1. **AI Chat Completions** (via local `gemini-web2api` service on port 8081 or OpenAI-compatible backend).
2. **AI Image Generation** (via Pollinations.ai, Hugging Face Inference API, or Stability AI).

---

## Features
- **Text & Chat API**: OpenAI-compatible endpoint with automatic Gemini routing.
- **Image Generation API**: Text-to-image with zero-configuration (Pollinations.ai) or custom Hugging Face tokens.
- **Full CORS Support**: Enabled via the `cors` package to allow requests from any frontend origin (`localhost:3000`, Netlify, Vercel, etc.).
- **Environment Configurations**: Easy `.env` configuration for Port, CORS, AI Backend URLs, Image Providers, and Models.
- **Robust Error Handling**: Input validation with clear 400 errors, upstream error propagation with 502/504 status codes, and 500 server crash guards.

---

## File Structure

```text
server/
├── .env                  # Active environment configuration
├── .env.example          # Template for environment variables
├── .gitignore            # Excludes node_modules, .env, and logs
├── package.json          # Project manifest & scripts
├── README.md             # Documentation and usage guide
└── server.js             # Express REST API application
```

---

## API Endpoints

### 1. Health Check
- **URL**: `GET /api/v1/health`
- **Description**: Verify the server is live.
- **Response**:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-09-16T09:29:54.956Z",
    "uptime": "42s"
  }
  ```

### 2. Chat Completion
- **URL**: `POST /api/v1/chat`
- **Headers**: `Content-Type: application/json`, optional `Authorization: Bearer <token>`
- **Request Body Options**:
  - **Single prompt**:
    ```json
    {
      "prompt": "Explain quantum computing in simple terms."
    }
    ```
  - **Full conversation history (Context Memory)**:
    ```json
    {
      "messages": [
        { "role": "user", "content": "My name is Alex." },
        { "role": "assistant", "content": "Hello Alex!" },
        { "role": "user", "content": "What is my name?" }
      ]
    }
    ```
  - **Both context + prompt**:
    ```json
    {
      "prompt": "What is my name?",
      "messages": [
        { "role": "user", "content": "My name is Alex." },
        { "role": "assistant", "content": "Hello Alex!" }
      ],
      "chat_id": 1
    }
    ```
  - **Non-streaming JSON response (optional)**:
    ```json
    {
      "prompt": "Explain quantum computing in simple terms.",
      "stream": false
    }
    ```
  *(If `prompt` is missing, the server extracts the content of the last user message from `messages` automatically.)*
- **Streaming Success Response (200 OK, default — Server-Sent Events)**:
  - **Content-Type**: `text/event-stream; charset=utf-8`
  - **Format**:
    ```text
    data: {"chunk":"Quantum","text":"Quantum","response":"Quantum"}

    data: {"chunk":" computing","text":" computing","response":" computing"}

    data: {"done":true,"success":true,"response":"Quantum computing...","chat_id":1}

    data: [DONE]
    ```
- **Non-Streaming Success Response (200 OK, when `"stream": false`)**:
  ```json
  {
    "success": true,
    "response": "Quantum computing is a type of computation that harnesses the collective properties of quantum states...",
    "chat_id": 1
  }
  ```
- **Error Response (400 Bad Request)**:
  ```json
  {
    "success": false,
    "error": "Validation failed: 'prompt' field is required and must be a non-empty string."
  }
  ```

### 3. Image Generation (Hugging Face FLUX.1-schnell)
- **URL**: `POST /api/v1/generate-image`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "prompt": "A glowing cyberpunk crystal in a dark forest, 8k resolution"
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "image_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
  }
  ```
- **Error Response (400 Bad Request)**:
  ```json
  {
    "success": false,
    "error": "Validation failed: 'prompt' field is required and must be a non-empty string."
  }
  ```
- **Error Response (503 Service Unavailable)**:
  ```json
  {
    "success": false,
    "error": "The AI image model is currently loading on Hugging Face. Please retry your request in a few moments."
  }
  ```

### 4. Link Analysis (Web Scrape & AI Summary)
- **URL**: `POST /api/v1/analyze-link`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "url": "https://example.com",
    "prompt": "Summarize the key takeaways from this website."
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "response": "Here is a summary of the website:\n- It is designated for documentation examples...",
    "url": "https://example.com/"
  }
  ```
- **Error Response (400 Bad Request)**:
  ```json
  {
    "success": false,
    "error": "Validation failed: 'url' field is required and must be a valid URL string."
  }
  ```
- **Error Response (502 Bad Gateway / 504 Timeout)**:
  ```json
  {
    "success": false,
    "error": "Target website timed out after 15 seconds: https://example.com"
  }
  ```

### 5. Multi-File & Multi-Image Analysis
- **URL**: `POST /api/v1/analyze-files` (Alias: `POST /api/v1/analyze-image`)
- **Headers**: `Content-Type: multipart/form-data`
- **Form Fields**:
  - `files`: One or more files (up to 10 files per request).
  - `prompt`: (Optional) Text instructions for analyzing the uploaded files.
- **Supported File Types**:
  - **Images**: PNG, JPG/JPEG, WebP (converted to Base64 image parts)
  - **Code & Text**: `.txt`, `.js`, `.ts`, `.html`, `.json`, `.md`, `.py`, `.css`, etc. (UTF-8 text appended to prompt)
  - **Documents**: PDF (text extracted via `pdf-parse` and appended to prompt)
- **Model**: Routed to `gemini-3.6-flash`
- **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "response": "Here is an analysis of your uploaded files...",
    "files_processed": 2
  }
  ```
- **Error Response (400 Bad Request / Unsupported Format)**:
  ```json
  {
    "success": false,
    "error": "Unsupported file format: 'archive.zip'. Supported formats are images (png, jpg, webp), text/code files (txt, js, html, json, md, py), and PDFs."
  }
  ```
- **Error Response (413 File Too Large)**:
  ```json
  {
    "success": false,
    "error": "File too large. Maximum allowed size is 20MB per file."
  }
  ```

---

## Quick Start & Terminal Commands

### 1. Install Dependencies
```bash
cd server
npm install
```

### 2. Configure Environment
In `server/.env`:
```env
PORT=3000
CORS_ORIGIN=*
AI_BACKEND_URL=http://localhost:8081/v1
AI_API_KEY=sk-gemini
AI_MODEL=gemini-3.6-flash
REQUEST_TIMEOUT_MS=60000

# Hugging Face Configuration (FLUX.1-schnell)
HF_TOKEN=your_hf_token_here
HF_IMAGE_MODEL=black-forest-labs/FLUX.1-schnell
```

### 3. Run Development Server (Auto-reloading with nodemon)
```bash
npm run dev
```

### 4. Run Production Server
```bash
npm start
```

---

## Frontend Integration Examples

### A. Image Generation & Displaying `<img>`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>AI Image Generator</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    input { width: 75%; padding: 10px; font-size: 16px; }
    button { padding: 10px 18px; font-size: 16px; cursor: pointer; }
    #imageContainer { margin-top: 20px; min-height: 200px; }
    img { max-width: 100%; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: block; }
    .loading { color: #888; font-style: italic; }
    .error { color: #d32f2f; font-weight: bold; }
  </style>
</head>
<body>
  <h2>AI Image Generator</h2>
  <div>
    <input id="promptInput" type="text" placeholder="e.g. A cute red panda wearing astronaut suit" />
    <button id="generateBtn" onclick="handleGenerate()">Generate</button>
  </div>
  <div id="imageContainer"></div>

  <script>
    async function generateImage(prompt) {
      const response = await fetch('http://localhost:3000/api/v1/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Server returned HTTP ${response.status}`);
      }

      return data.image_url;
    }

    async function handleGenerate() {
      const input = document.getElementById('promptInput');
      const container = document.getElementById('imageContainer');
      const btn = document.getElementById('generateBtn');
      const prompt = input.value.trim();

      if (!prompt) {
        alert('Please enter a prompt!');
        return;
      }

      btn.disabled = true;
      container.innerHTML = '<p class="loading">Generating image, please wait...</p>';

      try {
        const imageUrl = await generateImage(prompt);

        // Create and display the <img> tag
        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = prompt;
        img.loading = 'lazy';

        container.innerHTML = '';
        container.appendChild(img);
      } catch (err) {
        container.innerHTML = `<p class="error">Generation failed: ${err.message}</p>`;
      } finally {
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>
```

### B. Chat Completion Integration

```javascript
async function askAI(prompt, chatId = null, jwtToken = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (jwtToken) headers['Authorization'] = `Bearer ${jwtToken}`;

  const body = { prompt };
  if (chatId) body.chat_id = chatId;

  const response = await fetch('http://localhost:3000/api/v1/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Chat request failed');
  }

  // Returns { response: "string", chat_id?: number }
  return data;
}
```

---

### 6. Google OAuth Authentication
- **URL**: `POST /api/v1/auth/google`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "credential": "<google_jwt_identity_token>"
  }
  ```
- **Description**: Verifies the Google ID token with Google's public keys via `google-auth-library` (`OAuth2Client`), upserts the user profile into SQLite `users` table, and returns a signed session JWT valid for 7 days.
- **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "name": "Jane Doe",
      "email": "jane@example.com",
      "avatar_url": "https://lh3.googleusercontent.com/..."
    }
  }
  ```

---

### 7. Chat History Endpoints (JWT Protected)

All routes require `Authorization: Bearer <token>`.

#### A. List User's Chats
- **URL**: `GET /api/v1/chats`
- **Response (200 OK)**:
  ```json
  {
    "success": true,
    "chats": [
      {
        "id": 1,
        "title": "Project Architecture Discussion",
        "updated_at": "2026-09-17T00:28:18.324Z"
      }
    ]
  }
  ```

#### B. Get Full Chat Thread
- **URL**: `GET /api/v1/chats/:id`
- **Response (200 OK)**:
  ```json
  {
    "success": true,
    "chat": {
      "id": 1,
      "title": "Project Architecture Discussion",
      "messages": [
        { "role": "user", "content": "What is the structure?" },
        { "role": "assistant", "content": "ZenitX consists of..." }
      ],
      "updated_at": "2026-09-17T00:28:18.324Z"
    }
  }
  ```

#### C. Save / Update Chat Thread Manually
- **URL**: `POST /api/v1/chats/save`
- **Body**:
  ```json
  {
    "chat_id": 1,
    "title": "Updated Title",
    "messages": [ ... ]
  }
  ```
- **Response (200 OK)**:
  ```json
  {
    "success": true,
    "chat_id": 1
  }
  ```

#### D. Delete Chat Thread
- **URL**: `DELETE /api/v1/chats/:id`
- **Response (200 OK)**:
  ```json
  {
    "success": true
  }
  ```

#### E. Auto-Save in `/api/v1/chat`
When sending requests to `POST /api/v1/chat`, include `Authorization: Bearer <token>` in the header and optionally `"chat_id": <number>` in the body. The assistant response and user prompt are automatically appended to the user's SQLite chat thread and the response returns:
```json
{
  "success": true,
  "response": "AI reply...",
  "chat_id": 1
}
```
If no `chat_id` is supplied, a brand new chat thread is created automatically.
If no `Authorization` header is provided, chat remains completely stateless and unauthenticated (backward compatible).

