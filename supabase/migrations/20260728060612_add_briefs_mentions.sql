-- Adds mentions to briefs, mirroring public.comments.mentions.
-- Stores an array of mentioned user ids as jsonb. Nullable, no default.
-- Already applied to the live database; this file records it for migration history.
alter table public.briefs add column if not exists mentions jsonb;
