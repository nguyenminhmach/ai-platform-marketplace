import { getSupabaseAdmin } from "@/lib/supabase";

// Đọc lời thoại tiếng Việt thành giọng nói qua ElevenLabs — dùng cho pipeline "Video đồng nhất
// nhân vật" (bước 2/3: Video model -> TTS -> Lip-sync). eleven_multilingual_v2 hỗ trợ tiếng Việt.
//
// Lưu ý: các voice ID bên dưới là giọng mặc định (Rachel/Josh/Domi/Antoni) của ElevenLabs — hãng
// thông báo các giọng "Default" này sẽ ngừng hoạt động từ 31/12/2026, cần đổi sang giọng khác
// trước mốc đó.
export const CHARACTER_VOICE_IDS = [
  "21m00Tcm4TlvDq8ikWAM", // Rachel (nữ)
  "TxGEqnHWrfWFTfGW9XjX", // Josh (nam)
  "AZnzlk1XvdvUeBnXmlld", // Domi (nữ)
  "ErXwobaYiN019PkySvjV", // Antoni (nam)
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
