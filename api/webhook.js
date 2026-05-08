import OpenAI from "openai";
import crypto from "crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  // Webhook verification (Meta calls this once during setup)
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

  // Read and verify signature
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
    if (!msg) {
      return res.status(200).end();
    }

    console.log("Incoming:", msg.channel, msg.senderId, msg.text);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content:
            "You are a friendly assistant for a small startup. Keep replies under 3 sentences. If you don't know something, say so honestly.",
        },
        { role: "user", content: msg.text },
      ],
    });

    const reply = completion.choices[0].message.content;
    console.log("Reply:", reply);
    await sendReply(msg, reply);

    return res.status(200).end();
  } catch (err) {
    console.error("Error:", err);
    return res.status(200).end(); // still return 200 so Meta doesn't retry
  }
}

function parseMessage(body) {
  const { object, entry } = body;

  if (object === "page" || object === "instagram") {
    const m = entry?.[0]?.messaging?.[0];
    if (!m?.message?.text) return null;
    if (m.message.is_echo) return null; // ignore our own sent messages
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