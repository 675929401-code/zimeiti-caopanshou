import { NATIVE_PRODUCT_NAME } from '@/integration/host-branding-contract'

export async function getPageTitle(name: string, _lng: string) {
  void _lng
  const brand = typeof document === 'undefined' ? NATIVE_PRODUCT_NAME : document.documentElement.dataset.nativeBrandName || NATIVE_PRODUCT_NAME
  return name ? `${brand} - ${name}` : brand
}
