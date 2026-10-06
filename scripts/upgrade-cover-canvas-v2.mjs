import fs from "node:fs";

const file = "src/components/cover-canvas.tsx";
let source = fs.readFileSync(file, "utf8");

function replace(search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Missing canvas anchor: ${label}`);
  source = source.replace(search, replacement);
}

replace('import { Canvas, Circle, FabricImage, FabricObject, Rect, Shadow, Textbox } from "fabric";', 'import { Canvas, Circle, FabricImage, FabricObject, Rect, Shadow, Textbox, filters } from "fabric";', "fabric filters");
replace('type CoverRole = "image" | "title" | "subtitle" | "badge" | "templateText" | "decoration";\ntype TaggedObject = FabricObject & { coverRole?: CoverRole; coverLayerId?: string };', `type CoverRole = "image" | "assetImage" | "shape" | "title" | "subtitle" | "badge" | "templateText" | "decoration";
type TaggedObject = FabricObject & { coverRole?: CoverRole; coverLayerId?: string; coverObjectId?: string; coverName?: string };

let objectCounter = 0;

export interface CoverLayerSummary {
  id: string;
  name: string;
  role: CoverRole;
  visible: boolean;
  locked: boolean;
  type: string;
}`, "canvas object metadata");
replace('  text?: string;\n}', `  text?: string;
  objectId?: string;
  name?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  textAlign?: string;
  charSpacing?: number;
  stroke?: string;
  strokeWidth?: number;
  locked?: boolean;
}`, "selection properties");
replace(`export interface CoverCanvasHandle {
  download: (filename?: string) => void;`, `export interface CoverCanvasHandle {
  download: (filename?: string, format?: "png" | "jpeg" | "webp", quality?: number) => void;` , "download signature");
replace('  updateSelected: (patch: Partial<{ fill: string; fontSize: number; opacity: number }>) => void;\n  fitSelectedImage: () => void;\n}', `  updateSelected: (patch: Partial<{ fill: string; fontSize: number; opacity: number; fontFamily: string; fontWeight: string | number; textAlign: string; charSpacing: number; stroke: string; strokeWidth: number }>) => void;
  updateImageFilters: (values: { brightness: number; contrast: number; saturation: number; blur: number }) => void;
  fitSelectedImage: () => void;
  addTextLayer: (text?: string) => void;
  addShapeLayer: () => void;
  addImageLayer: (source: string) => Promise<void>;
  setBackgroundColor: (color: string) => void;
  moveSelected: (direction: "front" | "forward" | "backward" | "back") => void;
  toggleSelectedLock: () => void;
  selectLayer: (id: string) => void;
  toggleLayerVisibility: (id: string) => void;
  getLayers: () => CoverLayerSummary[];
}`, "canvas commands");
replace('  templateTextValues: Record<string, string>;\n  onSelectionChange:', '  templateTextValues: Record<string, string>;\n  canvasWidth: number;\n  canvasHeight: number;\n  snapToGuides: boolean;\n  onSelectionChange:', "canvas sizing props");
replace('  onTemplateTextEdit: (layerId: string, value: string) => void;\n}', '  onTemplateTextEdit: (layerId: string, value: string) => void;\n  onLayersChange: (layers: CoverLayerSummary[]) => void;\n}', "layers callback");
replace(`function withRole<T extends FabricObject>(object: T, role: CoverRole, layerId?: string): T {
  (object as TaggedObject).coverRole = role;
  (object as TaggedObject).coverLayerId = layerId;
  return object;
}`, `function withRole<T extends FabricObject>(object: T, role: CoverRole, layerId?: string, name?: string): T {
  const tagged = object as TaggedObject;
  tagged.coverRole = role;
  tagged.coverLayerId = layerId;
  tagged.coverObjectId ||= \`cover-object-\${Date.now()}-\${objectCounter += 1}\`;
  tagged.coverName ||= name;
  return object;
}

function workingDimensions(width: number, height: number) {
  const maxSide = 720;
  if (width >= height) return { width: maxSide, height: Math.max(180, Math.round(maxSide * height / width)) };
  return { width: Math.max(180, Math.round(maxSide * width / height)), height: maxSide };
}`, "object tagging");
replace('async function drawTemplate(canvas: Canvas, template: CoverTemplate, imageUrl: string, title: string, subtitle: string, badge: string, templateTextValues: Record<string, string>) {\n  const { width: w, height: h } = COVER_DIMENSIONS[template.ratio];', 'async function drawTemplate(canvas: Canvas, template: CoverTemplate, imageUrl: string, title: string, subtitle: string, badge: string, templateTextValues: Record<string, string>, dimensions: { width: number; height: number }) {\n  const { width: w, height: h } = dimensions;', "dynamic renderer size");
replace('  const { template, imageUrl, title, subtitle, badge, templateTextValues, onSelectionChange, onHistoryChange, onReadyChange, onTextEdit, onTemplateTextEdit } = props;', '  const { template, imageUrl, title, subtitle, badge, templateTextValues, canvasWidth, canvasHeight, snapToGuides, onSelectionChange, onHistoryChange, onReadyChange, onTextEdit, onTemplateTextEdit, onLayersChange } = props;\n  const dimensions = workingDimensions(canvasWidth, canvasHeight);', "canvas v2 props");
replace('    const json = JSON.stringify(canvas.toObject(["coverRole", "coverLayerId"]));', '    const json = JSON.stringify(canvas.toObject(["coverRole", "coverLayerId", "coverObjectId", "coverName"]));', "snapshot metadata");
replace('    reportHistory();\n  }\n\n  async function restore', `    reportHistory();
    reportLayers();
  }

  function layerList(canvas = canvasRef.current): CoverLayerSummary[] {
    if (!canvas) return [];
    return [...canvas.getObjects()].reverse().map((object, index) => {
      const tagged = withRole(object, roleOf(object) ?? "decoration");
      return {
        id: tagged.coverObjectId!,
        name: tagged.coverName || (object instanceof Textbox ? object.text.slice(0, 16) || "文字" : roleOf(object) === "image" ? "背景图" : roleOf(object) === "assetImage" ? "图片" : \`图层 \${index + 1}\`),
        role: roleOf(object) ?? "decoration",
        visible: object.visible,
        locked: !object.selectable,
        type: object.type,
      };
    });
  }

  function reportLayers() {
    onLayersChange(layerList());
  }

  async function restore`, "layer reporter");
replace(`  useImperativeHandle(ref, () => ({
    download(filename = "video-cover.png") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      const link = document.createElement("a");
      link.download = filename;
      const baseWidth = COVER_DIMENSIONS[template.ratio].width;
      const multiplier = template.originalWidth ? template.originalWidth / baseWidth : COVER_DIMENSIONS[template.ratio].exportScale;
      link.href = canvas.toDataURL({ format: "png", multiplier });
      link.click();
    },`, `  useImperativeHandle(ref, () => ({
    download(filename = "video-cover.png", format = "png", quality = .94) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      const rendered = canvas.toCanvasElement(Math.max(1, canvasWidth / dimensions.width));
      const output = document.createElement("canvas");
      output.width = canvasWidth;
      output.height = canvasHeight;
      output.getContext("2d")?.drawImage(rendered, 0, 0, canvasWidth, canvasHeight);
      const link = document.createElement("a");
      link.download = filename;
      link.href = output.toDataURL(\`image/\${format}\`, quality);
      link.click();
    },`, "advanced download");
replace('      void object.clone().then((clone: FabricObject) => {\n        clone.set({ left: (object.left || 0) + 16, top: (object.top || 0) + 16 });\n        (clone as TaggedObject).coverRole = roleOf(object);', '      void object.clone().then((clone: FabricObject) => {\n        clone.set({ left: (object.left || 0) + 16, top: (object.top || 0) + 16 });\n        (clone as TaggedObject).coverRole = roleOf(object);\n        (clone as TaggedObject).coverObjectId = undefined;\n        withRole(clone, roleOf(object) ?? "decoration", undefined, `${(object as TaggedObject).coverName || "图层"} 副本`);', "clone ids");
replace(`    fitSelectedImage() {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !object || roleOf(object) !== "image") return;
      const { width, height } = COVER_DIMENSIONS[template.ratio];
      const scale = Math.max(width / (object.width || width), height / (object.height || height));
      object.set({ left: width / 2, top: height / 2, originX: "center", originY: "center", scaleX: scale, scaleY: scale });
      object.setCoords();
      canvas.requestRenderAll();
      snapshot();
    },
  }), [template.ratio, template.originalWidth]);`, `    updateImageFilters(values) {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !(object instanceof FabricImage)) return;
      object.filters = [
        new filters.Brightness({ brightness: values.brightness }),
        new filters.Contrast({ contrast: values.contrast }),
        new filters.Saturation({ saturation: values.saturation }),
        new filters.Blur({ blur: values.blur }),
      ];
      object.applyFilters();
      canvas.requestRenderAll();
      snapshot();
    },
    fitSelectedImage() {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !(object instanceof FabricImage)) return;
      const scale = Math.max(dimensions.width / (object.width || dimensions.width), dimensions.height / (object.height || dimensions.height));
      object.set({ left: dimensions.width / 2, top: dimensions.height / 2, originX: "center", originY: "center", scaleX: scale, scaleY: scale });
      object.setCoords();
      canvas.requestRenderAll();
      snapshot();
    },
    addTextLayer(text = "双击编辑文字") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const object = withRole(new Textbox(text, { left: dimensions.width / 2, top: dimensions.height / 2, originX: "center", originY: "center", width: dimensions.width * .7, fontSize: Math.max(28, dimensions.width * .07), fontFamily: '"Microsoft YaHei", sans-serif', fontWeight: 900, fill: "#ffffff", stroke: "#111111", strokeWidth: 2, paintFirst: "stroke", textAlign: "center", editable: true, splitByGrapheme: true }), "templateText", undefined, "新文字");
      canvas.add(object);
      canvas.setActiveObject(object);
      canvas.requestRenderAll();
      snapshot();
    },
    addShapeLayer() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const object = withRole(new Rect({ left: dimensions.width / 2, top: dimensions.height / 2, originX: "center", originY: "center", width: dimensions.width * .42, height: dimensions.height * .12, rx: 8, ry: 8, fill: "#ffd43b" }), "shape", undefined, "矩形");
      canvas.add(object);
      canvas.setActiveObject(object);
      canvas.requestRenderAll();
      snapshot();
    },
    async addImageLayer(source) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const image = withRole(await FabricImage.fromURL(source, { crossOrigin: "anonymous" }), "assetImage", undefined, "图片");
      const scale = Math.min(dimensions.width * .55 / (image.width || dimensions.width), dimensions.height * .55 / (image.height || dimensions.height));
      image.set({ left: dimensions.width / 2, top: dimensions.height / 2, originX: "center", originY: "center", scaleX: scale, scaleY: scale });
      canvas.add(image);
      canvas.setActiveObject(image);
      canvas.requestRenderAll();
      snapshot();
    },
    setBackgroundColor(color) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.backgroundColor = color;
      canvas.requestRenderAll();
      snapshot();
    },
    moveSelected(direction) {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !object || roleOf(object) === "image") return;
      if (direction === "front") canvas.bringObjectToFront(object);
      if (direction === "forward") canvas.bringObjectForward(object);
      if (direction === "backward") canvas.sendObjectBackwards(object);
      if (direction === "back") canvas.sendObjectToBack(object);
      canvas.requestRenderAll();
      snapshot();
    },
    toggleSelectedLock() {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !object || roleOf(object) === "image") return;
      const next = object.selectable;
      object.set({ selectable: !next, evented: !next, lockMovementX: next, lockMovementY: next, lockScalingX: next, lockScalingY: next, lockRotation: next });
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      snapshot();
    },
    selectLayer(id) {
      const canvas = canvasRef.current;
      const object = canvas?.getObjects().find((item) => (item as TaggedObject).coverObjectId === id);
      if (!canvas || !object || !object.selectable) return;
      canvas.setActiveObject(object);
      canvas.requestRenderAll();
    },
    toggleLayerVisibility(id) {
      const canvas = canvasRef.current;
      const object = canvas?.getObjects().find((item) => (item as TaggedObject).coverObjectId === id);
      if (!canvas || !object) return;
      object.set({ visible: !object.visible });
      canvas.requestRenderAll();
      snapshot();
    },
    getLayers: () => layerList(),
  }), [canvasWidth, canvasHeight, dimensions.height, dimensions.width]);`, "canvas v2 commands");
replace('    const { width, height } = COVER_DIMENSIONS[template.ratio];\n    const canvas = new Canvas(elementRef.current, { width, height, preserveObjectStacking: true, selectionColor: "rgba(8,127,112,.10)", selectionBorderColor: "#087f70" });', '    const canvas = new Canvas(elementRef.current, { width: dimensions.width, height: dimensions.height, preserveObjectStacking: true, selectionColor: "rgba(8,127,112,.10)", selectionBorderColor: "#087f70" });', "dynamic canvas init");
replace('    canvas.on("object:modified", () => snapshot());', `    canvas.on("object:modified", () => snapshot());
    canvas.on("object:moving", ({ target }) => {
      if (!snapToGuides || !target) return;
      const center = target.getCenterPoint();
      if (Math.abs(center.x - dimensions.width / 2) < 6) target.set({ left: (target.left || 0) + dimensions.width / 2 - center.x });
      if (Math.abs(center.y - dimensions.height / 2) < 6) target.set({ top: (target.top || 0) + dimensions.height / 2 - center.y });
    });`, "guide snapping");
replace('  }, [template.ratio, onSelectionChange, onTextEdit, onTemplateTextEdit]);', '  }, [dimensions.height, dimensions.width, onSelectionChange, onTextEdit, onTemplateTextEdit, snapToGuides]);', "canvas init deps");
replace('    void drawTemplate(canvas, template, imageUrl, title, subtitle, badge, templateTextValues).then(() => {', '    void drawTemplate(canvas, template, imageUrl, title, subtitle, badge, templateTextValues, dimensions).then(() => {', "draw dimensions");
replace('  }, [template, imageUrl]);', '  }, [template, imageUrl, dimensions.height, dimensions.width]);', "draw deps");
replace('      onSelectionChange({ role, type: object.type, fill: typeof object.fill === "string" ? object.fill : "#ffffff", fontSize: object instanceof Textbox ? object.fontSize : 0, opacity: object.opacity, layerId: (object as TaggedObject).coverLayerId, text: object instanceof Textbox ? object.text : undefined });', `      const tagged = object as TaggedObject;
      onSelectionChange({ role, type: object.type, fill: typeof object.fill === "string" ? object.fill : "#ffffff", fontSize: object instanceof Textbox ? object.fontSize : 0, opacity: object.opacity, layerId: tagged.coverLayerId, objectId: tagged.coverObjectId, name: tagged.coverName, text: object instanceof Textbox ? object.text : undefined, fontFamily: object instanceof Textbox ? object.fontFamily : undefined, fontWeight: object instanceof Textbox ? object.fontWeight : undefined, textAlign: object instanceof Textbox ? object.textAlign : undefined, charSpacing: object instanceof Textbox ? object.charSpacing : undefined, stroke: typeof object.stroke === "string" ? object.stroke : undefined, strokeWidth: object.strokeWidth, locked: !object.selectable });`, "advanced selection");

fs.writeFileSync(file, source, "utf8");
console.log("Upgraded cover canvas to V2 controls");
