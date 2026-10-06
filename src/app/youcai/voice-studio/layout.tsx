import "@/app/voice-studio/voice-studio.css";
import "@/app/voice-studio/voice-studio-global.css";
import VoiceStudioHeader from "@/components/vs/Header";
import VoiceStudioFooter from "@/components/vs/Footer";
import GlobalTaskBar from "@/components/vs/GlobalTaskBar";

export default function YoucaiVoiceStudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="voice-studio-root">
      <VoiceStudioHeader />
      <GlobalTaskBar />
      <main className="flex-1">{children}</main>
      <VoiceStudioFooter />
    </div>
  );
}
