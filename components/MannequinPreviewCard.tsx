"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildMannequin, MANNEQUIN_ROTATION_Y, nearestCameraView } from "@/lib/mannequin-preview";

// Khối "1 cảnh" trong khung xem trước bố cục MIỄN PHÍ (story-video) — ảnh Bối cảnh làm nền tĩnh (CSS
// background, không cần WebGL), mannequin 3D CHUNG CHUNG (không phải mặt/thân thật) đặt đè lên theo
// đúng vị trí/tỉ lệ đã tính sẵn (boxStyle, tính theo % ở nơi gọi — xem app/mini-app/[id]/page.tsx), khách
// kéo chuột/vuốt tay để TỰ XOAY xem các góc khác ngoài đúng cameraView Agent đã chọn. Bấm "Chọn góc này"
// để GHI ĐÈ lại cameraView thật sự dùng khi tạo ảnh AI (xem onCameraViewChange ở nơi gọi).
export function MannequinPreviewCard({
  locationUrl,
  boxStyle,
  cameraAngle,
  cameraView,
  onCameraViewChange,
  editable = true,
}: {
  locationUrl?: string | null;
  boxStyle: { left: string; top: string; width: string; height: string };
  cameraAngle: string | null;
  cameraView: string | null;
  onCameraViewChange?: (view: string) => void;
  editable?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const mannequinRef = useRef<THREE.Group | null>(null);
  const baseRotationRef = useRef(0);
  const dragRef = useRef<{ dragging: boolean; startX: number; startRot: number }>({ dragging: false, startX: 0, startRot: 0 });
  const [rotatedAway, setRotatedAway] = useState(false);

  // Dựng scene 1 lần — mount vào đúng div này, tự resize theo kích thước thật của div (đổi theo boxStyle
  // % của khung cha nên không cố định số px).
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

  // cameraView đổi (cảnh khác, hoặc Agent chọn lại) — đặt lại góc mặc định, bỏ trạng thái "đã xoay".
  useEffect(() => {
    const rot = MANNEQUIN_ROTATION_Y[cameraView ?? "front"] ?? 0;
    baseRotationRef.current = rot;
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
    <div
      className="relative aspect-video w-full overflow-hidden bg-zinc-900"
      style={{
        backgroundImage: locationUrl ? `url(${locationUrl})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-black/15" />
      <div
        ref={mountRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className="absolute touch-none"
        style={{ ...boxStyle, cursor: editable ? "grab" : "default" }}
      />
      <div className="absolute left-0 top-0 h-1.5 w-full" style={{ backgroundColor: barColor }} />
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

// Trùng đúng bảng màu SCENE_PREVIEW_ANGLE_BAR_COLOR ở app/mini-app/[id]/page.tsx — tách riêng vì
// component này là "use client" độc lập, không import ngược được biến khai báo trong page.tsx.
const SCENE_PREVIEW_ANGLE_BAR_COLOR: Record<string, string> = {
  eye_level: "#64748b",
  low_angle: "#f59e0b",
  high_angle: "#3b82f6",
  aerial_shot: "#8b5cf6",
  dutch_angle: "#ef4444",
};
