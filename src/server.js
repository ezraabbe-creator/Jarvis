import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

const DATA_DIR = join(__dirname, '../data');
const MEMORY_FILE = join(DATA_DIR, 'memory.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const TOKEN_FILE = join(DATA_DIR, 'google_token.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function loadMemory() { try { if (existsSync(MEMORY_FILE)) return JSON.parse(readFileSync(MEMORY_FILE, 'utf8')); } catch {} return {}; }
function saveMemory(mem) { writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); }
function loadHistory() { try { if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, 'utf8')).slice(-40); } catch {} return []; }
function saveHistory(messages) {
  const clean = messages
    .filter(m => typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some(b => b.type === 'text')))
    .map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('') : m.content }))
    .slice(-60);
  writeFileSync(HISTORY_FILE, JSON.stringify(clean, null, 2));
}
let persistentMemory = loadMemory();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback'
);
if (existsSync(TOKEN_FILE)) {
  try { oauth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))); console.log('Google token loaded'); } catch {}
}
oauth2Client.on('tokens', (tokens) => {
  const cur = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : {};
  writeFileSync(TOKEN_FILE, JSON.stringify({ ...cur, ...tokens }, null, 2));
});
function isGoogleAuthed() { const c = oauth2Client.credentials; return !!(c && (c.access_token || c.refresh_token)); }

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    res.send('<html><body style="background:#030b12;color:#00d4ff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center"><h1>GOOGLE CONNECTED</h1><p style="color:#c0e8f8">Close this tab and return to Jarvis.</p></div></body></html>');
  } catch (err) { res.status(500).send('Auth failed: ' + err.message); }
});

