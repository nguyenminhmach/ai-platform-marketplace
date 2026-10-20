import { getSupabaseAdmin } from "@/lib/supabase";

// Ảnh sinh qua Fal.ai (prompt_image_jobs, story-video scenes...) lưu trên CDN của Fal, KHÔNG tốn
// Storage Supabase — chỉ video đã ghép (bucket "videos", xem lib/story-video.ts stitchAndFinish) và vài
// loại ảnh khách tự tải lên (bucket "outfit-swap-uploads") mới thật sự nằm trong Supabase Storage, cần
// xoá file khi xoá bản ghi lịch sử để không tích rác dung lượng (đúng tinh thần theo dõi quota Supabase
// đã thống nhất, sau sự cố khoá tài khoản 2026-10-10).
const KNOWN_BUCKETS = ["videos", "outfit-swap-uploads"];

async function deleteStorageFileFromUrl(supabase: ReturnType<typeof getSupabaseAdmin>, url: string): Promise<void> {
  for (const bucket of KNOWN_BUCKETS) {
    const match = url.match(new RegExp(`/${bucket}/(.+)$`));
    if (match) {
      await supabase.storage.from(bucket).remove([decodeURIComponent(match[1])]);
      return;
    }
  }
  // Không khớp bucket nào đã biết -- URL ngoài (Fal CDN...), không có gì để xoá trong Storage của mình.
}

// Xoá 1 mục lịch sử (ảnh/video) — xoá CẢ file thật trong Storage (nếu có, best-effort — lỗi xoá storage
// không chặn xoá bản ghi DB, file có thể đã mất/hỏng từ trước) LẪN bản ghi DB. Chỉ cho xoá đúng chủ.
export async function deleteGenerationHistoryItem(userId: string, id: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase.from("generation_history").select("output_url").eq("id", id).eq("user_id", userId).single();
  if (!row) throw new Error("Không tìm thấy mục này");
  await deleteStorageFileFromUrl(supabase, row.output_url).catch(() => {});
  const { error } = await supabase.from("generation_history").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Xoá TOÀN BỘ nội dung (ảnh/video) đã gắn vào 1 dự án — dùng khi khách chọn "Xoá cả nội dung bên trong"
// lúc xoá dự án (nguy hiểm, vĩnh viễn — xác nhận rõ ở client trước khi gọi). Gọi TRƯỚC khi xoá dòng
// content_projects (project_id vẫn còn hợp lệ lúc lọc).
export async function deleteGenerationHistoryByProject(userId: string, projectId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: rows } = await supabase
    .from("generation_history")
    .select("id, output_url")
    .eq("user_id", userId)
    .eq("project_id", projectId);
  for (const row of rows ?? []) {
    await deleteStorageFileFromUrl(supabase, row.output_url).catch(() => {});
  }
  await supabase.from("generation_history").delete().eq("user_id", userId).eq("project_id", projectId);
}
