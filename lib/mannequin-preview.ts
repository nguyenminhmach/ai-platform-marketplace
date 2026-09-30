import * as THREE from "three";

// Hình người 3D CHUNG CHUNG (không phải mặt/thân thật của nhân vật) dùng cho khối "Xem trước bố cục
// miễn phí" (story-video) — chỉ để khách hình dung ĐÚNG HƯỚNG nhân vật đứng/nhìn trong khung cảnh.
// Trước đây render sẵn 6 ảnh tĩnh theo cameraView; giờ dùng trực tiếp trong component tương tác
// (components/MannequinPreviewCard.tsx) — khách kéo chuột xoay tự do, không chỉ xem đúng 6 góc cố định.
export const MANNEQUIN_ROTATION_Y: Record<string, number> = {
  front: 0,
  face: 0,
  three_quarter_right: Math.PI / 4,
  three_quarter_left: -Math.PI / 4,
  side: Math.PI / 2,
  back: Math.PI,
};

export function buildMannequin(): THREE.Group {
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

// Khách kéo chuột xoay tự do (radian bất kỳ) — khi bấm "Chọn góc này", quy tròn về 1 trong 6 giá trị
// cameraView chuẩn gần nhất (dùng để lưu lại, vì hệ thống tạo ảnh thật chỉ hiểu 6 giá trị này, không
// hiểu góc độ tự do). "side" không phân biệt trái/phải (chỉ có 1 giá trị "side" trong hệ thống hiện tại)
// nên cả +90° lẫn -90° đều quy về "side"; tương tự "back" nhận cả +180°/-180°.
export function nearestCameraView(rotationY: number): string {
  let a = rotationY % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  const candidates: [string, number][] = [
    ["front", 0],
    ["three_quarter_right", Math.PI / 4],
    ["three_quarter_left", -Math.PI / 4],
    ["side", Math.PI / 2],
    ["side", -Math.PI / 2],
    ["back", Math.PI],
    ["back", -Math.PI],
  ];
  let best = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    let d = Math.abs(a - c[1]);
    if (d > Math.PI) d = Math.PI * 2 - d;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best[0];
}
