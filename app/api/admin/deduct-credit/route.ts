import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";
import { deductCreditAdmin } from "@/lib/credit-system";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

// POST /api/admin/deduct-credit — nút "Thu" ở bảng "Người dùng gần đây" trong /admin, chiều ngược của
// /api/admin/grant-credit. Dùng lại RPC deduct_credit() đã có sẵn, không cho trừ quá số dư hiện có.
export async function POST(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!(await verifyAdminToken(token))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { userId, amount } = await req.json();
  if (typeof userId !== "string" || !userId.trim()) {
    return Response.json({ error: "Thiếu userId" }, { status: 400 });
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: "Số credit không hợp lệ" }, { status: 400 });
  }

  try {
    const newBalance = await deductCreditAdmin(userId, Math.floor(amount));
    return Response.json({ success: true, newBalance });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
