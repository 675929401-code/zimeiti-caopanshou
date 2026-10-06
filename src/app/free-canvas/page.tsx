import { redirect } from "next/navigation";

export default function FreeCanvasPage() {
  redirect("/storyboard-workbench?legacy=free-canvas");
}
