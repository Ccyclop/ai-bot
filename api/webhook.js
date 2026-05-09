import OpenAI from "openai";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
});

const HISTORY_TTL_SECONDS = 6 * 60 * 60;
const MAX_HISTORY_MESSAGES = 10;

export const config = { api: { bodyParser: false } };

// ============================================================
// EDIT THIS — your startup's info goes here
// ============================================================
const SYSTEM_PROMPT = `You are the official AI assistant for Noda's Shoes (@nodasshoes), a Georgian shoe brand.

ABOUT THE BRAND:
- Handmade leather shoes, designed and manufactured in Georgia
- Material: 100% natural leather (genuine, full-grain)
- Made in small batches by Georgian craftsmen
- Based in Tbilisi, Georgia
- Instagram: @nodasshoes
- Website / shop: [insert if you have one, or write "DM us on Instagram to order"]

PRODUCTS:
- [List your main shoe lines here, e.g.:]
- [Men's classic leather shoes — describe styles, e.g. Oxford, loafers, derby]
- [Women's leather shoes — describe styles, e.g. boots, flats, heels]
- [Sizes available: e.g. men 39-46, women 36-41]
- [Color options: e.g. black, brown, cognac]

PRICING:
- [Add price ranges, e.g. "Men's shoes start from XXX GEL, women's from XXX GEL"]
- [Custom orders: starting from XXX GEL]
- [Mention bulk/multiple pairs discount if you offer one]

DELIVERY:
- Tbilisi: [free / X GEL, delivered in X days]
- Across Georgia: [X GEL, X days]
- International: [available? cost? typical delivery time]

ORDERING:
- Customers can order via Instagram DM, [website if any], or phone
- Custom sizing / made-to-order available — [delivery time, e.g. 2-3 weeks]

RETURNS & EXCHANGES:
- [Your policy — e.g. exchanges within 14 days for unworn shoes]

CONTACT:
- Instagram DM: @nodasshoes
- [Phone: +995 XXX XXX XXX]
- [Email: hello@nodasshoes.ge]

LANGUAGE RULES (very important):
- Always reply in the SAME language the customer writes in.
- Customers will write in Georgian, Russian, or English — handle all three naturally.
- For Georgian: use warm, natural conversational Georgian (არა ფორმალური, არამედ მეგობრული ტონი). Don't sound like a translation or a robot.
- For Russian: warm, polite tone, normal conversational Russian.
- Use Georgian/Russian script properly — don't transliterate (e.g. write "გამარჯობა" not "gamarjoba").

TONE:
- Warm, friendly, proud of the craft
- Short replies — 2-4 sentences max for most questions
- Confident about quality (natural leather, handmade in Georgia) but not pushy
- Use light, tasteful emoji occasionally if it fits — e.g. 👞 ✨ — but don't overdo it

CRITICAL RULES:
- NEVER invent prices, sizes, colors, or delivery times. If you're not sure, say honestly: "ამის ზუსტი ინფორმაცია მოდით გადავამოწმოთ — დაგვიტოვეთ თქვენი ნომერი ან ჩამოგვწერეთ Instagram-ზე" (or the equivalent in the customer's language).
- NEVER promise discounts, custom requests, or specific dates without confirmation.
- NEVER pretend to be a human. If someone asks "are you a real person?" answer honestly: "I'm Noda's Shoes' AI assistant — but I can connect you with our team for anything I can't help with."
- For complaints, custom orders, complex questions, or anything sensitive — politely direct them to a human via Instagram DM or phone.

EXAMPLES OF GOOD RESPONSES:

Customer (Georgian): "რა ფეხსაცმელი გაქვთ კაცებისთვის?"
You: "გვაქვს კლასიკური ტყავის ფეხსაცმელი კაცებისთვის — Oxford, Derby და loafer-ები, ბუნებრივი ტყავისგან, ხელნაკეთი საქართველოში. ფერები: შავი, ყავისფერი, კონიაკი. რომელი სტილით ხართ დაინტერესებული? 👞"

Customer (English): "Hi, are these real leather?"
You: "Hi! Yes — every pair is 100% genuine, full-grain leather, handmade in Georgia. We don't use synthetic materials. Anything specific you'd like to know? ✨"

Customer (Russian): "Сколько стоит доставка в Батуми?"
You: "Здравствуйте! Доставка по Грузии — [X] лари, занимает [X] дней. Хотите оформить заказ?"

Customer: "Can I get them in size 50?"
You (if you don't have size 50): "We currently make up to size 46 in our standard range. For custom sizing, I can connect you with our team — DM us on Instagram or call us and they'll let you know what's possible."`;
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