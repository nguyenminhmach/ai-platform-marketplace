"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildMannequin, MANNEQUIN_ROTATION_Y, nearestCameraView } from "@/lib/mannequin-preview";

type StageProps = {
  locationUrl?: string | null;
  boxStyle: { left: string; top: string; width: string; height: string };
  cameraAngle: string | null;
  cameraView: string | null;
  onCameraViewChange?: (view: string) => void;
  editable?: boolean;
  onZoomClick?: () => void;
};

// 1 "sân khấu" độc lập: ảnh Bối cảnh làm nền + mannequin 3D + vùng bấm-kéo xoay + nút "Chọn góc này".
// Tách riêng khỏi MannequinPreviewCard vì cần dựng 2 lần: 1 bản nhỏ trong lưới, 1 bản to khi khách bấm
// "phóng to" (xem MannequinPreviewCard) — mỗi bản có Three.js renderer RIÊNG (không dùng chung canvas).
function Stage({ locationUrl, boxStyle, cameraAngle, cameraView, onCameraViewChange, editable = true, onZoomClick }: StageProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const mannequinRef = useRef<THREE.Group | null>(null);
  const dragRef = useRef<{ dragging: boolean; startX: number; startRot: number }>({ dragging: false, startX: 0, startRot: 0 });
  const [rotatedAway, setRotatedAway] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(1, 2, 3);
    scene.add(dirLight);

    const mannequin = buildMannequin();
    scene.add(mannequin);
    mannequinRef.current = mannequin;

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    camera.position.set(0, 2.1, 7.5);
    camera.lookAt(0, 2.0, 0);
    cameraRef.current = camera;
    sceneRef.current = scene;

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    return () => {
      ro.disconnect();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const rot = MANNEQUIN_ROTATION_Y[cameraView ?? "front"] ?? 0;
    setRotatedAway(false);
    if (mannequinRef.current && sceneRef.current && cameraRef.current && rendererRef.current) {
      mannequinRef.current.rotation.y = rot;
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }, [cameraView]);

  function render() {
    if (sceneRef.current && cameraRef.current && rendererRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (!editable || !mannequinRef.current) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { dragging: true, startX: e.clientX, startRot: mannequinRef.current.rotation.y };
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (!dragRef.current.dragging || !mannequinRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    mannequinRef.current.rotation.y = dragRef.current.startRot + dx * 0.012;
    setRotatedAway(true);
    render();
  }
  function handlePointerUp() {
    dragRef.current.dragging = false;
  }

  function handleConfirmAngle() {
    if (!mannequinRef.current || !onCameraViewChange) return;
    const view = nearestCameraView(mannequinRef.current.rotation.y);
    onCameraViewChange(view);
    // onCameraViewChange đổi cameraView prop -> effect ở trên tự đặt lại rotation về đúng góc chuẩn +
    // tắt trạng thái rotatedAway, không cần tự làm ở đây.
  }

  const barColor = SCENE_PREVIEW_ANGLE_BAR_COLOR[cameraAngle ?? ""] ?? "#64748b";

  return (
    // Vùng bấm-kéo phủ NGUYÊN CẢ khung ảnh (không chỉ đúng ô nhỏ vẽ mannequin) — mannequin ở cỡ cảnh
    // "Toàn cảnh rộng" có thể chỉ chiếm vài % diện tích khung, bấm trúng rất khó nếu chỉ cho kéo đúng ô
    // đó. Khách bấm-kéo bất kỳ đâu trong khung đều xoay được, mannequin vẫn chỉ VẼ ở đúng vị trí/tỉ lệ
    // (boxStyle) như cũ.
    <div
      className="relative aspect-video w-full touch-none overflow-hidden bg-zinc-900"
      style={{
        backgroundImage: locationUrl ? `url(${locationUrl})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
        cursor: editable ? "grab" : "default",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div className="absolute inset-0 bg-black/15" />
      <div ref={mountRef} className="pointer-events-none absolute" style={boxStyle} />
      <div className="absolute left-0 top-0 h-1.5 w-full" style={{ backgroundColor: barColor }} />
      {onZoomClick && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onZoomClick();
          }}
          className="absolute right-1.5 top-3 rounded-full bg-black/50 px-2 py-1 text-[11px] text-white hover:bg-black/70"
          title="Phóng to"
        >
          🔍
        </button>
      )}
      {editable && rotatedAway && onCameraViewChange && (
        <button
          type="button"
          onClick={handleConfirmAngle}
          className="absolute bottom-1.5 right-1.5 rounded-full bg-zinc-900/90 px-2.5 py-1 text-[10px] font-medium text-white shadow hover:bg-zinc-900 dark:bg-zinc-50/90 dark:text-zinc-900"
        >
          ✅ Chọn góc này
        </button>
      )}
      {editable && !rotatedAway && (
        <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
          🔄 Kéo để xoay
        </span>
      )}
    </div>
  );
}

// Khối "1 cảnh" trong khung xem trước bố cục MIỄN PHÍ (story-video) — ảnh Bối cảnh làm nền tĩnh, mannequin
// 3D CHUNG CHUNG (không phải mặt/thân thật) đặt đè lên theo đúng vị trí/tỉ lệ đã tính sẵn (boxStyle, tính
// theo % ở nơi gọi — xem app/mini-app/[id]/page.tsx), khách kéo chuột/vuốt tay để TỰ XOAY xem các góc khác
// ngoài đúng cameraView Agent đã chọn. Bấm "Chọn góc này" để GHI ĐÈ lại cameraView thật sự dùng khi tạo
// ảnh AI (xem onCameraViewChange ở nơi gọi). Bấm 🔍 mở khung to hết màn hình (dựng riêng 1 renderer khác,
// đồng bộ qua cùng cameraView/onCameraViewChange) — khung nhỏ trong lưới nhiều khi quá bé để kéo chính xác,
// nhất là cỡ cảnh "Toàn cảnh rộng" (khách phản hồi thực tế yêu cầu thêm nút này).
export function MannequinPreviewCard(props: StageProps) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <>
      <Stage {...props} onZoomClick={() => setZoomed(true)} />
      {zoomed && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-4"
          onClick={() => setZoomed(false)}
        >
          <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <Stage {...props} />
            <button
              type="button"
              onClick={() => setZoomed(false)}
              className="mt-3 w-full rounded-full bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-900"
            >
              Đóng
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Trùng đúng bảng màu SCENE_PREVIEW_ANGLE_BAR_COLOR ở app/mini-app/[id]/page.tsx — tách riêng vì
// component này là "use client" độc lập, không import ngược được biến khai báo trong page.tsx.
const SCENE_PREVIEW_ANGLE_BAR_COLOR: Record<string, string> = {
  eye_level: "#64748b",
  low_angle: "#f59e0b",
  high_angle: "#3b82f6",
  aerial_shot: "#8b5cf6",
  dutch_angle: "#ef4444",
};
