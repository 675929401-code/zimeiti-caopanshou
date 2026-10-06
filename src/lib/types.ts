export * from "./types/index";

export interface CoverModel {
  id: string;
  name: string;
  model_name: string;
  provider: string;
  selling_price: number;
  supports_image_input: boolean;
}
