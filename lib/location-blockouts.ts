import { getSupabaseAdmin } from "@/lib/supabase";

// Lưu lại kết quả "Dựng khối 3D" (depth + ground mask + phân loại cảnh) xuống DB, keyed theo
// (user_id, image_url) — SỬA (phản hồi thật user: "khi tạo hình xong restart máy thì hình đã tạo bị
// mất") — trước đây chỉ lưu trong React state (RAM trình duyệt), mất khi tải lại trang/khởi động lại
// máy, phải gọi lại AI từ đầu (tốn thêm tiền). Giờ lưu DB, bấm "Dựng khối 3D" lại cho cùng ảnh sẽ trả
// về NGAY kết quả cũ (không gọi lại AI) — xem route POST /api/story-video/location-blockout.
export type LocationBlockoutRow = {
  imageUrl: string;
  depthImageUrl: string | null;
  groundMaskUrl: string | null;
  isNaturalTerrain: boolean;
};

export async function getLocationBlockout(userId: string, imageUrl: string): Promise<LocationBlockoutRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("location_blockouts")
    .select("image_url, depth_image_url, ground_mask_url, is_natural_terrain")
    .eq("user_id", userId)
    .eq("image_url", imageUrl)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    imageUrl: data.image_url,
    depthImageUrl: data.depth_image_url,
    groundMaskUrl: data.ground_mask_url,
    isNaturalTerrain: data.is_natural_terrain,
  };
}

export async function saveLocationBlockout(userId: string, row: LocationBlockoutRow): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("location_blockouts").upsert(
    {
      user_id: userId,
      image_url: row.imageUrl,
      depth_image_url: row.depthImageUrl,
      ground_mask_url: row.groundMaskUrl,
      is_natural_terrain: row.isNaturalTerrain,
    },
    { onConflict: "user_id,image_url" }
  );
  if (error) throw new Error(error.message);
}
