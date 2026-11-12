'use client'

import { Suspense, useEffect, useState, type ReactNode } from 'react'

/** Same client-mount boundary as the original NoSSR consumer, using the host
 * React runtime instead of a dependency with an embedded React 18 JSX runtime. */
export function NativeClientOnly({ children, loading }: { children?: ReactNode, loading?: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  return mounted ? <Suspense fallback={loading}>{children}</Suspense> : null
}
