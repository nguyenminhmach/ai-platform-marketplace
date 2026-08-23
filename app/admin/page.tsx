"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Stats = {
  userCount: number;
  totalRevenueVnd: number;
  totalCreditsSold: number;
  totalCreditsUsed: number;
  paidOrderCount: number;
  recentTransactions: {
    id: number;
    user_id: string;
    amount: number;
    type: string;
    mini_app_id: string | null;
    created_at: string;
  }[];
  recentUsers: { user_id: string; credit_balance: number; created_at: string }[];
};

const TYPE_LABEL: Record<string, string> = {
  topup: "Nạp credit",
  usage: "Sử dụng",
  refund: "Hoàn credit",
  bonus: "Thưởng",
};

function formatVnd(amount: number) {
  return amount.toLocaleString("vi-VN") + "đ";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string) {
  return id.slice(0, 8) + "...";
}

type Settings = {
  signupBonusCredits: number;
  promoBannerEnabled: boolean;
  subscriptionEnabled: boolean;
  subscriptionPriceVnd: number;
  subscriptionDurationDays: number;
  mediaMarginPercent: number;
  vndPerCredit: number;
  usdToVndRate: number;
  freeTrialDailyCap: number;
};

type BackgroundMusicTrack = { id: number; name: string; file_url: string };

type MiniAppPrice = {
  id: string;
  name: string;
  creditCost: number;
  dynamic: boolean;
  isActive: boolean;
  ownApp: boolean;
  demoImageUrls: string[];
  outfitSwapModels: { generic: boolean; fashn: boolean; fashn_max: boolean } | null;
  modelTiers: Record<string, boolean> | null;
  isVideoApp: boolean;
  defaultPrompt: string;
  defaultPromptVisible: boolean;
  promptHelperInstructions: string;
  characterPrompt: string;
  storyImageModels: StoryModelEntry[] | null;
  storyVideoModels: StoryModelEntry[] | null;
};

// Catalog model ảnh/video nhiều nhà cung cấp cho app "Video từ ý tưởng truyện" — multi_image chỉ có
// ý nghĩa với model ảnh (model video luôn nhận 1 ảnh keyframe/cảnh), field thừa với model video không
// gây lỗi gì vì backend chỉ đọc field mình cần.
type StoryModelEntry = {
  key: string;
  provider: string;
  label: string;
  model: string;
  provider_cost_vnd: number;
  multi_image?: boolean;
  enabled: boolean;
};

// 3 ảnh minh hoạ trên card trang chủ: trước → trang phục → sau (kiểu "A + B = C") thay vì 2 ảnh rời rạc,
// để minh hoạ rõ tính năng thay đồ như card tham khảo admin gửi.
const DEMO_IMAGE_SLOT_LABELS = ["Trước", "Trang phục", "Sau"];

// Nhãn hiển thị cho các key trong model_config.models — dùng cho khối "Tier chất lượng" tổng quát
// (app.modelTiers), không phải khối "Model AI" riêng của Thay trang phục.
const MODEL_TIER_LABELS: Record<string, string> = { budget: "Tiết kiệm", basic: "Cơ bản", premium: "Cao cấp" };

const MODEL_OPTIONS = [
  { value: "google/gemini-3-flash-preview", label: "Gemini Flash (rẻ, nhanh)" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet (chất lượng cao hơn, đắt hơn)" },
];

const NEW_APP_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "van-ban", label: "Văn bản" },
  { value: "anh", label: "Ảnh" },
  { value: "video", label: "Video" },
  { value: "am-thanh", label: "Âm thanh" },
];

type HomepageChip = { id: string; type: "category" | "search" | "link"; label: string; value: string };

const CHIP_TYPE_LABEL: Record<HomepageChip["type"], string> = {
  category: "Danh mục",
  search: "Tìm nhanh",
  link: "Liên kết",
};

type PendingDeveloper = { id: string; display_name: string; status: string; created_at: string };
type PendingApp = {
  id: string;
  name: string;
  description: string;
  category: string;
  credit_cost: number;
  developer_id: string;
  created_at: string;
};

