import express from "express";
import { OAuth2Client } from "google-auth-library";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const historicalTransactionsTool = {
  functionDeclarations: [
    {
      name: "get_historical_transactions",
      description:
        "Query all historical transactions (beyond the recent 50 provided in context). Use this to answer questions about past spending, trends, or specific shops not in the recent list.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          searchKeyword: {
            type: Type.STRING,
            description: "Shop name or description to filter by",
          },
          startDate: {
            type: Type.STRING,
            description: "Start date in YYYY-MM-DD format",
          },
          endDate: {
            type: Type.STRING,
            description: "End date in YYYY-MM-DD format",
          },
          categoryName: {
            type: Type.STRING,
            description: "The name of the category to filter by",
          },
        },
      },
    },
  ],
};

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
         These will rendered as clickable UI buttons to help the user continue the conversation.
         The suggestions MUST be phrased from the USER'S perspective.
         Format:
         <suggestion>User Command 1</suggestion>
         <suggestion>User Command 2</suggestion>

      TOOLS & SECURITY:
      - You have access to tools to query historical transactions.
      - When you use a tool, the user will be asked to APPROVE or REJECT the data access.
      - If historical context for goals or pots is needed, look at related transactions using the tool.
    `;

    // Map history to Google GenAI SDK format
    const contents = history.map((m) => {
      if (m.functionResponse) {
        return {
          role: "tool",
          parts: [
            {
              functionResponse: {
                name: m.functionResponse.name,
                response: m.functionResponse.response,
              },
            },
          ],
        };
      }
      return {
        role: m.role === "user" ? "user" : "model",
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...(m.functionCall
            ? [
                {
                  functionCall: {
                    name: m.functionCall.name,
                    args: m.functionCall.args,
                  },
                },
              ]
            : []),
        ],
      };
    });

    // Start chat with system instruction
    const chat = ai.chats.create({
      model: "gemini-2.5-flash",
      history: contents.slice(0, -1),
      config: {
        systemInstruction: systemInstruction,
        tools: [historicalTransactionsTool],
      },
    });

    const lastTurn = contents[contents.length - 1];
    const message = lastTurn.parts.find((p) => p.text)?.text || "";
    const response = await chat.sendMessageStream(message);

    let isFirstChunk = true;

    for await (const chunk of response) {
      if (isFirstChunk) {
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          // If there's a function call, we don't stream, just send JSON
          const functionCall = chunk.functionCalls[0];
          const text = chunk.text || "";
          res.json({ text, functionCall });
          return;
        }

        // It's text, start streaming
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        isFirstChunk = false;
      }

      if (chunk.text) {
        res.write(chunk.text);
      }
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

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });
    res.json({ title: result.text.replace(/"/g, "").trim() || "New Chat" });
  } catch (error) {
    console.error("AI Title Error:", error);
    res.json({ title: "New Financial Chat" });
  }
});

const oauthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "postmessage", // Special value for 'auth-code' flow in @react-oauth/google
);

app.post("/auth/google", async (req, res) => {
  const { code } = req.body;
  try {
    const { tokens } = await oauthClient.getToken(code);
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
    const oauth = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth.setCredentials({ refresh_token });
    const { token } = await oauth.getAccessToken();
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
