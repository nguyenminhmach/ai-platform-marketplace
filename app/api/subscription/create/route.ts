import { getSupabaseAdmin } from "@/lib/supabase";
import { generateVietQRUrl } from "@/lib/sepay";

export async function POST(req: Request) {
  const { userId } = await req.json();

  if (!userId) {
    return Response.json({ error: "Thiếu userId" }, { status: 400 });
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

  const { data: settings } = await supabase
    .from("site_settings")
    .select("subscription_enabled, subscription_price_vnd, subscription_duration_days")
    .eq("id", 1)
    .single();

  if (!settings?.subscription_enabled) {
    return Response.json({ error: "Gói không giới hạn hiện chưa mở" }, { status: 403 });
  }

  const amountVnd = settings.subscription_price_vnd;
  const durationDays = settings.subscription_duration_days;

  const { data: inserted, error: insertError } = await supabase
    .from("subscription_orders")
    .insert({
      order_code: "PENDING",
      user_id: userId,
      amount_vnd: amountVnd,
      duration_days: durationDays,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    return Response.json({ error: insertError?.message ?? "Không tạo được đơn gia hạn" }, { status: 500 });
  }

  const orderCode = `GS${String(inserted.id).padStart(6, "0")}`;

  const { error: updateError } = await supabase
    .from("subscription_orders")
    .update({ order_code: orderCode })
    .eq("id", inserted.id);

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  const qrUrl = generateVietQRUrl({
    accountNumber,
    bank,
    amount: amountVnd,
    content: orderCode,
    template: "compact",
  });

  return Response.json({
    orderCode,
    amountVnd,
    durationDays,
    bankName: bank,
    accountNumber,
    qrUrl,
  });
}