function extractId(u) {
  if (!u) return u;
  return u.match(/\/document\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
    u.match(/\/presentation\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
    u.match(/\/file\/d\/([a-zA-Z0-9-_]+)/)?.[1] || u;
}

const TOOLS = [
  { name: 'web_search', description: 'Search the web.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_weather', description: 'Get weather for a location.', input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
  { name: 'get_news', description: 'Get latest news on a topic.', input_schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
  { name: 'calculate', description: 'Do math.', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'remember', description: 'Save to permanent memory.', input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
  { name: 'recall', description: 'Get a memory by key.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'list_memories', description: 'List all memories.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'forget', description: 'Delete a memory.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'check_google_auth', description: 'Check if Google is connected.', input_schema: { type: 'object', properties: {}, required: [] } },
  {
    name: 'get_canvas_assignments',
    description: 'Get assignments from Canvas. course_id can be "all". filter can be "missing" for unsubmitted, "future" for upcoming, or omit for all.',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', description: 'Course ID or "all"' },
        filter: { type: 'string', description: 'Optional: "missing" or "future"' }
      },
      required: ['course_id']
    }
  },
  {
    name: 'get_classroom_assignments',
    description: 'Get assignments from Google Classroom. course_id can be "all".',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', description: 'Course ID or "all"' }
      },
      required: ['course_id']
    }
  },
  { name: 'list_drive_files', description: 'Search Google Drive files.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_google_doc', description: 'Read a Google Doc by ID or URL.', input_schema: { type: 'object', properties: { doc_id: { type: 'string' } }, required: ['doc_id'] } },
  {
    name: 'write_google_doc',
    description: 'Write to a Google Doc. doc_id can be "new" to create. mode is "replace" or "append".',
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string' }
      },
      required: ['doc_id', 'content', 'mode']
    }
  },
  { name: 'read_google_slides', description: 'Read a Google Slides presentation.', input_schema: { type: 'object', properties: { presentation_id: { type: 'string' } }, required: ['presentation_id'] } },
  {
    name: 'create_google_slides',
    description: 'Create a Google Slides presentation.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } } } }
      },
      required: ['title', 'slides']
    }
  }
];

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'web_search': {
        if (!process.env.BRAVE_API_KEY) {
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_redirect=1`);
          const data = await res.json();
          return data.AbstractText || data.Answer || `No results for "${input.query}".`;
        }
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=5`, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY } });
        const data = await res.json();
        return (data.web?.results || []).slice(0, 5).map(r => `• ${r.title}\n  ${r.description}`).join('\n\n');
      }
      case 'get_weather': {
        if (!process.env.WEATHER_API_KEY) return 'Weather API key not set.';
        const res = await fetch(`https://api.weatherapi.com/v1/forecast.json?key=${process.env.WEATHER_API_KEY}&q=${encodeURIComponent(input.location)}&days=3&aqi=no`);
        const d = await res.json();
        if (d.error) return `Weather error: ${d.error.message}`;
        return `${d.location.name}: ${d.current.temp_f}°F, ${d.current.condition.text}. 3-day: ${d.forecast.forecastday.map(x => `${x.date}: ${x.day.maxtemp_f}/${x.day.mintemp_f}°F`).join(' | ')}`;
      }
      case 'get_news': {
        const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(`https://news.google.com/rss/search?q=${encodeURIComponent(input.topic)}&hl=en-US&gl=US&ceid=US:en`)}`);
        const data = await res.json();
        return data.items?.length ? data.items.slice(0, 6).map(i => `• ${i.title}`).join('\n') : `No news for "${input.topic}".`;
      }
      case 'calculate': {
        const result = Function(`"use strict"; return (${input.expression.replace(/[^0-9+\-*/().,% ]/g, '')})`)();
        return `${input.expression} = ${result}`;
      }
      case 'remember': { persistentMemory[input.key] = { value: input.value, saved: new Date().toISOString() }; saveMemory(persistentMemory); return `Saved: "${input.key}" = "${input.value}"`; }
      case 'recall': { const item = persistentMemory[input.key]; return item ? `"${input.key}": ${item.value}` : `No memory for "${input.key}".`; }
      case 'list_memories': { const keys = Object.keys(persistentMemory); return keys.length ? 'Memories:\n' + keys.map(k => `• ${k}: ${persistentMemory[k].value}`).join('\n') : 'No memories.'; }
      case 'forget': { if (persistentMemory[input.key]) { delete persistentMemory[input.key]; saveMemory(persistentMemory); return `Forgot "${input.key}"`; } return `No memory for "${input.key}"`; }
      case 'check_google_auth': {
        if (isGoogleAuthed()) return 'Google account is connected.';
        const host = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000';
        return `Google not connected. Authorize here: ${host}/auth/google`;
      }
      case 'get_canvas_assignments': {
        if (!process.env.CANVAS_API_TOKEN || !process.env.CANVAS_DOMAIN) return 'Canvas not configured. Add CANVAS_API_TOKEN and CANVAS_DOMAIN to .env';
        const h = { 'Authorization': `Bearer ${process.env.CANVAS_API_TOKEN}` };
        const domain = process.env.CANVAS_DOMAIN;
        const bucket = input.filter === 'missing' ? '&bucket=missing' : input.filter === 'future' ? '&bucket=future' : '';
        if (input.course_id === 'all') {
          const courses = await (await fetch(`https://${domain}/api/v1/courses?enrollment_state=active&per_page=20`, { headers: h })).json();
          if (!Array.isArray(courses)) return `Canvas error: ${JSON.stringify(courses)}`;
          const all = [];
          for (const c of courses.slice(0, 8)) {
            const assignments = await (await fetch(`https://${domain}/api/v1/courses/${c.id}/assignments?order_by=due_at&per_page=10${bucket}`, { headers: h })).json();
            if (Array.isArray(assignments) && assignments.length) {
              all.push(`📚 ${c.name}:`);
              assignments.slice(0, 6).forEach(a => all.push(`  • ${a.name} — Due: ${a.due_at ? new Date(a.due_at).toLocaleDateString() : 'N/A'} (${a.points_possible} pts)\n    ${(a.description || '').replace(/<[^>]+>/g, '').slice(0, 150)}`));
            }
          }
          return all.length ? all.join('\n') : 'No assignments found.';
        }
        const assignments = await (await fetch(`https://${domain}/api/v1/courses/${input.course_id}/assignments?order_by=due_at&per_page=20${bucket}`, { headers: h })).json();
        return Array.isArray(assignments) ? assignments.slice(0, 10).map(a => `• ${a.name} — Due: ${a.due_at ? new Date(a.due_at).toLocaleDateString() : 'N/A'}\n  ${(a.description || '').replace(/<[^>]+>/g, '').slice(0, 150)}`).join('\n\n') : `Error: ${JSON.stringify(assignments)}`;
      }
      case 'get_classroom_assignments': {
        if (!isGoogleAuthed()) return 'Google not connected.';
        const classroom = google.classroom({ version: 'v1', auth: oauth2Client });
        if (input.course_id === 'all') {
          const courses = (await classroom.courses.list({ courseStates: ['ACTIVE'] })).data.courses || [];
          const all = [];
          for (const c of courses.slice(0, 5)) {
            const work = (await classroom.courses.courseWork.list({ courseId: c.id })).data.courseWork || [];
            if (work.length) {
              all.push(`📗 ${c.name}:`);
              work.slice(0, 5).forEach(w => all.push(`  • ${w.title} — Due: ${w.dueDate ? `${w.dueDate.month}/${w.dueDate.day}/${w.dueDate.year}` : 'N/A'}\n    ${(w.description || '').slice(0, 150)}`));
            }
          }
          return all.length ? all.join('\n') : 'No Classroom assignments found.';
        }
        const work = (await classroom.courses.courseWork.list({ courseId: input.course_id })).data.courseWork || [];
        return work.slice(0, 10).map(w => `• ${w.title} — Due: ${w.dueDate ? `${w.dueDate.month}/${w.dueDate.day}` : 'N/A'}\n  ${(w.description || '').slice(0, 150)}`).join('\n\n');
      }
      case 'list_drive_files': {
        if (!isGoogleAuthed()) return 'Google not connected.';
        const drive = google.drive({ version: 'v3', auth: oauth2Client });
        const res = await drive.files.list({ q: `name contains '${input.query}' and trashed=false`, fields: 'files(id,name,mimeType,webViewLink)', pageSize: 10 });
        const files = res.data.files || [];
        return files.length ? files.map(f => `• ${f.name}\n  ID: ${f.id}\n  Link: ${f.webViewLink}`).join('\n\n') : `No files found for "${input.query}"`;
      }
      case 'read_google_doc': {
        if (!isGoogleAuthed()) return 'Google not connected.';
        const docs = google.docs({ version: 'v1', auth: oauth2Client });
        const id = extractId(input.doc_id);
        const res = await docs.documents.get({ documentId: id });
        const text = res.data.body.content.map(el => el.paragraph?.elements.map(e => e.textRun?.content || '').join('') || '').join('').slice(0, 3000);
        return `"${res.data.title}":\n\n${text}`;
      }
      case 'write_google_doc': {
        if (!isGoogleAuthed()) return 'Google not connected.';
        const docs = google.docs({ version: 'v1', auth: oauth2Client });
        if (input.doc_id === 'new') {
          const created = await docs.documents.create({ requestBody: { title: input.title || 'Jarvis Document' } });
          const docId = created.data.documentId;
          await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: input.content } }] } });
          return `Created: "${input.title}"\nLink: https://docs.google.com/document/d/${docId}/edit`;
        }
        const id = extractId(input.doc_id);
        if (input.mode === 'replace') {
          const doc = await docs.documents.get({ documentId: id });
          const endIndex = doc.data.body.content.reduce((max, el) => Math.max(max, el.endIndex || 0), 1);
          const requests = [];
          if (endIndex > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
          requests.push({ insertText: { location: { index: 1 }, text: input.content } });
          await docs.documents.batchUpdate({ documentId: id, requestBody: { requests } });
        } else {
          const doc = await docs.documents.get({ documentId: id });
          const endIndex = doc.data.body.content.reduce((max, el) => Math.max(max, el.endIndex || 0), 1);
          await docs.documents.batchUpdate({ documentId: id, requestBody: { requests: [{ insertText: { location: { index: endIndex - 1 }, text: '\n' + input.content } }] } });
        }
        return `Updated doc successfully. Link: https://docs.google.com/document/d/${extractId(input.doc_id)}/edit`;
      }
      case 'read_google_slides': {
        if (!isGoogleAuthed()) return 'Google not connected.';
        const slides = google.slides({ version: 'v1', auth: oauth2Client });
        const id = extractId(input.presentation_id);
        const res = await slides.presentations.get({ presentationId: id });
        const summary = res.data.slides.map((s, i) => `Slide ${i + 1}: ${(s.pageElements || []).flatMap(el => el.shape?.text?.textElements?.map(te => te.textRun?.content?.trim()).filter(Boolean) || []).join(' | ')}`).join('\n');
        return `"${res.data.title}" (${res.data.slides.length} slides)\n\n${summary}`;
      }
      case 'create_google_slides': {
        if (!isGoogleAuthed()) return 'Google not connected.';
        const slidesApi = google.slides({ version: 'v1', auth: oauth2Client });

        // Create blank presentation
        const created = await slidesApi.presentations.create({ requestBody: { title: input.title } });
        const presId = created.data.presentationId;

        // Get the initial slide
        const pres = await slidesApi.presentations.get({ presentationId: presId });
        const firstSlide = pres.data.slides[0];
        const firstSlideId = firstSlide.objectId;

        // Delete existing placeholder elements from first slide
        const deleteRequests = (firstSlide.pageElements || []).map(el => ({
          deleteObject: { objectId: el.objectId }
        }));
        if (deleteRequests.length > 0) {
          await slidesApi.presentations.batchUpdate({ presentationId: presId, requestBody: { requests: deleteRequests } });
        }

        // Process each slide one at a time
        for (let i = 0; i < input.slides.length; i++) {
          const slideData = input.slides[i];
          let slideId;

          if (i === 0) {
            slideId = firstSlideId;
          } else {
            await slidesApi.presentations.batchUpdate({
              presentationId: presId,
              requestBody: { requests: [{ duplicateObject: { objectId: firstSlideId } }] }
            });
            const updated = await slidesApi.presentations.get({ presentationId: presId });
            slideId = updated.data.slides[i].objectId;
          }

          const titleId = `tb_title_${i}_${Date.now()}`;
          const bodyId = `tb_body_${i}_${Date.now()}`;

          await slidesApi.presentations.batchUpdate({
            presentationId: presId,
            requestBody: {
              requests: [
                {
                  createShape: {
                    objectId: titleId,
                    shapeType: 'TEXT_BOX',
                    elementProperties: {
                      pageObjectId: slideId,
                      size: { height: { magnitude: 900000, unit: 'EMU' }, width: { magnitude: 8200000, unit: 'EMU' } },
                      transform: { scaleX: 1, scaleY: 1, translateX: 350000, translateY: 250000, unit: 'EMU' }
                    }
                  }
                },
                {
                  createShape: {
                    objectId: bodyId,
                    shapeType: 'TEXT_BOX',
                    elementProperties: {
                      pageObjectId: slideId,
                      size: { height: { magnitude: 4000000, unit: 'EMU' }, width: { magnitude: 8200000, unit: 'EMU' } },
                      transform: { scaleX: 1, scaleY: 1, translateX: 350000, translateY: 1300000, unit: 'EMU' }
                    }
                  }
                }
              ]
            }
          });

          await slidesApi.presentations.batchUpdate({
            presentationId: presId,
            requestBody: {
              requests: [
                { insertText: { objectId: titleId, insertionIndex: 0, text: slideData.title || '' } },
                { insertText: { objectId: bodyId, insertionIndex: 0, text: slideData.content || '' } },
                { updateTextStyle: { objectId: titleId, style: { bold: true, fontSize: { magnitude: 24, unit: 'PT' } }, textRange: { type: 'ALL' }, fields: 'bold,fontSize' } },
                { updateTextStyle: { objectId: bodyId, style: { fontSize: { magnitude: 14, unit: 'PT' } }, textRange: { type: 'ALL' }, fields: 'fontSize' } }
              ]
            }
          });
        }

        return `Created and filled: "${input.title}" (${input.slides.length} slides)\nLink: https://docs.google.com/presentation/d/${presId}/edit`;
      }
      default: return `Unknown tool: ${name}`;
    }
  } catch (err) { console.error(`Tool error (${name}):`, err.message); return `Tool error (${name}): ${err.message}`; }
}

