// app/api/chat/route.ts — proxy gọi OpenRouter với streaming cho chatbot hỗ trợ.
// KHÔNG expose OPENROUTER_API_KEY ra client — mọi request từ widget đi qua route này.

import { systemPrompt } from "@/lib/chatbot-knowledge";

export const runtime = "edge";

const MODEL = "google/gemini-3-flash-preview";

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENROUTER_API_KEY chưa được set trong .env.local" },
      { status: 500 }
    );
  }

  let messages: Msg[];
  try {
    const body = await req.json();
    messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) throw new Error("empty messages");
  } catch {
    return Response.json({ error: "Invalid messages payload" }, { status: 400 });
  }

  // Giới hạn lịch sử 20 turn cuối để tránh tốn token + vượt context window.
  const trimmed = messages.slice(-20);

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "AI Marketplace Chatbot",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...trimmed],
      stream: true,
      temperature: 0.7,
      max_tokens: 800,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "Unknown OpenRouter error");
    return Response.json({ error: `OpenRouter error: ${upstream.status} ${errText}` }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
