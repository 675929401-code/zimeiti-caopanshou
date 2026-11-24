export const characterImageSlots = ['人物正脸图','左侧脸','右侧脸','人脸特征图','人脸特征图','人脸特征图'] as const;

export type CharacterProfile = {
  images: (string | null)[];
  audioId: string | null;
  videoId: string | null;
  consentAt: number;
};