function buildSystem() {
  const memKeys = Object.keys(persistentMemory);
  const memBlock = memKeys.length ? '\n\nMemories:\n' + memKeys.map(k => `- ${k}: ${persistentMemory[k].value}`).join('\n') : '';
  return `You are J.A.R.V.I.S., a personal AI with permanent memory and access to Google and school platforms.

Personality: Calm, confident, sharp British wit. Call user "sir" or "ma'am". Proactive. Never give up halfway. Actually DO the work.

Integrations: Google ${isGoogleAuthed() ? 'Connected' : 'Not connected'} | Canvas ${process.env.CANVAS_API_TOKEN ? 'Configured' : 'Not configured'}

Assignment workflow: 1) check_google_auth 2) get assignments 3) read instructions 4) search web if needed 5) find/create Doc or Slides 6) write full content 7) save and report link

Rules: Chain tools freely. Save important info to memory. Greet returning users naturally.

Today: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}${memBlock}`;
}

async function runAgentLoop(conversationHistory, onUpdate) {
  const messages = [...conversationHistory];
  let iterations = 0;
  while (iterations < 15) {
    iterations++;
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4096, system: buildSystem(), tools: TOOLS, messages });
    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');
    if (textBlocks.length && toolBlocks.length) onUpdate({ type: 'thinking', text: textBlocks.map(b => b.text).join('') });
    if (response.stop_reason === 'end_turn' || !toolBlocks.length) {
      return { reply: textBlocks.map(b => b.text).join(''), messages: [...messages, { role: 'assistant', content: response.content }] };
    }
    onUpdate({ type: 'tools', tools: toolBlocks.map(t => ({ name: t.name, input: t.input })) });
    const toolResults = await Promise.all(toolBlocks.map(async tool => {
      const result = await executeTool(tool.name, tool.input);
      onUpdate({ type: 'tool_result', tool: tool.name, result });
      return { type: 'tool_result', tool_use_id: tool.id, content: result };
    }));
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }
  return { reply: "Reached iteration limit, sir. Want me to continue?", messages };
}

