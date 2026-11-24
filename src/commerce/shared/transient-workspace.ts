'use client';

// Inputs can travel between views in this document. A reload starts a new document.
export const workspaceInputs = new Map<string, string>();
let activeOwner = '';

export function scopeWorkspaceInputs(owner: string) {
  if (activeOwner === owner) return;
  workspaceInputs.clear();
  activeOwner = owner;
}
