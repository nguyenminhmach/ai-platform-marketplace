"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MINI_APPS } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth-context";
import { MannequinPreviewCard } from "@/components/MannequinPreviewCard";
import { LocationPositionStage3D } from "@/components/LocationPositionStage3D";
import { ReferencePickerModal } from "@/components/reference-elements/ReferencePickerModal";
import type { ReferenceElement } from "@/components/reference-elements/NewElementModal";
import { LightSphereModal, nearestLightQuickPosition, type LightSettings } from "@/components/story-video/LightSphereModal";
import { uploadImageDirect } from "@/lib/upload-direct";

// Trang riêng cho "Video từ ý tưởng" (story-video) — tách ra khỏi app/mini-app/[id]/page.tsx (file
// dùng chung cho mọi mini-app, đã quá lớn) để dễ chỉnh sửa/đọc hơn. Hành vi giữ NGUYÊN y hệt bản gốc
// (cùng API /api/story-video/*, cùng state, cùng JSX) — chỉ bỏ phần dùng chung cho 11 mini-app khác
// (video-gen, outfit-swap, dialogue-video, v.v.) không liên quan tới story-video.
const MINI_APP_ID = "video-tu-y-tuong";

// Kiểu model ảnh/video đọc từ mini_apps.model_config — tách ra module-level (trước đây khai báo bên
// trong component) để page.tsx (Server Component cha, xem app/video-tu-y-tuong/page.tsx) import được,
// dùng chung type khi fetch dữ liệu này NGAY TRÊN SERVER rồi truyền xuống làm initial props — tránh
// hiện chữ "model" placeholder rồi mới "nhảy" sang tên model thật sau khi fetch client-side xong (độ
// trễ round-trip mạng, khách phản ánh thấy bị giật khi trang vừa mở).
export type StoryModel = {
  key: string;
  provider: string;
  label: string;
  provider_cost_vnd: number;
  multi_image?: boolean;
  aspect_ratios?: string[];
  resolution_price_vnd?: Record<string, number>;
  duration_price_vnd?: Record<string, number>;
  model?: string;
};

export type VideoTuYTuongClientProps = {
  initialImageModels: StoryModel[];
  initialVideoModels: StoryModel[];
  initialImageModelKey: string | null;
  initialVideoModelKey: string | null;
  initialResolutionKey: string | null;
  initialDurationKey: string | null;
  initialGenreThumbnails: Record<string, string>;
  initialEnableSpeedSlider: boolean;
};

