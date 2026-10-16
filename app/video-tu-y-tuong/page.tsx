import { getSupabaseAdmin } from "@/lib/supabase";
import VideoTuYTuongClient, { type StoryModel, type VideoTuYTuongClientProps } from "./VideoTuYTuongClient";

// Server Component (KHÔNG "use client") — fetch danh sách model ảnh/video NGAY TRÊN SERVER trước khi
// gửi trang về trình duyệt, thay vì để VideoTuYTuongClient tự fetch "/api/story-video/models" sau khi
// mount (như trước đây). Lý do: khách phản ánh lúc trang vừa mở hiện tạm chữ "model" (placeholder,
// vì danh sách rỗng) rồi 1 lúc sau mới "nhảy" sang tên model thật khi fetch client-side xong — độ trễ
// round-trip mạng không thể tránh nếu fetch ở client. Fetch ở server loại bỏ hẳn khoảng "nhấp nháy" đó:
// trang gửi xuống trình duyệt đã có sẵn dữ liệu, hiện đúng tên model ngay từ lần vẽ đầu tiên.
//
// Logic lọc model/field trả về giữ Y HỆT app/api/story-video/models/route.ts (route đó vẫn giữ nguyên,
// không xoá — các chỗ khác trong code có thể còn gọi lại route này, vd khi đổi lại promptMediaTab).
const MINI_APP_ID = "video-tu-y-tuong";

// BẮT BUỘC render động (SSR mỗi request) — nếu không, Next.js sẽ prerender trang này 1 LẦN DUY NHẤT
// lúc build và "đóng băng" model_config đọc được lúc đó, khiến admin đổi model/giá ở /admin sau này
// không bao giờ phản ánh lên trang cho tới lần deploy kế tiếp. Trước đây (fetch ở client) không có vấn
// đề này vì mỗi lần mở trang trình duyệt luôn tự gọi API mới.
export const dynamic = "force-dynamic";

export default async function VideoTuYTuongPage() {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mini_apps").select("model_config").eq("id", MINI_APP_ID).single();

  const config = data?.model_config as
    | {
        image_models?: StoryModel[];
        video_models?: StoryModel[];
        genre_thumbnails?: Record<string, string>;
        enable_speed_slider?: boolean;
      }
    | null
    | undefined;

  const initialImageModels = (config?.image_models ?? []).filter((m) => (m as unknown as { enabled?: boolean }).enabled);
  const initialVideoModels = (config?.video_models ?? []).filter((m) => (m as unknown as { enabled?: boolean }).enabled);

  const firstImage = initialImageModels[0];
  const firstVideo = initialVideoModels[0];

  const props: VideoTuYTuongClientProps = {
    initialImageModels,
    initialVideoModels,
    initialImageModelKey: firstImage?.key ?? null,
    initialVideoModelKey: firstVideo?.key ?? null,
    initialResolutionKey: firstImage?.resolution_price_vnd ? Object.keys(firstImage.resolution_price_vnd)[0] : null,
    initialDurationKey: firstVideo?.duration_price_vnd ? Object.keys(firstVideo.duration_price_vnd)[0] : null,
    initialGenreThumbnails: config?.genre_thumbnails ?? {},
    initialEnableSpeedSlider: config?.enable_speed_slider === true,
  };

  return <VideoTuYTuongClient {...props} />;
}
