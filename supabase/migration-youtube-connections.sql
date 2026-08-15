-- Migration: lưu token OAuth YouTube của từng user để đăng video thẳng từ app lên kênh YouTube của họ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create table if not exists youtube_connections (
  user_id uuid primary key references user_profiles(user_id),
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  channel_title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS deny-all mặc định (giống các bảng khác) — chỉ backend (service_role key) thao tác trực tiếp được.
-- Token OAuth là dữ liệu nhạy cảm, tuyệt đối không để lộ qua client-side query.
alter table youtube_connections enable row level security;

create or replace function set_youtube_connection_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_youtube_connections_updated_at on youtube_connections;
create trigger trg_youtube_connections_updated_at
  before update on youtube_connections
  for each row execute function set_youtube_connection_updated_at();
