import observed from '../components/commerce-agent/observed-catalog.json';
import { directorScenes, sceneImageSlot, type DirectorScene } from './director-scenarios';

type Slot = { key: string; label: string; kinds: string[]; min: number; max: number };
const observedCards = new Map(observed.directors.map(card => [card.key, card]));

export function directorReferenceLayout<T extends Slot>(card: { key: string; slots: readonly T[] }, scene?: DirectorScene) {
  const reference = observedCards.get(scene ? directorScenes[scene].cardKey : card.key);
  const product = sceneImageSlot(card.slots);
  const nativeActor = card.slots.find(slot => slot.label === '角色' && slot.kinds.includes('image'));
  // Personal IP briefs share the general director's image/character/audio contract.
  const actorTemplate=reference || (scene ? observedCards.get('default-director') : undefined);
  const observedActor = actorTemplate?.slots.find(slot => slot.label === '角色');
  const actor = nativeActor || (observedActor ? product : undefined);
  const productMinimum = Math.max(product?.min || 0, scene ? Number(directorScenes[scene].productImage) : sceneImageSlot(reference?.slots || [])?.min || 0);
  return { product, productMinimum, actor, nativeActor, actorMax: nativeActor?.max ?? Math.min(observedActor?.max || 0, actor?.max || 0) };
}
