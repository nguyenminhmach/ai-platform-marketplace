"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildMannequin } from "@/lib/mannequin-preview";

export type PositionedCharacter = {
  url: string;
  name: string;
  color: string;
  // Toạ độ chuẩn hoá 0..1 đã chọn trên ảnh 2D (xem locationPositions ở VideoTuYTuongClient.tsx) — x:
  // trái(0)->phải(1), y: xa(0, gần đỉnh ảnh)->gần(1, gần đáy ảnh).
  x: number;
  y: number;
};

type Props = {
  locationUrl: string;
  characters: PositionedCharacter[];
};

// Xem trước 3D NHIỀU nhân vật cùng lúc, đặt đúng vị trí tương đối đã chọn trên ảnh bối cảnh 2D — mở
// rộng từ components/MannequinPreviewCard.tsx (vốn chỉ có 1 mannequin xoay tại chỗ). Khác biệt chính:
// (1) nhiều mannequin, mỗi cái nhân bản từ CÙNG 1 hình buildMannequin() (xem mục 18.3 kế hoạch đã lưu
// memory — không cần tạo model mới cho từng người), đặt vào world-position tính từ x/y; (2) khách kéo
// xoay CAMERA quanh cả cảnh (orbit) thay vì xoay từng mannequin riêng — vì giờ có nhiều vật thể, xoay
// riêng từng cái sẽ rối; (3) ảnh bối cảnh vẫn chỉ là phông CSS phẳng phía sau (chưa dùng khối 3D thật
// từ Fal depth/segment — đó là lớp nâng cấp sau, xem nút "Dựng khối 3D" đã gọi nhưng chưa render).
export function LocationPositionStage3D({ locationUrl, characters }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const dragRef = useRef<{ dragging: boolean; startX: number; startAzimuth: number }>({ dragging: false, startX: 0, startAzimuth: 0 });
  // Góc orbit ban đầu = 0 (nhìn THẲNG, không chếch) — BẮT BUỘC để trái/phải trên khung 3D khớp đúng
  // trái/phải khách đã bấm trên ảnh 2D lúc mới mở (user phản hồi thực tế: chếch sẵn làm 2 bên lệch
  // nhau rõ). Khách tự kéo xoay thêm sau nếu muốn xem góc khác, chỉ ảnh hưởng lúc ĐANG xoay, không
  // ảnh hưởng lúc vừa mở.
  const azimuthRef = useRef(0);
  const [, forceRerender] = useState(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(1, 3, 2);
    scene.add(dirLight);

    // Mặt đất mờ — chỉ để mắt có điểm neo chiều sâu khi xoay, không phải khối 3D thật dựng từ Fal.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(6, 32),
      new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 1, transparent: true, opacity: 0.35 })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    cameraRef.current = camera;
    sceneRef.current = scene;

    function updateCamera() {
      const radius = 9;
      const az = azimuthRef.current;
      camera.position.set(Math.sin(az) * radius, 3.4, Math.cos(az) * radius);
      camera.lookAt(0, 1.8, 0);
    }
    updateCamera();

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

    let raf = 0;
    function loop() {
      updateCamera();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    }
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dựng lại mannequin mỗi khi danh sách nhân vật/vị trí đổi — xoá hết group cũ, thêm lại từ đầu (đơn
  // giản hơn diff từng người, số lượng tối đa 5 nên không đáng lo hiệu năng — xem mục 18.4).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const old = scene.children.filter((c) => c.userData.isCharacterMannequin);
    old.forEach((c) => scene.remove(c));

    const SPREAD_X = 5;
    const SPREAD_Z = 5;
    for (const ch of characters) {
      const mannequin = buildMannequin();
      mannequin.userData.isCharacterMannequin = true;
      const worldX = (ch.x - 0.5) * SPREAD_X;
      const worldZ = -(1 - ch.y) * SPREAD_Z;
      mannequin.position.set(worldX, 0, worldZ);
      mannequin.scale.setScalar(0.42); // thu nhỏ để vừa khung + chừa chỗ nhiều người đứng cạnh nhau
      mannequin.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial && obj.material.color.getHex() === 0x9ca3af) {
          const mat = obj.material.clone();
          mat.color.set(ch.color);
          obj.material = mat;
        }
      });
      scene.add(mannequin);
    }
    forceRerender((n) => n + 1);
  }, [characters]);

  function handlePointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { dragging: true, startX: e.clientX, startAzimuth: azimuthRef.current };
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    azimuthRef.current = dragRef.current.startAzimuth + dx * 0.012;
  }
  function handlePointerUp() {
    dragRef.current.dragging = false;
  }

  return (
    <div
      className="relative aspect-video w-full touch-none overflow-hidden rounded-lg bg-zinc-900"
      style={{ backgroundImage: `url(${locationUrl})`, backgroundSize: "cover", backgroundPosition: "center", cursor: "grab" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div className="absolute inset-0 bg-black/10" />
      <div ref={mountRef} className="absolute inset-0" />
      <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">🔄 Kéo để xoay xem</span>
    </div>
  );
}
