import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Mirror đúng outfit-swap/upload/route.ts — route này chỉ xin "signed upload URL", KHÔNG nhận bytes
// ảnh qua Vercel nữa (xem lib/upload-direct.ts để biết lý do: đường truyền máy khách → IP Vercel bị
// nghẽn khi body lớn, đo được bằng curl -v, không liên quan code/app logic).
export async function POST(req: Request) {
  const { ext } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  const safeExt = typeof ext === "string" && /^[a-zA-Z0-9]{1,10}$/.test(ext) ? ext : "jpg";
  const filePath = `${userId}/${randomUUID()}.${safeExt}`;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from("reference-element-uploads").createSignedUploadUrl(filePath);
  if (error || !data) return Response.json({ error: error?.message ?? "Không tạo được link tải ảnh" }, { status: 500 });

  const { data: publicUrlData } = supabase.storage.from("reference-element-uploads").getPublicUrl(filePath);
  return Response.json({ token: data.token, path: data.path, publicUrl: publicUrlData.publicUrl });
}
