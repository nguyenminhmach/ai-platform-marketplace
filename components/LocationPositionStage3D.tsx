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
  // Ảnh độ sâu Fal trả về (xem nút "Dựng khối 3D" ở VideoTuYTuongClient.tsx) — tuỳ chọn, nếu chưa gọi
  // hoặc chưa xong thì khung 3D vẫn hiển thị bình thường (chỉ mannequin + phông ảnh phẳng), không chặn
  // gì cả. Khi có, dựng thành 1 LƯỚI ĐỊA HÌNH lồi lõm (heightmap mesh) — xem buildTerrainGeometry bên
  // dưới. SỬA (phản hồi thật user lần 2): bỏ hẳn khối hộp vuông vức dựng từ phân vùng (segments) — địa
  // hình tự nhiên lồi lõm hợp lý hơn, và không cần gọi thêm AI phân vùng nữa (chỉ cần ảnh độ sâu đã có).
  depthImageUrl?: string | null;
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

// Đọc ảnh độ sâu (Midas — càng sáng càng gần máy ảnh) bằng canvas, dựng 1 lưới điểm (heightmap) — mỗi
// điểm có toạ độ world (x, z) tính từ vị trí trên ảnh (y: trên ảnh (0, xa)->dưới ảnh (1, gần), x: trái
// (0)->phải (1), ĐÚNG công thức world-mapping đã dùng cho nhân vật, để lưới địa hình và nhân vật nằm
// cùng 1 hệ toạ độ) và chiều cao (world y) tính từ độ sáng tại đúng điểm đó trên ảnh độ sâu — vùng gần
// (sáng) nhô cao hơn, vùng xa (tối) thấp hơn, cho cảm giác lồi lõm thật thay vì khối hộp phẳng lì.
async function buildTerrainGeometry(depthUrl: string, gridW = 36, gridH = 22): Promise<THREE.BufferGeometry | null> {
  try {
    const img = await loadImageEl(depthUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const positions = new Float32Array(gridW * gridH * 3);
    for (let iy = 0; iy < gridH; iy++) {
      for (let ix = 0; ix < gridW; ix++) {
        const u = ix / (gridW - 1);
        const v = iy / (gridH - 1);
        const px = Math.min(canvas.width - 1, Math.floor(u * (canvas.width - 1)));
        const py = Math.min(canvas.height - 1, Math.floor(v * (canvas.height - 1)));
        const brightness = data[(py * canvas.width + px) * 4] / 255;
        const worldX = (u - 0.5) * 5;
        const worldZ = -(1 - v) * 5;
        const worldY = brightness * 2.4;
        const vi = (iy * gridW + ix) * 3;
        positions[vi] = worldX;
        positions[vi + 1] = worldY;
        positions[vi + 2] = worldZ;
      }
    }
    const indices: number[] = [];
    for (let iy = 0; iy < gridH - 1; iy++) {
      for (let ix = 0; ix < gridW - 1; ix++) {
        const a = iy * gridW + ix;
        const b = a + 1;
        const c = a + gridW;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  } catch {
    return null; // ảnh độ sâu lỗi/không tải được (CORS, 404...) — bỏ qua, khung 3D vẫn hiện mannequin bình thường
  }
}

// Xem trước 3D NHIỀU nhân vật cùng lúc, đặt đúng vị trí tương đối đã chọn trên ảnh bối cảnh 2D — mở
// rộng từ components/MannequinPreviewCard.tsx (vốn chỉ có 1 mannequin xoay tại chỗ). Khác biệt chính:
// (1) nhiều mannequin, mỗi cái nhân bản từ CÙNG 1 hình buildMannequin() (xem mục 18.3 kế hoạch đã lưu
// memory — không cần tạo model mới cho từng người), đặt vào world-position tính từ x/y; (2) khách kéo
// xoay CAMERA quanh cả cảnh (orbit) thay vì xoay từng mannequin riêng — vì giờ có nhiều vật thể, xoay
// riêng từng cái sẽ rối; (3) ảnh bối cảnh vẫn chỉ là phông CSS phẳng phía sau (chưa dùng khối 3D thật
// từ Fal depth/segment — đó là lớp nâng cấp sau, xem nút "Dựng khối 3D" đã gọi nhưng chưa render).
export function LocationPositionStage3D({ characters, depthImageUrl }: Props) {
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

  // Dựng lưới địa hình (heightmap) từ ảnh độ sâu — thay cho khối hộp vuông vức trước đây, cho hình
  // dạng lồi lõm giống địa hình thật (núi/vách đá nhô ra, chỗ xa lõm vào) thay vì khối chữ nhật phẳng
  // lì. Vẽ cả mặt đặc (mờ) lẫn khung dây (wireframe) đè lên — khớp đúng kiểu "low-poly wireframe" đã
  // tham khảo, dễ nhìn rõ hình khối khi xoay.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !depthImageUrl) return;
    let cancelled = false;
    (async () => {
      const geo = await buildTerrainGeometry(depthImageUrl);
      if (cancelled || !geo) return;
      const sc = sceneRef.current;
      if (!sc) return;
      sc.children.filter((c) => c.userData.isLocationBlock).forEach((c) => sc.remove(c));

      // Màu xám trung tính + flatShading (mỗi mặt tam giác giữ phẳng, không làm mượt) — đúng phong cách
      // "low-poly" tham khảo (núi xám nhiều mặt, không phải màu mè trong suốt như bản trước).
      const solid = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide })
      );
      solid.userData.isLocationBlock = true;
      sc.add(solid);

      const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x374151, wireframe: true }));
      wire.userData.isLocationBlock = true;
      sc.add(wire);

      forceRerender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [depthImageUrl]);

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
      style={{ cursor: "grab" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div ref={mountRef} className="absolute inset-0" />
      <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">🔄 Kéo để xoay xem</span>
    </div>
  );
}
