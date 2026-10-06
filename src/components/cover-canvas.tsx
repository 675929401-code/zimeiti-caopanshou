"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Canvas, Circle, FabricImage, FabricObject, Rect, Shadow, Textbox, filters } from "fabric";
import { COVER_DIMENSIONS, type CoverTemplate } from "@/lib/cover-templates";

type CoverRole = "image" | "assetImage" | "shape" | "title" | "subtitle" | "badge" | "templateText" | "decoration";
type TaggedObject = FabricObject & { coverRole?: CoverRole; coverLayerId?: string; coverObjectId?: string; coverName?: string };

let objectCounter = 0;

export interface CoverLayerSummary {
  id: string;
  name: string;
  role: CoverRole;
  visible: boolean;
  locked: boolean;
  type: string;
}

export interface CoverSelection {
  role: CoverRole;
  type: string;
  fill: string;
  fontSize: number;
  opacity: number;
  layerId?: string;
  text?: string;
  objectId?: string;
  name?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  textAlign?: string;
  charSpacing?: number;
  stroke?: string;
  strokeWidth?: number;
  locked?: boolean;
}

export interface CoverCanvasHandle {
  download: (filename?: string, format?: "png" | "jpeg" | "webp", quality?: number) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  updateSelected: (patch: Partial<{ fill: string; fontSize: number; opacity: number; fontFamily: string; fontWeight: string | number; textAlign: string; charSpacing: number; stroke: string; strokeWidth: number }>) => void;
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
}

interface Props {
  template: CoverTemplate;
  imageUrl: string;
  title: string;
  subtitle: string;
  badge: string;
  templateTextValues: Record<string, string>;
  canvasWidth: number;
  canvasHeight: number;
  snapToGuides: boolean;
  onSelectionChange: (selection: CoverSelection | null) => void;
  onHistoryChange: (history: { canUndo: boolean; canRedo: boolean }) => void;
  onReadyChange: (ready: boolean) => void;
  onTextEdit: (role: "title" | "subtitle" | "badge", value: string) => void;
  onTemplateTextEdit: (layerId: string, value: string) => void;
  onLayersChange: (layers: CoverLayerSummary[]) => void;
}

function roleOf(object?: FabricObject): CoverRole | undefined {
  return (object as TaggedObject | undefined)?.coverRole;
}

function withRole<T extends FabricObject>(object: T, role: CoverRole, layerId?: string, name?: string): T {
  const tagged = object as TaggedObject;
  tagged.coverRole = role;
  tagged.coverLayerId = layerId;
  tagged.coverObjectId ||= `cover-object-${Date.now()}-${objectCounter += 1}`;
  tagged.coverName ||= name;
  return object;
}

function workingDimensions(width: number, height: number) {
  const maxSide = 720;
  if (width >= height) return { width: maxSide, height: Math.max(180, Math.round(maxSide * height / width)) };
  return { width: Math.max(180, Math.round(maxSide * width / height)), height: maxSide };
}

function addShape(canvas: Canvas, object: FabricObject) {
  object.set({ selectable: false, evented: false });
  canvas.add(withRole(object, "decoration"));
}

function addText(canvas: Canvas, role: "title" | "subtitle" | "badge", text: string, options: ConstructorParameters<typeof Textbox>[1]) {
  const textbox = withRole(new Textbox(text, {
    fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
    fontWeight: role === "title" ? 900 : 700,
    splitByGrapheme: true,
    editable: true,
    ...options,
  }), role);
  canvas.add(textbox);
}

async function addImage(canvas: Canvas, source: string, width: number, height: number) {
  const image = withRole(await FabricImage.fromURL(source, { crossOrigin: "anonymous" }), "image");
  const scale = Math.max(width / (image.width || width), height / (image.height || height));
  image.set({
    left: width / 2,
    top: height / 2,
    originX: "center",
    originY: "center",
    scaleX: scale,
    scaleY: scale,
    lockRotation: true,
  });
  canvas.add(image);
}

