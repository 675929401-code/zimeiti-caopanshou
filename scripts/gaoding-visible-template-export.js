/*
 * Safe DOM-only exporter for a normally opened gaoding.com template page.
 * It reads only visible card text, links, public image URLs and explicit
 * data attributes. It never reads cookies/storage or replays API requests.
 */
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isPublicUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      return url.protocol === "https:" && (url.hostname.endsWith("gaoding.com") || url.hostname.endsWith("dancf.com"));
    } catch {
      return false;
    }
  };

  let previousHeight = 0;
  let stableRounds = 0;
  for (let round = 0; round < 40 && stableRounds < 5; round += 1) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    await sleep(900);
    const height = document.documentElement.scrollHeight;
    stableRounds = height === previousHeight ? stableRounds + 1 : 0;
    previousHeight = height;
  }
  window.scrollTo({ top: 0, behavior: "instant" });

  const visibleCards = Array.from(document.querySelectorAll("a[href]"))
    .map((anchor, index) => {
      const image = anchor.querySelector("img");
      if (!image || !isPublicUrl(anchor.href)) return null;
      const rect = anchor.getBoundingClientRect();
      const imageUrl = image.currentSrc || image.src;
      if (!isPublicUrl(imageUrl)) return null;
      const explicitAttributes = {};
      for (const element of [anchor, image]) {
        for (const attribute of element.attributes) {
          if (/^(data-|width$|height$|title$|aria-label$)/i.test(attribute.name)) {
            explicitAttributes[`${element.tagName.toLowerCase()}.${attribute.name}`] = attribute.value;
          }
        }
      }
      return {
        index,
        href: anchor.href,
        visibleText: clean(anchor.innerText || anchor.textContent).slice(0, 300),
        alt: clean(image.alt),
        imageUrl,
        thumbnailNaturalWidth: image.naturalWidth,
        thumbnailNaturalHeight: image.naturalHeight,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        explicitAttributes,
      };
    })
    .filter(Boolean)
    .filter((card, index, all) => all.findIndex((item) => item.href === card.href && item.imageUrl === card.imageUrl) === index);

  const sizeText = Array.from(document.querySelectorAll("body *"))
    .filter((element) => element.children.length === 0 && /\b\d{2,5}\s*[×xX*]\s*\d{2,5}\b/.test(element.textContent || ""))
    .map((element) => ({
      text: clean(element.textContent),
      nearestLink: element.closest("a[href]")?.href || "",
    }))
    .slice(0, 1000);

  const output = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    page: { url: location.href, title: document.title },
    safety: {
      visibleDomOnly: true,
      cookiesRead: false,
      storageRead: false,
      requestsReplayed: false,
      internalFrameworkStateRead: false,
    },
    cardCount: visibleCards.length,
    cards: visibleCards,
    visibleSizeLabels: sizeText,
  };
  const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `gaoding-visible-templates-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  console.info("Visible template export complete", { cards: visibleCards.length, sizeLabels: sizeText.length });
})();
