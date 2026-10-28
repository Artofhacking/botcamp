const RETRY_LISTING = 'Retry listing workspace'

// Hide the innermost node that paints this sentence. The host uses it while a
// workspace list is in flight and again when that list fails.
export function hideWorkspaceRetry(root) {
  if (!root?.querySelectorAll || !root.textContent?.includes(RETRY_LISTING)) return
  for (const el of root.querySelectorAll('*')) {
    if (!el.textContent?.includes(RETRY_LISTING)) continue
    let nested = false
    for (const child of el.children) {
      if (child.textContent?.includes(RETRY_LISTING)) { nested = true; break }
    }
    if (!nested) el.style.setProperty('display', 'none', 'important')
  }
}
