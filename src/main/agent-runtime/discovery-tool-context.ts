import type { ExecutionEnv, ExecutionToolContext } from '@earendil-works/pi-agent-core'

/**
 * 发现类工具（grep / find / ls）需要的执行上下文。
 *
 * 这些工具只拿 env 做两件事：把请求路径解成绝对路径，再解成规范路径
 * （见 openpipal-search-tools.ts 的 resolveSearchRoot）。此前调用方直接
 * `new NodeExecutionEnv({ cwd })` 把一整个执行环境交出去，代价有两处：
 *
 *   1. `@earendil-works/pi-agent-core/node` 被**静态**拉进 pi-tools.ts。
 *      那条边界的意义正是「选了 legacy 回滚路径，就不该在 import 期加载新
 *      后端」——同一文件里的 execute_code 与 bash 都特意走了 await import。
 *   2. 交出去的是完整环境。原注释写着 "never spawns a child process"，但没有
 *      任何东西拦得住；真 spawn 还会绕过 OpenPipalNodeExecutionEnv 的超时、
 *      输出上限与环境净化。
 *
 * 这里一并解决：后端按需动态加载（import 期零代价），且只放行路径解析——
 * 「只解析路径」从注释变成机制。需要执行进程的调用方走
 * ./openpipal-execution-env 的 OpenPipalNodeExecutionEnv。
 */
export function createDiscoveryToolContext(cwd: string): ExecutionToolContext {
  let backend: Promise<ExecutionEnv> | undefined
  const load = (): Promise<ExecutionEnv> => {
    backend ??= import('@earendil-works/pi-agent-core/node')
      .then(({ NodeExecutionEnv }) => new NodeExecutionEnv({ cwd }))
    return backend
  }

  const pathOnly = {
    cwd,
    absolutePath: async (...args: Parameters<ExecutionEnv['absolutePath']>) =>
      (await load()).absolutePath(...args),
    canonicalPath: async (...args: Parameters<ExecutionEnv['canonicalPath']>) =>
      (await load()).canonicalPath(...args)
  }

  const env = new Proxy(pathOnly as ExecutionEnv, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      // await 解包与调试打印会探测这些成员；在这里抛错会把无关代码一起带崩。
      if (typeof property === 'symbol' || property === 'then') return undefined
      throw new TypeError(
        `发现类工具的执行上下文只解析路径，不提供 ${property}。` +
        '需要执行进程请用 openpipal-execution-env 的 OpenPipalNodeExecutionEnv。'
      )
    }
  })

  return { env }
}
