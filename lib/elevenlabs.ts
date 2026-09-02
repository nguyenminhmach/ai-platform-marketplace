import { getSupabaseAdmin } from "@/lib/supabase";

// Đọc lời thoại tiếng Việt thành giọng nói qua ElevenLabs — dùng cho pipeline "Video đồng nhất
// nhân vật" và "Video từ ý tưởng truyện" (bước TTS -> Lip-sync). Giọng tiếng Việt thật do admin tự
// chọn/thêm vào tài khoản ElevenLabs (Voice Library, lọc Language: Vietnamese), luân phiên nữ/nam
// theo vị trí nhân vật — xem thêm ghi chú model_id ở generateVietnameseSpeech() bên dưới (gốc rễ thật
// của mọi lần phát âm lơ lớ suốt từ đầu KHÔNG phải do chọn giọng sai).
export const CHARACTER_VOICE_IDS = [
  "f5q6kePPoQAjCPYG6moa", // giọng nữ tiếng Việt
  "ekOUbc6LmXiQZnLcHOoL", // giọng nam tiếng Việt
];

export async function generateVietnameseSpeech(
  text: string,
  voiceId: string,
  jobId: number,
  characterId: number,
  // Namespace theo app gọi hàm — dialogue-video.ts và story-video.ts dùng 2 bảng job/character khác
  // nhau (id tự tăng ĐỘC LẬP mỗi bảng), nên jobId+characterId có thể trùng số giữa 2 app dù không liên
  // quan gì nhau. Không truyền namespace riêng thì 2 app ghi đè lẫn audio của nhau qua cùng 1 path
  // "dialogue-video/{jobId}-{characterId}.mp3" (đã xảy ra thật, gây tiếng lồng sai/lẫn tiếng người khác).
  namespace: "dialogue-video" | "story-video" = "dialogue-video"
): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình ELEVENLABS_API_KEY trong .env.local");

  // Chuẩn hoá NFC bắt buộc: nếu text tiếng Việt tới tay hàm này ở dạng NFD (dấu rời — vd "ế" lưu
  // thành "e" + dấu mũ + dấu sắc riêng biệt, thường gặp khi text đi qua 1 số nguồn/model trung gian),
  // ElevenLabs đọc sai/lộn thanh điệu dù phụ âm-nguyên âm vẫn đúng (đã xác nhận qua thực tế: giọng rõ
  // nhưng "không biết tiếng nước nào" — đúng triệu chứng thanh điệu bị vỡ, không phải lỗi chọn giọng).
  const normalizedText = text.normalize("NFC");

  // model_id: đây là gốc rễ thật của toàn bộ chuỗi report "lơ lớ" từ đầu tới giờ — đã tra lại tài liệu
  // ElevenLabs hiện tại (docs/models) và xác nhận "eleven_multilingual_v2" KHÔNG hỗ trợ tiếng Việt
  // chính thức (danh sách 29 ngôn ngữ của model này không có tiếng Việt) dù comment cũ trong file này
  // từng ghi nhầm là có hỗ trợ. Chỉ "eleven_flash_v2_5" (và bản cũ đã deprecated turbo_v2_5) mới chính
  // thức hỗ trợ tiếng Việt (32 ngôn ngữ = 29 của multilingual_v2 + Hungarian/Norwegian/Vietnamese) — vì
  // vậy đổi giọng bao nhiêu lần cũng không hết lơ lớ, do model xử lý text chưa từng được huấn luyện cho
  // tiếng Việt. Đổi hẳn sang eleven_flash_v2_5.
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: normalizedText,
      model_id: "eleven_flash_v2_5",
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown ElevenLabs error");
    throw new Error(`ElevenLabs lỗi: ${res.status} ${errText}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());

  const supabase = getSupabaseAdmin();
  const filePath = `${namespace}/${jobId}-${characterId}.mp3`;
  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(filePath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
  if (uploadError) throw new Error(`Lỗi lưu audio: ${uploadError.message}`);

  const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
  return publicUrlData.publicUrl;
}
