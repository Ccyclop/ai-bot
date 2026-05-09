import OpenAI from "openai";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
});

const HISTORY_TTL_SECONDS = 6 * 60 * 60;
const MAX_HISTORY_MESSAGES = 10;

export const config = { api: { bodyParser: false } };

// Edit your brand info in api/prompt.md
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8");

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

    const historyKey = `chat:${msg.channel}:${msg.senderId}`;
    const history = (await redis.get(historyKey)) ?? [];

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 300,
      reasoning_effort: "minimal",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: msg.text },
      ],
    });

    const reply = completion.choices[0].message.content;
    console.log("Reply:", reply);
    await sendReply(msg, reply);

    const updated = [
      ...history,
      { role: "user", content: msg.text },
      { role: "assistant", content: reply },
    ].slice(-MAX_HISTORY_MESSAGES);
    await redis.set(historyKey, updated, { ex: HISTORY_TTL_SECONDS });

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
