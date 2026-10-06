import { redirect } from "next/navigation";

export type LegacyFilmStudioCreatePageProps = {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function redirectLegacyFilmStudioCreatePage(
  searchParamsPromise: LegacyFilmStudioCreatePageProps["searchParams"],
  canonicalPath: `/youcai/tools/text/${string}`,
): Promise<never> {
  const searchParams = await searchParamsPromise;
  const query = new URLSearchParams();
  for (const [name, rawValue] of Object.entries(searchParams)) {
    if (Array.isArray(rawValue)) {
      rawValue.forEach((value) => query.append(name, value));
    } else if (typeof rawValue === "string") {
      query.set(name, rawValue);
    }
  }
  const serialized = query.toString();
  redirect(serialized ? `${canonicalPath}?${serialized}` : canonicalPath);
}
