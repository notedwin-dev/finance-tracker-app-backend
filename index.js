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
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  tools: [
    {
      functionDeclarations: [
        {
          name: "get_historical_transactions",
          description:
            "Query all historical transactions (beyond the recent 50 provided in context). Use this to answer questions about past spending, trends, or specific shops not in the recent list.",
          parameters: {
            type: "OBJECT",
            properties: {
              searchKeyword: {
                type: "STRING",
                description: "Shop name or description to filter by",
              },
              startDate: {
                type: "STRING",
                description: "Start date in YYYY-MM-DD format",
              },
              endDate: {
                type: "STRING",
                description: "End date in YYYY-MM-DD format",
              },
              categoryName: {
                type: "STRING",
                description: "The name of the category to filter by",
              },
            },
          },
        },
      ],
    },
  ],
});

app.post("/ai/chat", checkLimit, async (req, res) => {
  const { history, context } = req.body;

  try {
    const snapshotTime = new Date().toLocaleString();
    const systemInstruction = `
      You are ZenFinance AI, a helpful and minimalist financial assistant. 
      Your goal is to provide clear, actionable financial advice based on the user's data.

      CRITICAL: Always prioritize the "Current Financial Context" provided below over any data mentioned in previous messages. 
      The user's financial state (balances, goals, pots, subscriptions) may have changed since earlier in the conversation.
      
      "updatedAt" timestamps are provided for accounts, goals, and pots. Use these to determine how recently the data was modified.

      "Spending Limits" (pots):
      - "totalBudgetLimit" is the total budget for the period.
      - "remainingAvailableBudget" is how much the user has LEFT to spend.
      - Money Spent = totalBudgetLimit - remainingAvailableBudget.
      - Spent Percentage = (Money Spent / totalBudgetLimit) * 100.

      Current Financial Context (Snapshot Date/Time: ${snapshotTime}):
      ${JSON.stringify(context, null, 2)}
      
      Rules:
      1. Be concise and friendly.
      2. Use Markdown for formatting. Use headers (###), bold text, and bullet points to make info digestible.
      3. Use double newlines between paragraphs and headers to ensure proper spacing.
      4. If asked about spending, reference their specific categories and limits.
      5. Never give professional investment advice; always include a disclaimer if needed but keep it brief.
      6. Always respond in the language the user is using.
      7. Follow-up Suggestions (UI Elements):
         At the very end of your response, provide 3-4 follow-up suggestions for the user.
         These will be rendered as clickable UI buttons to help the user continue the conversation.
         The suggestions MUST be phrased from the USER'S perspective.
         Format:
         <suggestion>User Command 1</suggestion>
         <suggestion>User Command 2</suggestion>

      TOOLS & SECURITY:
      - You have access to tools to query historical transactions.
      - When you use a tool, the user will be asked to APPROVE or REJECT the data access.
      - If historical context for goals or pots is needed, look at related transactions using the tool.
    `;

    // Map history to Google's format
    const contents = history.map((m) => {
      if (m.functionResponse) {
        return {
          role: "function",
          parts: [{ functionResponse: m.functionResponse }],
        };
      }
      return {
        role: m.role === "user" ? "user" : "model",
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...(m.functionCall ? [{ functionCall: m.functionCall }] : []),
        ],
      };
    });

    // Start chat with system instruction
    const chat = model.startChat({
      history: contents.slice(0, -1),
      systemInstruction: {
        role: "system",
        parts: [{ text: systemInstruction }],
      },
    });

    const lastTurnParts = contents[contents.length - 1].parts;
    const result = await chat.sendMessageStream(lastTurnParts);

    let isFirstChunk = true;

    for await (const chunk of result.stream) {
      if (isFirstChunk) {
        const parts = chunk.candidates[0].content.parts;
        const hasFunctionCall = parts.some((p) => p.functionCall);

        if (hasFunctionCall) {
          // If there's a function call, we don't stream, just send JSON
          const functionCall = parts.find((p) => p.functionCall).functionCall;
          const text = parts
            .filter((p) => p.text)
            .map((p) => p.text)
            .join("");
          res.json({ text, functionCall });
          return;
        }

        // It's text, start streaming
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        isFirstChunk = false;
      }

      const chunkText = chunk.text();
      res.write(chunkText);
    }
    res.end();
  } catch (error) {
    console.error("AI Error:", error);
    if (!res.headersSent) {
      if (error.status === 429) {
        return res.status(429).json({
          error:
            "Gemini API Quota Exceeded. Please try again in 30-60 seconds or check your API limits.",
        });
      }
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
