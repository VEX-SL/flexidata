-- Migration: Add model icon columns to profiles table
-- Run this in Supabase Dashboard > SQL Editor

ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS model_icon TEXT,
ADD COLUMN IF NOT EXISTS model_icon_type TEXT CHECK (model_icon_type IN ('preset', 'custom'));

-- Optional: Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_profiles_model_icon ON public.profiles(model_icon);