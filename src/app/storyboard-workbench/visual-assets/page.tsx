import { Suspense } from "react";
import { StoryboardWorkbench } from "@/components/storyboard-workbench";
import "../storyboard-workbench.css";
import "./visual-assets-page.css";
export default function StoryboardVisualAssetsPage(){return <Suspense fallback={<p>正在加载角色参考…</p>}><StoryboardWorkbench view="visual-assets" /></Suspense>;}
