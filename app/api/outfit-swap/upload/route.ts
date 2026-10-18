import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Route này KHÔNG còn nhận bytes ảnh nữa (xem lib/upload-direct.ts) — chỉ xin 1 "signed upload URL" từ
// Supabase rồi trả về cho trình duyệt tự tải thẳng lên, tránh gửi body lớn qua Vercel (đường truyền từ
// máy khách tới IP Vercel bị nghẽn khi body lớn, đã đo bằng curl -v, không liên quan gì tới code/app).
export async function POST(req: Request) {
  const { ext } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  const safeExt = typeof ext === "string" && /^[a-zA-Z0-9]{1,10}$/.test(ext) ? ext : "jpg";
  const filePath = `${userId}/${randomUUID()}.${safeExt}`;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from("outfit-swap-uploads").createSignedUploadUrl(filePath);
  if (error || !data) return Response.json({ error: error?.message ?? "Không tạo được link tải ảnh" }, { status: 500 });

  const { data: publicUrlData } = supabase.storage.from("outfit-swap-uploads").getPublicUrl(filePath);
  return Response.json({ token: data.token, path: data.path, publicUrl: publicUrlData.publicUrl });
}
