import { applyVideoStageResult, applyLipsyncStageResult } from "@/lib/dialogue-video";

// Fal.ai gọi vào đây 2 lần cho bước video-gen (1 lần/nhân vật) và 2 lần cho bước lipsync
// (1 lần/nhân vật) — phân biệt bằng query param speaker (a/b) và stage (video/lipsync).
// Bước ghép video cuối (ffmpeg) chạy ngay trong request này khi cả 2 nhân vật đã xong lipsync,
// nên cần thời gian chờ dài hơn mặc định.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    const speaker = searchParams.get("speaker");
    const stage = searchParams.get("stage");

    if (!jobId || (speaker !== "a" && speaker !== "b") || (stage !== "video" && stage !== "lipsync")) {
      return Response.json({ error: "Thiếu hoặc sai jobId/speaker/stage" }, { status: 400 });
    }

    const payload = await req.json();

    if (stage === "video") {
      await applyVideoStageResult(Number(jobId), speaker, payload);
    } else {
      await applyLipsyncStageResult(Number(jobId), speaker, payload);
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error("[dialogue-video-webhook] Unhandled error:", err);
    // Vẫn trả 200 để tránh Fal.ai retry gây xử lý trùng — lỗi đã log lại để debug
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
