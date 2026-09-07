import type { ReactNode } from 'react'
import { onNavClick } from '../lib/router.ts'

/** An ordinary anchor that navigates without a reload. ⚠ It keeps a real `href` so the link can be
 *  copied, opened in a new tab and read by a crawler. */
export function Link({ to, className, children, ...rest }: {
  to: string; className?: string; children: ReactNode
} & Record<string, unknown>) {
  return (
    <a href={to} className={className} onClick={onNavClick(to)} {...rest}>
      {children}
    </a>
  )
}
