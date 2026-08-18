import { getSupabaseAdmin } from "@/lib/supabase";
import { callOpenRouter } from "@/lib/ai-router";

const MODEL = "google/gemini-3-flash-preview";

// Hướng dẫn mặc định khi admin chưa tự soạn — rút gọn từ skill video-motion-prompt (giữ nguyên
// danh tính/trang phục/bối cảnh, camera đứng yên, chỉ 1 chuyển động nhỏ tự nhiên theo đúng ý khách).
const DEFAULT_PROMPT_HELPER_INSTRUCTIONS = `Bạn là chuyên gia viết motion prompt tiếng Anh cho công cụ image-to-video (Kling). Khách cung cấp 1 ảnh nhân vật (có thể không có) + 1 gợi ý ngắn bằng tiếng Việt mô tả chuyển động họ muốn. Nhiệm vụ: nhìn kỹ ảnh (nếu có), kết hợp gợi ý của khách, viết ra ĐÚNG 1 câu prompt tiếng Anh hoàn chỉnh để dùng trực tiếp cho Kling.

Nguyên tắc bắt buộc:
- Giữ nguyên tuyệt đối danh tính nhân vật (khuôn mặt, kiểu tóc, trang phục, phụ kiện), môi trường, ánh sáng, góc máy như trong ảnh gốc — không bịa thêm người/vật/chi tiết không có trong ảnh.
- Camera đứng yên tuyệt đối, không zoom/pan/tilt/dolly.
- Chỉ mô tả 1 chuyển động chính, nhỏ và tự nhiên (như người thật đứng trước máy quay), đúng theo ý khách gợi ý — nếu gợi ý mơ hồ hoặc không có ảnh, chọn chuyển động tự nhiên hợp lý nhất.
- Văn phong: photorealistic, natural motion, cinematic quality, 4K, HDR.
- Chỉ trả về ĐÚNG 1 câu prompt tiếng Anh, không thêm giải thích, không thêm tiêu đề, không xuống dòng, không dùng dấu ngoặc kép bao quanh.`;

const MAX_HINT_LENGTH = 300;
const MAX_IMAGE_DATA_URL_LENGTH = 6_000_000; // ~4.5MB ảnh gốc sau base64

export async function POST(req: Request) {
  const { miniAppId, hint, imageDataUrl } = await req.json();

  if (typeof miniAppId !== "string" || !miniAppId) {
    return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  }
  if (typeof hint !== "string" || !hint.trim()) {
    return Response.json({ error: "Nhập gợi ý trước đã" }, { status: 400 });
  }
  if (hint.length > MAX_HINT_LENGTH) {
    return Response.json({ error: `Gợi ý tối đa ${MAX_HINT_LENGTH} ký tự` }, { status: 400 });
  }
  if (imageDataUrl !== undefined && (typeof imageDataUrl !== "string" || imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH)) {
    return Response.json({ error: "Ảnh không hợp lệ" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mini_apps").select("model_config").eq("id", miniAppId).single();
  const instructions =
    (data?.model_config as { prompt_helper_instructions?: string } | null)?.prompt_helper_instructions ||
    DEFAULT_PROMPT_HELPER_INSTRUCTIONS;

  try {
    const { output } = await callOpenRouter(MODEL, 200, instructions, hint.trim(), imageDataUrl || undefined);
    return Response.json({ prompt: output.trim() });
  } catch {
    return Response.json({ error: "Không tạo được prompt, thử lại sau" }, { status: 502 });
  }
}
