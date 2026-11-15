-- Normalize legacy model avatar types before the application applies stricter
-- comparisons. Both values are valid app-level identifiers.
UPDATE public.profiles
SET model_icon_type = lower(btrim(model_icon_type))
WHERE model_icon_type IS NOT NULL
  AND model_icon_type <> lower(btrim(model_icon_type));

-- New chat attachments live in their own private bucket. The application
-- serves them through the owner-scoped /api/chat-image route.
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'chat-images',
  'chat-images',
  false,
  8388608,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Avatars are now uploaded, read, replaced, and removed through authenticated
-- server routes. Prevent the bucket from serving objects publicly.
UPDATE storage.buckets
SET public = false,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY[
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/avif'
    ]::text[]
WHERE id = 'avatars';
