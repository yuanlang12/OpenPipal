import type { Task } from './task-store'

export interface TaskSchedulerControl {
  schedule(task: Task): void
  unschedule(taskId: string): void
  reschedule(taskId: string): void
}

let control: TaskSchedulerControl | null = null

export function registerTaskSchedulerControl(next: TaskSchedulerControl): void {
  control = next
}

export function getTaskSchedulerControl(): TaskSchedulerControl {
  if (!control) {
    throw new Error('任务调度器尚未初始化')
  }
  return control
}
