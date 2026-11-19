"use client";

import { useEffect, useRef } from "react";
import { useApp } from "@/contexts/app-context";
import { readPaymentWallet, subscribePaymentWallet } from "@/lib/payment-wallet-client";

export function PaymentWalletSync() {
  const { state, dispatch } = useApp();
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    let mounted = true;
    const off = subscribePaymentWallet(async id => {
      const { token, user } = latest.current.auth;
      if (!token || user?.id !== id) return;
      const balance = await readPaymentWallet(token);
      const current = latest.current;
      if (!mounted || !balance || current.auth.token !== token || current.auth.user?.id !== id) return;
      dispatch({ type: "SET_CREDITS", payload: { ...current.credits, total: balance.credits, used: 0, remaining: balance.credits } });
      dispatch({ type: "SET_CASH_BALANCE", payload: balance.cashBalance });
      if (current.auth.user.credits !== balance.credits) {
        dispatch({ type: "SET_AUTH", payload: { token, user: { ...current.auth.user, credits: balance.credits } } });
      }
    });
    return () => { mounted = false; off(); };
  }, [dispatch]);
  return null;
}
