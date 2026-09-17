import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import type { StoreWindow } from './live-helpers'

/**
 * 规则页删除：自己定的规则旁边有垃圾桶，点了先就地确认，确认后文件进系统废纸篓、这一行消失；
 * 第三方插件自带的规则没有垃圾桶。不调模型。
 * 注意：废纸篓是系统的，跑一次会在真实废纸篓里留两个 e2e-*.ts 小文件。
 */

const ARTIFACTS = 'tests/artifacts/rules-delete'
const rule = (description: string): string =>
  `export const description = '${description}'\nexport default function (hook) { hook.on('tool_result', () => undefined) }\n`

test.describe('规则页删除', () => {
  let app: IsolatedElectron | null = null
  test.afterEach(async () => { await app?.dispose(); app = null })

  test('垃圾桶 → 就地确认 → 文件没了、行消失；取消不动；插件自带的不给删', async () => {
    app = await launchIsolatedElectron()
    const plugins = join(app.home, '.openpipal', 'plugins')
    for (const name of ['local-rules', 'vendor']) {
      await mkdir(join(plugins, name, 'hooks'), { recursive: true })
      await writeFile(join(plugins, name, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name }), 'utf8')
    }
    const mine = join(plugins, 'local-rules', 'hooks', 'e2e-mask-names.ts')
    const mineOff = join(plugins, 'local-rules', 'hooks', 'e2e-old-rule.ts.off')
    await writeFile(mine, rule('读成绩表前先遮名字'), 'utf8')
    await writeFile(mineOff, rule('一条关掉的旧规则'), 'utf8')
    await writeFile(join(plugins, 'vendor', 'hooks', 'theirs.ts'), rule('插件自带的规则'), 'utf8')
    await mkdir(ARTIFACTS, { recursive: true })

    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as StoreWindow).__appStore)
    await page.evaluate(() => (window as StoreWindow).__appStore?.getState().openToolsHub('rules'))

    const global = page.locator('[data-rules-group="global"]')
    await expect(global.locator('li')).toHaveCount(2, { timeout: 15_000 })
    await expect(global.getByTestId('rule-delete')).toHaveCount(2)
    await expect(page.locator('[data-rules-group="plugin:vendor"]').getByTestId('rule-delete')).toHaveCount(0)
    await page.screenshot({ path: join(ARTIFACTS, '01-list.png') })

    const row = global.locator('li', { hasText: '读成绩表前先遮名字' })
    await row.getByTestId('rule-delete').click()
    await expect(row.getByTestId('rule-delete-confirm')).toBeVisible()
    await page.screenshot({ path: join(ARTIFACTS, '02-confirm.png') })
    await row.getByRole('button', { name: '取消' }).click()
    await expect(row.getByTestId('rule-delete')).toBeVisible()
    expect(existsSync(mine)).toBe(true)

    await row.getByTestId('rule-delete').click()
    await row.getByTestId('rule-delete-yes').click()
    await expect(global.locator('li')).toHaveCount(1, { timeout: 10_000 })
    expect(existsSync(mine)).toBe(false)

    const offRow = global.locator('li', { hasText: '一条关掉的旧规则' })
    await offRow.getByTestId('rule-delete').click()
    await offRow.getByTestId('rule-delete-yes').click()
    await expect(global).toHaveCount(0, { timeout: 10_000 })
    expect(existsSync(mineOff)).toBe(false)
    await page.screenshot({ path: join(ARTIFACTS, '03-after.png') })
  })
})
