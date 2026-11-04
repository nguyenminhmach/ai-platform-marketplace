"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { uploadImageDirect } from "@/lib/upload-direct";
import { LocationPositionStage3D, type PositionedCharacter } from "@/components/LocationPositionStage3D";
import { LightSphereModal, type LightSettings } from "@/components/story-video/LightSphereModal";

// Trang "3D Builder" — công cụ dàn cảnh 3D ĐỘC LẬP (không phụ thuộc luồng "Video từ ý tưởng"), tham
// khảo bố cục TopView Film Studio khách gửi: trái = công cụ (Characters...), giữa = khung 3D, phải =
// thông số (Camera preview/3D Scene/Background/Global lighting/Display), dưới = thanh prompt/timeline
// (placeholder, chưa làm — xem kế hoạch đã lưu). Tái dùng tối đa phần 3D đã có: LocationPositionStage3D
// (dựng khối 3D + đặt/kéo nhân vật), LightSphereModal (chỉnh ánh sáng), pipeline "Dựng khối 3D" (depth +
// ground mask qua /api/story-video/location-blockout) — không viết lại logic 3D/Fal.ai nào từ đầu.

type LeftTab = "objects" | "characters" | "props" | "cameras" | "camera-moves" | "motions";

const LEFT_TABS: { key: LeftTab; label: string; icon: string }[] = [
  { key: "objects", label: "Objects", icon: "◇" },
  { key: "characters", label: "Characters", icon: "☺" },
  { key: "props", label: "Props", icon: "⚑" },
  { key: "cameras", label: "Cameras", icon: "⌘" },
  { key: "camera-moves", label: "Camera moves", icon: "▶" },
  { key: "motions", label: "Motions", icon: "✦" },
];

// SỬA (phản hồi thật user: "khi bấm vào character anh muốn hiện ra các hình thế này" — ảnh mẫu TopView
// 4 dáng người khác hẳn nhau) — 4 model .glb RIÊNG, tải từ Mixamo (Adobe, miễn phí, cần đăng nhập) rồi
// xuất qua Blender (giảm texture còn tối đa 1024px + nén Draco, xem scratchpad/fbx_to_glb_compressed.py
// — mỗi file từ ~55MB xuống còn 2.7-6.9MB). Đặt trong public/models/{female,man-adult,youth,child}.glb
// (man.glb GỐC giữ nguyên, không đụng — chỗ khác (LightSphereModal, Story Video) vẫn dùng đúng file đó).
// SỬA (phản hồi thật user: "anh tải về 2 xbot nam và nữ trưởng thành, em tải lên 2 xbot trưởng thành này
// làm nhân vật — xbot nữ để nguyên, giảm kích thước xbot nam xuống làm thanh niên, giảm thêm nữa làm trẻ
// em — 4 hình kia em bỏ đi" — thay hẳn 4 model Mixamo cũ (female/man-adult/youth/child.glb, bỏ hẳn, xem
// dọn dẹp cuối phiên) bằng đúng 2 model Mixamo chuẩn "X Bot" (nam)/"Y Bot" (nữ), convert .fbx -> .glb nén
// Draco qua Blender headless (cùng script scratchpad/fbx_to_glb_compressed.py). "Nữ" dùng Y Bot nguyên
// scale=1; "Nam" dùng X Bot nguyên scale=1; "Thanh niên"/"Trẻ em" dùng LẠI ĐÚNG model X Bot nhưng đặt
// scale KHỞI ĐẦU nhỏ dần (0.85/0.6, xác nhận qua chat) — tái dùng field `scaleX/Y/Z` có sẵn ở
// PositionedCharacter (vốn làm cho panel Transform > Scale) làm ĐIỂM XUẤT PHÁT khi thêm nhân vật mới,
// khách vẫn chỉnh lại được bình thường qua panel sau khi đã thêm vào cảnh.
// SỬA (phản hồi thật user: trang bị vòng lặp "Maximum update depth exceeded" ngay khi khung 3D hiện ra)
// — LocationPositionStage3D.tsx có prop `testPoints` mặc định `= []`, tạo MẢNG MỚI mỗi lần gọi; nơi gọi
// nào không truyền testPoints sẽ khiến effect phụ thuộc vào nó (deps [testPoints, ...]) chạy lại MỖI lần
// re-render (vì "[] !== []" theo tham chiếu), rồi effect đó tự forceRerender -> lặp vô hạn.
// VideoTuYTuongClient.tsx tránh được lỗi này vì luôn truyền testPoints={testPoints} (mảng state ổn định
// tham chiếu) — "3D Builder" trước đây KHÔNG truyền gì cả nên dính lỗi. Định nghĩa 1 mảng rỗng CỐ ĐỊNH ở
// module-level (không phải default param) để tham chiếu không đổi giữa các lần render.
const NO_TEST_POINTS: { x: number; y: number }[] = [];

type CharacterPreset = { key: string; label: string; color: string; modelUrl: string; thumbUrl?: string; scale?: number };

