import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { AppRouteShell } from "@/components/app-route-shell";
import styles from "@/features/official-inspiration/canvas-share-showcase.module.css";

export default function CanvasShareNotFound() {
  return (
    <AppRouteShell>
      <section className={styles.notFound}>
        <span><FileQuestion size={30} /></span>
        <h1>这个公开画布不存在</h1>
        <p>该画布可能已被删除、设为私密，或分享链接已失效。</p>
        <Link href="/inspiration"><ArrowLeft size={15} />返回灵感广场</Link>
      </section>
    </AppRouteShell>
  );
}
