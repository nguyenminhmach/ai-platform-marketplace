import { resolvePromptImageJob } from "@/lib/prompt-image";

// GET /api/prompt-image/status?jobId=... — frontend poll định kỳ cho tới khi status done/failed.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    return Response.json({ error: "Thiếu jobId" }, { status: 400 });
  }

  const result = await resolvePromptImageJob(Number(jobId));
  if (result.status === "not_found") {
    return Response.json({ error: "Không tìm thấy job" }, { status: 404 });
  }

  return Response.json(result);
}
