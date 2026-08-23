"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, MINI_APPS } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/lib/auth-context";
import { supabaseBrowser } from "@/lib/supabase-browser";

// Kling (model tạo video đang dùng) từ chối xử lý (lỗi 422) nếu prompt quá dài — giữ dưới ngưỡng an toàn.
const VIDEO_PROMPT_MAX_LENGTH = 2000;

// Giá hiện trên nút chọn tier — tier tính theo duration hiện giá rẻ nhất ("từ X credit") thay vì
// tra theo selectedVideoDuration hiện tại, vì mỗi tier/model có bộ giây hợp lệ khác nhau (Kling
// 5/10, LTX-2.3 6/8/10/12/...) nên số giây đang chọn ở tier khác có thể không tồn tại ở tier này.
function tierDisplayCost(tier: { creditCost?: number; creditCostByDuration?: Record<string, number> }): number | undefined {
  if (tier.creditCost !== undefined) return tier.creditCost;
  if (tier.creditCostByDuration) {
    const values = Object.values(tier.creditCostByDuration);
    return values.length ? Math.min(...values) : undefined;
  }
  return undefined;
}

export default function MiniAppDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const app = MINI_APPS.find((item) => item.id === params.id);
  const { user } = useAuth();

  const [input, setInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [endFrameDataUrl, setEndFrameDataUrl] = useState<string | null>(null);
  const [endFrameError, setEndFrameError] = useState<string | null>(null);
  // "Nhảy theo video mẫu": endFrameDataUrl tái dùng để chứa URL video mẫu (không phải base64) vì
  // video có thể tới 15MB — upload thẳng lên Supabase Storage từ trình duyệt, không qua API route
  // (vượt giới hạn ~4.5MB request body của Vercel).
  const [uploadingReferenceVideo, setUploadingReferenceVideo] = useState(false);
  const [textFileError, setTextFileError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [videoStatusText, setVideoStatusText] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [liveCreditCost, setLiveCreditCost] = useState<number | null>(null);
  // Tier chất lượng video (Tiết kiệm/Cơ bản/Cao cấp) — app không có tier trả mảng rỗng nên UI chọn
  // tier chỉ hiện khi videoTiers.length > 0.
  const [videoTiers, setVideoTiers] = useState<
    {
      key: "basic" | "premium" | "budget";
      label: string;
      creditCost?: number;
      creditCostByDuration?: Record<string, number>; // key là số giây — mỗi tier/model có bộ giây riêng
    }[]
  >([]);
  const [selectedVideoTier, setSelectedVideoTier] = useState<"basic" | "premium" | "budget">("basic");
  const [selectedVideoDuration, setSelectedVideoDuration] = useState<string>("5");
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // "AI viết giúp mô tả" — khách gõ 1 gợi ý ngắn tiếng Việt, gọi OpenRouter (có nhìn ảnh nhân vật
  // nếu đã tải) để tự viết prompt tiếng Anh chuẩn cho Kling, điền thẳng vào ô "Câu lệnh mô tả".
  const [promptHint, setPromptHint] = useState("");
  const [generatingPrompt, setGeneratingPrompt] = useState(false);
  const [promptGenError, setPromptGenError] = useState<string | null>(null);

  async function handleGeneratePrompt() {
    if (!promptHint.trim()) {
      setPromptGenError("Nhập gợi ý trước đã");
      return;
    }
    setGeneratingPrompt(true);
    setPromptGenError(null);
    try {
      const res = await fetch("/api/video/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ miniAppId: params.id, hint: promptHint.trim(), imageDataUrl: imageDataUrl ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPromptGenError(data.error ?? "Không tạo được prompt");
        return;
      }
      setInput(data.prompt);
    } catch {
      setPromptGenError("Không kết nối được tới server");
    } finally {
      setGeneratingPrompt(false);
    }
  }

  // Đăng video kết quả thẳng lên kênh YouTube của user (OAuth qua Google) — chỉ áp dụng cho app
  // outputType "video". youtubeStatus null = chưa kiểm tra xong.
  const [youtubeStatus, setYoutubeStatus] = useState<{ connected: boolean; channelTitle: string | null } | null>(null);
  const [showYoutubeForm, setShowYoutubeForm] = useState(false);
  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubeDescription, setYoutubeDescription] = useState("");
  const [youtubePublishing, setYoutubePublishing] = useState(false);
  const [youtubePublishedUrl, setYoutubePublishedUrl] = useState<string | null>(null);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);

  // Ghép nhạc nền vào video kết quả — thư viện nhạc do admin upload sẵn (đã có bản quyền hợp lệ),
  // user chỉ chọn 1 bài trong danh sách này rồi gọi /api/video/add-music (dùng ffmpeg phía server).
  const [currentVideoJobId, setCurrentVideoJobId] = useState<number | null>(null);
  const [musicTracks, setMusicTracks] = useState<{ id: number; name: string; file_url: string }[]>([]);
  const [showMusicPicker, setShowMusicPicker] = useState(false);
  const [musicMode, setMusicMode] = useState<"library" | "upload">("library");
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [customAudioDataUrl, setCustomAudioDataUrl] = useState<string | null>(null);
  const [customAudioError, setCustomAudioError] = useState<string | null>(null);
  const [addingMusic, setAddingMusic] = useState(false);
  const [musicAddError, setMusicAddError] = useState<string | null>(null);
  const [musicAddedSuccess, setMusicAddedSuccess] = useState(false);

  // Chia sẻ kết quả + đánh giá nhanh (👍/👎) — chỉ là tương tác phía client, không lưu server.
  const [shareCopied, setShareCopied] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);

  async function handleShareResult() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      setShareCopied(false);
    }
  }

  // "Video đồng nhất nhân vật": 2-4 nhân vật, mỗi người 1 ảnh + 1 lời thoại riêng — upload ảnh thật
  // lên Storage lúc bấm "Chạy ngay" (giống outfit-swap), không upload ngay lúc chọn file.
  const DIALOGUE_MIN_CHARACTERS = 2;
  const DIALOGUE_MAX_CHARACTERS = 4;
  type DialogueCharacter = { image: string | null; error: string | null; line: string };
  const [dialogueCharacters, setDialogueCharacters] = useState<DialogueCharacter[]>([
    { image: null, error: null, line: "" },
    { image: null, error: null, line: "" },
  ]);
  const [dialogueCreditCost, setDialogueCreditCost] = useState<number | null>(null);
  const [dialogueRunning, setDialogueRunning] = useState(false);
  const [dialogueStatusText, setDialogueStatusText] = useState<string | null>(null);
  const [dialogueResult, setDialogueResult] = useState<string | null>(null);
  const [dialogueError, setDialogueError] = useState<string | null>(null);
  const dialoguePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // "Video từ ý tưởng truyện": 1-3 ảnh nhân vật + mô tả truyện (dùng chung state `input`) + số phân
  // cảnh (2-8) + chọn model ảnh/video từ catalog nhiều nhà cung cấp — AI tự chia cảnh, không cho
  // khách tự viết từng cảnh.
  const STORY_MIN_SCENES = 2;
  const STORY_MAX_SCENES = 8;
  const [numScenes, setNumScenes] = useState(3);
  const [storyCharacterImages, setStoryCharacterImages] = useState<string[]>([]);
  type StoryModel = {
    key: string;
    provider: string;
    label: string;
    provider_cost_vnd: number;
    multi_image?: boolean;
    aspect_ratios?: string[];
    resolution_price_vnd?: Record<string, number>;
    duration_price_vnd?: Record<string, number>;
  };
  const [storyImageModels, setStoryImageModels] = useState<StoryModel[]>([]);
  const [storyVideoModels, setStoryVideoModels] = useState<StoryModel[]>([]);
  const [storyImageModelKey, setStoryImageModelKey] = useState<string | null>(null);
  const [storyVideoModelKey, setStoryVideoModelKey] = useState<string | null>(null);
  // "Cấu hình media" — tỉ lệ khung hình (luôn có), độ phân giải/thời lượng chỉ hiện khi model đang
  // chọn có bảng giá riêng cho trục đó (không hiện dropdown giả cho model không hỗ trợ).
  const [storyAspectRatio, setStoryAspectRatio] = useState("9:16");
  const [storyResolutionKey, setStoryResolutionKey] = useState<string | null>(null);
  const [storyDurationKey, setStoryDurationKey] = useState<string | null>(null);
  // "Model chat" — LLM thực thi bước chia cảnh (tách biệt với "Agent" = persona/hướng dẫn) — đúng 2
  // lựa chọn admin đang dùng cho app tự tạo dạng text (xem MODEL_OPTIONS trong app/admin/page.tsx).
  const STORY_MODEL_CHAT_OPTIONS = [
    { value: "google/gemini-3-flash-preview", label: "Gemini Flash" },
    { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet" },
  ];
  const [storyModelChatKey, setStoryModelChatKey] = useState(STORY_MODEL_CHAT_OPTIONS[0].value);
  const [storyImageCost, setStoryImageCost] = useState<number | null>(null);
  const [storyVideoCost, setStoryVideoCost] = useState<number | null>(null);
  const [storyCharacterCost, setStoryCharacterCost] = useState<number | null>(null);
  // Bước "Tạo Character" — ảnh sheet nhiều góc dùng làm tham chiếu chung cho mọi phân cảnh (thay vì
  // ảnh gốc lộn xộn). Job dừng ở "character_ready" chờ khách duyệt trước khi tốn credit chia cảnh.
  const [storyCharacterSheetUrl, setStoryCharacterSheetUrl] = useState<string | null>(null);
  const [storyCharacterSource, setStoryCharacterSource] = useState<string | null>(null);
  const [storyRegeneratingCharacter, setStoryRegeneratingCharacter] = useState(false);
  const [storyContinuingScenes, setStoryContinuingScenes] = useState(false);
  const [storySavingCharacter, setStorySavingCharacter] = useState(false);
  const [storySavedCharacterMsg, setStorySavedCharacterMsg] = useState<string | null>(null);
  // Thư viện Character đã lưu — chọn 1 cái thay vì tải ảnh mới, bỏ qua hẳn bước tạo Character (chắc
  // chắn 100% vì chính hệ thống đã tạo ra trước đó, không cần AI phân loại lại).
  type SavedCharacter = { id: number; imageUrl: string; label: string | null };
  const [storySavedCharacters, setStorySavedCharacters] = useState<SavedCharacter[]>([]);
  const [storySelectedSavedCharacterId, setStorySelectedSavedCharacterId] = useState<number | null>(null);
  // "Tự động tạo video luôn" (gộp 1 lượt, giống Genful bấm mũi tên ▾) — mặc định TẮT: chỉ chạy chia
  // cảnh + tạo ảnh trước, dừng lại cho khách xem, ưng mới bấm "Tạo video" (đỡ tốn credit video oan
  // nếu ảnh ra không đúng ý).
  const [storyAutoVideo, setStoryAutoVideo] = useState(false);
  const [storyRunning, setStoryRunning] = useState(false);
  const [storyContinuing, setStoryContinuing] = useState(false);
  const [storyStatusText, setStoryStatusText] = useState<string | null>(null);
  const [storyStatus, setStoryStatus] = useState<string | null>(null);
  const [storyJobId, setStoryJobId] = useState<number | null>(null);
  const [storyScenes, setStoryScenes] = useState<{ position: number; imageUrl: string | null; videoUrl: string | null }[] | null>(null);
  const [storyResult, setStoryResult] = useState<string | null>(null);
  const [storyError, setStoryError] = useState<string | null>(null);
  const storyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const storyCharacterPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyScenesPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyResultRef = useRef<HTMLDivElement | null>(null);

  // Tự động cuộn xuống khi Character/ảnh phân cảnh xong hoặc video hoàn tất — khách không phải cuộn
  // tay để xem kết quả.
  useEffect(() => {
    if (storyStatus === "character_ready") {
      storyCharacterPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (storyStatus === "images_ready") {
      storyScenesPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [storyStatus]);
  useEffect(() => {
    if (storyResult) {
      storyResultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [storyResult]);

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
    if (params.id !== "video-tu-y-tuong" || !user) return;
    loadSavedStoryCharacters(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, user?.id]);

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

  // "Thay trang phục": imageDataUrl dùng chung làm ảnh người mẫu, garmentImages là danh sách trang phục
  // tham chiếu riêng (tối đa 10) — kết quả trả về nhiều ảnh nên dùng state riêng, không dùng chung `result`.
  const [garmentImages, setGarmentImages] = useState<string[]>([]);
  const [garmentError, setGarmentError] = useState<string | null>(null);
  // Loại trang phục cho từng ảnh — người dùng tự khai báo (không để AI đoán, hay bịa sai quần/váy
  // khi ảnh tham chiếu là cả bộ). Song song index với garmentImages, mặc định "tops" (chỉ áo).
  type GarmentCategory = "tops" | "one-pieces";
  const [garmentCategories, setGarmentCategories] = useState<GarmentCategory[]>([]);
  type OutfitSwapModel = {
    key: "generic" | "fashn" | "fashn_max";
    label: string;
    pricePerImage: number;
    hasPrompt: boolean;
    defaultPrompt?: string;
  };
  const [outfitSwapModels, setOutfitSwapModels] = useState<OutfitSwapModel[]>([]);
  const [outfitSwapModelChoice, setOutfitSwapModelChoice] = useState<"generic" | "fashn" | "fashn_max" | null>(null);
  const [outfitSwapResults, setOutfitSwapResults] = useState<string[] | null>(null);
  // URL thật (Storage) của ảnh người mẫu gốc sau khi upload — dùng làm "ảnh trước" khi nối sang
  // app "Video trước/sau" (imageDataUrl vẫn giữ base64 preview, không phù hợp nhét vào query string).
  const [outfitSwapModelImageUrl, setOutfitSwapModelImageUrl] = useState<string | null>(null);
  const [outfitSwapStatusText, setOutfitSwapStatusText] = useState<string | null>(null);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (dialoguePollRef.current) clearInterval(dialoguePollRef.current);
      if (storyPollRef.current) clearInterval(storyPollRef.current);
    };
  }, []);

  // Đến từ nút "Tạo video từ ảnh này" ở app khác (vd outfit-swap) — ảnh đã là URL thật (fal.media/
  // fashn CDN), Kling nhận thẳng URL nên không cần upload lại, chỉ cần điền sẵn vào state có sẵn.
  useEffect(() => {
    if (app?.inputType === "video-gen") {
      const prefillUrl = searchParams.get("imageUrl");
      if (prefillUrl) setImageDataUrl(prefillUrl);
    }
    if (app?.inputType === "video-transform") {
      const startUrl = searchParams.get("startImageUrl");
      const endUrl = searchParams.get("endImageUrl");
      if (startUrl) setImageDataUrl(startUrl);
      if (endUrl) setEndFrameDataUrl(endUrl);
    }
  }, [app?.inputType, searchParams]);

  // Kiểm tra đã kết nối YouTube chưa (chỉ app tạo video mới cần) + đọc phản hồi từ trang
  // /api/youtube/callback redirect về (?youtube=connected|denied|error).
  useEffect(() => {
    if (app?.outputType !== "video" || !user) return;
    fetch(`/api/youtube/status?userId=${user.id}`)
      .then((res) => res.json())
      .then((data) => setYoutubeStatus(data))
      .catch(() => {});

    const youtubeParam = searchParams.get("youtube");
    if (youtubeParam === "denied") setYoutubeError("Anh đã từ chối cấp quyền YouTube.");
    if (youtubeParam === "error") setYoutubeError("Kết nối YouTube thất bại, thử lại.");
  }, [app?.outputType, user, searchParams]);

  // Danh sách nhạc nền (admin upload sẵn) để user chọn ghép vào video kết quả.
  useEffect(() => {
    if (app?.outputType !== "video") return;
    fetch("/api/background-music")
      .then((res) => res.json())
      .then((data) => setMusicTracks(data.tracks ?? []))
      .catch(() => {});
  }, [app?.outputType]);

  // Tự khôi phục job video gần nhất khi khách quay lại trang (đóng tab/tắt máy giữa chừng rồi mở
  // lại) — tránh mất kết quả đã tạo xong hoặc phải chờ lại từ đầu nếu vẫn đang xử lý. Bỏ qua nếu
  // đến từ nút "Tạo video từ ảnh này" (?imageUrl=) vì đó là ý định tạo video MỚI, không phải tiếp tục.
  useEffect(() => {
    if (app?.outputType !== "video" || !user || !app) return;
    if (searchParams.get("imageUrl")) return;
    fetch(`/api/video/latest?userId=${user.id}&miniAppId=${app.id}`)
      .then((res) => res.json())
      .then((data) => {
        const job = data.job;
        if (!job) return;
        setCurrentVideoJobId(job.id);
        if (job.status === "done" && job.outputUrl) {
          setResult(job.outputUrl);
        } else if (job.status === "pending" || job.status === "processing") {
          setIsRunning(true);
          setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
          pollVideoStatus(job.id);
        }
      })
      .catch(() => {});
  }, [app, user, searchParams]);

  async function handleAddMusic() {
    if (!user || !currentVideoJobId) return;
    if (musicMode === "library" && !selectedTrackId) return;
    if (musicMode === "upload" && !customAudioDataUrl) return;
    setAddingMusic(true);
    setMusicAddError(null);
    setMusicAddedSuccess(false);
    try {
      const res = await fetch("/api/video/add-music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          jobId: currentVideoJobId,
          trackId: musicMode === "library" ? selectedTrackId : undefined,
          customAudioDataUrl: musicMode === "upload" ? customAudioDataUrl : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMusicAddError(data.error ?? "Không ghép được nhạc");
        return;
      }
      setResult(data.url);
      setMusicAddedSuccess(true);
    } catch {
      setMusicAddError("Không kết nối được tới server");
    } finally {
      setAddingMusic(false);
    }
  }

  useEffect(() => {
    if (params.id === "thay-trang-phuc") {
      fetch("/api/outfit-swap")
        .then((res) => res.json())
        .then((data) => {
          const models: OutfitSwapModel[] = data.models ?? [];
          setOutfitSwapModels(models);
          // Mặc định FASHN nếu có bật, không thì lấy model còn lại đang bật
          const fashn = models.find((m) => m.key === "fashn");
          const defaultModel = fashn ?? models[0];
          setOutfitSwapModelChoice(defaultModel?.key ?? null);
          if (defaultModel?.defaultPrompt) setInput(defaultModel.defaultPrompt);
        })
        .catch(() => {});
    }
  }, [params.id]);

  // "Video đồng nhất nhân vật": giá tăng theo số nhân vật (2-4 người) — tính lại mỗi khi thêm/bớt.
  useEffect(() => {
    if (params.id !== "video-doi-thoai-nhan-vat") return;
    fetch(`/api/dialogue-video/price?miniAppId=${params.id}&characterCount=${dialogueCharacters.length}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.creditCost === "number") setDialogueCreditCost(data.creditCost);
      })
      .catch(() => {});
  }, [params.id, dialogueCharacters.length]);

  // "Video từ ý tưởng truyện": tải danh sách model ảnh/video từ catalog 1 lần khi vào trang, chọn sẵn
  // model đầu tiên mỗi loại.
  useEffect(() => {
    if (params.id !== "video-tu-y-tuong") return;
    fetch(`/api/story-video/models?miniAppId=${params.id}`)
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
      })
      .catch(() => {});
  }, [params.id]);

  // "Video từ ý tưởng truyện": giá tăng theo số phân cảnh (2-8) + model/tỉ lệ/độ phân giải/thời
  // lượng đã chọn — tính lại mỗi khi đổi.
  useEffect(() => {
    if (params.id !== "video-tu-y-tuong" || !storyImageModelKey || !storyVideoModelKey) return;
    const params2 = new URLSearchParams({
      miniAppId: params.id,
      numScenes: String(numScenes),
      imageModelKey: storyImageModelKey,
      videoModelKey: storyVideoModelKey,
    });
    if (storyResolutionKey) params2.set("resolutionKey", storyResolutionKey);
    if (storyDurationKey) params2.set("durationKey", storyDurationKey);
    fetch(`/api/story-video/price?${params2.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.imageCost === "number") setStoryImageCost(data.imageCost);
        if (typeof data.videoCost === "number") setStoryVideoCost(data.videoCost);
        if (typeof data.characterCost === "number") setStoryCharacterCost(data.characterCost);
      })
      .catch(() => {});
  }, [params.id, numScenes, storyImageModelKey, storyVideoModelKey, storyResolutionKey, storyDurationKey]);

  // Ảnh/video có giá tính động theo chi phí thật + biên lợi nhuận, khác app text (giá cố định)
  useEffect(() => {
    if (params.id) {
      fetch(`/api/mini-app/${params.id}/price`)
        .then((res) => res.json())
        .then((data) => {
          if (data.dynamic) setLiveCreditCost(data.creditCost);
          // Prompt mặc định admin soạn sẵn (nếu có) — chỉ điền khi khách chưa tự gõ gì, vẫn sửa/xoá được.
          if (data.defaultPrompt) setInput((prev) => prev || data.defaultPrompt);
        })
        .catch(() => {});
    }
  }, [params.id]);

  // App có nhiều tier chất lượng (hiện chỉ "Tạo video quảng cáo ngắn") — app khác trả mảng rỗng.
  useEffect(() => {
    if (params.id) {
      fetch(`/api/video/tiers?miniAppId=${params.id}`)
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data.tiers)) setVideoTiers(data.tiers);
        })
        .catch(() => {});
    }
  }, [params.id]);

  if (!app) {
    return <CommunityMiniAppRunner miniAppId={params.id} />;
  }

  const relatedApps = MINI_APPS.filter(
    (item) => item.category === app.category && item.id !== app.id
  ).slice(0, 3);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImageError(null);
    if (!file.type.startsWith("image/")) {
      setImageError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    // "Thay trang phục" upload ảnh này lên Storage riêng trước khi chạy (xem handleRunOutfitSwap) —
    // cap 3MB thay vì 4MB vì base64 encode phình ~33%, 1 ảnh 4MB có thể tự vượt giới hạn request của Vercel.
    const maxBytes = app?.inputType === "outfit-swap" ? 3 * 1024 * 1024 : 4 * 1024 * 1024;
    if (file.size > maxBytes) {
      setImageError(
        app?.inputType === "outfit-swap"
          ? "Ảnh tối đa 3MB, anh chọn ảnh nhỏ hơn giúp em nhé"
          : "Ảnh tối đa 4MB, anh chọn ảnh nhỏ hơn giúp em nhé"
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleGarmentFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setGarmentError(null);
    const remainingSlots = 10 - garmentImages.length;
    if (remainingSlots <= 0) {
      setGarmentError("Tối đa 10 ảnh trang phục");
      return;
    }

    const filesToAdd = files.slice(0, remainingSlots);
    filesToAdd.forEach((file) => {
      if (!file.type.startsWith("image/")) {
        setGarmentError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
        return;
      }
      if (file.size > 3 * 1024 * 1024) {
        setGarmentError("Mỗi ảnh tối đa 3MB");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setGarmentImages((prev) => [...prev, reader.result as string]);
        setGarmentCategories((prev) => [...prev, "tops"]);
      };
      reader.readAsDataURL(file);
    });
  }

  function removeGarmentImage(index: number) {
    setGarmentImages((prev) => prev.filter((_, i) => i !== index));
    setGarmentCategories((prev) => prev.filter((_, i) => i !== index));
  }

  function setGarmentCategoryAt(index: number, category: GarmentCategory) {
    setGarmentCategories((prev) => prev.map((c, i) => (i === index ? category : c)));
  }

  function pollOutfitSwapStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/outfit-swap/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setOutfitSwapResults(data.outputs);
          setIsRunning(false);
          setOutfitSwapStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Thay trang phục thất bại, credit đã được hoàn");
          setIsRunning(false);
          setOutfitSwapStatusText(null);
        } else {
          setOutfitSwapStatusText(`Đang xử lý ${data.doneCount}/${data.totalItems} bộ đồ...`);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function uploadOutfitSwapImage(dataUrl: string): Promise<string> {
    const res = await fetch("/api/outfit-swap/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user!.id, dataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Không tải được ảnh lên");
    return data.url as string;
  }

  function handleCharFileChange(e: React.ChangeEvent<HTMLInputElement>, index: number) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, error: "Chỉ nhận file ảnh (JPG, PNG, WEBP...)" } : c)));
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, error: "Ảnh tối đa 3MB" } : c)));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, image: dataUrl, error: null } : c)));
    };
    reader.readAsDataURL(file);
  }

  function addDialogueCharacter() {
    setDialogueCharacters((prev) => (prev.length >= DIALOGUE_MAX_CHARACTERS ? prev : [...prev, { image: null, error: null, line: "" }]));
  }

  function removeDialogueCharacter(index: number) {
    setDialogueCharacters((prev) => (prev.length <= DIALOGUE_MIN_CHARACTERS ? prev : prev.filter((_, i) => i !== index)));
  }

  function setDialogueLine(index: number, line: string) {
    setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, line } : c)));
  }

  function pollDialogueVideoStatus(jobId: number) {
    dialoguePollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/dialogue-video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (dialoguePollRef.current) clearInterval(dialoguePollRef.current);
          setDialogueResult(data.outputUrl);
          setDialogueRunning(false);
          setDialogueStatusText(null);
        } else if (data.status === "failed") {
          if (dialoguePollRef.current) clearInterval(dialoguePollRef.current);
          setDialogueError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setDialogueRunning(false);
          setDialogueStatusText(null);
        } else if (data.statusText) {
          setDialogueStatusText(data.statusText);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunDialogueVideo() {
    if (!user || dialogueCharacters.some((c) => !c.image || !c.line.trim())) return;
    setDialogueRunning(true);
    setDialogueResult(null);
    setDialogueError(null);
    setDialogueStatusText("Đang tải ảnh lên...");

    let imageUrls: string[];
    try {
      imageUrls = await Promise.all(dialogueCharacters.map((c) => uploadOutfitSwapImage(c.image!)));
    } catch (err) {
      setDialogueError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
      setDialogueRunning(false);
      setDialogueStatusText(null);
      return;
    }

    setDialogueStatusText("Đang gửi yêu cầu...");

    try {
      const res = await fetch("/api/dialogue-video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          miniAppId: app!.id,
          characters: dialogueCharacters.map((c, index) => ({ imageUrl: imageUrls[index], line: c.line.trim() })),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setDialogueError(data.error ?? "Có lỗi xảy ra");
        setDialogueRunning(false);
        setDialogueStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setDialogueStatusText(
        `Đang tạo chuyển động cho ${dialogueCharacters.length} nhân vật, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...`
      );
      pollDialogueVideoStatus(data.jobId);
    } catch {
      setDialogueError("Không kết nối được tới server");
      setDialogueRunning(false);
      setDialogueStatusText(null);
    }
  }

  function pollStoryVideoStatus(jobId: number) {
    storyPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();

        if (Array.isArray(data.scenes)) setStoryScenes(data.scenes);
        setStoryStatus(data.status ?? null);
        if (data.characterSheetUrl) setStoryCharacterSheetUrl(data.characterSheetUrl);
        if (data.characterSource) setStoryCharacterSource(data.characterSource);

        if (data.status === "done" && data.outputUrl) {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryResult(data.outputUrl);
          setStoryRunning(false);
          setStoryStatusText(null);
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
        } else if (data.status === "failed") {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
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

  async function handleSaveCharacter() {
    if (!user || !storyCharacterSheetUrl) return;
    setStorySavingCharacter(true);
    setStorySavedCharacterMsg(null);
    try {
      const res = await fetch("/api/story-video/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, imageUrl: storyCharacterSheetUrl }),
      });
      if (res.ok) {
        setStorySavedCharacterMsg("Đã lưu vào thư viện Character.");
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
    if (!user || !storyJobId) return;
    setStoryContinuingScenes(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/continue-to-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId, modelChatKey: storyModelChatKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryContinuingScenes(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuingScenes(false);
      setStoryRunning(true);
      setStoryStatusText(`Đang tạo ảnh cho ${numScenes} phân cảnh...`);
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuingScenes(false);
    }
  }

  async function handleContinueToVideo() {
    if (!user || !storyJobId) return;
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

  async function handleRunStoryVideo() {
    const images = storyCharacterImages;
    const reuseId = storySelectedSavedCharacterId;
    if (!user || (!reuseId && images.length === 0) || !input.trim() || !storyImageModelKey || !storyVideoModelKey) return;
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
    if (!reuseId) {
      setStoryStatusText("Đang tải ảnh lên...");
      try {
        characterImageUrls = await Promise.all(images.map((img) => uploadOutfitSwapImage(img)));
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
          numScenes,
          characterImageUrls,
          imageModelKey: storyImageModelKey,
          videoModelKey: storyVideoModelKey,
          autoVideo: storyAutoVideo,
          aspectRatio: storyAspectRatio,
          resolutionKey: storyResolutionKey,
          durationKey: storyDurationKey,
          modelChatKey: storyModelChatKey,
          reuseCharacterId: reuseId ?? undefined,
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

  async function handleRunOutfitSwap() {
    if (!user || garmentImages.length === 0 || !imageDataUrl || !outfitSwapModelChoice) return;
    setIsRunning(true);
    setOutfitSwapResults(null);
    setRunError(null);
    setOutfitSwapStatusText("Đang tải ảnh lên...");

    // Upload từng ảnh lên Storage TRƯỚC — gửi thẳng base64 gộp 6-7 ảnh trong 1 request chạy AI dễ
    // vượt giới hạn ~4.5MB/request của Vercel, bị chặn 413 (đã xảy ra thật, lặp lại liên tục).
    // Chưa trừ credit ở bước này nên lỗi ở đây luôn an toàn để bấm thử lại.
    let modelImageUrl: string;
    let garmentImageUrls: string[];
    try {
      [modelImageUrl, ...garmentImageUrls] = await Promise.all([
        uploadOutfitSwapImage(imageDataUrl),
        ...garmentImages.map(uploadOutfitSwapImage),
      ]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
      setIsRunning(false);
      setOutfitSwapStatusText(null);
      return;
    }
    setOutfitSwapModelImageUrl(modelImageUrl);

    setOutfitSwapStatusText("Đang gửi yêu cầu...");

    try {
      const res = await fetch("/api/outfit-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          modelImageDataUrl: modelImageUrl,
          garmentImageDataUrls: garmentImageUrls,
          garmentCategories: garmentCategories,
          modelChoice: outfitSwapModelChoice,
          prompt: input,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setOutfitSwapStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setOutfitSwapStatusText(
        `Đang xử lý ${garmentImages.length} bộ đồ, có thể mất khoảng 1-2 phút — anh có thể rời trang, quay lại vẫn thấy kết quả...`
      );
      pollOutfitSwapStatus(data.jobId);
    } catch {
      // Server có thể đã submit job xong (và trừ credit) nhưng phản hồi bị rớt mạng trước khi về
      // tới trình duyệt — không chắc chắn là lượt chạy thất bại, nên không giục chạy lại ngay kẻo
      // bị trừ credit 2 lần cho cùng 1 lượt.
      setRunError(
        "Mất kết nối khi nhận phản hồi từ server. Lượt chạy có thể đã thực hiện thành công — anh kiểm tra /wallet → \"Lịch sử kết quả\" trước khi bấm chạy lại."
      );
      setIsRunning(false);
      setOutfitSwapStatusText(null);
    }
  }

  // Chạy lại riêng 1 ảnh kết quả sai — thay vì bắt chạy lại nguyên cả lượt (tốn thêm credit cho cả
  // những ảnh vốn đã đúng). AI đôi khi ra sai ngẫu nhiên trên cùng 1 ảnh đầu vào, chạy lại có thể ra kết quả khác.
  function pollRetryOutfitSwapStatus(jobId: number, index: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/outfit-swap/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputs?.[0]) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setOutfitSwapResults((prev) => {
            if (!prev) return prev;
            const next = [...prev];
            next[index] = data.outputs[0];
            return next;
          });
          setRetryingIndex(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Chạy lại thất bại, credit đã được hoàn");
          setRetryingIndex(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRetryOutfitSwapItem(index: number) {
    if (!user || !imageDataUrl || !outfitSwapModelChoice || retryingIndex !== null) return;
    const garmentDataUrl = garmentImages[index];
    if (!garmentDataUrl) return;

    setRetryingIndex(index);
    setRunError(null);

    try {
      const [modelImageUrl, garmentImageUrl] = await Promise.all([
        uploadOutfitSwapImage(imageDataUrl),
        uploadOutfitSwapImage(garmentDataUrl),
      ]);

      const res = await fetch("/api/outfit-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          modelImageDataUrl: modelImageUrl,
          garmentImageDataUrls: [garmentImageUrl],
          garmentCategories: [garmentCategories[index] ?? "tops"],
          modelChoice: outfitSwapModelChoice,
          prompt: input,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setRetryingIndex(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      pollRetryOutfitSwapStatus(data.jobId, index);
    } catch {
      setRunError("Không tải được ảnh lên, thử lại");
      setRetryingIndex(null);
    }
  }

  function handleEndFrameFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setEndFrameError(null);
    if (!file.type.startsWith("image/")) {
      setEndFrameError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setEndFrameError("Ảnh tối đa 4MB, anh chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setEndFrameDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleTextFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setTextFileError(null);
    if (!file.type.startsWith("text/") && !file.name.toLowerCase().endsWith(".txt")) {
      setTextFileError("Chỉ nhận file .txt");
      return;
    }
    if (file.size > 1 * 1024 * 1024) {
      setTextFileError("File tối đa 1MB, anh chọn file nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setInput(reader.result as string);
    reader.readAsText(file);
  }

  async function handleRun() {
    if (!user) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);

    try {
      const res = await fetch(`/api/run/${app!.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, userId: user.id, imageDataUrl }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setResult(data.output);
      window.dispatchEvent(new Event("balance-updated"));
    } catch {
      setRunError("Không kết nối được tới server");
    } finally {
      setIsRunning(false);
    }
  }

  function pollVideoStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setResult(data.outputUrl);
          setIsRunning(false);
          setVideoStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setIsRunning(false);
          setVideoStatusText(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunVideo() {
    if (!user || !app) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: app.id,
          userId: user.id,
          prompt: input,
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
          modelChoice: videoTiers.length > 0 ? selectedVideoTier : undefined,
          duration: videoTiers.length > 0 ? selectedVideoDuration : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  async function handleReferenceVideoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;

    setEndFrameError(null);
    if (!file.type.startsWith("video/")) {
      setEndFrameError("Chỉ nhận file video (MP4, MOV...)");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setEndFrameError("Video mẫu tối đa 15MB, anh chọn clip ngắn hơn giúp em nhé");
      return;
    }

    setUploadingReferenceVideo(true);
    try {
      const ext = file.name.split(".").pop() || "mp4";
      const filePath = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabaseBrowser.storage
        .from("motion-transfer-uploads")
        .upload(filePath, file, { contentType: file.type, upsert: true });
      if (uploadError) {
        setEndFrameError(uploadError.message);
        return;
      }
      const { data } = supabaseBrowser.storage.from("motion-transfer-uploads").getPublicUrl(filePath);
      setEndFrameDataUrl(data.publicUrl);
    } catch {
      setEndFrameError("Không tải được video lên, thử lại giúp em");
    } finally {
      setUploadingReferenceVideo(false);
    }
  }

  async function handleRunMotionTransfer() {
    if (!user || !app) return;
    if (!imageDataUrl) {
      setImageError("Anh tải ảnh nhân vật lên giúp em");
      return;
    }
    if (!endFrameDataUrl) {
      setEndFrameError("Anh tải video mẫu chuyển động lên giúp em");
      return;
    }

    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: app.id,
          userId: user.id,
          prompt: "Nhảy theo video mẫu",
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
          modelChoice: videoTiers.length > 0 ? selectedVideoTier : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  async function handleRunVideoTransform() {
    if (!user || !app) return;
    if (!imageDataUrl) {
      setImageError("Anh tải ảnh \"trước\" lên giúp em");
      return;
    }
    if (!endFrameDataUrl) {
      setEndFrameError("Anh tải ảnh \"sau\" lên giúp em");
      return;
    }

    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: app.id,
          userId: user.id,
          // Không bắt buộc khách gõ mô tả cho app này — nếu để trống, dùng câu mặc định vì
          // /api/video/submit yêu cầu prompt khác rỗng.
          prompt: input.trim() || "Chuyển cảnh mượt mà từ ảnh đầu sang ảnh cuối, ánh sáng giữ nguyên tự nhiên.",
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
          modelChoice: videoTiers.length > 0 ? selectedVideoTier : undefined,
          duration: videoTiers.length > 0 ? selectedVideoDuration : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  async function handlePublishYoutube() {
    if (!user || !result || !youtubeTitle.trim()) return;
    setYoutubePublishing(true);
    setYoutubeError(null);
    try {
      const res = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, videoUrl: result, title: youtubeTitle, description: youtubeDescription }),
      });
      const data = await res.json();
      if (!res.ok) {
        setYoutubeError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setYoutubePublishedUrl(data.youtubeUrl);
      setShowYoutubeForm(false);
    } catch {
      setYoutubeError("Không kết nối được tới server");
    } finally {
      setYoutubePublishing(false);
    }
  }

  // Bố cục 2 cột (input trái/kết quả phải, tên app trên header) — thí điểm ở "Tạo video từ ảnh",
  // giờ áp dụng thêm cho 2 app video khác có input đơn giản tương tự (ảnh + mô tả/tier), và
  // "Thay trang phục" (nhiều ảnh trang phục + 1 ảnh người mẫu, kết quả nhiều ảnh — outfitSwapResults).
  // Không áp dụng "Video đồng nhất nhân vật" — UI app đó là danh sách nhân vật động, khác cấu trúc.
  const isTwoColumnLayout = ["video-gen", "video-transform", "motion-transfer", "outfit-swap"].includes(app.inputType);
  // "story-video" có bố cục 2 cột RIÊNG bên trong khối "Thử ngay" (trái: ảnh nhân vật/Agent/mô tả,
  // phải: Cấu hình media) — không dùng chung hệ thống isTwoColumnLayout (vốn là input|kết quả),
  // chỉ mượn cùng độ rộng khung trang để đủ chỗ cho 2 cột.
  const isWideLayout = isTwoColumnLayout || app.inputType === "story-video";

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className={`mx-auto flex items-center justify-between px-6 py-4 ${isWideLayout ? "max-w-6xl" : "max-w-3xl"}`}>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              ← Quay lại Danh mục
            </Link>
            {isTwoColumnLayout && (
              <span className="hidden text-base font-semibold text-zinc-900 dark:text-zinc-50 sm:inline">
                {app.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main
        className={`mx-auto px-6 ${
          isWideLayout ? "max-w-6xl pt-4 pb-10" : "max-w-3xl py-10"
        }`}
      >
        {/* Header Mini App — bỏ badge Danh mục/Hot/Mới riêng cho các app video dùng bố cục 2 cột, tên
            app đã chuyển lên thanh Header phía trên rồi nên không cần lặp lại gì ở đây nữa. */}
        {!isTwoColumnLayout && app.inputType !== "story-video" && (
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {CATEGORIES[app.category]}
            </span>
            {app.popular && (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                Hot
              </span>
            )}
            {app.isNew && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                Mới
              </span>
            )}
          </div>
        )}
        {!isTwoColumnLayout && (
          <>
            <h1
              className={`text-2xl font-semibold text-zinc-900 dark:text-zinc-50 ${
                app.inputType === "story-video" ? "mb-4" : "mb-2"
              }`}
            >
              {app.name}
            </h1>
            {app.inputType !== "story-video" && (
              <>
                <p className="mb-4 text-zinc-600 dark:text-zinc-400">{app.description}</p>
                <div className="mb-8 flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
                  <span>⭐ {app.rating}/5</span>
                  <span>{app.usageCount.toLocaleString("vi-VN")} lượt đã chạy</span>
                </div>
              </>
            )}
          </>
        )}

        {/* Demo input/output mẫu — Tập 5 mục 1.2: cần thấy ví dụ thật trước khi bỏ credit ra thử.
            Bỏ riêng cho "thay-trang-phuc" — card trang chủ đã có ảnh minh hoạ trực quan hơn rồi, mục
            text ở đây thành thừa/rối cho app này (các app khác vẫn giữ). "video-gen" cũng bỏ theo
            yêu cầu — giao diện app video giờ đã đủ rõ ràng, phần ví dụ text làm rối thêm. */}
        {app.inputType !== "outfit-swap" &&
          app.inputType !== "video-gen" &&
          app.inputType !== "motion-transfer" &&
          app.inputType !== "video-transform" &&
          app.inputType !== "story-video" && (
          <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Ví dụ minh hoạ
            </h2>
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Input mẫu</p>
              <p className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {app.demoInput}
              </p>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả AI trả về</p>
              <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-300">
                {app.demoOutput}
              </p>
            </div>
          </section>
        )}

        {/* Khu vực nhập input thật + chạy */}
        <section
          className={`mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 ${
            app.inputType === "story-video" ? "story-video-theme" : ""
          }`}
        >
          {app.inputType !== "story-video" && (
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Thử ngay
            </h2>
          )}
          {/* Bố cục 2 cột (trái = input, phải = kết quả) cho các app video đơn giản (ảnh + mô tả/tier)
              — app khác vẫn giữ nguyên 1 cột như trước, 2 div dưới đây chỉ là wrapper vô hại khi
              không phải grid. */}
          <div className={isTwoColumnLayout ? "grid grid-cols-1 gap-6 lg:grid-cols-2" : undefined}>
          <div className={isTwoColumnLayout ? "flex h-full flex-col" : undefined}>
          {app.inputType !== "outfit-swap" && app.inputType !== "dialogue-video" && app.inputType !== "story-video" && (
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {app.inputLabel}
            </label>
          )}

          {app.inputType === "image" ? (
            <div className="mb-4">
              {imageDataUrl ? (
                <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageDataUrl}
                    alt="Ảnh sản phẩm đã chọn"
                    className="h-20 w-20 rounded-md object-cover"
                  />
                  <button
                    onClick={() => setImageDataUrl(null)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Xóa ảnh
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-8 text-center dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Bấm để chọn ảnh sản phẩm
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
              {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
            </div>
          ) : app.inputType === "image-gen" ? (
            <div className="mb-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={app.inputPlaceholder}
                rows={3}
                className="mb-3 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Ảnh sản phẩm tham chiếu (không bắt buộc)
              </p>
              {imageDataUrl ? (
                <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageDataUrl}
                    alt="Ảnh sản phẩm tham chiếu đã chọn"
                    className="h-20 w-20 rounded-md object-cover"
                  />
                  <button
                    onClick={() => setImageDataUrl(null)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Xóa ảnh
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Bấm để tải ảnh sản phẩm thật (tuỳ chọn)
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
              {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
            </div>
          ) : app.inputType === "video-gen" ? (
            <div className="mb-4">
              <div className="mb-4 mx-auto max-w-xs">
                <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh nhân vật (không bắt buộc)</p>
                {imageDataUrl ? (
                  <div className="relative aspect-square w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageDataUrl} alt="Ảnh nhân vật" className="h-full w-full rounded-lg object-cover" />
                    <button
                      onClick={() => setImageDataUrl(null)}
                      className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                    >
                      Xóa
                    </button>
                  </div>
                ) : (
                  <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                    <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                    <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                  </label>
                )}
                {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
              </div>

              {videoTiers.length > 0 && (
                <div className="mb-4">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Chất lượng video</p>
                  <div className="flex flex-wrap gap-2">
                    {videoTiers.map((tier) => (
                      <button
                        key={tier.key}
                        onClick={() => {
                          setSelectedVideoTier(tier.key);
                          if (tier.creditCostByDuration) {
                            setSelectedVideoDuration(Object.keys(tier.creditCostByDuration)[0]);
                          }
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                          selectedVideoTier === tier.key
                            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        {tier.label} —{" "}
                        {tier.creditCostByDuration ? "từ " : ""}
                        {tierDisplayCost(tier) ?? "?"} credit
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const tier = videoTiers.find((t) => t.key === selectedVideoTier);
                    if (!tier?.creditCostByDuration) return null;
                    return (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Độ dài video:</p>
                        {Object.keys(tier.creditCostByDuration).map((d) => (
                          <button
                            key={d}
                            onClick={() => setSelectedVideoDuration(d)}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              selectedVideoDuration === d
                                ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {d} giây — {tier.creditCostByDuration![d]} credit
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              <div className="mb-3 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Không biết viết mô tả? Gõ gợi ý ngắn, để AI viết giúp
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={promptHint}
                    onChange={(e) => setPromptHint(e.target.value)}
                    placeholder="Ví dụ: video selfie tự nhiên, đang chải tóc"
                    maxLength={300}
                    className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                  <button
                    onClick={handleGeneratePrompt}
                    disabled={generatingPrompt || !promptHint.trim()}
                    className="shrink-0 rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    {generatingPrompt ? "Đang viết..." : "✨ AI viết giúp mô tả"}
                  </button>
                </div>
                {promptGenError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{promptGenError}</p>}
              </div>

              <p className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Câu lệnh mô tả (có thể chỉnh sửa)</p>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={3}
                maxLength={VIDEO_PROMPT_MAX_LENGTH}
                className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <p
                className={`text-right text-xs ${
                  input.length > VIDEO_PROMPT_MAX_LENGTH - 100 ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {input.length}/{VIDEO_PROMPT_MAX_LENGTH} ký tự — mô tả quá dài AI sẽ từ chối xử lý
              </p>
            </div>
          ) : app.inputType === "video-transform" ? (
            <div className="mb-4">
              <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh trước</p>
                  {imageDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh trước" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh sau</p>
                  {endFrameDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={endFrameDataUrl} alt="Ảnh sau" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleEndFrameFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
                </div>
              </div>

              {videoTiers.length > 0 && (
                <div className="mb-4">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Chất lượng video</p>
                  <div className="flex flex-wrap gap-2">
                    {videoTiers.map((tier) => (
                      <button
                        key={tier.key}
                        onClick={() => {
                          setSelectedVideoTier(tier.key);
                          if (tier.creditCostByDuration) {
                            setSelectedVideoDuration(Object.keys(tier.creditCostByDuration)[0]);
                          }
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                          selectedVideoTier === tier.key
                            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        {tier.label} —{" "}
                        {tier.creditCostByDuration ? "từ " : ""}
                        {tierDisplayCost(tier) ?? "?"} credit
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const tier = videoTiers.find((t) => t.key === selectedVideoTier);
                    if (!tier?.creditCostByDuration) return null;
                    return (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Độ dài video:</p>
                        {Object.keys(tier.creditCostByDuration).map((d) => (
                          <button
                            key={d}
                            onClick={() => setSelectedVideoDuration(d)}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              selectedVideoDuration === d
                                ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {d} giây — {tier.creditCostByDuration![d]} credit
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              <p className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Câu lệnh mô tả (không bắt buộc)</p>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ví dụ: chuyển cảnh mượt mà, ánh sáng giữ nguyên tự nhiên"
                rows={3}
                maxLength={VIDEO_PROMPT_MAX_LENGTH}
                className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <p
                className={`text-right text-xs ${
                  input.length > VIDEO_PROMPT_MAX_LENGTH - 100 ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {input.length}/{VIDEO_PROMPT_MAX_LENGTH} ký tự — mô tả quá dài AI sẽ từ chối xử lý
              </p>
            </div>
          ) : app.inputType === "motion-transfer" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh nhân vật</p>
                  {imageDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh nhân vật" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Video mẫu chuyển động</p>
                  {uploadingReferenceVideo ? (
                    <div className="flex aspect-square w-full flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải video lên...</span>
                    </div>
                  ) : endFrameDataUrl ? (
                    <div className="relative aspect-square w-full">
                      <video src={endFrameDataUrl} controls className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải video</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">MP4, MOV — tối đa 15MB</span>
                      <input type="file" accept="video/*" onChange={handleReferenceVideoFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
                </div>
              </div>

              {videoTiers.length > 0 && (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Chất lượng video</p>
                  <div className="flex flex-wrap gap-2">
                    {videoTiers.map((tier) => (
                      <button
                        key={tier.key}
                        onClick={() => {
                          setSelectedVideoTier(tier.key);
                          if (tier.creditCostByDuration) {
                            setSelectedVideoDuration(Object.keys(tier.creditCostByDuration)[0]);
                          }
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                          selectedVideoTier === tier.key
                            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        {tier.label} — {tier.creditCostByDuration ? "từ " : ""}
                        {tierDisplayCost(tier) ?? "?"} credit
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : app.inputType === "outfit-swap" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh trang phục tham chiếu (tối đa 10)
                  </p>
                  {garmentImages.length > 0 && (
                    <div className="mb-2 grid grid-cols-3 gap-2">
                      {garmentImages.map((url, index) => (
                        <div key={index}>
                          <div className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt={`Trang phục ${index + 1}`} className="aspect-square w-full rounded-md object-cover" />
                            <button
                              onClick={() => removeGarmentImage(index)}
                              aria-label="Xoá ảnh"
                              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
                            >
                              ×
                            </button>
                          </div>
                          <div className="mt-1 flex gap-0.5 text-[10px]">
                            <button
                              type="button"
                              onClick={() => setGarmentCategoryAt(index, "tops")}
                              className={`flex-1 rounded px-1 py-0.5 font-medium ${
                                (garmentCategories[index] ?? "tops") === "tops"
                                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"
                              }`}
                            >
                              Áo
                            </button>
                            <button
                              type="button"
                              onClick={() => setGarmentCategoryAt(index, "one-pieces")}
                              className={`flex-1 rounded px-1 py-0.5 font-medium ${
                                garmentCategories[index] === "one-pieces"
                                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"
                              }`}
                            >
                              Cả bộ
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {garmentImages.length < 10 && (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        Bấm để thêm ảnh trang phục ({garmentImages.length}/10)
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — mỗi ảnh tối đa 3MB</span>
                      <input type="file" accept="image/*" multiple onChange={handleGarmentFilesChange} className="hidden" />
                    </label>
                  )}
                  {garmentError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{garmentError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh người mẫu</p>
                  {imageDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh người mẫu" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        aria-label="Xoá ảnh"
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh người mẫu</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 3MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
              </div>

              {outfitSwapModels.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {outfitSwapModels.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setOutfitSwapModelChoice(m.key)}
                      className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                        outfitSwapModelChoice === m.key
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                          : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                      }`}
                    >
                      {m.label} — {m.pricePerImage} credit/ảnh
                    </button>
                  ))}
                </div>
              )}

              {outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.hasPrompt && (
                <>
                  <p className="mb-1 mt-4 text-xs font-medium text-zinc-500 dark:text-zinc-400">{app.inputLabel}</p>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </>
              )}
            </div>
          ) : app.inputType === "dialogue-video" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {dialogueCharacters.map((character, index) => (
                  <div key={index}>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Nhân vật {String.fromCharCode(65 + index)}</p>
                      {dialogueCharacters.length > DIALOGUE_MIN_CHARACTERS && (
                        <button
                          onClick={() => removeDialogueCharacter(index)}
                          className="text-xs text-zinc-400 underline hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
                        >
                          Xoá nhân vật
                        </button>
                      )}
                    </div>
                    {character.image ? (
                      <div className="relative aspect-square w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={character.image}
                          alt={`Nhân vật ${String.fromCharCode(65 + index)}`}
                          className="h-full w-full rounded-lg object-cover"
                        />
                        <button
                          onClick={() =>
                            setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, image: null } : c)))
                          }
                          className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                        >
                          Xóa
                        </button>
                      </div>
                    ) : (
                      <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                        <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 3MB</span>
                        <input type="file" accept="image/*" onChange={(e) => handleCharFileChange(e, index)} className="hidden" />
                      </label>
                    )}
                    {character.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{character.error}</p>}
                    <textarea
                      value={character.line}
                      onChange={(e) => setDialogueLine(index, e.target.value)}
                      placeholder={`Lời thoại của nhân vật ${String.fromCharCode(65 + index)}...`}
                      rows={2}
                      maxLength={400}
                      className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                ))}
              </div>

              {dialogueCharacters.length < DIALOGUE_MAX_CHARACTERS && (
                <button
                  onClick={addDialogueCharacter}
                  className="mt-3 rounded-full border border-dashed border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                >
                  + Thêm nhân vật (tối đa {DIALOGUE_MAX_CHARACTERS})
                </button>
              )}

              {dialogueStatusText && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{dialogueStatusText}</p>}
              {dialogueError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{dialogueError}</p>}

              {dialogueResult && (
                <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
                  <video src={dialogueResult} controls className="w-full max-w-md rounded-lg" />
                  <div className="mt-3 flex gap-2">
                    <a
                      href={`/api/download?url=${encodeURIComponent(dialogueResult)}&filename=doi-thoai.mp4`}
                      download
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Tải xuống
                    </a>
                    <button
                      onClick={() => {
                        setDialogueResult(null);
                        setDialogueCharacters([
                          { image: null, error: null, line: "" },
                          { image: null, error: null, line: "" },
                        ]);
                      }}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Chạy lại với input khác
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : app.inputType === "story-video" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-base font-medium text-zinc-500 dark:text-zinc-400">Ý tưởng truyện</p>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Mô tả mạch truyện, bối cảnh — AI sẽ chia thành phân cảnh"
                    rows={8}
                    maxLength={2000}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  />

                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">📷 Ảnh nhân vật</p>

                      {storySavedCharacters.length > 0 && (
                        <div className="mb-3">
                          <p className="mb-1 text-sm text-zinc-500 dark:text-zinc-400">📂 Character đã lưu</p>
                          <div className="flex flex-wrap gap-2">
                            {storySavedCharacters.map((c) => (
                              <div key={c.id} className="relative h-14 w-14">
                                <button
                                  onClick={() => setStorySelectedSavedCharacterId((prev) => (prev === c.id ? null : c.id))}
                                  className={`h-14 w-14 overflow-hidden rounded-lg border-2 ${
                                    storySelectedSavedCharacterId === c.id ? "border-zinc-900 dark:border-zinc-50" : "border-transparent"
                                  }`}
                                  title={c.label ?? `Character #${c.id}`}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={c.imageUrl} alt={c.label ?? `Character #${c.id}`} className="h-full w-full object-cover" />
                                </button>
                                <button
                                  onClick={() => handleDeleteSavedCharacter(c.id)}
                                  title="Xoá Character này"
                                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] font-medium text-white hover:bg-black/90"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {storySelectedSavedCharacterId ? (
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                          {(() => {
                            const selected = storySavedCharacters.find((c) => c.id === storySelectedSavedCharacterId);
                            return selected ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={selected.imageUrl} alt={selected.label ?? "Character đã chọn"} className="mb-2 w-full rounded-lg" />
                            ) : null;
                          })()}
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-zinc-600 dark:text-zinc-400">Đã chọn Character đã lưu — bỏ qua tải ảnh mới</span>
                            <div className="flex items-center gap-2">
                              {(() => {
                                const selected = storySavedCharacters.find((c) => c.id === storySelectedSavedCharacterId);
                                return selected ? (
                                  <a
                                    href={`/api/download?url=${encodeURIComponent(selected.imageUrl)}&filename=character-sheet.png`}
                                    download
                                    className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300"
                                  >
                                    Tải xuống
                                  </a>
                                ) : null;
                              })()}
                              <button
                                onClick={() => setStorySelectedSavedCharacterId(null)}
                                className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300"
                              >
                                Bỏ chọn
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            {storyCharacterImages.map((img, index) => (
                              <div key={index} className="relative aspect-square w-full">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={img} alt={`Ảnh nhân vật ${index + 1}`} className="h-full w-full rounded-lg object-cover" />
                                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">@image{index + 1}</span>
                                <button
                                  onClick={() => setStoryCharacterImages((prev) => prev.filter((_, i) => i !== index))}
                                  className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                            <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800">
                              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">+ Tải ảnh</span>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  e.target.value = "";
                                  if (!file) return;
                                  const reader = new FileReader();
                                  reader.onload = () => setStoryCharacterImages((prev) => [...prev, reader.result as string]);
                                  reader.readAsDataURL(file);
                                }}
                              />
                            </label>
                          </div>
                          <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
                            AI sẽ tự tạo 1 ảnh Character (nhiều góc) từ ảnh anh/chị tải lên, dùng giữ đúng nhân vật xuyên suốt các cảnh
                          </p>
                        </>
                      )}
                    </div>

                    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">🤖 Agent xử lý</p>
                      <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Agent</label>
                      <select
                        disabled
                        value="default"
                        className="mb-2 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-base text-zinc-500 outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                      >
                        <option value="default">Mặc định</option>
                      </select>
                      <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Model chat</label>
                      <select
                        value={storyModelChatKey}
                        onChange={(e) => setStoryModelChatKey(e.target.value)}
                        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      >
                        {STORY_MODEL_CHAT_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">Admin chỉnh hướng dẫn Agent trong /admin.</p>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-base font-medium text-zinc-500 dark:text-zinc-400">⚙️ Cấu hình media</p>
                  <div className="space-y-3">
                    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">🖼️ Ảnh phân cảnh</p>
                      {(() => {
                        const selected = storyImageModels.find((m) => m.key === storyImageModelKey);
                        return (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Model</label>
                              <select
                                value={storyImageModelKey ?? ""}
                                onChange={(e) => {
                                  setStoryImageModelKey(e.target.value);
                                  const m = storyImageModels.find((x) => x.key === e.target.value);
                                  setStoryResolutionKey(m?.resolution_price_vnd ? Object.keys(m.resolution_price_vnd)[0] : null);
                                  if (m?.aspect_ratios && !m.aspect_ratios.includes(storyAspectRatio)) setStoryAspectRatio(m.aspect_ratios[0]);
                                }}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {Array.from(new Set(storyImageModels.map((m) => m.provider))).map((provider) => (
                                  <optgroup key={provider} label={provider}>
                                    {storyImageModels
                                      .filter((m) => m.provider === provider)
                                      .map((m) => (
                                        <option key={m.key} value={m.key}>
                                          {m.label} — {m.provider_cost_vnd}đ/cảnh
                                        </option>
                                      ))}
                                  </optgroup>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Tỉ lệ</label>
                              <select
                                value={storyAspectRatio}
                                onChange={(e) => setStoryAspectRatio(e.target.value)}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {(selected?.aspect_ratios ?? ["9:16", "16:9", "1:1"]).map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {selected?.resolution_price_vnd && (
                              <div>
                                <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Độ phân giải</label>
                                <select
                                  value={storyResolutionKey ?? ""}
                                  onChange={(e) => setStoryResolutionKey(e.target.value)}
                                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                >
                                  {Object.entries(selected.resolution_price_vnd).map(([k, v]) => (
                                    <option key={k} value={k}>
                                      {k} — {v}đ
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                        Đơn giá đã chọn: <strong className="text-zinc-900 dark:text-zinc-50">{storyImageCost ?? "?"} credit</strong>
                      </p>
                    </div>

                    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">🎬 Video phân cảnh</p>
                      {(() => {
                        const selected = storyVideoModels.find((m) => m.key === storyVideoModelKey);
                        return (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Model</label>
                              <select
                                value={storyVideoModelKey ?? ""}
                                onChange={(e) => {
                                  setStoryVideoModelKey(e.target.value);
                                  const m = storyVideoModels.find((x) => x.key === e.target.value);
                                  setStoryDurationKey(m?.duration_price_vnd ? Object.keys(m.duration_price_vnd)[0] : null);
                                }}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {Array.from(new Set(storyVideoModels.map((m) => m.provider))).map((provider) => (
                                  <optgroup key={provider} label={provider}>
                                    {storyVideoModels
                                      .filter((m) => m.provider === provider)
                                      .map((m) => (
                                        <option key={m.key} value={m.key}>
                                          {m.label} — {m.provider_cost_vnd}đ/cảnh
                                        </option>
                                      ))}
                                  </optgroup>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Tỉ lệ</label>
                              <select
                                value={storyAspectRatio}
                                onChange={(e) => setStoryAspectRatio(e.target.value)}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {(selected?.aspect_ratios ?? ["9:16", "16:9", "1:1"]).map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {selected?.duration_price_vnd && (
                              <div>
                                <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Thời lượng</label>
                                <select
                                  value={storyDurationKey ?? ""}
                                  onChange={(e) => setStoryDurationKey(e.target.value)}
                                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                >
                                  {Object.entries(selected.duration_price_vnd).map(([k, v]) => (
                                    <option key={k} value={k}>
                                      {k}s — {v}đ
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                        Đơn giá đã chọn: <strong className="text-zinc-900 dark:text-zinc-50">{storyVideoCost ?? "?"} credit</strong>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <p className="mb-1 text-sm font-medium text-zinc-500 dark:text-zinc-400">Số phân cảnh</p>
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: STORY_MAX_SCENES - STORY_MIN_SCENES + 1 }, (_, i) => STORY_MIN_SCENES + i).map((n) => (
                    <button
                      key={n}
                      onClick={() => setNumScenes(n)}
                      className={`rounded-full border px-4 py-1.5 text-sm font-medium ${
                        numScenes === n
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                          : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                      }`}
                    >
                      {n} cảnh
                    </button>
                  ))}
                </div>
              </div>

              <label className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={storyAutoVideo} onChange={(e) => setStoryAutoVideo(e.target.checked)} />
                Tự động tạo video luôn (gộp 1 lượt) — mặc định tắt: chỉ tạo ảnh trước, xem ưng ý mới tạo video
              </label>

              {storyStatusText && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{storyStatusText}</p>}
              {storyError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{storyError}</p>}

              {storyStatus === "character_ready" && storyCharacterSheetUrl && (
                <div
                  ref={storyCharacterPreviewRef}
                  className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <p className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh Character (nhiều góc) — xem trước rồi mới chia cảnh
                  </p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={storyCharacterSheetUrl} alt="Character sheet" className="w-full max-w-xl rounded-lg" />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <a
                      href={`/api/download?url=${encodeURIComponent(storyCharacterSheetUrl)}&filename=character-sheet.png`}
                      download
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Tải xuống
                    </a>
                    {storyCharacterSource !== "reused" && (
                      <button
                        onClick={handleRegenerateCharacter}
                        disabled={storyRegeneratingCharacter || storyContinuingScenes}
                        className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {storyRegeneratingCharacter ? "Đang tạo lại..." : "🔄 Tạo lại Character"}
                      </button>
                    )}
                    {storyCharacterSource !== "reused" && (
                      <button
                        onClick={handleSaveCharacter}
                        disabled={storySavingCharacter}
                        className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {storySavingCharacter ? "Đang lưu..." : "💾 Lưu vào thư viện"}
                      </button>
                    )}
                    <button
                      onClick={handleContinueToScenes}
                      disabled={storyContinuingScenes || storyRegeneratingCharacter}
                      className="ml-auto rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
                    >
                      {storyContinuingScenes ? "Đang gửi..." : "Tiếp tục chia cảnh →"}
                    </button>
                  </div>
                  {storySavedCharacterMsg && <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{storySavedCharacterMsg}</p>}
                </div>
              )}

              {storyStatus === "images_ready" && storyScenes && (
                <div
                  ref={storyScenesPreviewRef}
                  className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <p className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">Ảnh từng phân cảnh — xem trước rồi mới tạo video</p>
                  <div className="grid grid-cols-4 gap-2">
                    {storyScenes.map((s) => (
                      <div key={s.position} className="aspect-square overflow-hidden rounded-lg bg-zinc-200 dark:bg-zinc-700">
                        {s.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.imageUrl} alt={`Cảnh ${s.position + 1}`} className="h-full w-full object-cover" />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-sm text-zinc-600 dark:text-zinc-400">
                      Tạo video sẽ trừ thêm <strong className="text-zinc-900 dark:text-zinc-50">{storyVideoCost ?? "?"} credit</strong>
                    </span>
                    <button
                      onClick={handleContinueToVideo}
                      disabled={storyContinuing}
                      className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
                    >
                      {storyContinuing ? "Đang gửi..." : "Tạo video"}
                    </button>
                  </div>
                </div>
              )}

              {storyResult && (
                <div ref={storyResultRef} className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="mb-1 text-sm font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
                  <video src={storyResult} controls className="w-full max-w-md rounded-lg" />
                  <div className="mt-3 flex gap-2">
                    <a
                      href={`/api/download?url=${encodeURIComponent(storyResult)}&filename=video-tu-y-tuong.mp4`}
                      download
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Tải xuống
                    </a>
                    <button
                      onClick={() => {
                        setStoryResult(null);
                        setStoryCharacterImages([]);
                        setStorySelectedSavedCharacterId(null);
                        setStoryCharacterSheetUrl(null);
                        setStoryCharacterSource(null);
                        setStoryScenes(null);
                        setStoryStatus(null);
                        setStoryJobId(null);
                        setInput("");
                      }}
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Chạy lại với input khác
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mb-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={app.inputPlaceholder}
                rows={4}
                className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <div className="mt-2 flex items-center gap-2">
                <label className="cursor-pointer text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
                  Hoặc tải file .txt lên
                  <input type="file" accept=".txt,text/plain" onChange={handleTextFileChange} className="hidden" />
                </label>
                {textFileError && <p className="text-xs text-red-600 dark:text-red-400">{textFileError}</p>}
              </div>
            </div>
          )}

          {(app.inputType === "outfit-swap" || app.inputType === "dialogue-video" || app.inputType === "story-video") && !user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : app.inputType === "dialogue-video" ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">{dialogueCreditCost ?? app.creditCost} credit</strong>{" "}
                ({dialogueCharacters.length} nhân vật)
              </span>
              <button
                onClick={handleRunDialogueVideo}
                disabled={dialogueRunning || dialogueCharacters.some((c) => !c.image || !c.line.trim())}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {dialogueRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          ) : app.inputType === "story-video" ? (
            <div className="flex items-center justify-between">
              <span className="text-base text-zinc-600 dark:text-zinc-400">
                {storySelectedSavedCharacterId ? (
                  "Character đã lưu — không tốn credit bước này"
                ) : (
                  <>
                    Bước này tốn tối đa{" "}
                    <strong className="text-zinc-900 dark:text-zinc-50">{storyCharacterCost ?? "?"} credit</strong> (chỉ khi cần tạo Character mới) — phần ảnh/video (~
                    {storyAutoVideo ? (storyImageCost ?? 0) + (storyVideoCost ?? 0) : (storyImageCost ?? app.creditCost)} credit,{" "}
                    {numScenes} phân cảnh) tính ở bước sau, sau khi anh/chị duyệt Character
                  </>
                )}
              </span>
              <button
                onClick={handleRunStoryVideo}
                disabled={
                  storyRunning ||
                  (!storySelectedSavedCharacterId && storyCharacterImages.length === 0) ||
                  !input.trim() ||
                  !storyImageModelKey ||
                  !storyVideoModelKey
                }
                className="rounded-full bg-zinc-900 px-6 py-2.5 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {storyRunning ? "Đang xử lý..." : storyAutoVideo ? "Chạy phân cảnh + ảnh + video" : "Chạy phân cảnh + ảnh"}
              </button>
            </div>
          ) : app.inputType === "outfit-swap" ? (
            <div className={`flex items-center justify-between ${isTwoColumnLayout ? "mt-auto pt-4" : ""}`}>
              <span className={isTwoColumnLayout ? "text-base text-zinc-600 dark:text-zinc-400" : "text-sm text-zinc-600 dark:text-zinc-400"}>
                {(() => {
                  const pricePerImage = outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.pricePerImage ?? 0;
                  return (
                    <>
                      Thao tác này sẽ trừ{" "}
                      <strong className="text-zinc-900 dark:text-zinc-50">
                        {pricePerImage * garmentImages.length} credit
                      </strong>{" "}
                      ({garmentImages.length} × {pricePerImage} credit)
                    </>
                  );
                })()}
              </span>
              <button
                onClick={handleRunOutfitSwap}
                disabled={isRunning || garmentImages.length === 0 || !imageDataUrl || !outfitSwapModelChoice}
                className={
                  isTwoColumnLayout
                    ? "rounded-full bg-zinc-900 px-5 py-2 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    : "rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                }
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          ) : !user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : (
            <div
              className={`flex items-center justify-between ${isTwoColumnLayout ? "mt-auto pt-4" : ""}`}
            >
              <span
                className={
                  isTwoColumnLayout
                    ? "text-base text-zinc-600 dark:text-zinc-400"
                    : "text-sm text-zinc-600 dark:text-zinc-400"
                }
              >
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">
                  {(() => {
                    if (videoTiers.length > 0) {
                      const tier = videoTiers.find((t) => t.key === selectedVideoTier);
                      return tier?.creditCost ?? tier?.creditCostByDuration?.[selectedVideoDuration] ?? app.creditCost;
                    }
                    return liveCreditCost ?? app.creditCost;
                  })()}{" "}
                  credit
                </strong>
              </span>
              <button
                onClick={
                  app.inputType === "video-gen"
                    ? handleRunVideo
                    : app.inputType === "motion-transfer"
                    ? handleRunMotionTransfer
                    : app.inputType === "video-transform"
                    ? handleRunVideoTransform
                    : handleRun
                }
                disabled={
                  isRunning ||
                  (app.inputType === "image"
                    ? !imageDataUrl
                    : app.inputType === "motion-transfer"
                    ? !imageDataUrl || !endFrameDataUrl || uploadingReferenceVideo
                    : app.inputType === "video-transform"
                    ? !imageDataUrl || !endFrameDataUrl
                    : input.trim() === "")
                }
                className={
                  isTwoColumnLayout
                    ? "rounded-full bg-zinc-900 px-5 py-2 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    : "rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                }
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          )}

          {videoStatusText && (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{videoStatusText}</p>
          )}

          {outfitSwapStatusText && (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{outfitSwapStatusText}</p>
          )}

          {runError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{runError}</p>
          )}
          </div>
          <div className={isTwoColumnLayout ? "flex h-full flex-col" : undefined}>

          {isTwoColumnLayout && !result && !outfitSwapResults && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
              <p className="text-sm font-medium text-zinc-400 dark:text-zinc-500">
                {isRunning ? "Đang xử lý..." : "Kết quả sẽ hiển thị ở đây"}
              </p>
              {!isRunning && (
                <p className="text-xs text-zinc-400 dark:text-zinc-600">Bấm &quot;Chạy ngay&quot; để bắt đầu</p>
              )}
            </div>
          )}

          {outfitSwapResults && (
            <div
              className={`mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800 ${
                isTwoColumnLayout ? "flex flex-1 flex-col" : ""
              }`}
            >
              <p className="mb-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Kết quả từ AI ({outfitSwapResults.length} ảnh)
              </p>
              <div
                className={
                  outfitSwapResults.length === 1
                    ? isTwoColumnLayout
                      ? "flex flex-1 flex-col items-center justify-center"
                      : "flex justify-center"
                    : "grid gap-3"
                }
                style={outfitSwapResults.length === 1 ? undefined : { gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
              >
                {outfitSwapResults.map((url, index) => (
                  <div key={index} className={outfitSwapResults.length === 1 ? "w-full max-w-md" : undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`Kết quả ${index + 1}`}
                      className={
                        outfitSwapResults.length === 1
                          ? `w-full rounded-lg object-contain ${isTwoColumnLayout ? "max-h-[55vh]" : ""}`
                          : "aspect-square w-full rounded-lg object-cover"
                      }
                    />
                    <div className="mt-1 flex items-center justify-center gap-2">
                      <a
                        href={`/api/download?url=${encodeURIComponent(url)}&filename=ket-qua-${index + 1}.jpg`}
                        download
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        Tải xuống
                      </a>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <button
                        onClick={() => handleRetryOutfitSwapItem(index)}
                        disabled={retryingIndex !== null}
                        title={`Chạy lại ảnh này (trừ thêm ${outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.pricePerImage ?? ""} credit)`}
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        {retryingIndex === index ? "Đang chạy lại..." : "Chạy lại ảnh này"}
                      </button>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <Link
                        href={`/mini-app/video-truoc-sau?startImageUrl=${encodeURIComponent(
                          outfitSwapModelImageUrl ?? ""
                        )}&endImageUrl=${encodeURIComponent(url)}`}
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        Tạo video từ ảnh này
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  setOutfitSwapResults(null);
                  setGarmentImages([]);
                  setImageDataUrl(null);
                }}
                className={`rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300 ${
                  isTwoColumnLayout ? "mt-auto pt-3" : "mt-3"
                }`}
              >
                Chạy lại với ảnh khác
              </button>
            </div>
          )}

          {result && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
              {app.outputType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={result}
                  alt="Ảnh do AI tạo"
                  className={`w-full max-w-md rounded-lg ${isTwoColumnLayout ? "max-h-[50vh] object-contain" : ""}`}
                />
              ) : app.outputType === "video" ? (
                <video
                  src={result}
                  controls
                  className={`w-full max-w-md rounded-lg ${isTwoColumnLayout ? "max-h-[50vh] object-contain" : ""}`}
                />
              ) : (
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{result}</p>
              )}
              <p className="mt-4 text-sm font-bold text-zinc-800 dark:text-zinc-200">Bạn muốn làm gì tiếp theo?</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {app.outputType === "image" || app.outputType === "video" ? (
                  <a
                    href={`/api/download?url=${encodeURIComponent(result)}&filename=ket-qua.${app.outputType === "video" ? "mp4" : "jpg"}`}
                    download
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Tải xuống
                  </a>
                ) : (
                  <button className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                    Tải xuống
                  </button>
                )}
                <button
                  onClick={() => {
                    setResult(null);
                    setInput("");
                    setImageDataUrl(null);
                    setEndFrameDataUrl(null);
                    setVideoStatusText(null);
                    setFeedbackRating(null);
                  }}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  Chạy lại với input khác
                </button>
                <button
                  onClick={handleShareResult}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  {shareCopied ? "Đã sao chép liên kết!" : "Chia sẻ"}
                </button>
                {app.outputType === "video" && currentVideoJobId && (
                  <button
                    onClick={() => setShowMusicPicker((v) => !v)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Thêm âm thanh
                  </button>
                )}
                {app.outputType === "video" &&
                  (youtubePublishedUrl ? (
                    <p className="text-xs text-emerald-700 dark:text-emerald-400">
                      Đã đăng lên YouTube:{" "}
                      <a href={youtubePublishedUrl} target="_blank" rel="noopener noreferrer" className="underline">
                        {youtubePublishedUrl}
                      </a>
                    </p>
                  ) : !youtubeStatus?.connected ? (
                    <a
                      href={`/api/youtube/authorize?userId=${user?.id ?? ""}`}
                      className="inline-block rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Kết nối YouTube để đăng video
                    </a>
                  ) : (
                    <button
                      onClick={() => setShowYoutubeForm((v) => !v)}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Đăng lên YouTube ({youtubeStatus.channelTitle})
                    </button>
                  ))}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setFeedbackRating((v) => (v === "up" ? null : "up"))}
                  title="Kết quả tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "up"
                      ? "border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👍
                </button>
                <button
                  onClick={() => setFeedbackRating((v) => (v === "down" ? null : "down"))}
                  title="Kết quả chưa tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "down"
                      ? "border-red-400 bg-red-50 dark:border-red-600 dark:bg-red-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👎
                </button>
                {feedbackRating && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Cảm ơn phản hồi của bạn!</span>
                )}
              </div>

              {app.outputType === "video" && (showMusicPicker || showYoutubeForm || youtubeError) && (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                  {showMusicPicker && currentVideoJobId && (
                    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <div className="flex gap-1">
                        <button
                          onClick={() => setMusicMode("library")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "library"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Từ thư viện
                        </button>
                        <button
                          onClick={() => setMusicMode("upload")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "upload"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Tải nhạc từ máy
                        </button>
                      </div>

                      {musicMode === "library" ? (
                        musicTracks.length === 0 ? (
                          <p className="text-xs text-zinc-400 dark:text-zinc-500">Thư viện chưa có bài nhạc nào.</p>
                        ) : (
                          <select
                            value={selectedTrackId ?? ""}
                            onChange={(e) => setSelectedTrackId(e.target.value ? Number(e.target.value) : null)}
                            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                          >
                            <option value="">Chọn bài nhạc...</option>
                            {musicTracks.map((track) => (
                              <option key={track.id} value={track.id}>
                                {track.name}
                              </option>
                            ))}
                          </select>
                        )
                      ) : (
                        <div>
                          <label className="inline-block cursor-pointer rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                            {customAudioDataUrl ? "Đã chọn file — bấm để đổi" : "Chọn file nhạc (mp3/wav/m4a, tối đa 10MB)"}
                            <input
                              type="file"
                              accept="audio/*"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (!file) return;
                                setCustomAudioError(null);
                                if (!file.type.startsWith("audio/")) {
                                  setCustomAudioError("Chỉ nhận file nhạc (mp3/wav/m4a)");
                                  return;
                                }
                                if (file.size > 10 * 1024 * 1024) {
                                  setCustomAudioError("File nhạc tối đa 10MB");
                                  return;
                                }
                                const reader = new FileReader();
                                reader.onload = () => setCustomAudioDataUrl(reader.result as string);
                                reader.readAsDataURL(file);
                              }}
                            />
                          </label>
                          {customAudioError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{customAudioError}</p>}
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Nhạc do anh tự chọn — anh tự chịu trách nhiệm về bản quyền file này.
                          </p>
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Chưa có nhạc?{" "}
                            <a href="https://www.youtube.com/audiolibrary" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              YouTube Audio Library
                            </a>
                            ,{" "}
                            <a href="https://pixabay.com/music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Pixabay Music
                            </a>{" "}
                            hoặc{" "}
                            <a href="https://mixkit.co/free-stock-music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Mixkit
                            </a>{" "}
                            có nhạc miễn phí dùng thương mại được, tải về rồi upload lại đây.
                          </p>
                        </div>
                      )}

                      <button
                        onClick={handleAddMusic}
                        disabled={(musicMode === "library" ? !selectedTrackId : !customAudioDataUrl) || addingMusic}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {addingMusic ? "Đang ghép nhạc..." : "Ghép nhạc"}
                      </button>
                      {musicAddError && <p className="text-xs text-red-600 dark:text-red-400">{musicAddError}</p>}
                      {musicAddedSuccess && (
                        <p className="text-xs text-emerald-700 dark:text-emerald-400">✓ Đã ghép nhạc thành công — xem thử video ở trên trước khi đăng.</p>
                      )}
                    </div>
                  )}

                  {showYoutubeForm && youtubeStatus?.connected && !youtubePublishedUrl && (
                    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Đăng lên kênh: <strong>{youtubeStatus.channelTitle ?? "YouTube"}</strong>
                      </p>
                      <input
                        type="text"
                        value={youtubeTitle}
                        onChange={(e) => setYoutubeTitle(e.target.value)}
                        placeholder="Tiêu đề video"
                        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                      <textarea
                        value={youtubeDescription}
                        onChange={(e) => setYoutubeDescription(e.target.value)}
                        placeholder="Mô tả (không bắt buộc)"
                        rows={2}
                        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handlePublishYoutube}
                          disabled={youtubePublishing || !youtubeTitle.trim()}
                          className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {youtubePublishing ? "Đang đăng..." : "Đăng lên YouTube"}
                        </button>
                        <button
                          onClick={() => setShowYoutubeForm(false)}
                          className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        >
                          Huỷ
                        </button>
                      </div>
                    </div>
                  )}
                  {youtubeError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{youtubeError}</p>}
                </div>
              )}
            </div>
          )}
          </div>
          </div>
        </section>

        {/* Gợi ý Mini App liên quan — Tập 5 mục 4.1 */}
        {relatedApps.length > 0 && (
          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Mini App liên quan
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {relatedApps.map((related) => (
                <Link
                  key={related.id}
                  href={`/mini-app/${related.id}`}
                  className="rounded-xl border border-zinc-200 bg-white p-4 text-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <p className="mb-1 font-medium text-zinc-900 dark:text-zinc-50">{related.name}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{related.creditCost} credit</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

type CommunityAppInfo = {
  id: string;
  name: string;
  description: string;
  category: string;
  creditCost: number;
  developerName: string | null;
  outputType: "text" | "image" | "video";
};

function CommunityMiniAppRunner({ miniAppId }: { miniAppId: string }) {
  const { user } = useAuth();
  const [appInfo, setAppInfo] = useState<CommunityAppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [endFrameDataUrl, setEndFrameDataUrl] = useState<string | null>(null);
  const [endFrameError, setEndFrameError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [videoStatusText, setVideoStatusText] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [currentVideoJobId, setCurrentVideoJobId] = useState<number | null>(null);
  const [musicTracks, setMusicTracks] = useState<{ id: number; name: string; file_url: string }[]>([]);
  const [showMusicPicker, setShowMusicPicker] = useState(false);
  const [musicMode, setMusicMode] = useState<"library" | "upload">("library");
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [customAudioDataUrl, setCustomAudioDataUrl] = useState<string | null>(null);
  const [customAudioError, setCustomAudioError] = useState<string | null>(null);
  const [addingMusic, setAddingMusic] = useState(false);
  const [musicAddError, setMusicAddError] = useState<string | null>(null);
  const [musicAddedSuccess, setMusicAddedSuccess] = useState(false);

  const [shareCopied, setShareCopied] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);

  async function handleShareResult() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      setShareCopied(false);
    }
  }

  useEffect(() => {
    fetch(`/api/mini-apps/community/${miniAppId}`)
      .then((res) => res.json())
      .then((data) => setAppInfo(data.app ?? null))
      .finally(() => setLoading(false));
  }, [miniAppId]);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (appInfo?.outputType !== "video") return;
    fetch("/api/background-music")
      .then((res) => res.json())
      .then((data) => setMusicTracks(data.tracks ?? []))
      .catch(() => {});
  }, [appInfo?.outputType]);

  // Tự khôi phục job video gần nhất khi khách quay lại trang (đóng tab/tắt máy giữa chừng rồi mở lại).
  useEffect(() => {
    if (appInfo?.outputType !== "video" || !user) return;
    fetch(`/api/video/latest?userId=${user.id}&miniAppId=${miniAppId}`)
      .then((res) => res.json())
      .then((data) => {
        const job = data.job;
        if (!job) return;
        setCurrentVideoJobId(job.id);
        if (job.status === "done" && job.outputUrl) {
          setResult(job.outputUrl);
        } else if (job.status === "pending" || job.status === "processing") {
          setIsRunning(true);
          setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
          pollVideoStatus(job.id);
        }
      })
      .catch(() => {});
  }, [appInfo?.outputType, user, miniAppId]);

  async function handleAddMusic() {
    if (!user || !currentVideoJobId) return;
    if (musicMode === "library" && !selectedTrackId) return;
    if (musicMode === "upload" && !customAudioDataUrl) return;
    setAddingMusic(true);
    setMusicAddError(null);
    setMusicAddedSuccess(false);
    try {
      const res = await fetch("/api/video/add-music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          jobId: currentVideoJobId,
          trackId: musicMode === "library" ? selectedTrackId : undefined,
          customAudioDataUrl: musicMode === "upload" ? customAudioDataUrl : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMusicAddError(data.error ?? "Không ghép được nhạc");
        return;
      }
      setResult(data.url);
      setMusicAddedSuccess(true);
    } catch {
      setMusicAddError("Không kết nối được tới server");
    } finally {
      setAddingMusic(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImageError(null);
    if (!file.type.startsWith("image/")) {
      setImageError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setImageError("Ảnh tối đa 4MB, chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleEndFrameFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setEndFrameError(null);
    if (!file.type.startsWith("image/")) {
      setEndFrameError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setEndFrameError("Ảnh tối đa 4MB, chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setEndFrameDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleRun() {
    if (!user || !appInfo) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);

    try {
      const res = await fetch(`/api/run/${appInfo.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, userId: user.id, imageDataUrl }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setResult(data.output);
      window.dispatchEvent(new Event("balance-updated"));
    } catch {
      setRunError("Không kết nối được tới server");
    } finally {
      setIsRunning(false);
    }
  }

  function pollVideoStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setResult(data.outputUrl);
          setIsRunning(false);
          setVideoStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setIsRunning(false);
          setVideoStatusText(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunVideo() {
    if (!user || !appInfo) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: appInfo.id,
          userId: user.id,
          prompt: input,
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  if (loading) {
    return <div className="min-h-full bg-zinc-50 dark:bg-black" />;
  }

  if (!appInfo) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-zinc-600 dark:text-zinc-400">Không tìm thấy Mini App này.</p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium underline">
          Quay lại Danh mục
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← Quay lại Danh mục
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {CATEGORIES[appInfo.category as keyof typeof CATEGORIES] ?? appInfo.category}
          </span>
          {appInfo.developerName && (
            <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-400">
              Cộng đồng
            </span>
          )}
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{appInfo.name}</h1>
        <p className="mb-4 text-zinc-600 dark:text-zinc-400">{appInfo.description}</p>
        <div className="mb-8 flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
          {appInfo.developerName && <span>Tạo bởi {appInfo.developerName}</span>}
        </div>

        <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Thử ngay
          </h2>
          <div className="mb-4">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={appInfo.outputType === "text" ? "Nhập nội dung..." : "Mô tả bối cảnh/nội dung muốn tạo..."}
              rows={appInfo.outputType === "text" ? 4 : 3}
              maxLength={appInfo.outputType === "video" ? VIDEO_PROMPT_MAX_LENGTH : undefined}
              className={`w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 ${
                appInfo.outputType === "video" ? "mb-1" : "mb-3"
              }`}
            />
            {appInfo.outputType === "video" && (
              <p
                className={`mb-3 text-right text-xs ${
                  input.length > VIDEO_PROMPT_MAX_LENGTH - 100 ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {input.length}/{VIDEO_PROMPT_MAX_LENGTH} ký tự — mô tả quá dài AI sẽ từ chối xử lý
              </p>
            )}

            {appInfo.outputType === "image" && (
              <>
                <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Ảnh tham chiếu (không bắt buộc)
                </p>
                {imageDataUrl ? (
                  <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageDataUrl} alt="Ảnh tham chiếu đã chọn" className="h-20 w-20 rounded-md object-cover" />
                    <button
                      onClick={() => setImageDataUrl(null)}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Xóa ảnh
                    </button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
                    <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh tham chiếu</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                    <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                  </label>
                )}
                {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
              </>
            )}

            {appInfo.outputType === "video" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh khung hình đầu (không bắt buộc)</p>
                  {imageDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh khung hình đầu" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh khung hình cuối (không bắt buộc)</p>
                  {endFrameDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={endFrameDataUrl} alt="Ảnh khung hình cuối" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleEndFrameFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
                </div>
              </div>
            )}
          </div>

          {!user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">{appInfo.creditCost} credit</strong>
              </span>
              <button
                onClick={appInfo.outputType === "video" ? handleRunVideo : handleRun}
                disabled={isRunning || input.trim() === ""}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          )}

          {videoStatusText && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{videoStatusText}</p>}

          {runError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{runError}</p>}

          {result && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
              {appInfo.outputType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result} alt="Ảnh do AI tạo" className="w-full max-w-md rounded-lg" />
              ) : appInfo.outputType === "video" ? (
                <video src={result} controls className="w-full max-w-md rounded-lg" />
              ) : (
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{result}</p>
              )}
              <p className="mt-4 text-sm font-bold text-zinc-800 dark:text-zinc-200">Bạn muốn làm gì tiếp theo?</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {appInfo.outputType === "image" || appInfo.outputType === "video" ? (
                  <a
                    href={`/api/download?url=${encodeURIComponent(result)}&filename=ket-qua.${appInfo.outputType === "video" ? "mp4" : "jpg"}`}
                    download
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Tải xuống
                  </a>
                ) : (
                  <button className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                    Tải xuống
                  </button>
                )}
                <button
                  onClick={() => {
                    setResult(null);
                    setInput("");
                    setImageDataUrl(null);
                    setEndFrameDataUrl(null);
                    setVideoStatusText(null);
                    setFeedbackRating(null);
                  }}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  Chạy lại với input khác
                </button>
                <button
                  onClick={handleShareResult}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  {shareCopied ? "Đã sao chép liên kết!" : "Chia sẻ"}
                </button>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setFeedbackRating((v) => (v === "up" ? null : "up"))}
                  title="Kết quả tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "up"
                      ? "border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👍
                </button>
                <button
                  onClick={() => setFeedbackRating((v) => (v === "down" ? null : "down"))}
                  title="Kết quả chưa tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "down"
                      ? "border-red-400 bg-red-50 dark:border-red-600 dark:bg-red-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👎
                </button>
                {feedbackRating && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Cảm ơn phản hồi của bạn!</span>
                )}
              </div>

              {appInfo.outputType === "video" && currentVideoJobId && (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                  <button
                    onClick={() => setShowMusicPicker((v) => !v)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Thêm âm thanh
                  </button>

                  {showMusicPicker && (
                    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <div className="flex gap-1">
                        <button
                          onClick={() => setMusicMode("library")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "library"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Từ thư viện
                        </button>
                        <button
                          onClick={() => setMusicMode("upload")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "upload"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Tải nhạc từ máy
                        </button>
                      </div>

                      {musicMode === "library" ? (
                        musicTracks.length === 0 ? (
                          <p className="text-xs text-zinc-400 dark:text-zinc-500">Thư viện chưa có bài nhạc nào.</p>
                        ) : (
                          <select
                            value={selectedTrackId ?? ""}
                            onChange={(e) => setSelectedTrackId(e.target.value ? Number(e.target.value) : null)}
                            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                          >
                            <option value="">Chọn bài nhạc...</option>
                            {musicTracks.map((track) => (
                              <option key={track.id} value={track.id}>
                                {track.name}
                              </option>
                            ))}
                          </select>
                        )
                      ) : (
                        <div>
                          <label className="inline-block cursor-pointer rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                            {customAudioDataUrl ? "Đã chọn file — bấm để đổi" : "Chọn file nhạc (mp3/wav/m4a, tối đa 10MB)"}
                            <input
                              type="file"
                              accept="audio/*"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (!file) return;
                                setCustomAudioError(null);
                                if (!file.type.startsWith("audio/")) {
                                  setCustomAudioError("Chỉ nhận file nhạc (mp3/wav/m4a)");
                                  return;
                                }
                                if (file.size > 10 * 1024 * 1024) {
                                  setCustomAudioError("File nhạc tối đa 10MB");
                                  return;
                                }
                                const reader = new FileReader();
                                reader.onload = () => setCustomAudioDataUrl(reader.result as string);
                                reader.readAsDataURL(file);
                              }}
                            />
                          </label>
                          {customAudioError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{customAudioError}</p>}
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Nhạc do anh tự chọn — anh tự chịu trách nhiệm về bản quyền file này.
                          </p>
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Chưa có nhạc?{" "}
                            <a href="https://www.youtube.com/audiolibrary" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              YouTube Audio Library
                            </a>
                            ,{" "}
                            <a href="https://pixabay.com/music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Pixabay Music
                            </a>{" "}
                            hoặc{" "}
                            <a href="https://mixkit.co/free-stock-music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Mixkit
                            </a>{" "}
                            có nhạc miễn phí dùng thương mại được, tải về rồi upload lại đây.
                          </p>
                        </div>
                      )}

                      <button
                        onClick={handleAddMusic}
                        disabled={(musicMode === "library" ? !selectedTrackId : !customAudioDataUrl) || addingMusic}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {addingMusic ? "Đang ghép nhạc..." : "Ghép nhạc"}
                      </button>
                      {musicAddError && <p className="text-xs text-red-600 dark:text-red-400">{musicAddError}</p>}
                      {musicAddedSuccess && (
                        <p className="text-xs text-emerald-700 dark:text-emerald-400">✓ Đã ghép nhạc thành công — xem thử video ở trên trước khi đăng.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
}
