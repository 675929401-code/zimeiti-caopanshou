type ShowcaseKind = "tv" | "horizon";

/**
 * Keep the established route-facing API while loading only the leaf module
 * selected by the App Router server render. The inspiration catalog therefore
 * stays exclusive to the TV route and never enters the horizon or navigation
 * dependency graph.
 */
export async function PublicShowcasePage({ kind }: { kind: ShowcaseKind }) {
  if (kind === "tv") {
    const { OfficialTvPage } = await import("./official-tv-page");
    return <OfficialTvPage />;
  }

  const { OfficialHorizonPage } = await import("./official-horizon-page");
  return <OfficialHorizonPage />;
}

export async function ResourceNavigationPage() {
  const { OfficialResourceNavigationPage } = await import("./official-resource-navigation-page");
  return <OfficialResourceNavigationPage />;
}
