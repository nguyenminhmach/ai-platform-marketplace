// Đăng video thẳng lên kênh YouTube của user qua OAuth 2.0 + YouTube Data API v3.
// Luồng: /api/youtube/authorize (redirect sang Google) -> /api/youtube/callback (đổi code lấy
// access_token + refresh_token, lưu vào bảng youtube_connections) -> /api/youtube/upload (resumable
// upload video). access_token hết hạn sau ~1h nên upload luôn refresh trước khi dùng cho chắc.

import { getSupabaseAdmin } from "@/lib/supabase";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";
const REDIRECT_URI = `${SITE_URL}/api/youtube/callback`;
const SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

function requireEnv(name: "YOUTUBE_CLIENT_ID" | "YOUTUBE_CLIENT_SECRET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Chưa cấu hình ${name} trong .env.local`);
  return value;
}

/** Link đưa user sang màn hình Google xin quyền — state mang theo userId để callback biết gắn token cho ai. */
export function getYoutubeAuthUrl(userId: string): string {
  const clientId = requireEnv("YOUTUBE_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // bắt buộc để nhận refresh_token
    prompt: "consent", // ép Google luôn trả refresh_token, kể cả lần 2 trở đi
    state: userId,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Đổi authorization code (từ callback) lấy access_token + refresh_token, lưu vào DB. */
export async function exchangeCodeAndSaveTokens(code: string, userId: string): Promise<void> {
  const clientId = requireEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = requireEnv("YOUTUBE_CLIENT_SECRET");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new Error(`Google OAuth lỗi: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokenData = await tokenRes.json();

  const channelRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const channelData = channelRes.ok ? await channelRes.json() : null;
  const channelTitle = channelData?.items?.[0]?.snippet?.title ?? null;

  const supabase = getSupabaseAdmin();
  await supabase.from("youtube_connections").upsert({
    user_id: userId,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
    channel_title: channelTitle,
  });
}

/** Lấy access_token còn hạn cho user — tự refresh nếu đã/sắp hết hạn. */
async function getValidAccessToken(userId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: conn, error } = await supabase.from("youtube_connections").select("*").eq("user_id", userId).single();
  if (error || !conn) throw new Error("Chưa kết nối YouTube");

  const stillValidMs = new Date(conn.token_expires_at).getTime() - Date.now();
  if (stillValidMs > 60_000) return conn.access_token; // còn hạn hơn 1 phút, dùng luôn

  const clientId = requireEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = requireEnv("YOUTUBE_CLIENT_SECRET");
  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: conn.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!refreshRes.ok) throw new Error(`Không làm mới được token YouTube: ${refreshRes.status} ${await refreshRes.text()}`);
  const refreshData = await refreshRes.json();

  await supabase
    .from("youtube_connections")
    .update({
      access_token: refreshData.access_token,
      token_expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
    })
    .eq("user_id", userId);

  return refreshData.access_token;
}

export async function isYoutubeConnected(userId: string): Promise<{ connected: boolean; channelTitle: string | null }> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("youtube_connections").select("channel_title").eq("user_id", userId).single();
  return { connected: !!data, channelTitle: data?.channel_title ?? null };
}

/** Upload video (từ URL đã host sẵn trên Storage) lên kênh YouTube của user — resumable upload theo chuẩn Google. */
export async function uploadVideoToYoutube(
  userId: string,
  videoUrl: string,
  title: string,
  description: string
): Promise<string> {
  const accessToken = await getValidAccessToken(userId);

  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Không tải được video để đăng: ${videoRes.status}`);
  const videoBlob = await videoRes.arrayBuffer();

  // Bước 1: khởi tạo phiên upload resumable, gửi metadata trước
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(videoBlob.byteLength),
      },
      body: JSON.stringify({
        snippet: { title, description, categoryId: "22" }, // 22 = People & Blogs, danh mục an toàn mặc định
        status: { privacyStatus: "public" },
      }),
    }
  );
  if (!initRes.ok) throw new Error(`YouTube lỗi khởi tạo upload: ${initRes.status} ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) throw new Error("YouTube không trả về upload URL");

  // Bước 2: gửi thẳng bytes video lên upload URL đó
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(videoBlob.byteLength) },
    body: videoBlob,
  });
  if (!uploadRes.ok) throw new Error(`YouTube lỗi khi upload: ${uploadRes.status} ${await uploadRes.text()}`);
  const result = await uploadRes.json();

  return `https://www.youtube.com/watch?v=${result.id}`;
}
