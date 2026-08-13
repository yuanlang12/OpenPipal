/** Small callback-to-AsyncIterable bridge used by both Runtime adapters. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolve: ((value: IteratorResult<T>) => void) | null = null
  private isDone = false

  push(item: T): void {
    if (this.isDone) return
    if (this.resolve) {
      const resolve = this.resolve
      this.resolve = null
      resolve({ value: item, done: false })
    } else {
      this.queue.push(item)
    }
  }

  done(): void {
    if (this.isDone) return
    this.isDone = true
    if (this.resolve) {
      const resolve = this.resolve
      this.resolve = null
      resolve({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false })
        }
        if (this.isDone) {
          return Promise.resolve({ value: undefined as T, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolve = resolve
        })
      }
    }
  }
}
