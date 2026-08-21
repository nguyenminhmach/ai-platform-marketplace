import { applyImageStageResult, applyVideoStageResult } from "@/lib/story-video";

// Fal.ai gọi vào đây 1 lần/cảnh cho bước tạo ảnh và 1 lần/cảnh cho bước tạo video — phân biệt bằng
// query param sceneId (id hàng trong story_video_scenes) và stage (image/video). Bước ghép video
// cuối (ffmpeg) chạy ngay trong request này khi cảnh cuối cùng xong video, nên cần thời gian chờ dài
// hơn mặc định.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    const sceneId = searchParams.get("sceneId");
    const stage = searchParams.get("stage");

    if (!jobId || !sceneId || (stage !== "image" && stage !== "video")) {
      return Response.json({ error: "Thiếu hoặc sai jobId/sceneId/stage" }, { status: 400 });
    }

    const payload = await req.json();

    if (stage === "image") {
      await applyImageStageResult(Number(jobId), Number(sceneId), payload);
    } else {
      await applyVideoStageResult(Number(jobId), Number(sceneId), payload);
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error("[story-video-webhook] Unhandled error:", err);
    // Vẫn trả 200 để tránh Fal.ai retry gây xử lý trùng — lỗi đã log lại để debug
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
