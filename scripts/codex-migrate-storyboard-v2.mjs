import fs from "node:fs";
import path from "node:path";

const file = path.resolve("src/components/storyboard-workbench.tsx");
let source = fs.readFileSync(file, "utf8");

function replaceOnce(label, before, after) {
  const first = source.indexOf(before);
  const second = first < 0 ? -1 : source.indexOf(before, first + before.length);
  if (first < 0) throw new Error(`${label}: source block not found`);
  if (second >= 0) throw new Error(`${label}: source block matched more than once`);
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

replaceOnce(
  "image validation field",
  `  imageUrl?: string;\n  imageError?: string;\n  videoStatus: TaskStatus;`,
  `  imageUrl?: string;\n  imageError?: string;\n  imageValidatedAt?: number;\n  videoStatus: TaskStatus;`,
);

replaceOnce(
  "browser image gate helpers",
  `function createRun(cardCount = 3): WorkbenchRun {`,
  `function browserImageReady(url: string, timeoutMs = 30_000) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const timer = window.setTimeout(() => finish(() => reject(new Error("图片加载超时"))), timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      callback();
    };
    const fail = () => finish(() => reject(new Error("图片无法在浏览器中解码")));
    image.decoding = "async";
    image.onload = async () => {
      try {
        if (typeof image.decode === "function") await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) return fail();
        finish(() => resolve({ width: image.naturalWidth, height: image.naturalHeight }));
      } catch {
        fail();
      }
    };
    image.onerror = fail;
    image.src = url;
  });
}

function hasValidatedImage(card: WorkbenchCard) {
  return card.imageStatus === "done" && Boolean(card.imageUrl) && Boolean(card.imageValidatedAt);
}

function createRun(cardCount = 3): WorkbenchRun {`,
);

replaceOnce(
  "submission refs",
  `  const pollingTasksRef = useRef(new Set<string>());\n  const uploadInputsRef`,
  `  const pollingTasksRef = useRef(new Set<string>());\n  const validatingImagesRef = useRef(new Set<string>());\n  const imageSubmissionsRef = useRef(new Set<string>());\n  const videoSubmissionsRef = useRef(new Set<string>());\n  const uploadInputsRef`,
);

replaceOnce(
  "synchronous run ref",
  `  const patchRun = useCallback((patch: Partial<WorkbenchRun>) => {
    setRun((current) => ({ ...current, ...patch, updatedAt: Date.now() }));
  }, []);

  const patchCard = useCallback((cardId: string, patch: Partial<WorkbenchCard>) => {
    setRun((current) => ({
      ...current,
      updatedAt: Date.now(),
      cards: current.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card),
    }));
  }, []);`,
  `  const patchRun = useCallback((patch: Partial<WorkbenchRun>) => {
    setRun((current) => {
      const next = { ...current, ...patch, updatedAt: Date.now() };
      runRef.current = next;
      return next;
    });
  }, []);

  const patchCard = useCallback((cardId: string, patch: Partial<WorkbenchCard>) => {
    setRun((current) => {
      const next = {
        ...current,
        updatedAt: Date.now(),
        cards: current.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card),
      };
      runRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    for (const card of run.cards) {
      if (card.imageStatus !== "done" || !card.imageUrl || card.imageValidatedAt || validatingImagesRef.current.has(card.id)) continue;
      validatingImagesRef.current.add(card.id);
      void browserImageReady(card.imageUrl)
        .then(() => patchCard(card.id, { imageValidatedAt: Date.now(), imageError: undefined }))
        .catch((error) => patchCard(card.id, {
          imageStatus: "failed",
          imageValidatedAt: undefined,
          imageError: error instanceof Error ? error.message : "图片加载失败",
        }))
        .finally(() => validatingImagesRef.current.delete(card.id));
    }
  }, [patchCard, run.cards, storageReady]);`,
);

replaceOnce(
  "image duplicate submission gate",
  `    const model = imageModels.find((item) => item.id === current.imageModelId);\n    if (!token)`,
  `    const model = imageModels.find((item) => item.id === current.imageModelId);\n    if (imageSubmissionsRef.current.has(cardId)) return null;\n    if (!token)`,
);

replaceOnce(
  "image submission start",
  `    patchCard(cardId, { imageStatus: "running", imageError: undefined, videoStatus: "idle", videoUrl: undefined, videoError: undefined, videoTaskId: undefined });\n    try {`,
  `    imageSubmissionsRef.current.add(cardId);\n    patchCard(cardId, { imageStatus: "running", imageUrl: undefined, imageValidatedAt: undefined, imageError: undefined, videoStatus: "idle", videoUrl: undefined, videoError: undefined, videoTaskId: undefined });\n    try {`,
);

replaceOnce(
  "browser decode before image success",
  `          const storedUrl = await persistImage(generatedUrl, card.order);\n          patchCard(cardId, { imageStatus: "done", imageUrl: storedUrl, imageError: undefined });`,
  `          const storedUrl = await persistImage(generatedUrl, card.order);\n          try {\n            await browserImageReady(storedUrl);\n          } catch {\n            throw new RetryableImageFileError("图片已入库，但浏览器无法正常解码");\n          }\n          patchCard(cardId, { imageStatus: "done", imageUrl: storedUrl, imageValidatedAt: Date.now(), imageError: undefined });`,
);

replaceOnce(
  "image submission cleanup",
  `    } catch (error) {
      patchCard(cardId, { imageStatus: "failed", imageError: error instanceof Error ? error.message : "故事板生成失败" });
      return null;
    }
  }, [imageModels, patchCard, persistImage, token]);`,
  `    } catch (error) {
      patchCard(cardId, { imageStatus: "failed", imageValidatedAt: undefined, imageError: error instanceof Error ? error.message : "故事板生成失败" });
      return null;
    } finally {
      imageSubmissionsRef.current.delete(cardId);
    }
  }, [imageModels, patchCard, persistImage, token]);`,
);

replaceOnce(
  "video duplicate and image gate",
  `    const imageUrl = imageOverride || card?.imageUrl;
    if (!token) { setNotice("请先登录后再生成"); return null; }
    if (!card?.videoPrompt.trim()) { setNotice("请先粘贴图生视频 Prompt"); return null; }
    if (!model || !imageUrl || !/^https?:\\/\\//iu.test(imageUrl)) { setNotice("故事板图片尚未完成公网入库"); return null; }`,
  `    const imageUrl = imageOverride || card?.imageUrl;
    if (videoSubmissionsRef.current.has(cardId)) return null;
    if (!token) { setNotice("请先登录后再生成"); return null; }
    if (!card?.videoPrompt.trim()) { setNotice("请先粘贴图生视频 Prompt"); return null; }
    if (!card || (!imageOverride && !hasValidatedImage(card))) { setNotice("故事板图片尚未真实加载，视频仍处于锁定状态"); return null; }
    if (!model || !imageUrl || !/^https?:\\/\\//iu.test(imageUrl)) { setNotice("故事板图片尚未完成公网入库"); return null; }`,
);

replaceOnce(
  "video submission start",
  `    patchCard(cardId, {
      videoStatus: "queued",`,
  `    videoSubmissionsRef.current.add(cardId);
    patchCard(cardId, {
      videoStatus: "queued",`,
);

replaceOnce(
  "video submission cleanup",
  `    } catch (error) {
      patchCard(cardId, { videoStatus: "failed", videoError: error instanceof Error ? error.message : "视频生成失败" });
      return null;
    }
  }, [patchCard, startPolling, token, videoModels]);`,
  `    } catch (error) {
      patchCard(cardId, { videoStatus: "failed", videoError: error instanceof Error ? error.message : "视频生成失败" });
      return null;
    } finally {
      videoSubmissionsRef.current.delete(cardId);
    }
  }, [patchCard, startPolling, token, videoModels]);`,
);

replaceOnce(
  "batch video validation",
  `    const missing = run.cards.filter((card) => card.imageStatus !== "done" || !card.imageUrl || !card.videoPrompt.trim());`,
  `    const missing = run.cards.filter((card) => !hasValidatedImage(card) || !card.videoPrompt.trim());`,
);

replaceOnce(
  "full flow validation",
  `    const ready = run.cards.filter((card) => card.imageStatus === "done" && card.imageUrl).map((card) => ({ cardId: card.id, imageUrl: card.imageUrl! }));`,
  `    const ready = run.cards.filter(hasValidatedImage).map((card) => ({ cardId: card.id, imageUrl: card.imageUrl! }));`,
);

replaceOnce(
  "validated image count",
  `  const imageDone = run.cards.filter((card) => card.imageStatus === "done").length;`,
  `  const imageDone = run.cards.filter(hasValidatedImage).length;`,
);

replaceOnce(
  "root ratio attribute",
  `<div className="voice-studio-root vs-workbench sbw-root">`,
  `<div className="voice-studio-root vs-workbench sbw-root" data-ratio={run.ratio}>`,
);

replaceOnce(
  "batch video button gate",
  `<button type="button" onClick={batchVideos} disabled={Boolean(batchMode) || imageDone !== run.cards.length}><Film />批量视频</button>`,
  `<button type="button" onClick={batchVideos} disabled={Boolean(batchMode) || run.cards.some((card) => !hasValidatedImage(card))}><Film />批量视频</button>`,
);

replaceOnce(
  "video stage gate",
  `<section className={\`sbw-zone sbw-video-stage \${card.imageStatus !== "done" || !card.imageUrl ? "is-locked" : ""} \${card.videoUrl ? "has-result" : ""}\`}>
                  <div className="sbw-zone-title"><Film /><strong>图生视频</strong><span>{card.imageStatus === "done" && card.imageUrl ? "图片已就绪" : "请先生图"}</span></div>`,
  `<section className={\`sbw-zone sbw-video-stage \${!hasValidatedImage(card) ? "is-locked" : ""} \${card.videoUrl ? "has-result" : ""}\`}>
                  <div className="sbw-zone-title"><Film /><strong>图生视频</strong><span>{hasValidatedImage(card) ? "图片已验证" : "请先生图"}</span></div>`,
);

replaceOnce(
  "video card button gate",
  `disabled={!card.videoPrompt.trim() || card.imageStatus !== "done" || !card.imageUrl || card.videoStatus === "running" || Boolean(batchMode)}`,
  `disabled={!card.videoPrompt.trim() || !hasValidatedImage(card) || card.videoStatus === "running" || card.videoStatus === "queued" || Boolean(batchMode)}`,
);

fs.writeFileSync(file, source, "utf8");
console.log(`Updated ${file}`);
