import { getSupabaseAdmin } from "@/lib/supabase";
import { generateVietQRUrl } from "@/lib/sepay";
import { CREDIT_PACKAGES } from "@/lib/mock-wallet";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function POST(req: Request) {
  const { packageId } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!packageId) {
    return Response.json({ error: "Thiếu packageId" }, { status: 400 });
  }

  const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) {
    return Response.json({ error: "Gói credit không hợp lệ" }, { status: 400 });
  }

  const bank = process.env.SEPAY_BANK_NAME;
  const accountNumber = process.env.SEPAY_BANK_ACCOUNT_NUMBER;
  if (!bank || !accountNumber) {
    return Response.json(
      { error: "Chưa cấu hình tài khoản ngân hàng Sepay (SEPAY_BANK_NAME / SEPAY_BANK_ACCOUNT_NUMBER)" },
      { status: 500 }
    );
  }

  const supabase = getSupabaseAdmin();

  // Tạo trước để lấy id, rồi build order_code dạng DH000001 (đúng quy ước repo)
  const { data: inserted, error: insertError } = await supabase
    .from("topup_orders")
    .insert({
      order_code: "PENDING",
      user_id: userId,
      package_id: pkg.id,
      credits: pkg.credits,
      amount_vnd: pkg.priceVnd,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    return Response.json({ error: insertError?.message ?? "Không tạo được đơn hàng" }, { status: 500 });
  }

  const orderCode = `DH${String(inserted.id).padStart(6, "0")}`;

  const { error: updateError } = await supabase
    .from("topup_orders")
    .update({ order_code: orderCode })
    .eq("id", inserted.id);

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  const qrUrl = generateVietQRUrl({
    accountNumber,
    bank,
    amount: pkg.priceVnd,
    content: orderCode,
    template: "compact",
  });

  return Response.json({
    orderCode,
    credits: pkg.credits,
    amountVnd: pkg.priceVnd,
    bankName: bank,
    accountNumber,
    qrUrl,
  });
}