wss.on('connection', (ws) => {
  const sessionHistory = loadHistory();
  console.log(`Client connected — ${sessionHistory.length} messages, ${Object.keys(persistentMemory).length} memories`);
  ws.on('message', async (raw) => {
    let data; try { data = JSON.parse(raw); } catch { return; }
    if (data.type === 'message') {
      sessionHistory.push({ role: 'user', content: data.text });
      try {
        const { reply, messages } = await runAgentLoop(sessionHistory, u => { if (ws.readyState === 1) ws.send(JSON.stringify(u)); });
        sessionHistory.length = 0; sessionHistory.push(...messages);
        saveHistory(messages);
        ws.send(JSON.stringify({ type: 'reply', text: reply }));
      } catch (err) { ws.send(JSON.stringify({ type: 'reply', text: `Systems error: ${err.message}` })); }
    }
  });
  ws.on('close', () => console.log('Client disconnected'));
});

app.get('/health', (_, res) => res.json({ status: 'online', google: isGoogleAuthed() }));
app.get('/memories', (_, res) => res.json(persistentMemory));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🤖 J.A.R.V.I.S. online at http://localhost:${PORT}`);
  console.log(`📦 ${Object.keys(persistentMemory).length} memories | 💬 ${loadHistory().length} history messages`);
  console.log(`🔑 Google: ${isGoogleAuthed() ? 'Connected' : 'Not connected — visit /auth/google'}`);
  console.log(`📚 Canvas: ${process.env.CANVAS_API_TOKEN ? 'Configured' : 'Not configured'}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — REAL TIME LOCATION TRACKING
// ═══════════════════════════════════════════════════════════════════════════

const LOCATION_FILE = join(DATA_DIR, 'location.json');
const SENT_ALERTS_FILE = join(DATA_DIR, 'sentAlerts.json');

function loadLocation() {
  try { if (existsSync(LOCATION_FILE)) return JSON.parse(readFileSync(LOCATION_FILE, 'utf8')); } catch {}
  return null;
}

function saveLocation(data) {
  writeFileSync(LOCATION_FILE, JSON.stringify(data, null, 2));
}

function loadSentAlerts() {
  try { if (existsSync(SENT_ALERTS_FILE)) return JSON.parse(readFileSync(SENT_ALERTS_FILE, 'utf8')); } catch {}
  return {};
}

function saveSentAlerts(data) {
  writeFileSync(SENT_ALERTS_FILE, JSON.stringify(data, null, 2));
}

// POST /location — receives lat/lng from iPhone Shortcut
app.post('/location', async (req, res) => {
  const { latitude, longitude } = req.body;
  if (!latitude || !longitude) return res.status(400).json({ error: 'Missing lat/lng' });

  try {
    // Reverse geocode using Nominatim (free, no key needed)
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
      { headers: { 'User-Agent': 'JarvisAI/1.0' } }
    );
    const geoData = await geoRes.json();
    const city = geoData.address?.city || geoData.address?.town || geoData.address?.village || geoData.address?.county || 'Unknown';
    const state = geoData.address?.state || '';
    const locationName = state ? `${city}, ${state}` : city;

    const locationData = {
      latitude,
      longitude,
      city: locationName,
      fullAddress: geoData.display_name || locationName,
      updatedAt: new Date().toISOString()
    };

    saveLocation(locationData);

    // Also save to persistent memory so Jarvis can reference it
    persistentMemory['current_location'] = { value: locationName, saved: new Date().toISOString() };
    persistentMemory['current_coordinates'] = { value: `${latitude},${longitude}`, saved: new Date().toISOString() };
    saveMemory(persistentMemory);

    console.log(`📍 Location updated: ${locationName} (${latitude}, ${longitude})`);
    res.json({ success: true, location: locationName });
  } catch (err) {
    console.error('Location error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /location — check current location
app.get('/location', (_, res) => {
  const loc = loadLocation();
  res.json(loc || { error: 'No location data yet' });
});

// ═══════════════════════════════════════════════════════════════════════════
// TWILIO CLIENT
// ═══════════════════════════════════════════════════════════════════════════

let twilioClient2 = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const { default: twilio } = await import('twilio');
    twilioClient2 = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('📱 Twilio client initialized');
  } catch (err) {
    console.log('⚠️ Twilio not available:', err.message);
  }
}

async function sendSMS2(to, message) {
  if (!twilioClient2) { console.log('Twilio not configured — SMS skipped:', message.slice(0, 50)); return false; }
  try {
    await twilioClient2.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to || process.env.MY_PHONE_NUMBER
    });
    console.log('📱 SMS sent:', message.slice(0, 60));
    return true;
  } catch (err) {
    console.error('SMS error:', err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — PROACTIVE ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

async function getWeatherForAlert() {
  const loc = loadLocation();
  const query = loc ? `${loc.latitude},${loc.longitude}` : 'Camarillo,CA';
  if (!process.env.WEATHER_API_KEY) return null;
  try {
    const res = await fetch(`https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${query}`);
    const d = await res.json();
    return `${Math.round(d.current.temp_f)}°F, ${d.current.condition.text}`;
  } catch { return null; }
}

async function getCanvasAlertsForBriefing() {
  if (!process.env.CANVAS_API_TOKEN || !process.env.CANVAS_DOMAIN) return [];
  const h = { 'Authorization': `Bearer ${process.env.CANVAS_API_TOKEN}` };
  const domain = process.env.CANVAS_DOMAIN;
  const alerts = [];
  try {
    const courses = await (await fetch(`https://${domain}/api/v1/courses?enrollment_state=active&per_page=10`, { headers: h })).json();
    if (!Array.isArray(courses)) return [];
    for (const c of courses.slice(0, 5)) {
      const assignments = await (await fetch(`https://${domain}/api/v1/courses/${c.id}/assignments?order_by=due_at&per_page=10&bucket=upcoming`, { headers: h })).json();
      if (!Array.isArray(assignments)) continue;
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      for (const a of assignments) {
        if (!a.due_at) continue;
        const due = new Date(a.due_at);
        if (due <= tomorrow && due >= now) {
          const hoursUntil = Math.round((due - now) / (1000 * 60 * 60));
          alerts.push(`${a.name} (${c.name}) — due in ${hoursUntil}h`);
        }
      }
    }
  } catch (err) { console.error('Canvas alert error:', err.message); }
  return alerts;
}

