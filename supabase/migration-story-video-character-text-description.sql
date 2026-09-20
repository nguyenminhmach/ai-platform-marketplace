alter table story_video_jobs add column if not exists character_appearance_description text;
alter table story_video_job_characters add column if not exists appearance_description text;
