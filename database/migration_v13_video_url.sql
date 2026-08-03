-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v13 — Suporte a vídeos do YouTube
-- ─────────────────────────────────────────────────────────────────────────────

-- Catálogo de itens (tabela real usada pelo catalog.ts é 'products')
ALTER TABLE products     ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS video_url TEXT;

-- Anúncios do SuperAdmin
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS video_url TEXT;