async function getCalendarAlertsForBriefing(hoursAhead = 24) {
  if (!isGoogleAuthed()) return [];
  const alerts = [];
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const now = new Date();
    const future = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10
    });
    const events = res.data.items || [];
    for (const e of events) {
      const start = e.start.dateTime ? new Date(e.start.dateTime) : null;
      if (!start) continue;
      const minsUntil = Math.round((start - now) / (1000 * 60));
      alerts.push({ summary: e.summary, minsUntil, start: start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) });
    }
  } catch (err) { console.error('Calendar alert error:', err.message); }
  return alerts;
}

async function checkAlerts() {
  console.log('⏰ Running proactive alert check...');
  const sentAlerts = loadSentAlerts();
  const now = new Date();
  const todayKey = now.toISOString().split('T')[0];
  const hour = now.getHours();
  const alerts = [];

  // Clean old sent alerts (keep only last 2 days)
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString().split('T')[0];
  for (const key of Object.keys(sentAlerts)) {
    if (key < twoDaysAgo) delete sentAlerts[key];
  }

  // ── MORNING BRIEFING (7-9 AM, once per day) ──
  const morningKey = `morning_${todayKey}`;
  if (hour >= 7 && hour < 9 && !sentAlerts[morningKey]) {
    const weather = await getWeatherForAlert();
    const canvasAlerts = await getCanvasAlertsForBriefing();
    const calAlerts = await getCalendarAlertsForBriefing(24);

    let briefing = `Good morning, sir. J.A.R.V.I.S. morning briefing:\n\n`;
    if (weather) briefing += `🌤 Weather: ${weather}\n\n`;
    if (calAlerts.length) {
      briefing += `📅 Today's schedule:\n`;
      calAlerts.forEach(e => { briefing += `  • ${e.summary} at ${e.start}\n`; });
      briefing += '\n';
    }
    if (canvasAlerts.length) {
      briefing += `📚 Assignments due soon:\n`;
      canvasAlerts.forEach(a => { briefing += `  • ${a}\n`; });
    }
    if (!calAlerts.length && !canvasAlerts.length) briefing += `All clear today, sir. No urgent items.`;

    await sendSMS2(process.env.MY_PHONE_NUMBER, briefing);
    sentAlerts[morningKey] = new Date().toISOString();
    alerts.push('Morning briefing sent');
  }

  // ── CALENDAR EVENT ALERTS (2 hours before) ──
  const calEvents = await getCalendarAlertsForBriefing(3);
  for (const e of calEvents) {
    if (e.minsUntil > 90 && e.minsUntil <= 130) {
      const alertKey = `cal_${todayKey}_${e.summary.slice(0, 20)}`;
      if (!sentAlerts[alertKey]) {
        await sendSMS2(process.env.MY_PHONE_NUMBER, `⏰ JARVIS: "${e.summary}" starts in ~2 hours (${e.start}), sir.`);
        sentAlerts[alertKey] = new Date().toISOString();
        alerts.push(`Calendar alert: ${e.summary}`);
      }
    }
  }

  // ── ASSIGNMENT DUE ALERTS ──
  const canvasItems = await getCanvasAlertsForBriefing();
  for (const a of canvasItems) {
    const alertKey = `assign_${todayKey}_${a.slice(0, 30)}`;
    if (!sentAlerts[alertKey]) {
      await sendSMS2(process.env.MY_PHONE_NUMBER, `📚 JARVIS: Assignment alert — ${a}, sir.`);
      sentAlerts[alertKey] = new Date().toISOString();
      alerts.push(`Assignment alert: ${a}`);
    }
  }

  saveSentAlerts(sentAlerts);
  if (alerts.length) console.log('📱 Alerts sent:', alerts);
  else console.log('✅ No new alerts to send');
}

