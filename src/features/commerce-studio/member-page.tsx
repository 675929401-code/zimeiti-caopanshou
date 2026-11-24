'use client';
import type {ReactNode} from 'react';
import {WorkspaceIdentity} from '@/commerce/components/commerce-agent/workspace-identity';

export function CommerceMemberPage({children}:{children:ReactNode}) {
  return <WorkspaceIdentity>{()=>children}</WorkspaceIdentity>;
}
