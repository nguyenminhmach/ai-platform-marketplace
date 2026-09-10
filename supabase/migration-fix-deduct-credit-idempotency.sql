-- Fix: deduct_credit() không thực sự idempotent -- khi cùng 1 idempotency_key được gọi lại lần 2
-- (webhook retry, khách bấm lại nút, race condition), function chỉ INSERT thẳng và để lỗi unique
-- constraint "credit_transactions_idempotency_key_key" của Postgres ném ra ngoài. Lỗi Postgres thô
-- đó lộ thẳng ra UI cho khách thấy (do route đã đổi sang surface real error message thay vì fallback
-- chung). Sửa: SELECT trước để phát hiện key đã xử lý rồi thì trả lại đúng kết quả cũ, không trừ
-- credit lần 2, không ném lỗi; thêm khối EXCEPTION bắt riêng unique_violation làm lưới an toàn cho
-- race hiếm (2 lượt gọi cùng lúc cùng vượt qua được SELECT trước khi lượt nào INSERT xong).
create or replace function deduct_credit(
  p_user_id uuid,
  p_amount integer,
  p_mini_app_id text,
  p_idempotency_key text
) returns table(success boolean, new_balance integer, tx_id bigint) as $$
declare
  v_current_balance integer;
  v_tx_id bigint;
  v_existing_id bigint;
begin
  select id into v_existing_id from credit_transactions where idempotency_key = p_idempotency_key;
  if v_existing_id is not null then
    select credit_balance into v_current_balance from user_profiles where user_id = p_user_id;
    return query select true, v_current_balance, v_existing_id;
    return;
  end if;

  select credit_balance into v_current_balance
  from user_profiles
  where user_id = p_user_id
  for update;

  if v_current_balance is null then
    return query select false, 0, null::bigint;
    return;
  end if;

  if v_current_balance < p_amount then
    return query select false, v_current_balance, null::bigint;
    return;
  end if;

  begin
    insert into credit_transactions (user_id, amount, type, mini_app_id, idempotency_key)
    values (p_user_id, -p_amount, 'usage', p_mini_app_id, p_idempotency_key)
    returning id into v_tx_id;
  exception when unique_violation then
    select id into v_tx_id from credit_transactions where idempotency_key = p_idempotency_key;
    select credit_balance into v_current_balance from user_profiles where user_id = p_user_id;
    return query select true, v_current_balance, v_tx_id;
    return;
  end;

  update user_profiles set credit_balance = credit_balance - p_amount
  where user_id = p_user_id;

  return query select true, v_current_balance - p_amount, v_tx_id;
end;
$$ language plpgsql;
