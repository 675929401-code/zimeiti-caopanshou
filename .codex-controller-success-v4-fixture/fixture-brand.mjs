export const fixtureChildren=new WeakSet();
export function ownsPinnedControllerChild(x){return fixtureChildren.has(x)}