// SỬA (phản hồi thật user: "ô nhân vật bên trái sao không có hình đại diện" — lúc đầu chưa có ảnh dựng
// sẵn cho X Bot/Y Bot, 4 thẻ rơi về icon-người-chung + màu riêng) — đã render ảnh thật qua Blender
// headless (bust-shot, nền trong suốt, canh khung GIỐNG HỆT style 4 ảnh Mixamo cũ — xem
// scratchpad/render_character_thumb.py), ortho_scale camera chia theo `scale` của từng preset nên 3 thẻ
// dùng chung 1 model (Nam/Thanh niên/Trẻ em) hiện NHỎ DẦN đúng tỉ lệ ngay trong ảnh preview, không còn 3
// thẻ trông giống hệt nhau dù khác scale.
// SỬA LẦN 2 (phản hồi thật user: "em nhầm nhân vật nam thành nữ rồi" — xem ảnh thumbnail xác nhận) —
// file "xbot-female.glb" (convert từ Y Bot.fbx) thật ra đúng dáng NAM, còn "xbot-male.glb" (convert từ X
// Bot.fbx) mới đúng dáng NỮ — tên file bị đặt NGƯỢC ngay từ lúc convert (đoán nhầm theo tên file Mixamo
// "X Bot"/"Y Bot", không kiểm tra lại dáng người thật). Đổi lại: "Nữ" trỏ sang file xbot-male.glb, "Nam"
// trỏ sang xbot-female.glb — GIỮ NGUYÊN tên file vật lý (đổi tên file dễ nhầm lẫn thêm lần nữa, chỉ cần
// preset trỏ đúng là đủ). "Thanh niên"/"Trẻ em" đổi theo để khớp ĐÚNG dáng "Nam" (đã render lại 2 ảnh
// thumbnail từ xbot-female.glb cho khớp).
const CHARACTER_PRESETS: CharacterPreset[] = [
  { key: "xbot-female", label: "Nam", color: "#60a5fa", modelUrl: "/models/xbot-female.glb", thumbUrl: "/models-thumbs/xbot-female.png" },
  { key: "xbot-male", label: "Nữ", color: "#f472b6", modelUrl: "/models/xbot-male.glb", thumbUrl: "/models-thumbs/xbot-male.png" },
  {
    key: "xbot-youth",
    label: "Thanh niên",
    color: "#34d399",
    modelUrl: "/models/xbot-female.glb",
    scale: 0.85,
    thumbUrl: "/models-thumbs/xbot-youth.png",
  },
  {
    key: "xbot-child",
    label: "Trẻ em",
    color: "#fbbf24",
    modelUrl: "/models/xbot-female.glb",
    scale: 0.6,
    thumbUrl: "/models-thumbs/xbot-child.png",
  },
];

// Màu lần lượt gán cho các model admin thêm thêm qua app/admin/character-models/page.tsx (không có màu
// riêng như preset Mixamo) — xoay vòng cho dễ phân biệt từng người khi đặt nhiều cùng lúc trong cảnh.
const CUSTOM_MODEL_COLORS = ["#a78bfa", "#fb923c", "#22d3ee", "#f87171", "#4ade80"];

// SỬA (phản hồi thật user, gửi ảnh mẫu panel "Camera preview/Properties/Transform" kiểu TopView) — toạ độ
// world/radian/scale THẬT của nhân vật đang chọn, báo ngược từ LocationPositionStage3D qua
// onCharacterTransform (xem prop đó) mỗi khi kéo gizmo hoặc dựng lại mannequin — panel Transform đọc
// thẳng từ đây để luôn hiện đúng số live, không cần tự quy đổi lại từ x/y chuẩn hoá 0..1.
type CharacterTransform = {
  worldX: number;
  worldY: number;
  worldZ: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
};

// Ô nhập số dùng chung cho cả 9 trường Position/Rotation/Scale trong panel Transform — SỬA (tránh giật/
// nhảy số khi đang gõ): dùng key={value...} để input chỉ "reset" hiển thị khi giá trị THẬT sự đổi từ bên
// ngoài (sau khi kéo gizmo hoặc sau khi field khác commit), còn trong lúc đang gõ dở (value chưa đổi vì
// chỉ commit lúc blur/Enter) input giữ nguyên text đang gõ, không bị ép quay lại số cũ giữa chừng.
// SỬA (phản hồi thật user: "chưa hiện tên trục" — thêm `axis` (X/Y/Z), hiện như 1 nhãn xám NHỎ đè bên
// trong góc trái ô nhập, chữ số lùi sang phải nhường chỗ — khớp đúng kiểu hiển thị "X 0 / Y 0 / Z 0"
// trong ảnh mẫu, để không phải đoán cột nào là trục nào.
function TransformNumberField({
  value,
  onCommit,
  axis,
  step = 1,
}: {
  value: number;
  onCommit: (v: number) => void;
  axis: "X" | "Y" | "Z";
  step?: number;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-zinc-500">{axis}</span>
      <input
        key={value.toFixed(3)}
        type="number"
        step={step}
        defaultValue={Number(value.toFixed(3))}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded border border-zinc-700 bg-zinc-900 py-1 pl-4 pr-1.5 text-xs text-zinc-200 focus:border-fuchsia-500 focus:outline-none"
      />
    </div>
  );
}

