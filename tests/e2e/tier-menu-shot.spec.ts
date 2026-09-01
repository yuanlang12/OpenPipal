/**
 * 权限档位菜单的遮挡回归 —— 判据是**每一档都真的点得到**，不是"菜单存在"。
 *
 * 2026-08-28 真机截图报的形态：菜单在 DOM 里、`toBeVisible()` 也过，但被输入框那张
 * `relative z-10` 的卡片整个盖住，用户只看得见最上面一档。所以断言必须落在
 * `elementFromPoint`——问"这个坐标上最上面的元素是不是它自己"，纯 DOM 存在性查不出遮挡。
 * 根因与修法见 `shared/WorkingDirBar.tsx` 根节点那段注释。
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedElectron } from './helpers'

test('权限档位三档都不被输入框盖住', async () => {
  const app = await launchIsolatedElectron({})
  try {
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.click('[title="编码助手"]', { timeout: 30000 })
    await page.waitForSelector('[data-testid="preflow-input"]', { timeout: 30000 })

    // ① 静止态：目录条刻意塞进输入框底下 10px（`-mt-2.5`），底色更深、压进去那边不圆角，
    //    全靠被输入框盖住才成立（见 glass.css 那段）。所以重叠处最上面的必须是**输入框**。
    //    第一版为了修遮挡把 z 常驻抬高，正是把这一层弄丢了——两个方向都得钉住。
    const bar = page.locator('[data-testid="working-dir-bar"]')
    const barBox = await bar.boundingBox()
    expect(barBox).not.toBeNull()
    const coveredByComposer = await page.evaluate(([x, y]) => {
      const top = document.elementFromPoint(x as number, y as number)
      return !top?.closest('[data-testid="working-dir-bar"]')
    }, [barBox!.x + barBox!.width / 2, barBox!.y + 3] as const)
    expect(coveredByComposer, '目录条的压入边露出来了，输入框没盖住它').toBe(true)
    await page.screenshot({ path: 'test-results/tier-menu-closed.png' })

    // ② 打开态：菜单向上弹进输入框的地盘，这时才该抬到输入框之上
    await page.click('[data-testid="permission-tier-trigger"]', { timeout: 15000 })
    await expect(page.locator('[data-testid="permission-tier-menu"]')).toBeVisible()

    for (const id of ['readonly', 'auto', 'full']) {
      const item = page.locator(`[data-testid="permission-tier-${id}"]`)
      await expect(item, `${id} 档不在菜单里`).toBeVisible()
      const box = await item.boundingBox()
      expect(box, `${id} 档量不到位置`).not.toBeNull()
      // 中心点上最上面的那个元素，必须还在这一档自己里面——否则就是被别的东西压着
      const onTop = await page.evaluate(([x, y, sel]) => {
        const top = document.elementFromPoint(x as number, y as number)
        return !!top?.closest(sel as string)
      }, [box!.x + box!.width / 2, box!.y + box!.height / 2,
          `[data-testid="permission-tier-${id}"]`] as const)
      expect(onTop, `${id} 档被别的元素盖住了`).toBe(true)
    }

    // 等 animate-fade-in 播完再截，否则截到半透明的中间态。等的是**动画的终态**而不是
    // 固定 600ms：机器慢一点那个数就不够，而它不够的时候只会截出一张糊图，不会报错。
    await expect(page.locator('[data-testid="permission-tier-menu"]')).toHaveCSS('opacity', '1')
    await page.screenshot({ path: 'test-results/tier-menu.png' })
  } finally {
    await app.dispose()
  }
})
