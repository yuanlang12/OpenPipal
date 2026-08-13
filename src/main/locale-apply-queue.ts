/**
 * Serialize locale changes and publish only the latest requested state. This
 * avoids an out-of-order async changeLanguage completion broadcasting stale
 * renderer/tray chrome.
 */
export function createLatestLocaleApplier<State>(options: {
  apply: (state: State) => Promise<void>
  publish: (state: State) => void | Promise<void>
  onError?: (error: unknown) => void
}): (state: State) => Promise<void> {
  let revision = 0
  let queue: Promise<void> = Promise.resolve()

  return (state: State): Promise<void> => {
    const requestRevision = ++revision
    queue = queue.then(async () => {
      if (requestRevision !== revision) return
      await options.apply(state)
      if (requestRevision !== revision) return
      await options.publish(state)
    }).catch((error) => {
      options.onError?.(error)
    })
    return queue
  }
}