// Schedule proactive alerts every 30 minutes
try {
  const { default: cron2 } = await import('node-cron');
  cron2.schedule('*/30 * * * *', checkAlerts);
  console.log('⏰ Proactive alert system scheduled (every 30 min)');
} catch (err) {
  console.log('⚠️ node-cron not available:', err.message);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — TWO WAY SMS TEXTING
// ═══════════════════════════════════════════════════════════════════════════

app.post('/sms', express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';

  // Security — only process from MY number
  const myNumber = process.env.MY_PHONE_NUMBER || '';
  if (!myNumber || from.replace(/\D/g, '') !== myNumber.replace(/\D/g, '')) {
    console.log('SMS rejected from unknown number:', from);
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

  console.log(`📱 Inbound SMS from ${from}: ${body}`);

  try {
    // Load history and memory — same pipeline as browser
    const smsHistory = loadHistory();
    smsHistory.push({ role: 'user', content: body });

    // Use same agent loop but with SMS-optimized system prompt
    const smsSystem = buildSystem() + '\n\n## SMS MODE\nYou are responding via SMS. Keep responses concise and readable on a phone screen. Max 300 characters when possible. No markdown, no headers. Be Jarvis but brief.';

    const messages = [...smsHistory];
    let reply = '';
    let iterations = 0;

    while (iterations < 8) {
      iterations++;
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: smsSystem,
        tools: TOOLS,
        messages
      });

      const textBlocks = response.content.filter(b => b.type === 'text');
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');

      if (response.stop_reason === 'end_turn' || !toolBlocks.length) {
        reply = textBlocks.map(b => b.text).join('');
        break;
      }

      const toolResults = await Promise.all(toolBlocks.map(async tool => {
        const result = await executeTool(tool.name, tool.input);
        return { type: 'tool_result', tool_use_id: tool.id, content: result };
      }));

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    if (!reply) reply = "Systems momentarily unavailable, sir. Try again shortly.";

    // Trim to SMS friendly length
    if (reply.length > 1500) reply = reply.slice(0, 1497) + '...';

    // Save to history
    smsHistory.push({ role: 'assistant', content: reply });
    saveHistory(smsHistory.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('') })));

    // Send reply via Twilio
    await sendSMS2(from, reply);

    // Respond to Twilio with empty TwiML (we already sent via API)
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');

  } catch (err) {
    console.error('SMS handler error:', err.message);
    await sendSMS2(from, `Systems error, sir: ${err.message.slice(0, 100)}`);
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  }
});

// Manual trigger for testing alerts
app.post('/trigger-alert', async (req, res) => {
  await checkAlerts();
  res.json({ success: true, message: 'Alert check triggered' });
});

console.log('🌍 Location tracking ready at POST /location');
console.log('📱 Two-way SMS ready at POST /sms');
