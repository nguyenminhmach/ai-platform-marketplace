import { applyCharacterStageResult, applyImageStageResult, applyVideoStageResult } from "@/lib/story-video";

// Fal.ai gọi vào đây: 1 lần/job cho bước tạo Character (không có sceneId), 1 lần/cảnh cho bước tạo
// ảnh và 1 lần/cảnh cho bước tạo video — phân biệt bằng query param sceneId (id hàng trong
// story_video_scenes, bỏ trống với stage=character) và stage (character/image/video). Bước ghép video
// cuối (ffmpeg) chạy ngay trong request này khi cảnh cuối cùng xong video, nên cần thời gian chờ dài
// hơn mặc định.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    const sceneId = searchParams.get("sceneId");
    const stage = searchParams.get("stage");
    const isRegenerate = searchParams.get("regen") === "1";
    const characterPositionRaw = searchParams.get("characterPosition");
    const characterPosition = characterPositionRaw !== null ? Number(characterPositionRaw) : undefined;

    if (!jobId || (stage !== "character" && stage !== "image" && stage !== "video")) {
      return Response.json({ error: "Thiếu hoặc sai jobId/stage" }, { status: 400 });
    }
    if (stage !== "character" && !sceneId) {
      return Response.json({ error: "Thiếu sceneId" }, { status: 400 });
    }

    const payload = await req.json();

    if (stage === "character") {
      await applyCharacterStageResult(Number(jobId), payload, characterPosition);
    } else if (stage === "image") {
      await applyImageStageResult(Number(jobId), Number(sceneId), payload, isRegenerate);
    } else {
      await applyVideoStageResult(Number(jobId), Number(sceneId), payload, isRegenerate);
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error("[story-video-webhook] Unhandled error:", err);
    // Vẫn trả 200 để tránh Fal.ai retry gây xử lý trùng — lỗi đã log lại để debug
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
