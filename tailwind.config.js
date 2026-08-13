/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ============================================================
        // 颜色系统 — 基于种子色派生 + RGB 三元组 + Tailwind <alpha-value>
        //
        // applyTheme()(lib/theme.ts) 在 :root 写入:
        //   --sw-brand-50-rgb   ... --sw-brand-900-rgb     (9 档,基于 accent 派生)
        //   --sw-surface-0-rgb  ... --sw-surface-900-rgb   (11 档,基于 surface/ink/contrast)
        //   --sw-sidebar-50-rgb ... --sw-sidebar-300-rgb   (4 档,基于 surface/ink)
        //
        // tailwind 用 rgb(<triplet> / <alpha-value>):
        //   bg-brand-500      → rgb(<triplet> / 1)
        //   bg-brand-900/30   → rgb(<triplet> / 0.3)  ← alpha modifier 工作
        //
        // 改主题色 → applyTheme 重新计算所有三元组 → 整个 UI 跟随。
        // ============================================================

        // Brand: accent 派生
        brand: {
          50:  'rgb(var(--sw-brand-50-rgb)  / <alpha-value>)',
          100: 'rgb(var(--sw-brand-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--sw-brand-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--sw-brand-300-rgb) / <alpha-value>)',
          400: 'rgb(var(--sw-brand-400-rgb) / <alpha-value>)',
          500: 'rgb(var(--sw-brand-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--sw-brand-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--sw-brand-700-rgb) / <alpha-value>)',
          800: 'rgb(var(--sw-brand-800-rgb) / <alpha-value>)',
          900: 'rgb(var(--sw-brand-900-rgb) / <alpha-value>)',
          DEFAULT: 'rgb(var(--sw-brand-500-rgb) / <alpha-value>)',
        },

        // Surface: surface → ink 渐变,400/500 受 contrast 影响
        surface: {
          0:   'rgb(var(--sw-surface-0-rgb)   / <alpha-value>)',
          50:  'rgb(var(--sw-surface-50-rgb)  / <alpha-value>)',
          100: 'rgb(var(--sw-surface-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--sw-surface-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--sw-surface-300-rgb) / <alpha-value>)',
          400: 'rgb(var(--sw-surface-400-rgb) / <alpha-value>)',
          500: 'rgb(var(--sw-surface-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--sw-surface-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--sw-surface-700-rgb) / <alpha-value>)',
          800: 'rgb(var(--sw-surface-800-rgb) / <alpha-value>)',
          900: 'rgb(var(--sw-surface-900-rgb) / <alpha-value>)',
          // 语义别名(不带 alpha,L2 token 直接引用)
          primary:   'var(--sw-bg-primary)',
          secondary: 'var(--sw-bg-secondary)',
          tertiary:  'var(--sw-bg-tertiary)',
          elevated:  'var(--sw-bg-elevated)',
          overlay:   'var(--sw-bg-overlay)',
        },

        // Sidebar: surface 微深暖调
        sidebar: {
          bg:     'var(--sw-bg-sidebar)',
          hover:  'var(--sw-list-hover)',
          active: 'var(--sw-list-active)',
          border: 'var(--sw-border)',
          50:  'rgb(var(--sw-sidebar-50-rgb)  / <alpha-value>)',
          100: 'rgb(var(--sw-sidebar-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--sw-sidebar-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--sw-sidebar-300-rgb) / <alpha-value>)',
        },

        // 前景文字
        ink: {
          primary:   'var(--sw-fg-primary)',
          secondary: 'var(--sw-fg-secondary)',
          tertiary:  'var(--sw-fg-tertiary)',
          disabled:  'var(--sw-fg-disabled)',
          'on-accent': 'var(--sw-fg-on-accent)',
        },

        // 边框
        border: {
          DEFAULT: 'var(--sw-border)',
          light:   'var(--sw-border-light)',
          heavy:   'var(--sw-border-heavy)',
          focus:   'var(--sw-border-focus)',
        },

        // 语义状态色
        success: { DEFAULT: 'var(--sw-success)', bg: 'var(--sw-success-bg)' },
        danger:  { DEFAULT: 'var(--sw-danger)',  bg: 'var(--sw-danger-bg)'  },
        warning: { DEFAULT: 'var(--sw-warning)', bg: 'var(--sw-warning-bg)' },
        info:    { DEFAULT: 'var(--sw-info)',    bg: 'var(--sw-info-bg)'    },
        // 官方次要色(clay 罕见高亮 / sand 暖面)
        clay: { DEFAULT: 'var(--sw-clay)', soft: 'var(--sw-clay-soft)' },
        sand: 'var(--sw-sand)',
        diff: {
          added:   'var(--sw-diff-added)',
          removed: 'var(--sw-diff-removed)',
        },
        tag: {
          skill: 'var(--sw-tag-skill)',
        },
      },

      fontFamily: {
        sans:    ['var(--sw-font-ui)'],
        display: ['var(--sw-font-ui)'],
        mono:    ['var(--sw-font-mono)'],
      },

      fontSize: {
        'sw-xs':   ['var(--sw-text-xs)',  { lineHeight: 'var(--sw-leading-snug)' }],
        'sw-sm':   ['var(--sw-text-sm)',  { lineHeight: 'var(--sw-leading-snug)' }],
        'sw-base': ['var(--sw-text-base)',{ lineHeight: 'var(--sw-leading-normal)' }],
        'sw-lg':   ['var(--sw-text-lg)',  { lineHeight: 'var(--sw-leading-normal)' }],
        'sw-xl':   ['var(--sw-text-xl)',  { lineHeight: 'var(--sw-leading-tight)' }],
        'sw-2xl':  ['var(--sw-text-2xl)', { lineHeight: 'var(--sw-leading-tight)' }],
        // 聊天专用 — Phase E++:走 chat-leading(1.65),比 leading-relaxed 更松,阅读舒适
        'chat':       ['var(--sw-chat-text)',  { lineHeight: 'var(--sw-chat-leading)' }],
        'chat-meta':  ['var(--sw-chat-meta)',  { lineHeight: 'var(--sw-leading-snug)' }],
        'chat-small': ['var(--sw-chat-small)', { lineHeight: 'var(--sw-leading-snug)' }],
        'chat-label': ['var(--sw-chat-label)', { lineHeight: 'var(--sw-chat-leading)' }],
      },

      maxWidth: {
        'msg': 'var(--sw-msg-max-width)',
      },

      margin: {
        'msg': 'var(--sw-msg-gap-y)',
      },

      borderRadius: {
        DEFAULT: 'var(--sw-radius-md)',
        xs:  'var(--sw-radius-xs)',
        sm:  'var(--sw-radius-sm)',
        md:  'var(--sw-radius-md)',
        lg:  'var(--sw-radius-lg)',
        xl:  'var(--sw-radius-xl)',
        '2xl': 'var(--sw-radius-2xl)',
        '3xl': 'var(--sw-radius-3xl)',
        full: 'var(--sw-radius-full)',
      },

      boxShadow: {
        sm:  'var(--sw-shadow-sm)',
        DEFAULT: 'var(--sw-shadow-md)',
        md:  'var(--sw-shadow-md)',
        lg:  'var(--sw-shadow-lg)',
        xl:  'var(--sw-shadow-xl)',
        '2xl': 'var(--sw-shadow-2xl)',
      },

      transitionTimingFunction: {
        enter:    'var(--sw-ease-enter)',
        exit:     'var(--sw-ease-exit)',
        smooth:   'var(--sw-ease-in-out)',
      },

      transitionDuration: {
        fast:   '150ms',
        normal: '220ms',
        slow:   '320ms',
      },

      spacing: {
        'toolbar':    'var(--sw-height-toolbar)',
        'toolbar-sm': 'var(--sw-height-toolbar-sm)',
        'statusbar':  'var(--sw-height-statusbar)',
        'row':        'var(--sw-height-row)',
        'sidebar':    'var(--sw-sidebar-width)',
      },

      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '0.4' },
          '50%':      { opacity: '1' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'orb-breathe': {
          '0%, 100%': { transform: 'scale(1)',    filter: 'brightness(1)'   },
          '50%':      { transform: 'scale(1.04)', filter: 'brightness(1.1)' },
        },
      },

      animation: {
        'pulse-soft':  'pulse-soft 1.4s ease-in-out infinite',
        'fade-in':     'fade-in 0.2s ease-out',
        'orb-breathe': 'orb-breathe 2.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
