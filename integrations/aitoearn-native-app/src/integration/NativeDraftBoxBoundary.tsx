"use client"
import dynamic from 'next/dynamic'
const DraftBoxCore = dynamic(() => import('@/app/[lng]/draft-box/DraftBoxCore'), { ssr: false })
export default function NativeDraftBoxBoundary() { return <DraftBoxCore /> }
