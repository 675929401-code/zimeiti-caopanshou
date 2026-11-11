/** Browser-safe workspace identities shared by configuration import and server governance. */
export const WORKSPACE_SURFACE_KIND = {
  "image-workbench": "image",
  "cover-studio": "image",
  "storyboard-image": "image",
  "free-canvas-image": "image",
  "film-studio-image": "image",
  "video-page": "video",
  "storyboard-video": "video",
  "free-canvas-video": "video",
  "film-studio-video": "video",
  "commerce-video": "video",
  "publish-center-image": "image",
  "publish-center-video": "video",
} as const;
export type WorkspaceSurface = keyof typeof WORKSPACE_SURFACE_KIND;
