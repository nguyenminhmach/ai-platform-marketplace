import { getSupabaseAdmin } from "@/lib/supabase";

// Đọc lời thoại tiếng Việt thành giọng nói qua ElevenLabs — dùng cho pipeline "Video đồng nhất
// nhân vật" và "Video từ ý tưởng truyện" (bước TTS -> Lip-sync). eleven_multilingual_v2 hỗ trợ
// tiếng Việt, nhưng giọng gốc tiếng Anh (Rachel/Josh/Domi/Antoni, dùng trước đây) phát âm tiếng Việt
// nghe lơ lớ như pha tiếng Anh — đã đổi sang giọng tiếng Việt thật do admin tự chọn/thêm vào tài
// khoản ElevenLabs (Voice Library, lọc Language: Vietnamese), luân phiên nữ/nam theo vị trí nhân vật.
export const CHARACTER_VOICE_IDS = [
  "HAAKLJlaJeGl18MKHYeg", // giọng nữ tiếng Việt
  "6adFm46eyy74snVn6YrT", // giọng nam tiếng Việt
];

export async function generateVietnameseSpeech(
  text: string,
  voiceId: string,
  jobId: number,
  characterId: number
): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình ELEVENLABS_API_KEY trong .env.local");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown ElevenLabs error");
    throw new Error(`ElevenLabs lỗi: ${res.status} ${errText}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());

  const supabase = getSupabaseAdmin();
  const filePath = `dialogue-video/${jobId}-${characterId}.mp3`;
  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(filePath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
  if (uploadError) throw new Error(`Lỗi lưu audio: ${uploadError.message}`);

  const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
  return publicUrlData.publicUrl;
}
