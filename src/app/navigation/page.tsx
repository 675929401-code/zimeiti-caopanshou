import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function MainSiteLegacyRoute() {
  redirect("/youcai");
}
