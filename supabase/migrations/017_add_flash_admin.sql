-- marvintlc - Migration 017
-- Promote existing user anomflash@gmail.com to super_admin

INSERT INTO public.admin_users (email, password_hash, full_name, role_id, status)
SELECT
  'anomflash@gmail.com',
  au.encrypted_password,
  COALESCE(p.full_name, 'Flash Admin'),
  ar.id,
  'active'
FROM auth.users au
JOIN public.admin_roles ar ON ar.name = 'super_admin'
LEFT JOIN public.profiles p ON p.email = au.email
WHERE au.email = 'anomflash@gmail.com'
ON CONFLICT (email) DO UPDATE SET
  role_id = EXCLUDED.role_id,
  status = 'active',
  full_name = EXCLUDED.full_name;
