import { applyVideoStageResult, applyLipsyncStageResult } from "@/lib/dialogue-video";

// Fal.ai gọi vào đây 1 lần/nhân vật cho bước video-gen và 1 lần/nhân vật cho bước lipsync —
// phân biệt bằng query param characterId (id hàng trong dialogue_video_characters) và stage
// (video/lipsync). Bước ghép video cuối (ffmpeg) chạy ngay trong request này khi nhân vật cuối
// cùng xong lipsync, nên cần thời gian chờ dài hơn mặc định.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    const characterId = searchParams.get("characterId");
    const stage = searchParams.get("stage");

    if (!jobId || !characterId || (stage !== "video" && stage !== "lipsync")) {
      return Response.json({ error: "Thiếu hoặc sai jobId/characterId/stage" }, { status: 400 });
    }

    const payload = await req.json();

    if (stage === "video") {
      await applyVideoStageResult(Number(jobId), Number(characterId), payload);
    } else {
      await applyLipsyncStageResult(Number(jobId), Number(characterId), payload);
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error("[dialogue-video-webhook] Unhandled error:", err);
    // Vẫn trả 200 để tránh Fal.ai retry gây xử lý trùng — lỗi đã log lại để debug
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