export default function VideoTuYTuongClient({
  initialImageModels,
  initialVideoModels,
  initialImageModelKey,
  initialVideoModelKey,
  initialResolutionKey,
  initialDurationKey,
  initialGenreThumbnails,
  initialEnableSpeedSlider,
}: VideoTuYTuongClientProps) {
  const app = MINI_APPS.find((item) => item.id === MINI_APP_ID);
  const { user, signOut } = useAuth();
  const router = useRouter();

  const [input, setInput] = useState("");
  // "Lịch sử" riêng của đúng app đang xem — lọc theo miniAppId, không lẫn kết quả app khác (khác với
  // trang /wallet vốn gộp chung lịch sử mọi app cho khách xem tổng quan toàn tài khoản).
  type HistoryItem = { id: number; outputType: string; outputUrl: string; createdAt: string };
  const [appHistory, setAppHistory] = useState<HistoryItem[]>([]);
  function loadAppHistory() {
    if (!user || !app) return;
    fetch(`/api/history?userId=${user.id}&miniAppId=${app.id}`)
      .then((res) => res.json())
      .then((data) => setAppHistory(data.items ?? []))
      .catch(() => {});
  }
  useEffect(loadAppHistory, [user, app?.id]);
  async function handleDeleteAppHistory(id: number) {
    if (!user) return;
    setAppHistory((items) => items.filter((item) => item.id !== id));
    await fetch(`/api/history/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    }).catch(() => {});
  }

  // Chia sẻ kết quả + đánh giá nhanh (👍/👎) — chỉ là tương tác phía client, không lưu server.
  const [shareCopied, setShareCopied] = useState(false);

  async function handleShareResult() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      setShareCopied(false);
    }
  }

  // "Video từ ý tưởng truyện": 1-3 ảnh nhân vật + mô tả truyện (dùng chung state `input`) + số phân
  // cảnh (2-8) + chọn model ảnh/video từ catalog nhiều nhà cung cấp — AI tự chia cảnh, không cho
  // khách tự viết từng cảnh.
  const STORY_MIN_SCENES = 1;
  const STORY_MAX_SCENES = 8;
  // Đúng cận trên MAX_STORY_CHARACTERS trong lib/story-video.ts (client component không import được
  // file server đó — sharp/child_process — nên khai lại hằng số ở đây).
  const STORY_MAX_CHARACTERS = 4;
  const [numScenes, setNumScenes] = useState(3);
  // "3 cảnh" là giá trị khởi tạo kỹ thuật (để price effect/submit luôn có số hợp lệ), KHÔNG phải lựa
  // chọn thật — chỉ hiện nút nào đó "sáng" sau khi AI đã gợi ý xong hoặc khách tự bấm chọn, tránh
  // khách tưởng nhầm "3 cảnh" là quyết định có sẵn.
  const [sceneCountChosen, setSceneCountChosen] = useState(false);
  // Bước "Tạo kịch bản" — thay thế ô chọn "số cảnh" + gợi ý AI cũ cho ĐÚNG luồng mặc định (1 nhân vật,
  // AI tự vẽ ảnh, không own-images). Agent tự liệt kê hành động + giây riêng từng cái, code nhóm thành
  // cảnh (mặc định 1 hành động = 1 cảnh) — xem lib/story-video.ts: generateStoryScript/planStoryVideoScenes.
  // Field chung cho cả 2 luồng (1 nhân vật / nhiều nhân vật) — "camera_view" chỉ có ở luồng 1 nhân vật,
  // "characters" chỉ có ở luồng nhiều nhân vật (ai xuất hiện trong cảnh); panel xem trước chỉ đọc field
  // chung (description/duration_key) nên dùng chung 1 type, không cần tách 2 state riêng.
  type StoryScriptAction = {
    description: string;
    location: string;
    end_pose: string;
    duration_seconds: number;
    camera_view?: string;
    // Agent (bước "Tạo kịch bản") đã tính sẵn 3 field này y hệt bước chia cảnh chính (xem
    // SceneSplitResult trong lib/story-video.ts) — trước đây type ở đây chưa khai báo nên dữ liệu bị bỏ
    // phí, giờ dùng để hiện preview 3D NGAY sau khi tạo kịch bản, không cần chờ submit job.
    shot_size?: string;
    camera_angle?: string;
    camera_movement?: string;
    light_direction?: string;
    camera_body?: string;
    lens?: string;
    aperture?: string;
    outfit_override?: string;
    face_view?: string;
    dialogue?: string | { speaker: number; line: string } | null;
    characters?: number[];
  };
  type StoryScriptScene = StoryScriptAction & { duration_key: string | null; provider_cost_vnd: number };
  // Video NHIỀU CHƯƠNG — mỗi chương là 1 lượt chạy đầy đủ của form (job riêng) ra 1 video ngắn; cuối cùng
  // "Kết thúc" ghép video các chương (xem lib/story-video-projects.ts). Chỉ giữ 1 form duy nhất: xong chương N
  // thì "chốt" gọn (mã job + video + ý tưởng) rồi reset form sang chương N+1 — luồng vốn tuần tự.
  type StoryProjectChapter = { chapterIndex: number; jobId: number; outputUrl: string; title: string };
  const STORY_MAX_CHAPTERS = 10; // đúng MAX_PROJECT_CHAPTERS ở lib/story-video-projects.ts
  const [storyMultiChapter, setStoryMultiChapter] = useState(false);
  const [storyProjectId, setStoryProjectId] = useState<number | null>(null);
  const [storyProjectChapters, setStoryProjectChapters] = useState<StoryProjectChapter[]>([]);
  const [storyActiveChapter, setStoryActiveChapter] = useState(0);
  const [storyLockedAspectRatio, setStoryLockedAspectRatio] = useState<string | null>(null);
  const [storyProjectFinalizing, setStoryProjectFinalizing] = useState(false);
  const [storyProjectFinalUrl, setStoryProjectFinalUrl] = useState<string | null>(null);
  // Kiểu chuyển cảnh (cắt cứng/hoà mờ) khách chọn riêng cho TỪNG điểm nối giữa 2 chương liên tiếp —
  // storyChapterTransitions[i] ứng với điểm nối Chương (i+1) → Chương (i+2). Không chọn gì thì mặc định
  // "cut" (giữ đúng hành vi cũ, xem finalize route). Reset khi bắt đầu dự án mới (handleNewProject).
  const [storyChapterTransitions, setStoryChapterTransitions] = useState<("cut" | "crossfade")[]>([]);
  const [storyProjectError, setStoryProjectError] = useState<string | null>(null);
  const [storyViewChapter, setStoryViewChapter] = useState<number | null>(null);
  const storyFormTopRef = useRef<HTMLDivElement | null>(null);
  const storyProjectFinalRef = useRef<HTMLDivElement | null>(null);
  const [storyScriptActions, setStoryScriptActions] = useState<StoryScriptAction[] | null>(null);
  const [storyScriptScenes, setStoryScriptScenes] = useState<StoryScriptScene[] | null>(null);
  const [storyScriptTotalSeconds, setStoryScriptTotalSeconds] = useState<number | null>(null);
  const [storyScriptVideoCreditCost, setStoryScriptVideoCreditCost] = useState<number | null>(null);
  const [storyScriptLoading, setStoryScriptLoading] = useState(false);
  const [storyScriptError, setStoryScriptError] = useState<string | null>(null);
  // Thanh trượt điều chỉnh tốc độ từng hành động — admin bật qua /admin (model_config.enable_speed_slider,
  // mặc định TẮT), đọc cờ này 1 lần lúc tải model. Khi bật: sau "Tạo kịch bản", hiện danh sách HÀNH ĐỘNG
  // GỐC (storyScriptActions, chưa gộp) kèm thanh trượt riêng từng cái thay vì hiện thẳng storyScriptScenes
  // (đã gộp) — khách chỉnh xong bấm "Hoàn thành" mới gọi lại plan-script để gộp/chốt giá lại.
  const [storyEnableSpeedSlider, setStoryEnableSpeedSlider] = useState(initialEnableSpeedSlider);
  const [storySpeedDrafts, setStorySpeedDrafts] = useState<Record<number, number>>({});
  const [storySpeedFinalized, setStorySpeedFinalized] = useState(false);
  const [storySpeedLoading, setStorySpeedLoading] = useState(false);
  const [storyCharacterImages, setStoryCharacterImages] = useState<string[]>([]);
  // Nhân vật #2, #3, #4 (nếu có) — nhân vật #1 vẫn dùng nguyên storyCharacterImages/
  // storySelectedSavedCharacterId ở trên, không đổi gì, để giữ đúng luồng 1-nhân-vật hiện có khi khách
  // không thêm ai — chỉ khi mảng này có phần tử mới coi là job nhiều nhân vật.
  const [storyExtraCharacters, setStoryExtraCharacters] = useState<
    { images: string[]; reuseId: number | null; label: string; itemImages: string[]; inputMode: "photo" | "text"; appearanceDescription: string }[]
  >([]);
  // Tên nhân vật #1 — chỉ cần điền khi có thêm nhân vật khác (job nhiều người), để Agent chia cảnh
  // khớp đúng tên trong Ý tưởng truyện (vd truyện viết "Lan ôm Mai" thì cần đúng tên "Lan" ở đây,
  // không phải để mặc định "Nhân vật 1" — Agent sẽ không biết "Lan" là ai nếu tên không khớp).
  const [storyPrimaryCharacterLabel, setStoryPrimaryCharacterLabel] = useState("");
  // Chế độ "Mô tả bằng chữ" — khách không có ảnh thật, để AI tự vẽ hẳn nhân vật từ mô tả này thay vì
  // tải ảnh. CHỈ áp dụng khi đúng 1 nhân vật (storyExtraCharacters rỗng) — xem
  // buildCharacterSheetTextPrompt() ở lib/story-video.ts.
  const [storyCharacterInputMode, setStoryCharacterInputMode] = useState<"photo" | "text">("photo");
  const [storyCharacterAppearanceDescription, setStoryCharacterAppearanceDescription] = useState("");
  // Ảnh THẬT của 1 địa điểm (sân vườn, nhà, cửa hàng...) — tuỳ chọn, dùng chung cho cả job, để ảnh
  // phân cảnh AI vẽ diễn ra đúng tại khung cảnh thật đó thay vì AI tự bịa bối cảnh.
  const [storyLocationReference, setStoryLocationReference] = useState<string | null>(null);
  // Vị trí đứng chính xác trong ảnh Bối cảnh (mask trắng/đen do khách khoanh vùng) — tuỳ chọn, chỉ có
  // tác dụng khi model ảnh đang chọn là GPT Image 2 Edit (model duy nhất hỗ trợ mask_url thật sự, xem
  // buildImageRequestBody trong lib/story-video.ts). storyLocationMaskRect là vùng khách đang
  // chọn/đã chọn (toạ độ chuẩn hoá 0..1 theo ảnh gốc); storyLocationReferenceMaskUrl là ảnh mask
  // đen/trắng đã sinh ra từ vùng đó (data URL trước khi upload, URL thật sau khi khôi phục job cũ).
  const [storyLocationReferenceMaskUrl, setStoryLocationReferenceMaskUrl] = useState<string | null>(null);
  const [storyLocationMaskRect, setStoryLocationMaskRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [storyLocationMaskEditorOpen, setStoryLocationMaskEditorOpen] = useState(false);
  const [storyLocationImageNaturalSize, setStoryLocationImageNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const storyLocationMaskDragStartRef = useRef<{ x: number; y: number } | null>(null);
  // NHIỀU nhân vật, NHIỀU vị trí trong CÙNG 1 ảnh Bối cảnh — mỗi phần tử gán 1 vùng cho đúng 1 nhân
  // vật (characterPosition khớp story_video_job_characters.position). storyLocationReferenceMaskUrl
  // vẫn là ẢNH MASK DUY NHẤT (gộp mọi vùng trắng lại) — mảng này chỉ để biết vùng nào của ai, dùng
  // sinh mask tổng hợp + gửi lên server viết chỉ dẫn văn bản (xem lib/story-video.ts:
  // describeMaskZonePosition). Chỉ có ý nghĩa khi có từ 2 nhân vật trở lên (storyExtraCharacters.length>0).
  const [storyLocationMaskAssignments, setStoryLocationMaskAssignments] = useState<
    { characterPosition: number; rect: { x: number; y: number; w: number; h: number } }[]
  >([]);
  const [storyLocationMaskActiveCharacter, setStoryLocationMaskActiveCharacter] = useState<number>(0);
  const STORY_MASK_ZONE_COLORS = ["#10b981", "#0ea5e9", "#f59e0b", "#d946ef"]; // emerald/sky/amber/fuchsia, theo đúng thứ tự position 0..3
  // Ngưỡng tối thiểu (theo % kích thước ảnh) để 1 vùng khoanh được coi là "đã chọn" — chặn trường hợp
  // khách bấm nhầm 1 điểm (gần như 0x0) rồi tưởng đã chọn xong. SỬA (phản hồi thật của khách): ngưỡng
  // cũ 0.02 (2%) không có dòng giải thích nào khi bị chặn — khách kéo vùng hơi nhỏ (vd nhân vật đứng xa,
  // vùng nhỏ hợp lý) thấy nút "Lưu vị trí" mờ đi mà không hiểu vì sao. Hạ ngưỡng xuống 0.008 (0.8%) cho
  // đỡ ngặt, ĐỒNG THỜI hiện rõ dòng cảnh báo ngay dưới nút khi vùng chưa đủ lớn (xem bên dưới).
  const STORY_MASK_MIN_FRACTION = 0.008;
  // Ảnh THẬT của tối đa MAX_ITEM_REFERENCES vật phẩm riêng của nhân vật #1 (đôi giày, túi xách, đồng
  // hồ...) — tuỳ chọn, mỗi nhân vật (kể cả nhân vật #2+ trong storyExtraCharacters) có ô riêng, không
  // dùng chung cho cả job như địa điểm — xem chú thích itemReferenceUrls trong lib/story-video.ts.
  const STORY_MAX_ITEM_REFERENCES = 3;
  const [storyPrimaryItemReferences, setStoryPrimaryItemReferences] = useState<string[]>([]);
  // Khách chủ động chọn bỏ qua bước tạo Character (AI vẽ sheet nhiều góc) — dùng thẳng ảnh đầu tiên đã
  // tải làm tham chiếu duy nhất, tiết kiệm ~18 credit nhưng các cảnh cần góc khác (quay lưng, nghiêng)
  // dễ kém đồng nhất hơn vì chỉ có đúng 1 góc ảnh để AI tham chiếu, không phải sheet đủ 6 góc.
  const [storySkipCharacterCreation, setStorySkipCharacterCreation] = useState(false);
  // StoryModel giờ khai báo ở module-level (export) để page.tsx (Server Component cha) dùng chung khi
  // fetch model server-side — xem comment đầu file.
  const [storyImageModels, setStoryImageModels] = useState<StoryModel[]>(initialImageModels);
  const [storyVideoModels, setStoryVideoModels] = useState<StoryModel[]>(initialVideoModels);
  const [storyImageModelKey, setStoryImageModelKey] = useState<string | null>(initialImageModelKey);
  const [storyVideoModelKey, setStoryVideoModelKey] = useState<string | null>(initialVideoModelKey);
  // Khách đã có sẵn ảnh cho từng phân cảnh (thay vì để AI tạo) — tải thẳng vào đây, bỏ qua hoàn toàn
  // bước Character + AI tạo ảnh phân cảnh. Agent chỉ đọc ảnh + gợi ý (tuỳ chọn) + Ý tưởng truyện để tự
  // viết prompt chuyển động khi tạo video, không tốn credit ảnh. Tải kiểu động (bấm "+ Tải ảnh" thêm
  // dần từng ảnh, giống hệt "Ảnh nhân vật") — số phân cảnh = số ảnh đã tải, tối đa STORY_MAX_SCENES.
  const [storyUseOwnSceneImages, setStoryUseOwnSceneImages] = useState(false);
  const [storySceneImages, setStorySceneImages] = useState<string[]>([]);
  const [storySceneHints, setStorySceneHints] = useState<string[]>([]);
  // "Cấu hình media" — tỉ lệ khung hình (luôn có), độ phân giải/thời lượng chỉ hiện khi model đang
  // chọn có bảng giá riêng cho trục đó (không hiện dropdown giả cho model không hỗ trợ).
  const [storyAspectRatio, setStoryAspectRatio] = useState("9:16");
  const [storyResolutionKey, setStoryResolutionKey] = useState<string | null>(initialResolutionKey);
  const [storyDurationKey, setStoryDurationKey] = useState<string | null>(initialDurationKey);
  // Chuyển động liên tục giữa các cảnh (Kling O1 FLFV) — chỉ có ý nghĩa khi model video đang chọn hỗ
  // trợ ảnh đầu/cuối (key "kling-o1-flfv"), ẩn checkbox khi chọn model khác. Bật thì mỗi cảnh có thêm
  // 1 ảnh cuối, nối chuỗi ảnh cuối cảnh trước = ảnh đầu cảnh sau — "Tạo lại" từng cảnh dùng route riêng
  // /api/story-video/regenerate-continuous-scene (theo "position", không phải sceneId thẳng).
  const [storyContinuousMotion, setStoryContinuousMotion] = useState(false);
  // Frame-chaining ("dẫn trạng thái qua khung hình thật") — cơ chế nối cảnh KHÁC hẳn continuous motion:
  // dùng khung hình THẬT trích từ video vừa render (không phải ảnh AI tự đoán trước), nên chạy được với
  // MỌI model video thường (không cần loại FLFV riêng). Loại trừ lẫn nhau với continuous motion — v1
  // chỉ hỗ trợ luồng 1 nhân vật, chạy TUẦN TỰ từng cảnh nên chậm hơn nhiều so với luồng song song mặc định.
  const [storyFrameChainMode, setStoryFrameChainMode] = useState(false);
  // Bước "Tạo kịch bản" (xem lib/story-video.ts: planStoryVideoScenes/planStoryVideoScenesMulti) — hỗ
  // trợ CẢ luồng 1 nhân vật lẫn nhiều nhân vật (generateStoryScript/generateStoryScriptMulti), dùng
  // được cả khi bật frame-chain (chỉ luồng 1 nhân vật có checkbox này). KHÔNG hỗ trợ own-images (không
  // cần), chuyển động liên tục (cần thêm field end_description riêng mà bước kịch bản chưa tạo ra).
  const storyUsesScriptFlow = !storyUseOwnSceneImages && !storyContinuousMotion;
  // "Model chat" — LLM thực thi bước chia cảnh (tách biệt với "Agent" = persona/hướng dẫn) — đúng 2
  // lựa chọn admin đang dùng cho app tự tạo dạng text (xem MODEL_OPTIONS trong app/admin/page.tsx).
  const STORY_MODEL_CHAT_OPTIONS = [
    { value: "google/gemini-3-flash-preview", label: "Gemini Flash" },
    { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet" },
    { value: "openai/gpt-5.1", label: "GPT-5.1" },
  ];
  const [storyModelChatKey, setStoryModelChatKey] = useState(STORY_MODEL_CHAT_OPTIONS[0].value);
  // Thể loại — chỉ là 1 khoá tra bảng (xem GENRE_STYLE_GUIDES trong lib/story-video.ts), nối thêm 1
  // đoạn hướng dẫn phong cách cố định vào system prompt Agent chia cảnh, không phải AI tự "hiểu" thể
  // loại. "default" = không chọn gì, không nối thêm.
  // emoji/gradient chỉ dùng làm ảnh thẻ MẶC ĐỊNH khi admin chưa tải ảnh thật cho thể loại đó (xem
  // storyGenreThumbnails) — /admin có ô tải ảnh thẻ riêng cho từng thể loại.
  const STORY_GENRE_OPTIONS = [
    { value: "default", label: "Mặc định", emoji: "🎬", gradient: "from-zinc-500 to-zinc-700" },
    { value: "romance", label: "Tình cảm", emoji: "❤️", gradient: "from-rose-500 to-pink-700" },
    { value: "comedy", label: "Hài hước", emoji: "😂", gradient: "from-amber-400 to-orange-600" },
    { value: "horror", label: "Kinh dị", emoji: "👻", gradient: "from-purple-900 to-black" },
    { value: "scifi", label: "Khoa học viễn tưởng", emoji: "🚀", gradient: "from-cyan-500 to-blue-800" },
    { value: "slice_of_life", label: "Đời thường", emoji: "🍃", gradient: "from-emerald-500 to-teal-700" },
    { value: "mystery", label: "Bí ẩn", emoji: "🕵️", gradient: "from-indigo-700 to-slate-900" },
  ];
  const [storyGenreKey, setStoryGenreKey] = useState(STORY_GENRE_OPTIONS[0].value);
  const [storyGenreThumbnails, setStoryGenreThumbnails] = useState<Record<string, string>>(initialGenreThumbnails);
  const [storyImageCost, setStoryImageCost] = useState<number | null>(null);
  const [storyVideoCost, setStoryVideoCost] = useState<number | null>(null);
  const [storyCharacterCost, setStoryCharacterCost] = useState<number | null>(null);
  // Bước "Tạo Character" — ảnh sheet nhiều góc dùng làm tham chiếu chung cho mọi phân cảnh (thay vì
  // ảnh gốc lộn xộn). Job dừng ở "character_ready" chờ khách duyệt trước khi tốn credit chia cảnh.
  const [storyCharacterSheetUrl, setStoryCharacterSheetUrl] = useState<string | null>(null);
  const [storyCharacterSource, setStoryCharacterSource] = useState<string | null>(null);
  const [storyRegeneratingCharacter, setStoryRegeneratingCharacter] = useState(false);
  // Job nhiều nhân vật — mảng N Character (song song với storyCharacterSheetUrl vốn chỉ dùng cho job 1
  // nhân vật). null/rỗng = job này không phải nhiều nhân vật.
  const [storyJobCharacters, setStoryJobCharacters] = useState<
    { position: number; label: string | null; sheetUrl: string | null; ready: boolean }[] | null
  >(null);
  const [storyRegeneratingJobCharacterPosition, setStoryRegeneratingJobCharacterPosition] = useState<number | null>(null);
  const [storyContinuingScenes, setStoryContinuingScenes] = useState(false);
  // Preview bố cục MIỄN PHÍ (luồng 1 nhân vật) — job dừng ở status "scenes_ready" sau khi chia cảnh
  // xong, TRƯỚC khi tốn credit tạo ảnh thật. scenePreviews có mô tả + lựa chọn camera Agent vừa chọn
  // cho từng cảnh (chưa có ảnh); characterAngleUrls dùng để ghép ảnh phác thảo (không gọi AI, không
  // tốn credit) — xem renderScenePreviewComposite().
  const [storyScenePreviews, setStoryScenePreviews] = useState<
    | {
        id: number;
        position: number;
        sceneDescription: string | null;
        cameraView: string | null;
        shotSize: string | null;
        cameraAngle: string | null;
        cameraMovement: string | null;
        lightDirection: string | null;
        cameraBody: string | null;
        lens: string | null;
        aperture: string | null;
        location: string | null;
      }[]
    | null
  >(null);
  // Modal chọn ánh sáng/máy quay kiểu Higgsfield Cinema Studio (bấm 1 chip gọn -> mở modal giữa màn
  // hình chứa lưới preset) — 1 state DÙNG CHUNG cho mọi thẻ cảnh (cả 2 khối script-stage/scenes_ready),
  // thay vì mở modal riêng từng thẻ, để tránh nhiều modal chồng nhau khi có nhiều cảnh.
  const [activePresetModal, setActivePresetModal] = useState<{
    stage: "script" | "preview";
    key: number; // script: index trong storyScriptScenes; preview: scene.id
    type: "light" | "gear";
  } | null>(null);
  const [storyCharacterAngleUrlsForPreview, setStoryCharacterAngleUrlsForPreview] = useState<Record<string, string> | null>(null);
  const [storyContinuingImages, setStoryContinuingImages] = useState(false);
  const [storySavingCharacter, setStorySavingCharacter] = useState(false);
  const [storySavedCharacterMsg, setStorySavedCharacterMsg] = useState<string | null>(null);
  // Thư viện Character đã lưu — chọn 1 cái thay vì tải ảnh mới, bỏ qua hẳn bước tạo Character (chắc
  // chắn 100% vì chính hệ thống đã tạo ra trước đó, không cần AI phân loại lại).
  type SavedCharacter = { id: number; imageUrl: string; label: string | null };
  const [storySavedCharacters, setStorySavedCharacters] = useState<SavedCharacter[]>([]);
  const [storySelectedSavedCharacterId, setStorySelectedSavedCharacterId] = useState<number | null>(null);
  // "Kiểm tra ảnh" — cho khách tự xem trước AI sẽ nhận ảnh đầu tiên là sheet nhiều góc (bỏ qua tạo mới)
  // hay ảnh thường (sẽ tốn credit tạo Character), không cần chạy hết cả job mới biết.
  const [storyCheckingImage, setStoryCheckingImage] = useState(false);
  const [storyImageCheckResult, setStoryImageCheckResult] = useState<"sheet" | "photo" | null>(null);
  // "Tự động tạo video luôn" (gộp 1 lượt, giống Genful bấm mũi tên ▾) — mặc định TẮT: chỉ chạy chia
  // cảnh + tạo ảnh trước, dừng lại cho khách xem, ưng mới bấm "Tạo video" (đỡ tốn credit video oan
  // nếu ảnh ra không đúng ý).
  const [storyAutoVideo, setStoryAutoVideo] = useState(false);
  // "AI gợi ý số cảnh" — đếm hộ số hành động/thay đổi tư thế lớn trong truyện, tự chọn nút số cảnh
  // tương ứng (khách vẫn tự bấm đổi lại được). Tránh bắt khách tự đếm hành động trong truyện.
  const [suggestingScenes, setSuggestingScenes] = useState(false);
  const [sceneSuggestError, setSceneSuggestError] = useState<string | null>(null);
  // Chỉ gọi API, KHÔNG đụng state — trả thẳng số cảnh (hoặc null nếu lỗi) để nơi gọi dùng NGAY trong
  // cùng 1 lượt submit, tránh race condition: setNumScenes() là bất đồng bộ (chờ re-render mới thấy),
  // nếu handleRunStoryVideo chỉ đọc biến numScenes hiện tại thì có thể đọc trúng giá trị CŨ nếu khách
  // bấm "Tạo ảnh phân cảnh" ngay sau khi rời ô nhập, trước khi lượt gợi ý (chạy nền, mất vài giây) kịp
  // xong.
  async function fetchSuggestedSceneCount(): Promise<number | null> {
    try {
      const res = await fetch("/api/story-video/suggest-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyDescription: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSceneSuggestError(data.error ?? "Không gợi ý được");
        return null;
      }
      return data.numScenes as number;
    } catch {
      setSceneSuggestError("Không kết nối được tới server");
      return null;
    }
  }
  async function handleSuggestSceneCount() {
    if (!input.trim()) {
      setSceneSuggestError("Nhập truyện trước đã");
      return;
    }
    setSuggestingScenes(true);
    setSceneSuggestError(null);
    try {
      const n = await fetchSuggestedSceneCount();
      if (n !== null) {
        setNumScenes(n);
        setSceneCountChosen(true);
      }
    } finally {
      setSuggestingScenes(false);
    }
  }
  // Bước "Tạo kịch bản" — CHỈ dùng cho luồng mặc định (1 nhân vật, AI tự vẽ ảnh, không own-images).
  async function handleCreateScript() {
    if (!input.trim()) {
      setStoryScriptError("Nhập truyện trước đã");
      return;
    }
    if (!storyVideoModelKey) {
      setStoryScriptError("Chưa chọn model video");
      return;
    }
    setStoryScriptLoading(true);
    setStoryScriptError(null);
    try {
      // Nhiều nhân vật -> gửi kèm tên từng người (fallback "Nhân vật N" nếu bỏ trống, khớp đúng cách
      // backend tự đặt tên khi tạo Character) để route chuyển sang generateStoryScriptMulti.
      const hasMultipleCharacters = storyExtraCharacters.length > 0;
      const characterLabels = hasMultipleCharacters
        ? [storyPrimaryCharacterLabel.trim() || "Nhân vật 1", ...storyExtraCharacters.map((c, i) => c.label.trim() || `Nhân vật ${i + 2}`)]
        : undefined;
      const res = await fetch("/api/story-video/plan-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyDescription: input.trim(),
          miniAppId: app!.id,
          videoModelKey: storyVideoModelKey,
          modelChatKey: storyModelChatKey,
          characterLabels,
          characterLabel: hasMultipleCharacters ? undefined : storyPrimaryCharacterLabel.trim() || "Nhân vật 1",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryScriptError(data.error ?? "Không tạo được kịch bản");
        return;
      }
      setStoryScriptActions(data.actions);
      setStoryScriptScenes(data.scenes);
      setStoryScriptTotalSeconds(data.totalNaturalSeconds ?? null);
      setStoryScriptVideoCreditCost(data.videoCreditCost ?? null);
      setNumScenes(data.scenes.length);
      setSceneCountChosen(true);
      setStorySpeedDrafts({});
      // Còn thanh trượt chờ chỉnh (nếu tính năng đang bật) — chưa coi là xong ngay, khách phải bấm
      // "Hoàn thành" mới hiện đúng danh sách cảnh/giá cuối (xem khối render bên dưới).
      setStorySpeedFinalized(false);
    } catch {
      setStoryScriptError("Không kết nối được tới server");
    } finally {
      setStoryScriptLoading(false);
    }
  }
  // Bước "Hoàn thành chỉnh tốc độ" (chỉ chạy khi storyEnableSpeedSlider bật) — gửi lại ĐÚNG mảng hành
  // động Agent đã liệt kê (storyScriptActions), chỉ thay duration_seconds theo thanh trượt khách vừa
  // kéo, KHÔNG gọi lại Agent (route tự nhận diện qua field actions/actionsMulti, xem plan-script/route.ts).
  async function handleFinalizeSpeed() {
    if (!storyScriptActions) return;
    setStorySpeedLoading(true);
    setStoryScriptError(null);
    try {
      const hasMultipleCharacters = storyExtraCharacters.length > 0;
      const adjustedActions = storyScriptActions.map((a, i) => ({
        ...a,
        duration_seconds: storySpeedDrafts[i] ?? a.duration_seconds,
      }));
      const characterLabels = hasMultipleCharacters
        ? [storyPrimaryCharacterLabel.trim() || "Nhân vật 1", ...storyExtraCharacters.map((c, i) => c.label.trim() || `Nhân vật ${i + 2}`)]
        : undefined;
      const res = await fetch("/api/story-video/plan-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyDescription: input.trim(),
          miniAppId: app!.id,
          videoModelKey: storyVideoModelKey,
          modelChatKey: storyModelChatKey,
          characterLabels,
          actions: hasMultipleCharacters ? undefined : adjustedActions,
          actionsMulti: hasMultipleCharacters ? adjustedActions : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryScriptError(data.error ?? "Không tính lại được cảnh/giá");
        return;
      }
      setStoryScriptActions(data.actions);
      setStoryScriptScenes(data.scenes);
      setStoryScriptTotalSeconds(data.totalNaturalSeconds ?? null);
      setStoryScriptVideoCreditCost(data.videoCreditCost ?? null);
      setNumScenes(data.scenes.length);
      setStorySpeedFinalized(true);
    } catch {
      setStoryScriptError("Không kết nối được tới server");
    } finally {
      setStorySpeedLoading(false);
    }
  }
  // Kịch bản đã tạo gắn với ĐÚNG nội dung truyện + model video lúc bấm — đổi 1 trong 2 thứ đó sau khi
  // đã có kịch bản thì huỷ bản cũ, bắt bấm "Tạo kịch bản" lại, đảm bảo giá hiện luôn khớp thực tế dùng.
  useEffect(() => {
    if (storyScriptActions) {
      setStoryScriptActions(null);
      setStoryScriptScenes(null);
      setStoryScriptTotalSeconds(null);
      setStoryScriptVideoCreditCost(null);
      setStorySpeedDrafts({});
      setStorySpeedFinalized(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, storyVideoModelKey]);
  const [storyRunning, setStoryRunning] = useState(false);
  const [storyContinuing, setStoryContinuing] = useState(false);
  const [storyFinalizingPartial, setStoryFinalizingPartial] = useState(false);
  const [storyCancelling, setStoryCancelling] = useState(false);
  // 2 nút "Tạo ảnh phân cảnh" / "Viết mô tả chuyển động để tạo video" độc lập nhau, nhưng vẫn dùng
  // chung storyRunning để khoá nhau tránh chạy đè job (storyJobId/storyScenes dùng chung 1 chỗ) — cờ
  // này chỉ để nhãn nút hiện đúng "Đang xử lý..." trên nút khách vừa bấm, không hiện nhầm sang nút kia.
  const [storyActiveButton, setStoryActiveButton] = useState<"images" | "video" | null>(null);
  const [storyStatusText, setStoryStatusText] = useState<string | null>(null);
  const [storyStatus, setStoryStatus] = useState<string | null>(null);
  const [storyJobId, setStoryJobId] = useState<number | null>(null);
  const [storyScenes, setStoryScenes] = useState<
    | {
        id: number;
        position: number;
        imageUrl: string | null;
        endImageUrl?: string | null;
        videoUrl: string | null;
        hasDialogue?: boolean;
        motionPrompt?: string;
        identityRetryCount?: number;
      }[]
    | null
  >(null);
  const [storyRegeneratingSceneId, setStoryRegeneratingSceneId] = useState<number | null>(null);
  // Chế độ chuyển động liên tục — "Tạo lại" theo VỊ TRÍ hiển thị trên UI (không phải sceneId trực
  // tiếp), xem regenerateContinuousMotionSceneImage() trong lib/story-video.ts để hiểu vì sao.
  const [storyRegeneratingContinuousPosition, setStoryRegeneratingContinuousPosition] = useState<number | null>(null);
  // 2 nút "Kiểm tra" thủ công (thiếu chi thể / lệch ảnh đầu-cuối) — key theo sceneId, giá trị null =
  // đang chạy, undefined = chưa kiểm tra lần nào, {ok,issue} = kết quả lần gần nhất.
  const [storyAnatomyChecking, setStoryAnatomyChecking] = useState<Record<number, boolean>>({});
  const [storyAnatomyResults, setStoryAnatomyResults] = useState<Record<number, { ok: boolean; issue?: string }>>({});
  const [storyContinuityChecking, setStoryContinuityChecking] = useState<Record<number, boolean>>({});
  const [storyContinuityResults, setStoryContinuityResults] = useState<Record<number, { ok: boolean; issue?: string }>>({});
  const [storyRegeneratingVideoSceneId, setStoryRegeneratingVideoSceneId] = useState<number | null>(null);
  // Sửa câu mô tả chuyển động trước khi tạo lại video 1 cảnh — dùng khi lỗi lặp lại y hệt (vd bị model
  // chặn nội dung), gửi lại đúng câu cũ dễ ra lỗi y hệt, cần chỗ để khách đổi cách diễn đạt.
  const [storyEditingPromptSceneId, setStoryEditingPromptSceneId] = useState<number | null>(null);
  const [storyEditedPrompt, setStoryEditedPrompt] = useState("");
  const [storyResult, setStoryResult] = useState<string | null>(null);
  const [storyError, setStoryError] = useState<string | null>(null);
  const storyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Sinh ảnh trực tiếp từ prompt bar ở tab "hình ảnh" (lib/prompt-image.ts) — TÁCH RIÊNG hẳn khỏi
  // storyRunning/storyResult (luồng video kịch bản cũ) vì đây là 1 job hoàn toàn khác (1 prompt -> 1
  // ảnh, không qua Character/phân cảnh), submit xong poll /api/prompt-image/status tới khi xong.
  const [promptImageRunning, setPromptImageRunning] = useState(false);
  const [promptImageResult, setPromptImageResult] = useState<string | null>(null);
  const [promptImageError, setPromptImageError] = useState<string | null>(null);
  const promptImagePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const storyCharacterPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyScenesPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyScenePreviewSectionRef = useRef<HTMLDivElement | null>(null);
  const storyResultRef = useRef<HTMLDivElement | null>(null);
  // Khối "Ảnh nhân vật" (điểm neo cuộn về lại khi đóng xem trước) + khối "Xem trước ảnh" dùng chung
  // đúng vị trí/kiểu hiển thị với khối kết quả Character thật (storyCharacterPreviewRef phía dưới) —
  // bấm ảnh nhỏ nào cũng phóng to ở ĐÚNG chỗ đó (không phải phóng to tại chỗ trong khung nhỏ), nên bấm
  // mới cần cuộn hẳn xuống khu vực khác, bấm đóng lại cuộn ngược lên khung "Ảnh nhân vật".
  const storyCharacterCardRef = useRef<HTMLDivElement | null>(null);
  const [storyQuickZoomUrl, setStoryQuickZoomUrl] = useState<string | null>(null);
  const storyQuickZoomRef = useRef<HTMLDivElement | null>(null);

  // Tự động cuộn xuống khi Character/ảnh phân cảnh xong hoặc video hoàn tất — khách không phải cuộn
  // tay để xem kết quả.
  useEffect(() => {
    if (storyStatus === "character_ready") {
      storyCharacterPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (storyStatus === "scenes_ready") {
      storyScenePreviewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (storyStatus === "images_ready") {
      storyScenesPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [storyStatus]);

  // Tỉ lệ chiều cao khung hình mà từng shot_size chiếm — dùng để ghép ảnh phác thảo bố cục MIỄN PHÍ
  // (không gọi AI, không tốn credit) từ ảnh Character đã có sẵn. Neo đáy khung hình, giống cách máy
  // ảnh thật lấy khung: cận cảnh chiếm gần hết khung, toàn cảnh chỉ chiếm 1 góc nhỏ.
  const SCENE_PREVIEW_SHOT_SCALE: Record<string, number> = {
    close_up: 0.95,
    medium_close_up: 0.75,
    medium_shot: 0.55,
    full_shot: 0.4,
    wide_shot: 0.22,
    detail_shot: 0.6,
  };
  const SCENE_PREVIEW_CAMERA_VIEW_LABEL: Record<string, string> = {
    front: "Chính diện",
    three_quarter_left: "Chếch trái",
    three_quarter_right: "Chếch phải",
    side: "Nghiêng ngang",
    back: "Sau lưng",
    face: "Cận mặt",
  };
  const SCENE_PREVIEW_SHOT_SIZE_LABEL: Record<string, string> = {
    close_up: "Cận cảnh",
    medium_close_up: "Cận vừa",
    medium_shot: "Trung cảnh",
    full_shot: "Toàn thân",
    wide_shot: "Toàn cảnh rộng",
    detail_shot: "Chi tiết (vật/tay/mắt...)",
  };
  const SCENE_PREVIEW_CAMERA_ANGLE_LABEL: Record<string, string> = {
    eye_level: "Ngang tầm mắt",
    low_angle: "Máy thấp hướng lên",
    high_angle: "Máy cao hướng xuống",
    aerial_shot: "Từ trên cao (chim bay)",
    dutch_angle: "Nghiêng máy",
  };
  const SCENE_PREVIEW_CAMERA_MOVEMENT_LABEL: Record<string, string> = {
    static: "Tĩnh",
    pan: "Lia ngang",
    dolly_in: "Tiến vào",
    dolly_out: "Lùi ra",
    tracking: "Bám theo",
  };
  // Đặt tên theo đúng thuật ngữ điện ảnh (tham khảo bảng Lighting thật của Higgsfield Cinema Studio) —
  // xem LIGHT_DIRECTION_LABELS trong lib/story-video.ts (6 giá trị y hệt).
  const SCENE_PREVIEW_LIGHT_DIRECTION_LABEL: Record<string, string> = {
    front_lighting: "Ánh sáng thẳng",
    back_lighting: "Ngược sáng (Contre jour)",
    silhouette: "Bóng đen (Silhouette)",
    side_lighting: "Sáng chéo (Rembrandt)",
    top_lighting: "Sáng từ trên",
    low_lighting: "Sáng hắt từ dưới",
  };
  const LIGHT_DIRECTION_OPTIONS = ["front_lighting", "back_lighting", "silhouette", "side_lighting", "top_lighting", "low_lighting"];
  // 3 trục thiết bị quay độc lập (xem CAMERA_BODY_LABELS/LENS_LABELS/APERTURE_LABELS trong
  // lib/story-video.ts) — tham khảo bảng "Camera > Setup" thật của Higgsfield Cinema Studio.
  const SCENE_PREVIEW_CAMERA_BODY_LABEL: Record<string, string> = {
    modern: "Hiện đại",
    dv_camcorder: "DV cổ điển",
    film_35mm: "Phim 35mm",
    film_8mm: "Phim 8mm (hoài cổ)",
  };
  const CAMERA_BODY_OPTIONS = ["modern", "dv_camcorder", "film_35mm", "film_8mm"];
  const SCENE_PREVIEW_LENS_LABEL: Record<string, string> = {
    clean_sharp: "Sắc nét hiện đại",
    vintage_anamorphic: "Anamorphic cổ điển",
    warm_vintage: "Ấm áp cổ điển",
    halation_vintage: "Cổ điển (quầng sáng)",
  };
  const LENS_OPTIONS = ["clean_sharp", "vintage_anamorphic", "warm_vintage", "halation_vintage"];
  const SCENE_PREVIEW_APERTURE_LABEL: Record<string, string> = {
    moderate: "Vừa phải (f/4)",
    wide_open: "Xoá phông mạnh (f/1.4)",
    deep_focus: "Nét sâu toàn khung (f/11)",
  };
  const APERTURE_OPTIONS = ["moderate", "wide_open", "deep_focus"];
  // Màu thanh trên cùng theo camera_angle — trùng bảng SCENE_PREVIEW_ANGLE_BAR_COLOR trong
  // components/MannequinPreviewCard.tsx (component đó tự vẽ thanh màu, không đọc bảng này nữa).

  // Vị trí/tỉ lệ (theo %, khớp trực tiếp với khung "aspect-video" 16:9) để đặt mannequin 3D tương tác
  // (MannequinPreviewCard) trong khối xem trước bố cục MIỄN PHÍ — nếu khách đã dùng "Chọn vị trí đứng"
  // thì đặt đúng vùng đã khoanh, không thì neo đáy giữa khung theo tỉ lệ shot_size (cận cảnh chiếm gần
  // hết khung, toàn cảnh chỉ chiếm 1 góc nhỏ) — trước đây tính bằng px trên Canvas 2D (renderScenePreviewComposite,
  // đã bỏ), giờ chỉ cần % vì mannequin tự render sống (WebGL) ngay trong khung, không ghép ảnh tĩnh nữa.
  function computeMannequinBoxStyle(
    shotSize: string | null,
    positionRect?: { x: number; y: number; w: number; h: number } | null
  ): { left: string; top: string; width: string; height: string } {
    const scale = SCENE_PREVIEW_SHOT_SCALE[shotSize ?? ""] ?? 0.5;
    // Tỉ lệ khung người chuẩn (rộng:cao) — mannequin cao gấp ~2.2 lần rộng, xấp xỉ đúng camera setup
    // trong buildMannequin()/MannequinPreviewCard (canvas render theo đúng khung div này).
    const personAspect = 0.42;
    let heightPct: number;
    let leftPct: number;
    let topPct: number;
    if (positionRect) {
      const rectHeightPct = positionRect.h * 100;
      heightPct = Math.max(rectHeightPct, scale * 100 * 0.6);
      const widthPct = heightPct * personAspect * (9 / 16);
      leftPct = positionRect.x * 100 + (positionRect.w * 100 - widthPct) / 2;
      topPct = (positionRect.y + positionRect.h) * 100 - heightPct;
      return { left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` };
    }
    heightPct = scale * 100;
    const widthPct = heightPct * personAspect * (9 / 16);
    leftPct = (100 - widthPct) / 2;
    topPct = 100 - heightPct;
    return { left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` };
  }

  // Khách kéo chuột xoay mannequin ở khối "Tạo kịch bản" rồi bấm "Chọn góc này" — ghi đè cameraView vào
  // ĐÚNG action gốc trong storyScriptActions (thứ thật sự gửi lên server khi submit qua preplannedActions)
  // VÀ vào storyScriptScenes[i] (chỉ để hiện nhãn đúng ngay trên UI). Một scene có thể được GỘP từ NHIỀU
  // action gốc (xem PlannedScene.merged_from trong lib/story-video.ts) — chỉ cho ghi đè khi scene đó gộp
  // từ ĐÚNG 1 action (trường hợp phổ biến nhất), tránh ghi nhầm cameraView cho action không liên quan khi
  // bị gộp nhiều action lại thành 1 cảnh.
  function handleScriptCameraViewChange(sceneIndex: number, view: string) {
    setStoryScriptScenes((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[sceneIndex] = { ...next[sceneIndex], camera_view: view };
      return next;
    });
    setStoryScriptActions((prev) => {
      if (!prev || !storyScriptScenes) return prev;
      const scene = storyScriptScenes[sceneIndex] as unknown as { merged_from?: StoryScriptAction[] };
      const sourceAction = scene.merged_from && scene.merged_from.length === 1 ? scene.merged_from[0] : null;
      if (!sourceAction) return prev;
      const actionIndex = prev.indexOf(sourceAction);
      if (actionIndex === -1) return prev;
      const next = [...prev];
      next[actionIndex] = { ...next[actionIndex], camera_view: view };
      return next;
    });
  }

  // Khách kéo chuột xoay mannequin ở khối "scenes_ready" (SAU khi đã submit job, scene đã có id thật
  // trong DB) rồi bấm "Chọn góc này" — cập nhật UI ngay (optimistic) + gọi API lưu lại cameraView thật
  // vào đúng hàng story_video_scenes, để lúc bấm "Tạo ảnh" sau đó dùng đúng góc khách vừa chọn thay vì
  // góc Agent chọn lúc chia cảnh.
  async function handleScenePreviewCameraViewChange(sceneId: number, view: string) {
    setStoryScenePreviews((prev) => (prev ? prev.map((s) => (s.id === sceneId ? { ...s, cameraView: view } : s)) : prev));
    try {
      await fetch("/api/story-video/update-scene-camera-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId, cameraView: view }),
      });
    } catch {
      // Lưu thất bại thì UI vẫn hiện đúng lựa chọn khách vừa xoay (optimistic) — không chặn thao tác,
      // rủi ro thấp nhất (nếu server không lưu được, ảnh tạo ra vẫn theo góc Agent chọn ban đầu, không
      // sai lệch nghiêm trọng).
    }
  }

  // Mirror đúng handleScriptCameraViewChange nhưng cho light_direction — khách bấm 1 trong 6 nút preset
  // hướng sáng (không kéo-xoay, chỉ dãy nút bấm — xem LIGHT_DIRECTION_OPTIONS).
  function handleScriptLightDirectionChange(sceneIndex: number, lightDirection: string) {
    setStoryScriptScenes((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[sceneIndex] = { ...next[sceneIndex], light_direction: lightDirection };
      return next;
    });
    setStoryScriptActions((prev) => {
      if (!prev || !storyScriptScenes) return prev;
      const scene = storyScriptScenes[sceneIndex] as unknown as { merged_from?: StoryScriptAction[] };
      const sourceAction = scene.merged_from && scene.merged_from.length === 1 ? scene.merged_from[0] : null;
      if (!sourceAction) return prev;
      const actionIndex = prev.indexOf(sourceAction);
      if (actionIndex === -1) return prev;
      const next = [...prev];
      next[actionIndex] = { ...next[actionIndex], light_direction: lightDirection };
      return next;
    });
  }

  // Mirror đúng handleScenePreviewCameraViewChange nhưng cho light_direction.
  async function handleScenePreviewLightDirectionChange(sceneId: number, lightDirection: string) {
    setStoryScenePreviews((prev) => (prev ? prev.map((s) => (s.id === sceneId ? { ...s, lightDirection } : s)) : prev));
    try {
      await fetch("/api/story-video/update-scene-light-direction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId, lightDirection }),
      });
    } catch {
      // Xem chú thích ở handleScenePreviewCameraViewChange — cùng lý do, không chặn thao tác.
    }
  }

  // Mirror đúng handleScriptLightDirectionChange nhưng cho 3 trục thiết bị (field nào gọi thì truyền
  // đúng field đó, 2 field còn lại giữ nguyên — xem cách gọi trong JSX, mỗi dãy nút chỉ đổi đúng 1 field).
  function handleScriptCameraGearChange(sceneIndex: number, field: "camera_body" | "lens" | "aperture", value: string) {
    setStoryScriptScenes((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[sceneIndex] = { ...next[sceneIndex], [field]: value };
      return next;
    });
    setStoryScriptActions((prev) => {
      if (!prev || !storyScriptScenes) return prev;
      const scene = storyScriptScenes[sceneIndex] as unknown as { merged_from?: StoryScriptAction[] };
      const sourceAction = scene.merged_from && scene.merged_from.length === 1 ? scene.merged_from[0] : null;
      if (!sourceAction) return prev;
      const actionIndex = prev.indexOf(sourceAction);
      if (actionIndex === -1) return prev;
      const next = [...prev];
      next[actionIndex] = { ...next[actionIndex], [field]: value };
      return next;
    });
  }

  // Mirror đúng handleScenePreviewLightDirectionChange nhưng cho 3 trục thiết bị — gọi chung 1 API
  // (update-scene-camera-gear) nhận field nào đổi thì gửi đúng field đó (xem updateSceneCameraGear).
  async function handleScenePreviewCameraGearChange(sceneId: number, field: "cameraBody" | "lens" | "aperture", value: string) {
    setStoryScenePreviews((prev) => (prev ? prev.map((s) => (s.id === sceneId ? { ...s, [field]: value } : s)) : prev));
    try {
      await fetch("/api/story-video/update-scene-camera-gear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId, [field]: value }),
      });
    } catch {
      // Xem chú thích ở handleScenePreviewCameraViewChange — cùng lý do, không chặn thao tác.
    }
  }

  useEffect(() => {
    if (storyResult) {
      storyResultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [storyResult]);

  // Ảnh phân cảnh (dù AI tự vẽ hay khách tự tải) luôn đổ về chung 1 khung "Ảnh phân cảnh" — đồng bộ
  // ảnh đã tạo xong từ job đang chạy vào storySceneImages để khung đó luôn có đủ nút xoá/tải thêm/zoom,
  // không bị chuyển sang chế độ chỉ xem sau khi chạy xong.
  useEffect(() => {
    if (!storyScenes) return;
    const urls = storyScenes.map((s) => s.imageUrl).filter((u): u is string => !!u);
    if (urls.length > 0) setStorySceneImages(urls);
  }, [storyScenes]);

  // Thư viện Character đã lưu — tải khi vào app + sau khi lưu 1 Character mới.
  function loadSavedStoryCharacters(userId: string) {
    fetch(`/api/story-video/characters?userId=${userId}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.characters)) setStorySavedCharacters(data.characters);
      })
      .catch(() => {});
  }
  useEffect(() => {
    if (!user) return;
    loadSavedStoryCharacters(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleDeleteSavedCharacter(characterId: number) {
    if (!user) return;
    setStorySavedCharacters((prev) => prev.filter((c) => c.id !== characterId));
    if (storySelectedSavedCharacterId === characterId) setStorySelectedSavedCharacterId(null);
    try {
      await fetch(`/api/story-video/characters?userId=${user.id}&id=${characterId}`, { method: "DELETE" });
    } catch {
      loadSavedStoryCharacters(user.id);
    }
  }

  useEffect(() => {
    return () => {
      if (storyPollRef.current) clearInterval(storyPollRef.current);
      if (promptImagePollRef.current) clearInterval(promptImagePollRef.current);
    };
  }, []);

  // "Video từ ý tưởng truyện": tải danh sách model ảnh/video từ catalog 1 lần khi vào trang, chọn sẵn
  // model đầu tiên mỗi loại.
  useEffect(() => {
    fetch("/api/story-video/models?miniAppId=video-tu-y-tuong")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.imageModels)) {
          setStoryImageModels(data.imageModels);
          const first = data.imageModels[0];
          if (first) {
            setStoryImageModelKey(first.key);
            if (first.resolution_price_vnd) setStoryResolutionKey(Object.keys(first.resolution_price_vnd)[0]);
          }
        }
        if (Array.isArray(data.videoModels)) {
          setStoryVideoModels(data.videoModels);
          const first = data.videoModels[0];
          if (first) {
            setStoryVideoModelKey(first.key);
            if (first.duration_price_vnd) setStoryDurationKey(Object.keys(first.duration_price_vnd)[0]);
          }
        }
        if (data.genreThumbnails && typeof data.genreThumbnails === "object") {
          setStoryGenreThumbnails(data.genreThumbnails);
        }
        if (typeof data.enableSpeedSlider === "boolean") setStoryEnableSpeedSlider(data.enableSpeedSlider);
      })
      .catch(() => {});
  }, []);

  // Từ 2 nhân vật trở lên bắt buộc dùng model hỗ trợ nhiều ảnh tham chiếu (multi_image) — đã kiểm
  // chứng qua test thật chỉ loại model này ghép được nhiều người vào 1 cảnh. Tự chuyển sang model
  // multi_image đầu tiên nếu model đang chọn không hỗ trợ, tránh khách bấm chạy rồi mới bị lỗi. Ảnh
  // Bối cảnh/Địa điểm và ảnh Vật phẩm riêng cũng cần multi_image (thêm ảnh tham chiếu nữa) nên dùng
  // chung điều kiện — thiếu điều kiện vật phẩm trước đây khiến job chỉ có vật phẩm (không kèm nhiều
  // nhân vật/địa điểm) âm thầm bỏ qua hẳn ảnh vật phẩm vì vẫn ở model 1-ảnh mặc định (xác nhận qua
  // job thật #127: item_reference_urls có dữ liệu nhưng image_model vẫn là flux-pro/kontext).
  useEffect(() => {
    // Đã khoanh vùng đặt nhân vật (mask) — CHỈ GPT Image 2 Edit thật sự hỗ trợ mask_url, ưu tiên điều
    // kiện này trước cả multi_image (GPT Image 2 Edit vốn cũng multi_image nên không xung đột).
    if (storyLocationReferenceMaskUrl) {
      const current = storyImageModels.find((m) => m.key === storyImageModelKey);
      if (current && current.model !== "fal-ai/gpt-image-2/edit") {
        const fallback = storyImageModels.find((m) => m.model === "fal-ai/gpt-image-2/edit");
        if (fallback) setStoryImageModelKey(fallback.key);
      }
      return;
    }
    if (storyExtraCharacters.length === 0 && !storyLocationReference && storyPrimaryItemReferences.length === 0) return;
    const current = storyImageModels.find((m) => m.key === storyImageModelKey);
    if (current && !current.multi_image) {
      const fallback = storyImageModels.find((m) => m.multi_image);
      if (fallback) setStoryImageModelKey(fallback.key);
    }
  }, [
    storyExtraCharacters.length,
    storyLocationReference,
    storyLocationReferenceMaskUrl,
    storyPrimaryItemReferences.length,
    storyImageModels,
    storyImageModelKey,
  ]);

  // "Video từ ý tưởng truyện": tự khôi phục job gần nhất còn dở dang khi khách quay lại trang (đóng
  // tab/tắt máy giữa chừng) — trước đây mọi tiến trình chỉ nằm trong state trình duyệt nên tắt đi là
  // mất, dù job vẫn đang chạy/đã hoàn thành phía server. Bao gồm cả "failed" vì job này có 2 lượt trừ
  // credit riêng (ảnh/video) — lỗi ở bước video không có nghĩa ảnh đã tạo (đã trả tiền) cũng mất theo.
  useEffect(() => {
    if (!user || storyJobId) return;
    fetch(`/api/story-video/active?userId=${user.id}`)
      .then((res) => res.json())
      .then(async (data) => {
        const job = data.job;
        if (!job) return;
        if (data.project) restoreStoryProject(data.project, data.chapterIndex ?? null);
        setStoryJobId(job.id);
        if (job.storyDescription) setInput(job.storyDescription);
        if (Array.isArray(job.characterImageUrls) && job.characterImageUrls.length > 0) {
          setStoryCharacterImages(job.characterImageUrls);
        }
        if (job.locationReferenceUrl) setStoryLocationReference(job.locationReferenceUrl);
        if (job.locationReferenceMaskUrl) setStoryLocationReferenceMaskUrl(job.locationReferenceMaskUrl);
        restoreLocationMaskZones(job.locationReferenceMaskZones);
        // Job 1 nhân vật không có toạ độ vùng (chỉ có ảnh mask) — dò lại từ ảnh mask để vẽ đè lên ảnh Bối cảnh.
        if (job.locationReferenceMaskUrl && !(Array.isArray(job.locationReferenceMaskZones) && job.locationReferenceMaskZones.length > 0)) {
          restoreSingleMaskRect(job.locationReferenceMaskUrl);
        }
        setStoryRunning(true);
        setStoryStatusText("Đang khôi phục công việc đang làm dở...");
        try {
          const res = await fetch(`/api/story-video/status?jobId=${job.id}`);
          const statusData = await res.json();
          if (Array.isArray(statusData.scenes)) setStoryScenes(statusData.scenes);
          setStoryStatus(statusData.status ?? null);
          if (statusData.characterSheetUrl) setStoryCharacterSheetUrl(statusData.characterSheetUrl);
          if (statusData.characterSource) setStoryCharacterSource(statusData.characterSource);
          if (statusData.status === "done" && statusData.outputUrl) {
            setStoryResult(statusData.outputUrl);
            setStoryRunning(false);
            setStoryStatusText(null);
          } else if (statusData.status === "character_ready" || statusData.status === "images_ready") {
            setStoryRunning(false);
            setStoryStatusText(statusData.statusText ?? null);
          } else if (statusData.status === "failed" || statusData.status === "cancelled") {
            setStoryError(
              statusData.status === "cancelled"
                ? statusData.errorMessage ?? "Đã dừng theo yêu cầu của bạn"
                : statusData.errorMessage ?? "Tạo video thất bại, credit đã được hoàn"
            );
            setStoryRunning(false);
            setStoryStatusText(null);
          } else {
            setStoryStatusText(statusData.statusText ?? "Đang xử lý...");
            pollStoryVideoStatus(job.id);
          }
        } catch {
          setStoryRunning(false);
          setStoryStatusText(null);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // "Video từ ý tưởng truyện": giá tăng theo số phân cảnh (2-8) + model/tỉ lệ/độ phân giải/thời
  // lượng đã chọn — tính lại mỗi khi đổi.
  useEffect(() => {
    if (!storyImageModelKey || !storyVideoModelKey) return;
    const params2 = new URLSearchParams({
      miniAppId: "video-tu-y-tuong",
      numScenes: String(numScenes),
      imageModelKey: storyImageModelKey,
      videoModelKey: storyVideoModelKey,
    });
    if (storyResolutionKey) params2.set("resolutionKey", storyResolutionKey);
    if (storyDurationKey) params2.set("durationKey", storyDurationKey);
    if (storyContinuousMotion) params2.set("continuousMotion", "1");
    fetch(`/api/story-video/price?${params2.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.imageCost === "number") setStoryImageCost(data.imageCost);
        if (typeof data.videoCost === "number") setStoryVideoCost(data.videoCost);
        if (typeof data.characterCost === "number") setStoryCharacterCost(data.characterCost);
      })
      .catch(() => {});
  }, [numScenes, storyImageModelKey, storyVideoModelKey, storyResolutionKey, storyDurationKey, storyContinuousMotion]);

  if (!app) {
    return null;
  }

  const relatedApps = MINI_APPS.filter(
    (item) => item.category === app.category && item.id !== app.id
  ).slice(0, 3);

  // Nén/resize ảnh NGAY trên trình duyệt trước khi tạo base64 để tải lên — ảnh điện thoại chụp
  // thường 3-8MB, base64 hoá phình thêm ~33% rồi còn phải đi 2 chặng mạng (trình duyệt → Vercel →
  // Supabase Storage), là nguyên nhân chính khiến tải ảnh chậm. Các model AI tạo ảnh xử lý ảnh tham
  // chiếu ở độ phân giải nội bộ thấp hơn maxDimension này nhiều, nên thu nhỏ không làm giảm chất
  // lượng AI nhận diện nhân vật — chỉ giảm dung lượng file thật sự cần gửi đi.
  // SỬA (phản hồi thật user: tải ảnh từ máy lên rất chậm/"Failed to fetch" dù mạng/đăng nhập bình
  // thường — nghi do ảnh gốc nặng, ảnh chụp điện thoại thường 5-15MB, nén 1 lần ở mức cố định (85%)
  // có thể vẫn ra file khá nặng với ảnh nhiều chi tiết). Giờ nén NHIỀU LƯỢT, hạ dần chất lượng tới khi
  // dưới ngưỡng mục tiêu (~900KB) hoặc hết lượt thử — giảm hẳn dữ liệu phải gửi lên, đỡ phụ thuộc vào
  // tốc độ đường truyền tải lên của khách.
  async function compressImageFile(file: File, maxDimension = 1800, quality = 0.85): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    // GIF động: canvas chỉ lấy được 1 khung hình tĩnh, sẽ mất hoạt ảnh — giữ nguyên gốc, không nén.
    if (file.type === "image/gif") return dataUrl;
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Không đọc được ảnh"));
        el.src = dataUrl;
      });
      const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return dataUrl;
      ctx.drawImage(img, 0, 0, width, height);

      // SỬA (phản hồi thật user: nén quá tay dễ làm AI nhận diện sai, nhất là ảnh nhân vật cần rõ nét
      // mặt) — nâng ngưỡng mục tiêu lên 1.5MB (trước 900KB) và sàn chất lượng thấp nhất lên 60% (trước
      // 40%, mức đó đã thấy rõ vết nén/vỡ khối). Đổi lại ảnh rất nặng sẽ không nén nhanh bằng trước,
      // nhưng ưu tiên đúng: chất lượng AI nhận diện quan trọng hơn vài giây tải lên.
      const TARGET_BYTES = 1.5 * 1024 * 1024;
      const qualitySteps = [quality, 0.75, 0.6];
      let best = canvas.toDataURL("image/jpeg", qualitySteps[0]);
      for (let i = 1; i < qualitySteps.length; i++) {
        // base64 nặng hơn byte gốc ~33% — ước lượng nhanh từ độ dài chuỗi, không cần decode lại.
        if (best.length * 0.75 <= TARGET_BYTES) break;
        best = canvas.toDataURL("image/jpeg", qualitySteps[i]);
      }
      return best;
    } catch {
      // Nén lỗi (trình duyệt cũ, ảnh hỏng...) — dùng ảnh gốc, không chặn khách tải lên.
      return dataUrl;
    }
  }

  // Sinh ảnh mask đen/trắng cùng kích thước ẢNH GỐC (naturalW/naturalH) từ N vùng chữ nhật đã khoanh
  // (toạ độ chuẩn hoá 0..1, mỗi vùng ứng với 1 nhân vật) — TẤT CẢ vùng đều tô trắng chung 1 ảnh (mask
  // không tự phân biệt vùng nào cho ai, xem lib/story-video.ts: describeMaskZonePosition dùng toạ độ
  // riêng để viết chỉ dẫn văn bản gán từng vùng cho đúng người). Dùng PNG (không nén mất dữ liệu) để
  // giữ đúng biên trắng/đen sắc nét.
  function generateLocationMaskDataUrl(
    rects: { x: number; y: number; w: number; h: number }[],
    naturalW: number,
    naturalH: number
  ): string {
    const canvas = document.createElement("canvas");
    canvas.width = naturalW;
    canvas.height = naturalH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, naturalW, naturalH);
    ctx.fillStyle = "white";
    rects.forEach((rect) => ctx.fillRect(rect.x * naturalW, rect.y * naturalH, rect.w * naturalW, rect.h * naturalH));
    return canvas.toDataURL("image/png");
  }

  function handleLocationMaskPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const bounds = e.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return; // khung chưa có kích thước (đang ẩn) — tránh chia cho 0 ra NaN
    const x = Math.min(Math.max((e.clientX - bounds.left) / bounds.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - bounds.top) / bounds.height, 0), 1);
    storyLocationMaskDragStartRef.current = { x, y };
    setStoryLocationMaskRect({ x, y, w: 0, h: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleLocationMaskPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = storyLocationMaskDragStartRef.current;
    if (!start) return;
    // Không còn nút chuột nào đang giữ = lượt kéo đã kết thúc (sự kiện nhả chuột bị mất, vd nhả ngoài khung
    // hoặc kéo nhanh) — nếu không dừng ở đây, cờ kéo bị kẹt và vùng tự chạy theo chuột khi chỉ rê qua ảnh.
    if (e.buttons === 0) {
      storyLocationMaskDragStartRef.current = null;
      return;
    }
    const bounds = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - bounds.left) / bounds.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - bounds.top) / bounds.height, 0), 1);
    setStoryLocationMaskRect({ x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) });
  }

  function handleLocationMaskPointerUp() {
    storyLocationMaskDragStartRef.current = null;
  }

  // 1 nhân vật (mặc định) — giữ đúng luồng cũ, đơn giản: vẽ xong 1 vùng, bấm là xong ngay, không cần
  // bước "Lưu vị trí" trung gian như luồng nhiều nhân vật bên dưới.
  function handleConfirmLocationMask() {
    if (!storyLocationMaskRect || !storyLocationImageNaturalSize) return;
    if (storyLocationMaskRect.w < STORY_MASK_MIN_FRACTION || storyLocationMaskRect.h < STORY_MASK_MIN_FRACTION) return; // vùng quá nhỏ, coi như chưa chọn
    const dataUrl = generateLocationMaskDataUrl([storyLocationMaskRect], storyLocationImageNaturalSize.w, storyLocationImageNaturalSize.h);
    setStoryLocationReferenceMaskUrl(dataUrl);
    // Lưu vùng đã chọn thành "vị trí của nhân vật #1" để vẽ đè lên ảnh Bối cảnh (cùng cơ chế nhiều nhân vật).
    setStoryLocationMaskAssignments([{ characterPosition: 0, rect: storyLocationMaskRect }]);
    setStoryLocationMaskEditorOpen(false);
  }

  // Khôi phục job 1 nhân vật: server chỉ lưu ẢNH mask (không lưu toạ độ) — dò lại hình chữ nhật trắng từ chính
  // ảnh mask để vẽ đè lên ảnh Bối cảnh. Lỗi (vd trình duyệt chặn đọc ảnh khác nguồn) thì bỏ qua, chỉ mất khung
  // vẽ đè, mask vẫn dùng bình thường.
  function restoreSingleMaskRect(maskUrl: string) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const scale = Math.min(1, 240 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let minX = w;
        let minY = h;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4] > 200) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return;
        setStoryLocationMaskAssignments((prev) =>
          prev.length > 0
            ? prev
            : [{ characterPosition: 0, rect: { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h } }]
        );
      } catch {}
    };
    img.src = maskUrl;
  }

  // NHIỀU nhân vật — lưu vùng vừa vẽ cho ĐÚNG nhân vật đang chọn (storyLocationMaskActiveCharacter),
  // ghi đè nếu người đó đã có vùng trước đó, rồi tự chuyển sang nhân vật kế tiếp CHƯA có vùng (nếu
  // còn) để khách không phải tự bấm chọn từng người theo đúng thứ tự.
  function handleSaveLocationMaskAssignment(characterOptions: { position: number; label: string }[]) {
    if (!storyLocationMaskRect) return;
    if (storyLocationMaskRect.w < STORY_MASK_MIN_FRACTION || storyLocationMaskRect.h < STORY_MASK_MIN_FRACTION) return;
    const rect = storyLocationMaskRect;
    storyLocationMaskDragStartRef.current = null;
    const updatedAssignments = [
      ...storyLocationMaskAssignments.filter((a) => a.characterPosition !== storyLocationMaskActiveCharacter),
      { characterPosition: storyLocationMaskActiveCharacter, rect },
    ];
    commitLocationMaskAssignments(updatedAssignments);
    const assignedPositions = new Set(updatedAssignments.map((a) => a.characterPosition));
    const next = characterOptions.find((c) => !assignedPositions.has(c.position));
    if (next) {
      // Còn người chưa gán — chuyển sang người đó, ô vẽ để trống chờ khách vẽ mới cho người này.
      setStoryLocationMaskActiveCharacter(next.position);
      setStoryLocationMaskRect(null);
    } else {
      // SỬA (xác nhận thật qua ảnh chụp khách gửi): trước đây luôn setStoryLocationMaskRect(null) ở
      // đây — khi vừa lưu xong NGƯỜI CUỐI CÙNG (không còn ai chưa gán), ô vừa vẽ bị xoá trắng ngay lập
      // tức dù đã lưu thành công (chip vẫn có ✓), khiến khách tưởng nhầm "vị trí chưa lưu" vì không
      // thấy ô nào trên ảnh cho tới khi bấm lại đúng chip đó. Giữ nguyên ô vừa vẽ hiển thị luôn thay vì
      // xoá trắng khi không còn ai để tự động chuyển sang.
      setStoryLocationMaskRect(rect);
    }
  }

  // Đặt danh sách vị trí mới VÀ sinh lại ảnh mask ngay (không chờ bấm "Xong") — mask gửi lên server luôn khớp
  // đúng các vị trí đang hiện trên ảnh, không có tình trạng "đã lưu vị trí nhưng mask cũ/thiếu".
  function commitLocationMaskAssignments(next: { characterPosition: number; rect: { x: number; y: number; w: number; h: number } }[]) {
    setStoryLocationMaskAssignments(next);
    if (next.length === 0 || !storyLocationImageNaturalSize) {
      setStoryLocationReferenceMaskUrl(null);
      return;
    }
    setStoryLocationReferenceMaskUrl(
      generateLocationMaskDataUrl(
        next.map((a) => a.rect),
        storyLocationImageNaturalSize.w,
        storyLocationImageNaturalSize.h
      )
    );
  }

  function handleRemoveLocationMaskAssignment(characterPosition: number) {
    commitLocationMaskAssignments(storyLocationMaskAssignments.filter((a) => a.characterPosition !== characterPosition));
    if (characterPosition === storyLocationMaskActiveCharacter) setStoryLocationMaskRect(null);
  }

  // Gộp mọi vùng đã "Lưu vị trí" thành 1 ảnh mask duy nhất, đóng khung chọn — dùng cho luồng NHIỀU
  // nhân vật (nút "Xong"). Không làm gì nếu chưa gán vùng nào (giữ nguyên mask cũ nếu có, hoặc vẫn null).
  function handleFinishLocationMask() {
    if (storyLocationMaskAssignments.length === 0 || !storyLocationImageNaturalSize) {
      setStoryLocationMaskEditorOpen(false);
      return;
    }
    const dataUrl = generateLocationMaskDataUrl(
      storyLocationMaskAssignments.map((a) => a.rect),
      storyLocationImageNaturalSize.w,
      storyLocationImageNaturalSize.h
    );
    setStoryLocationReferenceMaskUrl(dataUrl);
    setStoryLocationMaskEditorOpen(false);
  }

  function handleClearLocationMask() {
    setStoryLocationReferenceMaskUrl(null);
    setStoryLocationMaskRect(null);
    setStoryLocationMaskAssignments([]);
    setStoryLocationMaskActiveCharacter(0);
  }

  // Khôi phục job dở dang — dựng lại storyLocationMaskAssignments từ dữ liệu server (chỉ có ở job
  // nhiều nhân vật) để khách "Chọn lại vị trí đứng" vẫn thấy đúng các vùng đã gán trước đó.
  function restoreLocationMaskZones(zones: unknown) {
    if (!Array.isArray(zones)) return;
    const assignments = zones
      .filter(
        (z): z is { position: number; xPct: number; yPct: number; wPct: number; hPct: number } =>
          !!z && typeof z === "object" && typeof (z as Record<string, unknown>).position === "number"
      )
      .map((z) => ({ characterPosition: z.position, rect: { x: z.xPct, y: z.yPct, w: z.wPct, h: z.hPct } }));
    if (assignments.length > 0) setStoryLocationMaskAssignments(assignments);
  }

  async function uploadOutfitSwapImage(dataUrl: string): Promise<string> {
    // Nút "+" ở prompt bar mới cho bấm tải ảnh TRƯỚC khi đăng nhập (chỉ nút "Tạo" cuối mới chặn đăng
    // nhập) — trước đây dùng user!.id (ép bỏ qua kiểm tra null) nên khách chưa đăng nhập bấm "+" tải
    // ảnh bị crash thẳng "Cannot read properties of null (reading 'id')" thay vì thấy lỗi dễ hiểu.
    if (!user) throw new Error("Vui lòng đăng nhập trước khi tải ảnh lên");
    return uploadImageDirect(dataUrl, "/api/outfit-swap/upload", "outfit-swap-uploads");
  }
  function pollStoryVideoStatus(jobId: number) {
    storyPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();

        if (Array.isArray(data.scenes)) setStoryScenes(data.scenes);
        if (Array.isArray(data.scenePreviews)) setStoryScenePreviews(data.scenePreviews);
        if (data.characterAngleUrls) setStoryCharacterAngleUrlsForPreview(data.characterAngleUrls);
        setStoryStatus(data.status ?? null);
        if (data.characterSheetUrl) setStoryCharacterSheetUrl(data.characterSheetUrl);
        if (data.characterSource) setStoryCharacterSource(data.characterSource);
        setStoryJobCharacters(Array.isArray(data.characters) ? data.characters : null);
        if (data.locationReferenceUrl) setStoryLocationReference(data.locationReferenceUrl);
        if (data.locationReferenceMaskUrl) setStoryLocationReferenceMaskUrl(data.locationReferenceMaskUrl);
        restoreLocationMaskZones(data.locationReferenceMaskZones);

        if (data.status === "done" && data.outputUrl) {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryResult(data.outputUrl);
          setStoryRunning(false);
          setStoryStatusText(null);
        } else if (data.status === "scenes_ready") {
          // Dừng poll — job đang chờ khách xem preview bố cục MIỄN PHÍ (chưa tốn credit) rồi tự bấm
          // "Tạo ảnh" (handleContinueToImages), không có gì chạy ngầm nữa.
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryRunning(false);
          setStoryStatusText(data.statusText ?? null);
        } else if (data.status === "character_ready") {
          // Dừng poll — job đang chờ khách xem/duyệt ảnh Character, tự bấm "Tạo lại" hoặc
          // "Tiếp tục chia cảnh", không có gì chạy ngầm nữa.
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryRunning(false);
          setStoryStatusText(data.statusText ?? null);
        } else if (data.status === "images_ready") {
          // Dừng poll — job đang chờ khách xem ảnh và tự bấm "Tạo video", không có gì chạy ngầm nữa.
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryRunning(false);
          setStoryStatusText(data.statusText ?? null);
        } else if (data.status === "failed" || data.status === "cancelled") {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryError(
            data.status === "cancelled" ? data.errorMessage ?? "Đã dừng theo yêu cầu của bạn" : data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn"
          );
          setStoryRunning(false);
          setStoryStatusText(null);
        } else if (data.statusText) {
          setStoryStatusText(data.statusText);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  // Poll riêng cho tạo lại 1 cảnh — khác pollStoryVideoStatus vì job.status đã ở "images_ready"/"failed"
  // từ trước (không đổi khi tạo lại 1 cảnh), nên không thể dùng chung vòng poll đó (nó dừng ngay lập
  // tức khi thấy status "images_ready"). CHỈ cập nhật storyScenes khi ảnh cảnh này đã có url mới —
  // không cập nhật lúc còn null, tránh làm lệch storySceneImages (effect đồng bộ lọc bỏ null nên 1
  // cảnh null giữa chừng sẽ làm co mảng, dịch chuyển sai vị trí các ảnh khác). Ảnh cũ vẫn hiện nguyên
  // (kèm overlay đang xử lý) cho tới khi có ảnh mới thay hẳn.
  function pollSceneRegenerate(jobId: number, sceneId: number) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();
        const scene = Array.isArray(data.scenes)
          ? data.scenes.find((s: { id: number; imageUrl: string | null }) => s.id === sceneId)
          : null;
        if (scene?.imageUrl) {
          setStoryScenes(data.scenes);
          clearInterval(interval);
          setStoryRegeneratingSceneId((cur) => (cur === sceneId ? null : cur));
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
    setTimeout(() => {
      clearInterval(interval);
      setStoryRegeneratingSceneId((cur) => (cur === sceneId ? null : cur));
    }, 120000);
  }

  async function handleRegenerateScene(sceneId: number) {
    if (!user || !storyJobId) return;
    setStoryRegeneratingSceneId(sceneId);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, sceneId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingSceneId(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      pollSceneRegenerate(storyJobId, sceneId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingSceneId(null);
    }
  }

  // Poll cho tạo lại ảnh chế độ chuyển động liên tục — theo dõi VỊ TRÍ (không phải sceneId, xem
  // handleRegenerateContinuousScene) vì ảnh mới có thể được ghi vào 1 cảnh KHÁC (cảnh liền trước) rồi
  // copy sang image_url của đúng vị trí này.
  function pollContinuousSceneRegenerate(jobId: number, position: number, previousUrl: string | null) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();
        const scene = Array.isArray(data.scenes)
          ? data.scenes.find((s: { position: number; imageUrl: string | null }) => s.position === position)
          : null;
        if (scene?.imageUrl && scene.imageUrl !== previousUrl) {
          setStoryScenes(data.scenes);
          clearInterval(interval);
          setStoryRegeneratingContinuousPosition((cur) => (cur === position ? null : cur));
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
    setTimeout(() => {
      clearInterval(interval);
      setStoryRegeneratingContinuousPosition((cur) => (cur === position ? null : cur));
    }, 120000);
  }

  async function handleRegenerateContinuousScene(position: number) {
    if (!user || !storyJobId) return;
    const previousUrl = storyScenes?.find((s) => s.position === position)?.imageUrl ?? null;
    setStoryRegeneratingContinuousPosition(position);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-continuous-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: storyJobId, position }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingContinuousPosition(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      pollContinuousSceneRegenerate(storyJobId, position, previousUrl);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingContinuousPosition(null);
    }
  }

  // "Kiểm tra thiếu chi thể" — nút thủ công, không trừ credit, gọi trực tiếp qua sceneId+imageUrl.
  async function handleCheckSceneAnatomy(sceneId: number, imageUrl: string) {
    setStoryAnatomyChecking((prev) => ({ ...prev, [sceneId]: true }));
    try {
      const res = await fetch("/api/story-video/check-scene-anatomy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, miniAppId: "video-tu-y-tuong" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra khi kiểm tra");
        return;
      }
      setStoryAnatomyResults((prev) => ({ ...prev, [sceneId]: { ok: data.ok, issue: data.issue } }));
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryAnatomyChecking((prev) => ({ ...prev, [sceneId]: false }));
    }
  }

  // "Kiểm tra lệch ảnh đầu/cuối" — chỉ áp dụng cảnh có đủ image_url + endImageUrl (chuyển động liên
  // tục), không trừ credit.
  async function handleCheckSceneContinuity(sceneId: number, startImageUrl: string, endImageUrl: string) {
    setStoryContinuityChecking((prev) => ({ ...prev, [sceneId]: true }));
    try {
      const res = await fetch("/api/story-video/check-scene-continuity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startImageUrl, endImageUrl, miniAppId: "video-tu-y-tuong" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra khi kiểm tra");
        return;
      }
      setStoryContinuityResults((prev) => ({ ...prev, [sceneId]: { ok: data.ok, issue: data.issue } }));
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryContinuityChecking((prev) => ({ ...prev, [sceneId]: false }));
    }
  }

  // Poll riêng cho tạo lại VIDEO 1 cảnh — cùng khuôn pollSceneRegenerate (ảnh) nhưng theo dõi videoUrl
  // thay vì imageUrl. job.status không đổi khi tạo lại 1 cảnh (có thể đã "done" từ trước), nên không
  // dùng chung pollStoryVideoStatus (nó dừng ngay khi thấy "done").
  function pollSceneVideoRegenerate(jobId: number, sceneId: number) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();
        const scene = Array.isArray(data.scenes)
          ? data.scenes.find((s: { id: number; videoUrl: string | null }) => s.id === sceneId)
          : null;
        if (scene?.videoUrl) {
          setStoryScenes(data.scenes);
          clearInterval(interval);
          setStoryRegeneratingVideoSceneId((cur) => (cur === sceneId ? null : cur));
          // Server có thể đã ghép lại thành video cuối mới (khi tất cả cảnh đã có video) -> lấy luôn
          // outputUrl mới nhất để khách thấy đúng bản đã cập nhật, không phải bản ghép cũ.
          if (data.status === "done" && data.outputUrl) setStoryResult(data.outputUrl);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
    setTimeout(() => {
      clearInterval(interval);
      setStoryRegeneratingVideoSceneId((cur) => (cur === sceneId ? null : cur));
    }, 180000);
  }

  async function handleRegenerateSceneVideo(sceneId: number, customPrompt?: string) {
    if (!user || !storyJobId) return;
    setStoryRegeneratingVideoSceneId(sceneId);
    setStoryEditingPromptSceneId(null);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-scene-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, sceneId, customPrompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingVideoSceneId(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      pollSceneVideoRegenerate(storyJobId, sceneId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingVideoSceneId(null);
    }
  }

  async function handleRegenerateCharacter() {
    if (!user || !storyJobId) return;
    setStoryRegeneratingCharacter(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingCharacter(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryRegeneratingCharacter(false);
      setStoryRunning(true);
      setStoryCharacterSheetUrl(null);
      setStoryStatusText("Đang tạo lại ảnh Character...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingCharacter(false);
    }
  }

  // Tạo lại Character của ĐÚNG 1 người trong job nhiều nhân vật — mirror handleRegenerateCharacter()
  // nhưng nhắm đúng 1 "position", các người khác trong lưới giữ nguyên ảnh cũ.
  async function handleRegenerateJobCharacter(position: number) {
    if (!user || !storyJobId) return;
    setStoryRegeneratingJobCharacterPosition(position);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-job-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId, position }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingJobCharacterPosition(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryRunning(true);
      setStoryStatusText("Đang tạo lại ảnh Character...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingJobCharacterPosition(null);
    }
  }

  async function handleCheckCharacterImage() {
    if (storyCharacterImages.length === 0) return;
    setStoryCheckingImage(true);
    setStoryImageCheckResult(null);
    try {
      // Kiểm tra TOÀN BỘ ảnh đã tải — chỉ báo "đã là Character" khi TẤT CẢ đều là sheet sẵn.
      // Ảnh đã có URL thật (vd job dở dang được khôi phục) thì dùng thẳng, chỉ upload ảnh base64 mới.
      const imageUrls = await Promise.all(
        storyCharacterImages.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img)))
      );
      const res = await fetch("/api/story-video/classify-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrls }),
      });
      const data = await res.json();
      setStoryImageCheckResult(res.ok && data.isSheet ? "sheet" : "photo");
    } catch {
      setStoryImageCheckResult(null);
    } finally {
      setStoryCheckingImage(false);
    }
  }

  async function handleSaveCharacter() {
    if (!user || !storyCharacterSheetUrl) return;
    setStorySavingCharacter(true);
    setStorySavedCharacterMsg(null);
    try {
      const res = await fetch("/api/story-video/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, imageUrl: storyCharacterSheetUrl, jobId: storyJobId ?? undefined }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.id) {
        setStorySavedCharacterMsg("Đã lưu vào thư viện Character.");
        // Chuyển ô "Ảnh nhân vật" sang hiển thị đúng Character vừa lưu (thay vì còn giữ ảnh thường gốc
        // đã tải lên) — khách không cần tự chọn lại từ thư viện, thấy ngay đây là Character đang dùng.
        const sheetUrl = storyCharacterSheetUrl;
        setStorySavedCharacters((prev) => [...prev, { id: data.id, imageUrl: sheetUrl, label: null }]);
        setStorySelectedSavedCharacterId(data.id);
        setStoryCharacterImages([]);
        loadSavedStoryCharacters(user.id);
      } else {
        setStorySavedCharacterMsg("Không lưu được, thử lại.");
      }
    } catch {
      setStorySavedCharacterMsg("Không kết nối được tới server");
    } finally {
      setStorySavingCharacter(false);
    }
  }

  async function handleContinueToScenes() {
    if (!user || !storyJobId || !input.trim()) return;
    setStoryContinuingScenes(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/continue-to-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          jobId: storyJobId,
          modelChatKey: storyModelChatKey,
          storyDescription: input.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryContinuingScenes(false);
        return;
      }
      // newBalance null = luồng 1 nhân vật, chưa trừ credit (chỉ chia cảnh, xem preview miễn phí trước) —
      // không cần phát sự kiện cập nhật số dư vì số dư chưa đổi. Luồng nhiều nhân vật vẫn trừ ngay như
      // cũ nên vẫn phát sự kiện bình thường.
      if (data.newBalance !== null) window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuingScenes(false);
      setStoryRunning(true);
      setStoryStatusText("Đang chia phân cảnh...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuingScenes(false);
    }
  }

  // Bước 2 của preview miễn phí (luồng 1 nhân vật) — khách đã xem bố cục Agent chọn ở status
  // "scenes_ready", bấm "Tạo ảnh" mới thật sự trừ credit + gọi model ảnh.
  async function handleContinueToImages() {
    if (!user || !storyJobId) return;
    setStoryContinuingImages(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/continue-to-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryContinuingImages(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuingImages(false);
      setStoryRunning(true);
      setStoryStatusText(`Đang tạo ảnh cho ${storyScenePreviews?.length ?? numScenes} phân cảnh...`);
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuingImages(false);
    }
  }

  async function handleContinueToVideo() {
    if (!user || !storyJobId) return;
    setStoryActiveButton("video");
    setStoryContinuing(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/continue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryContinuing(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuing(false);
      setStoryRunning(true);
      setStoryStatusText("Đang tạo video cho từng phân cảnh...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuing(false);
    }
  }

  // Khách chấp nhận bỏ cảnh mãi không tạo video được (vd bị model chặn nội dung) — ghép video cuối
  // chỉ từ các cảnh đã có video, không chờ đủ tất cả cảnh nữa.
  // Khách chủ động bấm "Dừng tạo" khi job đang chạy dở — dừng hẳn, xem cancelStoryVideoJob() trong
  // lib/story-video.ts (KHÔNG hoàn credit các cảnh đã tốn trước đó, đúng lựa chọn của khách).
  async function handleCancelStoryVideo() {
    if (!user || !storyJobId) return;
    if (storyPollRef.current) clearInterval(storyPollRef.current);
    setStoryCancelling(true);
    try {
      const res = await fetch("/api/story-video/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra khi dừng job");
        setStoryCancelling(false);
        return;
      }
      setStoryStatus("cancelled");
      setStoryError("Đã dừng theo yêu cầu của bạn");
      setStoryRunning(false);
      setStoryStatusText(null);
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryCancelling(false);
    }
  }

  async function handleFinalizePartial() {
    if (!user || !storyJobId) return;
    setStoryFinalizingPartial(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/finalize-partial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryFinalizingPartial(false);
        return;
      }
      setStoryRunning(true);
      setStoryStatusText("Đang ghép video từ các cảnh đã có...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryFinalizingPartial(false);
    }
  }

  // ================= Video NHIỀU CHƯƠNG (dự án) =================
  // Model không hỗ trợ tỉ lệ đã khoá theo chương 1 thì ẩn khỏi dropdown (không thì đổi model sẽ phá khoá).
  function modelSupportsLockedRatio(m: { aspect_ratios?: string[] }): boolean {
    return !storyLockedAspectRatio || !m.aspect_ratios || m.aspect_ratios.includes(storyLockedAspectRatio);
  }
  async function handleToggleMultiChapter(enabled: boolean) {
    setStoryProjectError(null);
    if (!enabled) {
      setStoryMultiChapter(false);
      return;
    }
    setStoryMultiChapter(true);
    setStoryActiveChapter(0);
    try {
      let projectId = storyProjectId;
      if (projectId === null) {
        const res = await fetch("/api/story-video/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ miniAppId: app!.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Không tạo được dự án");
        projectId = data.projectId as number;
        setStoryProjectId(projectId);
      }
      // Trang đã có sẵn 1 job (vd job vừa khôi phục sau khi tải lại trang, hoặc đang chạy dở) — gắn luôn làm
      // Chương 1 để khách không phải bỏ nó đi làm lại từ đầu.
      if (storyJobId !== null) {
        const res = await fetch("/api/story-video/projects/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, jobId: storyJobId, chapterIndex: 0 }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Không gắn được video hiện tại vào dự án");
        }
      }
    } catch (err) {
      setStoryMultiChapter(false);
      setStoryProjectError(err instanceof Error ? err.message : "Không tạo được dự án");
    }
  }
  // Đưa MỌI ô của form về trạng thái trống cho chương mới. GIỮ LẠI (khách vẫn sửa được): model ảnh/video, độ
  // phân giải/thời lượng, model chat, thể loại, tự động tạo video, chuyển động liên tục/frame-chain, tỉ lệ khung
  // hình (khoá theo chương 1). Ảnh nhân vật, ảnh bối cảnh, vật phẩm, ý tưởng, kịch bản, cảnh, video: xoá hết.
  function resetStoryFormForNextChapter() {
    if (storyPollRef.current) clearInterval(storyPollRef.current);
    setInput("");
    setNumScenes(3);
    setSceneCountChosen(false);
    setStoryScriptActions(null);
    setStoryScriptScenes(null);
    setStoryScriptTotalSeconds(null);
    setStoryScriptVideoCreditCost(null);
    setStoryScriptLoading(false);
    setStoryScriptError(null);
    setStorySpeedDrafts({});
    setStorySpeedFinalized(false);
    setStorySpeedLoading(false);
    setStoryCharacterImages([]);
    setStoryExtraCharacters([]);
    setStoryPrimaryCharacterLabel("");
    setStoryCharacterInputMode("photo");
    setStoryCharacterAppearanceDescription("");
    setStoryLocationReference(null);
    setStoryLocationReferenceMaskUrl(null);
    setStoryLocationMaskRect(null);
    setStoryLocationMaskEditorOpen(false);
    setStoryLocationImageNaturalSize(null);
    setStoryLocationMaskAssignments([]);
    setStoryLocationMaskActiveCharacter(0);
    setStoryPrimaryItemReferences([]);
    setStorySkipCharacterCreation(false);
    setStoryUseOwnSceneImages(false);
    setStorySceneImages([]);
    setStorySceneHints([]);
    setStoryCharacterSheetUrl(null);
    setStoryCharacterSource(null);
    setStoryRegeneratingCharacter(false);
    setStoryJobCharacters(null);
    setStoryRegeneratingJobCharacterPosition(null);
    setStoryContinuingScenes(false);
    setStorySavingCharacter(false);
    setStorySavedCharacterMsg(null);
    setStorySelectedSavedCharacterId(null);
    setStoryCheckingImage(false);
    setStoryImageCheckResult(null);
    setStoryRunning(false);
    setStoryContinuing(false);
    setStoryFinalizingPartial(false);
    setStoryCancelling(false);
    setStoryActiveButton(null);
    setStoryStatusText(null);
    setStoryStatus(null);
    setStoryJobId(null);
    setStoryScenes(null);
    setStoryRegeneratingSceneId(null);
    setStoryRegeneratingContinuousPosition(null);
    setStoryAnatomyChecking({});
    setStoryAnatomyResults({});
    setStoryContinuityChecking({});
    setStoryContinuityResults({});
    setStoryRegeneratingVideoSceneId(null);
    setStoryEditingPromptSceneId(null);
    setStoryEditedPrompt("");
    setStoryResult(null);
    setStoryError(null);
    setStoryQuickZoomUrl(null);
    setSuggestingScenes(false);
    setSceneSuggestError(null);
  }
  async function handleNextChapter() {
    if (storyProjectId === null || !storyJobId || !storyResult) return;
    if (storyActiveChapter + 1 >= STORY_MAX_CHAPTERS) return;
    const finished: StoryProjectChapter = {
      chapterIndex: storyActiveChapter,
      jobId: storyJobId,
      outputUrl: storyResult,
      title: input.trim().slice(0, 80),
    };
    // Tỉ lệ khoá theo chương 1 — lấy từ server (tỉ lệ job chương 1 THỰC SỰ dùng), lỗi mạng thì dùng tỉ lệ đang chọn.
    let locked = storyLockedAspectRatio ?? storyAspectRatio;
    try {
      const res = await fetch(`/api/story-video/projects?projectId=${storyProjectId}`);
      const data = await res.json();
      if (res.ok && data.project?.aspectRatio) locked = data.project.aspectRatio;
    } catch {}
    setStoryProjectChapters((prev) => [...prev.filter((c) => c.chapterIndex !== finished.chapterIndex), finished]);
    setStoryLockedAspectRatio(locked);
    setStoryAspectRatio(locked);
    resetStoryFormForNextChapter();
    setStoryActiveChapter(finished.chapterIndex + 1);
    setStoryViewChapter(null);
    setTimeout(() => storyFormTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  async function handleFinishProject() {
    if (storyProjectId === null || storyProjectFinalizing) return;
    setStoryProjectFinalizing(true);
    setStoryProjectError(null);
    try {
      const res = await fetch("/api/story-video/projects/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: storyProjectId, transitions: storyChapterTransitions }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Không ghép được video");
      setStoryProjectFinalUrl(data.finalOutputUrl);
      setTimeout(() => storyProjectFinalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (err) {
      setStoryProjectError(err instanceof Error ? err.message : "Không ghép được video");
    } finally {
      setStoryProjectFinalizing(false);
    }
  }
  // Dự án đã kết thúc -> bắt đầu dự án mới (form trống, quay về chế độ thường; khách bật lại nếu muốn nhiều chương).
  function handleNewProject() {
    resetStoryFormForNextChapter();
    setStoryProjectChapters([]);
    setStoryProjectFinalUrl(null);
    setStoryLockedAspectRatio(null);
    setStoryViewChapter(null);
    setStoryActiveChapter(0);
    setStoryProjectId(null);
    setStoryMultiChapter(false);
    setStoryProjectError(null);
    setStoryChapterTransitions([]);
    setTimeout(() => storyFormTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  // Khôi phục dự án dở dang sau khi tải lại trang — dựng lại tab chương từ database (chương đang soạn dở mà
  // chưa bấm chạy thì không có gì để khôi phục, giống hành vi 1 job đơn hiện tại).
  function restoreStoryProject(
    project: {
      id: number;
      status: string;
      aspectRatio: string | null;
      finalOutputUrl: string | null;
      chapters: { chapterIndex: number; jobId: number; status: string; outputUrl: string | null; storyDescription: string | null }[];
    },
    activeIndex: number | null
  ) {
    const active = activeIndex ?? project.chapters.length;
    setStoryMultiChapter(true);
    setStoryProjectId(project.id);
    setStoryActiveChapter(active);
    setStoryProjectChapters(
      project.chapters
        .filter((c) => c.chapterIndex !== active && c.status === "done" && c.outputUrl)
        .map((c) => ({ chapterIndex: c.chapterIndex, jobId: c.jobId, outputUrl: c.outputUrl as string, title: (c.storyDescription ?? "").slice(0, 80) }))
    );
    if (active > 0 && project.aspectRatio) {
      setStoryLockedAspectRatio(project.aspectRatio);
      setStoryAspectRatio(project.aspectRatio);
    }
    if (project.status === "done" && project.finalOutputUrl) setStoryProjectFinalUrl(project.finalOutputUrl);
  }

  async function handleRunStoryVideo() {
    const images = storyCharacterImages;
    const reuseId = storySelectedSavedCharacterId;
    // Bước này thường chỉ tạo Character, chưa cần Ý tưởng truyện — thứ đó bắt buộc ở bước "Tiếp tục
    // chia cảnh" sau. NGOẠI LỆ: khi dùng Character đã lưu từ thư viện (biết chắc 100%, không cần AI
    // kiểm tra lại), server sẽ chạy thẳng 1 lượt luôn tới chia cảnh nếu đã có Ý tưởng truyện — nên bắt
    // buộc nhập trước ở đây để chắc chắn kích hoạt được đường tắt đó (ảnh thường vẫn không cần, vì
    // server không biết trước có phải toàn bộ ảnh đã là sheet hay không).
    const hasMultipleCharacters = storyExtraCharacters.length > 0;
    // Chế độ "Mô tả bằng chữ" — không có ảnh, AI tự vẽ từ mô tả này (xem storyCharacterInputMode). Mỗi
    // nhân vật (kể cả #2+ bên dưới) độc lập chọn ảnh thật hoặc mô tả chữ.
    const usesAppearanceDescription = storyCharacterInputMode === "text" && !!storyCharacterAppearanceDescription.trim();
    if (!user || (!reuseId && !usesAppearanceDescription && images.length === 0) || !storyImageModelKey || !storyVideoModelKey) return;
    if (reuseId && !input.trim()) return;
    if (storyMultiChapter && storyProjectId === null) {
      setStoryError("Chưa tạo được dự án nhiều chương — bỏ tick rồi tick lại ô \"Video nhiều chương\"");
      return;
    }
    if (
      hasMultipleCharacters &&
      storyExtraCharacters.some(
        (s) => !s.reuseId && s.images.length === 0 && !(s.inputMode === "text" && s.appearanceDescription.trim())
      )
    ) {
      setStoryError("Có nhân vật chưa tải ảnh — xoá bớt hoặc tải ảnh cho đủ trước khi chạy");
      return;
    }
    // Luồng mặc định (1 nhân vật, AI tự vẽ ảnh, KHÔNG own-images) bắt buộc phải có kịch bản đã xác nhận
    // trước — đảm bảo giá hiện lúc "Tạo kịch bản" luôn khớp với giá thật lúc submit (không chia cảnh
    // ngầm bằng số cảnh cũ/mặc định nếu khách quên bấm nút). Own-images/nhiều nhân vật/chuyển động liên
    // tục/frame-chain không dùng bước kịch bản này (xem storyUsesScriptFlow).
    // 2 điều kiện TÁCH RIÊNG (trước đây gộp chung "input.trim() && !storyScriptActions" — khi ô Ý tưởng
    // truyện đang trống, cả cụm bị bỏ qua hoàn toàn vì short-circuit, cho lọt request preplannedActions=
    // null lên server và bị 400 "Danh sách hành động không hợp lệ"; xảy ra thật ở chế độ "AI tự vẽ" nhân
    // vật vì khách có thể điền xong mô tả nhân vật mà quên/chưa kịp viết Ý tưởng truyện).
    if (storyUsesScriptFlow && !input.trim()) {
      setStoryError("Nhập Ý tưởng truyện trước khi tạo ảnh phân cảnh");
      return;
    }
    if (storyUsesScriptFlow && (!storyScriptActions || storyScriptActions.length === 0)) {
      setStoryError('Bấm "Tạo kịch bản" trước khi tạo ảnh phân cảnh');
      return;
    }
    // Nếu khách bấm chạy ngay sau khi rời ô truyện, lượt gợi ý số cảnh (chạy nền từ onBlur) có thể
    // chưa kịp xong — tự đợi nốt ở đây, dùng biến cục bộ (không đọc numScenes từ state, tránh đọc
    // trúng giá trị cũ do setState là bất đồng bộ) để đảm bảo submit đúng số cảnh AI vừa tính. CHỈ áp
    // dụng luồng CHƯA nối kiến trúc "Tạo kịch bản" mới — luồng mặc định lấy thẳng số cảnh từ
    // storyScriptActions.length (đã set numScenes lúc "Tạo kịch bản" xong).
    let resolvedNumScenes = numScenes;
    if (!sceneCountChosen && !storyUseOwnSceneImages && !storyUsesScriptFlow && input.trim()) {
      const suggested = await fetchSuggestedSceneCount();
      if (suggested !== null) {
        resolvedNumScenes = suggested;
        setNumScenes(suggested);
        setSceneCountChosen(true);
      }
    }
    setStoryActiveButton("images");
    setStoryRunning(true);
    setStoryResult(null);
    setStoryError(null);
    setStoryScenes(null);
    setStoryStatus(null);
    setStoryJobId(null);
    setStoryCharacterSheetUrl(null);
    setStoryCharacterSource(null);
    setStorySavedCharacterMsg(null);

    let characterImageUrls: string[] = [];
    let primaryItemReferenceUrls: string[] = [];
    let characters:
      | {
          imageUrls: string[];
          reuseCharacterId?: number;
          skipCharacterCreation?: boolean;
          label?: string;
          itemReferenceUrls?: string[];
          appearanceDescription?: string;
        }[]
      | undefined;
    let locationReferenceUrl: string | undefined;
    let locationReferenceMaskUrl: string | undefined;
    if (!reuseId || storyPrimaryItemReferences.length > 0 || hasMultipleCharacters || storyLocationReference) {
      setStoryStatusText("Đang tải ảnh lên...");
      try {
        // Gộp TẤT CẢ lượt tải ảnh (nhân vật #1, vật phẩm #1, từng nhân vật phụ, địa điểm) vào 1 lượt
        // Promise.all duy nhất thay vì 4 khối await tuần tự như trước — mỗi khối trước đây chờ khối
        // trước xong mới bắt đầu dù hoàn toàn độc lập với nhau, cộng dồn thời gian chờ (vd 4 khối x
        // ~2-3s = 8-12s+), khiến khách cảm thấy "tải ảnh lâu". Giờ chạy song song, tổng thời gian chỉ
        // còn bằng khối chậm nhất thay vì tổng cả 4 khối.
        const [characterImageUrlsResult, primaryItemReferenceUrlsResult, extraUploaded, locationReferenceUrlResult, locationReferenceMaskUrlResult] =
          await Promise.all([
          // Ảnh đã có URL thật (vd job dở dang được khôi phục) thì dùng thẳng, chỉ upload ảnh base64 mới.
          !reuseId
            ? Promise.all(images.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img))))
            : Promise.resolve<string[]>([]),
          storyPrimaryItemReferences.length > 0
            ? Promise.all(storyPrimaryItemReferences.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img))))
            : Promise.resolve<string[]>([]),
          // Job nhiều nhân vật — tải ảnh của từng nhân vật phụ (#2, #3, #4), gộp cùng nhân vật #1 thành
          // mảng "characters" gửi server. Mỗi nhân vật tự tải ảnh + vật phẩm SONG SONG (không tuần tự).
          hasMultipleCharacters
            ? Promise.all(
                storyExtraCharacters.map(async (slot) => {
                  const [slotImages, slotItemImages] = await Promise.all([
                    slot.reuseId
                      ? Promise.resolve<string[]>([])
                      : Promise.all(slot.images.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img)))),
                    Promise.all(slot.itemImages.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img)))),
                  ]);
                  return {
                    imageUrls: slotImages,
                    reuseCharacterId: slot.reuseId ?? undefined,
                    label: slot.label.trim() || undefined,
                    itemReferenceUrls: slotItemImages,
                    appearanceDescription:
                      !slot.reuseId && slot.inputMode === "text" ? slot.appearanceDescription.trim() || undefined : undefined,
                  };
                })
              )
            : Promise.resolve(undefined),
          // Ảnh Bối cảnh/Địa điểm (tuỳ chọn, dùng chung cho cả job) — tải lên nếu là ảnh mới (base64),
          // dùng thẳng nếu đã là URL thật (job khôi phục dở dang).
          storyLocationReference
            ? storyLocationReference.startsWith("http")
              ? Promise.resolve(storyLocationReference)
              : uploadOutfitSwapImage(storyLocationReference)
            : Promise.resolve(undefined),
          // Vị trí đứng chính xác (mask đen/trắng, xem storyLocationReferenceMaskUrl) — mirror đúng cách
          // tải ảnh Bối cảnh ở trên: dùng thẳng nếu đã là URL thật (job khôi phục dở dang), tải lên nếu
          // là data URL PNG vừa sinh ra ở trình duyệt.
          storyLocationReferenceMaskUrl
            ? storyLocationReferenceMaskUrl.startsWith("http")
              ? Promise.resolve(storyLocationReferenceMaskUrl)
              : uploadOutfitSwapImage(storyLocationReferenceMaskUrl)
            : Promise.resolve(undefined),
        ]);
        characterImageUrls = characterImageUrlsResult;
        primaryItemReferenceUrls = primaryItemReferenceUrlsResult;
        if (hasMultipleCharacters && extraUploaded) {
          characters = [
            {
              imageUrls: reuseId ? [] : characterImageUrls,
              reuseCharacterId: reuseId ?? undefined,
              skipCharacterCreation: !reuseId && storySkipCharacterCreation,
              label: storyPrimaryCharacterLabel.trim() || undefined,
              itemReferenceUrls: primaryItemReferenceUrls,
              appearanceDescription: usesAppearanceDescription ? storyCharacterAppearanceDescription.trim() : undefined,
            },
            ...extraUploaded,
          ];
        }
        locationReferenceUrl = locationReferenceUrlResult;
        locationReferenceMaskUrl = locationReferenceMaskUrlResult;
      } catch (err) {
        setStoryError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }
    }

    setStoryStatusText(reuseId ? "Đang chuẩn bị Character đã lưu..." : "AI đang kiểm tra ảnh nhân vật...");

    try {
      const res = await fetch("/api/story-video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          miniAppId: app!.id,
          storyDescription: input.trim(),
          numScenes: resolvedNumScenes,
          characterImageUrls,
          imageModelKey: storyImageModelKey,
          videoModelKey: storyVideoModelKey,
          autoVideo: storyAutoVideo,
          aspectRatio: storyAspectRatio,
          resolutionKey: storyResolutionKey,
          // Luồng dùng bước "Tạo kịch bản" đã khoá thời lượng riêng từng cảnh qua preplannedActions —
          // bỏ qua dropdown phẳng cũ (đã ẩn khỏi UI cho đúng luồng này). Own-images/nhiều nhân vật/
          // chuyển động liên tục/frame-chain vẫn gửi bình thường (chưa nối kiến trúc kịch bản mới).
          durationKey: storyUsesScriptFlow ? undefined : storyDurationKey,
          modelChatKey: storyModelChatKey,
          reuseCharacterId: reuseId ?? undefined,
          skipCharacterCreation: !reuseId && storySkipCharacterCreation,
          genreKey: storyGenreKey !== "default" ? storyGenreKey : undefined,
          characters,
          locationReferenceUrl,
          locationReferenceMaskUrl,
          // Nhiều nhân vật, nhiều vị trí — chỉ có ý nghĩa khi job nhiều nhân vật (server tự bỏ qua khi
          // không phải nhánh đó). Dữ liệu thuần toạ độ, không cần upload — gửi thẳng trong JSON.
          locationReferenceMaskZones:
            hasMultipleCharacters && storyLocationMaskAssignments.length > 0
              ? storyLocationMaskAssignments.map((a) => ({
                  position: a.characterPosition,
                  xPct: a.rect.x,
                  yPct: a.rect.y,
                  wPct: a.rect.w,
                  hPct: a.rect.h,
                }))
              : undefined,
          itemReferenceUrls: primaryItemReferenceUrls,
          continuousMotion: storyContinuousMotion,
          frameChainMode: storyFrameChainMode,
          preplannedActions: storyUsesScriptFlow && !hasMultipleCharacters ? storyScriptActions : undefined,
          preplannedActionsMulti: storyUsesScriptFlow && hasMultipleCharacters ? storyScriptActions : undefined,
          characterAppearanceDescription: usesAppearanceDescription ? storyCharacterAppearanceDescription.trim() : undefined,
          projectId: storyMultiChapter ? (storyProjectId ?? undefined) : undefined,
          chapterIndex: storyMultiChapter ? storyActiveChapter : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setStoryJobId(data.jobId);
      setStoryStatusText("Đang xử lý ảnh Character...");
      pollStoryVideoStatus(data.jobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRunning(false);
      setStoryStatusText(null);
    }
  }

  // Khách đã có sẵn ảnh cho từng phân cảnh — bỏ qua hoàn toàn bước Character + AI tạo ảnh, chỉ tốn
  // credit video. Agent tự viết mô tả chuyển động cho từng ảnh (gợi ý của khách chỉ là hỗ trợ thêm).
  async function handleRunStoryVideoWithOwnImages(forceAutoVideo?: boolean) {
    if (!user || !input.trim() || !storyVideoModelKey || storySceneImages.length < STORY_MIN_SCENES) return;
    if (storyMultiChapter && storyProjectId === null) {
      setStoryError("Chưa tạo được dự án nhiều chương — bỏ tick rồi tick lại ô \"Video nhiều chương\"");
      return;
    }
    setStoryActiveButton("video");
    setStoryRunning(true);
    setStoryResult(null);
    setStoryError(null);
    setStoryScenes(null);
    setStoryStatus(null);
    setStoryJobId(null);
    setStoryCharacterSheetUrl(null);
    setStoryCharacterSource(null);
    setStorySavedCharacterMsg(null);

    setStoryStatusText("Đang tải ảnh phân cảnh lên...");
    let sceneImageUrls: string[];
    try {
      // Ảnh đã là URL thật (vd đồng bộ từ 1 job trước qua storyScenes) thì dùng thẳng, không tải lại —
      // uploadOutfitSwapImage chỉ nhận đúng ảnh còn ở dạng base64 mới từ máy (chưa có URL thật).
      sceneImageUrls = await Promise.all(storySceneImages.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img))));
    } catch (err) {
      setStoryError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
      setStoryRunning(false);
      setStoryStatusText(null);
      return;
    }

    setStoryStatusText("Agent đang viết mô tả chuyển động cho từng ảnh...");

    try {
      const res = await fetch("/api/story-video/submit-own-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          miniAppId: app!.id,
          storyDescription: input.trim(),
          sceneImages: sceneImageUrls.map((imageUrl, i) => ({ imageUrl, hint: storySceneHints[i]?.trim() || undefined })),
          videoModelKey: storyVideoModelKey,
          autoVideo: forceAutoVideo ?? storyAutoVideo,
          aspectRatio: storyAspectRatio,
          durationKey: storyDurationKey,
          modelChatKey: storyModelChatKey,
          projectId: storyMultiChapter ? (storyProjectId ?? undefined) : undefined,
          chapterIndex: storyMultiChapter ? storyActiveChapter : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setStoryJobId(data.jobId);
      setStoryStatusText("Agent đang viết mô tả chuyển động cho từng ảnh...");
      pollStoryVideoStatus(data.jobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRunning(false);
      setStoryStatusText(null);
    }
  }

  // ----- Giao diện mới dạng "prompt bar" (xem D:\giao diên app\video1.jpg) -----
  // Lớp UI mới này KHÔNG xoá state/handler cũ ở trên (vẫn cần khi nối lại pipeline thật ở đợt sau) —
  // chỉ thêm state RIÊNG cho shell mới: ảnh tham chiếu đính kèm thẳng vào prompt (nút "+"/"@"), tab
  // hình ảnh/video, và modal chọn ảnh kiểu Higgsfield (xem components/reference-elements/ReferencePickerModal).
  const [promptMediaTab, setPromptMediaTab] = useState<"hinh-anh" | "video">("video");
  const [promptImages, setPromptImages] = useState<string[]>([]);
  // Loại + tên của ảnh gắn vào prompt khi ảnh đó đến từ kho tham chiếu (keyed theo url) — ảnh tải thô
  // ở tab "Tải lên" không có mặt trong map này (coi như không rõ loại). Dùng để biết ảnh nào là "địa
  // điểm" khi khách bấm phóng to, mở thêm khung "Chọn vị trí đứng" cho các nhân vật cũng đang gắn sẵn.
  const [promptImageMeta, setPromptImageMeta] = useState<Record<string, { type: "character" | "location" | "prop"; name: string }>>({});
  const [zoomedPromptImage, setZoomedPromptImage] = useState<string | null>(null);
  // Vị trí đứng của từng nhân vật trên 1 ảnh địa điểm cụ thể — keyed theo [locationUrl][characterUrl],
  // toạ độ chuẩn hoá 0..1 (x/y tính từ góc trên-trái ảnh). Cài 1 lần, dùng lại mọi lần sau khi cùng
  // ảnh địa điểm + nhân vật đó được gắn chung vào 1 prompt (xem mục 18-19 kế hoạch đã lưu memory).
  const [locationPositions, setLocationPositions] = useState<Record<string, Record<string, { x: number; y: number }>>>({});
  const [positionEditorActiveChar, setPositionEditorActiveChar] = useState<string | null>(null);
  // Kết quả gọi Fal.ai (ước lượng độ sâu) cho từng ảnh địa điểm — keyed theo url, chỉ gọi 1 lần/ảnh
  // (cache lại ở đây), KHÔNG tự gọi lúc gắn ảnh — chỉ gọi khi khách chủ động bấm nút "Dựng khối 3D"
  // trong khung chọn vị trí (đã bàn kỹ: gọi sớm quá dễ tốn tiền cho ảnh khách chỉ gắn thử).
  const [locationBlockout, setLocationBlockout] = useState<
    Record<
      string,
      { status: "loading" | "done" | "error"; depthImageUrl?: string | null; groundMaskUrl?: string | null; error?: string }
    >
  >({});

  async function handleBuildLocationBlockout(imageUrl: string) {
    if (locationBlockout[imageUrl]?.status === "loading" || locationBlockout[imageUrl]?.status === "done") return;
    setLocationBlockout((prev) => ({ ...prev, [imageUrl]: { status: "loading" } }));
    try {
      const res = await fetch("/api/story-video/location-blockout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi dựng khối 3D");
      setLocationBlockout((prev) => ({
        ...prev,
        [imageUrl]: { status: "done", depthImageUrl: data.depthImageUrl, groundMaskUrl: data.groundMaskUrl },
      }));
    } catch (err) {
      setLocationBlockout((prev) => ({
        ...prev,
        [imageUrl]: { status: "error", error: err instanceof Error ? err.message : "Có lỗi xảy ra" },
      }));
    }
  }
  const POSITION_MARKER_COLORS = ["#10b981", "#0ea5e9", "#f59e0b", "#d946ef", "#ef4444"]; // tối đa 5 nhân vật, xem mục 18.4
  const [pickerModal, setPickerModal] = useState<{ defaultTab: "upload" | "reference" | "favorite"; forMention: boolean } | null>(null);
  const [createToast, setCreateToast] = useState<string | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  // "Cài đặt camera" — bảng Máy ảnh/Thấu kính/Khẩu độ (xem ảnh tham khảo Higgsfield). Áp dụng CHUNG
  // cho cả video, giống cơ chế máy quay/ánh sáng trước đó: không cần cột DB mới, chỉ ghép guidance
  // text vào cuối storyDescription lúc submit. "Tự động" (null) = không ghép gì, giữ hành vi cũ.
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [promptCameraBody, setPromptCameraBody] = useState<string | null>(null);
  const [promptCameraLens, setPromptCameraLens] = useState<string | null>(null);
  const [promptCameraAperture, setPromptCameraAperture] = useState<string | null>(null);

  type CameraPreset = { key: string; label: string; guidance: string; icon: React.ReactNode };

  const CAMERA_BODY_PRESETS: CameraPreset[] = [
    {
      key: "phim-8mm",
      label: "Phim 8mm",
      guidance: "quay bằng máy phim 8mm cổ điển, hạt phim nhẹ, màu ám vàng hoài niệm",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="7" cy="8" r="3" />
          <circle cx="17" cy="8" r="3" />
          <path d="M9.5 10.5L12 16l2.5-5.5" />
          <rect x="9" y="16" width="6" height="4" rx="1" />
        </svg>
      ),
    },
    {
      key: "phim-35mm",
      label: "Phim 35mm",
      guidance:
        "quay bằng máy phim 35mm chuẩn điện ảnh, hạt phim tinh tế, màu sắc ấm tự nhiên, độ tương phản đặc trưng của phim nhựa — sắc nét và chuyên nghiệp hơn hẳn phim 8mm nghiệp dư",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <rect x="3" y="8" width="18" height="11" rx="2" />
          <path d="M8 8l1.5-3h5L16 8" />
          <circle cx="12" cy="13.5" r="3.5" />
          <circle cx="18" cy="10.5" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      key: "may-quay-dv",
      label: "Máy quay DV",
      guidance: "quay bằng máy quay DV cầm tay kiểu thập niên 2000, chất lượng video thô mộc",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <rect x="3" y="9" width="11" height="8" rx="1.5" />
          <path d="M14 11.5l6-2.5v9l-6-2.5" />
          <rect x="6" y="6" width="5" height="3" rx="0.5" />
        </svg>
      ),
    },
    {
      key: "tu-dong",
      label: "Tự động",
      guidance: "",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <rect x="3" y="7" width="18" height="12" rx="2" />
          <circle cx="12" cy="13" r="3.5" />
          <path d="M8 7l1.2-2h5.6L16 7" />
        </svg>
      ),
    },
  ];

  const CAMERA_LENS_PRESETS: CameraPreset[] = [
    {
      key: "sach-se-sac-net",
      label: "Sạch sẽ và sắc nét",
      guidance: "ống kính sạch sắc nét, chi tiết rõ ràng, không méo mó",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.5" />
          <path d="M9 4l1-1.5M15 4l-1-1.5" />
        </svg>
      ),
    },
    {
      key: "bien-dang",
      label: "Biến dạng",
      guidance: "ống kính fisheye biến dạng nhẹ ở rìa khung hình",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" />
          <path d="M6 9c3 2 9 2 12 0M6 15c3-2 9-2 12 0" />
        </svg>
      ),
    },
    {
      key: "halation-vintage",
      label: "Halation Vintage",
      guidance: "ống kính cổ điển có quầng sáng (halation) quanh nguồn sáng, cảm giác retro",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" strokeDasharray="2 2" />
          <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" opacity="0.5" />
        </svg>
      ),
    },
    {
      key: "tu-dong",
      label: "Tự động",
      guidance: "",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      ),
    },
  ];

  const CAMERA_APERTURE_PRESETS: CameraPreset[] = [
    {
      key: "f1-4",
      label: "f/1.4 Mở tối đa",
      guidance: "khẩu độ mở tối đa f/1.4, hậu cảnh xoá mờ sâu (bokeh mạnh)",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="6.5" fill="currentColor" opacity="0.35" stroke="none" />
        </svg>
      ),
    },
    {
      key: "f4-vua-phai",
      label: "f/4 Vừa phải",
      guidance: "khẩu độ vừa phải f/4, hậu cảnh hơi mờ, chủ thể vẫn nổi bật",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.5" fill="currentColor" opacity="0.35" stroke="none" />
        </svg>
      ),
    },
    {
      key: "f11-lay-net-sau",
      label: "f/11 Lấy nét sâu",
      guidance: "khẩu độ khép nhỏ f/11, lấy nét sâu, toàn cảnh đều rõ nét",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      key: "tu-dong",
      label: "Tự động",
      guidance: "",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 6v3M12 15v3M6 12h3M15 12h3" />
        </svg>
      ),
    },
  ];

  const selectedCameraLabels = [
    CAMERA_BODY_PRESETS.find((p) => p.key === promptCameraBody)?.label,
    CAMERA_LENS_PRESETS.find((p) => p.key === promptCameraLens)?.label,
    CAMERA_APERTURE_PRESETS.find((p) => p.key === promptCameraAperture)?.label,
  ].filter((l): l is string => !!l);

  // "Cài đặt màu" — cùng cơ chế preset-chung-cho-cả-video như camera: không làm phần editor đầy đủ
  // của Higgsfield (tạo bảng màu từ ảnh/bánh xe màu tuỳ chỉnh, lưu bảng màu riêng) — chỉ chọn 1 trong
  // các preset màu có sẵn, ghép guidance vào storyDescription lúc submit, không cần DB mới.
  const [colorModalOpen, setColorModalOpen] = useState(false);
  const [promptColorPalette, setPromptColorPalette] = useState<string | null>(null);

  type ColorPreset = { key: string; label: string; guidance: string; swatches: string[] };

  const COLOR_PALETTE_PRESETS: ColorPreset[] = [
    {
      key: "am-ap-hoai-co",
      label: "Ấm áp hoài cổ",
      guidance: "tông màu ấm áp hoài cổ, cam-vàng chủ đạo, cảm giác hoài niệm",
      swatches: ["#D97A3D", "#E8B45C", "#8B4A2B"],
    },
    {
      key: "lanh-dien-anh",
      label: "Lạnh điện ảnh",
      guidance: "tông màu lạnh điện ảnh, xanh dương-xanh lục (teal-orange) chuyên nghiệp",
      swatches: ["#2A6F7A", "#1B3A4B", "#4FA3B0"],
    },
    {
      key: "den-trang-co-dien",
      label: "Đen trắng cổ điển",
      guidance: "hình ảnh đen trắng cổ điển, tương phản rõ, không màu",
      swatches: ["#1a1a1a", "#808080", "#e5e5e5"],
    },
    {
      key: "pastel-nhe-nhang",
      label: "Pastel nhẹ nhàng",
      guidance: "tông màu pastel nhẹ nhàng, sáng dịu, bão hoà thấp",
      swatches: ["#F2C6C6", "#C6E2F2", "#D6C6F2"],
    },
    {
      key: "ruc-ro-tuong-phan",
      label: "Rực rỡ tương phản cao",
      guidance: "màu sắc rực rỡ, bão hoà cao, tương phản mạnh, nổi bật",
      swatches: ["#E8294B", "#2BD4C4", "#F2C12E"],
    },
  ];

  // "Cài đặt ánh sáng" — bảng 3D thật (quả cầu + đèn kéo-thả được, có thể nhiều đèn), xem
  // components/story-video/LightSphereModal.tsx.
  const [lightModalOpen, setLightModalOpen] = useState(false);
  const [promptLights, setPromptLights] = useState<LightSettings[] | null>(null);

  // Chèn "@element_id " vào đúng vị trí con trỏ trong ô "viết prompt" — mục 8 trong spec (gõ "@" chèn
  // thẳng @mention, không chỉ chọn ảnh rời). Dùng lại state `input` đã có sẵn (prompt truyện).
  function insertMentionAtCursor(elementId: string) {
    const el = promptTextareaRef.current;
    const mentionText = `@${elementId} `;
    if (!el) {
      setInput((prev) => `${prev}${mentionText}`);
      return;
    }
    const start = el.selectionStart ?? input.length;
    const end = el.selectionEnd ?? input.length;
    const next = `${input.slice(0, start)}${mentionText}${input.slice(end)}`;
    setInput(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + mentionText.length;
      el.setSelectionRange(pos, pos);
    });
  }

  // Quét "@element_id" trong prompt (mirror extractMentionedElementIds ở lib/reference-elements.ts —
  // không import thẳng module đó vì nó kéo theo getSupabaseAdmin/service-role key vào bundle client,
  // dù hàm này không gọi tới, không nên đưa code server-only vào "use client").
  function extractMentionedElementIdsClient(text: string): string[] {
    const matches = text.match(/@([a-z0-9_]+)/g) ?? [];
    return Array.from(new Set(matches.map((m) => m.slice(1))));
  }

  // Nút "tạo" trong prompt bar mới (xem video1.jpg) — submit THẬT 1 job story-video, đơn giản hơn
  // handleRunStoryVideo cũ (không qua các bước Character/kịch bản riêng, đi thẳng "autoVideo"): đọc
  // @mention trong prompt -> tra kho tham chiếu (/api/reference-elements) -> gộp thành
  // characterImageUrls/characters/locationReferenceUrl/itemReferenceUrls -> submit.
  async function handlePromptCreate() {
    if (!user) {
      setCreateToast("Vui lòng đăng nhập trước khi tạo video");
      setTimeout(() => setCreateToast(null), 3500);
      router.push("/login");
      return;
    }
    if (!app) return;
    const rawText = input.trim();
    if (!rawText) {
      setCreateToast("Nhập prompt trước đã");
      setTimeout(() => setCreateToast(null), 3500);
      return;
    }
    if (!storyVideoModelKey) {
      setCreateToast("Chưa chọn model video");
      setTimeout(() => setCreateToast(null), 3500);
      return;
    }

    setStoryRunning(true);
    setStoryResult(null);
    setStoryError(null);
    setStoryJobId(null);
    setStoryStatus(null);
    setStoryStatusText("Đang chuẩn bị...");

    try {
      // 1) Tra các @mention trong prompt tới đúng element trong kho tham chiếu của khách.
      const mentionedIds = extractMentionedElementIdsClient(rawText);
      let elements: ReferenceElement[] = [];
      if (mentionedIds.length > 0) {
        const res = await fetch("/api/reference-elements");
        const data = await res.json();
        if (res.ok && Array.isArray(data.elements)) elements = data.elements;
      }
      const mentionedElements = elements.filter((el) => mentionedIds.includes(el.element_id));
      const characterElements = mentionedElements.filter((el) => el.type === "character");
      const locationElements = mentionedElements.filter((el) => el.type === "location");
      const propElements = mentionedElements.filter((el) => el.type === "prop");

      // 2) Thay "@id" bằng tên thật (vd "@lan đi dạo" -> "Lan đi dạo") để câu vẫn đọc tự nhiên cho
      // Agent — @id không khớp element nào thì giữ nguyên nguyên văn (không chặn/crash).
      const foundById = new Map(mentionedElements.map((el) => [el.element_id, el]));
      const mentionStrippedText = rawText.replace(/@([a-z0-9_]+)/g, (full, id) => {
        const el = foundById.get(id);
        return el ? el.name : full;
      });
      // Gắn thêm chỉ dẫn máy ảnh/thấu kính/khẩu độ (nếu khách chọn ở modal "cài đặt camera") vào CUỐI
      // câu truyện — Agent chia cảnh đọc nguyên văn storyDescription nên chỉ cần ghép câu, không cần
      // cột DB riêng.
      const cameraNotes = [
        CAMERA_BODY_PRESETS.find((p) => p.key === promptCameraBody)?.guidance,
        CAMERA_LENS_PRESETS.find((p) => p.key === promptCameraLens)?.guidance,
        CAMERA_APERTURE_PRESETS.find((p) => p.key === promptCameraAperture)?.guidance,
      ].filter((n): n is string => !!n);
      const colorNote = COLOR_PALETTE_PRESETS.find((p) => p.key === promptColorPalette)?.guidance;
      let storyDescription = mentionStrippedText;
      if (cameraNotes.length > 0) storyDescription += `\n\n(Phong cách máy quay: ${cameraNotes.join(", ")}.)`;
      if (colorNote) storyDescription += `\n\n(Phong cách màu sắc: ${colorNote}.)`;
      if (promptLights && promptLights.length > 0) {
        const lightDescs = promptLights.map((l, i) => {
          const dirLabel = nearestLightQuickPosition(l.azimuth, l.elevation).label;
          const prefix = promptLights.length > 1 ? `Đèn ${i + 1}: ` : "";
          return `${prefix}hướng ${dirLabel.toLowerCase()}, độ sáng ${l.brightness}%, màu ${l.color}, độ lan toả ${l.spread}%`;
        });
        storyDescription += `\n\n(Ánh sáng: ${lightDescs.join("; ")}.)`;
      }

      // 3) Upload ảnh "+"-tải thêm trong session này (còn đang là data URL, chưa có URL thật).
      const uploadedPromptImages = await Promise.all(
        promptImages.map((img) => (img.startsWith("http") ? Promise.resolve(img) : uploadOutfitSwapImage(img)))
      );

      // 4) Gộp ảnh nhân vật — luồng 1 nhân vật (0 hoặc 1 @mention character) hay nhiều nhân vật (2+).
      const MAX_CHARACTER_IMAGES_CLIENT = 20; // đúng MAX_CHARACTER_IMAGES ở lib/story-video.ts
      let characterImageUrls: string[] = [];
      let characters:
        | { imageUrls: string[]; label?: string; itemReferenceUrls?: string[] }[]
        | undefined;

      if (characterElements.length >= 2) {
        // 2+ nhân vật -> luồng nhiều nhân vật, mỗi người 1 entry riêng. Ảnh "+" tải rời gộp hết vào
        // nhân vật ĐẦU TIÊN được mention (không rõ thuộc về ai nếu chia đều, gán vậy dễ hiểu hơn).
        characters = characterElements.map((el, i) => ({
          imageUrls: (i === 0 ? [...el.image_urls, ...uploadedPromptImages] : el.image_urls).slice(0, MAX_CHARACTER_IMAGES_CLIENT),
          label: el.name,
        }));
      } else if (characterElements.length === 1) {
        characterImageUrls = [...characterElements[0].image_urls, ...uploadedPromptImages].slice(0, MAX_CHARACTER_IMAGES_CLIENT);
      } else {
        // Không @mention nhân vật nào -> coi ảnh "+" tải rời là ảnh nhân vật (luồng cũ "tải ảnh trực
        // tiếp"), có thể rỗng (job không cần nhân vật).
        characterImageUrls = uploadedPromptImages;
      }

      if (characterElements.length < 2 && characterImageUrls.length === 0) {
        setCreateToast("Cần ít nhất 1 ảnh nhân vật — tải ảnh hoặc @ mention 1 nhân vật đã lưu");
        setTimeout(() => setCreateToast(null), 4000);
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }

      // 5) Địa điểm — chỉ hỗ trợ 1 địa điểm/job (backend chỉ nhận locationReferenceUrl đơn); @mention
      // nhiều hơn 1 địa điểm thì chỉ lấy cái đầu tiên, bỏ qua các cái sau.
      const locationReferenceUrl = locationElements[0]?.image_urls[0] || undefined;

      // 6) Vật phẩm — tối đa 3 (MAX_ITEM_REFERENCES).
      const itemReferenceUrls = propElements
        .map((el) => el.image_urls[0])
        .filter((u): u is string => !!u)
        .slice(0, 3);

      // 7) Model ảnh — không có dropdown riêng ở prompt bar mới, mặc định model đầu tiên trong catalog,
      // ưu tiên model hỗ trợ multi_image nếu job có >1 ảnh tham chiếu gộp lại (nhân vật/địa điểm/vật
      // phẩm) — mirror đúng điều kiện ở effect multi_image phía trên (storyExtraCharacters.length===0...).
      const combinedReferenceCount =
        (characters ? characters.length : characterImageUrls.length > 0 ? 1 : 0) +
        (locationReferenceUrl ? 1 : 0) +
        itemReferenceUrls.length;
      let imageModelKey = storyImageModelKey ?? storyImageModels[0]?.key ?? undefined;
      if ((characters || combinedReferenceCount > 1) && imageModelKey) {
        const current = storyImageModels.find((m) => m.key === imageModelKey);
        if (!current?.multi_image) {
          const fallback = storyImageModels.find((m) => m.multi_image);
          if (fallback) imageModelKey = fallback.key;
        }
      }

      // 8) Số cảnh — để Agent tự gợi ý theo nội dung truyện đã bỏ @mention, mặc định 3 nếu gợi ý lỗi.
      setStoryStatusText("Đang tính số phân cảnh...");
      const suggested = await fetchSuggestedSceneCount();
      const resolvedNumScenes = suggested ?? 3;

      // 9) Submit job thật — autoVideo=true (prompt bar mới là luồng "gõ rồi bấm tạo" 1 lượt, đi thẳng
      // tới video, không dừng ở bước xem ảnh phân cảnh như wizard cũ).
      setStoryStatusText("Đang gửi yêu cầu tạo video...");
      const res = await fetch("/api/story-video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          miniAppId: app.id,
          storyDescription,
          numScenes: resolvedNumScenes,
          characterImageUrls,
          characters,
          imageModelKey,
          videoModelKey: storyVideoModelKey,
          autoVideo: true,
          aspectRatio: storyAspectRatio,
          resolutionKey: storyResolutionKey,
          durationKey: storyDurationKey,
          locationReferenceUrl,
          itemReferenceUrls: itemReferenceUrls.length > 0 ? itemReferenceUrls : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setStoryJobId(data.jobId);
      setStoryStatusText("Đang xử lý ảnh Character...");
      pollStoryVideoStatus(data.jobId);
    } catch (err) {
      setStoryError(err instanceof Error ? err.message : "Không kết nối được tới server");
      setStoryRunning(false);
      setStoryStatusText(null);
    }
  }

  function pollPromptImageStatus(jobId: number) {
    promptImagePollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/prompt-image/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (promptImagePollRef.current) clearInterval(promptImagePollRef.current);
          setPromptImageResult(data.outputUrl);
          setPromptImageRunning(false);
          window.dispatchEvent(new Event("balance-updated"));
        } else if (data.status === "failed") {
          if (promptImagePollRef.current) clearInterval(promptImagePollRef.current);
          setPromptImageError(data.errorMessage ?? "Có lỗi xảy ra");
          setPromptImageRunning(false);
          window.dispatchEvent(new Event("balance-updated")); // credit đã hoàn lại
        }
      } catch {
        // lỗi mạng tạm thời — vòng poll tiếp theo thử lại, không dừng hẳn
      }
    }, 3000);
  }

  // Nút "tạo" ở tab "hình ảnh" — sinh 1 ảnh TRỰC TIẾP từ prompt (khác hẳn handlePromptCreate ở trên,
  // vốn luôn tạo VIDEO qua luồng kịch bản/phân cảnh). Dùng đúng cùng 1 ô prompt + ảnh tham chiếu đã
  // tải ở "+" (promptImages), nhưng gửi tới job sinh ảnh riêng (lib/prompt-image.ts).
  //
  // Trước đây tab này KHÔNG tra @mention trong prompt — gõ "@mai" chỉ đi thẳng dạng chữ, không lấy
  // được ảnh thật của Mai. Giờ mirror đúng bước 1-2 trong handlePromptCreate ở trên: quét @mention ->
  // tra kho tham chiếu -> thay @id bằng tên thật trong câu + gộp ảnh của element đó vào imageUrls gửi
  // cho model (prompt-image.ts không phân biệt nhân vật/địa điểm/vật phẩm như story-video, chỉ 1 mảng
  // imageUrls duy nhất, nên gộp chung tất cả loại element được mention).
  async function handlePromptImageCreate() {
    if (!user) {
      setCreateToast("Vui lòng đăng nhập trước khi tạo ảnh");
      setTimeout(() => setCreateToast(null), 3500);
      router.push("/login");
      return;
    }
    const rawText = input.trim();
    if (!rawText) {
      setCreateToast("Nhập prompt trước đã");
      setTimeout(() => setCreateToast(null), 3500);
      return;
    }

    setPromptImageRunning(true);
    setPromptImageResult(null);
    setPromptImageError(null);

    try {
      const mentionedIds = extractMentionedElementIdsClient(rawText);
      let elements: ReferenceElement[] = [];
      if (mentionedIds.length > 0) {
        const res = await fetch("/api/reference-elements");
        const data = await res.json();
        if (res.ok && Array.isArray(data.elements)) elements = data.elements;
      }
      const mentionedElements = elements.filter((el) => mentionedIds.includes(el.element_id));
      const foundById = new Map(mentionedElements.map((el) => [el.element_id, el]));
      const mentionStrippedText = rawText.replace(/@([a-z0-9_]+)/g, (full, id) => {
        const el = foundById.get(id);
        return el ? el.name : full;
      });

      const MAX_REFERENCE_IMAGES_CLIENT = 20; // đúng MAX_CHARACTER_IMAGES ở lib/story-video.ts
      const elementImageUrls = mentionedElements.flatMap((el) => el.image_urls);
      const uploadedPromptImages = await Promise.all(
        promptImages.map((img) => (img.startsWith("http") ? Promise.resolve(img) : uploadOutfitSwapImage(img)))
      );
      const imageUrls = [...elementImageUrls, ...uploadedPromptImages].slice(0, MAX_REFERENCE_IMAGES_CLIENT);

      // >1 ảnh tham chiếu gộp lại -> cần model hỗ trợ multi_image, mirror đúng điều kiện ở
      // handlePromptCreate (dòng ~2614-2621) để không bị lỗi khi model đang chọn chỉ nhận 1 ảnh.
      let imageModelKey = storyImageModelKey ?? storyImageModels[0]?.key ?? undefined;
      if (imageUrls.length > 1 && imageModelKey) {
        const current = storyImageModels.find((m) => m.key === imageModelKey);
        if (!current?.multi_image) {
          const fallback = storyImageModels.find((m) => m.multi_image);
          if (fallback) imageModelKey = fallback.key;
        }
      }

      const res = await fetch("/api/prompt-image/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: mentionStrippedText,
          imageUrls,
          modelKey: imageModelKey,
          aspectRatio: storyAspectRatio,
          resolutionKey: storyResolutionKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPromptImageError(data.error ?? "Có lỗi xảy ra");
        setPromptImageRunning(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      pollPromptImageStatus(data.jobId);
    } catch (err) {
      setPromptImageError(err instanceof Error ? err.message : "Không kết nối được tới server");
      setPromptImageRunning(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-black text-zinc-100">
      {/* Sidebar trái — xem video1.jpg. "Hình ảnh tham chiếu" trỏ sang trang quản lý kho tham chiếu đã
          có sẵn (/reference-elements); các mục còn lại chưa có trang đích riêng nên để dạng nút tĩnh
          (chrome bố cục, chưa phải navigation thật — đúng mô tả trong yêu cầu đợt này). */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-900 bg-zinc-800 p-5 lg:flex">
        {/* Logo "Video từ ý tưởng" — icon tròn thu nhỏ (không chữ, sidebar hẹp 240px), đặt trên cùng
            theo đúng vị trí thương hiệu chuẩn (góc trên-trái sidebar). */}
        <div className="mb-5 flex items-center gap-3">
          {/* viewBox cắt sát quanh khối tròn (trước đây dùng chung viewBox "0 0 680 320" của logo đầy đủ
              — khiến icon chỉ chiếm 1 góc nhỏ trong khung rộng, hiển thị bé tí dù width/height=32. Giờ
              cắt sát tâm (340,120) bán kính 92 nên icon lấp đầy khung, phóng to lên 48px mới thấy rõ. */}
          <svg width="48" height="48" viewBox="238 18 204 204" role="img" aria-label="Video từ ý tưởng">
            <defs>
              <linearGradient id="sidebarLogoGlow" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#22d3ee" />
                <stop offset="100%" stopColor="#d946ef" />
              </linearGradient>
              <radialGradient id="sidebarLogoBg" cx="35%" cy="30%" r="80%">
                <stop offset="0%" stopColor="#27272a" />
                <stop offset="100%" stopColor="#09090b" />
              </radialGradient>
            </defs>
            <circle cx="340" cy="120" r="92" fill="url(#sidebarLogoBg)" />
            <circle cx="340" cy="120" r="92" fill="none" stroke="url(#sidebarLogoGlow)" strokeWidth="6" opacity="0.9" />
            <path d="M312 78 L312 162 L376 120 Z" fill="url(#sidebarLogoGlow)" />
            <path d="M402 72 L408 86 L422 90 L408 94 L402 108 L396 94 L382 90 L396 86 Z" fill="#22d3ee" />
          </svg>
          <span className="text-base font-semibold leading-tight text-zinc-100">Không gian cho mọi ý tưởng</span>
        </div>
        <Link href="/" className="mb-6 text-sm font-medium text-zinc-400 hover:text-zinc-100">
          ← Danh mục
        </Link>
        <nav className="space-y-1 text-sm">
          <Link href="/" className="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-900 hover:text-white">
            trang chủ
          </Link>
          <span className="block rounded-lg border border-fuchsia-500/60 bg-zinc-700 px-3 py-2 font-medium text-fuchsia-400">không gian cho mọi ý tưởng</span>
          <Link href="/reference-elements" className="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-900 hover:text-white">
            hình ảnh tham chiếu
          </Link>
          <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-zinc-300 hover:bg-zinc-900 hover:text-white">
            Bộ sưu tập yêu thích
          </button>
          <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-zinc-300 hover:bg-zinc-900 hover:text-white">
            dự án của tôi
          </button>
          <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-zinc-300 hover:bg-zinc-900 hover:text-white">
            Tất cả các dự án
          </button>
        </nav>
        <div className="mt-auto flex items-center justify-between pt-4">
          <ThemeToggle />
          <div className="flex items-center gap-2">
            {/* Thêm nút đăng xuất — trước đây app không có cách nào đăng xuất từ giao diện (user phản
                hồi thật: không có nút đăng xuất), phải xoá cookie bằng tay/mở ẩn danh mới làm mới được
                phiên đăng nhập. signOut() đã có sẵn trong AuthProvider (lib/auth-context.tsx), chỉ
                thiếu chỗ gọi — xem app/wallet/page.tsx đã dùng y hệt. */}
            {user && (
              <button
                type="button"
                onClick={() => signOut()}
                className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              >
                Đăng xuất
              </button>
            )}
            <BalanceBadge />
          </div>
        </div>
      </aside>

      {/* Khối nội dung chính TÁCH RIÊNG khỏi sidebar — sidebar vuông góc, dính sát viền trang; khối
          này mới có bo góc + lề ngoài, nền sáng hơn (zinc-800) các khối con bên trong (zinc-900). */}
      <main className="m-3 min-w-0 flex-1 overflow-y-auto rounded-[32px] bg-zinc-700">
        <div className="mx-auto max-w-5xl px-6 py-8">
          {/* Carousel/slider — placeholder tĩnh, chưa cần logic carousel thật ở đợt này. */}
          <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex h-28 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-400 text-sm font-medium text-white shadow-lg"
              >
                carousel/slider
              </div>
            ))}
          </div>

          <h1 className="mb-6 text-center text-3xl font-bold text-white sm:text-4xl">Không gian cho mọi ý tưởng</h1>

          {/* Khối prompt chính — tab "video" dùng layout GỘP 1 khối duy nhất (tab toggle + hàng icon +
              ô prompt + hàng chip preset + nút "tạo" đều nằm trong 1 rounded-2xl box), đúng cấu trúc
              ảnh mẫu Higgsfield anh gửi (annotation mũi tên đỏ) thay vì tách cột tab riêng + box riêng
              + nút "tạo" đứng ngoài như trước. Thứ tự 2 hàng đã đảo theo mũi tên: hàng "+/@/🎥/model/
              1080/tỉ lệ/thời gian/âm thanh" nằm TRÊN (cùng dòng với tab toggle), hàng chip preset "tài
              liệu tham khảo/máy ảnh/bảng màu/ánh sáng/thiết lập phim tự động" nằm NGAY DƯỚI ô prompt.
              Tab "hình ảnh" CHƯA đổi — anh nói sẽ gửi ảnh mẫu riêng cho tab đó sau, nên giữ nguyên
              layout cũ (cột tab riêng bên trái + box riêng + nút "tạo" đứng ngoài) ở nhánh else. */}
          {promptMediaTab === "video" ? (
            <div className="flex flex-col gap-6">
              {/* KHỐI 1/2 — bản thiết kế có 2 khối riêng biệt (khối pill trên + khối box dưới), không
                  phải 1 khối gộp chung như bản trước. Khối này: tab toggle RIÊNG 1 DÒNG trên cùng (sát
                  góc trên-trái của khối), chip preset (tài liệu tham khảo/máy ảnh/bảng màu/ánh sáng/
                  thiết lập phim tự động) ở DÒNG RIÊNG bên dưới — đúng hướng mũi tên anh vẽ nhiều lần
                  (từ hàng chip chỉ lên khối tab, nghĩa là 2 dòng tách biệt, không chung 1 hàng). */}
              <div
                className="flex flex-col gap-2 rounded-[40px] border border-fuchsia-500/50 bg-zinc-800 pb-3 pl-1 pr-4 pt-0"
                style={{ boxShadow: "0 0 45px -4px rgba(217,70,239,0.75), 0 0 4px rgba(217,70,239,0.95)" }}
              >
                {/* Viền TRÊN của tab toggle phải trùng/sát viền trên của khối lớn — không có khoảng đệm
                    phía trên (pt-0 ở div cha), tab nằm sát ngay mép trong của viền ngoài. */}
                <div
                  className="flex w-fit items-center gap-1 rounded-full border border-fuchsia-500/60 bg-zinc-700 p-1"
                  style={{ boxShadow: "0 0 10px -2px rgba(217,70,239,0.6)" }}
                >
                  <button
                    type="button"
                    onClick={() => setPromptMediaTab("hinh-anh")}
                    className="rounded-full px-4 py-1.5 text-sm font-medium text-zinc-300 hover:text-zinc-100"
                  >
                    hình ảnh
                  </button>
                  <button type="button" className="rounded-full bg-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-900">
                    video
                  </button>
                </div>

                <div className="ml-[95px] flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPickerModal({ defaultTab: "reference", forMention: false })}
                  className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                >
                  tài liệu tham khảo
                </button>

                <button
                  type="button"
                  onClick={() => setCameraModalOpen(true)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="1.5" className="h-4 w-4 shrink-0">
                    <rect x="3" y="7" width="18" height="13" rx="2" />
                    <path d="M8 7l2-3h4l2 3" />
                    <circle cx="12" cy="13.5" r="3.2" />
                  </svg>
                  máy ảnh
                </button>

                <button
                  type="button"
                  onClick={() => setColorModalOpen(true)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0">
                    <circle cx="12" cy="12" r="9" fill="none" stroke="#22d3ee" strokeWidth="1.5" />
                    <path d="M12 3a9 9 0 0 1 9 9h-9z" fill="#22d3ee" />
                  </svg>
                  bảng màu
                </button>

                <button
                  type="button"
                  onClick={() => setLightModalOpen(true)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="1.5" className="h-4 w-4 shrink-0">
                    <circle cx="12" cy="12" r="5" />
                    <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
                  </svg>
                  ánh sáng
                </button>

                <button
                  type="button"
                  title="Sắp ra mắt"
                  className="rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                >
                  thiết lập phim tự động
                </button>
                </div>
              </div>

              {/* KHỐI 2/3 — ô "viết prompt" + icon toolbar — khối này KHÔNG viền tím (bình thường), đúng
                  ảnh mẫu: chỉ có khối chip (khối 1) và khối nút "Tạo" (khối 3) mới có viền neon, khối ô
                  prompt này chỉ là box tối thường, không glow. */}
              <div className="flex flex-col gap-3 rounded-[28px] bg-zinc-800 p-4">
                {promptImages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {promptImages.map((url, i) => (
                      <div
                        key={i}
                        role="button"
                        onClick={() => setZoomedPromptImage(url)}
                        className="group relative h-14 w-14 cursor-pointer overflow-hidden rounded-lg border border-zinc-700"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" className="h-full w-full object-cover" />
                        <span
                          role="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPromptImages((prev) => prev.filter((_, idx) => idx !== i));
                          }}
                          title="Xoá"
                          className="absolute right-1 top-1 hidden rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-600 group-hover:flex"
                        >
                          ✕
                        </span>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setPickerModal({ defaultTab: "upload", forMention: false })}
                      title="Thêm ảnh"
                      className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-zinc-600 text-lg text-zinc-400 hover:border-zinc-400 hover:text-zinc-200"
                    >
                      +
                    </button>
                  </div>
                )}
                <textarea
                  ref={promptTextareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="viết prompt"
                  rows={4}
                  className="w-full resize-none bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                />

                {/* Hàng dưới ô prompt — icon toolbar (+/@/🎥/model/1080p/tỉ lệ), ĐÚNG vị trí ảnh mẫu.
                    Giữ thêm "thời gian" khi model cần chọn độ dài clip (chức năng thật, ảnh mẫu không
                    có vì model mặc định không cần) — "âm thanh" đã xoá hẳn vì vốn chỉ trang trí, không
                    có chức năng gì. */}
                <div className="flex flex-wrap items-center gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setPickerModal({ defaultTab: "upload", forMention: false })}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-700 text-base text-zinc-200 hover:bg-zinc-600"
                  title="Tải ảnh lên"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setPickerModal({ defaultTab: "reference", forMention: true })}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-700 text-base text-zinc-200 hover:bg-zinc-600"
                  title="Chèn @mention từ kho tham chiếu"
                >
                  @
                </button>
                <button
                  type="button"
                  title="Thiết lập máy quay/ánh sáng — sắp ra mắt cho prompt bar"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-700 text-base text-zinc-200 hover:bg-zinc-600"
                >
                  🎥
                </button>

                {/* Khung viền bao quanh cụm model/độ phân giải/tỉ lệ — đúng ảnh mẫu (3 chip này đi
                    chung 1 khối có viền, tách biệt trực quan khỏi +/@/🎥 đứng riêng bên trái). */}
                <div className="flex items-center gap-2 rounded-full border border-zinc-600 p-1">
                {storyVideoModels.length > 0 && (
                  <select
                    value={storyVideoModelKey ?? ""}
                    onChange={(e) => setStoryVideoModelKey(e.target.value || null)}
                    className="h-9 rounded-full bg-zinc-700 px-3 text-xs text-zinc-200 outline-none"
                  >
                    <option value="">model</option>
                    {storyVideoModels.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}
                {storyVideoModels.length === 0 && (
                  <span className="flex h-9 items-center rounded-full bg-zinc-700 px-3 text-xs text-zinc-400">model</span>
                )}

                <span className="flex h-9 items-center rounded-full bg-zinc-700 px-3 text-xs text-zinc-400">{storyResolutionKey ?? "1080"}p</span>

                <select
                  value={storyAspectRatio}
                  onChange={(e) => setStoryAspectRatio(e.target.value)}
                  className="h-9 rounded-full bg-zinc-700 px-3 text-xs text-zinc-200 outline-none"
                >
                  {["16:9", "9:16", "1:1"].map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
                </div>

                {/* "thời gian" (chọn độ dài clip) CHỈ hiện khi model đang chọn thật sự có giá theo thời
                    lượng — ảnh mẫu không có chip này (model mặc định không cần chọn), và "âm thanh" đã
                    bỏ hẳn vì vốn chỉ là placeholder trang trí, không có chức năng gì (không onClick/
                    không select) — xoá đi khớp ảnh mẫu mà không mất tính năng thật nào. */}
                {storyVideoModels.find((m) => m.key === storyVideoModelKey)?.duration_price_vnd && (
                  <select
                    value={storyDurationKey ?? ""}
                    onChange={(e) => setStoryDurationKey(e.target.value || null)}
                    className="h-9 rounded-full bg-zinc-700 px-3 text-xs text-zinc-200 outline-none"
                  >
                    <option value="">thời gian</option>
                    {Object.keys(storyVideoModels.find((m) => m.key === storyVideoModelKey)?.duration_price_vnd ?? {}).map((key) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Nút "Tạo" — NẰM TRONG khối ô prompt (không tách khối riêng), nhưng tự nó có viền tím
                  ĐẬM (border dày, màu rõ) + nền màu tím NHẠT hơn viền (không phải đen/zinc-950 nữa). */}
              <button
                type="button"
                onClick={handlePromptCreate}
                disabled={storyRunning}
                style={{ boxShadow: "0 0 32px -3px rgba(217,70,239,0.8)" }}
                className="w-full rounded-full border-2 border-fuchsia-500 bg-fuchsia-500/20 py-3.5 text-base font-semibold text-white hover:bg-fuchsia-500/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {storyRunning ? "Đang tạo..." : "Tạo"}
              </button>
              </div>
            </div>
          ) : null}

          {promptMediaTab !== "video" && (
            <div className="flex flex-col gap-6">
              {/* KHỐI 1/2 tab "hình ảnh" — ĐÚNG cấu trúc tab "video": tab toggle riêng 1 dòng trên cùng
                  (sát góc trên-trái), chip cấu hình (character/camera/màu sắc) ở dòng riêng bên dưới,
                  cả khối viền tím phát sáng. */}
              <div
                className="flex flex-col gap-2 rounded-[40px] border border-fuchsia-500/50 bg-zinc-800 pb-3 pl-1 pr-4 pt-0"
                style={{ boxShadow: "0 0 45px -4px rgba(217,70,239,0.75), 0 0 4px rgba(217,70,239,0.95)" }}
              >
                <div
                  className="flex w-fit items-center gap-1 rounded-full border border-fuchsia-500/60 bg-zinc-700 p-1"
                  style={{ boxShadow: "0 0 10px -2px rgba(217,70,239,0.6)" }}
                >
                  <button
                    type="button"
                    className="rounded-full bg-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-900"
                  >
                    hình ảnh
                  </button>
                  <button
                    type="button"
                    onClick={() => setPromptMediaTab("video")}
                    className="rounded-full px-4 py-1.5 text-sm font-medium text-zinc-300 hover:text-zinc-100"
                  >
                    video
                  </button>
                </div>

                <div className="ml-[95px] flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPickerModal({ defaultTab: "reference", forMention: true })}
                    className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                    title="Chèn @mention nhân vật từ kho tham chiếu"
                  >
                    character
                  </button>
                  <button
                    type="button"
                    onClick={() => setCameraModalOpen(true)}
                    className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="1.5" className="h-4 w-4 shrink-0">
                      <rect x="3" y="7" width="18" height="13" rx="2" />
                      <path d="M8 7l2-3h4l2 3" />
                      <circle cx="12" cy="13.5" r="3.2" />
                    </svg>
                    camera
                  </button>
                  <button
                    type="button"
                    onClick={() => setColorModalOpen(true)}
                    className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0">
                      <circle cx="12" cy="12" r="9" fill="none" stroke="#22d3ee" strokeWidth="1.5" />
                      <path d="M12 3a9 9 0 0 1 9 9h-9z" fill="#22d3ee" />
                    </svg>
                    màu sắc
                  </button>

                  {/* Cụm "+/model/1080/tỉ lệ" — chuyển từ khối 2 lên đây theo yêu cầu (gộp chung vào
                      khối viền tím trên cùng với character/camera/màu sắc, không nằm ở khối ô prompt
                      bên dưới nữa). */}
                  <button
                    type="button"
                    onClick={() => setPickerModal({ defaultTab: "upload", forMention: false })}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-700 text-base text-zinc-200 hover:bg-zinc-600"
                    title="Tải ảnh lên"
                  >
                    +
                  </button>

                  <div className="flex items-center gap-2 rounded-full border border-zinc-600 p-1">
                    {storyImageModels.length > 0 ? (
                      <select
                        value={storyImageModelKey ?? ""}
                        onChange={(e) => setStoryImageModelKey(e.target.value || null)}
                        className="h-9 rounded-full bg-zinc-700 px-3 text-xs text-zinc-200 outline-none"
                      >
                        <option value="">model</option>
                        {storyImageModels.map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="flex h-9 items-center rounded-full bg-zinc-700 px-3 text-xs text-zinc-400">model</span>
                    )}

                    <span className="flex h-9 items-center rounded-full bg-zinc-700 px-3 text-xs text-zinc-400">{storyResolutionKey ?? "1080"}</span>

                    <select
                      value={storyAspectRatio}
                      onChange={(e) => setStoryAspectRatio(e.target.value)}
                      className="h-9 rounded-full bg-zinc-700 px-3 text-xs text-zinc-200 outline-none"
                    >
                      {["16:9", "9:16", "1:1"].map((ratio) => (
                        <option key={ratio} value={ratio}>
                          {ratio}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* KHỐI 2/2 tab "hình ảnh" — ô "viết prompt", không viền tím (đúng tab video); nút "Tạo"
                  dính liền cuối khối, có viền tím đậm + nền tím nhạt. */}
              <div className="flex flex-col gap-3 rounded-[28px] bg-zinc-800 p-4">
                {promptImages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {promptImages.map((url, i) => (
                      <div
                        key={i}
                        role="button"
                        onClick={() => setZoomedPromptImage(url)}
                        className="group relative h-14 w-14 cursor-pointer overflow-hidden rounded-lg border border-zinc-700"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" className="h-full w-full object-cover" />
                        <span
                          role="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPromptImages((prev) => prev.filter((_, idx) => idx !== i));
                          }}
                          title="Xoá"
                          className="absolute right-1 top-1 hidden rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-600 group-hover:flex"
                        >
                          ✕
                        </span>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setPickerModal({ defaultTab: "upload", forMention: false })}
                      title="Thêm ảnh"
                      className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-zinc-600 text-lg text-zinc-400 hover:border-zinc-400 hover:text-zinc-200"
                    >
                      +
                    </button>
                  </div>
                )}

                <textarea
                  ref={promptTextareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="viết prompt"
                  rows={4}
                  className="w-full resize-none bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                />

                <button
                  type="button"
                  onClick={handlePromptImageCreate}
                  disabled={promptImageRunning}
                  style={{ boxShadow: "0 0 32px -3px rgba(217,70,239,0.8)" }}
                  className="w-full rounded-full border-2 border-fuchsia-500 bg-fuchsia-500/20 py-3.5 text-base font-semibold text-white hover:bg-fuchsia-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {promptImageRunning ? "Đang tạo..." : "Tạo"}
                </button>
              </div>
            </div>
          )}

          {createToast && <p className="mt-3 text-center text-xs text-amber-400">{createToast}</p>}

          {/* Khu vực tiến trình/kết quả — hiện ngay dưới prompt bar sau khi bấm "tạo". */}
          {(storyRunning || storyResult || storyError) && (
            <div ref={storyResultRef} className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
              {storyRunning && (
                <div className="flex items-center justify-center gap-3 py-6 text-sm text-zinc-300">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-400" />
                  <span>{storyStatusText ?? "Đang xử lý..."}</span>
                </div>
              )}

              {!storyRunning && storyError && (
                <p className="text-center text-sm text-red-400">{storyError}</p>
              )}

              {!storyRunning && storyResult && (
                <div className="flex flex-col items-center gap-3">
                  <video
                    src={storyResult}
                    controls
                    className="max-h-[480px] w-full max-w-sm rounded-xl bg-black"
                  />
                  <a
                    href={storyResult}
                    download
                    className="rounded-full bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                  >
                    Tải video
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Khu vực tiến trình/kết quả cho tab "hình ảnh" — TÁCH RIÊNG khối trên (promptImageRunning/
              promptImageResult/promptImageError, không phải storyRunning/storyResult/storyError). */}
          {(promptImageRunning || promptImageResult || promptImageError) && (
            <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
              {promptImageRunning && (
                <div className="flex items-center justify-center gap-3 py-6 text-sm text-zinc-300">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-400" />
                  <span>Đang tạo ảnh...</span>
                </div>
              )}

              {!promptImageRunning && promptImageError && <p className="text-center text-sm text-red-400">{promptImageError}</p>}

              {!promptImageRunning && promptImageResult && (
                <div className="flex flex-col items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={promptImageResult} alt="" className="max-h-[480px] w-full max-w-sm rounded-xl bg-black object-contain" />
                  <a
                    href={promptImageResult}
                    download
                    className="rounded-full bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                  >
                    Tải ảnh
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {pickerModal && (
        <ReferencePickerModal
          defaultTab={pickerModal.defaultTab}
          onClose={() => setPickerModal(null)}
          compressImageFile={compressImageFile}
          uploadImage={uploadOutfitSwapImage}
          onAddImages={(urls) => setPromptImages((prev) => [...prev, ...urls])}
          onAddElementMeta={(items) =>
            setPromptImageMeta((prev) => {
              const next = { ...prev };
              for (const it of items) next[it.url] = { type: it.type, name: it.name };
              return next;
            })
          }
          onInsertMention={pickerModal.forMention ? insertMentionAtCursor : undefined}
          selectedUrls={promptImages}
        />
      )}

      {cameraModalOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          onClick={() => setCameraModalOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-800 text-zinc-100 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
              <h3 className="text-base font-semibold">Máy ảnh</h3>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setPromptCameraBody(null);
                    setPromptCameraLens(null);
                    setPromptCameraAperture(null);
                  }}
                  className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                >
                  Đặt lại tất cả
                </button>
                <button
                  onClick={() => setCameraModalOpen(false)}
                  className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* Sidebar — "Sự chuyển động" (camera movement) chưa làm ở đợt này, chỉ để chỗ. */}
              <div className="w-44 shrink-0 border-r border-zinc-800 p-3">
                <div className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium">
                  <span className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                      <rect x="3" y="7" width="18" height="12" rx="2" />
                      <circle cx="12" cy="13" r="3.5" />
                    </svg>
                    Cài đặt
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </div>
                <div className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-500" title="Sắp ra mắt">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                  Sự chuyển động
                </div>
              </div>

              <div className="grid flex-1 grid-cols-3 gap-4 overflow-y-auto p-5">
                {(
                  [
                    { title: "MÁY ẢNH", presets: CAMERA_BODY_PRESETS, selected: promptCameraBody, onSelect: setPromptCameraBody },
                    { title: "THẤU KÍNH", presets: CAMERA_LENS_PRESETS, selected: promptCameraLens, onSelect: setPromptCameraLens },
                    { title: "KHẨU ĐỘ", presets: CAMERA_APERTURE_PRESETS, selected: promptCameraAperture, onSelect: setPromptCameraAperture },
                  ] as const
                ).map((col) => (
                  <div key={col.title}>
                    <p className="mb-3 text-center text-[11px] font-semibold tracking-wide text-zinc-500">{col.title}</p>
                    <div className="flex flex-col gap-3">
                      {col.presets.map((p) => {
                        const isSelected = col.selected === p.key;
                        return (
                          <button
                            key={p.key}
                            type="button"
                            onClick={() => col.onSelect(isSelected ? null : p.key)}
                            className={`flex flex-col items-center gap-2 rounded-2xl border-2 px-2 py-4 ${
                              isSelected ? "border-white bg-zinc-900" : "border-transparent bg-zinc-900/60 hover:bg-zinc-900"
                            }`}
                          >
                            <span className={isSelected ? "text-white" : "text-zinc-500"}>{p.icon}</span>
                            <span className={`text-center text-[11px] font-medium leading-tight ${isSelected ? "text-white" : "text-zinc-500"}`}>
                              {p.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {colorModalOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          onClick={() => setColorModalOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-800 text-zinc-100 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
              <h3 className="text-base font-semibold">Bảng màu</h3>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setPromptColorPalette(null)}
                  className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                >
                  Đặt lại
                </button>
                <button
                  onClick={() => setColorModalOpen(false)}
                  className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 overflow-y-auto p-5 sm:grid-cols-3">
              {COLOR_PALETTE_PRESETS.map((p) => {
                const isSelected = promptColorPalette === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPromptColorPalette(isSelected ? null : p.key)}
                    className={`flex flex-col items-center gap-2 rounded-2xl border-2 p-3 ${
                      isSelected ? "border-white bg-zinc-900" : "border-transparent bg-zinc-900/60 hover:bg-zinc-900"
                    }`}
                  >
                    <span className="flex h-12 w-full overflow-hidden rounded-lg">
                      {p.swatches.map((c, i) => (
                        <span key={i} className="h-full flex-1" style={{ background: c }} />
                      ))}
                    </span>
                    <span className={`text-center text-xs font-medium leading-tight ${isSelected ? "text-white" : "text-zinc-400"}`}>
                      {p.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {lightModalOpen && (
        <LightSphereModal initial={promptLights} onClose={() => setLightModalOpen(false)} onApply={(settings) => setPromptLights(settings)} />
      )}

      {zoomedPromptImage &&
        (() => {
          const meta = promptImageMeta[zoomedPromptImage];
          const characters = promptImages
            .filter((u) => u !== zoomedPromptImage && promptImageMeta[u]?.type === "character")
            .slice(0, 5); // giới hạn 5 nhân vật — xem mục 18.4 kế hoạch đã lưu
          // SỬA (phản hồi thật user): trước đây bắt buộc phải có sẵn ≥1 nhân vật mới cho mở khung này —
          // nhưng khách muốn dựng khối 3D (địa hình) TRƯỚC, rồi mới gắn/chỉnh vị trí nhân vật SAU, không
          // cần ép thứ tự ngược lại. Bỏ điều kiện characters.length > 0 — chỉ cần đúng ảnh địa điểm.
          const isLocationEditor = meta?.type === "location";
          const assignments = locationPositions[zoomedPromptImage] ?? {};
          const activeChar = positionEditorActiveChar && characters.includes(positionEditorActiveChar) ? positionEditorActiveChar : characters[0];
          const blockoutForImage = locationBlockout[zoomedPromptImage];
          const show3DPanel = !!blockoutForImage?.depthImageUrl || Object.keys(assignments).length > 0;

          function handlePlaceMarker(e: React.MouseEvent<HTMLDivElement>) {
            if (!isLocationEditor || !activeChar) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            setLocationPositions((prev) => ({
              ...prev,
              [zoomedPromptImage as string]: { ...(prev[zoomedPromptImage as string] ?? {}), [activeChar]: { x, y } },
            }));
          }

          return (
            <div
              className="fixed inset-0 z-[10000] flex items-center justify-center p-6"
              onClick={() => setZoomedPromptImage(null)}
            >
              <div
                className={`relative flex max-h-full flex-col gap-3 ${
                  isLocationEditor ? "w-full max-w-[92vw] rounded-2xl border border-zinc-700 bg-zinc-800 p-4 xl:max-w-7xl" : "max-w-3xl"
                }`}
                onClick={isLocationEditor ? (e) => e.stopPropagation() : undefined}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoomedPromptImage(null);
                  }}
                  title="Đóng"
                  className="absolute -right-2 -top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-sm text-white shadow hover:bg-zinc-700"
                >
                  ✕
                </button>
                {isLocationEditor && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-zinc-300">
                      {characters.length > 0
                        ? "Chọn vị trí đứng — bấm chọn nhân vật rồi bấm vào ảnh:"
                        : "Chưa có nhân vật nào gắn kèm — vẫn dựng được khối 3D địa hình, gắn thêm nhân vật sau để chọn vị trí."}
                    </span>
                    {characters.map((u, i) => {
                      const color = POSITION_MARKER_COLORS[i % POSITION_MARKER_COLORS.length];
                      const placed = !!assignments[u];
                      const active = activeChar === u;
                      return (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setPositionEditorActiveChar(u)}
                          className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium"
                          style={{
                            borderColor: color,
                            backgroundColor: active ? `${color}30` : "transparent",
                            color: active ? color : "#d4d4d8",
                          }}
                        >
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                          {promptImageMeta[u]?.name || "Nhân vật"}
                          {placed && " ✓"}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Phương án A — 2 khung song song (2D trái, 3D phải), đồng bộ real-time — thay cho bản
                    tab-chuyển-qua-lại trước đó (user phản hồi không thấy/khó nhận ra). Khung 3D hiện khi
                    đã có địa hình (depthImageUrl) HOẶC đã có ít nhất 1 vị trí nhân vật — không bắt buộc
                    phải có nhân vật trước mới dựng được địa hình (phản hồi thật user). Trên màn hẹp tự
                    xếp chồng (grid-cols-1) nhờ lg:grid-cols-2. */}
                <div className={isLocationEditor ? `grid gap-3 ${show3DPanel ? "lg:grid-cols-[1fr_1.3fr]" : ""}` : ""}>
                  <div
                    className={`relative overflow-hidden rounded-lg ${isLocationEditor ? "cursor-crosshair" : ""}`}
                    onClick={isLocationEditor ? handlePlaceMarker : undefined}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={zoomedPromptImage}
                      alt=""
                      className={isLocationEditor ? "max-h-[65vh] w-full select-none object-contain" : "max-h-[75vh] max-w-full select-none object-contain"}
                      draggable={false}
                    />
                    {isLocationEditor &&
                      characters.map((u, i) => {
                        const pos = assignments[u];
                        if (!pos) return null;
                        const color = POSITION_MARKER_COLORS[i % POSITION_MARKER_COLORS.length];
                        return (
                          <div
                            key={u}
                            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                            style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, width: 16, height: 16, backgroundColor: color }}
                            title={promptImageMeta[u]?.name}
                          />
                        );
                      })}
                  </div>
                  {isLocationEditor && show3DPanel && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-zinc-400">Xem 3D — kéo chuột để xoay:</span>
                      <LocationPositionStage3D
                        locationUrl={zoomedPromptImage}
                        characters={characters
                          .map((u, i) => ({
                            url: u,
                            name: promptImageMeta[u]?.name || "Nhân vật",
                            color: POSITION_MARKER_COLORS[i % POSITION_MARKER_COLORS.length],
                            pos: assignments[u],
                          }))
                          .filter((c): c is { url: string; name: string; color: string; pos: { x: number; y: number } } => !!c.pos)
                          .map((c) => ({ url: c.url, name: c.name, color: c.color, x: c.pos.x, y: c.pos.y }))}
                        depthImageUrl={locationBlockout[zoomedPromptImage]?.depthImageUrl}
                        groundMaskUrl={locationBlockout[zoomedPromptImage]?.groundMaskUrl}
                      />
                    </div>
                  )}
                </div>
                {isLocationEditor &&
                  (() => {
                    const blockout = locationBlockout[zoomedPromptImage];
                    return (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setZoomedPromptImage(null)}
                          className="rounded-full border-2 border-fuchsia-500 bg-fuchsia-500/20 px-4 py-2 text-sm font-medium text-white"
                        >
                          Xác nhận vị trí
                        </button>
                        <button
                          type="button"
                          onClick={() => handleBuildLocationBlockout(zoomedPromptImage)}
                          disabled={blockout?.status === "loading" || blockout?.status === "done"}
                          title="Phân tích ảnh để dựng khối 3D theo đúng những gì có trong ảnh — chỉ tốn phí nhỏ, gọi 1 lần/ảnh"
                          className="rounded-full border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-70"
                        >
                          {blockout?.status === "loading"
                            ? "⏳ Đang dựng khối 3D..."
                            : blockout?.status === "done"
                              ? "✅ Đã dựng khối 3D"
                              : "🧱 Dựng khối 3D"}
                        </button>
                        {characters.length > 0 && (
                          <span className="text-xs text-zinc-400">
                            Đã đặt {Object.keys(assignments).length}/{characters.length} nhân vật
                          </span>
                        )}
                        {blockout?.status === "error" && <span className="text-xs text-red-400">{blockout.error}</span>}
                      </div>
                    );
                  })()}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
