import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";
import { grantCreditAdmin } from "@/lib/credit-system";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

// POST /api/admin/grant-credit — nút "Cấp credit" ở bảng "Người dùng gần đây" trong /admin. Dùng type
// "bonus" (xem grantCreditAdmin) — không phải nạp tiền thật, không ảnh hưởng số liệu doanh thu
// (totalRevenueVnd/totalCreditsSold tính từ topup_orders, không đụng tới credit_transactions).
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
    await grantCreditAdmin(userId, Math.floor(amount));
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
