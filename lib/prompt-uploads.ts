import { getSupabaseAdmin } from "@/lib/supabase";

// Thư viện ảnh "Tải lên" trong modal +/@ ở app/video-tu-y-tuong — khác reference_elements (kho
// nhân vật/địa điểm/đạo cụ có tên/@mention), đây chỉ là danh sách ảnh THÔ khách đã tải lên qua nút
// "+", lưu lại để mở modal lần sau vẫn thấy, không bị mất khi đóng modal/rời trang.

export type PromptUpload = {
  id: number;
  user_id: string;
  url: string;
  created_at: string;
};

const MAX_LISTED = 60;

export async function listPromptUploads(userId: string): Promise<PromptUpload[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("prompt_uploads")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_LISTED);
  if (error) throw new Error(error.message);
  return (data ?? []) as PromptUpload[];
}

export async function createPromptUpload(userId: string, url: string): Promise<PromptUpload> {
  if (!url?.trim()) throw new Error("Thiếu url ảnh");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("prompt_uploads")
    .insert({ user_id: userId, url })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as PromptUpload;
}

// Xoá 1 ảnh khỏi thư viện "Tải lên" — khách bấm "Xoá" trong ReferencePickerModal. Xoá cả bản ghi DB
// VÀ file thật trong Supabase Storage (bucket "outfit-swap-uploads", nơi /api/outfit-swap/upload lưu
// ảnh gốc) để tránh rác dung lượng tích luỹ (đúng tinh thần theo dõi quota Supabase đã thống nhất) —
// lỗi xoá storage KHÔNG chặn việc xoá bản ghi DB (best-effort, ảnh có thể đã bị xoá tay/hỏng từ trước).
// Chỉ match theo user_id + url (không cần id riêng) — mỗi lần upload luôn ra url khác nhau (randomUUID
// trong filePath), nên url ở đây vẫn đủ xác định đúng 1 hàng.
export async function deletePromptUpload(userId: string, url: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  const match = url.match(/\/outfit-swap-uploads\/(.+)$/);
  if (match) {
    await supabase.storage.from("outfit-swap-uploads").remove([decodeURIComponent(match[1])]);
  }

  const { error } = await supabase.from("prompt_uploads").delete().eq("user_id", userId).eq("url", url);
  if (error) throw new Error(error.message);
}
