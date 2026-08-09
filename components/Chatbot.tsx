"use client";

// Floating chatbot widget — góc dưới phải, responsive 3 breakpoint.
// Mobile (≤640px): fullscreen overlay khi mở.
// Tablet/Desktop: panel neo góc dưới phải.

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTED_QUESTIONS = [
  "Credit là gì?",
  "Làm sao nạp credit?",
  "Có Mini App nào?",
  "Chính sách hoàn credit?",
];

const WELCOME = "Em chào anh/chị 👋 Em là trợ lý AI của AI Marketplace. Anh/chị cần em hỗ trợ gì ạ?";

export default function Chatbot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  useEffect(() => {
    if (open && window.matchMedia("(max-width: 640px)").matches) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [open]);

  async function send(text: string) {
    if (!text.trim() || streaming) return;
    setError(null);
    const userMsg: Msg = { role: "user", content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("No response body");

      setMessages((m) => [...m, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              setMessages((m) => {
                const last = m[m.length - 1];
                if (last.role !== "assistant") return m;
                return [...m.slice(0, -1), { ...last, content: last.content + delta }];
              });
            }
          } catch {
            // bỏ qua chunk không parse được (vd. comment SSE keep-alive)
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Lỗi không xác định";
      setError(msg);
      setMessages((m) => (m[m.length - 1]?.role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m));
    } finally {
      setStreaming(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Mở chatbot hỗ trợ"
          className="fixed bottom-5 right-5 z-[9999] flex h-14 w-14 items-center justify-center rounded-full bg-zinc-900 text-white shadow-lg transition hover:scale-105 hover:bg-zinc-700 active:scale-95 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 sm:bottom-6 sm:right-6 lg:h-16 lg:w-16"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6 lg:h-7 lg:w-7">
            <path d="M12 2C6.48 2 2 6.04 2 11c0 2.28.93 4.36 2.5 6L3 21l4.4-1.42c1.4.65 2.97 1.02 4.6 1.02 5.52 0 10-4.04 10-9S17.52 2 12 2z" />
          </svg>
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-[9999] flex flex-col bg-white shadow-2xl dark:bg-zinc-950 sm:bottom-6 sm:right-6 sm:left-auto sm:top-auto sm:h-[70vh] sm:w-[380px] sm:rounded-2xl sm:border sm:border-zinc-200 dark:sm:border-zinc-800 lg:h-[600px] lg:w-[400px]"
          role="dialog"
          aria-label="Chatbot hỗ trợ"
        >
          <div className="flex items-center justify-between bg-zinc-900 px-4 py-3 text-white dark:bg-zinc-50 dark:text-zinc-900 sm:rounded-t-2xl">
            <div>
              <div className="font-semibold">Trợ lý AI Marketplace</div>
              <div className="text-xs opacity-80">Trả lời trong vài giây</div>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Đóng chatbot"
              className="rounded-full p-1 transition hover:bg-zinc-700 dark:hover:bg-zinc-200 active:scale-95"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-zinc-50 px-4 py-4 dark:bg-zinc-900">
            {messages.length === 0 && (
              <>
                <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm dark:bg-zinc-800 dark:text-zinc-100">
                  {WELCOME}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {SUGGESTED_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => send(q)}
                      className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700 transition hover:bg-zinc-100 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] break-words rounded-2xl px-3 py-2 text-sm shadow-sm ${
                  m.role === "user"
                    ? "ml-auto whitespace-pre-wrap rounded-tr-sm bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "chatbot-md rounded-tl-sm bg-white text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                }`}
              >
                {m.content ? (
                  m.role === "assistant" ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: (props) => (
                          <a
                            {...props}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2"
                          />
                        ),
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  ) : (
                    m.content
                  )
                ) : streaming && i === messages.length - 1 ? (
                  <TypingDots />
                ) : (
                  ""
                )}
              </div>
            ))}

            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
                Lỗi: {error}. Anh/chị thử lại sau ít phút giúp em ạ.
              </div>
            )}
          </div>

          <div
            className="border-t border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
            style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nhập câu hỏi..."
                rows={1}
                disabled={streaming}
                className="max-h-32 flex-1 resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              />
              <button
                onClick={() => send(input)}
                disabled={!input.trim() || streaming}
                aria-label="Gửi tin nhắn"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 active:scale-95"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                  <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
    </span>
  );
}
