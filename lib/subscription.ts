import { getSupabaseAdmin } from "@/lib/supabase";

export type SubscriptionInfo = { active: boolean; expiresAt: string | null };

export async function getSubscriptionInfo(userId: string): Promise<SubscriptionInfo> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("subscriptions")
    .select("expires_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { active: false, expiresAt: null };
  const active = new Date(data.expires_at).getTime() > Date.now();
  return { active, expiresAt: data.expires_at };
}

export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const info = await getSubscriptionInfo(userId);
  return info.active;
}
