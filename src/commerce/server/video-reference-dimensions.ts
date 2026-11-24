import path from 'node:path';
import type {Asset} from './assets';
import type {Model} from './models';
import {runtimeDir} from './store';
import {classifyDepthCloneModel, validateSourceVideoDimensions} from './depth-video-clone-model-profiles';
import {probeVideoFile} from './video-file-probe';

export async function validateVideoReferenceDimensions(model:Model, assets:readonly (Asset|undefined|null)[]) {
  const profile = classifyDepthCloneModel(model);
  if (profile !== 'seedance-2-0-fast') return;
  const videos = new Set(assets.filter(asset => asset?.type.startsWith('video/')).map(asset => asset!.id));
  for (const id of videos) {
    const {width,height} = await probeVideoFile(path.join(runtimeDir(),'assets',id));
    validateSourceVideoDimensions(profile,width,height);
  }
}
