import { redirect } from "next/navigation";

export default function CanvasEntryPage() {
  redirect("/storyboard-workbench?legacy=canvas-entry");
}
