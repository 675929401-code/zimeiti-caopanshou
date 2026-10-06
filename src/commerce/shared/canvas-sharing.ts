import type {CanvasGraph} from './canvas-schema';
export type SharedMedia={assetRef:string;name:string;type:string;size:number;previewUrl:string;downloadUrl:string};
export type CanvasSharePreview={title:string;revision:number;createdAt:number;expiresAt:number;graph:CanvasGraph;public_assets:SharedMedia[]};
export type CanvasShareOwnerView={id:string;status:'preparing'|'failed'|'active'|'cancelled'|'expired'|'source-deleted';revision:number;currentRevision:number;createdAt:number;expiresAt:number;url:string;ttlSeconds:number};
export type CanvasShareAcceptance={status:'none'|'pending'|'accepted'|'deleted';canvasId?:string;title?:string;openUrl?:string};
