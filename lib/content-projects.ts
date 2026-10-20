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
