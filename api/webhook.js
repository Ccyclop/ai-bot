import OpenAI from "openai";
import crypto from "crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const config = { api: { bodyParser: false } };

// ============================================================
// EDIT THIS — your startup's info goes here
// ============================================================
const SYSTEM_PROMPT = `You are the official AI assistant for [STARTUP NAME].

ABOUT US:
- What we do: [describe in 1-2 sentences what your startup does]
- Who we serve: [your target customers]
- Founded: [year], based in [city/country]
- Website: [your URL]

PRODUCTS / SERVICES:
- [Product 1]: [short description, price if relevant]
- [Product 2]: [short description, price if relevant]
- [Add more as needed]

COMMON QUESTIONS:
- Pricing: [your pricing info or "see website"]
- Delivery / availability: [details]
- Refund / return policy: [details]
- Contact: [email, phone, or "we'll connect you with our team"]

TONE & RULES:
- Respond in the SAME LANGUAGE the user writes in (Georgian, English, or Russian).
- For Georgian: use natural, conversational Georgian — not formal or robotic.
- Keep replies SHORT — 2-4 sentences max.
- If you don't know something specific, say so honestly and offer to connect them with a human.
- Never make up prices, dates, or product features. If unsure, say "let me check with the team and get back to you."
- Be warm and helpful, but professional.

ESCALATION:
If the user wants to: place a custom order, file a complaint, or speak to a human — politely tell them to email [your email] or call [your phone].`;
// ============================================================

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRawBody(req);
  const sig = req.headers["x-hub-signature-256"];
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", process.env.APP_SECRET).update(raw).digest("hex");
  if (sig !== expected) {
    console.error("Invalid signature");
    return res.status(401).end();
  }

  const body = JSON.parse(raw.toString());

  try {
    const msg = parseMessage(body);
    if (!msg) return res.status(200).end();

    console.log("Incoming:", msg.channel, msg.senderId, msg.text);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // upgraded — much better at Georgian
      max_tokens: 300,
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: msg.text },
      ],
    });

    const reply = completion.choices[0].message.content;
    console.log("Reply:", reply);
    await sendReply(msg, reply);

    return res.status(200).end();
  } catch (err) {
    console.error("Error:", err);
    return res.status(200).end();
  }
}

function parseMessage(body) {
  const { object, entry } = body;

  if (object === "page" || object === "instagram") {
    const m = entry?.[0]?.messaging?.[0];
    if (!m?.message?.text) return null;
    if (m.message.is_echo) return null;
    return {
      channel: object === "page" ? "messenger" : "instagram",
      senderId: m.sender.id,
      text: m.message.text,
    };
  }

  if (object === "whatsapp_business_account") {
    const change = entry?.[0]?.changes?.[0]?.value;
    const m = change?.messages?.[0];
    if (!m || m.type !== "text") return null;
    return {
      channel: "whatsapp",
      senderId: m.from,
      text: m.text.body,
      phoneNumberId: change.metadata.phone_number_id,
    };
  }

  return null;
}

async function sendReply(msg, text) {
  const v = "v21.0";
  let url, body;

  if (msg.channel === "whatsapp") {
    url = `https://graph.facebook.com/${v}/${msg.phoneNumberId}/messages`;
    body = {
      messaging_product: "whatsapp",
      to: msg.senderId,
      text: { body: text },
    };
  } else {
    url = `https://graph.facebook.com/${v}/me/messages`;
    body = { recipient: { id: msg.senderId }, message: { text } };
  }

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAGE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text();
    console.error("Send failed:", r.status, errText);
  }
}