import fs from "node:fs";

const file = "src/components/cover-studio.tsx";
let source = fs.readFileSync(file, "utf8");

function replace(search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Missing studio anchor: ${label}`);
  source = source.replace(search, replacement);
}

replace('  ChevronDown,\n  Copy,', `  ChevronDown,
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  Bot,
  Copy,
  CopyPlus,`, "advanced icons start");
replace('  Download,\n  ImagePlus,', `  Download,
  Eraser,
  Expand,
  FileDown,
  FileText,
  FolderOpen,
  Grid2X2,
  History,
  ImagePlus,
  Images,`, "advanced icons middle");
replace('  MonitorUp,\n  Plus,', `  MonitorUp,
  Palette,
  PanelBottom,
  Plus,
  Ruler,`, "advanced icons tools");
replace('  Search,\n  Sparkles,', `  Search,
  Save,
  Scan,
  Settings2,
  Shapes,
  SlidersHorizontal,
  Sparkles,`, "advanced icons end");
replace('import { CoverCanvas, type CoverCanvasHandle, type CoverSelection } from "@/components/cover-canvas";', 'import { CoverCanvas, type CoverCanvasHandle, type CoverLayerSummary, type CoverSelection } from "@/components/cover-canvas";', "canvas layer import");
replace('type InspectorMode = "content" | "style";', 'type InspectorMode = "content" | "style" | "layers";\ntype ExportFormat = "png" | "jpeg" | "webp";', "studio modes");
replace('interface CoverDraft {', `interface ArtboardPage {
  id: string;
  name: string;
  ratio: CoverRatio;
  templateId: string;
  title: string;
  subtitle: string;
  badge: string;
  prompt: string;
  selectedImage: string;
  candidates: string[];
  templateTexts: Record<string, string>;
  width: number;
  height: number;
}

interface CoverDraft {`, "page model");
replace('  templateTexts: Record<string, string>;\n}', '  templateTexts: Record<string, string>;\n  documentName: string;\n  canvasWidth: number;\n  canvasHeight: number;\n}', "draft v2 fields");
replace('const INITIAL_TEMPLATE = getDefaultTemplate("3:4");', `const INITIAL_TEMPLATE = getDefaultTemplate("3:4");
const INITIAL_WIDTH = INITIAL_TEMPLATE.originalWidth || 1080;
const INITIAL_HEIGHT = INITIAL_TEMPLATE.originalHeight || 1440;

function makePage(name: string, template = INITIAL_TEMPLATE): ArtboardPage {
  return {
    id: \`page-\${Date.now()}-\${Math.random().toString(36).slice(2, 7)}\`,
    name,
    ratio: template.ratio,
    templateId: template.id,
    title: template.title,
    subtitle: template.subtitle,
    badge: template.badge,
    prompt: "年轻内容创作者在明亮的工作室分享实用经验，真实自然，有亲和力",
    selectedImage: "",
    candidates: [],
    templateTexts: textValuesFor(template),
    width: template.originalWidth || (template.ratio === "3:4" ? 1080 : 1440),
    height: template.originalHeight || (template.ratio === "3:4" ? 1440 : 1080),
  };
}`, "page factory");
replace('  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("content");', `  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("content");
  const [documentName, setDocumentName] = useState("AI 视频封面设计");
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [showRulers, setShowRulers] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [snapToGuides, setSnapToGuides] = useState(true);
  const [canvasWidth, setCanvasWidth] = useState(INITIAL_WIDTH);
  const [canvasHeight, setCanvasHeight] = useState(INITIAL_HEIGHT);
  const [pendingWidth, setPendingWidth] = useState(INITIAL_WIDTH);
  const [pendingHeight, setPendingHeight] = useState(INITIAL_HEIGHT);
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [exportQuality, setExportQuality] = useState(94);
  const [layers, setLayers] = useState<CoverLayerSummary[]>([]);
  const [pages, setPages] = useState<ArtboardPage[]>(() => [makePage("画板 1")]);
  const [activePageId, setActivePageId] = useState(() => pages[0].id);
  const [versions, setVersions] = useState<Array<{ id: string; name: string; createdAt: string; page: ArtboardPage }>>([]);
  const [batchText, setBatchText] = useState("");
  const [aiEditing, setAiEditing] = useState("");
  const [imageAdjust, setImageAdjust] = useState({ brightness: 0, contrast: 0, saturation: 0, blur: 0 });`, "v2 state");
replace('        if (draft.templateTexts) setTemplateTexts(draft.templateTexts);', `        if (draft.templateTexts) setTemplateTexts(draft.templateTexts);
        if (draft.documentName) setDocumentName(draft.documentName);
        if (draft.canvasWidth) { setCanvasWidth(draft.canvasWidth); setPendingWidth(draft.canvasWidth); }
        if (draft.canvasHeight) { setCanvasHeight(draft.canvasHeight); setPendingHeight(draft.canvasHeight); }`, "restore v2 draft");
replace('      const draft: CoverDraft = { ratio, templateId, title, subtitle, badge, prompt, selectedImage, candidates, templateTexts };', '      const draft: CoverDraft = { ratio, templateId, title, subtitle, badge, prompt, selectedImage, candidates, templateTexts, documentName, canvasWidth, canvasHeight };', "save v2 draft");
replace('  }, [ratio, templateId, title, subtitle, badge, prompt, selectedImage, candidates, templateTexts]);', '  }, [ratio, templateId, title, subtitle, badge, prompt, selectedImage, candidates, templateTexts, documentName, canvasWidth, canvasHeight]);', "save v2 deps");
replace('  const handleTemplateTextEdit = useCallback((layerId: string, value: string) => {\n    setTemplateTexts((current) => ({ ...current, [layerId]: value }));\n  }, []);', `  const handleTemplateTextEdit = useCallback((layerId: string, value: string) => {
    setTemplateTexts((current) => ({ ...current, [layerId]: value }));
  }, []);

  const handleLayersChange = useCallback((nextLayers: CoverLayerSummary[]) => setLayers(nextLayers), []);`, "layers callback");
replace('    setTemplateTexts(textValuesFor(next));\n    setCategory("全部");', '    setTemplateTexts(textValuesFor(next));\n    setCanvasWidth(next.originalWidth || (nextRatio === "3:4" ? 1080 : 1440));\n    setCanvasHeight(next.originalHeight || (nextRatio === "3:4" ? 1440 : 1080));\n    setCategory("全部");', "ratio canvas size");
replace('    setTemplateTexts(textValuesFor(next));\n    setSelection(null);', '    setTemplateTexts(textValuesFor(next));\n    setCanvasWidth(next.originalWidth || (next.ratio === "3:4" ? 1080 : 1440));\n    setCanvasHeight(next.originalHeight || (next.ratio === "3:4" ? 1440 : 1080));\n    setSelection(null);', "template canvas size");
replace(`  function downloadCover() {
    if (!canvasReady) return;
    try {
      canvasRef.current?.download(\`封面-\${ratio.replace(":", "x")}-\${Date.now()}.png\`);
      setNotice(\`已导出 \${template.originalWidth && template.originalHeight ? \`\${template.originalWidth}×\${template.originalHeight}\` : ratio === "3:4" ? "1080×1440" : "1440×1080"} PNG\`);
    } catch {
      setNotice("导出失败，请改用上传素材后重试");
    }
  }`, `  function downloadCover() {
    if (!canvasReady) return;
    setExportOpen(true);
  }

  function performDownload() {
    try {
      const extension = exportFormat === "jpeg" ? "jpg" : exportFormat;
      canvasRef.current?.download(\`\${documentName || "封面"}-\${canvasWidth}x\${canvasHeight}.\${extension}\`, exportFormat, exportQuality / 100);
      setExportOpen(false);
      setNotice(\`已导出 \${canvasWidth}×\${canvasHeight} \${extension.toUpperCase()}\`);
    } catch {
      setNotice("导出失败，请稍后重试");
    }
  }

  function applyCanvasSize() {
    const width = Math.max(320, Math.min(4096, Math.round(pendingWidth)));
    const height = Math.max(320, Math.min(4096, Math.round(pendingHeight)));
    setCanvasWidth(width);
    setCanvasHeight(height);
    setRatio(height >= width ? "3:4" : "4:3");
    setSizeOpen(false);
    setNotice(\`画布已调整为 \${width}×\${height}\`);
  }

  function currentPage(name = "当前画板"): ArtboardPage {
    return { id: activePageId, name, ratio, templateId, title, subtitle, badge, prompt, selectedImage, candidates, templateTexts, width: canvasWidth, height: canvasHeight };
  }

  function loadPage(page: ArtboardPage) {
    setActivePageId(page.id);
    setRatio(page.ratio);
    setTemplateId(page.templateId);
    setTitle(page.title);
    setSubtitle(page.subtitle);
    setBadge(page.badge);
    setPrompt(page.prompt);
    setSelectedImage(page.selectedImage);
    setCandidates(page.candidates);
    setTemplateTexts(page.templateTexts);
    setCanvasWidth(page.width);
    setCanvasHeight(page.height);
    setSelection(null);
  }

  function addPage(duplicate = false) {
    const page = duplicate ? { ...currentPage(\`画板 \${pages.length + 1}\`), id: \`page-\${Date.now()}\` } : makePage(\`画板 \${pages.length + 1}\`, getDefaultTemplate(ratio));
    setPages((current) => [...current.map((item) => item.id === activePageId ? currentPage(item.name) : item), page]);
    loadPage(page);
  }

  function deletePage(pageId: string) {
    if (pages.length <= 1) return setNotice("至少保留一个画板");
    const next = pages.filter((item) => item.id !== pageId);
    setPages(next);
    if (pageId === activePageId) loadPage(next[0]);
  }

  function createVersion() {
    const version = { id: \`version-\${Date.now()}\`, name: \`版本 \${versions.length + 1}\`, createdAt: new Date().toLocaleString("zh-CN"), page: currentPage() };
    setVersions((current) => [version, ...current]);
    setFileMenuOpen(false);
    setNotice("已创建版本快照");
  }

  function applyBatchPages() {
    const rows = batchText.split(/\\r?\\n/).map((row) => row.trim()).filter(Boolean);
    if (!rows.length) return setNotice("请填写批量文案");
    const created = rows.map((row, index) => {
      const [nextTitle, nextSubtitle = subtitle, nextBadge = badge] = row.split("|");
      const page = { ...currentPage(\`批量画板 \${index + 1}\`), id: \`page-\${Date.now()}-\${index}\`, title: nextTitle, subtitle: nextSubtitle, badge: nextBadge };
      const layerIds = template.layers ?? [];
      page.templateTexts = { ...page.templateTexts };
      if (layerIds[0]) page.templateTexts[layerIds[0].id] = nextTitle;
      if (layerIds[1]) page.templateTexts[layerIds[1].id] = nextSubtitle;
      if (layerIds[2]) page.templateTexts[layerIds[2].id] = nextBadge;
      return page;
    });
    setPages((current) => [...current, ...created]);
    setBatchOpen(false);
    setBatchText("");
    setNotice(\`已创建 \${created.length} 个批量画板\`);
  }

  async function runAiEdit(action: "抠图" | "擦除" | "扩图" | "换背景") {
    const reference = selectedImage || template.image;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return setLoginOpen(true);
    setAiEditing(action);
    const instructions = {
      抠图: "Remove the background cleanly and return the isolated main subject on a simple pure white background. Preserve hair and edge details. No text.",
      擦除: "Remove distracting objects and visual clutter from the background while preserving the main subject and composition. No text.",
      扩图: \`Extend and recompose this image naturally for a \${canvasWidth}:\${canvasHeight} cover. Preserve the main subject identity and leave clean typography space. No text.\`,
      换背景: \`\${prompt}. Keep the main subject identity and pose, replace the environment with this new scene, premium commercial cover background, no text.\`,
    };
    try {
      const response = await fetch("/api/bridge/image/generate", { method: "POST", headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: instructions[action], mode: "local", modelId, style: "", aspectRatio: ratio, coverText: "", referenceImageUrls: [reference], referenceUsage: "general" }) });
      const data = await response.json() as { images?: Array<{ url?: string }>; error?: string };
      const url = data.images?.[0]?.url;
      if (!response.ok || !url) throw new Error(data.error || "AI 图片处理失败");
      setSelectedImage(url);
      setCandidates((current) => [url, ...current].slice(0, 8));
      setNotice(\`AI \${action}已完成\`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : \`AI \${action}失败\`);
    } finally {
      setAiEditing("");
    }
  }`, "studio v2 functions");
replace(`      <header className="cover-topbar">
        <div className="cover-topbar-left">
          <Link href="/" className="cover-icon-button" title="返回工作台"><ArrowLeft size={19} /></Link>
          <div className="cover-brand-mark"><Sparkles size={17} /></div>
          <div>
            <strong>AI 视频封面</strong>
            <span className={\`cover-save-state \${saved ? "is-saved" : ""}\`}>{saved ? "已自动保存" : "保存中"}</span>
          </div>
        </div>`, `      <header className="cover-topbar">
        <div className="cover-topbar-left">
          <Link href="/" className="cover-icon-button" title="返回工作台"><ArrowLeft size={19} /></Link>
          <div className="cover-file-wrap">
            <button className="cover-file-button" type="button" onClick={() => setFileMenuOpen((value) => !value)}><FileText size={16} />文件<ChevronDown size={14} /></button>
            {fileMenuOpen && <div className="cover-file-menu">
              <button type="button" onClick={() => { setFileMenuOpen(false); addPage(false); }}><Plus size={16} /><span>创建设计</span></button>
              <button type="button" onClick={() => { setFileMenuOpen(false); uploadRef.current?.click(); }}><FolderOpen size={16} /><span>导入文件</span></button>
              <button type="button" onClick={createVersion}><Save size={16} /><span>创建新版本</span></button>
              <button type="button" onClick={() => { setFileMenuOpen(false); setVersionOpen(true); }}><History size={16} /><span>查看版本记录</span></button>
              <button type="button" onClick={() => { setFileMenuOpen(false); addPage(true); }}><CopyPlus size={16} /><span>创建副本</span></button>
              <div className="cover-menu-separator" />
              <button type="button" onClick={() => { setFileMenuOpen(false); setSizeOpen(true); setPendingWidth(canvasWidth); setPendingHeight(canvasHeight); }}><Expand size={16} /><span>尺寸延展</span><small>{canvasWidth}×{canvasHeight}</small></button>
              <button type="button" onClick={() => { setFileMenuOpen(false); setBatchOpen(true); }}><Grid2X2 size={16} /><span>批量套版</span></button>
              <label><Ruler size={16} /><span>标尺与参考线</span><input type="checkbox" checked={showRulers} onChange={(event) => setShowRulers(event.target.checked)} /></label>
              <label><Settings2 size={16} /><span>智能吸附</span><input type="checkbox" checked={snapToGuides} onChange={(event) => setSnapToGuides(event.target.checked)} /></label>
            </div>}
          </div>
          <input className="cover-document-title" value={documentName} onChange={(event) => setDocumentName(event.target.value)} aria-label="作品名称" />
          <span className={\`cover-save-state \${saved ? "is-saved" : ""}\`}>{saved ? "已保存" : "保存中"}</span>
        </div>`, "gaoding topbar");
replace('          <button className="cover-primary-button" type="button" onClick={downloadCover} disabled={!canvasReady}>\n            <Download size={17} />下载 PNG\n          </button>', `          <button className="cover-publish-button" type="button" onClick={() => setNotice("作品已保存到主站草稿")}>发布</button>
          <button className="cover-primary-button" type="button" onClick={downloadCover} disabled={!canvasReady}>
            <Download size={17} />导出
          </button>`, "publish export");
replace('        <aside className="cover-library" aria-label="素材与模板">\n          <div className="cover-side-tabs">\n            <button className={sidebarMode === "templates" ? "is-active" : ""} type="button" onClick={() => setSidebarMode("templates")}><Layers3 size={16} />模板</button>\n            <button className={sidebarMode === "assets" ? "is-active" : ""} type="button" onClick={() => setSidebarMode("assets")}><ImagePlus size={16} />素材</button>\n          </div>', `        <aside className="cover-library" aria-label="素材与模板">
          <nav className="cover-tool-rail" aria-label="编辑工具">
            <button type="button" title="添加文字" onClick={() => canvasRef.current?.addTextLayer()}><Plus size={18} /><span>添加</span></button>
            <button className={sidebarMode === "templates" ? "is-active" : ""} type="button" onClick={() => setSidebarMode("templates")}><Grid2X2 size={18} /><span>模板</span></button>
            <button className={sidebarMode === "assets" ? "is-active" : ""} type="button" onClick={() => setSidebarMode("assets")}><Images size={18} /><span>素材</span></button>
            <button type="button" onClick={() => canvasRef.current?.addTextLayer()}><Type size={18} /><span>文字</span></button>
            <button type="button" onClick={() => canvasRef.current?.addShapeLayer()}><Shapes size={18} /><span>形状</span></button>
            <button type="button" onClick={() => { setInspectorMode("style"); setSelection(null); }}><Palette size={18} /><span>背景</span></button>
            <button type="button" onClick={() => setInspectorMode("content")}><Bot size={18} /><span>AI 工具</span></button>
            <button type="button" onClick={() => setInspectorMode("layers")}><Layers3 size={18} /><span>图层</span></button>
          </nav>
          <div className="cover-library-panel">
          <div className="cover-library-heading"><strong>{sidebarMode === "templates" ? "模板" : "素材"}</strong><span>{sidebarMode === "templates" ? \`\${filteredTemplates.length} 款\` : \`\${candidates.length} 项\`}</span></div>`, "tool rail");
replace('          )}\n        </aside>\n\n        <section className="cover-stage"', '          )}\n          </div>\n        </aside>\n\n        <section className="cover-stage"', "library panel close");
replace('              <button className="cover-icon-button" type="button" title="放大" onClick={() => setZoom((value) => Math.min(100, value + 5))}><ZoomIn size={17} /></button>\n            </div>', '              <button className="cover-icon-button" type="button" title="放大" onClick={() => setZoom((value) => Math.min(100, value + 5))}><ZoomIn size={17} /></button>\n            </div>\n            <div className="cover-toolbar-status"><button className={showRulers ? "is-active" : ""} type="button" title="标尺" onClick={() => setShowRulers((value) => !value)}><Ruler size={16} /></button><button className={showGuides ? "is-active" : ""} type="button" title="参考线" onClick={() => setShowGuides((value) => !value)}><Grid2X2 size={16} /></button><span>{canvasWidth} × {canvasHeight}</span></div>', "stage tools");
replace('<div className="cover-canvas-area">\n            <div className={`cover-canvas-frame ratio-${ratio.replace(":", "-")}`} style={{ width: `${zoom}%` }}>', '<div className={`cover-canvas-area ${showRulers ? "has-rulers" : ""}`}>\n            {showRulers && <><div className="cover-ruler cover-ruler-x" /><div className="cover-ruler cover-ruler-y" /></>}\n            <div className={`cover-canvas-frame ratio-${ratio.replace(":", "-")}`} style={{ width: `${zoom}%`, aspectRatio: `${canvasWidth} / ${canvasHeight}` }}>', "canvas rulers");
replace('                templateTextValues={templateTexts}\n                onSelectionChange={setSelection}', '                templateTextValues={templateTexts}\n                canvasWidth={canvasWidth}\n                canvasHeight={canvasHeight}\n                snapToGuides={snapToGuides}\n                onSelectionChange={setSelection}', "canvas v2 props");
replace('                onTemplateTextEdit={handleTemplateTextEdit}\n              />', '                onTemplateTextEdit={handleTemplateTextEdit}\n                onLayersChange={handleLayersChange}\n              />\n              {showGuides && <div className="cover-guides" aria-hidden="true"><span className="guide-x" /><span className="guide-y" /></div>}', "canvas guides and layers");
replace(`          <div className="cover-candidate-rail">
            <div className="cover-candidate-heading"><strong>画面候选</strong><span>{candidates.length ? \`已保留 \${candidates.length} 张\` : "等待生成"}</span></div>
            <div className="cover-candidate-list">
              {candidates.length ? candidates.map((url, index) => (
                <button key={\`\${url.slice(-40)}-\${index}\`} className={selectedImage === url ? "is-active" : ""} type="button" onClick={() => setSelectedImage(url)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={\`候选素材 \${index + 1}\`} />
                  {selectedImage === url && <span><Check size={12} /></span>}
                </button>
              )) : <div className="cover-candidate-empty"><WandSparkles size={17} />AI 生成的画面会保留在这里</div>}
            </div>
          </div>`, `          <div className="cover-artboard-strip">
            <div className="cover-artboard-heading"><PanelBottom size={16} /><strong>画板 {pages.findIndex((page) => page.id === activePageId) + 1}/{pages.length}</strong></div>
            <div className="cover-artboard-list">
              {pages.map((page, index) => <button key={page.id} className={page.id === activePageId ? "is-active" : ""} type="button" onClick={() => loadPage(page)}>
                <span className="cover-artboard-thumb" style={{ backgroundImage: \`url(\${(COVER_TEMPLATES.find((item) => item.id === page.templateId)?.preview || page.selectedImage || COVER_TEMPLATES.find((item) => item.id === page.templateId)?.image)})\` }}><b>{index + 1}</b></span>
                <small>{page.name}</small>
                {pages.length > 1 && <i role="button" title="删除画板" onClick={(event) => { event.stopPropagation(); deletePage(page.id); }}><X size={11} /></i>}
              </button>)}
              <button className="cover-add-artboard" type="button" onClick={() => addPage(false)} title="添加画板"><Plus size={20} /></button>
            </div>
            <button className="cover-duplicate-artboard" type="button" onClick={() => addPage(true)}><CopyPlus size={15} />复制画板</button>
          </div>`, "artboard strip");
replace('          <div className="cover-inspector-tabs">\n            <button className={inspectorMode === "content" ? "is-active" : ""} type="button" onClick={() => setInspectorMode("content")}><Type size={16} />内容</button>\n            <button className={inspectorMode === "style" ? "is-active" : ""} type="button" onClick={() => setInspectorMode("style")}><Sparkles size={16} />样式</button>\n          </div>', `          <div className="cover-inspector-tabs">
            <button className={inspectorMode === "content" ? "is-active" : ""} type="button" onClick={() => setInspectorMode("content")}><Type size={16} />内容</button>
            <button className={inspectorMode === "style" ? "is-active" : ""} type="button" onClick={() => setInspectorMode("style")}><SlidersHorizontal size={16} />属性</button>
            <button className={inspectorMode === "layers" ? "is-active" : ""} type="button" onClick={() => setInspectorMode("layers")}><Layers3 size={16} />图层</button>
          </div>`, "inspector tabs");
replace('                <button className="cover-secondary-button" type="button" onClick={() => uploadRef.current?.click()}><Upload size={16} />使用本地素材</button>', `                <button className="cover-secondary-button" type="button" onClick={() => uploadRef.current?.click()}><Upload size={16} />使用本地素材</button>
                <div className="cover-ai-tool-grid">
                  <button type="button" disabled={Boolean(aiEditing)} onClick={() => void runAiEdit("抠图")}><Scan size={17} /><span>{aiEditing === "抠图" ? "处理中" : "AI 抠图"}</span></button>
                  <button type="button" disabled={Boolean(aiEditing)} onClick={() => void runAiEdit("擦除")}><Eraser size={17} /><span>{aiEditing === "擦除" ? "处理中" : "AI 消除"}</span></button>
                  <button type="button" disabled={Boolean(aiEditing)} onClick={() => void runAiEdit("扩图")}><Expand size={17} /><span>{aiEditing === "扩图" ? "处理中" : "AI 扩图"}</span></button>
                  <button type="button" disabled={Boolean(aiEditing)} onClick={() => void runAiEdit("换背景")}><Palette size={17} /><span>{aiEditing === "换背景" ? "处理中" : "AI 换景"}</span></button>
                </div>`, "ai edit tools");
replace('          ) : (\n            <div className="cover-inspector-scroll">', `          ) : inspectorMode === "layers" ? (
            <div className="cover-inspector-scroll">
              <section className="cover-panel-section">
                <div className="cover-section-heading"><div><Layers3 size={17} /><strong>图层</strong></div><span>{layers.length}</span></div>
                <div className="cover-layer-list">{layers.map((layer) => <button key={layer.id} type="button" className={selection?.objectId === layer.id ? "is-active" : ""} onClick={() => canvasRef.current?.selectLayer(layer.id)}><span onClick={(event) => { event.stopPropagation(); canvasRef.current?.toggleLayerVisibility(layer.id); }}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</span><b>{layer.name}</b><small>{layer.locked ? "已锁定" : layer.type}</small></button>)}</div>
              </section>
            </div>
          ) : (
            <div className="cover-inspector-scroll">`, "layers inspector branch");
replace(`                    {selection.fontSize > 0 && <label className="cover-field"><span>字号 <b>{Math.round(selection.fontSize)}</b></span><input type="range" min="12" max="96" defaultValue={selection.fontSize} onChange={(event) => canvasRef.current?.updateSelected({ fontSize: Number(event.target.value) })} /></label>}
                    {selection.role !== "image" && <label className="cover-field"><span>颜色</span><span className="cover-color-row"><input type="color" defaultValue={selection.fill.startsWith("#") ? selection.fill : "#ffffff"} onChange={(event) => canvasRef.current?.updateSelected({ fill: event.target.value })} /><code>{selection.fill}</code></span></label>}
                    <label className="cover-field"><span>不透明度 <b>{Math.round(selection.opacity * 100)}%</b></span><input type="range" min="10" max="100" defaultValue={selection.opacity * 100} onChange={(event) => canvasRef.current?.updateSelected({ opacity: Number(event.target.value) / 100 })} /></label>
                    {selection.role === "image" && <button className="cover-secondary-button" type="button" onClick={() => canvasRef.current?.fitSelectedImage()}><RefreshCw size={16} />铺满画布</button>}`, `                    {selection.fontSize > 0 && <>
                      <label className="cover-field"><span>字体</span><span className="cover-select-wrap"><select value={selection.fontFamily || "Microsoft YaHei"} onChange={(event) => canvasRef.current?.updateSelected({ fontFamily: event.target.value })}><option>Microsoft YaHei</option><option>SimHei</option><option>SimSun</option><option>KaiTi</option></select><ChevronDown size={15} /></span></label>
                      <label className="cover-field"><span>字号 <b>{Math.round(selection.fontSize)}</b></span><input type="range" min="12" max="160" value={selection.fontSize} onChange={(event) => canvasRef.current?.updateSelected({ fontSize: Number(event.target.value) })} /></label>
                      <div className="cover-format-row"><button type="button" className={Number(selection.fontWeight) >= 700 ? "is-active" : ""} title="粗体" onClick={() => canvasRef.current?.updateSelected({ fontWeight: Number(selection.fontWeight) >= 700 ? 400 : 900 })}><Bold size={16} /></button><button type="button" className={selection.textAlign === "left" ? "is-active" : ""} title="左对齐" onClick={() => canvasRef.current?.updateSelected({ textAlign: "left" })}><AlignLeft size={16} /></button><button type="button" className={selection.textAlign === "center" ? "is-active" : ""} title="居中" onClick={() => canvasRef.current?.updateSelected({ textAlign: "center" })}><AlignCenter size={16} /></button><button type="button" className={selection.textAlign === "right" ? "is-active" : ""} title="右对齐" onClick={() => canvasRef.current?.updateSelected({ textAlign: "right" })}><AlignRight size={16} /></button></div>
                      <label className="cover-field"><span>字距 <b>{Math.round(selection.charSpacing || 0)}</b></span><input type="range" min="-100" max="1200" value={selection.charSpacing || 0} onChange={(event) => canvasRef.current?.updateSelected({ charSpacing: Number(event.target.value) })} /></label>
                      <label className="cover-field"><span>描边 <b>{Math.round(selection.strokeWidth || 0)}</b></span><span className="cover-dual-control"><input type="color" value={selection.stroke?.startsWith("#") ? selection.stroke : "#111111"} onChange={(event) => canvasRef.current?.updateSelected({ stroke: event.target.value })} /><input type="range" min="0" max="12" value={selection.strokeWidth || 0} onChange={(event) => canvasRef.current?.updateSelected({ strokeWidth: Number(event.target.value) })} /></span></label>
                    </>}
                    {selection.role !== "image" && selection.role !== "assetImage" && <label className="cover-field"><span>颜色</span><span className="cover-color-row"><input type="color" value={selection.fill.startsWith("#") ? selection.fill : "#ffffff"} onChange={(event) => canvasRef.current?.updateSelected({ fill: event.target.value })} /><code>{selection.fill}</code></span></label>}
                    <label className="cover-field"><span>不透明度 <b>{Math.round(selection.opacity * 100)}%</b></span><input type="range" min="10" max="100" value={selection.opacity * 100} onChange={(event) => canvasRef.current?.updateSelected({ opacity: Number(event.target.value) / 100 })} /></label>
                    {(selection.role === "image" || selection.role === "assetImage") && <>
                      <div className="cover-image-tools"><button type="button" onClick={() => canvasRef.current?.fitSelectedImage()}><Crop size={16} />裁剪铺满</button><button type="button" onClick={() => void runAiEdit("抠图")}><Scan size={16} />AI 抠图</button></div>
                      {(["brightness", "contrast", "saturation", "blur"] as const).map((key) => <label className="cover-field" key={key}><span>{{ brightness: "亮度", contrast: "对比度", saturation: "饱和度", blur: "模糊" }[key]} <b>{Math.round(imageAdjust[key] * 100)}</b></span><input type="range" min={key === "blur" ? 0 : -100} max="100" value={imageAdjust[key] * 100} onChange={(event) => { const next = { ...imageAdjust, [key]: Number(event.target.value) / 100 }; setImageAdjust(next); canvasRef.current?.updateImageFilters(next); }} /></label>)}
                    </>}
                    {selection.role !== "image" && <><div className="cover-layer-actions"><button type="button" title="上移" onClick={() => canvasRef.current?.moveSelected("forward")}><ArrowUp size={15} /></button><button type="button" title="下移" onClick={() => canvasRef.current?.moveSelected("backward")}><ArrowDown size={15} /></button><button type="button" title="锁定" onClick={() => canvasRef.current?.toggleSelectedLock()}>{selection.locked ? <Unlock size={15} /> : <Lock size={15} />}</button></div></>}`, "advanced style controls");
replace(`                ) : (
                  <div className="cover-empty-selection"><Type size={20} /><strong>选择画布中的图层</strong><span>文字与图片可直接拖动、缩放和编辑</span></div>
                )}`, `                ) : (
                  <div className="cover-canvas-properties">
                    <button className="cover-size-summary" type="button" onClick={() => { setPendingWidth(canvasWidth); setPendingHeight(canvasHeight); setSizeOpen(true); }}><span><Expand size={17} />画布尺寸</span><strong>{canvasWidth} × {canvasHeight}</strong></button>
                    <label className="cover-field"><span>背景色</span><span className="cover-color-row"><input type="color" value={backgroundColor} onChange={(event) => { setBackgroundColor(event.target.value); canvasRef.current?.setBackgroundColor(event.target.value); }} /><code>{backgroundColor}</code></span></label>
                    <label className="cover-switch-row"><span>显示参考线</span><input type="checkbox" checked={showGuides} onChange={(event) => setShowGuides(event.target.checked)} /></label>
                    <label className="cover-switch-row"><span>智能吸附</span><input type="checkbox" checked={snapToGuides} onChange={(event) => setSnapToGuides(event.target.checked)} /></label>
                  </div>
                )}`, "canvas properties");
replace('      {notice && <div className="cover-toast"', `      {sizeOpen && <div className="cover-modal-backdrop"><div className="cover-dialog cover-size-dialog"><button className="cover-icon-button cover-dialog-close" type="button" title="关闭" onClick={() => setSizeOpen(false)}><X size={18} /></button><h2>调整尺寸</h2><div className="cover-size-presets"><button type="button" onClick={() => { setPendingWidth(1080); setPendingHeight(1440); }}>抖音 3:4</button><button type="button" onClick={() => { setPendingWidth(1440); setPendingHeight(1080); }}>横版 4:3</button><button type="button" onClick={() => { setPendingWidth(1080); setPendingHeight(1920); }}>竖屏 9:16</button><button type="button" onClick={() => { setPendingWidth(1920); setPendingHeight(1080); }}>横屏 16:9</button></div><div className="cover-size-inputs"><label><span>宽度</span><input type="number" min="320" max="4096" value={pendingWidth} onChange={(event) => setPendingWidth(Number(event.target.value))} /></label><b>×</b><label><span>高度</span><input type="number" min="320" max="4096" value={pendingHeight} onChange={(event) => setPendingHeight(Number(event.target.value))} /></label></div><button className="cover-primary-button cover-dialog-submit" type="button" onClick={applyCanvasSize}>应用尺寸</button></div></div>}

      {exportOpen && <div className="cover-modal-backdrop"><div className="cover-dialog cover-export-dialog"><button className="cover-icon-button cover-dialog-close" type="button" title="关闭" onClick={() => setExportOpen(false)}><X size={18} /></button><div className="cover-dialog-title"><FileDown size={20} /><div><h2>导出作品</h2><span>{canvasWidth} × {canvasHeight}</span></div></div><div className="cover-export-formats">{(["png", "jpeg", "webp"] as ExportFormat[]).map((format) => <button key={format} className={exportFormat === format ? "is-active" : ""} type="button" onClick={() => setExportFormat(format)}>{format === "jpeg" ? "JPG" : format.toUpperCase()}</button>)}</div>{exportFormat !== "png" && <label className="cover-field"><span>图片质量 <b>{exportQuality}%</b></span><input type="range" min="50" max="100" value={exportQuality} onChange={(event) => setExportQuality(Number(event.target.value))} /></label>}<button className="cover-primary-button cover-dialog-submit" type="button" onClick={performDownload}><Download size={17} />下载文件</button></div></div>}

      {batchOpen && <div className="cover-modal-backdrop"><div className="cover-dialog"><button className="cover-icon-button cover-dialog-close" type="button" title="关闭" onClick={() => setBatchOpen(false)}><X size={18} /></button><h2>批量套版</h2><p className="cover-dialog-help">每行生成一个画板，格式：主标题|副标题|标签</p><textarea className="cover-batch-textarea" rows={8} value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder={'新手做账号的5个坑|避坑指南|干货\\n普通人如何抓住机会|三个判断方法|必看'} /><button className="cover-primary-button cover-dialog-submit" type="button" onClick={applyBatchPages}>生成批量画板</button></div></div>}

      {versionOpen && <div className="cover-modal-backdrop"><div className="cover-dialog"><button className="cover-icon-button cover-dialog-close" type="button" title="关闭" onClick={() => setVersionOpen(false)}><X size={18} /></button><h2>版本记录</h2><div className="cover-version-list">{versions.length ? versions.map((version) => <button key={version.id} type="button" onClick={() => { loadPage(version.page); setVersionOpen(false); }}><History size={16} /><span><strong>{version.name}</strong><small>{version.createdAt}</small></span></button>) : <div className="cover-empty-selection"><History size={20} /><strong>暂无版本</strong><span>通过“文件 - 创建新版本”保存快照</span></div>}</div></div></div>}

      {notice && <div className="cover-toast"`, "v2 dialogs");

fs.writeFileSync(file, source, "utf8");
console.log("Upgraded cover studio to V2 workbench");
