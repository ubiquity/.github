-- Unified Authentication Identity Mapping Schema for Supabase
CREATE TABLE IF NOT EXISTS public.user_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_user_id TEXT UNIQUE NOT NULL,
    github_username TEXT NOT NULL,
    google_email TEXT,
    google_drive_linked BOOLEAN DEFAULT FALSE,
    telegram_user_id TEXT,
    telegram_username TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_identities_github ON public.user_identities(github_user_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_telegram ON public.user_identities(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_google ON public.user_identities(google_email);