export default function AdminPage() {
  const [authState, setAuthState] = useState<"checking" | "loggedOut" | "loggedIn">("checking");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [miniApps, setMiniApps] = useState<MiniAppPrice[] | null>(null);
  const [savingAppId, setSavingAppId] = useState<string | null>(null);
  const [savedAppId, setSavedAppId] = useState<string | null>(null);
  const [appPriceError, setAppPriceError] = useState<string | null>(null);
  const [togglingAppId, setTogglingAppId] = useState<string | null>(null);
  const [uploadingDemoImage, setUploadingDemoImage] = useState<string | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [promptVisibleDrafts, setPromptVisibleDrafts] = useState<Record<string, boolean>>({});
  const [savingPromptId, setSavingPromptId] = useState<string | null>(null);
  const [savedPromptId, setSavedPromptId] = useState<string | null>(null);
  const [helperInstructionsDrafts, setHelperInstructionsDrafts] = useState<Record<string, string>>({});
  const [savingHelperId, setSavingHelperId] = useState<string | null>(null);
  const [savedHelperId, setSavedHelperId] = useState<string | null>(null);
  const [characterPromptDrafts, setCharacterPromptDrafts] = useState<Record<string, string>>({});
  const [savingCharacterPromptId, setSavingCharacterPromptId] = useState<string | null>(null);
  const [savedCharacterPromptId, setSavedCharacterPromptId] = useState<string | null>(null);

  // Catalog model ảnh/video của "Video từ ý tưởng truyện" — draft riêng theo app.id + loại (ảnh/video),
  // chỉ ghi đè state gốc (app.storyImageModels/storyVideoModels) khi bấm "Lưu catalog".
  const [storyImageModelsDrafts, setStoryImageModelsDrafts] = useState<Record<string, StoryModelEntry[]>>({});
  const [storyVideoModelsDrafts, setStoryVideoModelsDrafts] = useState<Record<string, StoryModelEntry[]>>({});
  const [savingStoryModelsId, setSavingStoryModelsId] = useState<string | null>(null);
  const [savedStoryModelsId, setSavedStoryModelsId] = useState<string | null>(null);

  const [showNewAppForm, setShowNewAppForm] = useState(false);
  const [newAppType, setNewAppType] = useState<"text" | "image" | "video">("text");
  const [newApp, setNewApp] = useState({
    name: "",
    description: "",
    category: "van-ban",
    creditCost: 10,
    model: MODEL_OPTIONS[0].value,
    systemPrompt: "",
  });
  const [creatingApp, setCreatingApp] = useState(false);
  const [newAppError, setNewAppError] = useState<string | null>(null);

  const [pendingDevs, setPendingDevs] = useState<PendingDeveloper[]>([]);
  const [pendingApps, setPendingApps] = useState<PendingApp[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const [homepageChips, setHomepageChips] = useState<HomepageChip[] | null>(null);
  const [savingChips, setSavingChips] = useState(false);
  const [chipsError, setChipsError] = useState<string | null>(null);

  const [musicTracks, setMusicTracks] = useState<BackgroundMusicTrack[] | null>(null);
  const [musicUploadName, setMusicUploadName] = useState("");
  const [uploadingMusic, setUploadingMusic] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [deletingMusicId, setDeletingMusicId] = useState<number | null>(null);

  async function loadStats() {
    const res = await fetch("/api/admin/stats");
    if (res.status === 401) {
      setAuthState("loggedOut");
      return;
    }
    const data = await res.json();
    setStats(data);
    setAuthState("loggedIn");
  }

  async function loadSettings() {
    const res = await fetch("/api/admin/settings");
    if (!res.ok) return;
    const data = await res.json();
    setSettings(data);
  }

  async function loadMiniApps() {
    const res = await fetch("/api/admin/mini-apps");
    if (!res.ok) return;
    const data = await res.json();
    setMiniApps(data.apps);
  }

  async function loadDeveloperReview() {
    const res = await fetch("/api/admin/developer-review");
    if (!res.ok) return;
    const data = await res.json();
    setPendingDevs(data.pendingDevs ?? []);
    setPendingApps(data.pendingApps ?? []);
  }

  async function loadHomepageChips() {
    const res = await fetch("/api/admin/homepage-chips");
    if (!res.ok) return;
    const data = await res.json();
    setHomepageChips(data.chips ?? []);
  }

  async function loadBackgroundMusic() {
    const res = await fetch("/api/admin/background-music");
    if (!res.ok) return;
    const data = await res.json();
    setMusicTracks(data.tracks ?? []);
  }

  useEffect(() => {
    loadStats();
    loadSettings();
    loadMiniApps();
    loadDeveloperReview();
    loadHomepageChips();
    loadBackgroundMusic();
  }, []);

  // Nhạc nền do admin tự cung cấp (đã có bản quyền hợp lệ) — user chọn 1 bài trong danh sách này
  // để ghép vào video AI tạo ra, không phải AI tự sinh nhạc.
  async function handleUploadMusic(file: File) {
    if (!musicUploadName.trim()) {
      setMusicError("Nhập tên bài nhạc trước khi upload");
      return;
    }
    if (!file.type.startsWith("audio/")) {
      setMusicError("Chỉ nhận file nhạc (mp3/wav/m4a)");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMusicError("File nhạc tối đa 10MB");
      return;
    }
    setUploadingMusic(true);
    setMusicError(null);

    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const res = await fetch("/api/admin/background-music", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: musicUploadName.trim(), dataUrl }),
    });
    const data = await res.json().catch(() => ({}));
    setUploadingMusic(false);
    if (!res.ok) {
      setMusicError(data.error ?? "Không upload được nhạc");
      return;
    }
    setMusicUploadName("");
    loadBackgroundMusic();
  }

  async function handleDeleteMusic(id: number) {
    setDeletingMusicId(id);
    await fetch(`/api/admin/background-music?id=${id}`, { method: "DELETE" });
    setDeletingMusicId(null);
    loadBackgroundMusic();
  }

  async function saveHomepageChips(chips: HomepageChip[]) {
    setSavingChips(true);
    setChipsError(null);
    const res = await fetch("/api/admin/homepage-chips", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chips }),
    });
    setSavingChips(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setChipsError(data.error ?? "Không lưu được");
      return;
    }
    setHomepageChips(chips);
  }

  function handleMoveChip(index: number, direction: -1 | 1) {
    if (!homepageChips) return;
    const target = index + direction;
    if (target < 0 || target >= homepageChips.length) return;
    const next = [...homepageChips];
    [next[index], next[target]] = [next[target], next[index]];
    saveHomepageChips(next);
  }

  function handleDeleteChip(index: number) {
    if (!homepageChips) return;
    const next = homepageChips.filter((_, i) => i !== index);
    saveHomepageChips(next);
  }

  async function handleReview(type: "developer" | "mini_app", id: string, action: "approve" | "reject") {
    setReviewingId(id);
    await fetch("/api/admin/developer-review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id, action }),
    });
    setReviewingId(null);
    loadDeveloperReview();
    loadMiniApps();
  }

  async function handleSaveMiniAppPrice(id: string, creditCost: number) {
    setSavingAppId(id);
    setSavedAppId(null);
    setAppPriceError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, creditCost }),
    });
    setSavingAppId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không lưu được giá");
      return;
    }
    setSavedAppId(id);
    setTimeout(() => setSavedAppId(null), 2000);
    loadMiniApps();
  }

  async function handleToggleActive(id: string, isActive: boolean) {
    setTogglingAppId(id);
    await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive }),
    });
    setTogglingAppId(null);
    loadMiniApps();
  }

  // Ảnh minh hoạ hiện trên card trang chủ thay icon — upload lên bucket "demo-images" rồi lưu URL
  // vào model_config.demo_image_urls qua PATCH có sẵn. Tối đa 2 ảnh/app, đổi được bất cứ lúc nào.
  async function handleUploadDemoImage(app: MiniAppPrice, index: number, file: File) {
    if (!file.type.startsWith("image/")) {
      setAppPriceError("Chỉ nhận file ảnh");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setAppPriceError("Ảnh tối đa 4MB");
      return;
    }
    setUploadingDemoImage(`${app.id}-${index}`);
    setAppPriceError(null);

    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const uploadRes = await fetch("/api/admin/upload-demo-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: app.id, dataUrl }),
    });
    const uploadData = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok) {
      setUploadingDemoImage(null);
      setAppPriceError(uploadData.error ?? "Không upload được ảnh");
      return;
    }

    // Đệm bằng "" nếu upload thẳng vào ô sau khi ô trước còn trống — tránh mảng có "lỗ" (undefined)
    // biến thành null khi JSON.stringify, khiến server từ chối vì demoImageUrls phải toàn chuỗi.
    const nextUrls = [...app.demoImageUrls];
    while (nextUrls.length < index) nextUrls.push("");
    nextUrls[index] = uploadData.url;
    const saveRes = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, demoImageUrls: nextUrls }),
    });
    setUploadingDemoImage(null);
    if (!saveRes.ok) {
      const saveData = await saveRes.json().catch(() => ({}));
      setAppPriceError(saveData.error ?? "Không lưu được ảnh");
      return;
    }
    loadMiniApps();
  }

  // Prompt mặc định tự điền cho khách khi mở app tạo video — admin sửa được ngay từ đây, không cần deploy code.
  // Công tắc ẩn/hiện tách riêng khỏi nội dung: tắt không xoá bản đã soạn, chỉ ngưng tự điền cho khách.
  async function handleSaveDefaultPrompt(app: MiniAppPrice) {
    const value = promptDrafts[app.id] ?? app.defaultPrompt;
    const visible = promptVisibleDrafts[app.id] ?? app.defaultPromptVisible;
    setSavingPromptId(app.id);
    setAppPriceError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, defaultPrompt: value, defaultPromptVisible: visible }),
    });
    setSavingPromptId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không lưu được prompt mặc định");
      return;
    }
    setSavedPromptId(app.id);
    setTimeout(() => setSavedPromptId(null), 2000);
    loadMiniApps();
  }

  // Hướng dẫn (system prompt) cho nút "AI viết giúp mô tả" ở trang app — rỗng thì route tự dùng
  // bản mặc định rút gọn từ skill video-motion-prompt, không cần admin soạn ngay từ đầu.
  async function handleSaveHelperInstructions(app: MiniAppPrice) {
    const value = helperInstructionsDrafts[app.id] ?? app.promptHelperInstructions;
    setSavingHelperId(app.id);
    setAppPriceError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, promptHelperInstructions: value }),
    });
    setSavingHelperId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không lưu được hướng dẫn AI viết giúp mô tả");
      return;
    }
    setSavedHelperId(app.id);
    setTimeout(() => setSavedHelperId(null), 2000);
    loadMiniApps();
  }

  // Prompt tạo ảnh Character (sheet nhiều góc) cho "Video từ ý tưởng truyện" — rỗng thì
  // lib/story-video.ts tự dùng bản mặc định 6 góc.
  async function handleSaveCharacterPrompt(app: MiniAppPrice) {
    const value = characterPromptDrafts[app.id] ?? app.characterPrompt;
    setSavingCharacterPromptId(app.id);
    setAppPriceError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, characterPrompt: value }),
    });
    setSavingCharacterPromptId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không lưu được prompt tạo Character");
      return;
    }
    setSavedCharacterPromptId(app.id);
    setTimeout(() => setSavedCharacterPromptId(null), 2000);
    loadMiniApps();
  }

  function getStoryImageModelsDraft(app: MiniAppPrice): StoryModelEntry[] {
    return storyImageModelsDrafts[app.id] ?? app.storyImageModels ?? [];
  }
  function getStoryVideoModelsDraft(app: MiniAppPrice): StoryModelEntry[] {
    return storyVideoModelsDrafts[app.id] ?? app.storyVideoModels ?? [];
  }

  function addStoryModelRow(app: MiniAppPrice, kind: "image" | "video") {
    const blank: StoryModelEntry = { key: "", provider: "", label: "", model: "", provider_cost_vnd: 1000, multi_image: false, enabled: true };
    if (kind === "image") {
      setStoryImageModelsDrafts((prev) => ({ ...prev, [app.id]: [...getStoryImageModelsDraft(app), blank] }));
    } else {
      setStoryVideoModelsDrafts((prev) => ({ ...prev, [app.id]: [...getStoryVideoModelsDraft(app), blank] }));
    }
  }

  function updateStoryModelRow(app: MiniAppPrice, kind: "image" | "video", index: number, patch: Partial<StoryModelEntry>) {
    if (kind === "image") {
      const next = getStoryImageModelsDraft(app).map((m, i) => (i === index ? { ...m, ...patch } : m));
      setStoryImageModelsDrafts((prev) => ({ ...prev, [app.id]: next }));
    } else {
      const next = getStoryVideoModelsDraft(app).map((m, i) => (i === index ? { ...m, ...patch } : m));
      setStoryVideoModelsDrafts((prev) => ({ ...prev, [app.id]: next }));
    }
  }

  function removeStoryModelRow(app: MiniAppPrice, kind: "image" | "video", index: number) {
    if (kind === "image") {
      setStoryImageModelsDrafts((prev) => ({ ...prev, [app.id]: getStoryImageModelsDraft(app).filter((_, i) => i !== index) }));
    } else {
      setStoryVideoModelsDrafts((prev) => ({ ...prev, [app.id]: getStoryVideoModelsDraft(app).filter((_, i) => i !== index) }));
    }
  }

  async function handleSaveStoryModels(app: MiniAppPrice) {
    setSavingStoryModelsId(app.id);
    setAppPriceError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: app.id,
        storyImageModels: getStoryImageModelsDraft(app).map((m) => ({ ...m, multi_image: !!m.multi_image })),
        storyVideoModels: getStoryVideoModelsDraft(app),
      }),
    });
    setSavingStoryModelsId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không lưu được catalog model");
      return;
    }
    setSavedStoryModelsId(app.id);
    setTimeout(() => setSavedStoryModelsId(null), 2000);
    loadMiniApps();
  }

  async function handleRemoveDemoImage(app: MiniAppPrice, index: number) {
    const nextUrls = app.demoImageUrls.filter((_, i) => i !== index);
    setUploadingDemoImage(`${app.id}-${index}`);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, demoImageUrls: nextUrls }),
    });
    setUploadingDemoImage(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không xoá được ảnh");
      return;
    }
    loadMiniApps();
  }

  // Riêng "Thay trang phục": app có 3 model AI (đa năng/FASHN/FASHN Max) chạy song song, admin bật/tắt
  // từng cái — bật nhiều hơn 1 thì người dùng tự chọn, chỉ bật 1 thì người dùng không thấy nút chọn gì cả.
  async function handleToggleOutfitSwapModel(app: MiniAppPrice, key: "generic" | "fashn" | "fashn_max", enabled: boolean) {
    setSavingAppId(app.id);
    setAppPriceError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, outfitSwapModels: { [key]: enabled } }),
    });
    setSavingAppId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không cập nhật được model");
      return;
    }
    loadMiniApps();
  }

  // Tổng quát cho mọi app có model_config.models ngoài "Thay trang phục" (vd tier chất lượng video
  // "basic"/"premium") — cùng cơ chế PATCH, chỉ khác tên field gửi lên (modelTiers thay vì
  // outfitSwapModels) cho rõ nghĩa, xem app/api/admin/mini-apps/route.ts.
  async function handleToggleModelTier(app: MiniAppPrice, key: string, enabled: boolean) {
    setSavingAppId(app.id);
    setAppPriceError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, modelTiers: { [key]: enabled } }),
    });
    setSavingAppId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAppPriceError(data.error ?? "Không cập nhật được tier");
      return;
    }
    loadMiniApps();
  }

  async function handleCreateApp(e: React.FormEvent) {
    e.preventDefault();
    setCreatingApp(true);
    setNewAppError(null);
    const res = await fetch("/api/admin/mini-apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...newApp, type: newAppType }),
    });
    setCreatingApp(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setNewAppError(data.error ?? "Không tạo được Mini App");
      return;
    }
    setNewApp({ name: "", description: "", category: "van-ban", creditCost: 10, model: MODEL_OPTIONS[0].value, systemPrompt: "" });
    setNewAppType("text");
    setShowNewAppForm(false);
    loadMiniApps();
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSavingSettings(true);
    setSettingsSaved(false);
    setSettingsError(null);
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSavingSettings(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setSettingsError(data.error ?? "Không lưu được cấu hình");
      return;
    }
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setLoginError("Sai mật khẩu");
      return;
    }
    setPassword("");
    loadStats();
    loadSettings();
    loadMiniApps();
    loadDeveloperReview();
    loadHomepageChips();
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setStats(null);
    setAuthState("loggedOut");
  }

  if (authState === "checking") return null;

  if (authState === "loggedOut") {
    return (
      <div className="flex min-h-full items-center justify-center bg-zinc-50 px-6 dark:bg-black">
        <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="mb-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">Trang quản trị</h1>
          <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">Nhập mật khẩu để xem dashboard.</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mật khẩu quản trị"
                className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 pr-10 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
            </div>
            {loginError && <p className="text-sm text-red-600 dark:text-red-400">{loginError}</p>}
            <button
              type="submit"
              className="w-full rounded-full bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Đăng nhập
            </button>
          </form>
          <Link href="/" className="mt-4 block text-center text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500">
            ← Quay lại Danh mục
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Trang quản trị</span>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              ← Danh mục
            </Link>
            <button onClick={handleLogout} className="text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              Đăng xuất
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {!stats ? (
          <p className="text-zinc-500 dark:text-zinc-400">Đang tải...</p>
        ) : (
          <>
            <section className="mb-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Tổng người dùng" value={stats.userCount.toLocaleString("vi-VN")} />
              <StatCard label="Doanh thu (đã thanh toán)" value={formatVnd(stats.totalRevenueVnd)} />
              <StatCard label="Credit đã bán" value={stats.totalCreditsSold.toLocaleString("vi-VN")} />
              <StatCard label="Credit đã dùng" value={stats.totalCreditsUsed.toLocaleString("vi-VN")} />
            </section>

            <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Cấu hình
              </h2>
              {!settings ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải...</p>
              ) : (
                <form onSubmit={handleSaveSettings} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:flex-wrap">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Credit tặng khi đăng ký
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={settings.signupBonusCredits}
                      onChange={(e) => setSettings({ ...settings, signupBonusCredits: Number(e.target.value) })}
                      className="w-40 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                  <label className="flex items-center gap-2 pb-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input
                      type="checkbox"
                      checked={settings.promoBannerEnabled}
                      onChange={(e) => setSettings({ ...settings, promoBannerEnabled: e.target.checked })}
                      className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
                    />
                    Hiện banner khuyến mãi trên trang chủ
                  </label>

                  <div className="w-full border-t border-zinc-100 pt-4 dark:border-zinc-800" />

                  <label className="flex items-center gap-2 pb-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input
                      type="checkbox"
                      checked={settings.subscriptionEnabled}
                      onChange={(e) => setSettings({ ...settings, subscriptionEnabled: e.target.checked })}
                      className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
                    />
                    Mở bán gói không giới hạn (thuê bao)
                  </label>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Giá gói (đ/tháng)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={settings.subscriptionPriceVnd}
                      onChange={(e) => setSettings({ ...settings, subscriptionPriceVnd: Number(e.target.value) })}
                      className="w-40 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Thời hạn (ngày)
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={settings.subscriptionDurationDays}
                      onChange={(e) =>
                        setSettings({ ...settings, subscriptionDurationDays: Number(e.target.value) })
                      }
                      className="w-32 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                  <div className="w-full border-t border-zinc-100 pt-4 dark:border-zinc-800" />

                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Biên lợi nhuận ảnh/video (%)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={settings.mediaMarginPercent}
                      onChange={(e) => setSettings({ ...settings, mediaMarginPercent: Number(e.target.value) })}
                      className="w-32 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                    <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                      Giá bán = chi phí thật trả Fal.ai × (1 + %). Chỉnh sửa chi phí gốc của từng app trong Supabase (mini_apps.model_config.provider_cost_vnd).
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Quy đổi 1 credit (đ)
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={settings.vndPerCredit}
                      onChange={(e) => setSettings({ ...settings, vndPerCredit: Number(e.target.value) })}
                      className="w-32 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Tỷ giá USD → VND
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={settings.usdToVndRate}
                      onChange={(e) => setSettings({ ...settings, usdToVndRate: Number(e.target.value) })}
                      className="w-32 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                    <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                      Dùng để quy đổi chi phí AI (actual_cost_usd) dev báo cáo, khi tính hoa hồng.
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Trần lượt dùng thử miễn phí/ngày (/thu-mien-phi)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={settings.freeTrialDailyCap}
                      onChange={(e) => setSettings({ ...settings, freeTrialDailyCap: Number(e.target.value) })}
                      className="w-32 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                    <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                      Tổng số lượt xoá nền miễn phí toàn hệ thống mỗi ngày (không phân biệt người dùng) — chặn tự động khi
                      vượt, tránh phát sinh chi phí Fal.ai ngoài kiểm soát.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={savingSettings}
                    className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    {savingSettings ? "Đang lưu..." : "Lưu cấu hình"}
                  </button>
                  {settingsSaved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Đã lưu ✓</span>}
                  {settingsError && <span className="text-sm text-red-600 dark:text-red-400">{settingsError}</span>}
                </form>
              )}
            </section>

            <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Mini App
                </h2>
                <button
                  onClick={() => setShowNewAppForm((v) => !v)}
                  className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  {showNewAppForm ? "Đóng" : "+ Thêm Mini App mới"}
                </button>
              </div>
              <p className="mb-4 text-xs text-zinc-400 dark:text-zinc-500">
                App ảnh/video tính giá động theo margin% ở trên, không sửa trực tiếp được ở đây. Nút Xoá chỉ ẩn app khỏi trang chủ (không mất dữ liệu), bấm lại để khôi phục.
              </p>

              {showNewAppForm && (
                <form
                  onSubmit={handleCreateApp}
                  className="mb-4 space-y-3 rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700"
                >
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Loại Mini App</label>
                    <div className="flex gap-2">
                      {(["text", "image", "video"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setNewAppType(t)}
                          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                            newAppType === t
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                          }`}
                        >
                          {t === "text" ? "Văn bản" : t === "image" ? "Ảnh" : "Video"}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                      {newAppType === "text"
                        ? "Người dùng nhập text, AI trả lời text — gọi OpenRouter."
                        : newAppType === "image"
                          ? "Người dùng nhập mô tả + ảnh tham chiếu (tuỳ chọn), AI tạo ảnh mới — dùng chung model Flux Kontext với app \"Tạo ảnh quảng cáo sản phẩm\"."
                          : "Người dùng nhập mô tả + ảnh khung hình đầu/cuối (tuỳ chọn), AI tạo video ngắn — dùng chung model Kling với app \"Tạo video từ ảnh\", chạy bất đồng bộ (vài phút)."}
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Tên Mini App</label>
                    <input
                      type="text"
                      value={newApp.name}
                      onChange={(e) => setNewApp({ ...newApp, name: e.target.value })}
                      placeholder="Ví dụ: Viết email marketing"
                      className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Mô tả (hiện ở trang chủ)</label>
                    <input
                      type="text"
                      value={newApp.description}
                      onChange={(e) => setNewApp({ ...newApp, description: e.target.value })}
                      placeholder="Nhập chủ đề, AI viết email marketing thuyết phục"
                      className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {newAppType === "text" && (
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Danh mục</label>
                        <select
                          value={newApp.category}
                          onChange={(e) => setNewApp({ ...newApp, category: e.target.value })}
                          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        >
                          {NEW_APP_CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Giá (credit)</label>
                      <input
                        type="number"
                        min={1}
                        value={newApp.creditCost}
                        onChange={(e) => setNewApp({ ...newApp, creditCost: Number(e.target.value) })}
                        className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                    </div>
                    {newAppType === "text" && (
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Model AI</label>
                        <select
                          value={newApp.model}
                          onChange={(e) => setNewApp({ ...newApp, model: e.target.value })}
                          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        >
                          {MODEL_OPTIONS.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                  {newAppType === "text" && (
                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        Hướng dẫn cho AI (system prompt)
                      </label>
                      <textarea
                        value={newApp.systemPrompt}
                        onChange={(e) => setNewApp({ ...newApp, systemPrompt: e.target.value })}
                        rows={3}
                        placeholder="Bạn là chuyên gia viết email marketing tiếng Việt. Viết email ngắn gọn, thuyết phục, dựa trên chủ đề người dùng cung cấp."
                        className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={creatingApp}
                      className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    >
                      {creatingApp ? "Đang tạo..." : "Tạo Mini App"}
                    </button>
                    {newAppError && <span className="text-sm text-red-600 dark:text-red-400">{newAppError}</span>}
                  </div>
                </form>
              )}

              {!miniApps ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải...</p>
              ) : (
                <div className="space-y-3">
                  {miniApps.map((app) => (
                    <div
                      key={app.id}
                      className={`space-y-2 rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800 ${
                        !app.isActive ? "opacity-50" : ""
                      }`}
                    >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">
                          {app.name}
                          {!app.isActive && <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-500">(đã ẩn)</span>}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {DEMO_IMAGE_SLOT_LABELS.map((label, index) => {
                            const key = `${app.id}-${index}`;
                            const url = app.demoImageUrls[index];
                            return (
                              <div key={index} className="flex flex-col items-center gap-0.5">
                                <label
                                  title={`Ảnh "${label}" trên card trang chủ`}
                                  className="group relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed border-zinc-300 bg-zinc-50 text-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-600"
                                >
                                  {uploadingDemoImage === key ? (
                                    <span className="text-[10px]">...</span>
                                  ) : url ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={url} alt="" className="h-full w-full object-cover" />
                                  ) : (
                                    <span className="text-lg leading-none">+</span>
                                  )}
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      e.target.value = "";
                                      if (file) handleUploadDemoImage(app, index, file);
                                    }}
                                  />
                                  {url && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        handleRemoveDemoImage(app, index);
                                      }}
                                      className="absolute right-0 top-0 hidden h-3.5 w-3.5 items-center justify-center bg-red-600 text-[9px] leading-none text-white group-hover:flex"
                                    >
                                      ×
                                    </button>
                                  )}
                                </label>
                                <span className="text-[9px] leading-none text-zinc-400 dark:text-zinc-600">{label}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {app.dynamic ? (
                          <span className="text-sm text-zinc-400 dark:text-zinc-500">
                            {app.creditCost} credit — tính động
                          </span>
                        ) : (
                          <MiniAppPriceEditor
                            app={app}
                            saving={savingAppId === app.id}
                            saved={savedAppId === app.id}
                            onSave={(value) => handleSaveMiniAppPrice(app.id, value)}
                          />
                        )}
                        <button
                          onClick={() => handleToggleActive(app.id, !app.isActive)}
                          disabled={togglingAppId === app.id}
                          className={`rounded-full px-3 py-1 text-xs font-medium text-white disabled:opacity-50 ${
                            app.isActive ? "bg-red-600" : "bg-emerald-600"
                          }`}
                        >
                          {app.isActive ? "Xoá" : "Khôi phục"}
                        </button>
                      </div>
                    </div>
                    {app.outfitSwapModels && (
                      <div className="flex items-center gap-4 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        <span>Model AI:</span>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={app.outfitSwapModels.generic}
                            onChange={(e) => handleToggleOutfitSwapModel(app, "generic", e.target.checked)}
                          />
                          Đa năng
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={app.outfitSwapModels.fashn}
                            onChange={(e) => handleToggleOutfitSwapModel(app, "fashn", e.target.checked)}
                          />
                          FASHN
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={app.outfitSwapModels.fashn_max}
                            onChange={(e) => handleToggleOutfitSwapModel(app, "fashn_max", e.target.checked)}
                          />
                          FASHN Max
                        </label>
                      </div>
                    )}
                    {app.modelTiers && !app.outfitSwapModels && (
                      <div className="flex items-center gap-4 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        <span>Tier chất lượng:</span>
                        {Object.entries(app.modelTiers).map(([key, enabled]) => (
                          <label key={key} className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) => handleToggleModelTier(app, key, e.target.checked)}
                            />
                            {MODEL_TIER_LABELS[key] ?? key}
                          </label>
                        ))}
                      </div>
                    )}
                    {app.isVideoApp && (
                      <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
                        <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
                          Prompt mặc định (tự điền cho khách, khách vẫn sửa được)
                        </p>
                        <textarea
                          value={promptDrafts[app.id] ?? app.defaultPrompt}
                          onChange={(e) => setPromptDrafts((prev) => ({ ...prev, [app.id]: e.target.value }))}
                          rows={2}
                          className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        />
                        <div className="mb-1 flex items-center justify-between">
                          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                            <input
                              type="checkbox"
                              checked={promptVisibleDrafts[app.id] ?? app.defaultPromptVisible}
                              onChange={(e) => setPromptVisibleDrafts((prev) => ({ ...prev, [app.id]: e.target.checked }))}
                            />
                            Hiện prompt này cho khách (tắt vẫn giữ bản đã soạn)
                          </label>
                          <button
                            onClick={() => handleSaveDefaultPrompt(app)}
                            disabled={savingPromptId === app.id}
                            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                          >
                            {savingPromptId === app.id ? "Đang lưu..." : savedPromptId === app.id ? "Đã lưu ✓" : "Lưu prompt"}
                          </button>
                        </div>
                      </div>
                    )}
                    {app.isVideoApp && (
                      <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
                        <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
                          Hướng dẫn cho nút &quot;AI viết giúp mô tả&quot; (rỗng = dùng bản mặc định)
                        </p>
                        <textarea
                          value={helperInstructionsDrafts[app.id] ?? app.promptHelperInstructions}
                          onChange={(e) => setHelperInstructionsDrafts((prev) => ({ ...prev, [app.id]: e.target.value }))}
                          rows={3}
                          placeholder="Để trống sẽ dùng hướng dẫn mặc định (giữ nguyên danh tính/trang phục/bối cảnh, camera đứng yên, 1 chuyển động nhỏ tự nhiên)..."
                          className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        />
                        <div className="flex justify-end">
                          <button
                            onClick={() => handleSaveHelperInstructions(app)}
                            disabled={savingHelperId === app.id}
                            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                          >
                            {savingHelperId === app.id ? "Đang lưu..." : savedHelperId === app.id ? "Đã lưu ✓" : "Lưu hướng dẫn"}
                          </button>
                        </div>
                      </div>
                    )}
                    {(app.storyImageModels || app.storyVideoModels) && (
                      <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
                        <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
                          Prompt tạo ảnh Character (sheet nhiều góc) — rỗng = dùng bản mặc định 6 góc
                        </p>
                        <textarea
                          value={characterPromptDrafts[app.id] ?? app.characterPrompt}
                          onChange={(e) => setCharacterPromptDrafts((prev) => ({ ...prev, [app.id]: e.target.value }))}
                          rows={4}
                          placeholder="Để trống sẽ dùng prompt mặc định: sheet 6 góc (chính diện/3-4 trái/3-4 phải/nghiêng/sau lưng/cận mặt), giữ nguyên mặt-tóc-trang phục..."
                          className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        />
                        <div className="mb-3 flex justify-end">
                          <button
                            onClick={() => handleSaveCharacterPrompt(app)}
                            disabled={savingCharacterPromptId === app.id}
                            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                          >
                            {savingCharacterPromptId === app.id ? "Đang lưu..." : savedCharacterPromptId === app.id ? "Đã lưu ✓" : "Lưu prompt Character"}
                          </button>
                        </div>
                        <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">Catalog model ảnh/video (nhóm theo provider)</p>
                        {(
                          [
                            { kind: "image" as const, title: "Model ảnh phân cảnh", rows: getStoryImageModelsDraft(app) },
                            { kind: "video" as const, title: "Model video phân cảnh", rows: getStoryVideoModelsDraft(app) },
                          ]
                        ).map(({ kind, title, rows }) => (
                          <div key={kind} className="mb-3">
                            <p className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
                            <div className="space-y-1.5">
                              {rows.map((m, index) => (
                                <div key={index} className="grid grid-cols-12 items-center gap-1.5">
                                  <input
                                    value={m.provider}
                                    onChange={(e) => updateStoryModelRow(app, kind, index, { provider: e.target.value })}
                                    placeholder="Provider"
                                    className="col-span-2 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                  />
                                  <input
                                    value={m.label}
                                    onChange={(e) => updateStoryModelRow(app, kind, index, { label: e.target.value })}
                                    placeholder="Tên hiển thị"
                                    className="col-span-2 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                  />
                                  <input
                                    value={m.key}
                                    onChange={(e) => updateStoryModelRow(app, kind, index, { key: e.target.value })}
                                    placeholder="key"
                                    className="col-span-1 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                  />
                                  <input
                                    value={m.model}
                                    onChange={(e) => updateStoryModelRow(app, kind, index, { model: e.target.value })}
                                    placeholder="fal-ai/..."
                                    className="col-span-3 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                  />
                                  <input
                                    type="number"
                                    value={m.provider_cost_vnd}
                                    onChange={(e) => updateStoryModelRow(app, kind, index, { provider_cost_vnd: Number(e.target.value) })}
                                    placeholder="Giá VND"
                                    className="col-span-2 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                  />
                                  {kind === "image" && (
                                    <label className="col-span-1 flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                                      <input
                                        type="checkbox"
                                        checked={!!m.multi_image}
                                        onChange={(e) => updateStoryModelRow(app, kind, index, { multi_image: e.target.checked })}
                                      />
                                      multi
                                    </label>
                                  )}
                                  <label className={`flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400 ${kind === "image" ? "col-span-1" : "col-span-2"}`}>
                                    <input
                                      type="checkbox"
                                      checked={m.enabled}
                                      onChange={(e) => updateStoryModelRow(app, kind, index, { enabled: e.target.checked })}
                                    />
                                    bật
                                  </label>
                                  <button
                                    onClick={() => removeStoryModelRow(app, kind, index)}
                                    className="text-xs text-zinc-400 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
                                  >
                                    Xoá
                                  </button>
                                </div>
                              ))}
                            </div>
                            <button
                              onClick={() => addStoryModelRow(app, kind)}
                              className="mt-1.5 rounded-full border border-dashed border-zinc-300 px-3 py-0.5 text-xs text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                            >
                              + Thêm model
                            </button>
                          </div>
                        ))}
                        <div className="flex justify-end">
                          <button
                            onClick={() => handleSaveStoryModels(app)}
                            disabled={savingStoryModelsId === app.id}
                            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                          >
                            {savingStoryModelsId === app.id ? "Đang lưu..." : savedStoryModelsId === app.id ? "Đã lưu ✓" : "Lưu catalog"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  ))}
                  {appPriceError && <p className="text-sm text-red-600 dark:text-red-400">{appPriceError}</p>}
                </div>
              )}
            </section>

            <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Hàng chip lọc trang chủ
              </h2>
              <p className="mb-4 text-xs text-zinc-400 dark:text-zinc-500">
                Hàng "Tất cả / Mô tả / Tóm tắt / Markets..." ngay dưới ô tìm kiếm. Dùng nút ↑↓ để đổi thứ tự, nút Xoá để bỏ hẳn.
              </p>
              {!homepageChips ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải...</p>
              ) : homepageChips.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500">Không còn chip nào.</p>
              ) : (
                <div className="space-y-2">
                  {homepageChips.map((chip, index) => (
                    <div
                      key={chip.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800"
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {CHIP_TYPE_LABEL[chip.type]}
                        </span>
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">{chip.label}</span>
                        <span className="text-xs text-zinc-400 dark:text-zinc-500">({chip.value})</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleMoveChip(index, -1)}
                          disabled={savingChips || index === 0}
                          aria-label="Đưa lên trước"
                          className="rounded-full border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 disabled:opacity-30 dark:border-zinc-600 dark:text-zinc-300"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => handleMoveChip(index, 1)}
                          disabled={savingChips || index === homepageChips.length - 1}
                          aria-label="Đưa xuống sau"
                          className="rounded-full border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 disabled:opacity-30 dark:border-zinc-600 dark:text-zinc-300"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => handleDeleteChip(index)}
                          disabled={savingChips}
                          className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                        >
                          Xoá
                        </button>
                      </div>
                    </div>
                  ))}
                  {chipsError && <p className="text-sm text-red-600 dark:text-red-400">{chipsError}</p>}
                </div>
              )}
            </section>

            <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Nhạc nền cho video
              </h2>
              <p className="mb-4 text-xs text-zinc-400 dark:text-zinc-500">
                Upload sẵn nhạc admin đã có bản quyền hợp lệ — user chọn 1 bài trong danh sách này để ghép vào video AI tạo ra
                (Kling chỉ tạo video câm, không tự sinh nhạc).
              </p>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={musicUploadName}
                  onChange={(e) => setMusicUploadName(e.target.value)}
                  placeholder="Tên bài nhạc..."
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                />
                <label className="cursor-pointer rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                  {uploadingMusic ? "Đang upload..." : "Chọn file nhạc (mp3/wav/m4a, tối đa 10MB)"}
                  <input
                    type="file"
                    accept="audio/*"
                    disabled={uploadingMusic}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleUploadMusic(file);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {musicError && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{musicError}</p>}
              {!musicTracks ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải...</p>
              ) : musicTracks.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500">Chưa có bài nhạc nào.</p>
              ) : (
                <div className="space-y-2">
                  {musicTracks.map((track) => (
                    <div
                      key={track.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">{track.name}</span>
                        <audio controls src={track.file_url} className="h-8" />
                      </div>
                      <button
                        onClick={() => handleDeleteMusic(track.id)}
                        disabled={deletingMusicId === track.id}
                        className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Xoá
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Duyệt nhà phát triển & Mini App (Giai đoạn 4)
              </h2>

              <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Nhà phát triển đang chờ duyệt ({pendingDevs.length})
              </p>
              {pendingDevs.length === 0 ? (
                <p className="mb-4 text-sm text-zinc-400 dark:text-zinc-500">Không có ai đang chờ.</p>
              ) : (
                <div className="mb-4 space-y-2">
                  {pendingDevs.map((dev) => (
                    <div
                      key={dev.id}
                      className="flex items-center justify-between rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800"
                    >
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">{dev.display_name}</span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleReview("developer", dev.id, "approve")}
                          disabled={reviewingId === dev.id}
                          className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                        >
                          Duyệt
                        </button>
                        <button
                          onClick={() => handleReview("developer", dev.id, "reject")}
                          disabled={reviewingId === dev.id}
                          className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                        >
                          Từ chối
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Mini App đang chờ duyệt ({pendingApps.length})
              </p>
              {pendingApps.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500">Không có app nào đang chờ.</p>
              ) : (
                <div className="space-y-2">
                  {pendingApps.map((app) => (
                    <div
                      key={app.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800"
                    >
                      <div>
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">{app.name}</span>
                        <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-500">
                          {app.category} · {app.credit_cost} credit
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleReview("mini_app", app.id, "approve")}
                          disabled={reviewingId === app.id}
                          className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                        >
                          Duyệt
                        </button>
                        <button
                          onClick={() => handleReview("mini_app", app.id, "reject")}
                          disabled={reviewingId === app.id}
                          className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                        >
                          Từ chối
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="mb-10">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Giao dịch gần đây
              </h2>
              <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 text-left text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Loại</th>
                      <th className="px-4 py-3 font-medium">User</th>
                      <th className="px-4 py-3 font-medium">Mini App</th>
                      <th className="px-4 py-3 font-medium">Thời gian</th>
                      <th className="px-4 py-3 text-right font-medium">Credit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {stats.recentTransactions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                          Chưa có giao dịch nào.
                        </td>
                      </tr>
                    ) : (
                      stats.recentTransactions.map((tx) => (
                        <tr key={tx.id} className="bg-white dark:bg-zinc-950">
                          <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{TYPE_LABEL[tx.type] ?? tx.type}</td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{shortId(tx.user_id)}</td>
                          <td className="px-4 py-3 text-zinc-900 dark:text-zinc-50">{tx.mini_app_id ?? "—"}</td>
                          <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{formatDate(tx.created_at)}</td>
                          <td
                            className={`px-4 py-3 text-right font-medium ${
                              tx.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-900 dark:text-zinc-50"
                            }`}
                          >
                            {tx.amount > 0 ? "+" : ""}
                            {tx.amount}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Người dùng gần đây
              </h2>
              <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 text-left text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">User ID</th>
                      <th className="px-4 py-3 font-medium">Ngày tham gia</th>
                      <th className="px-4 py-3 text-right font-medium">Số dư credit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {stats.recentUsers.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                          Chưa có người dùng nào.
                        </td>
                      </tr>
                    ) : (
                      stats.recentUsers.map((u) => (
                        <tr key={u.user_id} className="bg-white dark:bg-zinc-950">
                          <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{shortId(u.user_id)}</td>
                          <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{formatDate(u.created_at)}</td>
                          <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-50">
                            {u.credit_balance.toLocaleString("vi-VN")}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{value}</p>
    </div>
  );
}

function MiniAppPriceEditor({
  app,
  saving,
  saved,
  onSave,
}: {
  app: MiniAppPrice;
  saving: boolean;
  saved: boolean;
  onSave: (value: number) => void;
}) {
  const [value, setValue] = useState(app.creditCost);

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-24 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
      />
      <span className="text-xs text-zinc-400 dark:text-zinc-500">credit</span>
      <button
        onClick={() => onSave(value)}
        disabled={saving || value === app.creditCost}
        className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {saving ? "Đang lưu..." : "Lưu"}
      </button>
      {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">✓</span>}
    </div>
  );
}
