import { randomUUID } from "crypto";
import { cookies, headers } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase";

// Tool dùng thử miễn phí, KHÔNG cần đăng nhập (/thu-mien-phi) — mồi kéo traffic mới, chi phí Fal.ai
// do platform tự trả (không qua credit khách, không có tài khoản để trừ). Model Bria RMBG 2.0
// ($0.018/ảnh, tra fal.ai/models 2026-08-17) — dữ liệu train có bản quyền thương mại rõ ràng, phù
// hợp làm tool đại diện thương hiệu công khai.
const TOOL = "remove-bg";
const MODEL = "fal-ai/bria/background/remove";
const PER_IDENTITY_DAILY_LIMIT = 3; // theo IP hoặc cookie, tuỳ cái nào chạm trước
const COOKIE_NAME = "free_trial_id";

export async function POST(req: Request) {
  const { imageDataUrl } = await req.json();
  const match =
    typeof imageDataUrl === "string" ? imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/) : null;
  if (!match) return Response.json({ error: "Ảnh không hợp lệ" }, { status: 400 });

  const [, , base64Data] = match;
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.byteLength > 3 * 1024 * 1024) {
    return Response.json({ error: "Ảnh tối đa 3MB, anh chọn ảnh nhỏ hơn giúp em nhé" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const existingCookieId = cookieStore.get(COOKIE_NAME)?.value;
  const cookieId = existingCookieId ?? randomUUID();

  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || headerList.get("x-real-ip") || "unknown";

  const supabase = getSupabaseAdmin();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: settingsRow } = await supabase.from("site_settings").select("free_trial_daily_cap").eq("id", 1).single();
  const dailyCap = settingsRow?.free_trial_daily_cap ?? 50;

  const { count: globalCount } = await supabase
    .from("free_trial_log")
    .select("id", { count: "exact", head: true })
    .eq("tool", TOOL)
    .gte("created_at", todayStart.toISOString());

  if ((globalCount ?? 0) >= dailyCap) {
    return Response.json(
      { error: "Tool này đã hết lượt dùng thử miễn phí hôm nay, anh quay lại vào ngày mai nhé." },
      { status: 429 }
    );
  }

  const { count: identityCount } = await supabase
    .from("free_trial_log")
    .select("id", { count: "exact", head: true })
    .eq("tool", TOOL)
    .or(`ip.eq.${ip},cookie_id.eq.${cookieId}`)
    .gte("created_at", todayStart.toISOString());

  if ((identityCount ?? 0) >= PER_IDENTITY_DAILY_LIMIT) {
    return Response.json(
      { error: `Anh đã dùng hết ${PER_IDENTITY_DAILY_LIMIT} lượt miễn phí hôm nay, quay lại vào ngày mai nhé.` },
      { status: 429 }
    );
  }

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return Response.json({ error: "Chưa cấu hình FAL_KEY trong .env.local" }, { status: 500 });

  try {
    const falRes = await fetch(`https://fal.run/${MODEL}`, {
      method: "POST",
      headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageDataUrl }),
    });
    if (!falRes.ok) {
      const errText = await falRes.text().catch(() => "Unknown Fal.ai error");
      throw new Error(`Fal.ai lỗi: ${falRes.status} ${errText}`);
    }
    const falData = await falRes.json();
    const resultUrl: string | undefined = falData?.image?.url;
    if (!resultUrl) throw new Error("Fal.ai không trả về ảnh");

    await supabase.from("free_trial_log").insert({ tool: TOOL, ip, cookie_id: cookieId });

    if (!existingCookieId) {
      cookieStore.set(COOKIE_NAME, cookieId, {
        maxAge: 60 * 60 * 24 * 365,
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      });
    }

    return Response.json({ resultUrl });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra, thử lại giúp em" }, { status: 500 });
  }
}
