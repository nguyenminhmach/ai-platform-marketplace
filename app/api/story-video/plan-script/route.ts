import { getSupabaseAdmin } from "@/lib/supabase";
import { generateStoryScript, generateStoryScriptMulti, planStoryVideoScenes, planStoryVideoScenesMulti, MAX_SCENES } from "@/lib/story-video";
import type { VideoModelEntry } from "@/lib/story-video";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";

// Bước "Tạo kịch bản" — luồng MỚI (xem ghi nhớ project_story_video_scene_duration_architecture), ĐÃ
// nối vào luồng submit thật qua app/api/story-video/submit/route.ts (field preplannedActions/
// preplannedActionsMulti). "characterLabels" (>=2 phần tử) chuyển route sang nhánh nhiều nhân vật —
// không hỗ trợ requestedSceneCount (không merge cảnh, xem planStoryVideoScenesMulti).
export async function POST(req: Request) {
  const { storyDescription, miniAppId, videoModelKey, requestedSceneCount, modelChatKey, characterLabels } = await req.json();

  if (typeof storyDescription !== "string" || !storyDescription.trim()) {
    return Response.json({ error: "Thiếu storyDescription" }, { status: 400 });
  }
  if (typeof miniAppId !== "string" || !miniAppId) {
    return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  }
  if (
    requestedSceneCount !== undefined &&
    (typeof requestedSceneCount !== "number" || requestedSceneCount < 1 || requestedSceneCount > MAX_SCENES)
  ) {
    return Response.json({ error: `requestedSceneCount phải từ 1 đến ${MAX_SCENES}` }, { status: 400 });
  }
  const isMulti = Array.isArray(characterLabels) && characterLabels.length >= 2;
  if (isMulti && !characterLabels.every((l: unknown) => typeof l === "string" && l.trim())) {
    return Response.json({ error: "characterLabels không hợp lệ" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("mini_apps").select("model_config").eq("id", miniAppId).single();
  if (error || !data) return Response.json({ error: "Không tìm thấy Mini App" }, { status: 404 });

  const config = data.model_config as { video_models?: VideoModelEntry[] } | null;
  const videoModels = (config?.video_models ?? []).filter((m) => m.enabled);
  const videoEntry = videoModels.find((m) => m.key === videoModelKey) ?? videoModels[0];
  if (!videoEntry) return Response.json({ error: "Không có model video nào đang bật" }, { status: 400 });

  try {
    const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
    if (isMulti) {
      const actions = await generateStoryScriptMulti(
        storyDescription.trim(),
        characterLabels,
        typeof modelChatKey === "string" ? modelChatKey : undefined,
        miniAppId
      );
      const plan = planStoryVideoScenesMulti(actions, videoEntry);
      const videoCreditCost = computeDynamicCreditCost(plan.totalVideoProviderCostVnd, marginPercent, vndPerCredit);
      return Response.json({
        actions,
        scenes: plan.scenes,
        totalNaturalSeconds: plan.totalNaturalSeconds,
        totalVideoProviderCostVnd: plan.totalVideoProviderCostVnd,
        videoCreditCost,
        videoModel: { key: videoEntry.key, label: videoEntry.label, duration_price_vnd: videoEntry.duration_price_vnd },
      });
    }
    const actions = await generateStoryScript(storyDescription.trim(), typeof modelChatKey === "string" ? modelChatKey : undefined, miniAppId);
    const plan = planStoryVideoScenes(actions, videoEntry, typeof requestedSceneCount === "number" ? requestedSceneCount : undefined);
    const videoCreditCost = computeDynamicCreditCost(plan.totalVideoProviderCostVnd, marginPercent, vndPerCredit);
    return Response.json({
      actions,
      scenes: plan.scenes,
      totalNaturalSeconds: plan.totalNaturalSeconds,
      totalVideoProviderCostVnd: plan.totalVideoProviderCostVnd,
      videoCreditCost,
      videoModel: { key: videoEntry.key, label: videoEntry.label, duration_price_vnd: videoEntry.duration_price_vnd },
    });
  } catch (err) {
    console.error("[plan-script] Lỗi:", err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
