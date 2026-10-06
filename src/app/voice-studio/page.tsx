/**
 * 智音工坊入口 — 重定向到工作台
 */
import { redirect } from 'next/navigation';

export default function VoiceStudioPage() {
  redirect('/voice-studio/workspace');
}
