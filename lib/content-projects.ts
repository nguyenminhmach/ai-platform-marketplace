import { getSupabaseAdmin } from "@/lib/supabase";

// "Dự án" ở panel nhanh "Không gian cho mọi ý tưởng" (app/video-tu-y-tuong) — gom ảnh/video khách tạo
// theo từng dự án đặt tên riêng, khác hẳn khái niệm "story_video_projects" (dự án video nhiều chương,
// xem lib/story-video-projects.ts) — hai thứ không liên quan tới nhau dù tên gần giống.
export type ContentProject = {
  id: number;
  name: string;
  isPrivate: boolean;
  createdAt: string;
};

export async function listContentProjects(userId: string): Promise<ContentProject[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("content_projects")
    .select("id, name, is_private, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: row.id, name: row.name, isPrivate: row.is_private, createdAt: row.created_at }));
}

export async function createContentProject(userId: string, name: string, isPrivate: boolean): Promise<ContentProject> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Thiếu tên dự án");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("content_projects")
    .insert({ user_id: userId, name: trimmed, is_private: isPrivate })
    .select("id, name, is_private, created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Không tạo được dự án");
  return { id: data.id, name: data.name, isPrivate: data.is_private, createdAt: data.created_at };
}

// SỬA (phản hồi thật user: menu 3 chấm cạnh tên dự án — chỉ làm đúng 2 mục thật sự cần: "Biên tập" đổi
// tên + "Xóa bỏ") — kiểm tra user_id khớp TRƯỚC khi sửa/xoá, không tin id client gửi lên là đủ.
export async function renameContentProject(userId: string, id: number, name: string): Promise<ContentProject> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Thiếu tên dự án");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("content_projects")
    .update({ name: trimmed })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id, name, is_private, created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Không tìm thấy dự án");
  return { id: data.id, name: data.name, isPrivate: data.is_private, createdAt: data.created_at };
}

// Xoá dự án — nội dung đã gắn (generation_history/prompt_image_jobs/story_video_jobs.project_id) KHÔNG
// bị xoá theo, tự rơi về project_id=null (migration đã khai "on delete set null") — khách mất nhãn gom
// nhóm, không mất ảnh/video đã tạo.
export async function deleteContentProject(userId: string, id: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error, count } = await supabase.from("content_projects").delete({ count: "exact" }).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
  if (!count) throw new Error("Không tìm thấy dự án");
}
