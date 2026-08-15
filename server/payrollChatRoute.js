/**
 * server/payrollChatRoute.js
 *
 * Free-text side of Agent Payroll. The 8 quick-action buttons on the
 * frontend need no AI at all — this route only handles the message box,
 * turning a sentence like "pay everyone in the eng vault 5 USDC each"
 * into a structured tool call the frontend already knows how to run.
 *
 * Uses Google's Gemini API (generous free tier, no credit card needed —
 * see https://aistudio.google.com/apikey) rather than a paid API, since
 * this is a testnet demo feature, not something that needs a paid SLA.
 *
 * Critical safety property: this route NEVER executes anything itself.
 * It only returns which action Gemini thinks the person meant and with
 * what arguments — the frontend always opens the matching confirmation
 * form for anything that creates data or moves money, exactly the same
 * as if the person had clicked the button directly. A wrong or hallucinated
 * tool call just pre-fills a form with bad data; it can never itself send
 * a transaction.
 *
 * If GEMINI_API_KEY isn't set, this fails soft — free-text chat says so
 * and the person can still use every button on the page, same pattern as
 * analyticsRoute.js's Google Sheets webhook.
 */

import express from "express";

const router = express.Router();

const GEMINI_MODEL = "gemini-2.5-flash";

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "create_vault",
        description: "Create a new payroll vault with a given name.",
        parameters: {
          type: "OBJECT",
          properties: { name: { type: "STRING", description: "Name for the new vault" } },
          required: ["name"],
        },
      },
      {
        name: "show_vaults",
        description: "List all of the user's existing payroll vaults.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "add_contractor",
        description: "Add a contractor (name + wallet address) to the currently active vault.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Contractor's display name" },
            address: { type: "STRING", description: "Contractor's 0x wallet address" },
          },
          required: ["name", "address"],
        },
      },
      {
        name: "list_contractors",
        description: "List contractors in the currently active vault.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "check_balance",
        description: "Check the user's current wallet USDC balance.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "run_payroll",
        description: "Pay every contractor in the active vault the same amount of a given token. This moves real testnet funds, so it always requires the user's explicit confirmation before anything is sent.",
        parameters: {
          type: "OBJECT",
          properties: {
            token: { type: "STRING", enum: ["USDC", "EURC", "cirBTC"], description: "Which token to pay in" },
            amount: { type: "STRING", description: "Amount to pay EACH contractor, as a plain decimal string" },
          },
          required: ["amount"],
        },
      },
      {
        name: "switch_vault",
        description: "Switch the active vault to a different one by name.",
        parameters: {
          type: "OBJECT",
          properties: { vaultName: { type: "STRING", description: "Name of the vault to switch to" } },
          required: ["vaultName"],
        },
      },
      {
        name: "show_history",
        description: "Show recent payroll payment history.",
        parameters: { type: "OBJECT", properties: {} },
      },
    ],
  },
];

router.post("/payroll-chat", async (req, res) => {
  const { message, context } = req.body || {};
  console.log(`[payroll-chat] hit — message="${(message || "").slice(0, 120)}"`);

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing message." });
  }

  if (!process.env.GEMINI_API_KEY) {
    console.log("[payroll-chat] GEMINI_API_KEY is not set — failing soft.");
    return res.json({
      reply: "AI chat isn't set up yet on this deployment — the buttons below still work for everything.",
    });
  }

  const systemInstruction = {
    parts: [
      {
        text:
          "You are Agent Payroll, a USDC payroll assistant for a testnet DeFi app called Arclify. " +
          "You help the user manage payroll vaults and contractors, and run payroll. " +
          "Current context: " +
          JSON.stringify(context || {}) +
          ". " +
          "If the user's request clearly maps to one of your tools, call that tool. " +
          "If they're just asking a question or chatting, reply in plain text instead — keep replies short, " +
          "1-3 sentences. Never claim you already completed an action; you only ever propose one, and the app " +
          "always shows the user a confirmation step before anything (especially anything involving money) " +
          "actually happens.",
      },
    ],
  };

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: message }] }],
          systemInstruction,
          tools: TOOLS,
        }),
      }
    );

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text().catch(() => "");
      console.error(`[payroll-chat] Gemini responded ${geminiRes.status}: ${errBody.slice(0, 300)}`);
      return res.json({ reply: "Couldn't reach the AI right now — the buttons below still work." });
    }

    const data = await geminiRes.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const functionCallPart = parts.find((p) => p.functionCall);
    const textPart = parts.find((p) => p.text);

    if (functionCallPart) {
      console.log(`[payroll-chat] tool call: ${functionCallPart.functionCall.name}`);
      return res.json({
        toolCall: { name: functionCallPart.functionCall.name, args: functionCallPart.functionCall.args || {} },
      });
    }

    return res.json({ reply: textPart?.text || "Not sure how to help with that — try one of the buttons below." });
  } catch (err) {
    console.error("[payroll-chat] Failed to reach Gemini:", err.message);
    return res.json({ reply: "Couldn't reach the AI right now — the buttons below still work." });
  }
});

export default router;
