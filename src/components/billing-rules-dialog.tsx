"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Coins } from "lucide-react";

interface BillingRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BillingRulesDialog({ open, onOpenChange }: BillingRulesDialogProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-[440px]">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Coins className="h-5 w-5" />积分使用规则</DialogTitle></DialogHeader>
      <p className="text-sm">对话按实际 Token 用量结算，缓存命中的输入单独计算。每次实际扣款和余额可在个人中心的交易记录中查看。</p>
    </DialogContent>
  </Dialog>;
}