export default function ThreeDBuilderClient() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<LeftTab>("characters");

  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [depthImageUrl, setDepthImageUrl] = useState<string | null>(null);
  const [groundMaskUrl, setGroundMaskUrl] = useState<string | null>(null);
  const [horizonY, setHorizonY] = useState(0.5);
  const [buildingBlockout, setBuildingBlockout] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);

  const [characters, setCharacters] = useState<PositionedCharacter[]>([]);
  const nextCharIdRef = useRef(1);

  // SỬA (phản hồi thật user, gửi ảnh mẫu panel "Properties/Transform" kiểu TopView: "bên phải màn hình
  // chưa có thông số của nhân vật") — trạng thái nhân vật ĐANG CHỌN, báo ngược từ LocationPositionStage3D
  // qua onCharacterSelect (component đó tự quản lý việc chọn/bỏ chọn nội bộ, trước giờ không lộ ra ngoài).
  // selectedCharacterUrlRef đi kèm state để tránh race-condition closure-cũ khi đọc trong
  // handleCharacterTransform (xem ghi chú ở đó) — pattern giống hệt các ref khác trong
  // LocationPositionStage3D.tsx (vd attachedCharacterUrlRef).
  const [selectedCharacterUrl, setSelectedCharacterUrl] = useState<string | null>(null);
  const selectedCharacterUrlRef = useRef<string | null>(null);
  const [selectedTransform, setSelectedTransform] = useState<CharacterTransform | null>(null);
  const [charPanelTab, setCharPanelTab] = useState<"properties" | "pose">("properties");
  const [scaleLocked, setScaleLocked] = useState(true);
  const [renamingChar, setRenamingChar] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const selectedChar = characters.find((c) => c.url === selectedCharacterUrl) ?? null;

  // Model nhân vật ADMIN thêm qua app/admin/character-models/page.tsx — đọc công khai, không cần đăng
  // nhập, nối thêm vào sau 4 preset Mixamo mặc định (xem CHARACTER_PRESETS). Không có thumbUrl (không
  // dựng ảnh preview tự động được lúc runtime, chỉ Blender offline mới làm được).
  const [customPresets, setCustomPresets] = useState<CharacterPreset[]>([]);
  useEffect(() => {
    fetch("/api/character-models")
      .then((res) => res.json())
      .then((data: { models?: { id: number; name: string; model_url: string }[] }) => {
        const models = data.models ?? [];
        setCustomPresets(
          models.map((m, i) => ({
            key: `custom-${m.id}`,
            label: m.name,
            color: CUSTOM_MODEL_COLORS[i % CUSTOM_MODEL_COLORS.length],
            modelUrl: m.model_url,
          }))
        );
      })
      .catch(() => {});
  }, []);
  const allCharacterPresets = [...CHARACTER_PRESETS, ...customPresets];

  const [lightSettings, setLightSettings] = useState<LightSettings[] | null>(null);
  const [lightModalOpen, setLightModalOpen] = useState(false);

  const [characterLabels, setCharacterLabels] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [exporting, setExporting] = useState(false);

  // SỬA (phản hồi thật user: "mình cần có cái này để thu cho các hình character thu lại cho gọn" —
  // ảnh mẫu nút "<" thu gọn panel) — panel trái (danh sách nhân vật/preset) có thể thu lại chỉ còn dải
  // icon, nhường chỗ cho khung 3D, giống TopView Film Studio.
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  // SỬA (phản hồi thật user: gửi video quay màn hình điện thoại cho thấy khung 3D BIẾN MẤT hoàn toàn trên
  // màn hình hẹp — test lại bằng đúng kích thước 480×1072 xác nhận: panel trái (w-20 dải icon + w-72 nội
  // dung ≈368px) CỘNG panel phải (w-80=320px) CỘNG LẠI lớn hơn cả chiều rộng màn hình 480px, khung 3D ở
  // giữa (flex-1 min-w-0) bị ép co về gần như 0 — không phải lỗi thuật toán bắt chuột của vòng tròn xoay
  // (đã kiểm chứng đúng nhiều lần trên desktop), mà là lỗi BỐ CỤC TRANG chưa responsive cho màn hình hẹp/
  // điện thoại. Thêm "ngăn kéo" (drawer) toàn màn hình cho di động: dưới md (768px), 2 panel 2 bên ẨN hẳn
  // (khung 3D chiếm trọn chiều rộng), thay bằng thanh tab ngang dưới cùng — bấm vào mở panel tương ứng
  // dạng lớp phủ toàn màn hình, có nút đóng. Từ md trở lên giữ NGUYÊN bố cục 3 cột cũ, không đổi gì.
  const [mobileDrawer, setMobileDrawer] = useState<"none" | "left" | "right">("none");

  async function handleBackgroundFile(file: File) {
    if (!user) {
      setBgError("Vui lòng đăng nhập trước");
      return;
    }
    setBgError(null);
    setBuildingBlockout(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const publicUrl = await uploadImageDirect(dataUrl, "/api/outfit-swap/upload", "outfit-swap-uploads");
      setBackgroundUrl(publicUrl);

      // Thử lấy cache trước (GET, không tốn tiền AI) — chỉ gọi POST (có thể tốn tiền) nếu ảnh này
      // chưa từng "Dựng khối 3D" trước đó, y hệt cách VideoTuYTuongClient.tsx đang làm.
      const cacheRes = await fetch(`/api/story-video/location-blockout?imageUrl=${encodeURIComponent(publicUrl)}`);
      const cached = await cacheRes.json();
      if (cached?.depthImageUrl || cached?.groundMaskUrl) {
        setDepthImageUrl(cached.depthImageUrl ?? null);
        setGroundMaskUrl(cached.groundMaskUrl ?? null);
        setHorizonY(typeof cached.horizonY === "number" ? cached.horizonY : 0.5);
      } else {
        const res = await fetch("/api/story-video/location-blockout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: publicUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Dựng khối 3D thất bại");
        setDepthImageUrl(data.depthImageUrl ?? null);
        setGroundMaskUrl(data.groundMaskUrl ?? null);
        setHorizonY(typeof data.horizonY === "number" ? data.horizonY : 0.5);
      }
    } catch (err) {
      setBgError(err instanceof Error ? err.message : "Có lỗi xảy ra");
    } finally {
      setBuildingBlockout(false);
    }
  }

  function addCharacter(preset: CharacterPreset) {
    const id = nextCharIdRef.current++;
    // SỬA (phản hồi thật user: "mặc định khi chọn nhân vật thì nhân vật đứng tại tâm của thảm 3D") —
    // x=0.5,y=0.75 quy đúng ra world X=0, độ sâu Z≈-2.5 (chính giữa thảm 5x5, xem y2DToDepth ở
    // LocationPositionStage3D.tsx với horizonY mặc định 0.5, DEPTH_SCALE=2.5: depth=((1-0.5)*2.5)/
    // (0.75-0.5)-2.5=2.5, world Z=-2.5 — đúng giữa khoảng -5..0). Nhiều nhân vật thêm liên tiếp sẽ chồng
    // đúng tâm, khách tự kéo gizmo ra nếu muốn tách — đúng hành vi khách yêu cầu, không tự dàn hàng nữa.
    setCharacters((prev) => [
      ...prev,
      {
        // url chỉ dùng làm KHOÁ định danh nội bộ, phải DUY NHẤT cho mỗi nhân vật đã đặt, kể cả trùng
        // preset, nên gắn thêm số đếm tăng dần.
        url: `3d-builder-${preset.key}-${id}`,
        name: `${preset.label}_${id}`,
        color: preset.color,
        modelUrl: preset.modelUrl,
        x: 0.5,
        y: 0.75,
        showLabel: characterLabels,
        // SỬA (phản hồi thật user: "thanh niên"/"trẻ em" giờ dùng CHUNG model X Bot với "Nam", chỉ khác
        // tỉ lệ ban đầu — xem CHARACTER_PRESETS.scale) — đặt sẵn scaleX/Y/Z = preset.scale lúc vừa thêm
        // vào cảnh (field Transform > Scale ở panel đọc/ghi đúng field này, khách chỉnh lại bình thường
        // sau đó); preset không khai báo scale (Nữ/Nam) thì giữ mặc định 1 (bỏ trống, không set gì).
        ...(preset.scale !== undefined ? { scaleX: preset.scale, scaleY: preset.scale, scaleZ: preset.scale } : {}),
      },
    ]);
  }

  function removeCharacter(url: string) {
    setCharacters((prev) => prev.filter((c) => c.url !== url));
  }

  function handleCharacterMove(url: string, pos: { x: number; y: number }) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, x: pos.x, y: pos.y } : c)));
  }

  function handleCharacterRotate(url: string, rotationY: number) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, rotationY } : c)));
  }

  // SỬA (phản hồi thật user, gửi ảnh mẫu "Edit Pose": thêm 2 trục xoay "nằm ngửa" (X) + "nằm nghiêng"
  // (Z)) — lưu lại tương tự handleCharacterRotate, không mất khi dựng lại mannequin.
  function handleCharacterRotateX(url: string, rotationX: number) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, rotationX } : c)));
  }
  function handleCharacterRotateZ(url: string, rotationZ: number) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, rotationZ } : c)));
  }

  // SỬA (phản hồi thật user: "không có chiều lên xuống à" — thêm trục Y nhấc nhân vật khỏi sàn) — lưu
  // lại elevationY để không mất khi dựng lại mannequin (xem PositionedCharacter.elevationY).
  function handleCharacterElevate(url: string, elevationY: number) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, elevationY } : c)));
  }

  // SỬA (phản hồi thật user, panel thông số nhân vật) — lưu lại tỉ lệ co giãn mới (gõ số ở panel, không
  // có gizmo kéo scale trong khung 3D), tương tự handleCharacterElevate.
  function handleCharacterScale(url: string, scale: { x: number; y: number; z: number }) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, scaleX: scale.x, scaleY: scale.y, scaleZ: scale.z } : c)));
  }
  function handleCharacterShowLabel(url: string, showLabel: boolean) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, showLabel } : c)));
  }
  // SỬA (phản hồi thật user, panel thông số nhân vật: "làm luôn Material") — lưu màu tint mới, giống hệt
  // pattern handleCharacterShowLabel — đổi `characters` state là đủ, effect "Dựng lại mannequin" bên
  // LocationPositionStage3D.tsx tự đọc ch.tintColor lại khi dựng lại, không cần callback riêng nào khác.
  function handleCharacterTint(url: string, tintColor: string) {
    setCharacters((prev) => prev.map((c) => (c.url === url ? { ...c, tintColor } : c)));
  }

  // SỬA (cùng lý do trên) — LocationPositionStage3D báo ngược mỗi khi khách chọn/bỏ chọn 1 nhân vật, để
  // hiện đúng panel thông số bên phải (xem characterPanelBody). Khi bỏ chọn (url=null), xoá luôn
  // selectedTransform để panel không giữ số cũ của nhân vật vừa bỏ chọn.
  function handleCharacterSelect(url: string | null) {
    selectedCharacterUrlRef.current = url;
    setSelectedCharacterUrl(url);
    if (!url) setSelectedTransform(null);
    setCharPanelTab("properties");
    setRenamingChar(false);
  }
  // SỬA (cùng panel) — báo toạ độ world/radian/scale THẬT mỗi khung kéo gizmo. Lọc theo
  // selectedCharacterUrlRef (KHÔNG đọc state selectedCharacterUrl trực tiếp) vì hàm này được
  // LocationPositionStage3D gọi từ bên trong 1 effect chỉ chạy lúc mount (deps []) — tham chiếu hàm này nó
  // giữ lại là bản CŨ từ lần render đầu tiên (closure cũ, y hệt handleCharacterMove/handleCharacterElevate
  // ở trên cũng vậy), nên state đọc trực tiếp trong thân hàm sẽ luôn là giá trị lúc mount (thường là
  // null), không bao giờ cập nhật. Đọc qua ref thay vì state tránh được vấn đề này — object ref không đổi
  // theo render, .current luôn là giá trị MỚI NHẤT bất kể bản đóng gói nào đang gọi.
  function handleCharacterTransform(url: string, t: CharacterTransform) {
    if (selectedCharacterUrlRef.current !== url) return;
    setSelectedTransform(t);
  }

  // SỬA (cùng panel, ô Position X/Z) — quy đổi 2 CHIỀU giữa toạ độ world X/Z và x/y chuẩn hoá 0..1 lưu
  // trong PositionedCharacter, dùng CHÍNH XÁC công thức fallback đơn giản (DEPTH_SCALE=2.5) mà
  // LocationPositionStage3D.tsx cũng dùng khi chưa có bảng hiệu chuẩn thật (groundCalib) — component cha
  // này không có quyền truy cập groundCalib (xây dựng nội bộ, bất đồng bộ, từ depthImageUrl/groundMaskUrl)
  // nên chỉ xấp xỉ được tới đây; hướng NGƯỢC LẠI (world -> x/y, dùng lúc gõ số) luôn chỉ xấp xỉ, còn hướng
  // XUÔI (x/y -> world, dùng lúc HIỂN THỊ) không cần tới vì panel đọc thẳng worldX/Y/Z CHÍNH XÁC TUYỆT ĐỐI
  // từ selectedTransform (xem onCharacterTransform) — chỉ lệch nhẹ ngay sau khi gõ số mới vào ô Position
  // X/Z (nếu ảnh nền có groundCalib thật), tự sửa đúng lại ngay khi effect dựng lại mannequin báo
  // transform mới về.
  const WORLD_DEPTH_SCALE_APPROX = 2.5;
  function worldZToNormalizedY(worldZ: number): number {
    const depth = Math.min(5, Math.max(0, -worldZ));
    return horizonY + (1 - horizonY) * (WORLD_DEPTH_SCALE_APPROX / (WORLD_DEPTH_SCALE_APPROX + depth));
  }
  function setPositionX(worldX: number) {
    if (!selectedChar) return;
    handleCharacterMove(selectedChar.url, { x: Math.min(1, Math.max(0, worldX / 5 + 0.5)), y: selectedChar.y });
  }
  function setPositionZ(worldZ: number) {
    if (!selectedChar) return;
    handleCharacterMove(selectedChar.url, { x: selectedChar.x, y: worldZToNormalizedY(worldZ) });
  }
  function setPositionY(worldY: number) {
    if (!selectedChar) return;
    handleCharacterElevate(selectedChar.url, worldY);
  }
  function setRotationXDeg(deg: number) {
    if (!selectedChar) return;
    handleCharacterRotateX(selectedChar.url, (deg * Math.PI) / 180);
  }
  function setRotationYDeg(deg: number) {
    if (!selectedChar) return;
    handleCharacterRotate(selectedChar.url, (deg * Math.PI) / 180);
  }
  function setRotationZDeg(deg: number) {
    if (!selectedChar) return;
    handleCharacterRotateZ(selectedChar.url, (deg * Math.PI) / 180);
  }
  function setScaleAxis(axis: "x" | "y" | "z", value: number) {
    if (!selectedChar || !selectedTransform) return;
    const safe = Math.max(0.05, value);
    if (scaleLocked) {
      handleCharacterScale(selectedChar.url, { x: safe, y: safe, z: safe });
      return;
    }
    const next = { x: selectedTransform.scaleX, y: selectedTransform.scaleY, z: selectedTransform.scaleZ };
    next[axis] = safe;
    handleCharacterScale(selectedChar.url, next);
  }
  function startRenameChar() {
    if (!selectedChar) return;
    setRenameDraft(selectedChar.name);
    setRenamingChar(true);
  }
  function commitRenameChar() {
    if (selectedChar && renameDraft.trim()) {
      setCharacters((prev) => prev.map((c) => (c.url === selectedChar.url ? { ...c, name: renameDraft.trim() } : c)));
    }
    setRenamingChar(false);
  }

  function handleExport() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setExporting(true);
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = "3d-builder-export.png";
      a.click();
    } finally {
      setExporting(false);
    }
  }

  // Nội dung panel trái (Characters/...) — tách riêng để dùng chung cho cả cột cố định desktop LẪN ngăn
  // kéo toàn màn hình trên di động, không viết 2 lần.
  const leftPanelBody =
    activeTab === "characters" ? (
      <>
        <h2 className="mb-3 text-sm font-semibold text-zinc-200">Characters</h2>
        <p className="mb-2 text-xs text-zinc-500">Add Characters</p>
        <div className="mb-6 grid grid-cols-2 gap-3">
          {allCharacterPresets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => addCharacter(preset)}
              className="flex flex-col items-center gap-1.5 overflow-hidden rounded-lg border-2 border-zinc-700 bg-zinc-900 p-2 hover:border-fuchsia-500"
            >
              {preset.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preset.thumbUrl} alt={preset.label} className="h-24 w-full rounded-lg object-cover object-top" />
              ) : (
                // Model admin thêm riêng, không có ảnh preview dựng sẵn (xem customPresets) — hiện
                // icon người chung làm đại diện, phân biệt bằng màu xoay vòng (CUSTOM_MODEL_COLORS).
                <div
                  className="flex h-24 w-full items-center justify-center rounded-lg text-3xl"
                  style={{ backgroundColor: `${preset.color}33` }}
                >
                  <span style={{ color: preset.color }}>☺</span>
                </div>
              )}
              <span className="text-sm font-medium text-zinc-200">{preset.label}</span>
            </button>
          ))}
        </div>

        {characters.length > 0 && (
          <>
            <p className="mb-2 text-xs text-zinc-500">Đã đặt trong cảnh ({characters.length})</p>
            <ul className="space-y-1.5">
              {characters.map((c) => (
                <li
                  key={c.url}
                  // SỬA: KHÔNG thêm bấm-để-chọn ở đây — LocationPositionStage3D tự quản lý chọn/bỏ chọn
                  // nội bộ (bấm trúng nhân vật trong khung 3D), không nhận "chọn từ xa" qua prop điều
                  // khiển nào cả; bấm ở list này sẽ chỉ đổi panel bên phải mà KHÔNG thật sự gắn gizmo vào
                  // đúng nhân vật đó trong khung 3D — gây lệch trạng thái, số liệu Transform sẽ đứng yên
                  // (không update) vì component 3D không biết gì về lượt "chọn" này. Để dành cho 1 bản vá
                  // sau nếu cần (thêm prop controlled selectedCharacterUrl cho LocationPositionStage3D).
                  className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${
                    c.url === selectedCharacterUrl ? "border-fuchsia-500 bg-fuchsia-500/10" : "border-zinc-800 bg-zinc-900/60"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                    <span className="truncate">{c.name}</span>
                  </span>
                  <button type="button" onClick={() => removeCharacter(c.url)} className="shrink-0 text-zinc-500 hover:text-red-400" title="Xoá">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    ) : (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-zinc-500">
        <p className="text-sm">Sắp ra mắt</p>
        <p className="text-xs">Mục &quot;{LEFT_TABS.find((t) => t.key === activeTab)?.label}&quot; đang được xây dựng.</p>
      </div>
    );

  // Nội dung panel phải (Background/Global lighting/Display) — tách riêng tương tự leftPanelBody.
  const rightPanelBody = (
    <>
      <section className="mb-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Background</h3>
        {backgroundUrl ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={backgroundUrl} alt="" className="h-28 w-full rounded-lg border border-zinc-800 object-cover" />
            <label className="block cursor-pointer rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-zinc-300 hover:border-fuchsia-500">
              Đổi ảnh
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleBackgroundFile(file);
                }}
              />
            </label>
          </div>
        ) : (
          <label className="block cursor-pointer rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-center text-xs text-zinc-400 hover:border-fuchsia-500 hover:text-zinc-200">
            Chưa có ảnh bối cảnh — bấm để thêm
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleBackgroundFile(file);
              }}
            />
          </label>
        )}
      </section>

      <section className="mb-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Global lighting</h3>
        <button
          type="button"
          onClick={() => setLightModalOpen(true)}
          className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-left text-xs text-zinc-300 hover:border-fuchsia-500"
        >
          {lightSettings && lightSettings.length > 0 ? `${lightSettings.length} nguồn sáng đã chỉnh` : "Mặc định — bấm để chỉnh"}
        </button>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Display</h3>
        <label className="flex items-center justify-between py-1.5 text-xs text-zinc-300">
          Character labels
          <input
            type="checkbox"
            checked={characterLabels}
            // SỬA (phản hồi thật user, panel thông số nhân vật thêm toggle "Show label" RIÊNG từng người —
            // xem characterPanelBody) — nút chung này trước đây không đụng gì tới khung 3D (state
            // `characterLabels` không được dùng ở đâu cả, vì chưa có nhãn tên nào thật sự tồn tại). Giờ
            // nhãn tên đã có thật (xem labelSprite ở LocationPositionStage3D.tsx), nút chung này áp dụng
            // HÀNG LOẠT cho MỌI nhân vật đang có trong cảnh + đặt mặc định cho nhân vật thêm MỚI sau đó
            // (xem addCharacter) — bấm 1 nhân vật rồi vào panel riêng vẫn chỉnh LẺ được, không xung đột.
            onChange={(e) => {
              setCharacterLabels(e.target.checked);
              setCharacters((prev) => prev.map((c) => ({ ...c, showLabel: e.target.checked })));
            }}
            className="h-4 w-4 accent-fuchsia-500"
          />
        </label>
      </section>
    </>
  );

  // SỬA (phản hồi thật user, gửi ảnh mẫu panel "Camera preview/Properties/Transform" kiểu TopView builder
  // — "bên phải màn hình chưa có thông số của nhân vật") — panel THÔNG SỐ NHÂN VẬT, thay thế rightPanelBody
  // khi đang CHỌN 1 nhân vật (xem chỗ render ở dưới). Bỏ phần "Camera preview" (hệ thống chưa có khái niệm
  // nhiều camera/camera đã lưu — xác nhận qua AskUserQuestion, để dành cho tab "Cameras" riêng sau này).
  // Tab "Pose" giữ layout 2 tab đúng ảnh mẫu nhưng để placeholder (thư viện tư thế chưa có, mục "Motions"
  // bên trái vẫn "sắp ra mắt" — cũng đã xác nhận qua AskUserQuestion). "Material" chỉ còn tiêu đề + "Sắp ra
  // mắt" vì nhân vật hiện dùng nguyên vật liệu/texture gốc từ file .glb, chưa có hệ thống đổi vật liệu.
  const characterPanelBody = selectedChar ? (
    <>
      {/* Không có nút "quay lại" riêng ở đây — nút "✕ Bỏ chọn" đã có sẵn trên khung 3D (overlay góc trên-
          trái canvas, xem component LocationPositionStage3D) là nơi DUY NHẤT điều khiển bỏ chọn, tự động
          trả panel này về rightPanelBody qua onCharacterSelect(null) — thêm nút riêng ở đây dễ gây lệch
          trạng thái (panel đổi nhưng gizmo 3D vẫn còn gắn, vì component 3D tự quản lý chọn/bỏ chọn nội bộ,
          không nhận lệnh điều khiển từ bên ngoài). */}
      <div className="mb-4 flex items-center justify-between gap-2">
        {renamingChar ? (
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={commitRenameChar}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRenameChar();
              if (e.key === "Escape") setRenamingChar(false);
            }}
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 focus:border-fuchsia-500 focus:outline-none"
          />
        ) : (
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-100">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: selectedChar.color }} />
            <span className="truncate">{selectedChar.name}</span>
          </span>
        )}
        {!renamingChar && (
          <button type="button" onClick={startRenameChar} className="shrink-0 text-zinc-400 hover:text-zinc-100" title="Đổi tên">
            ✎
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-4 border-b border-zinc-800 text-xs">
        <button
          type="button"
          onClick={() => setCharPanelTab("properties")}
          className={`-mb-px border-b-2 px-0.5 pb-2 font-medium ${
            charPanelTab === "properties" ? "border-fuchsia-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Properties
        </button>
        <button
          type="button"
          onClick={() => setCharPanelTab("pose")}
          className={`-mb-px border-b-2 px-0.5 pb-2 font-medium ${
            charPanelTab === "pose" ? "border-fuchsia-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Pose
        </button>
      </div>

      {charPanelTab === "pose" ? (
        <div className="flex h-40 flex-col items-center justify-center gap-1 text-center text-zinc-500">
          <p className="text-sm">Sắp ra mắt</p>
          <p className="text-xs">Thư viện tư thế đang được xây dựng.</p>
        </div>
      ) : (
        <>
          <label className="mb-4 flex items-center justify-between text-xs text-zinc-300">
            Show label
            <input
              type="checkbox"
              checked={selectedChar.showLabel ?? true}
              onChange={(e) => handleCharacterShowLabel(selectedChar.url, e.target.checked)}
              className="h-4 w-4 accent-fuchsia-500"
            />
          </label>

          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Transform</h3>
          </div>

          <div className="mb-3">
            <p className="mb-1 text-[11px] text-zinc-500">Position</p>
            <div className="grid grid-cols-3 gap-1.5">
              <TransformNumberField axis="X" value={selectedTransform?.worldX ?? 0} onCommit={setPositionX} step={0.1} />
              <TransformNumberField axis="Y" value={selectedTransform?.worldY ?? 0} onCommit={setPositionY} step={0.1} />
              <TransformNumberField axis="Z" value={selectedTransform?.worldZ ?? 0} onCommit={setPositionZ} step={0.1} />
            </div>
          </div>

          <div className="mb-3">
            <p className="mb-1 text-[11px] text-zinc-500">Rotation</p>
            <div className="grid grid-cols-3 gap-1.5">
              <TransformNumberField axis="X" value={((selectedTransform?.rotationX ?? 0) * 180) / Math.PI} onCommit={setRotationXDeg} step={1} />
              <TransformNumberField axis="Y" value={((selectedTransform?.rotationY ?? 0) * 180) / Math.PI} onCommit={setRotationYDeg} step={1} />
              <TransformNumberField axis="Z" value={((selectedTransform?.rotationZ ?? 0) * 180) / Math.PI} onCommit={setRotationZDeg} step={1} />
            </div>
          </div>

          <div className="mb-4">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-[11px] text-zinc-500">Scale</p>
              <button
                type="button"
                onClick={() => setScaleLocked((v) => !v)}
                title={scaleLocked ? "Đang khoá tỉ lệ X=Y=Z — bấm để tự do từng trục" : "Đang tự do từng trục — bấm để khoá tỉ lệ"}
                className="text-zinc-400 hover:text-zinc-100"
              >
                {scaleLocked ? "🔒" : "🔓"}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <TransformNumberField axis="X" value={selectedTransform?.scaleX ?? 1} onCommit={(v) => setScaleAxis("x", v)} step={0.05} />
              <TransformNumberField axis="Y" value={selectedTransform?.scaleY ?? 1} onCommit={(v) => setScaleAxis("y", v)} step={0.05} />
              <TransformNumberField axis="Z" value={selectedTransform?.scaleZ ?? 1} onCommit={(v) => setScaleAxis("z", v)} step={0.05} />
            </div>
          </div>

          {/* SỬA (phản hồi thật user: "làm luôn Material" — hệ thống chưa có kho texture/PBR để làm
              material editor đầy đủ, nên làm đúng mức khả thi nhất: 1 màu TINT nhân đè lên toàn bộ vật
              liệu model (giữ nguyên hoạ tiết/texture gốc, chỉ ngả màu) — xem chỗ áp dụng thật ở
              LocationPositionStage3D.tsx (PositionedCharacter.tintColor). */}
          <div className="border-t border-zinc-800 pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Material</h3>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={selectedChar.tintColor ?? "#ffffff"}
                onChange={(e) => handleCharacterTint(selectedChar.url, e.target.value)}
                className="h-8 w-10 shrink-0 cursor-pointer rounded border border-zinc-700 bg-zinc-900 p-0.5"
                title="Màu tint — nhân đè lên toàn bộ vật liệu nhân vật"
              />
              <span className="flex-1 text-xs text-zinc-400">
                {selectedChar.tintColor && selectedChar.tintColor.toLowerCase() !== "#ffffff" ? selectedChar.tintColor : "Màu gốc — chưa tint"}
              </span>
              {selectedChar.tintColor && selectedChar.tintColor.toLowerCase() !== "#ffffff" && (
                <button
                  type="button"
                  onClick={() => handleCharacterTint(selectedChar.url, "#ffffff")}
                  className="shrink-0 text-xs text-zinc-500 hover:text-zinc-200"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </>
  ) : null;

  return (
    <div className="flex h-screen flex-col bg-black text-zinc-100">
      {/* Thanh trên cùng */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <Link href="/video-tu-y-tuong" className="text-zinc-400 hover:text-zinc-100" title="Quay lại">
          ←
        </Link>
        <span className="text-sm font-semibold">3D Builder</span>
        <span className="hidden text-xs text-zinc-500 sm:inline">· Untitled</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleExport}
          disabled={!backgroundUrl && characters.length === 0}
          className="rounded-lg border-2 border-fuchsia-500 bg-fuchsia-500/20 px-4 py-1.5 text-sm font-semibold text-white hover:bg-fuchsia-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {exporting ? "Đang xuất..." : "⬇ Export"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Cột trái — icon rail + panel theo tab. ẨN HẲN dưới md (768px, xem ghi chú mobileDrawer phía
            trên) — trên di động dùng thanh tab ngang + ngăn kéo toàn màn hình ở cuối file thay thế. */}
        <div className="relative hidden shrink-0 border-r border-zinc-800 md:flex">
          <nav className="flex w-20 flex-col items-center gap-1 border-r border-zinc-800 py-3">
            {LEFT_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex w-16 flex-col items-center gap-1 rounded-lg py-2 text-[11px] ${
                  activeTab === tab.key ? "bg-zinc-800 text-fuchsia-400" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
              >
                <span className="text-lg leading-none">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Nút thu gọn/mở rộng panel bên phải dải icon — nổi giữa cạnh phải panel */}
          <button
            type="button"
            onClick={() => setLeftPanelCollapsed((v) => !v)}
            title={leftPanelCollapsed ? "Mở rộng" : "Thu gọn"}
            className="absolute top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-400 shadow hover:border-fuchsia-500 hover:text-fuchsia-400"
            style={{ left: leftPanelCollapsed ? "4.5rem" : "22.5rem" }}
          >
            {leftPanelCollapsed ? "›" : "‹"}
          </button>

          <div className={`overflow-y-auto p-4 ${leftPanelCollapsed ? "hidden w-0 p-0" : "w-72"}`}>{leftPanelBody}</div>
        </div>

        {/* Khung 3D ở giữa — SỬA (phản hồi thật user: "chưa cho nhân vật vào 3D được" — trước đây khung
            3D CHỈ hiện sau khi đã upload ảnh bối cảnh, nên bấm thêm nhân vật trước đó không thấy gì cả,
            vẫn kẹt ở màn hình "Bấm để chọn ảnh") — luôn dựng khung 3D (sàn phẳng mặc định), cho thêm
            nhân vật được ngay cả khi chưa có ảnh; ô upload ảnh chuyển thành gợi ý nổi phía trên, không
            còn chặn hẳn khung 3D nữa. */}
        <div className="relative flex min-w-0 flex-1 items-center justify-center bg-zinc-950">
          <LocationPositionStage3D
            locationUrl={backgroundUrl ?? ""}
            characters={characters}
            testPoints={NO_TEST_POINTS}
            depthImageUrl={depthImageUrl}
            groundMaskUrl={groundMaskUrl}
            horizonY={horizonY}
            characterHeightUnits={1.0}
            onCharacterMove={handleCharacterMove}
            onCharacterRotate={handleCharacterRotate}
            onCharacterRotateX={handleCharacterRotateX}
            onCharacterRotateZ={handleCharacterRotateZ}
            onCharacterElevate={handleCharacterElevate}
            onCharacterScale={handleCharacterScale}
            onCharacterSelect={handleCharacterSelect}
            onCharacterTransform={handleCharacterTransform}
            onCanvasReady={(canvas) => {
              canvasRef.current = canvas;
            }}
          />
          {!backgroundUrl && !buildingBlockout && (
            <label className="absolute left-1/2 top-4 flex -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/90 px-4 py-2 text-xs text-zinc-300 hover:border-fuchsia-500 hover:text-zinc-100">
              <span>🖼</span>
              <span>Bấm để chọn ảnh bối cảnh (tuỳ chọn)</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleBackgroundFile(file);
                }}
              />
            </label>
          )}
          {buildingBlockout && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-zinc-300">
              Đang dựng khối 3D từ ảnh bối cảnh...
            </div>
          )}
          {bgError && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-red-900/60 bg-red-950/80 px-3 py-1.5 text-xs text-red-300">
              {bgError}
            </div>
          )}
        </div>

        {/* Cột phải — thông số. ẨN HẲN dưới md, xem ngăn kéo "right" ở cuối file. */}
        <div className="hidden w-80 shrink-0 overflow-y-auto border-l border-zinc-800 p-4 text-sm md:block">
          {characterPanelBody ?? rightPanelBody}
        </div>
      </div>

      {/* Thanh dưới cùng desktop — placeholder, chưa làm (xem kế hoạch: Motions/timeline là việc sau).
          ẨN trên di động, nhường chỗ cho thanh tab ngang thay thế bên dưới. */}
      <footer className="hidden h-14 shrink-0 items-center gap-3 border-t border-zinc-800 px-4 text-xs text-zinc-600 md:flex">
        <span>Timeline — sắp ra mắt</span>
      </footer>

      {/* Thanh tab ngang DƯỚI CÙNG — chỉ hiện trên di động (dưới md), thay cho dải icon dọc bên trái vốn
          chiếm quá nhiều chiều rộng màn hình hẹp. Bấm vào 1 tab mở ngăn kéo toàn màn hình tương ứng. */}
      <nav className="flex shrink-0 items-center justify-around overflow-x-auto border-t border-zinc-800 bg-black px-1 py-1.5 md:hidden">
        {LEFT_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => {
              setActiveTab(tab.key);
              setMobileDrawer("left");
            }}
            className={`flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[10px] ${
              mobileDrawer === "left" && activeTab === tab.key ? "text-fuchsia-400" : "text-zinc-400"
            }`}
          >
            <span className="text-base leading-none">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMobileDrawer("right")}
          className={`flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[10px] ${
            mobileDrawer === "right" ? "text-fuchsia-400" : "text-zinc-400"
          }`}
        >
          <span className="text-base leading-none">⚙</span>
          Thông số
        </button>
      </nav>

      {/* Ngăn kéo toàn màn hình trên di động — hiện đúng nội dung leftPanelBody/rightPanelBody, cùng 1
          nguồn với cột cố định desktop phía trên, không viết trùng. */}
      {mobileDrawer !== "none" && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black md:hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-3">
            <span className="text-sm font-semibold text-zinc-200">
              {mobileDrawer === "left" ? LEFT_TABS.find((t) => t.key === activeTab)?.label : characterPanelBody ? "Thông số nhân vật" : "Thông số"}
            </span>
            <button type="button" onClick={() => setMobileDrawer("none")} className="text-zinc-400 hover:text-zinc-100">
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 text-sm">
            {mobileDrawer === "left" ? leftPanelBody : (characterPanelBody ?? rightPanelBody)}
          </div>
        </div>
      )}

      {lightModalOpen && (
        <LightSphereModal
          initial={lightSettings}
          onClose={() => setLightModalOpen(false)}
          onApply={(settings) => {
            setLightSettings(settings);
            setLightModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
