const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();

// Strict CORS to only allow specific origin
const allowedOrigins = [
  "https://finance.notedwin.dev",
  process.env.NODE_ENV === "local" && "http://localhost:3000",
].filter(Boolean);
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  }),
);

app.use(express.json());

// Simple in-memory rate limiting
const dailyUsage = new Map();
const DAILY_LIMIT = 50;

const checkLimit = (req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const today = new Date().toISOString().split("T")[0];
  const key = `${ip}:${today}`;

  const currentUsage = dailyUsage.get(key) || 0;
  if (currentUsage >= DAILY_LIMIT) {
    return res.status(429).json({
      error:
        "Daily limit reached. Please provide your own API key in settings.",
    });
  }
  dailyUsage.set(key, currentUsage + 1);
  next();
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

app.post("/ai/chat", checkLimit, async (req, res) => {
  const { history, context } = req.body;

  // Set headers for streaming
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const systemInstruction = `
      You are ZenFinance AI, a helpful and minimalist financial assistant. 
      Your goal is to provide clear, actionable financial advice based on the user's data.
      
      Current Financial Context:
      ${JSON.stringify(context, null, 2)}
      
      Rules:
      1. Be concise and friendly.
      2. Use Markdown for formatting. Use headers (###), bold text, and bullet points to make info digestible.
      3. Use double newlines between paragraphs and headers to ensure proper spacing.
      4. If asked about spending, reference their specific categories and limits.
      5. Never give professional investment advice; always include a disclaimer if needed but keep it brief.
      6. Always respond in the language the user is using.
      7. At the end of your response, provide 2-3 brief follow-up suggestions in the format:
         <suggestion>Question 1?</suggestion>
         <suggestion>Question 2?</suggestion>
    `;

    // Map history to Google's format
    const contents = history.map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

    // Start chat with system instruction
    const chat = model.startChat({
      history: contents.slice(0, -1),
      systemInstruction: {
        role: "system",
        parts: [{ text: systemInstruction }],
      },
    });

    const lastMessage = history[history.length - 1].content;
    const result = await chat.sendMessageStream(lastMessage);

    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      res.write(chunkText);
    }
    res.end();
  } catch (error) {
    console.error("AI Error:", error);
    // If headers were already sent, we can't send a JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process AI request" });
    } else {
      res.end();
    }
  }
});

app.post("/ai/title", checkLimit, async (req, res) => {
  const { question, answer } = req.body;

  try {
    const prompt = `
      Based on this first exchange in a financial chat, generate a very short (max 4 words) title.
      Question: "${question}"
      Answer: "${answer.slice(0, 100)}..."
      
      Title:
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/"/g, "").trim() || "New Chat";
    res.json({ title: text });
  } catch (error) {
    console.error("AI Title Error:", error);
    res.json({ title: "New Financial Chat" });
  }
});

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "postmessage", // Special value for 'auth-code' flow in @react-oauth/google
);

app.post("/auth/google", async (req, res) => {
  const { code } = req.body;
  try {
    const { tokens } = await client.getToken(code);
    // Tokens will contain access_token, refresh_token, etc.
    res.json(tokens);
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    res.status(500).json({ error: "Failed to exchange code" });
  }
});

app.post("/auth/refresh", async (req, res) => {
  const { refresh_token } = req.body;
  try {
    const user = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    user.setCredentials({ refresh_token });
    const { token } = await user.getAccessToken();
    res.json({ access_token: token });
  } catch (error) {
    console.error("Error refreshing token:", error);
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
