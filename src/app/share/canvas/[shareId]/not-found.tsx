import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { AppRouteShell } from "@/components/app-route-shell";
import styles from "@/features/official-inspiration/canvas-share-showcase.module.css";

export default function CanvasShareNotFound() {
  return (
    <AppRouteShell>
      <section className={styles.notFound}>
        <span><FileQuestion size={30} /></span>
        <h1>这个公开画布不存在</h1>
        <p>主站目前没有公共画布持久化接口，因此只展示明确内置的原创示例，不会根据任意 ID 编造用户数据。</p>
        <Link href="/inspiration"><ArrowLeft size={15} />返回灵感广场</Link>
      </section>
    </AppRouteShell>
  );
}
