import type {Metadata} from 'next';
import {CanvasSharePreview} from '../../../../commerce/components/commerce-agent/canvas-share-preview';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'画布分享 · 只读预览',referrer:'no-referrer',robots:{index:false,follow:false}};
export default async function Page({params}:{params:Promise<{token:string}>}){const {token}=await params;return <CanvasSharePreview token={token}/>;}
