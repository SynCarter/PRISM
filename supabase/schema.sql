-- ==============================================================================
-- PRISM: Supabase Database Schema & Storage Configuration
-- Run this script in the Supabase SQL Editor (Dashboard -> SQL Editor)
-- ==============================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Sessions Table (tracks anonymous user sessions)
CREATE TABLE IF NOT EXISTS public.sessions (
    session_id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Projects Table
CREATE TABLE IF NOT EXISTS public.projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT REFERENCES public.sessions(session_id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. Uploaded Images Table
CREATE TABLE IF NOT EXISTS public.uploaded_images (
    image_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 5. Reconstruction Jobs Table (monitored live via Supabase Realtime & polling)
CREATE TABLE IF NOT EXISTS public.reconstruction_jobs (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
    stage TEXT DEFAULT 'Image Ingestion',   -- downloading, colmap, training, exporting, done
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 6. Reconstructed Models Table
CREATE TABLE IF NOT EXISTS public.reconstructed_models (
    model_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL UNIQUE REFERENCES public.projects(project_id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    file_format TEXT DEFAULT 'spz',
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 7. Indexes for Query Performance
CREATE INDEX IF NOT EXISTS idx_projects_session ON public.projects(session_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_images_project ON public.uploaded_images(project_id);
CREATE INDEX IF NOT EXISTS idx_reconstruction_jobs_project ON public.reconstruction_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_reconstruction_jobs_status_created ON public.reconstruction_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reconstructed_models_project ON public.reconstructed_models(project_id);

-- 8. Enable Supabase Realtime for Live Reconstruction Stepper
ALTER PUBLICATION supabase_realtime ADD TABLE public.reconstruction_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;

-- 9. Storage Bucket: project-images
INSERT INTO storage.buckets (id, name, public)
VALUES ('project-images', 'project-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 10. Row Level Security (RLS) Policies
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uploaded_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconstruction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconstructed_models ENABLE ROW LEVEL SECURITY;

-- Allow public anonymous access for app demo operations
CREATE POLICY "Public full access on sessions" ON public.sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access on projects" ON public.projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access on uploaded_images" ON public.uploaded_images FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access on reconstruction_jobs" ON public.reconstruction_jobs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access on reconstructed_models" ON public.reconstructed_models FOR ALL USING (true) WITH CHECK (true);

-- Allow public / anon access to storage bucket project-images
CREATE POLICY "Public Access on project-images bucket" ON storage.objects
    FOR ALL
    USING (bucket_id = 'project-images')
    WITH CHECK (bucket_id = 'project-images');
