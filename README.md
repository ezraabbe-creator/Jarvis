# 🤖 J.A.R.V.I.S. — Autonomous AI Agent

A fully autonomous, voice-enabled AI assistant powered by Claude. Talk to it by voice, give it complex tasks, and it won't stop until they're done.

## What It Does

| Feature | Details |
|---|---|
| 🎙️ Voice in | Speak commands via mic (Web Speech API) |
| 🔊 Voice out | Jarvis speaks responses back |
| 🌐 Web search | Live web results via Brave Search |
| 🌤️ Weather | Current + 3-day forecast via WeatherAPI |
| 📰 News | Real-time headlines via Google News RSS |
| 🧠 Memory | Jarvis remembers things within a session |
| 🔁 Agent loop | Runs up to 10 tool iterations per task |
| 💻 24/7 server | Deployable to Railway in minutes |

---

## Setup — Local

### 1. Install dependencies
```bash
npm install
```

### 2. Create your `.env` file
```bash
cp .env.example .env
```

Fill in your keys:

```env
ANTHROPIC_API_KEY=sk-ant-...     # Required — get at console.anthropic.com
BRAVE_API_KEY=...                 # Optional but recommended — api.search.brave.com (free tier)
WEATHER_API_KEY=...               # Optional — weatherapi.com (free tier)
```

### 3. Run it
```bash
npm run dev     # development (auto-restarts)
npm start       # production
```

Open **http://localhost:3000** in your browser.

---

## Deploy to Railway (24/7 Free Tier)

Railway gives you $5/month free — more than enough for Jarvis.

### Step-by-step:

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "jarvis init"
   # Create a new repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/jarvis.git
   git push -u origin main
   ```

2. **Deploy on Railway**
   - Go to [railway.app](https://railway.app) → sign in with GitHub
   - Click **New Project** → **Deploy from GitHub repo**
   - Select your jarvis repo
   - Railway auto-detects Node.js and deploys

3. **Add Environment Variables**
   - In Railway dashboard → your project → **Variables**
   - Add: `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, `WEATHER_API_KEY`

4. **Get your URL**
   - Railway gives you a public URL like `https://jarvis-production.up.railway.app`
   - That's your Jarvis — accessible from anywhere, 24/7 🎉

---

## API Keys (Where to Get Them)

| Key | Where | Free Tier |
|---|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Pay-as-you-go |
| `BRAVE_API_KEY` | [api.search.brave.com](https://api.search.brave.com) | 2,000 searches/month |
| `WEATHER_API_KEY` | [weatherapi.com](https://weatherapi.com) | 1,000,000 calls/month |

> **Note:** Brave and Weather keys are optional. Without them, Jarvis falls back to DuckDuckGo for search and skips weather. The bot still works great.

---

## Customizing Jarvis

### Change the personality
Edit the `SYSTEM` constant in `src/server.js`. That's Jarvis's brain — rewrite it however you want.

### Add new tools
1. Add a tool definition to the `TOOLS` array in `src/server.js`
2. Add a case to the `executeTool` switch statement
3. Jarvis will automatically start using it

### Upgrade voice quality
Replace browser TTS with [ElevenLabs](https://elevenlabs.io):
1. Get a free ElevenLabs API key
2. In `public/index.html`, replace the `speak()` function with an ElevenLabs API call
3. Use the "Jarvis" or "Daniel" voice for a cinematic sound

### Add SMS (Twilio)
1. `npm install twilio`
2. Add a `/sms` endpoint in `server.js` that receives webhooks from Twilio
3. Jarvis can now text you and receive texts from you

---

## Architecture

```
Browser (index.html)
  ↕ WebSocket
Node.js Server (server.js)
  ↕ Anthropic API (Claude Sonnet)
  ↕ Brave Search API
  ↕ WeatherAPI
  ↕ Google News RSS
```

The agent loop:
1. User sends message
2. Claude decides which tools to use
3. Server executes tools in parallel
4. Results fed back to Claude
5. Claude decides if done or needs more tools
6. Repeats up to 10 times
7. Final answer sent to browser → spoken aloud
