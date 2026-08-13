export function Skeleton() {
  return (
    <div className="h-screen flex flex-col bg-surface-0 dark:bg-surface-50 animate-pulse" data-testid="skeleton">
      {/* StatusBar skeleton */}
      <div className="flex items-center px-3 py-2 border-b border-surface-100 pl-[76px]">
        <div className="h-4 w-16 bg-surface-100 rounded" />
        <div className="flex-1 flex justify-center">
          <div className="h-4 w-20 bg-surface-100 rounded" />
        </div>
        <div className="flex gap-1">
          <div className="w-6 h-6 bg-surface-100 rounded" />
          <div className="w-6 h-6 bg-surface-100 rounded" />
        </div>
      </div>

      {/* Chat area skeleton */}
      <div className="flex-1 px-3 py-4 space-y-4">
        {/* Assistant message */}
        <div className="flex justify-start">
          <div className="max-w-[80%] space-y-2">
            <div className="h-3 w-48 bg-surface-100 rounded" />
            <div className="h-3 w-64 bg-surface-100 rounded" />
            <div className="h-3 w-40 bg-surface-100 rounded" />
          </div>
        </div>
        {/* User message */}
        <div className="flex justify-end">
          <div className="h-3 w-32 bg-surface-100 rounded" />
        </div>
        {/* Assistant message */}
        <div className="flex justify-start">
          <div className="max-w-[80%] space-y-2">
            <div className="h-3 w-56 bg-surface-100 rounded" />
            <div className="h-3 w-44 bg-surface-100 rounded" />
          </div>
        </div>
      </div>

      {/* InputBar skeleton */}
      <div className="border-t border-surface-100 px-3 py-3 flex items-end gap-2">
        <div className="flex-1 h-10 bg-surface-50 rounded-lg border border-surface-100" />
        <div className="w-9 h-9 bg-surface-100 rounded-lg" />
      </div>
    </div>
  )
}
