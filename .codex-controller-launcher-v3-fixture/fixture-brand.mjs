export const fixtureBrand=new WeakSet();
export function isVerifiedWorkerFileProvider(x){return fixtureBrand.has(x)}