function colorWithAlpha(color: string, alpha: number) {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return color;
  const values = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${values[0]}, ${values[1]}, ${values[2]}, ${Math.max(0, Math.min(1, alpha))})`;
}

function addJianyingLayers(canvas: Canvas, template: CoverTemplate, values: Record<string, string>, width: number, height: number) {
  for (const layer of [...(template.layers ?? [])].sort((a, b) => a.zIndex - b.zIndex)) {
    const fontSize = Math.max(8, layer.fontSizeRatio * width);
    const distance = (layer.shadow?.distanceRatio ?? 0) * width;
    const angle = ((layer.shadow?.angle ?? 0) * Math.PI) / 180;
    const textbox = withRole(new Textbox(values[layer.id] ?? layer.text, {
      left: layer.x * width,
      top: layer.y * height,
      originX: "center",
      originY: "center",
      width: Math.max(40, layer.width * width),
      fontFamily: layer.fontFamily,
      fontWeight: layer.fontWeight,
      fontSize,
      fill: layer.fill,
      opacity: layer.opacity,
      textAlign: layer.align,
      charSpacing: layer.charSpacing,
      lineHeight: layer.lineHeight,
      angle: layer.angle,
      scaleX: layer.scaleX,
      scaleY: layer.scaleY,
      stroke: layer.stroke || undefined,
      strokeWidth: layer.stroke ? Math.max(1, layer.strokeWidthRatio * fontSize) : 0,
      paintFirst: "stroke",
      backgroundColor: layer.background || undefined,
      shadow: layer.shadow ? new Shadow({
        color: colorWithAlpha(layer.shadow.color, layer.shadow.opacity),
        blur: layer.shadow.blurRatio * width,
        offsetX: Math.cos(angle) * distance,
        offsetY: -Math.sin(angle) * distance,
      }) : undefined,
      splitByGrapheme: true,
      editable: true,
    }), "templateText", layer.id);
    canvas.add(textbox);
  }
}

async function drawTemplate(canvas: Canvas, template: CoverTemplate, imageUrl: string, title: string, subtitle: string, badge: string, templateTextValues: Record<string, string>, dimensions: { width: number; height: number }) {
  const { width: w, height: h } = dimensions;
  const portrait = template.ratio === "3:4";
  const pad = portrait ? 34 : 42;
  const titleSize = portrait ? 54 : 50;
  canvas.clear();
  canvas.backgroundColor = template.surface;
  await addImage(canvas, imageUrl || template.image, w, h);

  if (template.layout === "jianying") {
    addJianyingLayers(canvas, template, templateTextValues, w, h);
    canvas.requestRenderAll();
    return;
  }

  if (template.layout === "editorial-left") {
    addShape(canvas, new Rect({ left: 0, top: 0, width: w, height: h, fill: "rgba(12,18,16,.22)" }));
    addShape(canvas, new Rect({ left: pad, top: 34, width: 116, height: 32, rx: 4, ry: 4, fill: template.accent }));
    addText(canvas, "badge", badge, { left: pad + 12, top: 40, width: 96, fontSize: 15, fill: template.ink });
    addText(canvas, "title", title, {
      left: pad, top: portrait ? 96 : 88, width: portrait ? 400 : 365, fontSize: titleSize, lineHeight: .96,
      fill: template.titleColor, stroke: "rgba(0,0,0,.28)", strokeWidth: 1,
      shadow: new Shadow({ color: "rgba(0,0,0,.34)", blur: 10, offsetX: 0, offsetY: 4 }),
    });
    addShape(canvas, new Rect({ left: pad, top: h - 92, width: 340, height: 46, rx: 3, ry: 3, fill: template.secondary }));
    addText(canvas, "subtitle", subtitle, { left: pad + 14, top: h - 81, width: 315, fontSize: 18, fill: "#ffffff" });
  } else if (template.layout === "sticker-stack") {
    addShape(canvas, new Rect({ left: 0, top: 0, width: w, height: h, fill: "rgba(0,0,0,.12)" }));
    addShape(canvas, new Rect({ left: pad - 6, top: 66, width: portrait ? 400 : 390, height: 202, angle: -2, rx: 5, ry: 5, fill: template.accent }));
    addText(canvas, "badge", badge, { left: pad + 10, top: 34, width: 130, fontSize: 16, fill: "#ffffff", backgroundColor: template.secondary });
    addText(canvas, "title", title, { left: pad + 12, top: 89, width: portrait ? 360 : 350, fontSize: titleSize - 4, lineHeight: .96, fill: template.ink });
    addShape(canvas, new Rect({ left: pad + 8, top: portrait ? 290 : 280, width: 310, height: 40, angle: 1.5, rx: 3, ry: 3, fill: "#ffffff" }));
    addText(canvas, "subtitle", subtitle, { left: pad + 20, top: portrait ? 299 : 289, width: 285, fontSize: 17, fill: template.ink, angle: 1.5 });
    addShape(canvas, new Circle({ left: w - 76, top: 30, radius: 22, fill: template.secondary }));
  } else if (template.layout === "bottom-banner") {
    const top = portrait ? h - 245 : h - 205;
    addShape(canvas, new Rect({ left: 0, top, width: w, height: h - top, fill: "rgba(13,20,18,.92)" }));
    addShape(canvas, new Rect({ left: pad, top: top - 18, width: 98, height: 34, rx: 3, ry: 3, fill: template.accent }));
    addText(canvas, "badge", badge, { left: pad + 13, top: top - 11, width: 78, fontSize: 16, fill: template.ink });
    addText(canvas, "title", title, { left: pad, top: top + 28, width: w - pad * 2, fontSize: titleSize - 2, lineHeight: .92, fill: "#ffffff" });
    addText(canvas, "subtitle", subtitle, { left: pad, top: h - 42, width: w - pad * 2, fontSize: 17, fill: template.accent });
  } else if (template.layout === "clean-column") {
    const panelWidth = portrait ? 310 : 330;
    addShape(canvas, new Rect({ left: 0, top: 0, width: panelWidth, height: h, fill: "rgba(250,249,245,.94)" }));
    addShape(canvas, new Rect({ left: pad, top: 48, width: 52, height: 8, fill: template.accent }));
    addText(canvas, "badge", badge, { left: pad, top: 74, width: 160, fontSize: 15, fill: template.secondary });
    addText(canvas, "title", title, { left: pad, top: 112, width: panelWidth - pad * 1.25, fontSize: portrait ? 48 : 46, lineHeight: 1.04, fill: template.ink });
    addShape(canvas, new Rect({ left: pad, top: portrait ? 340 : 335, width: 36, height: 3, fill: template.secondary }));
    addText(canvas, "subtitle", subtitle, { left: pad, top: portrait ? 365 : 360, width: panelWidth - pad * 1.25, fontSize: 17, lineHeight: 1.35, fill: "#4b5550" });
  } else if (template.layout === "outline-pop") {
    addShape(canvas, new Rect({ left: 0, top: 0, width: w, height: h, fill: "rgba(8,13,12,.36)" }));
    addShape(canvas, new Rect({ left: pad, top: 42, width: 104, height: 34, angle: -3, rx: 2, ry: 2, fill: template.secondary }));
    addText(canvas, "badge", badge, { left: pad + 15, top: 48, width: 90, fontSize: 16, fill: "#ffffff", angle: -3 });
    addText(canvas, "title", title, {
      left: pad, top: portrait ? 106 : 96, width: 420, fontSize: titleSize, lineHeight: .94,
      fill: template.titleColor, stroke: template.ink, strokeWidth: 5, paintFirst: "stroke",
      shadow: new Shadow({ color: template.accent, blur: 0, offsetX: 6, offsetY: 7 }),
    });
    addShape(canvas, new Rect({ left: pad, top: portrait ? 270 : 256, width: 330, height: 42, angle: 1.5, fill: template.accent }));
    addText(canvas, "subtitle", subtitle, { left: pad + 12, top: portrait ? 279 : 265, width: 306, fontSize: 18, fill: template.ink, angle: 1.5 });
  } else {
    const left = portrait ? 0 : w * .46;
    const textLeft = portrait ? pad : left + 34;
    addShape(canvas, new Rect({ left, top: 0, width: w - left, height: h, fill: portrait ? "rgba(13,20,18,.48)" : "rgba(13,20,18,.82)" }));
    addText(canvas, "badge", badge, { left: textLeft, top: 54, width: 138, fontSize: 16, fill: template.accent });
    addShape(canvas, new Rect({ left: textLeft, top: 82, width: 54, height: 4, fill: template.secondary }));
    addText(canvas, "title", title, { left: textLeft, top: 112, width: portrait ? 420 : 290, fontSize: portrait ? 52 : 46, lineHeight: .98, fill: "#ffffff" });
    addText(canvas, "subtitle", subtitle, { left: textLeft, top: portrait ? 270 : 276, width: portrait ? 360 : 280, fontSize: 17, lineHeight: 1.3, fill: "#dbe6e1" });
    addShape(canvas, new Rect({ left: textLeft, top: h - 54, width: 120, height: 8, fill: template.accent }));
  }
  canvas.requestRenderAll();
}

export const CoverCanvas = forwardRef<CoverCanvasHandle, Props>(function CoverCanvas(props, ref) {
  const { template, imageUrl, title, subtitle, badge, templateTextValues, canvasWidth, canvasHeight, snapToGuides, onSelectionChange, onHistoryChange, onReadyChange, onTextEdit, onTemplateTextEdit, onLayersChange } = props;
  const dimensions = workingDimensions(canvasWidth, canvasHeight);
  const elementRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  const restoringRef = useRef(false);

  function reportHistory() {
    onHistoryChange({ canUndo: indexRef.current > 0, canRedo: indexRef.current >= 0 && indexRef.current < historyRef.current.length - 1 });
  }

  function snapshot(reset = false) {
    const canvas = canvasRef.current;
    if (!canvas || restoringRef.current) return;
    const json = JSON.stringify(canvas.toObject(["coverRole", "coverLayerId", "coverObjectId", "coverName"]));
    if (reset) {
      historyRef.current = [json];
      indexRef.current = 0;
    } else {
      historyRef.current = historyRef.current.slice(0, indexRef.current + 1);
      historyRef.current.push(json);
      indexRef.current = historyRef.current.length - 1;
    }
    reportHistory();
    reportLayers();
  }

  function layerList(canvas = canvasRef.current): CoverLayerSummary[] {
    if (!canvas) return [];
    return [...canvas.getObjects()].reverse().map((object, index) => {
      const tagged = withRole(object, roleOf(object) ?? "decoration") as TaggedObject;
      return {
        id: tagged.coverObjectId!,
        name: tagged.coverName || (object instanceof Textbox ? object.text.slice(0, 16) || "文字" : roleOf(object) === "image" ? "背景图" : roleOf(object) === "assetImage" ? "图片" : `图层 ${index + 1}`),
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

  async function restore(index: number) {
    const canvas = canvasRef.current;
    if (!canvas || !historyRef.current[index]) return;
    restoringRef.current = true;
    await canvas.loadFromJSON(JSON.parse(historyRef.current[index]));
    restoringRef.current = false;
    indexRef.current = index;
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    onSelectionChange(null);
    reportHistory();
  }

  useImperativeHandle(ref, () => ({
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
      link.href = output.toDataURL(`image/${format}`, quality);
      link.click();
    },
    undo: async () => { if (indexRef.current > 0) await restore(indexRef.current - 1); },
    redo: async () => { if (indexRef.current < historyRef.current.length - 1) await restore(indexRef.current + 1); },
    deleteSelected() {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !object || roleOf(object) === "image") return;
      canvas.remove(object);
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      snapshot();
    },
    duplicateSelected() {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !object || roleOf(object) === "image") return;
      void object.clone().then((clone: FabricObject) => {
        clone.set({ left: (object.left || 0) + 16, top: (object.top || 0) + 16 });
        (clone as TaggedObject).coverRole = roleOf(object);
        (clone as TaggedObject).coverObjectId = undefined;
        withRole(clone, roleOf(object) ?? "decoration", undefined, `${(object as TaggedObject).coverName || "图层"} 副本`);
        canvas.add(clone);
        canvas.setActiveObject(clone);
        canvas.requestRenderAll();
        snapshot();
      });
    },
    updateSelected(patch) {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !object) return;
      object.set(patch);
      object.setCoords();
      canvas.requestRenderAll();
      snapshot();
    },
    updateImageFilters(values) {
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
  }), [canvasWidth, canvasHeight, dimensions.height, dimensions.width]);

  useEffect(() => {
    if (!elementRef.current) return;
    const canvas = new Canvas(elementRef.current, { width: dimensions.width, height: dimensions.height, preserveObjectStacking: true, selectionColor: "rgba(8,127,112,.10)", selectionBorderColor: "#087f70" });
    canvasRef.current = canvas;
    const reportSelection = () => {
      const object = canvas.getActiveObject();
      const role = roleOf(object);
      if (!object || !role) return onSelectionChange(null);
      const tagged = object as TaggedObject;
      onSelectionChange({ role, type: object.type, fill: typeof object.fill === "string" ? object.fill : "#ffffff", fontSize: object instanceof Textbox ? object.fontSize : 0, opacity: object.opacity, layerId: tagged.coverLayerId, objectId: tagged.coverObjectId, name: tagged.coverName, text: object instanceof Textbox ? object.text : undefined, fontFamily: object instanceof Textbox ? object.fontFamily : undefined, fontWeight: object instanceof Textbox ? object.fontWeight : undefined, textAlign: object instanceof Textbox ? object.textAlign : undefined, charSpacing: object instanceof Textbox ? object.charSpacing : undefined, stroke: typeof object.stroke === "string" ? object.stroke : undefined, strokeWidth: object.strokeWidth, locked: !object.selectable });
    };
    canvas.on("selection:created", reportSelection);
    canvas.on("selection:updated", reportSelection);
    canvas.on("selection:cleared", reportSelection);
    canvas.on("object:modified", () => snapshot());
    canvas.on("object:moving", ({ target }) => {
      if (!snapToGuides || !target) return;
      const center = target.getCenterPoint();
      if (Math.abs(center.x - dimensions.width / 2) < 6) target.set({ left: (target.left || 0) + dimensions.width / 2 - center.x });
      if (Math.abs(center.y - dimensions.height / 2) < 6) target.set({ top: (target.top || 0) + dimensions.height / 2 - center.y });
    });
    canvas.on("text:changed", ({ target }) => {
      const role = roleOf(target);
      if (target instanceof Textbox && (role === "title" || role === "subtitle" || role === "badge")) onTextEdit(role, target.text);
      if (target instanceof Textbox && role === "templateText" && (target as TaggedObject).coverLayerId) onTemplateTextEdit((target as TaggedObject).coverLayerId!, target.text);
    });
    return () => { canvas.dispose(); canvasRef.current = null; };
  }, [dimensions.height, dimensions.width, onSelectionChange, onTextEdit, onTemplateTextEdit, snapToGuides]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    onReadyChange(false);
    void drawTemplate(canvas, template, imageUrl, title, subtitle, badge, templateTextValues, dimensions).then(() => {
      if (!active) return;
      snapshot(true);
      onReadyChange(true);
    }).catch((error) => {
      console.error("Cover canvas render failed", error);
      onReadyChange(true);
    });
    return () => { active = false; };
  }, [template, imageUrl, dimensions.height, dimensions.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const values: Record<string, string> = { title, subtitle, badge };
    canvas.getObjects().forEach((object) => {
      const role = roleOf(object);
      if (object instanceof Textbox && role && role in values && object.text !== values[role]) object.set({ text: values[role] });
    });
    canvas.requestRenderAll();
  }, [title, subtitle, badge]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || template.layout !== "jianying") return;
    canvas.getObjects().forEach((object) => {
      const tagged = object as TaggedObject;
      if (object instanceof Textbox && tagged.coverLayerId && templateTextValues[tagged.coverLayerId] !== undefined && object.text !== templateTextValues[tagged.coverLayerId]) {
        object.set({ text: templateTextValues[tagged.coverLayerId] });
      }
    });
    canvas.requestRenderAll();
  }, [template.layout, templateTextValues]);

  return <canvas ref={elementRef} aria-label="可编辑封面画布" />;
});
