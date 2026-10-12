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
