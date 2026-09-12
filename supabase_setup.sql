-- =========================================================================
-- Prompt Challenge — Supabase Storage Setup Script
-- =========================================================================
-- Chạy script này trong Supabase Dashboard -> SQL Editor
-- Script này sẽ đảm bảo bucket 'gallery' tồn tại, công khai, và cấp quyền
-- upload/download cho role anon (người dùng web) nếu không dùng service_role key.
-- =========================================================================

-- 1. Tạo hoặc cập nhật bucket 'gallery' thành public
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gallery',
  'gallery',
  true,
  20971520, -- 20MB limit
  ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 20971520,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

-- 2. Xóa các policy cũ của gallery nếu đã tồn tại để tránh xung đột
DROP POLICY IF EXISTS "Public Select Gallery" ON storage.objects;
DROP POLICY IF EXISTS "Public Insert Gallery" ON storage.objects;
DROP POLICY IF EXISTS "Public Update Gallery" ON storage.objects;
DROP POLICY IF EXISTS "Public Delete Gallery" ON storage.objects;

-- 3. Tạo policy cho phép mọi người (anon & authenticated) XEM / TẢI ảnh từ gallery
CREATE POLICY "Public Select Gallery"
ON storage.objects FOR SELECT
TO anon, authenticated, public
USING (bucket_id = 'gallery');

-- 4. Tạo policy cho phép mọi người (anon & authenticated) TẢI LÊN ảnh vào gallery
CREATE POLICY "Public Insert Gallery"
ON storage.objects FOR INSERT
TO anon, authenticated, public
WITH CHECK (bucket_id = 'gallery');

-- 5. Tạo policy cho phép GHI ĐÈ / CẬP NHẬT ảnh (upsert) trong gallery
CREATE POLICY "Public Update Gallery"
ON storage.objects FOR UPDATE
TO anon, authenticated, public
USING (bucket_id = 'gallery');

-- 6. Tạo policy cho phép XÓA ảnh trong gallery (tùy chọn)
CREATE POLICY "Public Delete Gallery"
ON storage.objects FOR DELETE
TO anon, authenticated, public
USING (bucket_id = 'gallery');
