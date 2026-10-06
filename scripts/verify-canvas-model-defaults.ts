import assert from "node:assert/strict";
import {
  isCanvasStoryboardVideoModelCompatible,
  selectCanvasImageModel,
  selectCanvasVideoModel,
} from "../src/lib/canvas-model-defaults";
import type { CoverModel, VideoModel } from "../src/lib/studio-canvas-types";

const imageModels = [
  { id: "banana", name: "Nano Banana 2", model_name: "nano-banana-2" },
  { id: "gpt-1-5", name: "GPT Image 1.5", model_name: "gpt-image-1.5" },
  { id: "gpt-2", name: "GPT Image 2", model_name: "gpt-image-2" },
] as unknown as CoverModel[];

assert.equal(
  selectCanvasImageModel(imageModels, "banana"),
  "gpt-2",
  "the canvas must prefer the highest-quality GPT image model over an older configured model",
);

const videoModels = [
  {
    id: "text-only",
    name: "Text Video",
    supportsImageInput: false,
    requiresImage: false,
    durationMode: "range",
    durationSeconds: 10,
    minDuration: 1,
    maxDuration: 10,
    resolutionTier: "1080p",
    successRate: 99,
  },
  {
    id: "fixed-eight",
    name: "Fixed 8s Image Video",
    supportsImageInput: true,
    requiresImage: true,
    durationMode: "fixed",
    durationSeconds: 8,
    minDuration: 8,
    maxDuration: 8,
    resolutionTier: "1080p",
    successRate: 95,
  },
  {
    id: "storyboard-range",
    name: "Storyboard Image Video",
    supportsImageInput: true,
    requiresImage: true,
    durationMode: "range",
    durationSeconds: 4,
    minDuration: 1,
    maxDuration: 10,
    resolutionTier: "1080p",
    successRate: 90,
  },
] as unknown as VideoModel[];

assert.equal(
  selectCanvasVideoModel(videoModels, "fixed-eight"),
  "storyboard-range",
  "the default video model must support reference images and exact 1-4 second storyboard timing",
);
assert.equal(isCanvasStoryboardVideoModelCompatible(videoModels[1]), false, "fixed 8s models would waste paid duration on 1-4s storyboard shots");
assert.equal(isCanvasStoryboardVideoModelCompatible(videoModels[2]), true, "range models with image input must remain available for exact storyboard timing");

console.log("Canvas model default verification passed.");
