'use client';

import React from 'react';

interface Step {
  label: string;
  description: string;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
}

export default function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  return (
    <div className="flex items-start">
      {steps.map((step, i) => (
        <React.Fragment key={i}>
          <div className="flex flex-col items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                i < currentStep
                  ? 'bg-emerald-500 text-white'
                  : i === currentStep
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-200 text-gray-500'
              }`}
            >
              {i < currentStep ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                i + 1
              )}
            </div>
            <div className="mt-2 text-center">
              <p className={`text-xs font-medium ${i <= currentStep ? 'text-gray-900' : 'text-gray-400'}`}>
                {step.label}
              </p>
              <p className="text-xs text-gray-400 hidden sm:block">{step.description}</p>
            </div>
          </div>
          {i < steps.length - 1 && (
            <div className={`flex-1 h-0.5 mt-4 mx-2 rounded ${i < currentStep ? 'bg-emerald-400' : 'bg-gray-200'}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
