import type { CreditsSubmitControlProps } from '../../types'
import { ArrowUp, Loader2 } from 'lucide-react'
import { cn } from '@/utils/className'

export function CreditsSubmitControl({
  isLoading,
  generationReady = false,
  billingLabel,
  onSubmit,
}: CreditsSubmitControlProps) {
  return (
    <button
      data-testid="draftbox-ai-submit-btn"
      type="button"
      className={cn(
        'flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/90',
        (isLoading || !generationReady) && 'pointer-events-none opacity-60',
      )}
      disabled={isLoading || !generationReady}
      title={generationReady ? billingLabel || '确认使用主站人民币钱包生成' : '主站报价或生成接入尚未就绪，目录仍可查看'}
      aria-label="确认使用主站模型生成"
      onClick={onSubmit}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <ArrowUp className="h-4 w-4" />
      )}
    </button>
  )
}
