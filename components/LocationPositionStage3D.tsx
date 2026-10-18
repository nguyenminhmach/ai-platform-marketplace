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

// SỬA (phản hồi thật của user): bỏ hẳn khái niệm "label" cố định (building/road/sky) — ảnh bối cảnh
// thật có thể là bất kỳ thứ gì, không nên đoán trước tên. Đổi sang fal-ai/sam2/auto-segment (tự động
// phân vùng toàn ảnh, không cần đoán tên) — đổi lại endpoint này KHÔNG trả sẵn toạ độ, chỉ trả ảnh
// mask từng vùng, nên phải tự đọc canvas để tính vị trí/kích thước — xem computeMaskBBox bên dưới.
export type LocationSegment = { maskUrl: string };

type Props = {
  locationUrl: string;
  characters: PositionedCharacter[];
  // Kết quả Fal.ai (ước lượng độ sâu + phân vùng, xem nút "Dựng khối 3D" ở VideoTuYTuongClient.tsx) —
  // tuỳ chọn, nếu chưa gọi hoặc chưa xong thì khung 3D vẫn hiển thị bình thường (chỉ mannequin + phông
  // ảnh phẳng), không chặn gì cả. Khi có, mỗi vùng dựng thành 1 khối hộp/mặt phẳng thô, không phân biệt
  // "đây là gì" — xem mục 17.2/19 kế hoạch đã lưu memory.
  segments?: LocationSegment[];
};

function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("load fail"));
    img.src = url;
  });
}

// Đọc ảnh mask (trắng = thuộc vùng, đen = không) bằng canvas, trả về khung bao (bounding box) chuẩn
// hoá 0..1 — không cần hiểu hình dạng chính xác, chỉ cần biết vùng đó nằm ở đâu/rộng bao nhiêu để dựng
// 1 khối hộp XẤP XỈ. Lấy mẫu thưa (step) cho nhanh, đủ dùng cho mục đích ước lượng thô.
async function computeMaskBBox(maskUrl: string): Promise<{ minX: number; maxX: number; minY: number; maxY: number } | null> {
  try {
    const img = await loadImageEl(maskUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0, found = false;
    const step = Math.max(1, Math.floor(Math.max(canvas.width, canvas.height) / 200));
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const idx = (y * canvas.width + x) * 4;
        if (data[idx] > 128) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return null;
    return { minX: minX / canvas.width, maxX: maxX / canvas.width, minY: minY / canvas.height, maxY: maxY / canvas.height };
  } catch {
    return null; // ảnh mask lỗi/không tải được (CORS, 404...) — bỏ qua vùng đó, không chặn cả khung 3D
  }
}

// Xem trước 3D NHIỀU nhân vật cùng lúc, đặt đúng vị trí tương đối đã chọn trên ảnh bối cảnh 2D — mở
// rộng từ components/MannequinPreviewCard.tsx (vốn chỉ có 1 mannequin xoay tại chỗ). Khác biệt chính:
// (1) nhiều mannequin, mỗi cái nhân bản từ CÙNG 1 hình buildMannequin() (xem mục 18.3 kế hoạch đã lưu
// memory — không cần tạo model mới cho từng người), đặt vào world-position tính từ x/y; (2) khách kéo
// xoay CAMERA quanh cả cảnh (orbit) thay vì xoay từng mannequin riêng — vì giờ có nhiều vật thể, xoay
// riêng từng cái sẽ rối; (3) ảnh bối cảnh vẫn chỉ là phông CSS phẳng phía sau (chưa dùng khối 3D thật
// từ Fal depth/segment — đó là lớp nâng cấp sau, xem nút "Dựng khối 3D" đã gọi nhưng chưa render).
export function LocationPositionStage3D({ locationUrl, characters, segments }: Props) {
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

  // Dựng khối thô cho MỖI vùng Fal phát hiện được — không biết/không cần biết "đây là cái gì" (không
  // còn building/road cố định), chỉ xét HÌNH DẠNG của khung bao để quyết định vẽ mặt phẳng (vùng rộng,
  // dẹt, nằm thấp trong khung — kiểu mặt đất/lối đi) hay khối hộp đứng (còn lại — kiểu vật thể đứng).
  // Bỏ qua vùng gần phủ kín cả khung (>85% rộng VÀ >85% cao) — thường là nền/bầu trời gộp chung, không
  // phải 1 vật thể rời rạc đáng dựng riêng.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !segments || segments.length === 0) return;
    let cancelled = false;
    (async () => {
      const bboxes = await Promise.all(segments.map((s) => computeMaskBBox(s.maskUrl)));
      if (cancelled) return;
      const sc = sceneRef.current;
      if (!sc) return;
      sc.children.filter((c) => c.userData.isLocationBlock).forEach((c) => sc.remove(c));
      for (const bbox of bboxes) {
        if (!bbox) continue;
        const widthFrac = bbox.maxX - bbox.minX;
        const heightFrac = bbox.maxY - bbox.minY;
        if (widthFrac > 0.85 && heightFrac > 0.85) continue; // gần phủ kín khung -> bỏ qua
        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;
        const worldX = (cx - 0.5) * 5;
        const worldZ = -(1 - cy) * 5;
        const isGroundLike = widthFrac > 0.4 && heightFrac < 0.25 && bbox.maxY > 0.55;
        if (isGroundLike) {
          const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(Math.max(0.5, widthFrac * 6), Math.max(0.5, heightFrac * 6)),
            new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 1, transparent: true, opacity: 0.4 })
          );
          plane.rotation.x = -Math.PI / 2;
          plane.position.set(worldX, 0.02, worldZ);
          plane.userData.isLocationBlock = true;
          sc.add(plane);
        } else {
          const height = Math.max(1, heightFrac * 6);
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(Math.max(0.3, widthFrac * 5), height, 0.8),
            new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9, transparent: true, opacity: 0.55 })
          );
          mesh.position.set(worldX, height / 2, worldZ);
          mesh.userData.isLocationBlock = true;
          sc.add(mesh);
        }
      }
      forceRerender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [segments]);

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
