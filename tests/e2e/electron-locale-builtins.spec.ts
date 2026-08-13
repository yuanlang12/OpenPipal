import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launchIsolatedElectron } from './helpers'

const mainEntry = join(process.cwd(), 'out', 'main', 'index.js')

test('the built Electron app renders builtin model chrome in English', async () => {
  test.setTimeout(60_000)
  const builtinConfig = {
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'openpipal-e2e-builtin-key',
    model: 'openpipal-e2e-builtin-model'
  }
  const { app, dispose } = await launchIsolatedElectron({ entry: mainEntry, env: {
    OPENAI_API_KEY: 'openpipal-e2e-env-key',
    OPENAI_MODEL: 'openpipal-e2e-env-model',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1'
  }, config: {
    localePreference: 'en',
    role: 'general',
    modelConfig: builtinConfig,
    modelProviders: [{
      id: 'builtin-provider',
      name: '内置服务',
      ...builtinConfig,
      builtin: true
    }],
    modelPresets: [{
      id: 'builtin-model',
      name: '内置模型',
      providerId: 'builtin-provider',
      config: builtinConfig
    }],
    activePresetId: 'builtin-model'
  } })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await expect(page.locator('[data-testid="welcome-model-select"]')).toContainText('Built-in model')

    await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
    await page.getByRole('button', { name: 'Models', exact: true }).click()

    await expect(page.getByText('Built-in service', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Built-in model', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('内置服务', { exact: true })).toHaveCount(0)
    await expect(page.getByText('内置模型', { exact: true })).toHaveCount(0)
  } finally {
    await dispose()
  }
})
