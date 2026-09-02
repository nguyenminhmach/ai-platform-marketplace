import { getSupabaseAdmin } from "@/lib/supabase";

// Đọc lời thoại tiếng Việt thành giọng nói qua ElevenLabs — dùng cho pipeline "Video đồng nhất
// nhân vật" và "Video từ ý tưởng truyện" (bước TTS -> Lip-sync). eleven_multilingual_v2 hỗ trợ
// tiếng Việt, nhưng giọng gốc tiếng Anh (Rachel/Josh/Domi/Antoni, dùng trước đây) phát âm tiếng Việt
// nghe lơ lớ như pha tiếng Anh — đã đổi sang giọng tiếng Việt thật do admin tự chọn/thêm vào tài
// khoản ElevenLabs (Voice Library, lọc Language: Vietnamese), luân phiên nữ/nam theo vị trí nhân vật.
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

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: normalizedText,
      model_id: "eleven_multilingual_v2",
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
