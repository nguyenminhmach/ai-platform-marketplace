import { execFile } from "child_process";
import { promisify } from "util";
import { chmodSync } from "fs";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { getSupabaseAdmin } from "@/lib/supabase";

const execFileAsync = promisify(execFile);

// Kling LipSync từ chối audio dưới 2s ("Audio duration is too short. Minimum is 2 seconds.") — xảy ra
// thật với câu thoại rất ngắn, khiến cả cảnh rơi về fallback video câm dù lời thoại đã trích đúng (xem
// ghi nhớ project_story_video_scene_duration_architecture). Đệm thêm khoảng lặng vào cuối bằng ffmpeg
// "apad=whole_dur=X" (chỉ đệm khi audio NGẮN HƠN X giây — audio đã đủ dài thì bộ lọc này không đổi gì)
// trước khi upload — không đổi nội dung giọng đọc, chỉ tránh lỗi kỹ thuật do audio quá ngắn. targetDurationSeconds
// mặc định 2.2s (đủ dư so với ngưỡng cứng 2.0s của Kling) khi không truyền — dùng cho dialogue-video (video
// luôn ngắn, không cần khớp thêm). story-video truyền đúng độ dài THẬT của video cảnh (xem
// generateVietnameseSpeech) — nếu chỉ đệm cố định 2.2s trong khi video cảnh dài hơn nhiều (vd 6s/8s), audio
// kết thúc sớm hơn hẳn video khiến Kling LipSync không có tín hiệu im lặng cho đoạn đuôi, miệng nhân vật vẫn
// tiếp tục "mấp máy" dù lời thoại đã hết (báo cáo thật). Lỗi ffmpeg (nếu có) không được làm hỏng cả lượt tạo
// giọng — rơi về dùng nguyên audio gốc chưa đệm, vẫn tốt hơn là chặn hẳn không tạo được giọng nói.
async function padAudioIfTooShort(audioBuffer: Buffer, targetDurationSeconds = 2.2): Promise<Buffer> {
  if (!ffmpegPath) return audioBuffer;
  try {
    chmodSync(ffmpegPath, 0o755);
  } catch {}
  const workDir = await mkdtemp(path.join(tmpdir(), "elevenlabs-pad-"));
  try {
    const inputPath = path.join(workDir, "input.mp3");
    const outputPath = path.join(workDir, "output.mp3");
    await writeFile(inputPath, audioBuffer);
    await execFileAsync(ffmpegPath, ["-i", inputPath, "-af", `apad=whole_dur=${targetDurationSeconds}`, "-y", outputPath]);
    return await readFile(outputPath);
  } catch {
    return audioBuffer;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

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
  namespace: "dialogue-video" | "story-video" = "dialogue-video",
  // Độ dài THẬT (giây) của video cảnh sẽ ghép giọng này vào — chỉ story-video truyền vào (xem chú thích
  // padAudioIfTooShort). Không truyền -> giữ hành vi cũ (đệm cố định 2.2s).
  videoDurationSeconds?: number
): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình ELEVENLABS_API_KEY trong .env.local");

  // Chuẩn hoá NFC bắt buộc: nếu text tiếng Việt tới tay hàm này ở dạng NFD (dấu rời — vd "ế" lưu
  // thành "e" + dấu mũ + dấu sắc riêng biệt, thường gặp khi text đi qua 1 số nguồn/model trung gian),
  // ElevenLabs đọc sai/lộn thanh điệu dù phụ âm-nguyên âm vẫn đúng (đã xác nhận qua thực tế: giọng rõ
  // nhưng "không biết tiếng nước nào" — đúng triệu chứng thanh điệu bị vỡ, không phải lỗi chọn giọng).
  const normalizedText = text.normalize("NFC");

  // Câu thoại ngắn (<=6 từ, vd "Thật là tuyệt vời!") đọc ở tốc độ mặc định thường ra audio dưới 2.2s --
  // padAudioIfTooShort() phải đệm THÊM khoảng lặng dài ở cuối để qua ngưỡng cứng 2s của Kling LipSync,
  // và khoảng lặng chiếm tỉ trọng lớn bất thường trong clip ngắn bị nghi là nguyên nhân khiến miệng nhân
  // vật khớp trễ so với lời thoại (báo cáo thật: "nói trước, sau đó mới máy môi"). Đọc chậm hơn
  // (voice_settings.speed=0.7, mức chậm nhất ElevenLabs cho phép) kéo dài audio bằng giọng nói THẬT thay
  // vì im lặng giả -- giảm (hoặc xoá hẳn) phần phải đệm sau. Chỉ áp dụng cho câu ngắn, câu bình thường/dài
  // giữ nguyên tốc độ mặc định, không đổi hành vi.
  const wordCount = normalizedText.trim().split(/\s+/).filter(Boolean).length;
  const isShortLine = wordCount > 0 && wordCount <= 6;

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
      ...(isShortLine ? { voice_settings: { speed: 0.7 } } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown ElevenLabs error");
    throw new Error(`ElevenLabs lỗi: ${res.status} ${errText}`);
  }

  // Đệm khớp theo đúng độ dài video thật (nếu có) thay vì luôn cố định 2.2s — không bao giờ đệm NGẮN
  // hơn 2.2s (ngưỡng cứng Kling) dù videoDurationSeconds truyền vào nhỏ hơn.
  const padTargetSeconds = Math.max(2.2, videoDurationSeconds ?? 0);
  const audioBuffer = await padAudioIfTooShort(Buffer.from(await res.arrayBuffer()), padTargetSeconds);

  const supabase = getSupabaseAdmin();
  const filePath = `${namespace}/${jobId}-${characterId}.mp3`;
  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(filePath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
  if (uploadError) throw new Error(`Lỗi lưu audio: ${uploadError.message}`);

  const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
  return publicUrlData.publicUrl;
}
