-- Display names are capped at 25 characters (live max was 25 when applied).
-- Schema already applied via MCP. Do NOT run supabase db push.
ALTER TABLE public.users ADD CONSTRAINT users_display_name_max25 CHECK (char_length(display_name) <= 25);
