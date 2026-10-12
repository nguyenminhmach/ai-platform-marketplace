-- Thư viện ảnh "Tải lên" trong modal +/@ ở app/video-tu-y-tuong — xem lib/prompt-uploads.ts

create table if not exists prompt_uploads (
  id bigserial primary key,
  user_id uuid not null,
  url text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_prompt_uploads_user on prompt_uploads(user_id, created_at desc);

alter table prompt_uploads enable row level security;
