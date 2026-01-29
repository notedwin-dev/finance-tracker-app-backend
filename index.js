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

  try {
    const prompt = `
      You are ZenFinance AI, a helpful personal finance assistant.
      User Financial Context:
      ${JSON.stringify(context, null, 2)}

      Response Guidelines:
      1. Be concise and professional.
      2. Use Markdown for formatting.
      3. Use currency symbols appropriately.
      4. Suggest actionable steps.
      5. To suggest a follow-up question, wrap it in <suggestion>Question Text</suggestion> at the end of your response.
    `;

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: prompt }] },
        {
          role: "model",
          parts: [
            {
              text: "Understood. I have your financial context. How can I assist you today?",
            },
          ],
        },
        ...history.slice(0, -1).map((msg) => ({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }],
        })),
      ],
    });

    const lastMessage = history[history.length - 1].content;
    const result = await chat.sendMessage(lastMessage);
    const response = await result.response;
    res.json({ text: response.text() });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: "Failed to process AI request" });
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
