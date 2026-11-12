import { createRef, useCallback, useRef } from 'react'
import type { RefObject } from 'react'

/** TransitionGroup retains leaving children: each stable key must retain its own DOM ref. */
export function useTransitionNodeRefs<T extends HTMLElement>() {
  const nodes = useRef(new Map<string, RefObject<T | null>>())
  return useCallback((key: string) => {
    let node = nodes.current.get(key)
    if (!node) {
      node = createRef<T>()
      nodes.current.set(key, node)
    }
    return node
  }, [])
}
