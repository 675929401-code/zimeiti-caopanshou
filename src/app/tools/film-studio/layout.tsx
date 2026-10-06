import type { ReactNode } from "react";
import { AppRouteShell } from "@/components/app-route-shell";
import styles from "@/app/short-drama/short-drama.module.css";

export default function FilmStudioLayout({ children }: { children: ReactNode }) {
  return (
    <AppRouteShell className={styles.appShell}>
      {children}
    </AppRouteShell>
  );
}
