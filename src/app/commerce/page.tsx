import { CommerceWorkspace } from '../../commerce/components/commerce-agent/workspace';
import { FeatureComingSoonGate } from '@/components/feature-coming-soon-gate';

export default function Page() {
  return (
    <FeatureComingSoonGate title="带货创作">
      <CommerceWorkspace />
    </FeatureComingSoonGate>
  );
}
