import { AppScopedLink } from "@/components/app-scoped-link";
import styles from "./official-public-pages.module.css";

export function PublicFooter({ overlay = false }: { overlay?: boolean }) {
  return (
    <footer className={overlay ? styles.overlayFooter : styles.footer}>
      <span>© 2026 漫剧工作台</span>
      <span aria-hidden="true">·</span>
      <AppScopedLink href="/about">关于我们</AppScopedLink>
      <span aria-hidden="true">·</span>
      <AppScopedLink href="/business">商务合作</AppScopedLink>
    </footer>
  );
}
