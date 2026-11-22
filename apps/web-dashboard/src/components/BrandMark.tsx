import type { SVGProps } from 'react';

export function BrandMark({ className = 'h-4 w-4', ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" className={className} {...props}>
      <path d="M256 64c-64 0-112 45-112 106 0 54 45 102 80 128h64c35-26 80-74 80-128 0-61-48-106-112-106z" />
      <rect x="232" y="312" width="48" height="24" rx="7" />
      <path d="M96 364h320v14H96zM242 378h28l128 108H114l128-108z" />
    </svg>
  );
}
