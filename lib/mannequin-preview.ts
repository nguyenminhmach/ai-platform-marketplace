import * as THREE from "three";

// Hình người 3D CHUNG CHUNG (không phải mặt/thân thật của nhân vật) dùng cho khối "Xem trước bố cục
// miễn phí" (story-video) — chỉ để khách hình dung ĐÚNG HƯỚNG nhân vật đứng/nhìn trong khung cảnh, xoay
// theo đúng "camera_view" Agent đã chọn khi chia cảnh (front/three_quarter_left/three_quarter_right/
// side/back/face — cùng 6 giá trị dùng để cắt ảnh Character thật, xem lib/story-video.ts). Không gọi
// AI, không tốn credit — dựng bằng Three.js (client-side, chạy 1 lần, cache lại 6 hướng).
const MANNEQUIN_ROTATION_Y: Record<string, number> = {
  front: 0,
  face: 0,
  three_quarter_right: Math.PI / 4,
  three_quarter_left: -Math.PI / 4,
  side: Math.PI / 2,
  back: Math.PI,
};

const SPRITE_W = 220;
const SPRITE_H = 440;

function buildMannequin(): THREE.Group {
  const group = new THREE.Group();
  const bodyColor = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.85, metalness: 0.05 });
  const markerColor = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.85, metalness: 0.05 });

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), bodyColor);
  head.position.y = 3.3;
  group.add(head);

  // Chấm tối nhỏ ở mặt trước đầu — dấu hiệu duy nhất để phân biệt "đang quay mặt hướng nào", vì
  // mannequin không có mắt/mũi/miệng thật.
  const faceMarker = new THREE.Mesh(new THREE.CircleGeometry(0.15, 16), markerColor);
  faceMarker.position.set(0, 3.3, 0.49);
  group.add(faceMarker);

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.5, 1.6, 20), bodyColor);
  torso.position.y = 2.2;
  group.add(torso);

  const legGeo = new THREE.CylinderGeometry(0.22, 0.18, 1.8, 16);
  const legLeft = new THREE.Mesh(legGeo, bodyColor);
  legLeft.position.set(-0.3, 0.9, 0);
  group.add(legLeft);
  const legRight = new THREE.Mesh(legGeo, bodyColor);
  legRight.position.set(0.3, 0.9, 0);
  group.add(legRight);

  const armGeo = new THREE.CylinderGeometry(0.15, 0.13, 1.5, 16);
  const armLeft = new THREE.Mesh(armGeo, bodyColor);
  armLeft.position.set(-0.85, 2.15, 0);
  armLeft.rotation.z = 0.12;
  group.add(armLeft);
  const armRight = new THREE.Mesh(armGeo, bodyColor);
  armRight.position.set(0.85, 2.15, 0);
  armRight.rotation.z = -0.12;
  group.add(armRight);

  return group;
}

let cachedSprites: Record<string, string> | null = null;

// Dựng sẵn cả 6 hướng 1 lần (không phụ thuộc scene nào) rồi cache lại — mọi cảnh dùng chung 6 ảnh này,
// chỉ khác cách đặt vị trí/tỉ lệ trên Canvas 2D (xem renderScenePreviewComposite ở page.tsx).
export function renderMannequinSprites(): Record<string, string> {
  if (cachedSprites) return cachedSprites;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SPRITE_W, SPRITE_H);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(1, 2, 3);
  scene.add(dirLight);

  const mannequin = buildMannequin();
  scene.add(mannequin);

  const camera = new THREE.PerspectiveCamera(28, SPRITE_W / SPRITE_H, 0.1, 100);
  camera.position.set(0, 2.1, 7.5);
  camera.lookAt(0, 2.0, 0);

  const sprites: Record<string, string> = {};
  for (const [view, rotationY] of Object.entries(MANNEQUIN_ROTATION_Y)) {
    mannequin.rotation.y = rotationY;
    renderer.render(scene, camera);
    sprites[view] = renderer.domElement.toDataURL("image/png");
  }

  renderer.dispose();
  cachedSprites = sprites;
  return sprites;
}
