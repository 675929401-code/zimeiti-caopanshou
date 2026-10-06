import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { authorizeAdminToken } from '@/lib/admin-auth';
import { getTokenFromHeaders } from '@/lib/auth';

export default async function RetiredCommerceSettingsPage(){
  const authorization=await authorizeAdminToken(getTokenFromHeaders(new Headers(await headers())));
  if(!authorization.ok)notFound();
  redirect('/admin?tab=commerce');
}
